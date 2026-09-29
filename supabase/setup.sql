-- =====================================================================
-- StudyBridge database setup
-- Paste this whole file into Supabase → SQL Editor → Run. Safe to re-run.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net is not available; phone alerts will be skipped';
end $$;

-- ---------------------------------------------------------------------
-- Profiles (one per login). Role is set by become_tutor() / accept_invite().
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text check (role in ('tutor', 'learner')),
  display_name text not null default '',
  email text,
  tutor_id uuid references public.profiles (id) on delete set null,
  programme_id uuid,
  timezone text not null default 'UTC',
  avatar_color text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'name', split_part(coalesce(new.email, ''), '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helpers used by the security rules (security definer avoids RLS recursion)
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.my_tutor() returns uuid
language sql stable security definer set search_path = public as $$
  select case when role = 'tutor' then id else tutor_id end from public.profiles where id = auth.uid()
$$;

create or replace function public.is_my_learner(p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_learner and tutor_id = auth.uid() and role = 'learner')
$$;

-- ---------------------------------------------------------------------
-- Tutor-defined structure: programmes → subjects → topics
-- ---------------------------------------------------------------------
create table if not exists public.programmes (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

do $$ begin
  alter table public.profiles add constraint profiles_programme_fk
    foreign key (programme_id) references public.programmes (id) on delete set null;
exception when duplicate_object then null; end $$;

create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  programme_id uuid references public.programmes (id) on delete set null,
  name text not null,
  color text,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.learner_subjects (
  learner_id uuid not null references public.profiles (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  primary key (learner_id, subject_id)
);

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  code text not null unique default upper(encode(extensions.gen_random_bytes(5), 'hex')),
  name text not null default '',
  email text,
  programme_id uuid references public.programmes (id) on delete set null,
  subject_ids uuid[] not null default '{}',
  revoked boolean not null default false,
  accepted_by uuid references public.profiles (id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

-- Can the signed-in learner see an item? (visibility + schedule + audience)
create or replace function public.can_learner_see(
  p_tutor uuid, p_learner_ids uuid[], p_subject uuid, p_visibility text, p_visible_from timestamptz
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'learner' and me.tutor_id = p_tutor)
    and (p_visibility = 'visible' or (p_visibility = 'scheduled' and p_visible_from is not null and p_visible_from <= now()))
    and (case
           when p_learner_ids is not null and cardinality(p_learner_ids) > 0 then auth.uid() = any (p_learner_ids)
           when p_subject is not null then exists (
             select 1 from public.learner_subjects ls where ls.learner_id = auth.uid() and ls.subject_id = p_subject)
           else true
         end)
$$;

-- ---------------------------------------------------------------------
-- Library files (PDFs, images, anything) and lessons
-- ---------------------------------------------------------------------
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null,
  mime text,
  size bigint,
  storage_path text not null unique,
  subject_id uuid references public.subjects (id) on delete set null,
  topic_id uuid references public.topics (id) on delete set null,
  description text,
  visibility text not null default 'hidden' check (visibility in ('hidden', 'visible', 'scheduled')),
  visible_from timestamptz,
  learner_ids uuid[],
  created_at timestamptz not null default now()
);

create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null,
  body_md text not null default '',
  subject_id uuid references public.subjects (id) on delete set null,
  topic_id uuid references public.topics (id) on delete set null,
  file_ids uuid[] not null default '{}',
  visibility text not null default 'hidden' check (visibility in ('hidden', 'visible', 'scheduled')),
  visible_from timestamptz,
  learner_ids uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Assignments: homework, quiz, test, exam — each with its own settings
-- ---------------------------------------------------------------------
create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind text not null default 'homework' check (kind in ('homework', 'quiz', 'test', 'exam')),
  title text not null,
  instructions_md text not null default '',
  subject_id uuid references public.subjects (id) on delete set null,
  topic_id uuid references public.topics (id) on delete set null,
  file_refs jsonb not null default '[]',
  due_at timestamptz,
  visibility text not null default 'hidden' check (visibility in ('hidden', 'visible', 'scheduled')),
  visible_from timestamptz,
  learner_ids uuid[],
  lockdown boolean not null default false,
  camera boolean not null default false,
  time_limit_min int check (time_limit_min is null or time_limit_min > 0),
  max_attempts int not null default 1 check (max_attempts > 0),
  allow_notes boolean not null default true,
  release_mode text not null default 'manual' check (release_mode in ('manual', 'on_submit', 'at')),
  release_at timestamptz,
  show_answers boolean not null default false,
  draft boolean not null default false,
  source text not null default 'tutor',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  position int not null default 0,
  type text not null check (type in ('mcq', 'numeric', 'short', 'steps', 'upload', 'drawing')),
  prompt_md text not null default '',
  image_path text,
  options jsonb not null default '[]',
  marks numeric not null default 1 check (marks >= 0),
  topic_id uuid references public.topics (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Answers and mark schemes live apart so learners can never read them early.
create table if not exists public.question_keys (
  question_id uuid primary key references public.questions (id) on delete cascade,
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  answer jsonb not null default '{}',
  mark_scheme_md text,
  solution_md text
);

create table if not exists public.attempts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  learner_id uuid not null references public.profiles (id) on delete cascade,
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  number int not null default 1,
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'marked', 'returned')),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  time_spent_sec int not null default 0,
  lockdown_events jsonb not null default '[]',
  score numeric,
  max_score numeric,
  released boolean not null default false,
  released_at timestamptz,
  feedback_md text,
  unique (assignment_id, learner_id, number)
);

create table if not exists public.responses (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  learner_id uuid not null references public.profiles (id) on delete cascade,
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  answer jsonb not null default '{}',
  auto_marks numeric,
  marks numeric,
  feedback_md text,
  step_marks jsonb not null default '[]',
  annotation_path text,
  mistake text,
  redo boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (attempt_id, question_id)
);

-- Notes and messages, both directions. Optionally pinned to an assignment/question.
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  learner_id uuid not null references public.profiles (id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  assignment_id uuid references public.assignments (id) on delete cascade,
  question_id uuid references public.questions (id) on delete cascade,
  attempt_id uuid references public.attempts (id) on delete cascade,
  body text not null default '',
  attachment_path text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  duration_min int not null default 60,
  learner_ids uuid[] not null default '{}',
  notes_md text,
  created_at timestamptz not null default now()
);

create table if not exists public.activity (
  id bigserial primary key,
  learner_id uuid not null references public.profiles (id) on delete cascade,
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('assignment', 'lesson', 'file', 'session')),
  ref_id uuid,
  subject_id uuid,
  topic_id uuid,
  seconds int not null check (seconds between 0 and 3600),
  day date not null default current_date,
  created_at timestamptz not null default now()
);

