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
  if (!allowedOrigins.has(origin)) return response(request, 403, { error: "This site is not allowed to create accounts." });
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return response(request, 500, { error: "The account-creation service is not configured." });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return response(request, 401, { error: "Sign in as an administrator first." });

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData.user) return response(request, 401, { error: "Your sign-in session is invalid or expired." });

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: adminProfile, error: profileError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (profileError) return response(request, 500, { error: "Could not verify administrator access." });
  if (adminProfile?.role !== "admin") return response(request, 403, { error: "Only administrators can create user accounts." });

  let input: Record<string, unknown>;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 16_384) return response(request, 413, { error: "The account details are too large." });
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response(request, 400, { error: "Account details must be a JSON object." });
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return response(request, 400, { error: "Account details are not valid JSON." });
  }

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const username = typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const fullName = typeof input.full_name === "string" ? input.full_name.trim() : "";
  const employeeId = typeof input.employee_id === "string" ? input.employee_id.trim() : "";
  const position = typeof input.position === "string" ? input.position.trim() : "";

  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    return response(request, 400, { error: "Username must be 3–40 letters, numbers, periods, underscores, or hyphens." });
  }
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response(request, 400, { error: "Enter a valid email address." });
  }
  if (password.length < 12 || password.length > 128) {
    return response(request, 400, { error: "Temporary passwords must be 12–128 characters." });
  }
  if (!fullName || fullName.length > 100 || employeeId.length > 40 || position.length > 80) {
    return response(request, 400, { error: "Check the teacher name, employee ID, and position lengths." });
  }

  const { data: existingUsername, error: usernameError } = await adminClient
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (usernameError) return response(request, 500, { error: "Could not check whether that username is available." });
  if (existingUsername) return response(request, 409, { error: "That username is already in use. Choose a different username." });

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      employee_id: employeeId || null,
      position: position || null,
      username,
    },
  });
  if (createError || !created.user) {
    if (createError?.message === "Database error creating new user") {
      const { data: usernameConflict, error: conflictError } = await adminClient
        .from("profiles")
        .select("id")
        .eq("username", username)
        .maybeSingle();
      if (!conflictError && usernameConflict) {
        return response(request, 409, { error: "That username is already in use. Choose a different username." });
      }
    }
    return response(request, 400, { error: createError?.message ?? "The account could not be created." });
  }

  const { error: flagError } = await adminClient
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", created.user.id);
  if (flagError) {
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(created.user.id);
    if (deleteError) {
      return response(request, 500, { error: "The account was created, but setup failed. Contact the project administrator before retrying." });
    }
    return response(request, 500, { error: "The account could not be secured with a required first-login password change." });
  }

  return response(request, 201, { success: true, userId: created.user.id });
});
