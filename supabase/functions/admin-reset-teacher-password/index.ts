import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const allowedOrigins = new Set([
  "https://romuloido18-commits.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

function response(request: Request, status: number, body: Record<string, unknown>) {
  const origin = request.headers.get("origin") ?? "";
  const headers = new Headers({
    "Content-Type": "application/json",
    "Vary": "Origin",
  });
  if (allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info, x-supabase-api-version");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return response(request, 204, {});
  if (request.method !== "POST") return response(request, 405, { error: "Use POST for this operation." });

  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins.has(origin)) return response(request, 403, { error: "This site is not allowed to reset passwords." });
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return response(request, 500, { error: "The password-reset service is not configured." });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return response(request, 401, { error: "Sign in as an administrator first." });

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData.user) return response(request, 401, { error: "Your sign-in session is invalid or expired." });

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: adminProfile, error: adminProfileError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (adminProfileError) return response(request, 500, { error: "Could not verify administrator access." });
  if (adminProfile?.role !== "admin") return response(request, 403, { error: "Only administrators can reset teacher passwords." });

  let input: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response(request, 400, { error: "Password reset details must be a JSON object." });
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return response(request, 400, { error: "Password reset details are not valid JSON." });
  }

  const teacherId = typeof input.teacher_id === "string" ? input.teacher_id.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(teacherId)) {
    return response(request, 400, { error: "Select a valid teacher account." });
  }
  if (password.length < 12 || password.length > 128) {
    return response(request, 400, { error: "Temporary passwords must be 12–128 characters." });
  }

  const { data: teacherProfile, error: teacherProfileError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", teacherId)
    .maybeSingle();
  if (teacherProfileError) return response(request, 500, { error: "Could not verify the selected teacher account." });
  if (teacherProfile?.role !== "teacher") return response(request, 404, { error: "That teacher account could not be found." });

  const { error: passwordError } = await adminClient.auth.admin.updateUserById(teacherId, { password });
  if (passwordError) return response(request, 400, { error: passwordError.message });

  const { error: flagError } = await adminClient
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", teacherId);
  if (flagError) {
    return response(request, 500, { error: "The password was reset, but the first-sign-in password change could not be enforced. Contact the project administrator before sharing the temporary password." });
  }

  return response(request, 200, { success: true });
});