-- Drafts written by Claude (tutor's Claude Desktop); nothing reaches a learner until applied.
create table if not exists public.claude_drafts (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('marking', 'message', 'note')),
  learner_id uuid references public.profiles (id) on delete cascade,
  attempt_id uuid references public.attempts (id) on delete cascade,
  summary text,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'applied', 'discarded')),
  created_at timestamptz not null default now()
);

-- One inbox per person: drives desktop notifications and the phone alerts.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  ref jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create table if not exists public.tutor_settings (
  tutor_id uuid primary key references public.profiles (id) on delete cascade,
  ntfy_topic text not null default ('studybridge-' || encode(extensions.gen_random_bytes(9), 'hex')),
  notify_phone boolean not null default true,
  livekit_url text,
  created_at timestamptz not null default now()
);

-- Readable by no one directly; only the token function uses it.
create table if not exists public.tutor_secrets (
  tutor_id uuid primary key references public.profiles (id) on delete cascade,
  livekit_api_key text,
  livekit_api_secret text
);

-- Tests and exams: questions stay hidden until the learner starts an attempt.
create or replace function public._questions_open(p_assignment uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.assignments a where a.id = p_assignment
                  and (a.kind in ('homework', 'quiz') or a.tutor_id = auth.uid()
                       or exists (select 1 from public.attempts t where t.assignment_id = a.id and t.learner_id = auth.uid())))
$$;

create index if not exists idx_profiles_tutor on public.profiles (tutor_id);
create index if not exists idx_assignments_tutor on public.assignments (tutor_id);
create index if not exists idx_questions_assignment on public.questions (assignment_id, position);
create index if not exists idx_attempts_learner on public.attempts (learner_id, assignment_id);
create index if not exists idx_attempts_tutor_status on public.attempts (tutor_id, status);
create index if not exists idx_responses_attempt on public.responses (attempt_id);
create index if not exists idx_comments_pair on public.comments (tutor_id, learner_id, created_at);
create index if not exists idx_activity_learner_day on public.activity (learner_id, day);
create index if not exists idx_notifications_user on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- Privileges + row-level security
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke update on public.profiles from authenticated;
grant update (display_name, timezone, avatar_color) on public.profiles to authenticated;
revoke all on public.tutor_secrets from anon, authenticated;

alter table public.profiles enable row level security;
alter table public.programmes enable row level security;
alter table public.subjects enable row level security;
alter table public.topics enable row level security;
alter table public.learner_subjects enable row level security;
alter table public.invites enable row level security;
alter table public.files enable row level security;
alter table public.lessons enable row level security;
alter table public.assignments enable row level security;
alter table public.questions enable row level security;
alter table public.question_keys enable row level security;
alter table public.attempts enable row level security;
alter table public.responses enable row level security;
alter table public.comments enable row level security;
alter table public.sessions enable row level security;
alter table public.activity enable row level security;
alter table public.claude_drafts enable row level security;
alter table public.notifications enable row level security;
alter table public.tutor_settings enable row level security;
alter table public.tutor_secrets enable row level security;

-- (re)create policies
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- profiles
create policy profiles_read on public.profiles for select
  using (id = auth.uid() or tutor_id = auth.uid() or id = public.my_tutor());
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- tutor-owned structure: tutor does everything, their learners can read
create policy programmes_tutor on public.programmes for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy programmes_learner on public.programmes for select using (tutor_id = public.my_tutor());
create policy subjects_tutor on public.subjects for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy subjects_learner on public.subjects for select using (tutor_id = public.my_tutor());
create policy topics_tutor on public.topics for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy topics_learner on public.topics for select using (tutor_id = public.my_tutor());
create policy learner_subjects_tutor on public.learner_subjects for all
  using (tutor_id = auth.uid()) with check (tutor_id = auth.uid() and public.is_my_learner(learner_id));
create policy learner_subjects_self on public.learner_subjects for select using (learner_id = auth.uid());
create policy invites_tutor on public.invites for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());

-- library + lessons: learners only see what is released to them
create policy files_tutor on public.files for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy files_learner on public.files for select
  using (public.can_learner_see(tutor_id, learner_ids, subject_id, visibility, visible_from));
create policy lessons_tutor on public.lessons for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy lessons_learner on public.lessons for select
  using (public.can_learner_see(tutor_id, learner_ids, subject_id, visibility, visible_from));

-- assignments + questions
create policy assignments_tutor on public.assignments for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy assignments_learner on public.assignments for select
  using (not draft and public.can_learner_see(tutor_id, learner_ids, subject_id, visibility, visible_from));
create policy questions_tutor on public.questions for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy questions_learner on public.questions for select
  using (assignment_id in (select id from public.assignments) and public._questions_open(assignment_id));
create policy question_keys_tutor on public.question_keys for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
-- learners read attempts, responses and keys only through the functions below (which hide unreleased marks)

create policy attempts_tutor on public.attempts for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy responses_tutor on public.responses for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());

