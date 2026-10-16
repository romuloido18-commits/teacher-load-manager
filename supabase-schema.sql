create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  username text not null unique,
  role text not null default 'teacher' check (role in ('admin', 'teacher')),
  teacher_id uuid not null unique,
  must_change_password boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

create table if not exists public.school_state (
  id boolean primary key default true check (id),
  data jsonb not null default '{"teachers":[],"loads":[],"substitutionPlans":[],"leaveApplications":[],"settings":{}}'::jsonb,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.school_state (id)
values (true)
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.school_state enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
drop policy if exists "Users can read their own profile; admins can read all profiles" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

revoke all on public.profiles, public.school_state from anon, authenticated;
grant select on public.profiles to authenticated;

create or replace function public.handle_new_teacher()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  teacher_name text := coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), new.email);
  teacher_username text := lower(coalesce(nullif(trim(new.raw_user_meta_data ->> 'username'), ''), split_part(new.email, '@', 1)));
  teacher_employee_id text := nullif(trim(new.raw_user_meta_data ->> 'employee_id'), '');
  teacher_position text := nullif(trim(new.raw_user_meta_data ->> 'position'), '');
begin
  insert into public.profiles (id, email, username, teacher_id)
  values (new.id, lower(new.email), teacher_username, new.id);

  update public.school_state
  set data = jsonb_set(
    data,
    '{teachers}',
    coalesce(data -> 'teachers', '[]'::jsonb)
      || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'id', new.id,
        'name', teacher_name,
        'employeeId', teacher_employee_id,
        'position', teacher_position,
        'status', 'Active'
      ))),
    true
  ),
  revision = revision + 1,
  updated_at = now()
  where id = true;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_teacher on auth.users;
create trigger on_auth_user_created_teacher
  after insert on auth.users
  for each row execute function public.handle_new_teacher();

create or replace function public.clear_temporary_password_requirement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.encrypted_password is distinct from new.encrypted_password then
    update public.profiles
    set must_change_password = false
    where id = new.id and must_change_password;
  end if;
  return new;
end;
$$;

revoke all on function public.clear_temporary_password_requirement() from public, anon, authenticated;
drop trigger if exists on_auth_user_password_changed on auth.users;
create trigger on_auth_user_password_changed
  after update of encrypted_password on auth.users
  for each row execute function public.clear_temporary_password_requirement();

create or replace function public.load_school_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  stored public.school_state%rowtype;
  account public.profiles%rowtype;
  visible_data jsonb;
begin
  select * into account
  from public.profiles
  where id = (select auth.uid());

  if not found then
    raise exception 'An active teacher account is required to load school records.';
  end if;
  if account.must_change_password then
    raise exception 'Change your temporary password before accessing school records.';
  end if;

  select * into stored from public.school_state where id = true;
  if account.role = 'admin' then
    visible_data := stored.data;
  else
    visible_data := jsonb_build_object(
      'teachers',
      coalesce((
        select jsonb_agg(
          case when teacher.value ->> 'id' = account.teacher_id::text then teacher.value
            else jsonb_build_object(
              'id', teacher.value -> 'id',
              'name', teacher.value -> 'name',
              'status', teacher.value -> 'status'
            )
          end
        )
        from jsonb_array_elements(coalesce(stored.data -> 'teachers', '[]'::jsonb)) teacher(value)
      ), '[]'::jsonb),
      'loads',
      coalesce((
        select jsonb_agg(
          case when load.value ->> 'teacherId' = account.teacher_id::text then load.value
            else jsonb_build_object(
              'id', load.value -> 'id',
              'teacherId', load.value -> 'teacherId',
              'groupName', load.value -> 'groupName',
              'period', load.value -> 'period',
              'schedule', load.value -> 'schedule',
              'days', load.value -> 'days'
            )
          end
        )
        from jsonb_array_elements(coalesce(stored.data -> 'loads', '[]'::jsonb)) load(value)
      ), '[]'::jsonb),
      'substitutionPlans',
      coalesce((
        select jsonb_agg(
          case when plan.value ->> 'leaveTeacherId' = account.teacher_id::text
              or plan.value ->> 'submittedBy' = account.id::text
            then plan.value
            else jsonb_build_object(
              'id', plan.value -> 'id',
              'substituteTeacherId', plan.value -> 'substituteTeacherId',
              'startDate', plan.value -> 'startDate',
              'endDate', plan.value -> 'endDate',
              'loadIds', plan.value -> 'loadIds',
              'status', plan.value -> 'status'
            )
          end
        )
        from jsonb_array_elements(coalesce(stored.data -> 'substitutionPlans', '[]'::jsonb)) plan(value)
        where plan.value ->> 'leaveTeacherId' = account.teacher_id::text
          or plan.value ->> 'submittedBy' = account.id::text
          or plan.value ->> 'substituteTeacherId' = account.teacher_id::text
      ), '[]'::jsonb),
      'leaveApplications',
      coalesce((
        select jsonb_agg(application.value)
        from jsonb_array_elements(coalesce(stored.data -> 'leaveApplications', '[]'::jsonb)) application(value)
        where application.value ->> 'teacherId' = account.teacher_id::text
      ), '[]'::jsonb),
      'settings', coalesce(stored.data -> 'settings', '{}'::jsonb)
    );
  end if;

  return jsonb_build_object('data', visible_data, 'revision', stored.revision);