-- notes and messages
create policy comments_tutor_read on public.comments for select using (tutor_id = auth.uid());
create policy comments_tutor_write on public.comments for insert
  with check (tutor_id = auth.uid() and author_id = auth.uid() and public.is_my_learner(learner_id));
create policy comments_tutor_delete on public.comments for delete using (tutor_id = auth.uid());
create policy comments_learner_read on public.comments for select using (learner_id = auth.uid());
create policy comments_learner_write on public.comments for insert
  with check (learner_id = auth.uid() and author_id = auth.uid() and tutor_id = public.my_tutor());

create policy sessions_tutor on public.sessions for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy sessions_learner on public.sessions for select using (auth.uid() = any (learner_ids));

create policy activity_tutor on public.activity for select using (tutor_id = auth.uid());
create policy activity_learner on public.activity for select using (learner_id = auth.uid());

create policy drafts_tutor on public.claude_drafts for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());

create policy notifications_own on public.notifications for select using (user_id = auth.uid());
create policy notifications_mark on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy settings_tutor on public.tutor_settings for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());

-- ---------------------------------------------------------------------
-- Notifications (+ phone push through ntfy.sh when pg_net is available)
-- ---------------------------------------------------------------------
create or replace function public.notify_user(p_user uuid, p_kind text, p_title text, p_body text, p_ref jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare
  v_topic text;
  v_phone boolean;
begin
  insert into public.notifications (user_id, kind, title, body, ref) values (p_user, p_kind, p_title, p_body, coalesce(p_ref, '{}'));
  select ntfy_topic, notify_phone into v_topic, v_phone from public.tutor_settings where tutor_id = p_user;
  if v_topic is not null and v_phone and exists (select 1 from pg_extension where extname = 'pg_net') then
    begin
      execute 'select net.http_post(url := $1, body := $2)'
        using 'https://ntfy.sh', jsonb_build_object('topic', v_topic, 'title', p_title, 'message', coalesce(p_body, ''), 'tags', jsonb_build_array('books'));
    exception when others then
      raise notice 'phone alert failed: %', sqlerrm;
    end;
  end if;
end $$;
revoke all on function public.notify_user(uuid, text, text, text, jsonb) from public, anon, authenticated;

create or replace function public.on_comment_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_title text;
begin
  select display_name into v_name from public.profiles where id = new.author_id;
  if new.assignment_id is not null then
    select title into v_title from public.assignments where id = new.assignment_id;
  end if;
  if new.author_id = new.learner_id then
    perform public.notify_user(new.tutor_id, 'note',
      coalesce(v_name, 'Your learner') || case when v_title is not null then ' · ' || v_title else '' end,
      left(new.body, 240), jsonb_build_object('learner_id', new.learner_id, 'assignment_id', new.assignment_id, 'comment_id', new.id));
  else
    perform public.notify_user(new.learner_id, 'message', coalesce(v_name, 'Your tutor') || ' sent you a message',
      left(new.body, 240), jsonb_build_object('assignment_id', new.assignment_id, 'comment_id', new.id));
  end if;
  return new;
end $$;
drop trigger if exists comments_notify on public.comments;
create trigger comments_notify after insert on public.comments for each row execute function public.on_comment_created();

-- Mark notes/messages as read by whoever received them
create or replace function public.mark_comments_read(p_ids uuid[])
returns void language sql security definer set search_path = public as $$
  update public.comments set read_at = now()
   where id = any (p_ids) and read_at is null and author_id <> auth.uid()
     and (learner_id = auth.uid() or tutor_id = auth.uid())
$$;

-- ---------------------------------------------------------------------
-- Tutor + learner setup
-- ---------------------------------------------------------------------
create or replace function public.become_tutor(p_name text, p_timezone text default 'UTC')
returns public.profiles language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into v from public.profiles where id = auth.uid();
  if v.role = 'learner' then raise exception 'This account is a learner account.'; end if;
  update public.profiles
     set role = 'tutor', display_name = coalesce(nullif(trim(p_name), ''), display_name), timezone = coalesce(p_timezone, timezone)
   where id = auth.uid() returning * into v;
  insert into public.tutor_settings (tutor_id) values (auth.uid()) on conflict do nothing;
  return v;
end $$;

create or replace function public.accept_invite(p_code text, p_name text, p_timezone text default 'UTC')
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  inv public.invites;
  v public.profiles;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into inv from public.invites where code = upper(trim(p_code)) and not revoked for update;
  if inv.id is null then raise exception 'That invite code is not valid.'; end if;
  if inv.accepted_by is not null and inv.accepted_by <> auth.uid() then raise exception 'That invite has already been used.'; end if;
  select * into v from public.profiles where id = auth.uid();
  if v.role = 'tutor' then raise exception 'Tutor accounts cannot join as learners.'; end if;
  update public.profiles
     set role = 'learner', tutor_id = inv.tutor_id, programme_id = inv.programme_id,
         display_name = coalesce(nullif(trim(p_name), ''), nullif(inv.name, ''), display_name),
         timezone = coalesce(p_timezone, timezone)
   where id = auth.uid() returning * into v;
  insert into public.learner_subjects (learner_id, subject_id, tutor_id)
    select auth.uid(), s, inv.tutor_id from unnest(inv.subject_ids) s
    where exists (select 1 from public.subjects where id = s and tutor_id = inv.tutor_id)
  on conflict do nothing;
  update public.invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  perform public.notify_user(inv.tutor_id, 'joined', v.display_name || ' joined StudyBridge', 'They accepted your invite.',
    jsonb_build_object('learner_id', auth.uid()));
  return v;
end $$;

-- Tutor edits a learner: name, programme, subjects
create or replace function public.set_learner(p_learner uuid, p_name text, p_programme uuid, p_subject_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_my_learner(p_learner) then raise exception 'Not your learner.'; end if;
  if p_programme is not null and not exists (select 1 from public.programmes where id = p_programme and tutor_id = auth.uid()) then
    raise exception 'Unknown programme.';
  end if;
  update public.profiles set display_name = coalesce(nullif(trim(p_name), ''), display_name), programme_id = p_programme
   where id = p_learner;
  delete from public.learner_subjects where learner_id = p_learner and tutor_id = auth.uid()
    and not (subject_id = any (coalesce(p_subject_ids, '{}')));
  insert into public.learner_subjects (learner_id, subject_id, tutor_id)
    select p_learner, s, auth.uid() from unnest(coalesce(p_subject_ids, '{}')) s
    where exists (select 1 from public.subjects where id = s and tutor_id = auth.uid())
  on conflict do nothing;
end $$;

create or replace function public.remove_learner(p_learner uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_my_learner(p_learner) then raise exception 'Not your learner.'; end if;
  delete from public.learner_subjects where learner_id = p_learner;
  update public.profiles set tutor_id = null, role = null, programme_id = null where id = p_learner;
end $$;

-- ---------------------------------------------------------------------
-- Doing work
-- ---------------------------------------------------------------------
create or replace function public.start_attempt(p_assignment uuid, p_client text default 'desktop')
returns public.attempts language plpgsql security definer set search_path = public as $$
declare
  a public.assignments;
  cur public.attempts;
  n int;
begin
  select * into a from public.assignments where id = p_assignment;
  if a.id is null or a.draft or not public.can_learner_see(a.tutor_id, a.learner_ids, a.subject_id, a.visibility, a.visible_from) then
    raise exception 'That assignment is not available.';
  end if;
  if (a.lockdown or a.camera) and coalesce(p_client, '') <> 'desktop' then
    raise exception 'Open this in the StudyBridge desktop app: it needs % mode.',
      case when a.lockdown then 'lockdown' else 'camera' end;
  end if;
  select * into cur from public.attempts
   where assignment_id = p_assignment and learner_id = auth.uid() and status in ('in_progress', 'returned')
   order by number desc limit 1;
  if cur.id is not null then
    if cur.status = 'returned' then
      update public.attempts set status = 'in_progress' where id = cur.id returning * into cur;
    end if;
    return cur;
  end if;
  select count(*) into n from public.attempts where assignment_id = p_assignment and learner_id = auth.uid();
  if n >= a.max_attempts then raise exception 'You have used all your attempts for this.'; end if;
  insert into public.attempts (assignment_id, learner_id, tutor_id, number, max_score)
  values (p_assignment, auth.uid(), a.tutor_id, n + 1,
          (select coalesce(sum(marks), 0) from public.questions where assignment_id = p_assignment))
  returning * into cur;
  return cur;
end $$;

-- Is the attempt past its time limit? (small grace for slow connections)
create or replace function public._attempt_timed_out(p_attempt public.attempts) returns boolean
language sql stable set search_path = public as $$
  select coalesce((select a.time_limit_min is not null and now() > p_attempt.started_at + make_interval(mins => a.time_limit_min) + interval '2 minutes'
                     from public.assignments a where a.id = p_attempt.assignment_id), false)
$$;

create or replace function public.save_response(p_attempt uuid, p_question uuid, p_answer jsonb)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  t public.attempts;
  r public.responses;
begin
  select * into t from public.attempts where id = p_attempt and learner_id = auth.uid();
  if t.id is null then raise exception 'Attempt not found.'; end if;
  if not exists (select 1 from public.questions where id = p_question and assignment_id = t.assignment_id) then
    raise exception 'Question not in this assignment.';
  end if;
  select * into r from public.responses where attempt_id = p_attempt and question_id = p_question;
  if t.status <> 'in_progress' then raise exception 'This attempt has already been submitted.'; end if;
  if t.number > 0 and exists (select 1 from public.responses where attempt_id = p_attempt and redo)
     and r.id is not null and not r.redo then
    raise exception 'Only the questions marked for redo can be changed.';
  end if;
  if public._attempt_timed_out(t) then raise exception 'Time is up for this attempt.'; end if;
  insert into public.responses (attempt_id, question_id, learner_id, tutor_id, answer)
  values (p_attempt, p_question, auth.uid(), t.tutor_id, coalesce(p_answer, '{}'))
  on conflict (attempt_id, question_id) do update set answer = excluded.answer, updated_at = now();
  return now();
end $$;

-- Automatic marking for multiple choice and numeric questions.
create or replace function public._auto_mark(p_type text, p_answer jsonb, p_key jsonb, p_marks numeric)
returns numeric language plpgsql immutable as $$
declare
  v numeric;
  k numeric;
  tol numeric;
begin
  if p_key is null or p_key = '{}'::jsonb then return null; end if;
  if p_type = 'mcq' then
    if p_key ? 'choices' then
      return case when (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(p_answer -> 'choices') x)
                     = (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(p_key -> 'choices') x)
                  then p_marks else 0 end;
    end if;
    return case when p_answer ->> 'choice' = p_key ->> 'choice' then p_marks else 0 end;
  elsif p_type = 'numeric' then
    begin
      v := replace(trim(p_answer ->> 'value'), ',', '')::numeric;
      k := (p_key ->> 'value')::numeric;
    exception when others then
      return 0;
    end;
    if v is null or k is null then return 0; end if;
    tol := coalesce((p_key ->> 'tolerance')::numeric, 0);
    return case when abs(v - k) <= tol then p_marks else 0 end;
  end if;
  return null; -- short / steps / upload / drawing are marked by the tutor
end $$;

create or replace function public.submit_attempt(p_attempt uuid)
returns public.attempts language plpgsql security definer set search_path = public as $$
declare
  t public.attempts;
  a public.assignments;
  q record;
  v_auto numeric;
  v_all_auto boolean := true;
  v_total numeric := 0;
  v_name text;
  v_redo boolean;
begin
  select * into t from public.attempts where id = p_attempt and learner_id = auth.uid() for update;
  if t.id is null then raise exception 'Attempt not found.'; end if;
  if t.status <> 'in_progress' then raise exception 'Already submitted.'; end if;
  select * into a from public.assignments where id = t.assignment_id;
  select exists (select 1 from public.responses where attempt_id = t.id and redo) into v_redo;
  update public.responses set marks = null, auto_marks = null, step_marks = '[]', mistake = null
   where attempt_id = t.id and redo;

  for q in select qs.id, qs.type, qs.marks, k.answer as key from public.questions qs
             left join public.question_keys k on k.question_id = qs.id
            where qs.assignment_id = t.assignment_id loop
    insert into public.responses (attempt_id, question_id, learner_id, tutor_id)
    values (t.id, q.id, auth.uid(), t.tutor_id) on conflict do nothing;
    select public._auto_mark(q.type, r.answer, q.key, q.marks) into v_auto
      from public.responses r where r.attempt_id = t.id and r.question_id = q.id;
    if v_auto is null then
      v_all_auto := false;
    else
      update public.responses set auto_marks = v_auto, marks = coalesce(marks, v_auto)
       where attempt_id = t.id and question_id = q.id;
    end if;
  end loop;
  update public.responses set redo = false where attempt_id = t.id and redo;
  select bool_and(marks is not null) into v_all_auto from public.responses where attempt_id = t.id;
  v_all_auto := coalesce(v_all_auto, true);

  select coalesce(sum(marks), 0) into v_total from public.responses where attempt_id = t.id;
  update public.attempts
     set status = case when v_all_auto then 'marked' else 'submitted' end,
         submitted_at = now(),
         score = case when v_all_auto then v_total else null end,
         released = released or a.release_mode = 'on_submit',
         released_at = case when a.release_mode = 'on_submit' then now() else released_at end
   where id = t.id returning * into t;

  select display_name into v_name from public.profiles where id = auth.uid();
  perform public.notify_user(t.tutor_id, 'submitted',
    coalesce(v_name, 'Your learner') || case when v_redo then ' resubmitted ' else ' submitted ' end || a.title,
    case when v_all_auto then 'Marked automatically: ' || v_total || ' / ' || coalesce(t.max_score, 0) else 'Ready for you to mark.' end,
    jsonb_build_object('attempt_id', t.id, 'assignment_id', a.id, 'learner_id', auth.uid()));
  return t;
end $$;

-- Tutor finishes marking: totals the marks, optionally releases them.
create or replace function public.finish_marking(p_attempt uuid, p_release boolean, p_feedback text default null)
returns public.attempts language plpgsql security definer set search_path = public as $$
declare
  t public.attempts;
  a public.assignments;
  v_redo boolean;
begin
  select * into t from public.attempts where id = p_attempt and tutor_id = auth.uid() for update;
  if t.id is null then raise exception 'Attempt not found.'; end if;
  select * into a from public.assignments where id = t.assignment_id;
  select exists (select 1 from public.responses where attempt_id = t.id and redo) into v_redo;
  update public.attempts
     set score = (select coalesce(sum(marks), 0) from public.responses where attempt_id = t.id),
         status = case when v_redo then 'returned' else 'marked' end,
         feedback_md = coalesce(p_feedback, feedback_md),
         released = released or p_release or v_redo,
         released_at = case when (p_release or v_redo) and not released then now() else released_at end
   where id = t.id returning * into t;
  if t.released then
    perform public.notify_user(t.learner_id, 'marked',
      case when v_redo then 'Some questions need another try: ' else 'Your marks are back: ' end || a.title,
      case when v_redo then 'Open it to see the feedback and redo.' else 'Score ' || t.score || ' / ' || coalesce(t.max_score, 0) end,
      jsonb_build_object('attempt_id', t.id, 'assignment_id', a.id));
  end if;
  return t;
end $$;

create or replace function public._is_released(t public.attempts) returns boolean
language sql stable set search_path = public as $$
  select t.released or exists (select 1 from public.assignments a where a.id = t.assignment_id
                                 and a.release_mode = 'at' and a.release_at is not null and a.release_at <= now()
                                 and t.status in ('marked', 'returned'))
$$;

-- Learner's view of their attempts (marks hidden until released)
create or replace function public.my_attempts(p_assignment uuid default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'assignment_id', t.assignment_id, 'number', t.number, 'status', t.status,
    'started_at', t.started_at, 'submitted_at', t.submitted_at, 'time_spent_sec', t.time_spent_sec,
    'released', public._is_released(t),
    'score', case when public._is_released(t) then t.score end,
    'max_score', t.max_score,
    'feedback_md', case when public._is_released(t) then t.feedback_md end
  ) order by t.started_at desc), '[]')
  from public.attempts t
  where t.learner_id = auth.uid() and (p_assignment is null or t.assignment_id = p_assignment)
$$;

create or replace function public.attempt_detail(p_attempt uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  t public.attempts;
  a public.assignments;
  rel boolean;
  is_tutor boolean;
begin
  select * into t from public.attempts where id = p_attempt;
  if t.id is null or (t.learner_id <> auth.uid() and t.tutor_id <> auth.uid()) then raise exception 'Attempt not found.'; end if;
  is_tutor := t.tutor_id = auth.uid();
  select * into a from public.assignments where id = t.assignment_id;
  rel := public._is_released(t);
  return jsonb_build_object(
    'attempt', jsonb_build_object('id', t.id, 'assignment_id', t.assignment_id, 'learner_id', t.learner_id, 'number', t.number,
      'status', t.status, 'started_at', t.started_at, 'submitted_at', t.submitted_at, 'time_spent_sec', t.time_spent_sec,
      'released', rel, 'score', case when rel or is_tutor then t.score end, 'max_score', t.max_score,
      'feedback_md', case when rel or is_tutor then t.feedback_md end,
      'lockdown_events', case when is_tutor then t.lockdown_events else '[]'::jsonb end),
    'responses', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'question_id', r.question_id, 'answer', r.answer, 'updated_at', r.updated_at, 'redo', r.redo,
        'marks', case when rel or is_tutor then r.marks end,
        'auto_marks', case when rel or is_tutor then r.auto_marks end,
        'feedback_md', case when rel or is_tutor then r.feedback_md end,
        'step_marks', case when rel or is_tutor then r.step_marks else '[]'::jsonb end,
        'annotation_path', case when rel or is_tutor then r.annotation_path end,
        'mistake', case when rel or is_tutor then r.mistake end))
      from public.responses r where r.attempt_id = t.id), '[]'),
    'keys', case when is_tutor or (rel and a.show_answers) then coalesce((select jsonb_agg(jsonb_build_object(
        'question_id', k.question_id, 'answer', k.answer, 'mark_scheme_md', k.mark_scheme_md, 'solution_md', k.solution_md))
      from public.question_keys k join public.questions q on q.id = k.question_id where q.assignment_id = t.assignment_id), '[]')
      else '[]'::jsonb end
  );
end $$;

-- Time tracking (called every ~30 s while working or reading)
create or replace function public.log_time(p_kind text, p_ref uuid, p_seconds int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tutor uuid;
  v_subject uuid;
  v_topic uuid;
  s int := greatest(0, least(coalesce(p_seconds, 0), 120));
begin
  select tutor_id into v_tutor from public.profiles where id = auth.uid() and role = 'learner';
  if v_tutor is null or s = 0 then return; end if;
  if p_kind = 'assignment' then
    select a.subject_id, a.topic_id into v_subject, v_topic from public.attempts t join public.assignments a on a.id = t.assignment_id
     where t.id = p_ref and t.learner_id = auth.uid();
    if not found then return; end if;
    update public.attempts set time_spent_sec = time_spent_sec + s where id = p_ref and learner_id = auth.uid();
  elsif p_kind = 'lesson' then
    select subject_id, topic_id into v_subject, v_topic from public.lessons where id = p_ref;
  elsif p_kind = 'file' then
    select subject_id, topic_id into v_subject, v_topic from public.files where id = p_ref;
  elsif p_kind <> 'session' then
    return;
  end if;
  insert into public.activity (learner_id, tutor_id, kind, ref_id, subject_id, topic_id, seconds)
  values (auth.uid(), v_tutor, p_kind, p_ref, v_subject, v_topic, s);
end $$;

-- Lockdown: the desktop app reports leaving the exam window
create or replace function public.log_lockdown_event(p_attempt uuid, p_event text)
returns void language plpgsql security definer set search_path = public as $$
declare
  t public.attempts;
  v_name text;
  v_title text;
begin
  select * into t from public.attempts where id = p_attempt and learner_id = auth.uid();
  if t.id is null then return; end if;
  update public.attempts set lockdown_events = lockdown_events || jsonb_build_array(jsonb_build_object('at', now(), 'event', left(p_event, 200)))
   where id = t.id;
  select display_name into v_name from public.profiles where id = auth.uid();
  select title into v_title from public.assignments where id = t.assignment_id;
  perform public.notify_user(t.tutor_id, 'lockdown', coalesce(v_name, 'Learner') || ': ' || left(p_event, 120), v_title,
    jsonb_build_object('attempt_id', t.id, 'learner_id', t.learner_id));
end $$;

-- ---------------------------------------------------------------------
-- Progress, strengths and summaries
-- ---------------------------------------------------------------------
create or replace function public._can_view_learner(p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_learner = auth.uid() or public.is_my_learner(p_learner)
$$;

-- Strength per topic from the most recent marked answers (last 10 per topic).
create or replace function public.learner_progress(p_learner uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public._can_view_learner(p_learner) then raise exception 'Not allowed.'; end if;
  return jsonb_build_object(
    'topics', coalesce((
      select jsonb_agg(x order by x ->> 'subject', x ->> 'topic') from (
        select jsonb_build_object(
          'topic_id', tp.id, 'topic', tp.name, 'subject_id', sb.id, 'subject', sb.name,
          'answered', count(*),
          'ratio', round(sum(rr.marks) / nullif(sum(rr.max_marks), 0), 3),
          'strength', case when sum(rr.max_marks) = 0 then 'none'
                           when sum(rr.marks) / sum(rr.max_marks) >= 0.8 then 'strong'
                           when sum(rr.marks) / sum(rr.max_marks) >= 0.5 then 'developing'
                           else 'weak' end,
          'seconds', coalesce((select sum(ac.seconds) from public.activity ac where ac.learner_id = p_learner and ac.topic_id = tp.id), 0)
        ) as x
        from (
          select r.marks, q.marks as max_marks, coalesce(q.topic_id, a.topic_id) as topic_id,
                 row_number() over (partition by coalesce(q.topic_id, a.topic_id) order by t.submitted_at desc) as rn
          from public.responses r
          join public.attempts t on t.id = r.attempt_id
          join public.questions q on q.id = r.question_id
          join public.assignments a on a.id = t.assignment_id
          where r.learner_id = p_learner and r.marks is not null and t.status in ('marked', 'returned')
            and (p_learner <> auth.uid() or public._is_released(t))
        ) rr
        join public.topics tp on tp.id = rr.topic_id
        join public.subjects sb on sb.id = tp.subject_id
        where rr.rn <= 10
        group by tp.id, tp.name, sb.id, sb.name
      ) z), '[]'),
    'time_by_subject', coalesce((
      select jsonb_agg(jsonb_build_object('subject_id', s.id, 'subject', coalesce(s.name, 'Other'), 'seconds', z.seconds))
      from (select subject_id, sum(seconds) seconds from public.activity where learner_id = p_learner group by subject_id) z
      left join public.subjects s on s.id = z.subject_id), '[]'),
    'total_seconds', coalesce((select sum(seconds) from public.activity where learner_id = p_learner), 0),
    'mistakes', coalesce((
      select jsonb_agg(jsonb_build_object('mistake', r.mistake, 'feedback', r.feedback_md, 'question', left(q.prompt_md, 160),
                                          'assignment', a.title, 'at', t.submitted_at) order by t.submitted_at desc)
      from public.responses r join public.attempts t on t.id = r.attempt_id
      join public.questions q on q.id = r.question_id join public.assignments a on a.id = t.assignment_id
      where r.learner_id = p_learner and r.mistake is not null and r.mistake <> ''
        and (p_learner <> auth.uid() or public._is_released(t))), '[]')
  );
end $$;

-- Weekly / monthly (or any range) summary for one learner.
create or replace function public.learner_summary(p_learner uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public._can_view_learner(p_learner) then raise exception 'Not allowed.'; end if;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'seconds', coalesce((select sum(seconds) from public.activity where learner_id = p_learner and created_at >= p_from and created_at < p_to), 0),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'seconds', s) order by day)
                        from (select day, sum(seconds) s from public.activity where learner_id = p_learner
                               and created_at >= p_from and created_at < p_to group by day) d), '[]'),
    'by_subject', coalesce((select jsonb_agg(jsonb_build_object('subject', coalesce(sb.name, 'Other'), 'seconds', s))
                            from (select subject_id, sum(seconds) s from public.activity where learner_id = p_learner
                                   and created_at >= p_from and created_at < p_to group by subject_id) d
                            left join public.subjects sb on sb.id = d.subject_id), '[]'),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object(
          'title', a.title, 'kind', a.kind, 'due_at', a.due_at, 'submitted_at', t.submitted_at, 'status', t.status,
          'late', a.due_at is not null and t.submitted_at > a.due_at,
          'score', case when p_learner <> auth.uid() or public._is_released(t) then t.score end, 'max_score', t.max_score,
          'lockdown_flags', jsonb_array_length(case when p_learner <> auth.uid() then t.lockdown_events else '[]'::jsonb end))
          order by t.submitted_at)
        from public.attempts t join public.assignments a on a.id = t.assignment_id
        where t.learner_id = p_learner and t.submitted_at >= p_from and t.submitted_at < p_to), '[]'),
    'missed', coalesce((select jsonb_agg(jsonb_build_object('title', a.title, 'due_at', a.due_at))
        from public.assignments a
        where a.tutor_id = (select tutor_id from public.profiles where id = p_learner)
          and not a.draft and a.due_at >= p_from and a.due_at < least(p_to, now())
          and (a.learner_ids is null or cardinality(a.learner_ids) = 0 or p_learner = any (a.learner_ids))
          and not exists (select 1 from public.attempts t where t.assignment_id = a.id and t.learner_id = p_learner
                          and t.submitted_at is not null)), '[]'),
    'notes', (select count(*) from public.comments where learner_id = p_learner and author_id = p_learner
               and created_at >= p_from and created_at < p_to),
    'mistakes', coalesce((select jsonb_agg(r.mistake) from public.responses r join public.attempts t on t.id = r.attempt_id
        where r.learner_id = p_learner and r.mistake is not null and r.mistake <> '' and t.submitted_at >= p_from and t.submitted_at < p_to
          and (p_learner <> auth.uid() or public._is_released(t))), '[]')
  );