end;
$$;

create or replace function public.save_school_state(p_data jsonb, p_expected_revision bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  account public.profiles%rowtype;
  stored public.school_state%rowtype;
  merged_data jsonb;
  own_pending_plans jsonb;
  own_pending_applications jsonb;
begin
  select * into account
  from public.profiles
  where id = (select auth.uid());

  if not found then
    raise exception 'An active teacher account is required to save school records.';
  end if;
  if account.must_change_password then
    raise exception 'Change your temporary password before saving school records.';
  end if;

  select * into stored from public.school_state where id = true for update;
  if stored.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'School records were changed by another user. Reload the latest records and retry.';
  end if;

  if jsonb_typeof(p_data) is distinct from 'object'
    or jsonb_typeof(p_data -> 'teachers') is distinct from 'array'
    or jsonb_typeof(p_data -> 'loads') is distinct from 'array'
    or jsonb_typeof(p_data -> 'substitutionPlans') is distinct from 'array'
    or jsonb_typeof(p_data -> 'leaveApplications') is distinct from 'array'
    or jsonb_typeof(p_data -> 'settings') is distinct from 'object' then
    raise exception 'School records have an invalid format.';
  end if;

  if account.role = 'admin' then
    merged_data := p_data;
  else
    if exists (
      select 1
      from jsonb_array_elements(p_data -> 'loads') load(value)
      where load.value ->> 'teacherId' = account.teacher_id::text
        and (
          nullif(load.value ->> 'id', '') is null
          or jsonb_typeof(load.value -> 'days') is distinct from 'array'
        )
    ) then
      raise exception 'A teaching assignment has invalid required fields.';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_data -> 'substitutionPlans') plan(value)
      where plan.value ->> 'submittedBy' = account.id::text
        and plan.value ->> 'leaveTeacherId' = account.teacher_id::text
        and (
          plan.value ->> 'status' is distinct from 'pending'
          or jsonb_typeof(plan.value -> 'loadIds') is distinct from 'array'
          or case
            when jsonb_typeof(plan.value -> 'loadIds') = 'array'
              then jsonb_array_length(plan.value -> 'loadIds') = 0
            else true
          end
          or plan.value ->> 'startDate' !~ '^\d{4}-\d{2}-\d{2}$'
          or plan.value ->> 'endDate' !~ '^\d{4}-\d{2}-\d{2}$'
          or plan.value ->> 'startDate' > plan.value ->> 'endDate'
          or not exists (
            select 1 from jsonb_array_elements(coalesce(stored.data -> 'teachers', '[]'::jsonb)) leave_teacher(value)
            where leave_teacher.value ->> 'id' = account.teacher_id::text
              and leave_teacher.value ->> 'status' = 'On leave'
          )
          or not exists (
            select 1 from jsonb_array_elements(coalesce(stored.data -> 'teachers', '[]'::jsonb)) substitute(value)
            where substitute.value ->> 'id' = plan.value ->> 'substituteTeacherId'
              and substitute.value ->> 'id' <> account.teacher_id::text
              and coalesce(substitute.value ->> 'status', 'Active') = 'Active'
          )
          or exists (
            select 1
            from jsonb_array_elements_text(coalesce(plan.value -> 'loadIds', '[]'::jsonb)) selected_load(load_id)
            where not exists (
              select 1 from jsonb_array_elements(coalesce(stored.data -> 'loads', '[]'::jsonb)) own_load(value)
              where own_load.value ->> 'id' = selected_load.load_id
                and own_load.value ->> 'teacherId' = account.teacher_id::text
            )
          )
        )
        and not exists (
          select 1
          from jsonb_array_elements(coalesce(stored.data -> 'substitutionPlans', '[]'::jsonb)) reviewed_plan(value)
          where reviewed_plan.value ->> 'id' = plan.value ->> 'id'
            and reviewed_plan.value = plan.value
        )
    ) then
      raise exception 'Only your own pending coverage proposals can be saved.';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_data -> 'leaveApplications') application(value)
      where application.value ->> 'teacherId' = account.teacher_id::text
        and application.value ->> 'submittedBy' = account.id::text
        and (
          application.value ->> 'status' is distinct from 'pending'
          or application.value ->> 'startDate' !~ '^\d{4}-\d{2}-\d{2}$'
          or application.value ->> 'endDate' !~ '^\d{4}-\d{2}-\d{2}$'
          or application.value ->> 'startDate' > application.value ->> 'endDate'
        )
        and not exists (
          select 1
          from jsonb_array_elements(coalesce(stored.data -> 'leaveApplications', '[]'::jsonb)) reviewed_application(value)
          where reviewed_application.value ->> 'id' = application.value ->> 'id'
            and reviewed_application.value = application.value
        )
    ) then
      raise exception 'Only your own pending leave applications can be saved.';
    end if;

    select coalesce(jsonb_agg(application.value), '[]'::jsonb)
    into own_pending_applications
    from jsonb_array_elements(p_data -> 'leaveApplications') application(value)
    where application.value ->> 'teacherId' = account.teacher_id::text
      and application.value ->> 'submittedBy' = account.id::text
      and application.value ->> 'status' = 'pending';

    select coalesce(jsonb_agg(plan.value), '[]'::jsonb)
    into own_pending_plans
    from jsonb_array_elements(p_data -> 'substitutionPlans') plan(value)
    where plan.value ->> 'leaveTeacherId' = account.teacher_id::text
      and plan.value ->> 'submittedBy' = account.id::text
      and plan.value ->> 'status' = 'pending';

    merged_data := jsonb_set(stored.data, '{loads}', (
      select coalesce(jsonb_agg(load.value), '[]'::jsonb)
      from (
        select load.value
        from jsonb_array_elements(coalesce(stored.data -> 'loads', '[]'::jsonb)) load(value)
        where load.value ->> 'teacherId' <> account.teacher_id::text
        union all
        select load.value
        from jsonb_array_elements(p_data -> 'loads') load(value)
        where load.value ->> 'teacherId' = account.teacher_id::text
      ) load
    ), true);

    merged_data := jsonb_set(merged_data, '{leaveApplications}', (
      select coalesce(jsonb_agg(application.value), '[]'::jsonb)
      from (
        select application.value
        from jsonb_array_elements(coalesce(stored.data -> 'leaveApplications', '[]'::jsonb)) application(value)
        where not (
          application.value ->> 'teacherId' = account.teacher_id::text
          and application.value ->> 'submittedBy' = account.id::text
          and application.value ->> 'status' = 'pending'
        )
        union all
        select application.value
        from jsonb_array_elements(own_pending_applications) application(value)
      ) application
    ), true);

    merged_data := jsonb_set(merged_data, '{substitutionPlans}', (
      select coalesce(jsonb_agg(plan.value), '[]'::jsonb)
      from (
        select plan.value
        from jsonb_array_elements(coalesce(stored.data -> 'substitutionPlans', '[]'::jsonb)) plan(value)
        where not (
          plan.value ->> 'leaveTeacherId' = account.teacher_id::text
          and plan.value ->> 'submittedBy' = account.id::text
          and plan.value ->> 'status' = 'pending'
        )
        union all
        select plan.value
        from jsonb_array_elements(own_pending_plans) plan(value)
      ) plan
    ), true);
  end if;

  update public.school_state
  set data = merged_data, revision = revision + 1, updated_at = now()
  where id = true
  returning revision into stored.revision;

  return stored.revision;
end;
$$;

revoke all on function public.handle_new_teacher() from public, anon, authenticated;
revoke all on function public.clear_temporary_password_requirement() from public, anon, authenticated;
revoke all on function public.load_school_state() from public, anon;
revoke all on function public.save_school_state(jsonb, bigint) from public, anon;
grant execute on function public.load_school_state() to authenticated;
grant execute on function public.save_school_state(jsonb, bigint) to authenticated;

-- After creating and confirming the administrator's account in the app, run:
-- update public.profiles set role = 'admin' where lower(email) = lower('ADMIN_EMAIL_HERE');
-- The admin must then sign out and sign in again for the new role to take effect.