end $$;

-- ---------------------------------------------------------------------
-- Claude drafts → applied by the tutor
-- ---------------------------------------------------------------------
create or replace function public.apply_draft(p_draft uuid, p_payload jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  d public.claude_drafts;
  m jsonb;
  pl jsonb;
begin
  select * into d from public.claude_drafts where id = p_draft and tutor_id = auth.uid() and status = 'pending' for update;
  if d.id is null then raise exception 'Draft not found.'; end if;
  pl := coalesce(p_payload, d.payload);
  if d.kind = 'marking' then
    for m in select * from jsonb_array_elements(coalesce(pl -> 'marks', '[]')) loop
      update public.responses
         set marks = coalesce((m ->> 'marks')::numeric, marks),
             feedback_md = coalesce(m ->> 'feedback_md', feedback_md),
             step_marks = coalesce(m -> 'step_marks', step_marks),
             mistake = coalesce(m ->> 'mistake', mistake),
             redo = coalesce((m ->> 'redo')::boolean, redo),
             updated_at = now()
       where attempt_id = d.attempt_id and question_id = (m ->> 'question_id')::uuid and tutor_id = auth.uid();
    end loop;
    if pl ? 'feedback_md' then
      update public.attempts set feedback_md = pl ->> 'feedback_md' where id = d.attempt_id and tutor_id = auth.uid();
    end if;
  elsif d.kind = 'message' then
    insert into public.comments (tutor_id, learner_id, author_id, body)
    values (auth.uid(), d.learner_id, auth.uid(), pl ->> 'body');
  end if;
  update public.claude_drafts set status = 'applied', payload = pl where id = d.id;
end $$;

-- ---------------------------------------------------------------------
-- Live video (LiveKit): short-lived access passes, signed here so the
-- LiveKit secret never leaves the database.
-- ---------------------------------------------------------------------
create or replace function public._b64url(b bytea) returns text
language sql immutable as $$
  select rtrim(translate(encode(b, 'base64'), E'+/\n', '-_'), '=')
$$;

create or replace function public._jwt_hs256(p_payload jsonb, p_secret text) returns text
language plpgsql immutable set search_path = public, extensions as $$
declare
  h text := public._b64url(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'));
  b text := public._b64url(convert_to(p_payload::text, 'utf8'));
begin
  return h || '.' || b || '.' || public._b64url(extensions.hmac(convert_to(h || '.' || b, 'utf8'), convert_to(p_secret, 'utf8'), 'sha256'));
end $$;

create or replace function public.set_live_keys(p_url text, p_key text, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() <> 'tutor' then raise exception 'Tutors only.'; end if;
  insert into public.tutor_settings (tutor_id, livekit_url) values (auth.uid(), p_url)
    on conflict (tutor_id) do update set livekit_url = excluded.livekit_url;
  insert into public.tutor_secrets (tutor_id, livekit_api_key, livekit_api_secret) values (auth.uid(), p_key, p_secret)
    on conflict (tutor_id) do update set livekit_api_key = excluded.livekit_api_key,
      livekit_api_secret = coalesce(nullif(excluded.livekit_api_secret, ''), public.tutor_secrets.livekit_api_secret);
end $$;

-- Rooms: 'session-<uuid>' (lessons) and 'attempt-<uuid>' (exam camera).
create or replace function public.live_pass(p_room text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tutor uuid;
  v_publish boolean := true;
  v_id uuid;
  v_url text;
  v_key text;
  v_secret text;
  v_name text;
  v_now bigint := extract(epoch from now())::bigint;
begin
  begin
    v_id := substring(p_room from '([0-9a-f-]{36})$')::uuid;
  exception when others then raise exception 'Unknown room.'; end;
  if p_room like 'session-%' then
    select tutor_id into v_tutor from public.sessions where id = v_id and (tutor_id = auth.uid() or auth.uid() = any (learner_ids));
  elsif p_room like 'attempt-%' then
    select tutor_id into v_tutor from public.attempts where id = v_id and (tutor_id = auth.uid() or learner_id = auth.uid());
    v_publish := v_tutor is not null and v_tutor <> auth.uid(); -- the learner sends camera; the tutor only watches
  end if;
  if v_tutor is null then raise exception 'You are not part of this room.'; end if;
  select s.livekit_url, k.livekit_api_key, k.livekit_api_secret into v_url, v_key, v_secret
    from public.tutor_settings s left join public.tutor_secrets k on k.tutor_id = s.tutor_id where s.tutor_id = v_tutor;
  if v_url is null or v_key is null or v_secret is null then
    raise exception 'Live video is not set up yet. The tutor adds the LiveKit keys in Settings.';
  end if;
  select display_name into v_name from public.profiles where id = auth.uid();
  return jsonb_build_object('url', v_url, 'token', public._jwt_hs256(jsonb_build_object(
    'iss', v_key, 'sub', auth.uid()::text, 'name', coalesce(v_name, ''), 'nbf', v_now - 10, 'exp', v_now + 6 * 3600,
    'video', jsonb_build_object('room', p_room, 'roomJoin', true, 'canPublish', v_publish, 'canSubscribe', true, 'canPublishData', true)
  ), v_secret));
end $$;

create or replace function public.live_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('configured', exists (
    select 1 from public.tutor_settings s join public.tutor_secrets k on k.tutor_id = s.tutor_id
     where s.tutor_id = public.my_tutor() and s.livekit_url is not null and k.livekit_api_key is not null and k.livekit_api_secret is not null),
    'url', (select livekit_url from public.tutor_settings where tutor_id = public.my_tutor()))
$$;

-- Notify a learner when a session is scheduled for them
create or replace function public.on_session_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare l uuid;
begin
  foreach l in array new.learner_ids loop
    perform public.notify_user(l, 'session', 'Live session: ' || new.title,
      'Starts ' || to_char(new.starts_at at time zone coalesce((select timezone from public.profiles where id = l), 'UTC'),
                           'Dy DD Mon, HH24:MI'), jsonb_build_object('session_id', new.id));
  end loop;
  return new;
end $$;
drop trigger if exists sessions_notify on public.sessions;
create trigger sessions_notify after insert on public.sessions for each row execute function public.on_session_created();

grant execute on all functions in schema public to authenticated;
revoke execute on function public.notify_user(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- File storage: 'library' (tutor uploads) and 'work' (learner answers)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('library', 'library', false, 209715200), ('work', 'work', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists sb_library_tutor on storage.objects;
drop policy if exists sb_library_learner on storage.objects;
drop policy if exists sb_work_learner on storage.objects;
drop policy if exists sb_work_tutor on storage.objects;

-- Tutor: everything under library/<tutor id>/...
create policy sb_library_tutor on storage.objects for all to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'library' and (storage.foldername(name))[1] = auth.uid()::text);

-- Learner: question/lesson images, plus library files released to them
create policy sb_library_learner on storage.objects for select to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = public.my_tutor()::text and (
    (storage.foldername(name))[2] in ('questions', 'lessons')
    or exists (select 1 from public.files f where f.storage_path = storage.objects.name
               and public.can_learner_see(f.tutor_id, f.learner_ids, f.subject_id, f.visibility, f.visible_from))));

-- Learner: their own work under work/<learner id>/...
create policy sb_work_learner on storage.objects for all to authenticated
  using (bucket_id = 'work' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'work' and (storage.foldername(name))[1] = auth.uid()::text);

-- Tutor: read their learners' work, and write marking annotations
create policy sb_work_tutor on storage.objects for all to authenticated
  using (bucket_id = 'work' and (storage.foldername(name))[1] in (select id::text from public.profiles where tutor_id = auth.uid()))
  with check (bucket_id = 'work' and (storage.foldername(name))[1] in (select id::text from public.profiles where tutor_id = auth.uid()));

-- ---------------------------------------------------------------------
-- Live updates in the app
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['notifications', 'comments', 'attempts', 'responses', 'assignments', 'sessions', 'claude_drafts'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when others then null;
      end;
    end loop;
  end if;
end $$;

select 'StudyBridge database is ready' as status;
