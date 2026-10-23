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

-- The demo StudyBridge's fake accounts (see admin_demo_build): fenced off from Admin's numbers, lists and emails
alter table public.profiles add column if not exists demo boolean not null default false;
alter table public.profiles add column if not exists demo_label text;

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

-- One row of settings for the whole StudyBridge. New tutor accounts are off
-- by default, so only the owner (the first tutor) can run this StudyBridge.
create table if not exists public.app_config (
  id int primary key default 1 check (id = 1),
  allow_new_tutors boolean not null default false
);
insert into public.app_config (id) values (1) on conflict do nothing;

-- StudyBridge as a service: anyone can sign up as a tutor and the StudyBridge
-- admin approves them. Learners only ever join through a tutor's invite.
alter table public.app_config add column if not exists tutor_signups_open boolean not null default true;
alter table public.app_config add column if not exists prof_model text not null default 'claude-sonnet-5-5';
alter table public.app_config add column if not exists default_ai_limit_cents int not null default 1000;
alter table public.app_config add column if not exists prof_endpoint text;
alter table public.app_config add column if not exists prof_seen_at timestamptz;
alter table public.app_config add column if not exists livekit_url text;

alter table public.profiles add column if not exists status text not null default 'active';
alter table public.profiles add column if not exists plan text not null default 'free';
alter table public.profiles add column if not exists plan_learners int; -- a Custom plan: how many learners the admin allows
alter table public.profiles add column if not exists plan_until date;   -- a Complimentary plan: free until this day (empty: no end)
-- Plans are chosen from a list (7 Oct 2026). Anything typed in by hand before then becomes Complimentary,
-- so nothing changes for those tutors and they're never charged.
update public.profiles set plan = 'complimentary' where plan not in ('free', 'starter', 'pro', 'custom', 'complimentary');
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_plan_check') then
    alter table public.profiles add constraint profiles_plan_check check (plan in ('free', 'starter', 'pro', 'custom', 'complimentary'));
  end if;
end $$;
-- A tutor's own Prof allowance (when the admin set one). Only the admin sees it, so it lives in
-- its own table nobody reads directly; early builds kept it on profiles, move it over.
create table if not exists public.prof_limits (
  tutor_id uuid primary key references public.profiles (id) on delete cascade,
  cents int not null check (cents >= 0)
);
alter table public.prof_limits enable row level security;
revoke all on public.prof_limits from public, anon, authenticated;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'ai_limit_cents') then
    execute 'insert into public.prof_limits (tutor_id, cents) select id, ai_limit_cents from public.profiles where ai_limit_cents is not null on conflict do nothing';
    execute 'alter table public.profiles drop column ai_limit_cents';
  end if;
end $$;
do $$ begin
  alter table public.profiles add constraint profiles_status_check check (status in ('pending', 'active', 'suspended'));
exception when duplicate_object then null; end $$;

-- The StudyBridge admin(s). The first tutor ever becomes the admin.
create table if not exists public.platform_admins (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
insert into public.platform_admins (user_id)
  select id from public.profiles where role = 'tutor' and not exists (select 1 from public.platform_admins)
  order by created_at limit 1;

-- Keys only the server uses (the Claude key for Prof, shared live-video keys). Nobody can read them back.
create table if not exists public.platform_secrets (
  id int primary key default 1 check (id = 1),
  anthropic_api_key text,
  livekit_api_key text,
  livekit_api_secret text,
  hook_secret text not null default encode(extensions.gen_random_bytes(24), 'hex')
);
insert into public.platform_secrets (id) values (1) on conflict do nothing;

-- The StudyBridge admin is its own account (role 'admin'), never a tutor account.
do $$ begin
  alter table public.profiles drop constraint if exists profiles_role_check;
  alter table public.profiles add constraint profiles_role_check check (role in ('tutor', 'learner', 'admin', 'parent'));
end $$;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins a join public.profiles p on p.id = a.user_id
                  where a.user_id = auth.uid() and p.role = 'admin')
$$;

-- An approved tutor (pending and paused tutors can't invite anyone or use Prof)
create or replace function public._tutor_active(p_tutor uuid default null) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = coalesce(p_tutor, auth.uid()) and role = 'tutor' and status = 'active')
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

-- warnings a locked-down test or exam gives before trying to leave hands it in (1.6)
alter table public.assignments add column if not exists leave_warnings int not null default 1;
do $$ begin
  alter table public.assignments add constraint assignments_leave_warnings_check check (leave_warnings between 0 and 5);
exception when duplicate_object then null; end $$;

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

-- 1.6: locked-down tests and exams hand themselves in after too many tries to leave; why it was handed in
alter table public.attempts add column if not exists strikes int not null default 0;
alter table public.attempts add column if not exists auto_reason text;

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
-- Prof's note to the tutor about an answer (what it read a drawing or photo as, anything to check); never shown to learners
alter table public.responses add column if not exists prof_note text;

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

-- Past papers: where a library file sits in the exam catalogue (board, syllabus, year, session, paper).
-- Imported papers stay on the tutor's computer (cloud = false) until the tutor shares one with learners.
-- A saved link has no file at all (link_url). StudyBridge never stores exam-board files for anyone else.
alter table public.files add column if not exists exam_board text;
alter table public.files add column if not exists exam_code text;
alter table public.files add column if not exists exam_year int;
alter table public.files add column if not exists exam_session text;
alter table public.files add column if not exists exam_kind text;
alter table public.files add column if not exists exam_paper text;
alter table public.files add column if not exists exam_level text;
alter table public.files add column if not exists exam_tz text;
alter table public.files add column if not exists sha256 text;
alter table public.files add column if not exists cloud boolean not null default true;
alter table public.files add column if not exists link_url text;
do $$ begin
  alter table public.files add constraint files_local_hidden check (cloud or visibility = 'hidden');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.files add constraint files_link_http check (link_url is null or link_url ~* '^https?://');
exception when duplicate_object then null; end $$;
create index if not exists idx_files_exam on public.files (tutor_id, exam_board, exam_code);
alter table public.tutor_settings add column if not exists exam_subjects text[] not null default '{}';
-- Which exam a subject is for ('cie:0607', 'ib:math-aa'), so Past papers shows your learners' exams first
alter table public.subjects add column if not exists exam text;
do $$ begin
  alter table public.subjects add constraint subjects_exam_check check (exam is null or exam ~ '^(cie|ib):[a-z0-9-]{2,40}$');
exception when duplicate_object then null; end $$;

-- Practice: tutor-approved questions a learner can do any time, as often as they like, marked instantly
alter table public.assignments add column if not exists practice boolean not null default false;

alter table public.lessons add column if not exists draft boolean not null default false;
alter table public.lessons add column if not exists source text not null default 'tutor';
-- Lesson notes written for a live lesson (Live → a past lesson → Write lesson notes)
alter table public.lessons add column if not exists session_id uuid references public.sessions (id) on delete set null;
alter table public.claude_drafts add column if not exists source text not null default 'claude';

-- What the StudyBridge admin did to an account (tutors see the entries about them)
create table if not exists public.admin_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  admin_id uuid references public.profiles (id) on delete set null,
  action text not null,
  user_id uuid,
  tutor_id uuid,
  email text,
  detail jsonb not null default '{}'
);

-- Prof, the AI teaching assistant (runs on the server; tutors only; makes drafts the tutor approves)
create table if not exists public.prof_settings (
  tutor_id uuid primary key references public.profiles (id) on delete cascade,
  auto_mark boolean not null default false,
  auto_create boolean not null default false,
  auto_day int not null default 0 check (auto_day between 0 and 6),
  auto_hour int not null default 17 check (auto_hour between 0 and 23),
  auto_count int not null default 8 check (auto_count between 3 and 30),
  auto_kind text not null default 'homework' check (auto_kind in ('homework', 'quiz')),
  style_md text not null default '',
  last_auto_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.prof_jobs (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('ask', 'mark', 'auto')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  prompt text not null default '',
  context jsonb not null default '{}',
  attempt_id uuid references public.attempts (id) on delete cascade,
  state jsonb not null default '{}',
  result jsonb not null default '{}',
  progress text,
  error text,
  model text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_cents numeric not null default 0,
  steps int not null default 0,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

-- What each Prof job cost. Only the StudyBridge admin sees money; tutors never do.
create table if not exists public.prof_costs (
  id bigserial primary key,
  job_id uuid unique references public.prof_jobs (id) on delete set null,
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  model text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_cents numeric not null default 0
);
create index if not exists idx_prof_costs_tutor on public.prof_costs (tutor_id, created_at);
-- Move what older versions kept on the job itself
insert into public.prof_costs (job_id, tutor_id, created_at, model, input_tokens, output_tokens, cost_cents)
  select id, tutor_id, created_at, model, input_tokens, output_tokens, cost_cents from public.prof_jobs
   where cost_cents <> 0 or input_tokens <> 0 or output_tokens <> 0
  on conflict (job_id) do nothing;
update public.prof_jobs set cost_cents = 0, input_tokens = 0, output_tokens = 0
 where cost_cents <> 0 or input_tokens <> 0 or output_tokens <> 0;

-- Warnings already sent to the admin (80% / 100% of a tutor's monthly Prof allowance)
create table if not exists public.prof_alerts (
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  month date not null,
  level int not null,
  at timestamptz not null default now(),
  primary key (tutor_id, month, level)
);
do $$ begin
  alter table public.prof_jobs drop constraint if exists prof_jobs_kind_check;
  alter table public.prof_jobs add constraint prof_jobs_kind_check check (kind in ('ask', 'mark', 'auto', 'bank', 'report', 'syllabus', 'paper', 'cards', 'boundaries', 'plan'));
end $$;
do $$ begin
  alter table public.prof_jobs drop constraint if exists prof_jobs_status_check;
  alter table public.prof_jobs add constraint prof_jobs_status_check
    check (status in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled'));
end $$;
create index if not exists idx_prof_jobs_tutor on public.prof_jobs (tutor_id, created_at desc);
create index if not exists idx_prof_jobs_status on public.prof_jobs (status, created_at);

-- The question bank: questions a tutor keeps to reuse (their own). StudyBridge's exam-style questions are the
-- content account's own bank questions; tutors read the checked ones for their exams (bank_studybridge_read).
-- (owner_id null was the old shared bank, no longer handed to tutors.)
-- Answers live here too, so learners never read this table; questions are copied into assignments.
create table if not exists public.bank_questions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles (id) on delete cascade,
  status text not null default 'approved' check (status in ('review', 'approved', 'rejected')),
  exam_board text,
  exam_code text,
  subject_id uuid references public.subjects (id) on delete set null,
  topic text,
  difficulty int check (difficulty between 1 and 3),
  type text not null check (type in ('mcq', 'numeric', 'short', 'steps', 'upload', 'drawing')),
  prompt_md text not null default '',
  image_path text,
  options jsonb not null default '[]',
  marks numeric not null default 1 check (marks >= 0),
  answer jsonb not null default '{}',
  mark_scheme_md text,
  solution_md text,
  source text not null default 'tutor',
  source_ref text,
  check_result jsonb,
  job_id uuid references public.prof_jobs (id) on delete set null,
  uses int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_bank_owner on public.bank_questions (owner_id, status, exam_code);
create index if not exists idx_bank_shared on public.bank_questions (exam_code, topic) where owner_id is null;

-- Weekly reports for a parent. The LEARNER switches them on and gives the parent's contact (learners are
-- adults); the tutor sets the exam date. Reports are drafted, the tutor approves and sends them.
create table if not exists public.learner_reports (
  learner_id uuid primary key references public.profiles (id) on delete cascade,
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  enabled boolean not null default false,
  parent_name text,
  parent_phone text,
  parent_email text,
  exam_name text,
  exam_date date,
  updated_at timestamptz not null default now()
);
create table if not exists public.parent_reports (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  learner_id uuid not null references public.profiles (id) on delete cascade,
  week_start date not null,
  status text not null default 'draft' check (status in ('draft', 'sent')),
  data jsonb not null default '{}',
  summary text,
  comment text,
  next_week text,
  prof boolean not null default false,
  sent_at timestamptz,
  sent_via text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tutor_id, learner_id, week_start)
);
do $$ begin
  alter table public.parent_reports drop constraint if exists parent_reports_learner_id_week_start_key;
  alter table public.parent_reports add constraint parent_reports_tutor_id_learner_id_week_start_key unique (tutor_id, learner_id, week_start);
exception when duplicate_table or duplicate_object then null; end $$;
alter table public.prof_settings add column if not exists auto_reports boolean not null default false;
alter table public.app_config add column if not exists reports_at timestamptz;

-- Prof's own notes on pages of a tutor's book, so it reads the notes next time instead of the pictures (cheaper)
create table if not exists public.book_notes (
  file_id uuid not null references public.files (id) on delete cascade,
  page int not null check (page > 0),
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  notes text not null,
  created_at timestamptz not null default now(),
  primary key (file_id, page)
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
revoke insert, update, delete on public.app_config from anon, authenticated;
revoke all on public.tutor_secrets from anon, authenticated;
revoke all on public.platform_secrets from anon, authenticated;
revoke all on public.platform_admins from anon, authenticated;
revoke all on public.prof_costs from anon, authenticated;
revoke all on public.prof_alerts from anon, authenticated;
revoke insert, update, delete on public.admin_log from anon, authenticated;
revoke insert, update, delete on public.prof_jobs from anon, authenticated;
revoke insert, update, delete on public.learner_reports from anon, authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

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
alter table public.app_config enable row level security;
alter table public.platform_admins enable row level security;
alter table public.prof_costs enable row level security;
alter table public.prof_alerts enable row level security;
alter table public.platform_secrets enable row level security;
alter table public.admin_log enable row level security;
alter table public.prof_settings enable row level security;
alter table public.prof_jobs enable row level security;
alter table public.bank_questions enable row level security;
alter table public.learner_reports enable row level security;
alter table public.parent_reports enable row level security;
alter table public.book_notes enable row level security;

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
create policy invites_tutor_read on public.invites for select using (tutor_id = auth.uid());
create policy invites_tutor_write on public.invites for insert with check (tutor_id = auth.uid() and public._tutor_active());
create policy invites_tutor_update on public.invites for update using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy invites_tutor_delete on public.invites for delete using (tutor_id = auth.uid());

-- library + lessons: learners only see what is released to them
create policy files_tutor on public.files for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy files_learner on public.files for select
  using (public.can_learner_see(tutor_id, learner_ids, subject_id, visibility, visible_from));
create policy lessons_tutor on public.lessons for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
-- question bank: a tutor's own questions (StudyBridge's checked ones are read through bank_studybridge_read,
-- in the "one StudyBridge library" block near the end)
create policy bank_own on public.bank_questions for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid() and public.my_role() = 'tutor');
-- parent reports: the learner's choice and contact are changed only through set_parent_reports / set_learner_exam
create policy learner_reports_read on public.learner_reports for select using (learner_id = auth.uid() or (tutor_id = auth.uid() and public.is_my_learner(learner_id)));
create policy parent_reports_tutor on public.parent_reports for all
  using (tutor_id = auth.uid())
  with check (tutor_id = auth.uid() and public.is_my_learner(learner_id)
              and (status = 'draft' or exists (select 1 from public.learner_reports r where r.learner_id = parent_reports.learner_id and r.tutor_id = auth.uid() and r.enabled)));
create policy book_notes_tutor on public.book_notes for select using (tutor_id = auth.uid());
create policy book_notes_delete on public.book_notes for delete using (tutor_id = auth.uid());
create policy parent_reports_learner on public.parent_reports for select using (learner_id = auth.uid() and status = 'sent');
create policy bank_admin on public.bank_questions for all
  using (owner_id is null and public.is_platform_admin()) with check (owner_id is null and public.is_platform_admin());
create policy lessons_learner on public.lessons for select
  using (not draft and public.can_learner_see(tutor_id, learner_ids, subject_id, visibility, visible_from));

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

create policy app_config_read on public.app_config for select using (auth.uid() is not null);
create policy settings_tutor on public.tutor_settings for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());

-- The admin log: admins read everything in it; a tutor reads what was done to their own account or learners
create policy admin_log_read on public.admin_log for select
  using (public.is_platform_admin() or tutor_id = auth.uid() or user_id = auth.uid());
create policy prof_settings_tutor on public.prof_settings for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid());
create policy prof_jobs_tutor on public.prof_jobs for select using (tutor_id = auth.uid());

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
  if v_topic is null and to_regclass('public.phone_alerts') is not null then
    select ntfy_topic, enabled into v_topic, v_phone from public.phone_alerts where user_id = p_user;
  end if;
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
drop function if exists public.become_tutor(text, text);
-- p_signup: what a new tutor told us when signing up (subjects, country, how many learners), for the admin
create or replace function public.become_tutor(p_name text, p_timezone text default 'UTC', p_signup jsonb default null)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  v_first boolean;
  a uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into v from public.profiles where id = auth.uid();
  if v.role = 'learner' then raise exception 'This account is a learner account.'; end if;
  -- The admin account (or the email chosen for it) signing in through the tutor screen: leave it
  -- as it is, and the app opens Admin (or offers "Set up admin account")
  if v.role = 'admin' or (v.role is null and public.admin_invited()) then return v; end if;
  if v.role = 'tutor' then
    update public.profiles set display_name = coalesce(nullif(trim(p_name), ''), display_name) where id = auth.uid() returning * into v;
    return v;
  end if;
  -- The very first tutor is the StudyBridge admin; everyone after waits for the admin's approval.
  v_first := not exists (select 1 from public.platform_admins);
  if not v_first and not (select tutor_signups_open from public.app_config where id = 1) then
    raise exception 'StudyBridge isn’t taking new tutors right now.';
  end if;
  update public.profiles
     set role = 'tutor', status = case when v_first then 'active' else 'pending' end,
         display_name = coalesce(nullif(trim(p_name), ''), display_name), timezone = coalesce(p_timezone, timezone),
         signup = jsonb_strip_nulls(jsonb_build_object(
           'subjects', left(p_signup ->> 'subjects', 300), 'country', left(p_signup ->> 'country', 100), 'learners', left(p_signup ->> 'learners', 50)))
   where id = auth.uid() returning * into v;
  insert into public.tutor_settings (tutor_id) values (auth.uid()) on conflict do nothing;
  if v_first then
    insert into public.platform_admins (user_id) values (auth.uid()) on conflict do nothing;
  else
    for a in select user_id from public.platform_admins loop
      perform public.notify_user(a, 'tutor_signup', 'New tutor waiting: ' || v.display_name,
        coalesce(v.email, '') || ' wants to teach on StudyBridge. Approve them in Admin.', jsonb_build_object('user_id', v.id));
    end loop;
  end if;
  return v;
end $$;

-- (older apps call this) open or close tutor sign-ups
create or replace function public.set_allow_new_tutors(p_allow boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'StudyBridge admins only.'; end if;
  update public.app_config set tutor_signups_open = p_allow, allow_new_tutors = p_allow where id = 1;
end $$;

-- Learners join with an 8-digit code (4829 1375) instead of a long pasted invite. A short code is easier to guess, so
-- every wrong code is counted, and 10 wrong codes in an hour make that account wait. (A wrong code returns no profile
-- instead of raising an error, because an error would also undo the count.)
create table if not exists public.invite_tries (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists invite_tries_user on public.invite_tries (user_id, at);
alter table public.invite_tries enable row level security;
revoke all on public.invite_tries from anon, authenticated;

create or replace function public._new_invite_code() returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  b bytea;
  c text;
begin
  loop
    b := extensions.gen_random_bytes(4);
    c := lpad(((get_byte(b, 0)::bigint * 16777216 + get_byte(b, 1) * 65536 + get_byte(b, 2) * 256 + get_byte(b, 3)) % 100000000)::text, 8, '0');
    exit when not exists (select 1 from public.invites where code = c);
  end loop;
  return c;
end $$;
alter table public.invites alter column code set default public._new_invite_code();

create or replace function public.accept_invite(p_code text, p_name text, p_timezone text default 'UTC')
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  inv public.invites;
  v public.profiles;
  c text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if (select count(*) from public.invite_tries where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many wrong codes. Wait an hour, or ask your tutor to send the code again.';
  end if;
  select * into inv from public.invites where code = c and not revoked for update;
  if inv.id is null and to_regclass('public.class_teachers') is not null
     and exists (select 1 from public.classes where join_code = c and not archived) then
    perform public.join_class(c);
    update public.profiles set display_name = coalesce(nullif(trim(p_name), ''), display_name), timezone = coalesce(p_timezone, timezone)
     where id = auth.uid() returning * into v;
    return v;
  end if;
  if inv.id is null then
    insert into public.invite_tries (user_id) values (auth.uid());
    delete from public.invite_tries where at < now() - interval '1 day';
    return null;
  end if;
  if inv.accepted_by is not null and inv.accepted_by <> auth.uid() then raise exception 'That invite has already been used.'; end if;
  select * into v from public.profiles where id = auth.uid();
  if v.role in ('tutor', 'admin') then raise exception 'Tutor and admin accounts cannot join as learners.'; end if;
  if not public._tutor_active(inv.tutor_id) then raise exception 'This invite can’t be used right now. Ask your tutor.'; end if;
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
  delete from public.learner_reports where learner_id = auth.uid() and tutor_id <> inv.tutor_id;
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
  delete from public.learner_subjects where learner_id = p_learner and tutor_id = auth.uid();
  delete from public.learner_reports where learner_id = p_learner; -- the parent's contact goes with the learner
  if to_regclass('public.parent_links') is not null then
    execute 'delete from public.parent_links where learner_id = $1' using p_learner; -- and parents lose access
  end if;
  update public.profiles set tutor_id = null, role = null, programme_id = null where id = p_learner;
end $$;

-- ---------------------------------------------------------------------
-- Tutor admin: learners' accounts, password resets, deleting an account
-- ---------------------------------------------------------------------
create or replace function public.learner_accounts()
returns table (id uuid, email text, joined_at timestamptz, last_sign_in_at timestamptz)
language sql stable security definer set search_path = public as $$
  select u.id, u.email::text, u.created_at, u.last_sign_in_at
    from auth.users u join public.profiles p on p.id = u.id
   where p.tutor_id = auth.uid() and p.role = 'learner'
   order by p.display_name
$$;

create or replace function public.set_learner_password(p_learner uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_my_learner(p_learner) then raise exception 'Not your learner.'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Use a password of at least 6 characters.'; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now())
   where id = p_learner;
end $$;

-- Files a learner uploaded as answers (the app deletes these before the account)
create or replace function public.learner_work_paths(p_learner uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct p), '{}') from (
    select f ->> 'path' as p from public.responses r, jsonb_array_elements(coalesce(r.answer -> 'files', '[]'::jsonb)) f
     where r.learner_id = p_learner and public.is_my_learner(p_learner)
    union all
    select annotation_path from public.responses where learner_id = p_learner and public.is_my_learner(p_learner)
    union all
    select attachment_path from public.comments where learner_id = p_learner and public.is_my_learner(p_learner)
  ) x where p is not null
$$;

-- Deletes the learner's sign-in and everything of theirs (work, marks, notes, progress). Can't be undone.
create or replace function public.delete_learner_account(p_learner uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_my_learner(p_learner) then raise exception 'Not your learner.'; end if;
  delete from public.invites where accepted_by = p_learner;
  delete from auth.users where id = p_learner;
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
    elsif public._attempt_timed_out(cur) then
      cur := public._hand_in(cur.id, 'time ran out');
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
  -- (redo requests are not timed)
  select coalesce((select a.time_limit_min is not null and now() > p_attempt.started_at + make_interval(mins => a.time_limit_min) + interval '2 minutes'
                     from public.assignments a where a.id = p_attempt.assignment_id), false)
     and not exists (select 1 from public.responses r where r.attempt_id = p_attempt.id and r.redo)
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

-- Hands an attempt in: marks what can be marked automatically and tells the tutor. p_why says why it was
-- handed in for the learner (time ran out, tried to leave a locked-down exam, ended by the tutor).
create or replace function public._hand_in(p_attempt uuid, p_why text default null)
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
  select * into t from public.attempts where id = p_attempt for update;
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
    values (t.id, q.id, t.learner_id, t.tutor_id) on conflict do nothing;
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
         released_at = case when a.release_mode = 'on_submit' then now() else released_at end,
         auto_reason = p_why
   where id = t.id returning * into t;

  select display_name into v_name from public.profiles where id = t.learner_id;
  if p_why is not null then
    perform public.notify_user(t.learner_id, 'auto_submitted', 'Your ' || lower(coalesce(a.title, 'work')) || ' was handed in',
      'Handed in automatically: ' || p_why || '. Your answers were kept.', jsonb_build_object('attempt_id', t.id, 'assignment_id', a.id));
  end if;
  -- practice is marked instantly and shows in progress; the tutor isn't pinged each time
  if a.practice and v_all_auto then return t; end if;
  perform public.notify_user(t.tutor_id, 'submitted',
    coalesce(v_name, 'Your learner') || case when v_redo then ' resubmitted ' else ' submitted ' end || a.title
      || case when p_why is not null then ' (handed in automatically)' else '' end,
    case when p_why is not null then 'Handed in automatically: ' || p_why || '. ' else '' end
      || case when v_all_auto then 'Marked automatically: ' || v_total || ' / ' || coalesce(t.max_score, 0) else 'Ready for you to mark.' end,
    jsonb_build_object('attempt_id', t.id, 'assignment_id', a.id, 'learner_id', t.learner_id));
  return t;
end $$;

create or replace function public.submit_attempt(p_attempt uuid)
returns public.attempts language plpgsql security definer set search_path = public as $$
declare t public.attempts;
begin
  select * into t from public.attempts where id = p_attempt and learner_id = auth.uid();
  if t.id is null then raise exception 'Attempt not found.'; end if;
  if t.status <> 'in_progress' then raise exception 'Already submitted.'; end if;
  return public._hand_in(p_attempt, null);
end $$;

-- Tutor finishes marking: totals the marks, optionally releases them.
-- Return marks (p_release), or save them for later. With p_redo the questions ticked "redo" go back to the learner;
-- without it the marks are final and any redo ticks are cleared.
drop function if exists public.finish_marking(uuid, boolean, text);
create or replace function public.finish_marking(p_attempt uuid, p_release boolean, p_feedback text default null, p_redo boolean default true)
returns public.attempts language plpgsql security definer set search_path = public as $$
declare
  t public.attempts;
  a public.assignments;
  v_redo boolean;
begin
  select * into t from public.attempts where id = p_attempt and tutor_id = auth.uid() for update;
  if t.id is null then raise exception 'Attempt not found.'; end if;
  select * into a from public.assignments where id = t.assignment_id;
  if p_release and not coalesce(p_redo, true) then
    update public.responses set redo = false where attempt_id = t.id and redo;
  end if;
  v_redo := p_release and exists (select 1 from public.responses where attempt_id = t.id and redo);
  update public.attempts
     set score = (select coalesce(sum(marks), 0) from public.responses where attempt_id = t.id),
         status = case when v_redo then 'returned' else 'marked' end,
         feedback_md = coalesce(public._fix_newlines(p_feedback), feedback_md),
         released = released or p_release,
         released_at = case when p_release and not released then now() else released_at end
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
    'released_at', case when public._is_released(t) then t.released_at end,
    'score', case when public._is_released(t) then t.score end,
    'max_score', t.max_score,
    'feedback_md', case when public._is_released(t) then t.feedback_md end
  ) order by t.started_at desc), '[]')
  from public.attempts t
  where t.learner_id = auth.uid() and (p_assignment is null or t.assignment_id = p_assignment)
$$;

-- Self-marked work: the answers and mark scheme show only once the learner can't change
-- anything any more (handed in, no redo open, no attempts left).
alter table public.assignments add column if not exists self_mark boolean not null default false;
create or replace function public._self_mark_open(t public.attempts, a public.assignments) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(a.self_mark, false) and t.status in ('submitted', 'marked')
     and not exists (select 1 from public.attempts x where x.assignment_id = t.assignment_id and x.learner_id = t.learner_id
                                                     and x.status in ('in_progress', 'returned'))
     and (select count(*) from public.attempts x where x.assignment_id = t.assignment_id and x.learner_id = t.learner_id) >= a.max_attempts
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
      'lockdown_events', case when is_tutor then t.lockdown_events else '[]'::jsonb end,
      'self_mark', a.self_mark, 'self_marked_at', t.self_marked_at, 'self_mark_open', public._self_mark_open(t, a),
      'strikes', t.strikes, 'auto_reason', t.auto_reason),
    'responses', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'question_id', r.question_id, 'answer', r.answer, 'updated_at', r.updated_at, 'redo', r.redo,
        'prof_note', case when is_tutor then r.prof_note end,
        'marks', case when rel or is_tutor then r.marks end,
        'auto_marks', case when rel or is_tutor then r.auto_marks end,
        'feedback_md', case when rel or is_tutor then r.feedback_md end,
        'step_marks', case when rel or is_tutor then r.step_marks else '[]'::jsonb end,
        'annotation_path', case when rel or is_tutor then r.annotation_path end,
        'mistake', case when rel or is_tutor then r.mistake end,
        'self_marks', r.self_marks))
      from public.responses r where r.attempt_id = t.id), '[]'),
    'keys', case when is_tutor or (rel and a.show_answers) or public._self_mark_open(t, a) then coalesce((select jsonb_agg(jsonb_build_object(
        'question_id', k.question_id, 'answer', k.answer, 'mark_scheme_md', case when is_tutor or a.self_mark then k.mark_scheme_md end, 'solution_md', k.solution_md))
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
  v_tz text;
  s int := greatest(0, least(coalesce(p_seconds, 0), 120));
begin
  select tutor_id, timezone into v_tutor, v_tz from public.profiles where id = auth.uid() and role = 'learner';
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
  elsif p_kind = 'study' then
    select id into v_subject from public.subjects where id = p_ref;
  elsif p_kind <> 'session' then
    return;
  end if;
  insert into public.activity (learner_id, tutor_id, kind, ref_id, subject_id, topic_id, seconds, day)
  values (auth.uid(), v_tutor, p_kind, p_ref, v_subject, v_topic, s,
          (now() at time zone coalesce((select name from pg_timezone_names where name = v_tz), 'UTC'))::date);
end $$;

-- Lockdown: the desktop app reports leaving the exam window
create or replace function public.log_lockdown_event(p_attempt uuid, p_event text)
returns void language plpgsql security definer set search_path = public as $$
declare
  t public.attempts;
  v_name text;
  v_title text;
  v_kind text;
  v_event text;
begin
  select * into t from public.attempts where id = p_attempt and learner_id = auth.uid();
  if t.id is null then return; end if;
  select title, kind into v_title, v_kind from public.assignments where id = t.assignment_id;
  v_event := replace(p_event, 'the exam', 'the ' || coalesce(v_kind, 'exam'));
  update public.attempts set lockdown_events = lockdown_events || jsonb_build_array(jsonb_build_object('at', now(), 'event', left(v_event, 200)))
   where id = t.id;
  select display_name into v_name from public.profiles where id = auth.uid();
  perform public.notify_user(t.tutor_id, 'lockdown', coalesce(v_name, 'Learner') || ': ' || left(v_event, 120), v_title,
    jsonb_build_object('attempt_id', t.id, 'learner_id', t.learner_id));
end $$;

-- ---------------------------------------------------------------------
-- Progress, strengths and summaries
-- ---------------------------------------------------------------------
create or replace function public._can_view_learner(p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_learner = auth.uid() or public.is_my_learner(p_learner)
$$;

-- What a learner is strong and weak at, by topic (last 10 answers per topic). p_released_only: only marks
-- the learner has been given back (for the learner's own view and for parent reports).
drop function if exists public._learner_topics(uuid, boolean);
create or replace function public._learner_topics(p_learner uuid, p_released_only boolean, p_tutor uuid default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
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
            and (not p_released_only or public._is_released(t))
        ) rr
        join public.topics tp on tp.id = rr.topic_id
        join public.subjects sb on sb.id = tp.subject_id
        where rr.rn <= 10 and (p_tutor is null or sb.tutor_id = p_tutor)
        group by tp.id, tp.name, sb.id, sb.name
      ) z), '[]')
$$;

create or replace function public.learner_progress(p_learner uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public._can_view_learner(p_learner) then raise exception 'Not allowed.'; end if;
  return jsonb_build_object(
    'topics', public._learner_topics(p_learner, p_learner = auth.uid(), case when p_learner = auth.uid() then null else auth.uid() end),
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
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'seconds', d.s, 'subjects', d.subj) order by d.day)
                        from (select a.day, sum(a.seconds) s,
                                     (select coalesce(jsonb_agg(jsonb_build_object('subject', coalesce(sb.name, 'Other'), 'seconds', x.s) order by x.s desc), '[]')
                                        from (select a2.subject_id, sum(a2.seconds) s from public.activity a2
                                               where a2.learner_id = p_learner and a2.day = a.day and a2.created_at >= p_from and a2.created_at < p_to
                                               group by a2.subject_id) x
                                        left join public.subjects sb on sb.id = x.subject_id) subj
                                from public.activity a where a.learner_id = p_learner
                               and a.created_at >= p_from and a.created_at < p_to group by a.day) d), '[]'),
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
-- Text that arrived with "\n" written out instead of a real line break (it happened in Prof's feedback, 6 Oct 2026).
-- Maths commands that start with \n (\neq, \nabla, \not, \nu…) are left alone: a lowercase letter follows them.
create or replace function public._fix_newlines(p text) returns text
language sql immutable as $$
  select case when p is null then null else regexp_replace(replace(p, E'\\r\\n', E'\n'), '\\n(?![a-z])', E'\n', 'g') end
$$;
update public.attempts set feedback_md = public._fix_newlines(feedback_md) where strpos(feedback_md, E'\\n') > 0;
update public.responses set feedback_md = public._fix_newlines(feedback_md) where strpos(feedback_md, E'\\n') > 0;
update public.claude_drafts set payload = jsonb_set(payload, '{feedback_md}', to_jsonb(public._fix_newlines(payload ->> 'feedback_md')))
 where status = 'pending' and strpos(payload ->> 'feedback_md', E'\\n') > 0;

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
             feedback_md = coalesce(public._fix_newlines(m ->> 'feedback_md'), feedback_md),
             step_marks = coalesce(m -> 'step_marks', step_marks),
             mistake = coalesce(m ->> 'mistake', mistake),
             redo = coalesce((m ->> 'redo')::boolean, redo),
             prof_note = coalesce(m ->> 'prof_note', prof_note),
             updated_at = now()
       where attempt_id = d.attempt_id and question_id = (m ->> 'question_id')::uuid and tutor_id = auth.uid();
    end loop;
    if pl ? 'feedback_md' then
      update public.attempts set feedback_md = public._fix_newlines(pl ->> 'feedback_md') where id = d.attempt_id and tutor_id = auth.uid();
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
  if public.my_role() is distinct from 'tutor' then raise exception 'Tutors only.'; end if;
  insert into public.tutor_settings (tutor_id, livekit_url) values (auth.uid(), p_url)
    on conflict (tutor_id) do update set livekit_url = excluded.livekit_url;
  insert into public.tutor_secrets (tutor_id, livekit_api_key, livekit_api_secret) values (auth.uid(), p_key, p_secret)
    on conflict (tutor_id) do update set livekit_api_key = excluded.livekit_api_key,
      livekit_api_secret = coalesce(nullif(excluded.livekit_api_secret, ''), public.tutor_secrets.livekit_api_secret);
end $$;

-- Settings → Phone alerts → Send a test
create or replace function public.test_phone_alert()
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is distinct from 'tutor' then raise exception 'Tutors only.'; end if;
  perform public.notify_user(auth.uid(), 'test', 'StudyBridge test alert', 'Phone alerts are working.', '{}');
  return exists (select 1 from pg_extension where extname = 'pg_net');
end $$;

-- Rooms: 'session-<uuid>' (lessons) and 'attempt-<uuid>' (exam camera).
create or replace function public.live_pass(p_room text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tutor uuid;
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
  end if;
  if v_tutor is null then raise exception 'You are not part of this room.'; end if;
  -- StudyBridge provides live video for every tutor (9 Oct 2026); a tutor's own keys from before only if it isn't set up
  select c.livekit_url, ps.livekit_api_key, ps.livekit_api_secret into v_url, v_key, v_secret
    from public.app_config c, public.platform_secrets ps where c.id = 1 and ps.id = 1;
  if v_url is null or v_key is null or v_secret is null then
    select s.livekit_url, k.livekit_api_key, k.livekit_api_secret into v_url, v_key, v_secret
      from public.tutor_settings s left join public.tutor_secrets k on k.tutor_id = s.tutor_id where s.tutor_id = v_tutor;
  end if;
  if v_url is null or v_key is null or v_secret is null then
    raise exception 'Live video isn’t switched on yet. StudyBridge is setting it up.';
  end if;
  select display_name into v_name from public.profiles where id = auth.uid();
  return jsonb_build_object('url', v_url, 'token', public._jwt_hs256(jsonb_build_object(
    'iss', v_key, 'sub', auth.uid()::text, 'name', coalesce(v_name, ''), 'nbf', v_now - 10, 'exp', v_now + 6 * 3600,
    'video', jsonb_build_object('room', p_room, 'roomJoin', true, 'canPublish', true, 'canSubscribe', true, 'canPublishData', true)
  ), v_secret));
end $$;

create or replace function public.live_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'configured', own or shared,
    'own', own,
    'shared', shared,
    'url', coalesce((select livekit_url from public.app_config where id = 1), (select livekit_url from public.tutor_settings where tutor_id = public.my_tutor())))
  from (select
    exists (select 1 from public.tutor_settings s join public.tutor_secrets k on k.tutor_id = s.tutor_id
             where s.tutor_id = public.my_tutor() and s.livekit_url is not null and k.livekit_api_key is not null and k.livekit_api_secret is not null) as own,
    exists (select 1 from public.app_config c, public.platform_secrets ps
             where c.id = 1 and ps.id = 1 and c.livekit_url is not null and ps.livekit_api_key is not null and ps.livekit_api_secret is not null) as shared) x
$$;

-- Who an item is for: chosen learners, else everyone taking the subject, else all the tutor's learners
create or replace function public._audience(p_tutor uuid, p_learner_ids uuid[], p_subject uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  select p.id from public.profiles p
   where p.tutor_id = p_tutor and p.role = 'learner'
     and case when p_learner_ids is not null and cardinality(p_learner_ids) > 0 then p.id = any (p_learner_ids)
              when p_subject is not null then exists (select 1 from public.learner_subjects ls where ls.learner_id = p.id and ls.subject_id = p_subject)
              else true end
$$;

-- Tell learners when new work or a lesson becomes visible to them
create or replace function public.on_published() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  l uuid;
  was_live boolean := false;
  is_live boolean;
  v_title text;
  v_body text;
begin
  is_live := new.visibility = 'visible' and not coalesce((to_jsonb(new) ->> 'draft')::boolean, false);
  if tg_op = 'UPDATE' then
    was_live := old.visibility = 'visible' and not coalesce((to_jsonb(old) ->> 'draft')::boolean, false);
  end if;
  if not is_live or was_live then return new; end if;
  if tg_table_name = 'assignments' and new.source = 'self' then return new; end if;  -- practice the learner started
  if tg_table_name = 'assignments' then
    v_title := 'New ' || new.kind || ': ' || new.title;
  else
    v_title := 'New lesson notes: ' || new.title;
    v_body := 'Open StudyBridge to read it.';
  end if;
  for l in select public._audience(new.tutor_id, new.learner_ids, new.subject_id) loop
    if tg_table_name = 'assignments' then
      -- due time in the learner's own time zone
      v_body := case when new.due_at is not null
        then 'Due ' || to_char(new.due_at at time zone coalesce((select p.timezone from public.profiles p join pg_timezone_names z on z.name = p.timezone where p.id = l), 'UTC'), 'Dy DD Mon, HH24:MI')
        else 'Open StudyBridge to start.' end;
    end if;
    perform public.notify_user(l, case when tg_table_name = 'assignments' then 'assignment' else 'lesson' end, v_title, v_body,
      jsonb_build_object(case when tg_table_name = 'assignments' then 'assignment_id' else 'lesson_id' end, new.id));
  end loop;
  return new;
end $$;
drop trigger if exists assignments_published on public.assignments;
create trigger assignments_published after insert or update of visibility, draft on public.assignments
  for each row execute function public.on_published();
drop trigger if exists lessons_published on public.lessons;
create trigger lessons_published after insert or update of visibility, draft on public.lessons
  for each row execute function public.on_published();

-- Notify a learner when a session is scheduled for them
create or replace function public.on_session_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare l uuid;
begin
  if new.series_id is not null then return new; end if;
  foreach l in array new.learner_ids loop
    perform public.notify_user(l, 'session', 'Live session: ' || new.title,
      'Starts ' || to_char(new.starts_at at time zone coalesce((select timezone from public.profiles where id = l), 'UTC'),
                           'Dy DD Mon, HH24:MI'), jsonb_build_object('session_id', new.id));
  end loop;
  return new;
end $$;
drop trigger if exists sessions_notify on public.sessions;
create trigger sessions_notify after insert on public.sessions for each row execute function public.on_session_created();

-- =====================================================================
-- StudyBridge admin console. Account details only: names, emails, status,
-- sign-in dates, how many learners, storage and AI used. Never anyone's
-- work, files, marks or messages. Every action is written to admin_log.
-- =====================================================================
create or replace function public._admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'StudyBridge admins only.'; end if;
end $$;

create or replace function public._admin_log(p_action text, p_user uuid, p_detail jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tutor uuid;
  v_email text;
begin
  select case when role = 'tutor' then id else tutor_id end, email into v_tutor, v_email from public.profiles where id = p_user;
  insert into public.admin_log (admin_id, action, user_id, tutor_id, email, detail)
  values (auth.uid(), p_action, p_user, v_tutor, v_email, coalesce(p_detail, '{}'));
end $$;

-- Bytes of files a tutor's StudyBridge uses (their library + their learners' work)
create or replace function public._storage_bytes(p_tutor uuid) returns bigint
language plpgsql stable security definer set search_path = public as $$
declare n bigint;
begin
  begin
    execute $q$select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o
      where (o.bucket_id = 'library' and (storage.foldername(o.name))[1] = $1::text)
         or (o.bucket_id = 'work' and (storage.foldername(o.name))[1] in (select id::text from public.profiles where tutor_id = $1))$q$
      into n using p_tutor;
  exception when others then n := null;
  end;
  return n;
end $$;

-- Prof's spending: this calendar month, and the tutor's monthly allowance
create or replace function public._prof_month_cents(p_tutor uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_cents), 0) from public.prof_costs where tutor_id = p_tutor and created_at >= date_trunc('month', now())
$$;
create or replace function public._prof_limit(p_tutor uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select cents from public.prof_limits where tutor_id = p_tutor), (select default_ai_limit_cents from public.app_config where id = 1))
$$;

create or replace function public.admin_tutors() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.display_name, 'email', coalesce(u.email::text, p.email), 'status', p.status, 'plan', p.plan,
      'plan_learners', p.plan_learners, 'plan_until', p.plan_until, 'plan_limit', public._tutor_limit(p.id),
      'joined_at', coalesce(u.created_at, p.created_at), 'last_sign_in_at', u.last_sign_in_at,
      'is_admin', exists (select 1 from public.platform_admins a where a.user_id = p.id),
      'learners', (select count(*) from public.profiles l where l.tutor_id = p.id and l.role = 'learner'),
      'storage_bytes', public._storage_bytes(p.id),
      'ai_cents', public._prof_month_cents(p.id),
      'ai_limit_cents', public._prof_limit(p.id),
      'ai_limit_custom', exists (select 1 from public.prof_limits pl where pl.tutor_id = p.id),
      'signup', p.signup, 'app_version', p.app_version, 'last_seen_at', p.last_seen_at
    ) order by (p.status = 'pending') desc, p.created_at)
    from public.profiles p left join auth.users u on u.id = p.id where p.role = 'tutor'), '[]');
end $$;

-- A tutor's learners, or (no tutor) accounts that never finished signing up
create or replace function public.admin_accounts(p_tutor uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'email', coalesce(u.email::text, p.email), 'role', p.role,
                                        'joined_at', coalesce(u.created_at, p.created_at), 'last_sign_in_at', u.last_sign_in_at) order by p.display_name)
    from public.profiles p left join auth.users u on u.id = p.id
    where case when p_tutor is null then p.role is null else p.tutor_id = p_tutor and p.role = 'learner' end), '[]');
end $$;

-- Approve a waiting tutor, pause (suspend) one, or switch them back on
create or replace function public.admin_set_status(p_user uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  perform public._admin();
  if p_status not in ('active', 'suspended') then raise exception 'Unknown status.'; end if;
  if p_user = auth.uid() then raise exception 'You can’t change your own account here.'; end if;
  select * into v from public.profiles where id = p_user;
  if v.id is null or v.role is distinct from 'tutor' then raise exception 'That isn’t a tutor account.'; end if;
  if v.status = p_status then return; end if;
  update public.profiles set status = p_status where id = p_user;
  -- a paused tutor can't sign in at all (their learners still can, and keep their past work)
  begin
    execute 'update auth.users set banned_until = $2 where id = $1'
      using p_user, case when p_status = 'suspended' then now() + interval '100 years' end;
  exception when others then raise notice 'could not change sign-in: %', sqlerrm;
  end;
  if p_status = 'suspended' then
    begin
      execute 'delete from auth.refresh_tokens where user_id = $1::text' using p_user;
    exception when others then null;
    end;
    begin
      execute 'delete from auth.sessions where user_id = $1' using p_user;
    exception when others then null;
    end;
  end if;
  if v.status = 'pending' and p_status = 'active' then
    perform public.notify_user(p_user, 'approved', 'You’re approved!',
      'Your StudyBridge tutor account is ready. Add your subjects, then invite your learners.', '{}');
  end if;
  perform public._admin_log(case when p_status = 'suspended' then 'paused' when v.status = 'pending' then 'approved' else 'switched_on' end, p_user);
end $$;

drop function if exists public.admin_set_plan(uuid, text, int);
create or replace function public.admin_set_plan(p_user uuid, p_plan text, p_ai_limit_cents int default null,
  p_learners int default null, p_until date default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_learners int;
begin
  perform public._admin();
  if not exists (select 1 from public.profiles where id = p_user and role = 'tutor') then raise exception 'That isn’t a tutor account.'; end if;
  if p_ai_limit_cents is not null and p_ai_limit_cents < 0 then raise exception 'The AI limit can’t be negative.'; end if;
  if coalesce(p_plan, '') not in ('free', 'starter', 'pro', 'custom', 'complimentary') then raise exception 'Choose a plan from the list.'; end if;
  select coalesce(p_learners, plan_learners) into v_learners from public.profiles where id = p_user;
  if p_plan = 'custom' and (v_learners is null or v_learners < 1) then raise exception 'Say how many learners the custom plan allows.'; end if;
  update public.profiles
     set plan = p_plan,
         plan_learners = case when p_plan = 'custom' then v_learners else plan_learners end,
         plan_until = case when p_plan = 'complimentary' then p_until end
   where id = p_user;
  if p_ai_limit_cents is null then
    delete from public.prof_limits where tutor_id = p_user;
  else
    insert into public.prof_limits (tutor_id, cents) values (p_user, p_ai_limit_cents)
      on conflict (tutor_id) do update set cents = excluded.cents;
  end if;
  -- the log is readable by the tutor it's about, so it never holds Prof amounts
  perform public._admin_log('plan', p_user, jsonb_build_object('plan', p_plan));
end $$;
-- earlier builds wrote the amount into the log
update public.admin_log set detail = detail - 'ai_limit_cents' where detail ? 'ai_limit_cents';

create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._admin();
  if length(coalesce(p_password, '')) < 6 then raise exception 'Use a password of at least 6 characters.'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'Account not found.'; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now())
   where id = p_user;
  perform public._admin_log('password_reset', p_user);
end $$;

-- Deletes an account. A tutor's learners and everything in that StudyBridge go with it. Can't be undone.
create or replace function public.admin_delete_account(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  n int := 0;
begin
  perform public._admin();
  if p_user = auth.uid() then raise exception 'You can’t delete your own account here.'; end if;
  select * into v from public.profiles where id = p_user;
  if v.id is null then raise exception 'Account not found.'; end if;
  if exists (select 1 from public.platform_admins where user_id = p_user) then raise exception 'That account is a StudyBridge admin.'; end if;
  if v.role = 'tutor' then
    select count(*) into n from public.profiles where tutor_id = p_user and role = 'learner';
  end if;
  perform public._admin_log('deleted', p_user, jsonb_build_object('role', v.role, 'name', v.display_name, 'learners', n));
  if v.role = 'tutor' then
    delete from auth.users where id in (select id from public.profiles where tutor_id = p_user and role = 'learner');
  end if;
  delete from public.invites where accepted_by = p_user;
  delete from auth.users where id = p_user;
  return jsonb_build_object('deleted', 1 + n);
end $$;

-- Moves admin from a tutor account (how it used to work) to its own admin account. The new
-- account must already exist and not be set up as a tutor or learner yet.
create or replace function public._make_admin(p_email text, p_by uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  select p.* into v from public.profiles p join auth.users u on u.id = p.id
   where lower(u.email) = lower(trim(coalesce(p_email, '')));
  if v.id is null then
    raise exception 'No StudyBridge account with that email yet. Sign up with it first, stop at the “Finish setting up” screen, then try again.';
  end if;
  if v.id = p_by then raise exception 'Use a different email from your tutor account.'; end if;
  if v.role is not null and v.role <> 'admin' then
    raise exception 'That account is already set up as a %. Use a new email for the admin account.', v.role;
  end if;
  update public.profiles set role = 'admin', status = 'active', tutor_id = null where id = v.id;
  insert into public.platform_admins (user_id) values (v.id) on conflict do nothing;
  -- Tutor accounts lose admin
  delete from public.platform_admins a using public.profiles p where p.id = a.user_id and p.role = 'tutor';
  insert into public.admin_log (admin_id, action, user_id, email, detail)
  values (coalesce(p_by, v.id), 'admin_moved', v.id, v.email, jsonb_build_object('name', v.display_name));
  return jsonb_build_object('id', v.id, 'email', v.email);
end $$;

-- (kept with the server secrets: nobody can read it back)
alter table public.platform_secrets add column if not exists admin_invite text;

-- From the app: only a tutor account that was the admin (the old way) can do this. If the admin
-- email has no account yet, it's remembered, and signing up with it offers "Set up as admin".
create or replace function public.admin_move_to(p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id uuid;
begin
  if not exists (select 1 from public.platform_admins a join public.profiles p on p.id = a.user_id
                  where a.user_id = auth.uid() and p.role = 'tutor') then
    raise exception 'StudyBridge admins only.';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter an email address.'; end if;
  if v_email = (select lower(email) from auth.users where id = auth.uid()) then
    raise exception 'Use a different email from your tutor account.';
  end if;
  select id into v_id from auth.users where lower(email) = v_email;
  if v_id is null then
    update public.platform_secrets set admin_invite = v_email where id = 1;
    return jsonb_build_object('moved', false, 'email', v_email);
  end if;
  perform public._make_admin(v_email, auth.uid());
  update public.platform_secrets set admin_invite = null where id = 1;
  return jsonb_build_object('moved', true, 'email', v_email);
end $$;

-- Signed up with the email the old admin chose, and not set up as anything yet
create or replace function public.admin_invited() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p join auth.users u on u.id = p.id, public.platform_secrets c
                  where p.id = auth.uid() and p.role is null and c.id = 1 and c.admin_invite is not null
                    and lower(u.email) = c.admin_invite)
$$;

create or replace function public.claim_admin()
returns public.profiles language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  if not public.admin_invited() then raise exception 'This account wasn’t chosen as the StudyBridge admin.'; end if;
  perform public._make_admin((select email from auth.users where id = auth.uid()), null);
  update public.platform_secrets set admin_invite = null where id = 1;
  select * into v from public.profiles where id = auth.uid();
  return v;
end $$;

-- True for a tutor account that still holds admin the old way (the app then offers the move)
create or replace function public.admin_to_move() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins a join public.profiles p on p.id = a.user_id
                  where a.user_id = auth.uid() and p.role = 'tutor')
$$;

-- From the Supabase SQL editor only (e.g. if you're locked out): select public.make_admin('you+admin@example.com');
create or replace function public.make_admin(p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return public._make_admin(p_email, null);
end $$;

create or replace function public.admin_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return (select jsonb_build_object(
    'tutor_signups_open', c.tutor_signups_open, 'prof_model', c.prof_model, 'default_ai_limit_cents', c.default_ai_limit_cents,
    'prof_key_set', s.anthropic_api_key is not null, 'prof_endpoint', c.prof_endpoint, 'prof_seen_at', c.prof_seen_at,
    'livekit_url', c.livekit_url, 'livekit_set', s.livekit_api_key is not null and s.livekit_api_secret is not null,
    'pg_net', exists (select 1 from pg_extension where extname = 'pg_net'),
    'pg_cron', exists (select 1 from pg_extension where extname = 'pg_cron'),
    'ai_cents_month', (select coalesce(sum(cost_cents), 0) from public.prof_costs where created_at >= date_trunc('month', now())))
    from public.app_config c, public.platform_secrets s where c.id = 1 and s.id = 1);
end $$;

create or replace function public.admin_set_signups(p_open boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  update public.app_config set tutor_signups_open = p_open where id = 1;
end $$;

-- Prof's Claude key (write-only: nobody can read it back), model and default monthly allowance per tutor
create or replace function public.admin_set_prof(p_key text default null, p_model text default null, p_default_limit_cents int default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  if nullif(trim(coalesce(p_key, '')), '') is not null then
    if trim(p_key) !~ '^sk-ant-' then raise exception 'That doesn’t look like a Claude API key (they start with sk-ant-).'; end if;
    update public.platform_secrets set anthropic_api_key = trim(p_key) where id = 1;
  end if;
  update public.app_config set prof_model = coalesce(nullif(trim(p_model), ''), prof_model),
                               default_ai_limit_cents = coalesce(p_default_limit_cents, default_ai_limit_cents) where id = 1;
end $$;

-- Live video for every tutor who hasn't added their own LiveKit keys
create or replace function public.admin_set_livekit(p_url text, p_key text, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  update public.app_config set livekit_url = nullif(trim(p_url), '') where id = 1;
  update public.platform_secrets set livekit_api_key = coalesce(nullif(trim(p_key), ''), livekit_api_key),
                                     livekit_api_secret = coalesce(nullif(trim(p_secret), ''), livekit_api_secret) where id = 1;
end $$;

-- =====================================================================
-- Prof: the AI teaching assistant. Runs on the server (Supabase Edge
-- Function "prof"). It only ever saves drafts; the tutor approves them.
-- =====================================================================

-- Wake the Prof server (needs pg_net and the server to have said hello once)
create or replace function public._prof_kick() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_secret text;
begin
  select prof_endpoint into v_url from public.app_config where id = 1;
  select hook_secret into v_secret from public.platform_secrets where id = 1;
  if v_url is null or not exists (select 1 from pg_extension where extname = 'pg_net') then return; end if;
  begin
    execute 'select net.http_post(url := $1, body := $2, headers := $3)'
      using v_url, '{"action":"kick"}'::jsonb, jsonb_build_object('Content-Type', 'application/json', 'x-prof-secret', v_secret);
  exception when others then
    raise notice 'Prof kick failed: %', sqlerrm;
  end;
end $$;

create or replace function public._prof_ready(p_tutor uuid) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public._tutor_active(p_tutor) or exists (select 1 from public.profiles p join public.platform_admins a on a.user_id = p.id
                                                    where p.id = p_tutor and p.role = 'admin')) then
    return 'Prof is for approved tutors.';
  end if;
  if not exists (select 1 from public.platform_secrets where id = 1 and anthropic_api_key is not null) then
    return 'Prof isn’t switched on yet. (The StudyBridge admin adds the Claude key in Admin.)';
  end if;
  if public._prof_month_cents(p_tutor) >= public._prof_limit(p_tutor)
     and not exists (select 1 from public.profiles where id = p_tutor and role = 'admin') then
    return 'Prof is unavailable right now. StudyBridge has been told and will sort it out.';
  end if;
  return null;
end $$;

create or replace function public.prof_ask(p_prompt text, p_context jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text;
  v_id uuid;
  p jsonb;
  v_books jsonb := '[]';
  v_reply uuid;
begin
  v_err := public._prof_ready(auth.uid());
  if v_err is not null then raise exception '%', v_err; end if;
  if length(trim(coalesce(p_prompt, ''))) < 2 then raise exception 'Tell Prof what to make.'; end if;
  -- pages Prof should read must be in this tutor's own library folder
  for p in select * from jsonb_array_elements(coalesce(p_context -> 'pages', '[]')) loop
    if (p ->> 'path') not like auth.uid()::text || '/prof/%' then raise exception 'Unknown page.'; end if;
  end loop;
  if jsonb_array_length(coalesce(p_context -> 'pages', '[]')) > 20 then raise exception 'Choose up to 20 pages.'; end if;
  -- whole books from the library: Prof reads the contents and asks for the pages it needs
  for p in select * from jsonb_array_elements(coalesce(p_context -> 'books', '[]')) loop
    if not exists (select 1 from public.files where id = (p ->> 'file_id')::uuid and tutor_id = auth.uid()) then raise exception 'Unknown book.'; end if;
    v_books := v_books || jsonb_build_array(jsonb_build_object('file_id', p ->> 'file_id', 'name', left(p ->> 'name', 200),
      'pages', (p ->> 'pages')::int, 'outline', left(coalesce(p ->> 'outline', ''), 6000)));
  end loop;
  if jsonb_array_length(v_books) > 3 then raise exception 'Choose up to 3 books.'; end if;
  -- a reply to an earlier request
  if p_context ? 'reply_to' then
    select id into v_reply from public.prof_jobs where id = (p_context ->> 'reply_to')::uuid and tutor_id = auth.uid();
  end if;
  insert into public.prof_jobs (tutor_id, kind, prompt, context)
  values (auth.uid(), 'ask', left(trim(p_prompt), 4000), jsonb_build_object(
    'learner_ids', coalesce(p_context -> 'learner_ids', '[]'), 'pages', coalesce(p_context -> 'pages', '[]'),
    'books', v_books, 'reply_to', v_reply))
  returning id into v_id;
  perform public._prof_kick();
  return jsonb_build_object('id', v_id);
end $$;

-- The learner switches weekly parent reports on or off and gives the parent's contact
create or replace function public.set_parent_reports(p_on boolean, p_name text default null, p_phone text default null, p_email text default null)
returns public.learner_reports language plpgsql security definer set search_path = public as $$
declare
  v_tutor uuid;
  v public.learner_reports;
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
begin
  select tutor_id into v_tutor from public.profiles where id = auth.uid() and role = 'learner';
  if v_tutor is null then raise exception 'Only learners choose this.'; end if;
  if p_on and v_phone is null and nullif(trim(coalesce(p_email, '')), '') is null then
    raise exception 'Add the parent’s WhatsApp number or email.';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9]{7,15}$' then raise exception 'That phone number doesn’t look right. Include the country code, e.g. +260…'; end if;
  if nullif(trim(coalesce(p_email, '')), '') is not null and trim(p_email) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email doesn’t look right.'; end if;
  insert into public.learner_reports (learner_id, tutor_id, enabled, parent_name, parent_phone, parent_email)
  values (auth.uid(), v_tutor, coalesce(p_on, false), nullif(trim(coalesce(p_name, '')), ''), v_phone, nullif(trim(coalesce(p_email, '')), ''))
  on conflict (learner_id) do update set enabled = excluded.enabled, parent_name = excluded.parent_name,
    parent_phone = excluded.parent_phone, parent_email = excluded.parent_email, tutor_id = excluded.tutor_id,
    exam_name = case when learner_reports.tutor_id = excluded.tutor_id then learner_reports.exam_name end,
    exam_date = case when learner_reports.tutor_id = excluded.tutor_id then learner_reports.exam_date end, updated_at = now()
  returning * into v;
  if p_on then
    perform public.notify_user(v_tutor, 'reports_on', (select display_name from public.profiles where id = auth.uid()) || ' switched on weekly reports',
      'Their weekly report to ' || coalesce(v.parent_name, 'their parent') || ' will be drafted for you to approve.', jsonb_build_object('learner_id', auth.uid()));
  end if;
  return v;
end $$;

-- The tutor sets the exam a learner is working towards (shown as a countdown in reports)
drop function if exists public.set_learner_exam(uuid, text, date);
create or replace function public.set_learner_exam(p_learner uuid, p_name text, p_date date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.learner_reports;
begin
  if not public.is_my_learner(p_learner) then raise exception 'Not your learner.'; end if;
  -- a row left from another tutor is reset: that tutor's parent contact never carries over
  delete from public.learner_reports where learner_id = p_learner and tutor_id <> auth.uid();
  insert into public.learner_reports (learner_id, tutor_id, exam_name, exam_date)
  values (p_learner, auth.uid(), nullif(trim(coalesce(p_name, '')), ''), p_date)
  on conflict (learner_id) do update set exam_name = excluded.exam_name, exam_date = excluded.exam_date, updated_at = now()
  returning * into v;
  return jsonb_build_object('exam_name', v.exam_name, 'exam_date', v.exam_date);
end $$;

-- Can a given learner see this assignment right now? (same rules as can_learner_see, for any learner)
create or replace function public._assignment_visible_to(a public.assignments, p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not a.draft
    and (a.visibility = 'visible' or (a.visibility = 'scheduled' and a.visible_from is not null and a.visible_from <= now()))
    and (case
           when a.learner_ids is not null and cardinality(a.learner_ids) > 0 then p_learner = any (a.learner_ids)
           when a.subject_id is not null then exists (select 1 from public.learner_subjects ls where ls.learner_id = p_learner and ls.subject_id = a.subject_id)
           else true
         end)
$$;

-- Everything a weekly report says, worked out from the learner's week with THIS tutor. Only work the
-- learner can see, and only marks they've been given back.
create or replace function public.report_numbers(p_learner uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_my_learner(p_learner) then raise exception 'Not your learner.'; end if;
  return public._report_numbers(auth.uid(), p_learner, p_from, p_to);
end $$;

create or replace function public._report_numbers(p_tutor uuid, p_learner uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tutor uuid := p_tutor;
  r public.learner_reports;
begin
  select * into r from public.learner_reports where learner_id = p_learner and tutor_id = v_tutor;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'learner', (select display_name from public.profiles where id = p_learner),
    'tutor', (select display_name from public.profiles where id = v_tutor),
    'parent', r.parent_name,
    'lessons', (select count(*) from public.sessions s where s.tutor_id = v_tutor and p_learner = any(s.learner_ids) and not s.cancelled
                 and s.starts_at >= p_from and s.starts_at < least(p_to, now())),
    'seconds', coalesce((select sum(seconds) from public.activity where learner_id = p_learner and tutor_id = v_tutor
                          and created_at >= p_from and created_at < p_to), 0),
    'work', coalesce((select jsonb_agg(w order by w ->> 'due_at') from (
        select jsonb_build_object('title', a.title, 'kind', a.kind, 'due_at', a.due_at,
          'status', case when t.submitted_at is null then case when a.due_at < now() then 'missing' else 'open' end
                         when a.due_at is not null and t.submitted_at > a.due_at then 'late' else 'on_time' end,
          'score', case when t.rel then t.score end, 'max', t.max_score) as w
        from public.assignments a
        left join lateral (select x.*, public._is_released(x) as rel from public.attempts x where x.assignment_id = a.id and x.learner_id = p_learner
                           order by x.number desc limit 1) t on true
        where a.tutor_id = v_tutor and not a.practice and public._assignment_visible_to(a, p_learner)
          and ((a.due_at >= p_from and a.due_at < p_to) or (a.due_at is null and t.submitted_at >= p_from and t.submitted_at < p_to))
      ) z), '[]'),
    'practice', jsonb_build_object(
      'tries', (select count(*) from public.attempts t join public.assignments a on a.id = t.assignment_id
                 where t.learner_id = p_learner and t.tutor_id = v_tutor and a.practice and t.submitted_at >= p_from and t.submitted_at < p_to),
      'pct', (select round(100 * avg(t.score / nullif(t.max_score, 0))) from public.attempts t join public.assignments a on a.id = t.assignment_id
               where t.learner_id = p_learner and t.tutor_id = v_tutor and a.practice and public._is_released(t)
                 and t.submitted_at >= p_from and t.submitted_at < p_to)),
    'avg_pct', (select round(100 * avg(t.score / nullif(t.max_score, 0))) from public.attempts t join public.assignments a on a.id = t.assignment_id
                 where t.learner_id = p_learner and t.tutor_id = v_tutor and not a.practice and public._is_released(t) and t.score is not null
                   and t.submitted_at >= p_from and t.submitted_at < p_to),
    'prev_avg_pct', (select round(100 * avg(t.score / nullif(t.max_score, 0))) from public.attempts t join public.assignments a on a.id = t.assignment_id
                      where t.learner_id = p_learner and t.tutor_id = v_tutor and not a.practice and public._is_released(t) and t.score is not null
                        and t.submitted_at >= p_from - interval '28 days' and t.submitted_at < p_from),
    'next', coalesce((select jsonb_agg(jsonb_build_object('title', a.title, 'kind', a.kind, 'due_at', a.due_at) order by a.due_at)
        from public.assignments a
        where a.tutor_id = v_tutor and not a.practice and public._assignment_visible_to(a, p_learner)
          and a.due_at >= p_to and a.due_at < p_to + interval '7 days'), '[]'),
    -- the latest mock grade they've been given back (1.6)
    'mock', (select z.r from (select jsonb_build_object('title', m.title) || (public._mock_result(m.id, p_learner, true) - 'papers') as r
                                from public.mocks m where m.tutor_id = v_tutor) z
              where (z.r ->> 'released')::boolean and z.r ->> 'pct' is not null order by z.r ->> 'last_at' desc limit 1),
    'exam', case when r.exam_date is not null then jsonb_build_object('name', r.exam_name, 'date', r.exam_date, 'days', r.exam_date - (p_to at time zone 'UTC')::date) end,
    'topics', public._learner_topics(p_learner, true, v_tutor)
  );
end $$;

-- Every report is kept up to date by the server (pg_cron, hourly check): each learner's report for this
-- week is refreshed once a day; when a week ends its final numbers are saved and, if the learner has
-- reports on, the tutor is told it's ready to send (and Prof writes the words if the tutor switched that on).
create or replace function public._refresh_reports() returns void
language plpgsql security definer set search_path = public as $$
declare
  l record;
  v_tz text;
  v_mon date;
  v_from timestamptz;
  v_to timestamptz;
  r public.parent_reports;
begin
  for l in select p.id as learner_id, p.tutor_id, p.display_name, t.timezone,
                  coalesce(ps.auto_reports, false) as auto,
                  coalesce(lr.enabled, false) or exists (select 1 from public.parent_links pl where pl.learner_id = p.id and pl.tutor_id = p.tutor_id) as enabled
             from public.profiles p
             join public.profiles t on t.id = p.tutor_id and t.role = 'tutor' and t.status = 'active'
             left join public.prof_settings ps on ps.tutor_id = p.tutor_id
             left join public.learner_reports lr on lr.learner_id = p.id and lr.tutor_id = p.tutor_id
            where p.role = 'learner' loop
    v_tz := coalesce((select name from pg_timezone_names where name = l.timezone), 'UTC');
    v_mon := date_trunc('week', now() at time zone v_tz)::date;
    v_from := v_mon::timestamp at time zone v_tz;
    v_to := (v_mon + 7)::timestamp at time zone v_tz;
    -- this week so far
    insert into public.parent_reports (tutor_id, learner_id, week_start, data)
    values (l.tutor_id, l.learner_id, v_mon, public._report_numbers(l.tutor_id, l.learner_id, v_from, v_to))
    on conflict (tutor_id, learner_id, week_start) do update set data = excluded.data, updated_at = now()
      where parent_reports.status = 'draft' and parent_reports.updated_at < now() - interval '20 hours';
    -- last week, once it's over
    select * into r from public.parent_reports where tutor_id = l.tutor_id and learner_id = l.learner_id and week_start = v_mon - 7;
    if r.id is null or (r.status = 'draft' and r.updated_at < v_from) then
      insert into public.parent_reports (tutor_id, learner_id, week_start, data)
      values (l.tutor_id, l.learner_id, v_mon - 7, public._report_numbers(l.tutor_id, l.learner_id, (v_mon - 7)::timestamp at time zone v_tz, v_from))
      on conflict (tutor_id, learner_id, week_start) do update set data = excluded.data, updated_at = now()
        where parent_reports.status = 'draft'
      returning * into r;
      if r.id is not null and l.enabled then
        perform public.notify_user(l.tutor_id, 'report_ready', l.display_name || '’s weekly report is ready',
          'Check it and send it to their parent.', jsonb_build_object('report_id', r.id, 'learner_id', l.learner_id));
        if l.auto and not r.prof and public._prof_ready(l.tutor_id) is null
           and not exists (select 1 from public.prof_jobs where kind = 'report' and context ->> 'report_id' = r.id::text) then
          insert into public.prof_jobs (tutor_id, kind, prompt, context)
          values (l.tutor_id, 'report', 'Write a weekly parent report', jsonb_build_object('report_id', r.id));
        end if;
      end if;
    end if;
  end loop;
end $$;

-- Ask Prof to write a report's summary, comment and next steps (the tutor approves before sending)
create or replace function public.prof_report(p_report uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text;
  v_id uuid;
begin
  if not exists (select 1 from public.parent_reports where id = p_report and tutor_id = auth.uid() and status = 'draft') then
    raise exception 'Report not found.';
  end if;
  v_err := public._prof_ready(auth.uid());
  if v_err is not null then raise exception '%', v_err; end if;
  select id into v_id from public.prof_jobs where kind = 'report' and status in ('queued', 'running') and context ->> 'report_id' = p_report::text;
  if v_id is null then
    insert into public.prof_jobs (tutor_id, kind, prompt, context)
    values (auth.uid(), 'report', 'Write a weekly parent report', jsonb_build_object('report_id', p_report))
    returning id into v_id;
  end if;
  perform public._prof_kick();
  return jsonb_build_object('id', v_id);
end $$;

-- Ask Prof to write questions for the question bank. Shared StudyBridge questions: admin only.
create or replace function public.prof_bank(p_board text, p_code text, p_topic text, p_count int default 10,
  p_difficulty int default null, p_subject uuid default null, p_shared boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text;
  v_id uuid;
begin
  v_err := public._prof_ready(auth.uid());
  if v_err is not null then raise exception '%', v_err; end if;
  if p_shared and not public.is_platform_admin() then raise exception 'Only the StudyBridge admin adds shared questions.'; end if;
  if p_subject is not null and not exists (select 1 from public.subjects where id = p_subject and tutor_id = auth.uid()) then
    raise exception 'Unknown subject.';
  end if;
  if length(trim(coalesce(p_topic, ''))) < 2 then raise exception 'Choose a topic.'; end if;
  if p_count is null or p_count < 1 or p_count > 30 then raise exception 'Ask for 1 to 30 questions.'; end if;
  if p_difficulty is not null and p_difficulty not between 1 and 3 then raise exception 'Unknown difficulty.'; end if;
  insert into public.prof_jobs (tutor_id, kind, prompt, context)
  values (auth.uid(), 'bank', format('%s questions on %s for the question bank', p_count, left(trim(p_topic), 120)),
    jsonb_build_object('board', left(p_board, 10), 'code', left(p_code, 40), 'topic', left(trim(p_topic), 200), 'count', p_count,
      'difficulty', p_difficulty, 'subject_id', p_subject, 'shared', coalesce(p_shared, false)))
  returning id into v_id;
  perform public._prof_kick();
  return jsonb_build_object('id', v_id);
end $$;

-- Counts how often bank questions are used (StudyBridge's can't be edited by tutors)
create or replace function public.bank_used(p_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bank_questions set uses = uses + 1
   where id = any(p_ids) and (owner_id = auth.uid() or (status = 'approved' and owner_id = public._sb_library()));
end $$;

-- The tutor's app sends the book pages Prof asked for
create or replace function public.prof_pages(p_job uuid, p_pages jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare p jsonb;
begin
  if not exists (select 1 from public.prof_jobs where id = p_job and tutor_id = auth.uid() and status = 'waiting') then
    raise exception 'Prof isn’t waiting for pages.';
  end if;
  if jsonb_array_length(coalesce(p_pages, '[]')) > 12 then raise exception 'Too many pages.'; end if;
  for p in select * from jsonb_array_elements(coalesce(p_pages, '[]')) loop
    if (p ->> 'path') not like auth.uid()::text || '/prof/%' then raise exception 'Unknown page.'; end if;
  end loop;
  update public.prof_jobs set result = result || jsonb_build_object('provided_pages', coalesce(p_pages, '[]')),
         status = 'queued', lease_until = null, progress = 'Reading the pages…', updated_at = now()
   where id = p_job;
  perform public._prof_kick();
end $$;

-- Ask Prof to mark one submission now
create or replace function public.prof_mark(p_attempt uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text;
  v_id uuid;
begin
  if not exists (select 1 from public.attempts where id = p_attempt and tutor_id = auth.uid() and status <> 'in_progress') then
    raise exception 'Submission not found.';
  end if;
  v_err := public._prof_ready(auth.uid());
  if v_err is not null then raise exception '%', v_err; end if;
  select id into v_id from public.prof_jobs where attempt_id = p_attempt and status in ('queued', 'running');
  if v_id is null then
    insert into public.prof_jobs (tutor_id, kind, attempt_id, prompt) values (auth.uid(), 'mark', p_attempt, 'Mark this submission')
    returning id into v_id;
  end if;
  perform public._prof_kick();
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.prof_cancel(p_job uuid)
returns void language sql security definer set search_path = public as $$
  update public.prof_jobs set status = 'cancelled', finished_at = now(), lease_until = null
   where id = p_job and tutor_id = auth.uid() and status in ('queued', 'running', 'waiting')
$$;

create or replace function public.prof_retry(p_job uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_err text;
begin
  v_err := public._prof_ready(auth.uid());
  if v_err is not null then raise exception '%', v_err; end if;
  update public.prof_jobs set status = 'queued', error = null, lease_until = null, state = '{}', steps = 0, result = '{}', progress = null
   where id = p_job and tutor_id = auth.uid() and status in ('failed', 'cancelled');
  perform public._prof_kick();
end $$;

-- Whether Prof can work right now. Tutors never see money (only the StudyBridge admin does).
create or replace function public.prof_usage() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ready', public._prof_ready(auth.uid()) is null, 'why_not', public._prof_ready(auth.uid()),
    'server_seen_at', (select prof_seen_at from public.app_config where id = 1))
$$;

-- Tell the admin when a tutor reaches 80% and 100% of this month's Prof allowance (once each)
create or replace function public._prof_alert(p_tutor uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  used numeric := public._prof_month_cents(p_tutor);
  lim int := public._prof_limit(p_tutor);
  lvl int;
  who text;
  a uuid;
begin
  if lim is null or lim <= 0 then return; end if;
  lvl := case when used >= lim then 100 when used >= lim * 0.8 then 80 else 0 end;
  if lvl = 0 then return; end if;
  -- 100% also counts as having passed 80%
  insert into public.prof_alerts (tutor_id, month, level) values (p_tutor, date_trunc('month', now())::date, lvl) on conflict do nothing;
  if not found then return; end if;
  if lvl = 100 then
    insert into public.prof_alerts (tutor_id, month, level) values (p_tutor, date_trunc('month', now())::date, 80) on conflict do nothing;
  end if;
  select display_name into who from public.profiles where id = p_tutor;
  for a in select user_id from public.platform_admins pa join public.profiles p on p.id = pa.user_id where p.role = 'admin' loop
    perform public.notify_user(a, 'prof_limit',
      case when lvl = 100 then coalesce(who, 'A tutor') || ' has run out of Prof this month' else coalesce(who, 'A tutor') || ' has used 80% of Prof this month' end,
      format('$%s of $%s. Raise their allowance in Tutors → Plan & Prof.', to_char(used / 100, 'FM999990.00'), to_char(lim::numeric / 100, 'FM999990.00')),
      jsonb_build_object('user_id', p_tutor, 'level', lvl));
  end loop;
end $$;

-- Auto-marking: when a learner hands in, Prof drafts the marks (if the tutor switched it on)
create or replace function public.on_attempt_submitted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'submitted' and old.status is distinct from 'submitted'
     and exists (select 1 from public.prof_settings where tutor_id = new.tutor_id and auto_mark)
     and public._prof_ready(new.tutor_id) is null
     and exists (select 1 from public.questions where assignment_id = new.assignment_id and type in ('short', 'steps', 'upload', 'drawing'))
     and not exists (select 1 from public.prof_jobs where attempt_id = new.id and status in ('queued', 'running')) then
    insert into public.prof_jobs (tutor_id, kind, attempt_id, prompt) values (new.tutor_id, 'mark', new.id, 'Mark this submission');
    perform public._prof_kick();
  end if;
  return new;
end $$;
drop trigger if exists attempts_prof_mark on public.attempts;
create trigger attempts_prof_mark after update of status on public.attempts
  for each row execute function public.on_attempt_submitted();

-- Every minute (pg_cron): restart stuck jobs, start weekly auto-created work, wake the server
create or replace function public.prof_tick() returns void
language plpgsql security definer set search_path = public as $$
declare
  s record;
  l record;
  v_local timestamp;
begin
  update public.prof_jobs
     set status = case when steps >= 40 then 'failed' else 'queued' end,
         error = case when steps >= 40 then 'Prof stopped: this took too many steps. Try asking for less at once.' else error end,
         lease_until = null, finished_at = case when steps >= 40 then now() end
   where status = 'running' and lease_until < now() - interval '30 seconds';
  for s in select ps.*, p.timezone from public.prof_settings ps join public.profiles p on p.id = ps.tutor_id
            where ps.auto_create and (ps.last_auto_at is null or ps.last_auto_at < now() - interval '6 days') loop
    v_local := now() at time zone coalesce((select name from pg_timezone_names where name = s.timezone), 'UTC');
    if extract(dow from v_local) = s.auto_day and extract(hour from v_local) >= s.auto_hour and public._prof_ready(s.tutor_id) is null then
      for l in select id, display_name from public.profiles where tutor_id = s.tutor_id and role = 'learner' loop
        insert into public.prof_jobs (tutor_id, kind, prompt, context) values (s.tutor_id, 'auto',
          format('Make next week’s %s for %s: about %s questions, focused on the topics they find hardest and their recent mistakes. Due in 7 days, at the end of the day in their time zone.',
                 s.auto_kind, l.display_name, s.auto_count),
          jsonb_build_object('learner_ids', jsonb_build_array(l.id)));
      end loop;
      update public.prof_settings set last_auto_at = now() where tutor_id = s.tutor_id;
    end if;
  end loop;
  -- parent reports: kept up to date about once an hour
  if coalesce((select reports_at from public.app_config where id = 1), '-infinity') < now() - interval '55 minutes' then
    update public.app_config set reports_at = now() where id = 1;
    begin
      perform public._refresh_reports();
    exception when others then
      raise warning 'parent reports refresh failed: %', sqlerrm;
    end;
  end if;
  if exists (select 1 from public.prof_jobs where status = 'queued' and (lease_until is null or lease_until < now())) then
    perform public._prof_kick();
  end if;
end $$;

-- ---------- called only by the Prof server (service role) ----------
create or replace function public.prof_hello(p_endpoint text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.app_config set prof_endpoint = coalesce(nullif(p_endpoint, ''), prof_endpoint), prof_seen_at = now() where id = 1;
  return (select jsonb_build_object('model', c.prof_model, 'key', s.anthropic_api_key, 'secret', s.hook_secret)
            from public.app_config c, public.platform_secrets s where c.id = 1 and s.id = 1);
end $$;

-- Takes the next job (or a given one) for up to ~3 minutes
create or replace function public.prof_claim(p_job uuid default null)
returns setof public.prof_jobs language sql security definer set search_path = public as $$
  update public.prof_jobs j set status = 'running', lease_until = now() + interval '170 seconds', updated_at = now()
   where j.id = (select id from public.prof_jobs
                  where status = 'queued' and (lease_until is null or lease_until < now()) and (p_job is null or id = p_job)
                  -- tutors' requests first; StudyBridge's paper sets in the background, one paper finished before the next starts
                  order by (kind = 'paper'), (state = '{}'::jsonb), created_at limit 1 for update skip locked)
  returning j.*
$$;

create or replace function public.prof_save(p_job uuid, p_status text, p_state jsonb default null, p_result jsonb default null,
  p_progress text default null, p_error text default null, p_input int default 0, p_output int default 0, p_cost numeric default 0,
  p_model text default null, p_retry_in int default null, p_notify jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare j public.prof_jobs;
begin
  update public.prof_jobs
     set status = case when status = 'cancelled' then status else p_status end,
         state = coalesce(p_state, state), result = coalesce(p_result, result),
         progress = coalesce(p_progress, progress), error = p_error,
         model = coalesce(p_model, model),
         steps = steps + case when coalesce(p_input, 0) > 0 then 1 else 0 end,
         lease_until = case when p_retry_in is not null then now() + make_interval(secs => p_retry_in)
                            when p_status = 'running' then lease_until end,
         updated_at = now(), finished_at = case when p_status in ('done', 'failed') then now() end
   where id = p_job returning * into j;
  if j.id is not null and (coalesce(p_input, 0) > 0 or coalesce(p_output, 0) > 0 or coalesce(p_cost, 0) > 0) then
    insert into public.prof_costs (job_id, tutor_id, model, input_tokens, output_tokens, cost_cents)
    values (j.id, j.tutor_id, p_model, coalesce(p_input, 0), coalesce(p_output, 0), coalesce(p_cost, 0))
    on conflict (job_id) do update set input_tokens = prof_costs.input_tokens + excluded.input_tokens,
      output_tokens = prof_costs.output_tokens + excluded.output_tokens, cost_cents = prof_costs.cost_cents + excluded.cost_cents,
      model = coalesce(excluded.model, prof_costs.model);
    perform public._prof_alert(j.tutor_id);
    perform public._prof_credit_spend(coalesce(p_cost, 0));
  end if;
  if j.status = p_status and p_notify is not null then
    perform public.notify_user(j.tutor_id, 'prof', p_notify ->> 'title', p_notify ->> 'body',
      coalesce(p_notify -> 'ref', '{}') || jsonb_build_object('job_id', j.id));
  end if;
end $$;

-- What Prof knows when making work: subjects, topics, learners (with what they find hard), the tutor's style
create or replace function public.prof_context(p_tutor uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tutor', (select jsonb_build_object('name', display_name, 'timezone', timezone) from public.profiles where id = p_tutor),
    'now', now(),
    'style', coalesce((select style_md from public.prof_settings where tutor_id = p_tutor), ''),
    'programmes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name)) from public.programmes where tutor_id = p_tutor), '[]'),
    'subjects', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'programme_id', programme_id) order by position, name)
                            from public.subjects where tutor_id = p_tutor), '[]'),
    'topics', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'subject_id', subject_id) order by position, name)
                          from public.topics where tutor_id = p_tutor), '[]'),
    'learners', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.display_name, 'timezone', l.timezone,
        'subject_ids', coalesce((select jsonb_agg(subject_id) from public.learner_subjects where learner_id = l.id), '[]'),
        'topics_needing_work', coalesce((select jsonb_agg(jsonb_build_object('topic', z.name, 'score_pct', z.pct) order by z.pct) from (
            select tp.name, round(100 * sum(r.marks) / nullif(sum(q.marks), 0)) as pct
              from public.responses r
              join public.questions q on q.id = r.question_id
              join public.attempts t on t.id = r.attempt_id
              join public.assignments a on a.id = t.assignment_id
              join public.topics tp on tp.id = coalesce(q.topic_id, a.topic_id)
             where r.learner_id = l.id and r.marks is not null and t.status in ('marked', 'returned')
             group by tp.name having sum(q.marks) > 0) z where z.pct < 80), '[]'),
        'recent_mistakes', coalesce((select jsonb_agg(m) from (
            select r.mistake as m from public.responses r where r.learner_id = l.id and coalesce(r.mistake, '') <> ''
             order by r.updated_at desc limit 10) x), '[]')
      ) order by l.display_name) from public.profiles l where l.tutor_id = p_tutor and l.role = 'learner'), '[]')
  )
$$;

-- Everything needed to mark one submission
create or replace function public.prof_mark_context(p_attempt uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'attempt_id', t.id, 'tutor_id', t.tutor_id, 'learner_id', t.learner_id, 'learner', p.display_name,
    'style', coalesce((select style_md from public.prof_settings where tutor_id = t.tutor_id), ''),
    'assignment', jsonb_build_object('id', a.id, 'title', a.title, 'kind', a.kind, 'instructions', a.instructions_md),
    'questions', coalesce((select jsonb_agg(jsonb_build_object(
        'number', q.rn, 'question_id', q.id, 'type', q.type, 'prompt', q.prompt_md, 'options', q.options, 'max_marks', q.marks,
        'answer_key', k.answer, 'mark_scheme', k.mark_scheme_md, 'model_solution', k.solution_md,
        'learner_answer', r.answer, 'auto_marks', r.auto_marks) order by q.rn)
      from (select qq.*, row_number() over (order by qq.position, qq.created_at) as rn from public.questions qq where qq.assignment_id = a.id) q
      left join public.question_keys k on k.question_id = q.id
      left join public.responses r on r.attempt_id = t.id and r.question_id = q.id), '[]'),
    'learner_notes', coalesce((select jsonb_agg(jsonb_build_object('question_id', c.question_id, 'note', c.body))
      from public.comments c where c.learner_id = t.learner_id and c.assignment_id = a.id and c.author_id = t.learner_id), '[]')
  )
  from public.attempts t join public.assignments a on a.id = t.assignment_id join public.profiles p on p.id = t.learner_id
  where t.id = p_attempt
$$;

-- Files left behind by deleted accounts (the Prof server removes them)
create or replace function public.prof_orphan_files() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  execute $q$select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'name', name)), '[]') from (
      select bucket_id, name from storage.objects
       where bucket_id in ('library', 'work')
         and not exists (select 1 from public.profiles p where p.id::text = (storage.foldername(name))[1])
       limit 500) x$q$ into r;
  return r;
end $$;

-- Prof can only save drafts. Even with the server's key it can't post work, change marks or message anyone.
create or replace function public._prof_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user = 'service_role' then
    if tg_table_name in ('assignments', 'lessons') then
      if not coalesce(new.draft, false) then raise exception 'Prof can only save drafts; the tutor approves them.'; end if;
    elsif tg_table_name = 'questions' then
      if not exists (select 1 from public.assignments where id = new.assignment_id and draft) then
        raise exception 'Prof can only add questions to drafts.';
      end if;
    elsif tg_table_name = 'book_notes' then
      if not exists (select 1 from public.files where id = new.file_id and tutor_id = new.tutor_id) then raise exception 'Not that tutor’s book.'; end if;
    elsif tg_table_name = 'parent_reports' then
      if tg_op <> 'UPDATE' or old.status <> 'draft' or new.status <> 'draft' then raise exception 'Prof only writes report drafts.'; end if;
    elsif tg_table_name = 'bank_questions' then
      if new.status <> 'review' then raise exception 'Prof’s bank questions wait for approval.'; end if;
    elsif tg_table_name = 'question_keys' then
      if not exists (select 1 from public.questions q join public.assignments a on a.id = q.assignment_id where q.id = new.question_id and a.draft) then
        raise exception 'Prof can only add answers to drafts.';
      end if;
    else
      raise exception 'Prof can’t change marks or send messages; it saves suggestions for the tutor.';
    end if;
  end if;
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['assignments', 'lessons', 'questions', 'question_keys', 'bank_questions', 'parent_reports', 'book_notes'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_prof_guard', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public._prof_guard()', t || '_prof_guard', t);
  end loop;
  foreach t in array array['attempts', 'responses', 'comments', 'notifications', 'invites', 'profiles'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_prof_guard', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public._prof_guard()', t || '_prof_guard', t);
  end loop;
end $$;

-- =====================================================================
-- 1.4: syllabus (topics with their syllabus number and subtopics) and the coverage map
-- =====================================================================
alter table public.topics add column if not exists code text;
alter table public.topics add column if not exists details text[] not null default '{}';

-- Topics the tutor marks as taught for a learner (e.g. in a live lesson)
create table if not exists public.taught_topics (
  learner_id uuid not null references public.profiles (id) on delete cascade,
  topic_id uuid not null references public.topics (id) on delete cascade,
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  taught_on date not null default current_date,
  primary key (learner_id, topic_id)
);
alter table public.taught_topics enable row level security;
drop policy if exists taught_tutor on public.taught_topics;
create policy taught_tutor on public.taught_topics for all
  using (tutor_id = auth.uid() and public.is_my_learner(learner_id))
  with check (tutor_id = auth.uid() and public.is_my_learner(learner_id)
              and exists (select 1 from public.topics t where t.id = topic_id and t.tutor_id = auth.uid()));
drop policy if exists taught_learner on public.taught_topics;
create policy taught_learner on public.taught_topics for select using (learner_id = auth.uid());
-- The tutor's own call on a topic for a learner: taught, not yet (even if a lesson covered it), or how
-- well they know it (overrides what their marked answers say)
alter table public.taught_topics add column if not exists state text not null default 'taught';
do $$ begin
  alter table public.taught_topics add constraint taught_topics_state_check check (state in ('taught', 'not_yet', 'weak', 'developing', 'strong'));
exception when duplicate_object then null; end $$;

-- Ask Prof to set out a subject's syllabus as topics. The tutor checks it and chooses to use it.
drop function if exists public.prof_syllabus(uuid, text, text);
create or replace function public.prof_syllabus(p_subject uuid, p_label text, p_note text default null, p_source jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text;
  v_id uuid;
  s public.subjects;
  p jsonb;
begin
  v_err := public._prof_ready(auth.uid());
  if v_err is not null then raise exception '%', v_err; end if;
  select * into s from public.subjects where id = p_subject and tutor_id = auth.uid();
  if s.id is null then raise exception 'Unknown subject.'; end if;
  if length(trim(coalesce(p_label, ''))) < 3 and p_source is null then raise exception 'Say which exam or syllabus this subject follows.'; end if;
  -- the syllabus document: its text, or pictures of its pages, in the tutor's own folder
  if p_source is not null then
    if coalesce(p_source ->> 'text_path', auth.uid()::text || '/prof/') not like auth.uid()::text || '/prof/%' then raise exception 'Unknown file.'; end if;
    for p in select * from jsonb_array_elements(coalesce(p_source -> 'pages', '[]')) loop
      if coalesce(p ->> 'path', '') not like auth.uid()::text || '/prof/%' then raise exception 'Unknown page.'; end if;
    end loop;
    if jsonb_array_length(coalesce(p_source -> 'pages', '[]')) > 16 then raise exception 'Up to 16 pages at a time.'; end if;
  end if;
  insert into public.prof_jobs (tutor_id, kind, prompt, context)
  values (auth.uid(), 'syllabus',
    case when p_source is not null then format('Set out the syllabus from %s', left(coalesce(nullif(trim(p_source ->> 'name'), ''), 'the syllabus document'), 150))
         else format('Set out the syllabus for %s', left(trim(p_label), 150)) end,
    jsonb_build_object('subject_id', s.id, 'subject', s.name, 'exam', s.exam, 'label', left(trim(coalesce(p_label, '')), 200),
                       'note', left(coalesce(p_note, ''), 1000), 'source', p_source))
  returning id into v_id;
  perform public._prof_kick();
  return jsonb_build_object('id', v_id);
end $$;

-- What each learner has covered in a subject: taught (lessons, work they were given, or marked
-- by the tutor) and how they did, per topic
create or replace function public.coverage(p_subject uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.subjects;
begin
  select * into s from public.subjects where id = p_subject;
  if s.id is null or s.tutor_id is distinct from auth.uid() then raise exception 'Unknown subject.'; end if;
  return jsonb_build_object(
    'topics', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', code, 'details', details) order by position, name)
                          from public.topics where subject_id = p_subject), '[]'),
    'learners', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.display_name,
        'scores', coalesce((select jsonb_object_agg(x ->> 'topic_id', jsonb_build_object('answered', x -> 'answered', 'ratio', x -> 'ratio', 'strength', x -> 'strength'))
                              from jsonb_array_elements(public._learner_topics(p.id, false, auth.uid())) x
                             where x ->> 'subject_id' = p_subject::text), '{}'),
        'marked', coalesce((select jsonb_agg(topic_id) from public.taught_topics tt where tt.learner_id = p.id and tt.state <> 'not_yet'
                              and tt.topic_id in (select id from public.topics where subject_id = p_subject)), '[]'),
        'set', coalesce((select jsonb_object_agg(topic_id, state) from public.taught_topics tt where tt.learner_id = p.id
                              and tt.topic_id in (select id from public.topics where subject_id = p_subject)), '{}'),
        'taught', coalesce((select jsonb_agg(distinct tid) from (
            select l.topic_id tid from public.lessons l
             where l.subject_id = p_subject and l.topic_id is not null and l.visibility <> 'hidden'
               and (l.learner_ids is null or cardinality(l.learner_ids) = 0 or p.id = any (l.learner_ids))
            union
            select a.topic_id from public.assignments a
             where a.subject_id = p_subject and a.topic_id is not null and not a.draft and a.source <> 'self' and public._assignment_visible_to(a, p.id)
            union
            select q.topic_id from public.questions q join public.assignments a on a.id = q.assignment_id
             where a.subject_id = p_subject and q.topic_id is not null and not a.draft and a.source <> 'self' and public._assignment_visible_to(a, p.id)
          ) z where tid is not null), '[]')
      ) order by p.display_name)
      from public.profiles p join public.learner_subjects ls on ls.learner_id = p.id and ls.subject_id = p_subject
      where p.role = 'learner' and p.tutor_id = auth.uid()), '[]'));
end $$;

-- =====================================================================
-- 1.4: self-study for learners. Everything they study is made or approved by their tutor
-- (learners never use AI): flashcards (spaced repetition), mistake cards, practice from the
-- tutor-approved question bank (daily quiz, a topic, worked example then "you try", timed drills),
-- formula sheets, a revision plan and a daily goal with a streak.
-- =====================================================================
alter table public.profiles add column if not exists study_goal_min int not null default 10;
-- Self-marking: the learner marks their own hand-in against the mark scheme first; the tutor then checks it
alter table public.responses add column if not exists self_marks numeric;
-- Self-marked work has one attempt (the answers show after it)
create or replace function public._self_mark_one_try() returns trigger language plpgsql as $$
begin
  if new.self_mark then new.max_attempts := 1; end if;
  return new;
end $$;
drop trigger if exists assignments_self_mark on public.assignments;
create trigger assignments_self_mark before insert or update of self_mark, max_attempts on public.assignments
  for each row execute function public._self_mark_one_try();
update public.assignments set max_attempts = 1 where self_mark and max_attempts <> 1;
alter table public.attempts add column if not exists self_marked_at timestamptz;
do $$ begin
  alter table public.activity drop constraint if exists activity_kind_check;
  alter table public.activity add constraint activity_kind_check check (kind in ('assignment', 'lesson', 'file', 'session', 'study'));
end $$;

-- ---------------- flashcards ----------------
create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  learner_id uuid references public.profiles (id) on delete cascade,        -- null = everyone taking the subject
  subject_id uuid references public.subjects (id) on delete cascade,
  topic_id uuid references public.topics (id) on delete set null,
  front_md text not null check (length(front_md) between 1 and 4000),
  back_md text not null default '' check (length(back_md) <= 8000),
  source text not null default 'tutor' check (source in ('tutor', 'prof', 'mistake', 'own')),
  question_id uuid references public.questions (id) on delete cascade,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_cards_tutor on public.cards (tutor_id, subject_id);
create unique index if not exists cards_one_mistake on public.cards (learner_id, question_id) where source = 'mistake';
alter table public.cards enable row level security;
drop policy if exists cards_tutor on public.cards;
create policy cards_tutor on public.cards for all
  using (tutor_id = auth.uid())
  with check (tutor_id = auth.uid() and source in ('tutor', 'prof')
              and (learner_id is null or public.is_my_learner(learner_id))
              and (subject_id is null or exists (select 1 from public.subjects s where s.id = subject_id and s.tutor_id = auth.uid())));
drop policy if exists cards_learner_read on public.cards;
create policy cards_learner_read on public.cards for select using (
  tutor_id = public.my_tutor() and public.my_role() = 'learner'
  and (learner_id = auth.uid()
       or (learner_id is null and (subject_id is null or exists (select 1 from public.learner_subjects ls where ls.learner_id = auth.uid() and ls.subject_id = cards.subject_id)))));
-- learners can make their own cards (no AI): only for themselves
drop policy if exists cards_learner_own on public.cards;
create policy cards_learner_own on public.cards for insert with check (
  source = 'own' and learner_id = auth.uid() and created_by = auth.uid() and tutor_id = public.my_tutor() and public.my_role() = 'learner'
  and (subject_id is null or exists (select 1 from public.learner_subjects ls where ls.learner_id = auth.uid() and ls.subject_id = cards.subject_id)));
drop policy if exists cards_learner_edit on public.cards;
create policy cards_learner_edit on public.cards for update using (source = 'own' and learner_id = auth.uid())
  with check (source = 'own' and learner_id = auth.uid() and created_by = auth.uid());
drop policy if exists cards_learner_delete on public.cards;
create policy cards_learner_delete on public.cards for delete using (source in ('own', 'mistake') and learner_id = auth.uid());

create table if not exists public.card_reviews (
  learner_id uuid not null references public.profiles (id) on delete cascade,
  card_id uuid not null references public.cards (id) on delete cascade,
  due_at timestamptz not null default now(),
  interval_days numeric not null default 0,
  ease numeric not null default 2.5,
  reps int not null default 0,
  lapses int not null default 0,
  last_grade int,
  last_at timestamptz,
  primary key (learner_id, card_id)
);
alter table public.card_reviews enable row level security;
revoke insert, update, delete on public.card_reviews from anon, authenticated;
drop policy if exists card_reviews_read on public.card_reviews;
create policy card_reviews_read on public.card_reviews for select using (learner_id = auth.uid() or public.is_my_learner(learner_id));

-- One review: 0 = again, 1 = hard, 2 = good, 3 = easy (spaced repetition, SM-2 style)
create or replace function public.review_card(p_card uuid, p_grade int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.card_reviews;
  g int := greatest(0, least(3, coalesce(p_grade, 2)));
  v_ease numeric;
  v_int numeric;
begin
  if not exists (select 1 from public.cards c where c.id = p_card
                  and c.tutor_id = public.my_tutor() and public.my_role() = 'learner'
                  and (c.learner_id = auth.uid() or (c.learner_id is null and (c.subject_id is null or exists (
                        select 1 from public.learner_subjects ls where ls.learner_id = auth.uid() and ls.subject_id = c.subject_id))))) then
    raise exception 'Card not found.';
  end if;
  select * into r from public.card_reviews where learner_id = auth.uid() and card_id = p_card;
  v_ease := coalesce(r.ease, 2.5);
  if g = 0 then
    v_ease := greatest(1.3, v_ease - 0.2);
    v_int := 0;  -- again today (in 10 minutes)
  else
    v_ease := greatest(1.3, v_ease + case g when 1 then -0.15 when 2 then 0 else 0.15 end);
    v_int := case
      when coalesce(r.reps, 0) = 0 then case g when 1 then 1 when 2 then 1 else 3 end
      when coalesce(r.reps, 0) = 1 then case g when 1 then 2 when 2 then 3 else 6 end
      else round(greatest(1, r.interval_days) * case g when 1 then 1.2 when 2 then v_ease else v_ease * 1.3 end, 1) end;
  end if;
  insert into public.card_reviews as cr (learner_id, card_id, due_at, interval_days, ease, reps, lapses, last_grade, last_at)
  values (auth.uid(), p_card, case when v_int = 0 then now() + interval '10 minutes' else now() + make_interval(days => ceil(v_int)::int) end,
          v_int, v_ease, case when g = 0 then 0 else 1 end, case when g = 0 then 1 else 0 end, g, now())
  on conflict (learner_id, card_id) do update set
    due_at = excluded.due_at, interval_days = excluded.interval_days, ease = excluded.ease,
    reps = case when g = 0 then 0 else cr.reps + 1 end, lapses = cr.lapses + case when g = 0 then 1 else 0 end,
    last_grade = g, last_at = now()
  returning * into r;
  return to_jsonb(r);
end $$;

-- Mistake cards: every question a learner lost marks on (once it's marked and released) becomes a card.
-- The back shows the worked solution only if the tutor lets them see answers for that work.
create or replace function public.sync_mistake_cards()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if public.my_role() is distinct from 'learner' then return 0; end if;
  insert into public.cards (tutor_id, learner_id, subject_id, topic_id, front_md, back_md, source, question_id, created_by)
  select distinct on (q.id) a.tutor_id, auth.uid(), a.subject_id, coalesce(q.topic_id, a.topic_id),
         left(coalesce(nullif(q.prompt_md, ''), '(question)'), 4000),
         left(case when a.show_answers then
                trim(both E'\n' from concat_ws(E'\n\n',
                  case when q.type = 'mcq' then 'Answer: ' || (select string_agg(chr(65 + c::int) || ': ' || coalesce(
                      case when jsonb_typeof(q.options) = 'array' then q.options ->> c::int else q.options -> 'items' ->> c::int end, '?'), ', ')
                    from jsonb_array_elements_text(coalesce(k.answer -> 'choices', case when k.answer ? 'choice' then jsonb_build_array(k.answer -> 'choice') end)) c) end,
                  case when k.answer ? 'value' then 'Answer: ' || (k.answer ->> 'value') || coalesce(' ' || (k.answer ->> 'unit'), '') end,
                  case when k.answer ? 'final' then 'Answer: $' || (k.answer ->> 'final') || '$' end,
                  case when k.answer ? 'text' then 'Answer: ' || (k.answer ->> 'text') end,
                  nullif(k.solution_md, ''), case when nullif(r.feedback_md, '') is not null then 'Your tutor said: ' || r.feedback_md end))
              else coalesce('Your tutor said: ' || nullif(r.feedback_md, ''), 'Look back at this question in your marked work, or ask your tutor.') end, 8000),
         'mistake', q.id, auth.uid()
    from public.responses r
    join public.attempts t on t.id = r.attempt_id
    join public.questions q on q.id = r.question_id
    join public.assignments a on a.id = t.assignment_id
    left join public.question_keys k on k.question_id = q.id
   where r.learner_id = auth.uid() and r.marks is not null and r.marks < q.marks and q.marks > 0
     and t.status in ('marked', 'returned') and public._is_released(t)
     and q.image_path is null
     and not exists (select 1 from public.cards c where c.learner_id = auth.uid() and c.question_id = q.id and c.source = 'mistake')
   order by q.id, t.submitted_at desc
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Ask Prof for flashcards on a topic. They come back for the tutor to pick from; nothing reaches learners until then.
create or replace function public.prof_cards(p_subject uuid, p_topic text, p_count int default 12, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text;
  v_id uuid;
  s public.subjects;
begin
  v_err := public._prof_ready(auth.uid());
  if v_err is not null then raise exception '%', v_err; end if;
  select * into s from public.subjects where id = p_subject and tutor_id = auth.uid();
  if s.id is null then raise exception 'Unknown subject.'; end if;
  if length(trim(coalesce(p_topic, ''))) < 2 then raise exception 'Choose a topic.'; end if;
  if p_count is null or p_count < 1 or p_count > 40 then raise exception 'Ask for 1 to 40 cards.'; end if;
  insert into public.prof_jobs (tutor_id, kind, prompt, context)
  values (auth.uid(), 'cards', format('%s flashcards on %s', p_count, left(trim(p_topic), 120)),
    jsonb_build_object('subject_id', s.id, 'subject', s.name, 'exam', s.exam, 'topic', left(trim(p_topic), 200), 'count', p_count, 'note', left(coalesce(p_note, ''), 500)))
  returning id into v_id;
  perform public._prof_kick();
  return jsonb_build_object('id', v_id);
end $$;

-- ---------------- practice the learner starts themselves ----------------
-- Built from the tutor's approved question bank (their own questions + StudyBridge's checked ones for the
-- exams their subjects are for), auto-marked questions only, any number of tries, answers shown straight away.
create or replace function public.start_practice(p_mode text, p_subject uuid default null, p_topic text default null,
  p_count int default 5, p_minutes int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me public.profiles;
  v_subjects uuid[];
  v_codes text[];
  v_weak text[];
  v_today date;
  v_id uuid;
  v_ex public.bank_questions;
  v_title text;
  v_instr text := '';
  v_subject uuid := p_subject;
  n int := greatest(1, least(coalesce(p_count, 5), 20));
  b public.bank_questions;
  qid uuid;
  i int := 0;
  v_sb uuid;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.role is distinct from 'learner' then raise exception 'For learners.'; end if;
  if not public._tutor_active(me.tutor_id) then raise exception 'Practice isn’t available right now.'; end if;
  -- StudyBridge's library never goes into a tutor's learners' practice by itself: with a tutor, a person approves
  -- everything a learner gets (the tutor uses StudyBridge questions by putting them in work they post). Students on
  -- their own already have it: it's their "tutor's". (A tutor choosing to switch it on for practice can come later.)
  v_sb := null;
  if p_mode not in ('daily', 'topic', 'learn', 'drill', 'check') then raise exception 'Unknown practice.'; end if;
  v_today := (now() at time zone coalesce((select name from pg_timezone_names where name = me.timezone), 'UTC'))::date;
  -- one daily quiz a day
  if p_mode = 'daily' then
    select id into v_id from public.assignments
     where tutor_id = me.tutor_id and source = 'self' and learner_ids = array[me.id] and title = 'Daily quiz · ' || to_char(v_today, 'DD Mon')
     order by created_at desc limit 1;
    if v_id is not null then return jsonb_build_object('assignment_id', v_id, 'existing', true); end if;
    n := 5;
  end if;
  -- the starting check (students on their own): one per subject at a time; an unfinished one carries on
  if p_mode = 'check' then
    if v_subject is null then raise exception 'Choose a subject.'; end if;
    select a.id into v_id from public.assignments a
     where a.starting_check and a.learner_ids = array[me.id] and a.subject_id = v_subject
       and not exists (select 1 from public.attempts t where t.assignment_id = a.id and t.submitted_at is not null)
     order by a.created_at desc limit 1;
    if v_id is not null then return jsonb_build_object('assignment_id', v_id, 'existing', true); end if;
    n := 12;
  end if;
  select array_agg(ls.subject_id) into v_subjects from public.learner_subjects ls where ls.learner_id = me.id;
  if v_subject is not null and not (v_subject = any (coalesce(v_subjects, '{}'))) then raise exception 'Unknown subject.'; end if;
  select array_agg(split_part(s.exam, ':', 2)) into v_codes from public.subjects s
   where s.id = any (coalesce(case when v_subject is not null then array[v_subject] else v_subjects end, '{}')) and s.exam is not null;
  -- topics this learner finds hard come first in the daily quiz
  select array_agg(lower(x ->> 'topic')) into v_weak from jsonb_array_elements(public._learner_topics(me.id, true, null)) x
   where x ->> 'strength' in ('weak', 'developing');

  -- worked example first: one with a written solution
  if p_mode = 'learn' then
    select bq.* into v_ex from public.bank_questions bq
     where bq.status = 'approved' and (bq.owner_id = me.tutor_id or (bq.owner_id = v_sb and bq.exam_code = any (coalesce(v_codes, '{}'))))
       and bq.type in ('mcq', 'numeric') and bq.image_path is null
       and ((v_subject is null and (bq.subject_id = any (coalesce(v_subjects, '{}')) or bq.exam_code = any (coalesce(v_codes, '{}'))))
            or (v_subject is not null and (bq.subject_id = v_subject or bq.exam_code = any (coalesce(v_codes, '{}')))))
       and (p_topic is null or lower(bq.topic) = lower(trim(p_topic)))
       and nullif(bq.solution_md, '') is not null
     order by random() limit 1;
    if v_ex.id is null then raise exception 'There’s no worked example for this topic yet. Try “Practise a topic” instead.'; end if;
    v_instr := E'**Worked example**\n\n' || v_ex.prompt_md || E'\n\n**Solution**\n\n' || v_ex.solution_md || E'\n\n---\n\n**Now you try** the questions below. Same idea, different numbers.';
  end if;
  create temporary table if not exists _picked (bid uuid, ord int) on commit drop;
  delete from _picked;
  -- the starting check: a question from as many different topics as there are, then more to make 12
  if p_mode = 'check' then
    insert into _picked
    select z.id, row_number() over (order by z.first desc, z.r) from (
      select bq.id, row_number() over (partition by lower(coalesce(bq.topic, '')) order by random()) = 1 as first, random() as r
        from public.bank_questions bq
       where bq.status = 'approved' and (bq.owner_id = me.tutor_id or (bq.owner_id = v_sb and bq.exam_code = any (coalesce(v_codes, '{}'))))
         and bq.type in ('mcq', 'numeric') and bq.image_path is null
         and (bq.subject_id = v_subject or bq.exam_code = any (coalesce(v_codes, '{}')))) z
     order by z.first desc, z.r limit n;
  end if;
  insert into _picked
  select bq.id, row_number() over () from (
    select bq.id from public.bank_questions bq
     where bq.status = 'approved' and (bq.owner_id = me.tutor_id or (bq.owner_id = v_sb and bq.exam_code = any (coalesce(v_codes, '{}'))))
       and bq.type in ('mcq', 'numeric') and bq.image_path is null
       and ((v_subject is null and (bq.subject_id = any (coalesce(v_subjects, '{}')) or bq.exam_code = any (coalesce(v_codes, '{}'))))
            or (v_subject is not null and (bq.subject_id = v_subject or bq.exam_code = any (coalesce(v_codes, '{}')))))
       and (p_topic is null or lower(bq.topic) = lower(trim(p_topic)))
       and bq.id is distinct from v_ex.id
       and p_mode <> 'check'
     order by case when p_mode = 'daily' and lower(bq.topic) = any (coalesce(v_weak, '{}')) then 0 else 1 end, random()
     limit n) bq;
  if not exists (select 1 from _picked) then
    raise exception '%', case when p_mode = 'learn' then 'There aren’t enough questions on this topic yet for “you try”.'
                              when me.self_learner then 'There aren’t practice questions for this yet. StudyBridge is adding them topic by topic.'
                              else 'There aren’t any practice questions for this yet. Ask your tutor to add some to the question bank.' end;
  end if;
  if v_subject is null then
    -- (a StudyBridge question's own subject is the content account's: the learner's is found by its exam)
    select coalesce(case when bq.owner_id = me.tutor_id then bq.subject_id end,
                    (select s.id from public.subjects s where s.id = any (coalesce(v_subjects, '{}')) and split_part(s.exam, ':', 2) = bq.exam_code limit 1))
      into v_subject from public.bank_questions bq join _picked p on p.bid = bq.id order by p.ord limit 1;
  end if;
  v_title := case p_mode
    when 'daily' then 'Daily quiz · ' || to_char(v_today, 'DD Mon')
    when 'learn' then 'Worked example: ' || coalesce(nullif(trim(p_topic), ''), 'mixed')
    when 'drill' then 'Timed drill' || coalesce(': ' || nullif(trim(p_topic), ''), '') || coalesce(' · ' || p_minutes || ' min', '')
    when 'check' then 'Starting check: ' || coalesce((select name from public.subjects where id = v_subject), 'my subject')
    else 'Practice: ' || coalesce(nullif(trim(p_topic), ''), 'mixed') end;
  if p_mode = 'check' then
    v_instr := 'A quick check of what you already know, a question or two from each topic. There’s no time limit and nothing to revise first: just do what you can. Your plan then starts with the topics you need most.';
  end if;
  insert into public.assignments (tutor_id, title, kind, practice, subject_id, learner_ids, visibility, draft, max_attempts,
     release_mode, show_answers, time_limit_min, lockdown, camera, allow_notes, source, instructions_md, starting_check)
  values (me.tutor_id, left(v_title, 200), 'quiz', true, v_subject, array[me.id], 'visible', false, case when p_mode = 'check' then 1 else 50 end,
     'on_submit', true, case when p_mode = 'drill' then greatest(1, least(coalesce(p_minutes, 10), 180)) end, false, false, true, 'self', v_instr,
     p_mode = 'check')
  returning id into v_id;
  for b in select bq.* from public.bank_questions bq join _picked p on p.bid = bq.id order by p.ord loop
    insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, options, marks, topic_id, hint_md, bank_id)
    values (v_id, me.tutor_id, i, b.type, b.prompt_md, b.options, b.marks,
            (select t.id from public.topics t where t.tutor_id = me.tutor_id and lower(t.name) = lower(b.topic)
               and (t.subject_id = v_subject or v_subject is null) limit 1), b.hint_md, b.id)
    returning id into qid;
    insert into public.question_keys (question_id, tutor_id, answer, mark_scheme_md, solution_md)
    values (qid, me.tutor_id, b.answer, b.mark_scheme_md, b.solution_md);
    i := i + 1;
  end loop;
  update public.bank_questions set uses = uses + 1 where id in (select bid from _picked) or id = v_ex.id;
  return jsonb_build_object('assignment_id', v_id, 'questions', i);
end $$;

-- Topics a learner can practise (from the bank their tutor approved), per subject. StudyBridge's questions reach a
-- tutor's learners only through work the tutor posts (see start_practice)
create or replace function public.practice_topics()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_sb uuid := null;
begin
  return (
  select coalesce(jsonb_agg(jsonb_build_object('subject_id', z.subject_id, 'topic', z.topic, 'questions', z.n, 'examples', z.ex) order by z.topic), '[]')
  from (
    select s.id subject_id, bq.topic, count(*) n, count(*) filter (where nullif(bq.solution_md, '') is not null) ex
      from public.learner_subjects ls
      join public.subjects s on s.id = ls.subject_id
      join public.bank_questions bq on (bq.subject_id = s.id or (s.exam is not null and bq.exam_code = split_part(s.exam, ':', 2)))
     where ls.learner_id = auth.uid() and bq.status = 'approved'
       and (bq.owner_id = public.my_tutor() or (bq.owner_id = v_sb and s.exam is not null and bq.exam_code = split_part(s.exam, ':', 2)))
       and bq.type in ('mcq', 'numeric') and bq.image_path is null and bq.topic is not null and public.my_role() = 'learner'
     group by s.id, bq.topic) z);
end $$;

-- The learner's own marks for a self-marked hand-in (before the tutor checks it)
create or replace function public.save_self_marks(p_attempt uuid, p_marks jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  t public.attempts;
  a public.assignments;
  k text;
  v text;
  who text;
begin
  select * into t from public.attempts where id = p_attempt and learner_id = auth.uid();
  if t.id is null then raise exception 'Attempt not found.'; end if;
  select * into a from public.assignments where id = t.assignment_id;
  if not a.self_mark then raise exception 'This work isn’t self-marked.'; end if;
  if t.status <> 'submitted' then raise exception 'Hand it in first; once your tutor has marked it, it can’t change.'; end if;
  if not public._self_mark_open(t, a) then raise exception 'You can mark it once you’ve used all your attempts.'; end if;
  for k, v in select * from jsonb_each_text(coalesce(p_marks, '{}')) loop
    update public.responses r set self_marks = greatest(0, least(q.marks, nullif(v, '')::numeric))
      from public.questions q where q.id = r.question_id and r.attempt_id = t.id and r.question_id::text = k;
  end loop;
  update public.attempts set self_marked_at = now() where id = t.id;
  select display_name into who from public.profiles where id = auth.uid();
  perform public.notify_user(t.tutor_id, 'self_marked', coalesce(who, 'Your learner') || ' marked their own work: ' || a.title,
    'Check their marks and confirm them.', jsonb_build_object('attempt_id', t.id));
end $$;

-- ---------------- formula sheets (the learner's own notes per subject) ----------------
create table if not exists public.study_notes (
  learner_id uuid not null references public.profiles (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  body_md text not null default '' check (length(body_md) <= 30000),
  updated_at timestamptz not null default now(),
  primary key (learner_id, subject_id)
);
alter table public.study_notes enable row level security;
drop policy if exists study_notes_own on public.study_notes;
create policy study_notes_own on public.study_notes for all
  using (learner_id = auth.uid())
  with check (learner_id = auth.uid() and exists (select 1 from public.learner_subjects ls where ls.learner_id = auth.uid() and ls.subject_id = study_notes.subject_id));
drop policy if exists study_notes_tutor on public.study_notes;
create policy study_notes_tutor on public.study_notes for select using (public.is_my_learner(learner_id));

-- ---------------- daily goal, streak, what to revise ----------------
create or replace function public.set_study_goal(p_minutes int)
returns void language sql security definer set search_path = public as $$
  update public.profiles set study_goal_min = greatest(5, least(coalesce(p_minutes, 10), 180)) where id = auth.uid() and role = 'learner'
$$;

-- p_learner: the learner themselves, or (for their tutor) one of their learners
create or replace function public.study_summary(p_learner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_l uuid := coalesce(p_learner, auth.uid());
  p public.profiles;
  v_today date;
  d date;
  streak int := 0;
  goal int;
begin
  if auth.uid() is null or v_l is null or not (v_l = auth.uid() or coalesce(public._can_view_learner(v_l), false)) then raise exception 'Not your learner.'; end if;
  select * into p from public.profiles where id = v_l;
  goal := coalesce(p.study_goal_min, 10) * 60;
  v_today := (now() at time zone coalesce((select name from pg_timezone_names where name = p.timezone), 'UTC'))::date;
  -- streak: days in a row with some study (today counts once started; not having started yet today doesn't break it)
  d := v_today;
  if coalesce((select sum(seconds) from public.activity where learner_id = v_l and day = d), 0) = 0 then d := d - 1; end if;
  while coalesce((select sum(seconds) from public.activity where learner_id = v_l and day = d), 0) > 0 loop
    streak := streak + 1;
    d := d - 1;
    exit when streak > 999;
  end loop;
  return jsonb_build_object(
    'goal_min', coalesce(p.study_goal_min, 10),
    'today_sec', coalesce((select sum(seconds) from public.activity where learner_id = v_l and day = v_today), 0),
    'streak', streak,
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', g::date, 'sec', coalesce((select sum(seconds) from public.activity a where a.learner_id = v_l and a.day = g::date), 0)) order by g)
                        from generate_series(v_today - 13, v_today, interval '1 day') g), '[]'),
    'cards_due', (select count(*) from public.cards c
                   where c.tutor_id = p.tutor_id and (c.learner_id = v_l or (c.learner_id is null and (c.subject_id is null or exists (
                          select 1 from public.learner_subjects ls where ls.learner_id = v_l and ls.subject_id = c.subject_id))))
                     and not exists (select 1 from public.card_reviews r where r.learner_id = v_l and r.card_id = c.id and r.due_at > now())),
    'cards_learned', (select count(*) from public.card_reviews r where r.learner_id = v_l and r.interval_days >= 7),
    'mistakes', (select count(*) from public.cards c where c.learner_id = v_l and c.source = 'mistake'),
    'exam', (select jsonb_build_object('name', exam_name, 'date', exam_date) from public.learner_reports where learner_id = v_l and exam_date is not null));
end $$;

-- The learner's own topics with how they're doing (for the revision plan)
create or replace function public.my_topics()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'code', t.code, 'subject_id', t.subject_id,
      'strength', coalesce(case when tt.state in ('weak', 'developing', 'strong') then tt.state end, x.strength, 'none'), 'ratio', x.ratio,
      'taught', coalesce(tt.state <> 'not_yet', false)
             or (tt.state is null and (
                 exists (select 1 from public.lessons l where l.topic_id = t.id and l.visibility = 'visible'
                          and (l.learner_ids is null or cardinality(l.learner_ids) = 0 or auth.uid() = any (l.learner_ids)))
              or exists (select 1 from public.assignments a where a.topic_id = t.id and not a.draft and a.source <> 'self' and public._assignment_visible_to(a, auth.uid())))))
    order by t.subject_id, t.position, t.name), '[]')
  from public.topics t
  join public.learner_subjects ls on ls.subject_id = t.subject_id and ls.learner_id = auth.uid()
  left join public.taught_topics tt on tt.learner_id = auth.uid() and tt.topic_id = t.id
  left join lateral (select y ->> 'strength' strength, (y ->> 'ratio')::numeric ratio
                       from jsonb_array_elements(public._learner_topics(auth.uid(), true, null)) y where y ->> 'topic_id' = t.id::text limit 1) x on true
  where public.my_role() = 'learner'
$$;

-- =====================================================================
-- 1.4: calendar link. Each person gets a private link their calendar app (Google, Apple,
-- Outlook) subscribes to: live lessons and due dates, kept up to date. Served by the Prof server.
-- =====================================================================
-- The links live in their own table that nobody can read directly (a link is as good as a
-- password for someone's timetable). Earlier 1.4 builds kept them on profiles; move them over.
create table if not exists public.calendar_tokens (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);
alter table public.calendar_tokens enable row level security;
revoke all on public.calendar_tokens from public, anon, authenticated;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'calendar_token') then
    execute 'insert into public.calendar_tokens (user_id, token) select id, calendar_token from public.profiles where calendar_token is not null on conflict do nothing';
    execute 'drop index if exists public.profiles_calendar_token';
    execute 'alter table public.profiles drop column calendar_token';
  end if;
end $$;

create or replace function public.my_calendar_token(p_reset boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if auth.uid() is null or public.my_role() is null or public.my_role() not in ('tutor', 'learner') then
    raise exception 'Tutors and learners only.';
  end if;
  select token into v from public.calendar_tokens where user_id = auth.uid();
  if v is null or p_reset then
    v := encode(extensions.gen_random_bytes(18), 'hex');
    insert into public.calendar_tokens (user_id, token) values (auth.uid(), v)
      on conflict (user_id) do update set token = excluded.token, created_at = now();
  end if;
  return v;
end $$;

-- Only the Prof server calls this (with the token from the link)
create or replace function public.calendar_feed(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p public.profiles;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  select pr.* into p from public.calendar_tokens c join public.profiles pr on pr.id = c.user_id where c.token = p_token;
  if p.id is null or p.role not in ('tutor', 'learner') then return null; end if;
  if p.role = 'tutor' and p.status <> 'active' then return null; end if;
  return jsonb_build_object(
    'name', 'StudyBridge · ' || p.display_name,
    'events', coalesce((select jsonb_agg(e) from (
      select jsonb_build_object('uid', 's-' || s.id, 'title', s.title, 'start', s.starts_at, 'end', s.starts_at + make_interval(mins => s.duration_min),
                                'description', 'Live lesson on StudyBridge. Open the app to join.') e
        from public.sessions s
       where s.starts_at > now() - interval '60 days' and s.starts_at < now() + interval '400 days' and not s.cancelled
         and ((p.role = 'tutor' and s.tutor_id = p.id) or (p.role = 'learner' and p.id = any (s.learner_ids)))
      union all
      select jsonb_build_object('uid', 'a-' || a.id, 'title', 'Due: ' || a.title, 'start', a.due_at, 'end', a.due_at + interval '15 minutes',
                                'description', initcap(a.kind) || ' due on StudyBridge.')
        from public.assignments a
       where a.due_at is not null and not a.draft and a.source <> 'self'
         and a.due_at > now() - interval '60 days' and a.due_at < now() + interval '400 days'
         and ((p.role = 'tutor' and a.tutor_id = p.id) or (p.role = 'learner' and a.tutor_id = p.tutor_id and public._assignment_visible_to(a, p.id)))
    ) z), '[]'));
end $$;

-- =====================================================================
-- 1.4: StudyBridge practice papers. Original papers Prof writes in the exact format of each
-- exam paper (never copies of real papers), approved by the StudyBridge admin, then shared
-- with every tutor. Written in the background, one job per paper, with an automatic check.
-- No longer used by the app (20 Oct 2026): StudyBridge's papers now come from the content account.
-- =====================================================================
create table if not exists public.sb_paper_plans (
  board text not null,
  code text not null,
  components jsonb not null default '[]',
  note text,
  updated_at timestamptz not null default now(),
  primary key (board, code)
);
create table if not exists public.sb_papers (
  id uuid primary key default gen_random_uuid(),
  board text not null check (board in ('cie', 'ib')),
  code text not null,
  level text,
  paper text not null,
  number int not null default 1,
  title text,
  duration_min int,
  total_marks numeric,
  instructions_md text,
  items jsonb not null default '[]',
  status text not null default 'writing' check (status in ('writing', 'review', 'approved', 'rejected', 'failed')),
  check_note text,
  flagged int not null default 0,
  job_id uuid references public.prof_jobs (id) on delete set null,
  uses int not null default 0,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);
create index if not exists idx_sb_papers_slot on public.sb_papers (board, code, level, paper);
alter table public.sb_paper_plans enable row level security;
alter table public.sb_papers enable row level security;
revoke all on public.sb_paper_plans from anon, authenticated;
revoke all on public.sb_papers from anon, authenticated;
grant select on public.sb_papers to authenticated;
drop policy if exists sb_papers_read on public.sb_papers;
-- No longer handed to tutors (20 Oct 2026): StudyBridge's practice papers come from the content account now
-- (studybridge_papers, in the "one StudyBridge library" block near the end)
create policy sb_papers_read on public.sb_papers for select using (public.is_platform_admin());

create or replace function public._admin_prof() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_err text;
begin
  perform public._admin();
  v_err := public._prof_ready(auth.uid());
  if v_err is not null then raise exception '%', v_err; end if;
  return auth.uid();
end $$;

-- Step 1: Prof works out which written papers a syllabus has (and which can't be written as text)
create or replace function public.admin_paper_plan(p_board text, p_codes text[], p_labels text[])
returns int language plpgsql security definer set search_path = public as $$
declare
  i int;
  me uuid := public._admin_prof();
begin
  if p_board not in ('cie', 'ib') then raise exception 'Unknown exam board.'; end if;
  for i in 1 .. coalesce(array_length(p_codes, 1), 0) loop
    if exists (select 1 from public.prof_jobs where kind = 'paper' and status in ('queued', 'running')
                and context ->> 'mode' = 'plan' and context ->> 'code' = p_codes[i]) then continue; end if;
    insert into public.prof_jobs (tutor_id, kind, prompt, context)
    values (me, 'paper', 'Work out the papers for ' || p_labels[i],
            jsonb_build_object('mode', 'plan', 'board', p_board, 'code', p_codes[i], 'label', p_labels[i]));
  end loop;
  perform public._prof_kick();
  return coalesce(array_length(p_codes, 1), 0);
end $$;

-- Step 2: write papers. p_slots: [{board, code, label, level, paper, name, count}]
create or replace function public.admin_write_papers(p_slots jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  me uuid := public._admin_prof();
  sl jsonb;
  k int;
  n int := 0;
  v_num int;
  v_paper uuid;
  v_job uuid;
begin
  for sl in select * from jsonb_array_elements(coalesce(p_slots, '[]')) loop
    for k in 1 .. greatest(0, least(coalesce((sl ->> 'count')::int, 0), 10)) loop
      select coalesce(max(number), 0) + 1 into v_num from public.sb_papers
       where board = sl ->> 'board' and code = sl ->> 'code' and paper = sl ->> 'paper' and level is not distinct from nullif(sl ->> 'level', '');
      insert into public.sb_papers (board, code, level, paper, number, title)
      values (sl ->> 'board', sl ->> 'code', nullif(sl ->> 'level', ''), sl ->> 'paper', v_num,
              left(format('StudyBridge practice paper %s · %s', v_num, coalesce(sl ->> 'name', 'Paper ' || (sl ->> 'paper'))), 200))
      returning id into v_paper;
      insert into public.prof_jobs (tutor_id, kind, prompt, context)
      values (me, 'paper', left(format('Practice paper %s for %s %s', v_num, sl ->> 'label', coalesce(sl ->> 'name', 'Paper ' || (sl ->> 'paper'))), 300),
              jsonb_build_object('mode', 'write', 'paper_id', v_paper, 'board', sl ->> 'board', 'code', sl ->> 'code', 'label', sl ->> 'label',
                                 'level', nullif(sl ->> 'level', ''), 'paper', sl ->> 'paper', 'name', sl ->> 'name', 'number', v_num,
                                 'duration_min', sl -> 'duration_min', 'marks', sl -> 'marks', 'structure', sl ->> 'structure'))
      returning id into v_job;
      update public.sb_papers set job_id = v_job where id = v_paper;
      n := n + 1;
    end loop;
  end loop;
  perform public._prof_kick();
  return n;
end $$;

create or replace function public.admin_papers() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return jsonb_build_object(
    'plans', coalesce((select jsonb_agg(jsonb_build_object('board', board, 'code', code, 'components', components, 'note', note, 'updated_at', updated_at)) from public.sb_paper_plans), '[]'),
    'papers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'board', p.board, 'code', p.code, 'level', p.level, 'paper', p.paper, 'number', p.number,
        'title', p.title, 'status', p.status, 'flagged', p.flagged, 'check_note', p.check_note, 'total_marks', p.total_marks, 'items', jsonb_array_length(p.items),
        'uses', p.uses, 'created_at', p.created_at, 'job_id', p.job_id, 'job_status', j.status, 'job_progress', j.progress, 'job_error', j.error) order by p.board, p.code, p.level, p.paper, p.number)
      from public.sb_papers p left join public.prof_jobs j on j.id = p.job_id), '[]'),
    -- what a paper has cost so far on average (for the estimate before writing more)
    'avg_cents', (select round(avg(c.cents), 2) from (
        select sum(pc.cost_cents) cents from public.prof_costs pc join public.prof_jobs j on j.id = pc.job_id
         where j.kind = 'paper' and j.context ->> 'mode' = 'write' and j.status = 'done' group by j.id) c),
    'model', (select prof_model from public.app_config where id = 1));
end $$;

-- A paper whose job failed or was stopped shows as "couldn't be written"; trying again starts it afresh
create or replace function public._paper_job_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'paper' and new.status is distinct from old.status and new.context ? 'paper_id' then
    if new.status in ('failed', 'cancelled') then
      update public.sb_papers set status = 'failed' where id = (new.context ->> 'paper_id')::uuid and status = 'writing';
    elsif new.status = 'queued' and old.status in ('failed', 'cancelled') then
      update public.sb_papers set status = 'writing', items = '[]', flagged = 0, check_note = null
       where id = (new.context ->> 'paper_id')::uuid and status = 'failed';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists prof_jobs_paper on public.prof_jobs;
create trigger prof_jobs_paper after update of status on public.prof_jobs
  for each row execute function public._paper_job_status();
update public.sb_papers p set status = 'failed'
  from public.prof_jobs j where j.id = p.job_id and p.status = 'writing' and j.status in ('failed', 'cancelled');

create or replace function public.admin_paper_status(p_ids uuid[], p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  if p_status not in ('approved', 'rejected', 'review') then raise exception 'Unknown status.'; end if;
  update public.sb_papers set status = p_status, approved_at = case when p_status = 'approved' then now() end
   where id = any (p_ids) and status in ('review', 'approved', 'rejected');
end $$;

-- Fix one part of a paper (e.g. one the check flagged): its answer, mark scheme or worked solution
create or replace function public.admin_paper_item(p_id uuid, p_index int, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  it jsonb;
  allowed jsonb;
begin
  perform public._admin();
  select items -> p_index into it from public.sb_papers where id = p_id;
  if it is null then raise exception 'That part isn’t there.'; end if;
  select coalesce(jsonb_object_agg(key, value), '{}') into allowed from jsonb_each(coalesce(p_patch, '{}'))
   where key in ('prompt', 'answer', 'mark_scheme', 'solution', 'marks');
  it := (it || allowed) - 'check' || jsonb_build_object('check', jsonb_build_object('ok', true, 'note', 'Fixed by StudyBridge'));
  update public.sb_papers set items = jsonb_set(items, array[p_index::text], it),
         flagged = (select count(*) from jsonb_array_elements(jsonb_set(items, array[p_index::text], it)) x where x -> 'check' ->> 'ok' = 'false')
   where id = p_id;
end $$;

create or replace function public.admin_delete_paper(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  update public.prof_jobs set status = 'cancelled' where id = (select job_id from public.sb_papers where id = p_id) and status in ('queued', 'running');
  delete from public.sb_papers where id = p_id;
end $$;

create or replace function public.paper_used(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.sb_papers set uses = uses + 1 where id = p_id and status = 'approved' and public._tutor_active()
$$;

-- =====================================================================
-- 1.4: crash reports, a fuller admin console (overview, notes, announcements,
-- feedback inbox, sign-up answers, app versions, minimum version, health)
-- =====================================================================
alter table public.profiles add column if not exists app_version text;
alter table public.profiles add column if not exists platform text;
alter table public.profiles add column if not exists last_seen_at timestamptz;
alter table public.profiles add column if not exists signup jsonb not null default '{}';
alter table public.app_config add column if not exists min_version text;
alter table public.app_config add column if not exists backup_at timestamptz;

-- The app says which version it is, once each time it opens (for Admin: who's on an old version)
create or replace function public.seen(p_version text, p_platform text)
returns void language sql security definer set search_path = public as $$
  update public.profiles set app_version = left(p_version, 30), platform = left(p_platform, 30), last_seen_at = now()
   where id = auth.uid()
$$;

-- ---------------- crash reports ----------------
-- Only the error itself (message, where, which version, what device). Never anyone's work.
create table if not exists public.app_errors (
  id bigserial primary key,
  fingerprint text not null unique,
  message text not null,
  stack text,
  screen text,
  app_version text,
  platform text,
  roles text[] not null default '{}',
  users uuid[] not null default '{}',
  count int not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  resolved_at timestamptz
);
create table if not exists public.app_error_quota (
  who text not null,
  day date not null default current_date,
  n int not null default 0,
  primary key (who, day)
);
alter table public.app_errors enable row level security;
alter table public.app_error_quota enable row level security;
revoke all on public.app_errors from anon, authenticated;
revoke all on public.app_error_quota from anon, authenticated;

create or replace function public.report_error(p_message text, p_stack text default null, p_screen text default null,
  p_version text default null, p_platform text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_who text := auth.uid()::text;
  v_ip text;
  v_n int;
  msg text := left(coalesce(nullif(trim(p_message), ''), 'Unknown error'), 500);
  frames text;
  fp text;
  is_new boolean;
  was_resolved boolean;
  r text := (select role from public.profiles where id = auth.uid());
  a uuid;
begin
  -- at most 30 reports a day per person; signed-out screens (the sign-in page) 20 a day per
  -- internet address and 300 a day altogether, so nobody can flood it
  if auth.uid() is null then
    begin
      v_ip := nullif(trim(split_part(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ',', 1)), '');
    exception when others then v_ip := null;
    end;
    v_who := 'ip:' || left(coalesce(v_ip, 'unknown'), 64);
    insert into public.app_error_quota (who, day, n) values ('anon', current_date, 1)
    on conflict (who, day) do update set n = app_error_quota.n + 1 returning app_error_quota.n into v_n;
    if v_n > 300 then return; end if;
  end if;
  insert into public.app_error_quota (who, day, n) values (v_who, current_date, 1)
  on conflict (who, day) do update set n = app_error_quota.n + 1 returning app_error_quota.n into v_n;
  if v_n > (case when auth.uid() is null then 20 else 30 end) then return; end if;
  -- the same problem groups together across versions: message + top of the stack, without build hashes or positions
  frames := array_to_string((string_to_array(regexp_replace(coalesce(p_stack, ''), '[-.][A-Za-z0-9_]{8}\.(js|mjs)', '.js', 'g'), E'\n'))[1:3], E'\n');
  frames := regexp_replace(frames, ':\d+:\d+', '', 'g');
  fp := md5(msg || '|' || frames);
  select resolved_at is not null into was_resolved from public.app_errors where fingerprint = fp;
  insert into public.app_errors as e (fingerprint, message, stack, screen, app_version, platform, roles, users)
  values (fp, msg, left(p_stack, 4000), left(p_screen, 200), left(p_version, 30), left(p_platform, 60),
          case when r is null then '{}' else array[r] end, case when auth.uid() is null then '{}' else array[auth.uid()] end)
  on conflict (fingerprint) do update set
    count = e.count + 1, last_at = now(), stack = coalesce(excluded.stack, e.stack), screen = coalesce(excluded.screen, e.screen),
    app_version = coalesce(excluded.app_version, e.app_version), platform = coalesce(excluded.platform, e.platform),
    roles = (select array_agg(distinct x) from unnest(e.roles || excluded.roles) x),
    users = case when array_length(e.users, 1) >= 50 then e.users else (select array_agg(distinct x) from unnest(e.users || excluded.users) x) end,
    resolved_at = null
  returning (xmax = 0) into is_new;
  if (is_new or coalesce(was_resolved, false)) and auth.uid() is null then
    -- new problems from signed-out screens: tell the admin about 5 a day at most (the rest still show in Problems)
    insert into public.app_error_quota (who, day, n) values ('anon-told', current_date, 1)
    on conflict (who, day) do update set n = app_error_quota.n + 1 returning app_error_quota.n into v_n;
    if v_n > 5 then return; end if;
  end if;
  if is_new or coalesce(was_resolved, false) then
    for a in select user_id from public.platform_admins pa join public.profiles p on p.id = pa.user_id where p.role = 'admin' loop
      perform public.notify_user(a, 'problem', 'New problem in StudyBridge', left(msg, 200), jsonb_build_object('fingerprint', fp));
    end loop;
  end if;
end $$;
grant execute on function public.report_error(text, text, text, text, text) to anon, authenticated;

create or replace function public.admin_errors() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'message', message, 'stack', stack, 'screen', screen,
      'app_version', app_version, 'platform', platform, 'roles', roles, 'people', coalesce(array_length(users, 1), 0),
      'count', count, 'first_at', first_at, 'last_at', last_at, 'resolved_at', resolved_at)
    order by (resolved_at is null) desc, last_at desc) from (select * from public.app_errors order by last_at desc limit 300) z), '[]');
end $$;

create or replace function public.admin_resolve_error(p_id bigint, p_resolved boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  update public.app_errors set resolved_at = case when p_resolved then now() end where id = p_id;
end $$;

-- ---------------- private notes about a tutor (only the admin) ----------------
create table if not exists public.admin_notes (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  body text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.admin_notes enable row level security;
revoke all on public.admin_notes from anon, authenticated;
create or replace function public.admin_set_note(p_user uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  insert into public.admin_notes (user_id, body) values (p_user, left(coalesce(p_body, ''), 5000))
  on conflict (user_id) do update set body = excluded.body, updated_at = now();
end $$;

-- ---------------- announcements ----------------
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 120),
  body text not null default '' check (length(body) <= 2000),
  audience text not null default 'tutors' check (audience in ('tutors', 'everyone')),
  until timestamptz,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
alter table public.announcements enable row level security;
revoke all on public.announcements from anon, authenticated;
grant select on public.announcements to authenticated;
drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements for select using (
  public.is_platform_admin()
  or (ended_at is null and (until is null or until > now())
      and (audience = 'everyone' or public.my_role() = 'tutor')));

create or replace function public.admin_announce(p_title text, p_body text, p_audience text default 'tutors', p_until timestamptz default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  perform public._admin();
  insert into public.announcements (title, body, audience, until) values (trim(p_title), coalesce(p_body, ''), coalesce(p_audience, 'tutors'), p_until)
  returning id into v;
  return v;
end $$;
create or replace function public.admin_end_announcement(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  update public.announcements set ended_at = now() where id = p_id;
end $$;
-- Change an announcement's words, who sees it and until when (an ended one stays ended)
create or replace function public.admin_edit_announcement(p_id uuid, p_title text, p_body text, p_audience text, p_until timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  if length(trim(coalesce(p_title, ''))) = 0 then raise exception 'Give it a title.'; end if;
  if length(trim(p_title)) > 120 then raise exception 'Keep the title to 120 characters.'; end if;
  if length(coalesce(p_body, '')) > 2000 then raise exception 'Keep the message to 2000 characters.'; end if;
  if coalesce(p_audience, '') not in ('tutors', 'everyone') then raise exception 'Choose who sees it: tutors, or tutors and learners.'; end if;
  update public.announcements set title = trim(p_title), body = coalesce(p_body, ''), audience = p_audience, until = p_until where id = p_id;
  if not found then raise exception 'That announcement isn’t there any more.'; end if;
end $$;
-- Delete an announcement for good
create or replace function public.admin_delete_announcement(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  delete from public.announcements where id = p_id;
  if not found then raise exception 'That announcement isn’t there any more.'; end if;
end $$;

-- ---------------- "Contact StudyBridge": tutors' messages to the admin ----------------
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null default 'question' check (kind in ('problem', 'idea', 'question')),
  body text not null check (length(body) between 2 and 4000),
  app_version text,
  created_at timestamptz not null default now(),
  reply text,
  replied_at timestamptz,
  closed_at timestamptz
);
alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;
grant select on public.feedback to authenticated;
drop policy if exists feedback_read on public.feedback;
create policy feedback_read on public.feedback for select using (user_id = auth.uid() or public.is_platform_admin());

create or replace function public.send_feedback(p_kind text, p_body text, p_version text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v uuid;
  who text;
  a uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if public.my_role() is distinct from 'tutor' and not coalesce((select self_learner from public.profiles where id = auth.uid()), false) then
    raise exception 'Only tutors and students can send these.';
  end if;
  if (select count(*) from public.feedback where user_id = auth.uid() and created_at > now() - interval '1 day') >= 20 then
    raise exception 'That’s a lot of messages today. Try again tomorrow.';
  end if;
  insert into public.feedback (user_id, kind, body, app_version) values (auth.uid(), coalesce(p_kind, 'question'), trim(p_body), left(p_version, 30))
  returning id into v;
  select display_name into who from public.profiles where id = auth.uid();
  for a in select user_id from public.platform_admins pa join public.profiles p on p.id = pa.user_id where p.role = 'admin' loop
    perform public.notify_user(a, 'feedback', coalesce(who, 'Someone') || ' wrote to StudyBridge', left(trim(p_body), 200), jsonb_build_object('feedback_id', v));
  end loop;
  perform public._email_us('support', initcap(coalesce(p_kind, 'question')) || ' from ' || coalesce(who, 'a ' || public.my_role()),
    'From: ' || coalesce(who, 'a tutor') || case when public.my_role() = 'learner' then ' (a student)' else '' end || ' <' || coalesce((select email::text from auth.users where id = auth.uid()), '') || '>'
      || coalesce(E'\nApp version: ' || nullif(p_version, ''), '') || E'\n\n' || trim(p_body)
      || E'\n\n(Reply to this email to answer them, or answer in Admin → Inbox.)',
    (select email::text from auth.users where id = auth.uid()));
  return v;
end $$;

create or replace function public.admin_feedback() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'body', f.body, 'created_at', f.created_at,
      'reply', f.reply, 'replied_at', f.replied_at, 'closed_at', f.closed_at, 'app_version', f.app_version,
      'name', p.display_name, 'email', coalesce(u.email::text, p.email), 'role', p.role, 'user_id', p.id)
    order by (f.closed_at is null) desc, f.created_at desc)
    from public.feedback f join public.profiles p on p.id = f.user_id left join auth.users u on u.id = p.id), '[]');
end $$;

create or replace function public.admin_reply_feedback(p_id uuid, p_reply text, p_close boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare f public.feedback;
begin
  perform public._admin();
  update public.feedback set reply = nullif(trim(coalesce(p_reply, '')), ''), replied_at = case when nullif(trim(coalesce(p_reply, '')), '') is not null then now() else replied_at end,
         closed_at = case when p_close then now() end
   where id = p_id returning * into f;
  if f.id is not null and nullif(trim(coalesce(p_reply, '')), '') is not null then
    perform public.notify_user(f.user_id, 'feedback_reply', 'StudyBridge replied', left(f.reply, 200), jsonb_build_object('feedback_id', f.id));
  end if;
end $$;

-- ---------------- minimum app version, health and the overview ----------------
create or replace function public.admin_set_min_version(p_version text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  if p_version is not null and p_version !~ '^\d+\.\d+\.\d+$' then raise exception 'Use a version like 1.1.25.'; end if;
  update public.app_config set min_version = nullif(p_version, '') where id = 1;
end $$;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_storage bigint;
begin
  perform public._admin();
  begin
    execute 'select coalesce(sum((metadata ->> ''size'')::bigint), 0) from storage.objects' into v_storage;
  exception when others then v_storage := null;
  end;
  return jsonb_build_object(
    'tutors', (select count(*) from public.profiles where role = 'tutor' and status = 'active' and not demo),
    'pending', (select count(*) from public.profiles where role = 'tutor' and status = 'pending' and not demo),
    'learners', (select count(*) from public.profiles where role = 'learner' and not demo),
    'active_7d', (select count(*) from public.profiles where role in ('tutor', 'learner') and last_seen_at > now() - interval '7 days' and not demo),
    'signins_7d', (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'assignments_30d', (select count(*) from public.assignments where created_at > now() - interval '30 days' and not draft),
    'handins_30d', (select count(*) from public.attempts where submitted_at > now() - interval '30 days'),
    'prof_month_cents', (select coalesce(sum(cost_cents), 0) from public.prof_costs where created_at >= date_trunc('month', now())),
    'prof_credit_left_cents', (select balance_cents - spent_cents from public.prof_credit where id = 1),
    'prof_by_month', coalesce((select jsonb_agg(jsonb_build_object('month', to_char(m, 'Mon YY'), 'cents', c) order by m)
        from (select gs::date m, coalesce((select sum(cost_cents) from public.prof_costs where created_at >= gs and created_at < gs + interval '1 month'), 0) c
                from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') gs) z), '[]'),
    'storage_bytes', v_storage,
    'problems_open', (select count(*) from public.app_errors where resolved_at is null),
    'feedback_open', (select count(*) from public.feedback where closed_at is null),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('version', coalesce(app_version, 'unknown'), 'people', n) order by n desc)
        from (select app_version, count(*) n from public.profiles where role in ('tutor', 'learner') and last_seen_at > now() - interval '30 days'
               group by app_version) z), '[]'),
    'min_version', (select min_version from public.app_config where id = 1),
    'health', jsonb_build_object(
      'prof_key', exists (select 1 from public.platform_secrets where id = 1 and anthropic_api_key is not null),
      'prof_seen_at', (select prof_seen_at from public.app_config where id = 1),
      'reports_at', (select reports_at from public.app_config where id = 1),
      'backup_at', (select backup_at from public.app_config where id = 1),
      'pg_cron', exists (select 1 from pg_extension where extname = 'pg_cron'),
      'pg_net', exists (select 1 from pg_extension where extname = 'pg_net'),
      'jobs_failed_24h', (select count(*) from public.prof_jobs where status = 'failed' and updated_at > now() - interval '1 day'),
      'jobs_stuck', (select count(*) from public.prof_jobs where status in ('queued', 'running') and updated_at < now() - interval '30 minutes'))
  );
end $$;

-- ---------------------------------------------------------------------
-- Prof's credit: Anthropic doesn't tell apps how much credit is left on a Claude key, so the admin
-- types in what the Claude Console shows and StudyBridge counts down from it with what Prof spends.
-- The admin is told once when it runs low.
-- ---------------------------------------------------------------------
create table if not exists public.prof_credit (
  id int primary key default 1 check (id = 1),
  balance_cents numeric,
  set_at timestamptz,
  spent_cents numeric not null default 0,
  low_cents numeric not null default 500,
  told_at timestamptz
);
insert into public.prof_credit (id) values (1) on conflict do nothing;
alter table public.prof_credit enable row level security;
revoke all on public.prof_credit from public, anon, authenticated;

create or replace function public._prof_credit_spend(p_cents numeric) returns void
language plpgsql security definer set search_path = public as $$
declare c public.prof_credit;
begin
  if coalesce(p_cents, 0) <= 0 then return; end if;
  update public.prof_credit set spent_cents = spent_cents + p_cents where id = 1 and balance_cents is not null returning * into c;
  if c.id is null or c.told_at is not null then return; end if;
  if c.balance_cents - c.spent_cents <= c.low_cents then
    update public.prof_credit set told_at = now() where id = 1;
    perform public.notify_user(pa.user_id, 'prof_credit', 'Prof’s Claude credit is running low',
      format('About $%s left of the credit you entered. Top up in the Claude Console, then update it in Admin → Prof.',
             to_char(greatest(0, c.balance_cents - c.spent_cents) / 100, 'FM999990.00')), '{}')
      from public.platform_admins pa join public.profiles p on p.id = pa.user_id where p.role = 'admin';
  end if;
end $$;

create or replace function public.admin_set_prof_credit(p_balance_cents numeric, p_low_cents numeric default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  if p_balance_cents is not null and p_balance_cents < 0 then raise exception 'The credit can’t be negative.'; end if;
  update public.prof_credit set balance_cents = p_balance_cents, set_at = case when p_balance_cents is null then null else now() end,
         spent_cents = 0, told_at = null, low_cents = coalesce(p_low_cents, low_cents) where id = 1;
end $$;

-- Everything about Prof's spending, for the admin
create or replace function public.admin_prof() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.prof_credit;
begin
  perform public._admin();
  select * into c from public.prof_credit where id = 1;
  return jsonb_build_object(
    'credit', jsonb_build_object('balance_cents', c.balance_cents, 'set_at', c.set_at, 'spent_cents', c.spent_cents,
                                 'left_cents', case when c.balance_cents is not null then c.balance_cents - c.spent_cents end, 'low_cents', c.low_cents),
    'model', (select prof_model from public.app_config where id = 1),
    'key_set', exists (select 1 from public.platform_secrets where id = 1 and anthropic_api_key is not null),
    'month_cents', (select coalesce(sum(cost_cents), 0) from public.prof_costs where created_at >= date_trunc('month', now())),
    'last_month_cents', (select coalesce(sum(cost_cents), 0) from public.prof_costs
                          where created_at >= date_trunc('month', now()) - interval '1 month' and created_at < date_trunc('month', now())),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', to_char(d, 'DD Mon'), 'cents', c2) order by d)
        from (select gs::date d, coalesce((select sum(cost_cents) from public.prof_costs where created_at >= gs and created_at < gs + interval '1 day'), 0) c2
                from generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') gs) z), '[]'),
    'by_tutor', coalesce((select jsonb_agg(x order by (x ->> 'cents')::numeric desc) from (
        select jsonb_build_object('id', p.id, 'name', p.display_name, 'role', p.role,
               'cents', coalesce(sum(pc.cost_cents), 0), 'jobs', count(pc.id),
               'limit_cents', case when p.role = 'tutor' then public._prof_limit(p.id) end) x
          from public.prof_costs pc join public.profiles p on p.id = pc.tutor_id
         where pc.created_at >= date_trunc('month', now())
         group by p.id) t), '[]'),
    'by_kind', coalesce((select jsonb_agg(jsonb_build_object('kind', k, 'cents', cents, 'jobs', n) order by cents desc) from (
        select coalesce(j.kind, 'other') k, sum(pc.cost_cents) cents, count(*) n
          from public.prof_costs pc left join public.prof_jobs j on j.id = pc.job_id
         where pc.created_at >= date_trunc('month', now())
         group by 1) z), '[]')
  );
end $$;

-- One tutor in detail (still account details only, never their work)
create or replace function public.admin_tutor(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return (select jsonb_build_object(
    'id', p.id, 'name', p.display_name, 'email', coalesce(u.email::text, p.email), 'status', p.status, 'plan', p.plan,
    'plan_learners', p.plan_learners, 'plan_until', p.plan_until, 'plan_limit', public._tutor_limit(p.id),
    'timezone', p.timezone, 'joined_at', coalesce(u.created_at, p.created_at), 'last_sign_in_at', u.last_sign_in_at,
    'last_seen_at', p.last_seen_at, 'app_version', p.app_version, 'platform', p.platform, 'signup', p.signup,
    'learners', (select count(*) from public.profiles l where l.tutor_id = p.id and l.role = 'learner'),
    'storage_bytes', public._storage_bytes(p.id),
    'ai_cents', public._prof_month_cents(p.id), 'ai_limit_cents', public._prof_limit(p.id), 'ai_limit_custom', exists (select 1 from public.prof_limits pl where pl.tutor_id = p.id),
    'ai_by_month', coalesce((select jsonb_agg(jsonb_build_object('month', to_char(m, 'Mon YY'), 'cents', c) order by m)
        from (select gs::date m, coalesce((select sum(cost_cents) from public.prof_costs where tutor_id = p.id and created_at >= gs and created_at < gs + interval '1 month'), 0) c
                from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') gs) z), '[]'),
    'note', (select body from public.admin_notes where user_id = p.id))
    from public.profiles p left join auth.users u on u.id = p.id where p.id = p_user and p.role = 'tutor');
end $$;

-- =====================================================================
-- 1.6 part 1: weekly lessons and reminders. A weekly lesson keeps the tutor's own clock time
-- (in the time zone the tutor set it in); each learner sees it in their own time zone, so when
-- one country changes its clocks, the other country's time moves by an hour. Lessons are made
-- 8 weeks ahead and topped up every hour. Reminders go out a day and 15 minutes before.
-- =====================================================================
create table if not exists public.lesson_series (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null,
  learner_ids uuid[] not null default '{}',
  weekday int not null check (weekday between 0 and 6),
  start_time time not null,
  timezone text not null,
  duration_min int not null default 60,
  starts_on date not null,
  ends_on date,
  notes_md text,
  created_at timestamptz not null default now()
);
alter table public.lesson_series enable row level security;
revoke all on public.lesson_series from public, anon, authenticated;
grant select on public.lesson_series to authenticated;
drop policy if exists series_tutor on public.lesson_series;
create policy series_tutor on public.lesson_series for select using (tutor_id = auth.uid());
drop policy if exists series_learner on public.lesson_series;
create policy series_learner on public.lesson_series for select using (auth.uid() = any (learner_ids));

alter table public.sessions add column if not exists series_id uuid references public.lesson_series (id) on delete cascade;
alter table public.sessions add column if not exists series_date date;
alter table public.sessions add column if not exists cancelled boolean not null default false;
alter table public.sessions add column if not exists reminded_day timestamptz;
alter table public.sessions add column if not exists reminded_soon timestamptz;
create unique index if not exists sessions_series_date on public.sessions (series_id, series_date) where series_id is not null;

-- Phone alerts (ntfy) for learners who switch them on; tutors keep theirs in tutor_settings
create table if not exists public.phone_alerts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  ntfy_topic text not null default ('studybridge-' || encode(extensions.gen_random_bytes(9), 'hex')),
  enabled boolean not null default false
);
alter table public.phone_alerts enable row level security;
revoke all on public.phone_alerts from public, anon, authenticated;

create or replace function public.my_phone_alerts(p_enabled boolean default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.phone_alerts;
begin
  if public.my_role() is distinct from 'learner' then raise exception 'Learners only (tutors set phone alerts in their own settings).'; end if;
  insert into public.phone_alerts (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  if p_enabled is not null then update public.phone_alerts set enabled = p_enabled where user_id = auth.uid(); end if;
  select * into v from public.phone_alerts where user_id = auth.uid();
  return jsonb_build_object('topic', v.ntfy_topic, 'enabled', v.enabled);
end $$;

-- A user's own time zone (UTC if it isn't a real one)
create or replace function public._tz_of(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select p.timezone from public.profiles p join pg_timezone_names z on z.name = p.timezone where p.id = p_user), 'UTC')
$$;

-- The moment a weekly lesson starts on a given day, at the tutor's clock time in the tutor's time zone
create or replace function public._series_start(p_day date, p_time time, p_tz text) returns timestamptz
language sql stable as $$ select (p_day + p_time) at time zone p_tz $$;

-- Make the lessons of one weekly series (or all of them) up to p_weeks ahead. Skipped or moved ones stay as they are.
create or replace function public._fill_series(p_series uuid default null, p_weeks int default 8) returns int
language plpgsql security definer set search_path = public as $$
declare
  r public.lesson_series;
  d date;
  v_to date;
  v_at timestamptz;
  n int := 0;
begin
  for r in select s.* from public.lesson_series s
            where (p_series is null or s.id = p_series) and public._tutor_active(s.tutor_id)
              and (s.ends_on is null or s.ends_on >= (now() at time zone s.timezone)::date - 1) loop
    d := greatest(r.starts_on, (now() at time zone r.timezone)::date - 1);
    d := d + ((r.weekday - extract(dow from d)::int + 7) % 7);
    v_to := (now() at time zone r.timezone)::date + p_weeks * 7;
    if r.ends_on is not null then v_to := least(v_to, r.ends_on); end if;
    while d <= v_to loop
      v_at := public._series_start(d, r.start_time, r.timezone);
      if v_at > now() then
        insert into public.sessions (tutor_id, title, starts_at, duration_min, learner_ids, notes_md, series_id, series_date)
        values (r.tutor_id, r.title, v_at, r.duration_min, r.learner_ids, r.notes_md, r.id, d)
        on conflict (series_id, series_date) where series_id is not null do nothing;
        if found then n := n + 1; end if;
      end if;
      d := d + 7;
    end loop;
  end loop;
  return n;
end $$;

-- Tell the learners of a weekly lesson when it is, in their own time
create or replace function public._series_notify(p_series uuid, p_title text) returns void
language plpgsql security definer set search_path = public as $$
declare
  r public.lesson_series;
  v_next timestamptz;
  v_tz text;
  l uuid;
begin
  select * into r from public.lesson_series where id = p_series;
  select min(starts_at) into v_next from public.sessions where series_id = p_series and not cancelled and starts_at > now();

  foreach l in array r.learner_ids loop
    v_tz := public._tz_of(l);
    perform public.notify_user(l, 'session', p_title || r.title,
      case when v_next is null then 'No lessons are planned for it right now.'
      else 'Every ' || trim(to_char(v_next at time zone v_tz, 'Day')) || ' at ' || to_char(v_next at time zone v_tz, 'HH24:MI')
        || ' your time, starting ' || to_char(v_next at time zone v_tz, 'Dy DD Mon') || '.'
        || case when exists (select 1 from generate_series(4, 26, 2) w
                              where to_char(public._series_start((v_next at time zone r.timezone)::date + w * 7, r.start_time, r.timezone) at time zone v_tz, 'HH24:MI')
                                 <> to_char(v_next at time zone v_tz, 'HH24:MI'))
                then ' Your time moves by an hour when the clocks change.' else '' end
      end,
      jsonb_build_object('series_id', p_series));
  end loop;
end $$;

-- Checks shared by create and change: returns the tutor's own clock time for the first lesson
create or replace function public._series_check(p_title text, p_first timestamptz, p_learner_ids uuid[], p_timezone text, p_until date)
returns timestamp language plpgsql stable security definer set search_path = public as $$
declare l uuid; v_tz text; v_local timestamp;
begin
  if public.my_role() is distinct from 'tutor' or not public._tutor_active() then raise exception 'Tutors only.'; end if;
  if nullif(trim(coalesce(p_title, '')), '') is null then raise exception 'Give the lesson a title.'; end if;
  if p_first is null then raise exception 'Choose when the first lesson is.'; end if;
  if coalesce(array_length(p_learner_ids, 1), 0) = 0 then raise exception 'Choose at least one learner.'; end if;
  foreach l in array p_learner_ids loop
    if not public.is_my_learner(l) then raise exception 'Not your learner.'; end if;
  end loop;
  v_tz := coalesce((select name from pg_timezone_names where name = p_timezone), public._tz_of(auth.uid()));
  v_local := date_trunc('minute', p_first at time zone v_tz);
  if p_until is not null and p_until < v_local::date then raise exception 'The last date is before the first lesson.'; end if;
  return v_local;
end $$;

create or replace function public.create_lesson_series(p_title text, p_first timestamptz, p_duration int, p_learner_ids uuid[],
  p_timezone text, p_until date default null, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_local timestamp; v_tz text; v_id uuid;
begin
  v_local := public._series_check(p_title, p_first, p_learner_ids, p_timezone, p_until);
  v_tz := coalesce((select name from pg_timezone_names where name = p_timezone), public._tz_of(auth.uid()));
  insert into public.lesson_series (tutor_id, title, learner_ids, weekday, start_time, timezone, duration_min, starts_on, ends_on, notes_md)
  values (auth.uid(), trim(p_title), p_learner_ids, extract(dow from v_local)::int, v_local::time, v_tz,
          greatest(10, least(coalesce(p_duration, 60), 480)), v_local::date, p_until, nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  perform public._fill_series(v_id);
  perform public._series_notify(v_id, 'Weekly lesson: ');
  return v_id;
end $$;

-- Change a weekly lesson from now on (time, day, length, learners, title). Past lessons stay as they were.
-- Lessons before p_from (default: now) stay as they are.
create or replace function public.change_lesson_series(p_series uuid, p_title text, p_first timestamptz, p_duration int, p_learner_ids uuid[],
  p_timezone text, p_until date default null, p_notes text default null, p_from timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_local timestamp; v_tz text; v_old uuid[]; l uuid;
begin
  select learner_ids into v_old from public.lesson_series where id = p_series and tutor_id = auth.uid();
  if not found then raise exception 'Not your lesson.'; end if;
  v_local := public._series_check(p_title, p_first, p_learner_ids, p_timezone, p_until);
  v_tz := coalesce((select name from pg_timezone_names where name = p_timezone), public._tz_of(auth.uid()));
  update public.lesson_series set title = trim(p_title), learner_ids = p_learner_ids, weekday = extract(dow from v_local)::int,
    start_time = v_local::time, timezone = v_tz, duration_min = greatest(10, least(coalesce(p_duration, 60), 480)),
    starts_on = v_local::date, ends_on = p_until, notes_md = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_series;
  delete from public.sessions where series_id = p_series and starts_at > now() and starts_at >= coalesce(p_from, now());
  perform public._fill_series(p_series);
  perform public._series_notify(p_series, 'Weekly lesson changed: ');
  foreach l in array v_old loop
    if not l = any (p_learner_ids) then
      perform public.notify_user(l, 'session', 'Weekly lesson stopped: ' || trim(p_title), 'This weekly lesson no longer includes you.', '{}');
    end if;
  end loop;
end $$;

create or replace function public.end_lesson_series(p_series uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.lesson_series; l uuid;
begin
  update public.lesson_series set ends_on = (now() at time zone timezone)::date - 1
   where id = p_series and tutor_id = auth.uid() returning * into r;
  if not found then raise exception 'Not your lesson.'; end if;
  delete from public.sessions where series_id = p_series and starts_at > now();
  foreach l in array r.learner_ids loop
    perform public.notify_user(l, 'session', 'Weekly lesson stopped: ' || r.title, 'There are no more lessons planned for it.', '{}');
  end loop;
end $$;

-- Skip one lesson (or put it back)
create or replace function public.skip_lesson(p_session uuid, p_skip boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessions; l uuid;
begin
  update public.sessions set cancelled = coalesce(p_skip, true)
   where id = p_session and tutor_id = auth.uid() and starts_at > now() returning * into s;
  if not found then raise exception 'Not your lesson, or it has already started.'; end if;
  foreach l in array s.learner_ids loop
    perform public.notify_user(l, 'session', case when s.cancelled then 'Lesson skipped: ' else 'Lesson back on: ' end || s.title,
      case when s.cancelled then 'No lesson on ' else 'On ' end || to_char(s.starts_at at time zone public._tz_of(l), 'Dy DD Mon, HH24:MI') || ' your time.',
      jsonb_build_object('session_id', s.id));
  end loop;
end $$;

-- Moving one lesson tells its learners and resets its reminders; cancelling a one-off lesson tells them too
create or replace function public.on_session_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare l uuid;
begin
  if new.starts_at is distinct from old.starts_at then
    new.reminded_day := null;
    new.reminded_soon := null;
    if new.starts_at > now() and not new.cancelled then
      foreach l in array new.learner_ids loop
        perform public.notify_user(l, 'session', 'Lesson moved: ' || new.title,
          'Now ' || to_char(new.starts_at at time zone public._tz_of(l), 'Dy DD Mon, HH24:MI') || ' your time.', jsonb_build_object('session_id', new.id));
      end loop;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists sessions_changed on public.sessions;
create trigger sessions_changed before update on public.sessions for each row execute function public.on_session_changed();

create or replace function public.on_session_deleted() returns trigger
language plpgsql security definer set search_path = public as $$
declare l uuid;
begin
  if old.series_id is null and not old.cancelled and old.starts_at > now() then
    foreach l in array old.learner_ids loop
      perform public.notify_user(l, 'session', 'Lesson cancelled: ' || old.title,
        'It was ' || to_char(old.starts_at at time zone public._tz_of(l), 'Dy DD Mon, HH24:MI') || ' your time.', '{}');
    end loop;
  end if;
  return old;
end $$;
drop trigger if exists sessions_deleted on public.sessions;
create trigger sessions_deleted after delete on public.sessions for each row execute function public.on_session_deleted();

-- Reminders: a day before (if the lesson was planned before then) and 15 minutes before. Each goes out once.
create or replace function public._lesson_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare
  s public.sessions;
  l uuid;
  v_soon boolean;
  v_others text;
  n int := 0;
begin
  for s in select x.* from public.sessions x
            where not x.cancelled and public._tutor_active(x.tutor_id)
              and ((x.reminded_soon is null and x.starts_at > now() and x.starts_at <= now() + interval '15 minutes'
                    and x.created_at < x.starts_at - interval '15 minutes')
                or (x.reminded_day is null and x.starts_at > now() + interval '1 hour' and x.starts_at <= now() + interval '24 hours'
                    and x.created_at < x.starts_at - interval '23 hours'))
            order by x.starts_at
            for update skip locked loop
    v_soon := s.starts_at <= now() + interval '15 minutes';
    foreach l in array s.learner_ids loop
      perform public.notify_user(l, 'session',
        case when v_soon then 'Lesson in 15 minutes: ' else 'Lesson coming up: ' end || s.title,
        case when v_soon then 'Starts at ' || to_char(s.starts_at at time zone public._tz_of(l), 'HH24:MI') || ' your time. Open Live in StudyBridge to join.'
        else 'Starts ' || to_char(s.starts_at at time zone public._tz_of(l), 'Dy DD Mon, HH24:MI') || ' your time.' end,
        jsonb_build_object('session_id', s.id));
    end loop;
    -- the tutor sees their own time and each learner's
    select string_agg(p.display_name || ' ' || to_char(s.starts_at at time zone public._tz_of(p.id), 'Dy HH24:MI'), ', ' order by p.display_name)
      into v_others from public.profiles p where p.id = any (s.learner_ids);
    perform public.notify_user(s.tutor_id, 'session',
      case when v_soon then 'Lesson in 15 minutes: ' else 'Lesson coming up: ' end || s.title,
      'Starts ' || to_char(s.starts_at at time zone public._tz_of(s.tutor_id), 'Dy DD Mon, HH24:MI') || ' your time'
        || coalesce(' · ' || v_others, '') || '.',
      jsonb_build_object('session_id', s.id));
    if v_soon then
      update public.sessions set reminded_soon = now(), reminded_day = coalesce(reminded_day, now()) where id = s.id;
    else
      update public.sessions set reminded_day = now() where id = s.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Runs every 5 minutes: reminders, and once an hour, the next weeks' lessons
create or replace function public._lesson_tick() returns void
language plpgsql security definer set search_path = public as $$
begin
  if extract(minute from now()) < 5 then perform public._fill_series(); end if;
  perform public._lesson_reminders();
end $$;

-- =====================================================================
-- 1.6 part 2: mock exams and grade boundaries. A mock is one or more papers (the tutor's own tests or
-- exams). Its marks add up to one total, and the grade comes from the tutor's own grade boundaries for
-- that exam by plain maths, never AI. Boundaries are set once per exam and session and stay private to
-- the tutor: learners only ever see their grade and how many marks short of the next one they were.
-- =====================================================================
create table if not exists public.grade_boundaries (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  exam text not null,                            -- 'cie:0607', 'ib:math-aa', or 'subject:<id>'
  session text not null default '',              -- e.g. 'June 2025'
  option_label text not null default '',         -- e.g. 'Extended (Papers 2 and 4)'
  max_mark numeric not null check (max_mark > 0),
  grades jsonb not null default '[]',            -- [{"grade": "A*", "min": 160}, ...] highest first
  source text not null default 'tutor' check (source in ('tutor', 'prof')),
  created_at timestamptz not null default now()
);
create index if not exists idx_boundaries_exam on public.grade_boundaries (tutor_id, exam, created_at desc);
alter table public.grade_boundaries enable row level security;
revoke all on public.grade_boundaries from public, anon, authenticated;
grant select, insert, update, delete on public.grade_boundaries to authenticated;
drop policy if exists boundaries_tutor on public.grade_boundaries;
create policy boundaries_tutor on public.grade_boundaries for all using (tutor_id = auth.uid())
  with check (tutor_id = auth.uid() and public.my_role() = 'tutor');

-- Each grade needs a name and the lowest mark that gets it; they're kept highest first
create or replace function public._check_boundaries() returns trigger
language plpgsql set search_path = public as $$
declare
  g jsonb;
  v numeric;
  n text;
  names text[] := '{}';
  mins numeric[] := '{}';
  out jsonb := '[]';
begin
  new.exam := trim(coalesce(new.exam, ''));
  if new.exam = '' then raise exception 'Say which exam these boundaries are for.'; end if;
  new.session := left(trim(coalesce(new.session, '')), 60);
  new.option_label := left(trim(coalesce(new.option_label, '')), 120);
  if new.max_mark is null or new.max_mark <= 0 then raise exception 'Give the total marks the boundaries are out of.'; end if;
  if jsonb_typeof(new.grades) is distinct from 'array' or jsonb_array_length(new.grades) = 0 then raise exception 'Add at least one grade.'; end if;
  if jsonb_array_length(new.grades) > 12 then raise exception 'Up to 12 grades.'; end if;
  for g in select * from jsonb_array_elements(new.grades) loop
    n := left(trim(coalesce(g ->> 'grade', '')), 8);
    if n = '' then raise exception 'Every grade needs a name, like A* or 7.'; end if;
    begin
      v := (g ->> 'min')::numeric;
    exception when others then
      v := null;
    end;
    if v is null then raise exception 'Grade % needs the lowest mark that gets it.', n; end if;
    if v < 0 or v > new.max_mark then raise exception 'Grade %: % isn’t between 0 and %.', n, v, new.max_mark; end if;
    if upper(n) = any (select upper(x) from unnest(names) x) then raise exception 'Grade % is there twice.', n; end if;
    if v = any (mins) then raise exception 'Two grades can’t start at the same mark (%).', v; end if;
    names := names || n;
    mins := mins || v;
    out := out || jsonb_build_object('grade', n, 'min', v);
  end loop;
  select jsonb_agg(x order by (x ->> 'min')::numeric desc) into new.grades from jsonb_array_elements(out) x;
  return new;
end $$;
drop trigger if exists boundaries_check on public.grade_boundaries;
create trigger boundaries_check before insert or update on public.grade_boundaries for each row execute function public._check_boundaries();

create table if not exists public.mocks (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null,
  subject_id uuid references public.subjects (id) on delete set null,
  exam text,
  boundary_id uuid references public.grade_boundaries (id) on delete set null,   -- null: the latest for the exam
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.mocks enable row level security;
revoke all on public.mocks from public, anon, authenticated;
grant select, insert, update, delete on public.mocks to authenticated;
drop policy if exists mocks_tutor on public.mocks;
create policy mocks_tutor on public.mocks for all using (tutor_id = auth.uid()) with check (tutor_id = auth.uid() and public.my_role() = 'tutor');

create or replace function public._check_mock() returns trigger
language plpgsql set search_path = public as $$
begin
  new.title := left(trim(coalesce(new.title, '')), 200);
  if new.title = '' then raise exception 'Give the mock exam a title.'; end if;
  if new.subject_id is not null and not exists (select 1 from public.subjects where id = new.subject_id and tutor_id = new.tutor_id) then
    raise exception 'Unknown subject.';
  end if;
  if new.boundary_id is not null and not exists (select 1 from public.grade_boundaries where id = new.boundary_id and tutor_id = new.tutor_id) then
    raise exception 'Unknown grade boundaries.';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists mocks_check on public.mocks;
create trigger mocks_check before insert or update on public.mocks for each row execute function public._check_mock();

alter table public.assignments add column if not exists mock_id uuid references public.mocks (id) on delete set null;
alter table public.assignments add column if not exists mock_position int;
create index if not exists idx_assignments_mock on public.assignments (mock_id) where mock_id is not null;

create or replace function public._check_assignment_mock() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.mock_id is not null and not exists (select 1 from public.mocks where id = new.mock_id and tutor_id = new.tutor_id) then
    raise exception 'Not your mock exam.';
  end if;
  if new.mock_id is null then new.mock_position := null; end if;
  return new;
end $$;
drop trigger if exists assignments_mock on public.assignments;
create trigger assignments_mock before insert or update of mock_id, mock_position on public.assignments
  for each row execute function public._check_assignment_mock();

-- Who a piece of work is for, whether or not it's visible yet
create or replace function public._in_audience(a public.assignments, p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
           when a.learner_ids is not null and cardinality(a.learner_ids) > 0 then p_learner = any (a.learner_ids)
           when a.subject_id is not null then exists (select 1 from public.learner_subjects ls where ls.learner_id = p_learner and ls.subject_id = a.subject_id)
           else true
         end
$$;

-- The boundaries a mock uses: the ones chosen for it, else the newest the tutor has for its exam
create or replace function public._mock_boundary(p_mock uuid) returns public.grade_boundaries
language sql stable security definer set search_path = public as $$
  select b.* from public.mocks m
    join public.grade_boundaries b on b.tutor_id = m.tutor_id
   where m.id = p_mock and (b.id = m.boundary_id or (m.boundary_id is null and b.exam = m.exam))
   order by b.created_at desc
   limit 1
$$;

-- The grade for a score, by plain maths. Boundaries out of a different total are scaled, so a mock out of
-- 100 marks uses the same percentages as the real exam out of 200.
create or replace function public._grade_for(p_grades jsonb, p_max_mark numeric, p_score numeric, p_out_of numeric) returns jsonb
language sql immutable set search_path = public as $$
  with g as (
    select x ->> 'grade' as grade, ceil(round((x ->> 'min')::numeric * p_out_of / p_max_mark, 6)) as need
      from jsonb_array_elements(p_grades) x
  )
  select jsonb_build_object(
    'grade', coalesce((select grade from g where p_score >= need order by need desc limit 1), 'U'),
    'next', (select grade from g where need > p_score order by need limit 1),
    'short_by', (select need - p_score from g where need > p_score order by need limit 1))
$$;

-- One learner's mock: each paper, the total and the grade. In the learner's own view, marks show only once
-- given back, and the total and grade only once every paper is.
create or replace function public._mock_result(p_mock uuid, p_learner uuid, p_learner_view boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_papers jsonb;
  v_n int;
  v_marked int;
  v_released int;
  v_total numeric;
  v_max numeric;
  v_last timestamptz;
  v_complete boolean;
  v_show boolean;
  b public.grade_boundaries;
  g jsonb;
begin
  select coalesce(jsonb_agg(p order by (p ->> 'position')::int nulls last, p ->> 'created_at'), '[]') into v_papers from (
    select jsonb_build_object(
      'id', a.id, 'title', a.title, 'kind', a.kind, 'position', a.mock_position, 'created_at', a.created_at,
      'visible', public._assignment_visible_to(a, p_learner),
      'attempt_id', t.id,
      'status', case when t.id is null then 'not_started'
                     when t.status = 'in_progress' then 'doing'
                     when t.score is not null and t.status in ('marked', 'returned') then 'marked'
                     else 'submitted' end,
      'released', coalesce(t.rel, false),
      '_score', case when t.score is not null and t.status in ('marked', 'returned') then t.score end,
      'max', coalesce(t.max_score, (select sum(q.marks) from public.questions q where q.assignment_id = a.id), 0),
      'submitted_at', t.submitted_at) as p
    from public.assignments a
    left join lateral (select x.*, public._is_released(x) as rel from public.attempts x
                        where x.assignment_id = a.id and x.learner_id = p_learner order by x.number desc limit 1) t on true
    where a.mock_id = p_mock and not a.draft
  ) z;
  v_n := jsonb_array_length(v_papers);
  select count(*) filter (where x ->> 'status' = 'marked'),
         count(*) filter (where x ->> 'status' = 'marked' and (x ->> 'released')::boolean),
         coalesce(sum((x ->> '_score')::numeric), 0), coalesce(sum((x ->> 'max')::numeric), 0), max((x ->> 'submitted_at')::timestamptz)
    into v_marked, v_released, v_total, v_max, v_last
    from jsonb_array_elements(v_papers) x;
  v_complete := v_n > 0 and v_marked = v_n;
  v_show := not p_learner_view or (v_complete and v_released = v_n);
  b := public._mock_boundary(p_mock);
  if v_complete and v_max > 0 and b.id is not null then g := public._grade_for(b.grades, b.max_mark, v_total, v_max); end if;
  return jsonb_build_object(
    'papers', coalesce((select jsonb_agg((x - '_score') || jsonb_build_object('score',
                          case when not p_learner_view or (x ->> 'released')::boolean then x -> '_score' end))
                          from jsonb_array_elements(v_papers) x
                         where not p_learner_view or (x ->> 'visible')::boolean or x ->> 'attempt_id' is not null), '[]'),
    'count', v_n,
    'marked', v_marked,
    'complete', v_complete,
    'released', v_complete and v_released = v_n,
    'last_at', v_last,
    'max', case when v_show then v_max end,
    'total', case when v_show and (v_complete or not p_learner_view) then v_total end,
    'pct', case when v_show and v_complete and v_max > 0 then round(100 * v_total / v_max) end,
    'grade', case when v_show then g ->> 'grade' end,
    'next', case when v_show then g ->> 'next' end,
    'short_by', case when v_show then (g ->> 'short_by')::numeric end,
    'has_boundaries', b.id is not null) - case when p_learner_view then 'has_boundaries' else '' end;
end $$;

-- The tutor's results table for a mock: every learner it's for, paper by paper
create or replace function public.mock_results(p_mock uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  m public.mocks;
  b public.grade_boundaries;
begin
  select * into m from public.mocks where id = p_mock and tutor_id = auth.uid();
  if m.id is null then raise exception 'Not your mock exam.'; end if;
  b := public._mock_boundary(p_mock);
  return jsonb_build_object(
    'boundary', case when b.id is not null then to_jsonb(b) end,
    'learners', coalesce((
      select jsonb_agg(public._mock_result(p_mock, p.id) || jsonb_build_object('learner_id', p.id, 'name', p.display_name) order by p.display_name)
        from public.profiles p
       where p.tutor_id = auth.uid() and p.role = 'learner'
         and exists (select 1 from public.assignments a where a.mock_id = p_mock and not a.draft
                       and (public._in_audience(a, p.id) or exists (select 1 from public.attempts t where t.assignment_id = a.id and t.learner_id = p.id)))), '[]'));
end $$;

-- A learner's mocks (the ones with a paper they can see), without boundaries
create or replace function public.my_mocks() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'subject_id', m.subject_id)
                            || public._mock_result(m.id, auth.uid(), true) order by m.created_at desc), '[]')
    from public.mocks m
   where public.my_role() = 'learner' and m.tutor_id = public.my_tutor()
     and exists (select 1 from public.assignments a where a.mock_id = m.id and public._assignment_visible_to(a, auth.uid()))
$$;

-- Mock grades over time, oldest first. The tutor sees every finished mock; a learner sees the ones given back.
create or replace function public.mock_history(p_learner uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_l uuid := coalesce(p_learner, auth.uid());
  v_own boolean;
  v_tutor uuid;
begin
  if v_l = auth.uid() and public.my_role() = 'learner' then
    v_own := true;
    v_tutor := public.my_tutor();
  elsif public.is_my_learner(v_l) then
    v_own := false;
    v_tutor := auth.uid();
  else
    raise exception 'Not your learner.';
  end if;
  return coalesce((
    select jsonb_agg(r order by r ->> 'last_at') from (
      select jsonb_build_object('id', m.id, 'title', m.title, 'subject_id', m.subject_id) || (public._mock_result(m.id, v_l, v_own) - 'papers') as r
        from public.mocks m
       where m.tutor_id = v_tutor
    ) z
    where r ->> 'pct' is not null), '[]');
end $$;

-- Prof reads the tutor's own grade-threshold PDF (pictures of its pages); the tutor checks the numbers before saving
create or replace function public.prof_boundaries(p_exam text, p_label text, p_pages jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text;
  v_id uuid;
  p jsonb;
begin
  v_err := public._prof_ready(auth.uid());
  if v_err is not null then raise exception '%', v_err; end if;
  if nullif(trim(coalesce(p_exam, '')), '') is null then raise exception 'Say which exam these boundaries are for.'; end if;
  if jsonb_typeof(p_pages) is distinct from 'array' or jsonb_array_length(p_pages) = 0 then raise exception 'Choose the grade-threshold PDF first.'; end if;
  if jsonb_array_length(p_pages) > 6 then raise exception 'Up to 6 pages at a time.'; end if;
  for p in select * from jsonb_array_elements(p_pages) loop
    if coalesce(p ->> 'path', '') not like auth.uid()::text || '/prof/%' then raise exception 'Unknown page.'; end if;
  end loop;
  insert into public.prof_jobs (tutor_id, kind, prompt, context)
  values (auth.uid(), 'boundaries', format('Read the grade thresholds for %s', left(coalesce(nullif(trim(p_label), ''), trim(p_exam)), 150)),
          jsonb_build_object('exam', trim(p_exam), 'label', left(trim(coalesce(p_label, '')), 200), 'pages', p_pages))
  returning id into v_id;
  perform public._prof_kick();
  return jsonb_build_object('id', v_id);
end $$;

-- =====================================================================
-- 1.6 part 3: parent accounts (read-only). A parent joins with a code the tutor makes for one learner.
-- Parents never get a tutor (tutor_id stays empty), so none of the tutor's or learners' tables are open to
-- them; everything they see comes through parent_children() and parent_view(), which hand out only: weekly
-- reports the tutor approved, upcoming lessons and due dates, marks that were given back, topic strengths,
-- mock grades that were given back, and the exam countdown. Never messages, working, photos, the exam
-- camera or anything from Prof. The learner sees which parents are linked and can remove them.
-- =====================================================================
create table if not exists public.parent_links (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles (id) on delete cascade,
  learner_id uuid not null references public.profiles (id) on delete cascade,
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (parent_id, learner_id)
);
create index if not exists idx_parent_links_learner on public.parent_links (learner_id);
alter table public.parent_links enable row level security;
revoke all on public.parent_links from public, anon, authenticated;

create table if not exists public.parent_invites (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  learner_id uuid not null references public.profiles (id) on delete cascade,
  -- 'P' + 10 hex: can't be mistaken for a learner's invite code
  code text not null unique default ('P' || upper(encode(extensions.gen_random_bytes(5), 'hex'))),
  name text not null default '',
  revoked boolean not null default false,
  accepted_by uuid references public.profiles (id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.parent_invites enable row level security;
revoke all on public.parent_invites from public, anon, authenticated;

-- The tutor makes a parent code for one of their learners
create or replace function public.create_parent_invite(p_learner uuid, p_name text default null)
returns public.parent_invites language plpgsql security definer set search_path = public as $$
declare v public.parent_invites;
begin
  if not public.is_my_learner(p_learner) then raise exception 'Not your learner.'; end if;
  if not public._tutor_active() then raise exception 'Your account needs to be approved first.'; end if;
  if (select count(*) from public.parent_invites where learner_id = p_learner and accepted_by is null and not revoked) >= 5 then
    raise exception 'There are already 5 unused parent codes for this learner. Cancel one first.';
  end if;
  insert into public.parent_invites (tutor_id, learner_id, name) values (auth.uid(), p_learner, left(trim(coalesce(p_name, '')), 80))
  returning * into v;
  return v;
end $$;

create or replace function public.revoke_parent_invite(p_invite uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.parent_invites set revoked = true
   where id = p_invite and accepted_by is null
     and (tutor_id = auth.uid() or (learner_id = auth.uid() and (select self_learner from public.profiles where id = auth.uid())));
  if not found then raise exception 'Not found.'; end if;
end $$;

-- A parent joins with the code (a new account, or a parent account adding another child)
create or replace function public.accept_parent_invite(p_code text, p_name text default null, p_timezone text default 'UTC')
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  inv public.parent_invites;
  v public.profiles;
  l public.profiles;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into inv from public.parent_invites where code = upper(trim(p_code)) and not revoked for update;
  if inv.id is null then raise exception 'That parent code is not valid.'; end if;
  if inv.accepted_by is not null and inv.accepted_by <> auth.uid() then raise exception 'That parent code has already been used.'; end if;
  select * into v from public.profiles where id = auth.uid();
  if v.role is not null and v.role <> 'parent' then raise exception 'This account is already a % account. Use a different email for the parent account.', v.role; end if;
  select * into l from public.profiles where id = inv.learner_id and role = 'learner' and tutor_id = inv.tutor_id;
  if l.id is null or not public._tutor_active(inv.tutor_id) then raise exception 'This code can’t be used right now. Ask the tutor.'; end if;
  update public.profiles
     set role = 'parent', tutor_id = null, programme_id = null,
         display_name = coalesce(nullif(trim(p_name), ''), nullif(display_name, ''), nullif(inv.name, ''), 'Parent'),
         timezone = coalesce(p_timezone, timezone)
   where id = auth.uid() returning * into v;
  insert into public.parent_links (parent_id, learner_id, tutor_id) values (auth.uid(), inv.learner_id, inv.tutor_id)
  on conflict (parent_id, learner_id) do update set tutor_id = excluded.tutor_id;
  update public.parent_invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  if not l.self_learner then
    perform public.notify_user(inv.tutor_id, 'parent_joined', v.display_name || ' can now follow ' || l.display_name || '’s progress',
      'They joined as a parent. They see approved reports, lessons, due dates and marks you’ve given back.', jsonb_build_object('learner_id', l.id));
  end if;
  perform public.notify_user(l.id, 'parent_joined', v.display_name || ' can now see your progress',
    case when l.self_learner then 'They see your plan, how much you study, your marks and how each topic is going. Never your answers or messages. You can remove them in Settings.'
         else 'They see your weekly reports, lessons, due dates and marks once they’re given back. Never your messages or working. You can remove them in Settings.' end, '{}');
  return v;
end $$;

-- Who can see a learner's progress: for the learner themselves, or their tutor (with codes not used yet)
create or replace function public.learner_parents(p_learner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_l uuid := coalesce(p_learner, auth.uid());
  v_tutor boolean := public.is_my_learner(v_l);
begin
  if not v_tutor and not (v_l = auth.uid() and public.my_role() = 'learner') then raise exception 'Not your learner.'; end if;
  return jsonb_build_object(
    'parents', coalesce((select jsonb_agg(jsonb_build_object('id', pl.id, 'name', p.display_name, 'since', pl.created_at,
                                                             'email', case when v_tutor then p.email end) order by pl.created_at)
                           from public.parent_links pl join public.profiles p on p.id = pl.parent_id
                          where pl.learner_id = v_l and pl.tutor_id = (select tutor_id from public.profiles where id = v_l)), '[]'),
    'invites', case when v_tutor then coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'code', i.code, 'name', i.name, 'created_at', i.created_at) order by i.created_at)
                                                  from public.parent_invites i where i.learner_id = v_l and i.tutor_id = auth.uid()
                                                   and i.accepted_by is null and not i.revoked), '[]')
                    when v_l = auth.uid() and (select self_learner from public.profiles where id = v_l) then
                      coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'code', i.code, 'name', i.name, 'created_at', i.created_at) order by i.created_at)
                                  from public.parent_invites i where i.learner_id = v_l and i.accepted_by is null and not i.revoked), '[]') end);
end $$;

-- The learner or the tutor takes a parent off
create or replace function public.remove_parent(p_link uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pl public.parent_links;
begin
  delete from public.parent_links where id = p_link and (learner_id = auth.uid() or tutor_id = auth.uid()) returning * into pl;
  if pl.id is null then raise exception 'Not found.'; end if;
  perform public.notify_user(pl.parent_id, 'parent_removed', 'You no longer see ' || (select display_name from public.profiles where id = pl.learner_id) || '’s progress',
    'Ask their tutor for a new parent code if this is a mistake.', '{}');
end $$;

-- A parent's links that still count (the learner is still with that tutor)
create or replace function public._parent_link(p_learner uuid) returns public.parent_links
language sql stable security definer set search_path = public as $$
  select pl.* from public.parent_links pl join public.profiles l on l.id = pl.learner_id
   where pl.parent_id = auth.uid() and pl.learner_id = p_learner and l.role = 'learner' and l.tutor_id = pl.tutor_id
     and public.my_role() = 'parent'
$$;

-- The parent's children, with a line each
create or replace function public.parent_children() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.display_name, 'tutor', t.display_name, 'timezone', l.timezone,
      'next_lesson', (select min(s.starts_at) from public.sessions s where s.tutor_id = pl.tutor_id and l.id = any (s.learner_ids)
                       and not s.cancelled and s.starts_at > now()),
      'reports', (select count(*) from public.parent_reports r where r.learner_id = l.id and r.tutor_id = pl.tutor_id and r.status = 'sent'),
      'latest_report', (select max(r.week_start) from public.parent_reports r where r.learner_id = l.id and r.tutor_id = pl.tutor_id and r.status = 'sent'))
      order by l.display_name), '[]')
    from public.parent_links pl
    join public.profiles l on l.id = pl.learner_id and l.role = 'learner' and l.tutor_id = pl.tutor_id
    join public.profiles t on t.id = pl.tutor_id
   where pl.parent_id = auth.uid() and public.my_role() = 'parent'
$$;

-- Everything a parent sees about one child. Read-only, and only what the learner already sees as given back.
create or replace function public.parent_view(p_learner uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  pl public.parent_links;
  l public.profiles;
  r public.learner_reports;
begin
  pl := public._parent_link(p_learner);
  if pl.id is null then raise exception 'You can’t see this learner’s progress.'; end if;
  select * into l from public.profiles where id = p_learner;
  select * into r from public.learner_reports where learner_id = p_learner and tutor_id = pl.tutor_id;
  return jsonb_build_object(
    'learner', jsonb_build_object('id', l.id, 'name', l.display_name, 'timezone', l.timezone),
    'tutor', (select display_name from public.profiles where id = pl.tutor_id),
    'self', case when l.self_learner then jsonb_build_object(
        'exam_date', l.exam_date, 'exam_label', l.exam_label, 'setup_done', l.setup_done, 'hours', l.study_hours,
        'goal_min', l.study_goal_min, 'plan_start', l.plan_start,
        'week_seconds', (select coalesce(sum(a.seconds), 0) from public.activity a where a.learner_id = l.id and a.created_at > now() - interval '7 days'),
        'days_this_week', (select count(distinct a.day) from public.activity a where a.learner_id = l.id and a.created_at > now() - interval '7 days'),
        'practice_this_week', (select count(*) from public.attempts t join public.assignments a on a.id = t.assignment_id
                                where t.learner_id = l.id and a.source = 'self' and t.submitted_at > now() - interval '7 days'),
        'subjects', (select coalesce(jsonb_agg(s.name order by s.position), '[]') from public.learner_subjects ls join public.subjects s on s.id = ls.subject_id where ls.learner_id = l.id),
        'trial_until', l.trial_until, 'paid_until', l.paid_until, 'paid_plan', l.paid_plan,
        'set_up_by_me', l.consent_parent = auth.uid()) end,
    'exam', case when r.exam_date is not null and r.exam_date >= current_date
                 then jsonb_build_object('name', r.exam_name, 'date', r.exam_date, 'days', r.exam_date - current_date) end,
    'lessons', coalesce((select jsonb_agg(jsonb_build_object('title', s.title, 'starts_at', s.starts_at, 'duration_min', s.duration_min, 'weekly', s.series_id is not null) order by s.starts_at)
                           from (select * from public.sessions s where s.tutor_id = pl.tutor_id and p_learner = any (s.learner_ids) and not s.cancelled
                                   and s.starts_at > now() - interval '1 hour' and s.starts_at < now() + interval '21 days' order by s.starts_at limit 12) s), '[]'),
    'due', coalesce((select jsonb_agg(x order by x ->> 'due_at') from (
        select jsonb_build_object('title', a.title, 'kind', a.kind, 'due_at', a.due_at,
                 'handed_in', exists (select 1 from public.attempts t where t.assignment_id = a.id and t.learner_id = p_learner and t.submitted_at is not null)) as x
          from public.assignments a
         where a.tutor_id = pl.tutor_id and not a.practice and a.source <> 'self' and public._assignment_visible_to(a, p_learner)
           and a.due_at > now() - interval '7 days' and a.due_at < now() + interval '21 days'
         order by a.due_at limit 20) z), '[]'),
    'marks', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
        select jsonb_build_object('title', a.title, 'kind', a.kind, 'score', t.score, 'max', t.max_score,
                 'at', coalesce(t.released_at, t.submitted_at), 'late', a.due_at is not null and t.submitted_at > a.due_at) as x
          from public.attempts t join public.assignments a on a.id = t.assignment_id
         where t.learner_id = p_learner and t.tutor_id = pl.tutor_id and not a.practice and public._is_released(t) and t.score is not null
         order by coalesce(t.released_at, t.submitted_at) desc limit 15) z), '[]'),
    'topics', public._learner_topics(p_learner, true, pl.tutor_id),
    'mocks', coalesce((select jsonb_agg(z.r order by z.r ->> 'last_at') from (
        select jsonb_build_object('id', m.id, 'title', m.title) || (public._mock_result(m.id, p_learner, true) - 'papers') as r
          from public.mocks m where m.tutor_id = pl.tutor_id) z
       where (z.r ->> 'released')::boolean and z.r ->> 'pct' is not null), '[]'),
    'reports', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'week_start', x.week_start, 'data', x.data, 'comment', x.comment,
                                                             'next_week', x.next_week, 'sent_at', x.sent_at) order by x.week_start desc)
                           from (select * from public.parent_reports x where x.learner_id = p_learner and x.tutor_id = pl.tutor_id and x.status = 'sent'
                                  order by x.week_start desc limit 26) x), '[]'));
end $$;

-- A report the tutor approved is in the parent's account straight away: tell them
create or replace function public.on_report_sent() returns trigger
language plpgsql security definer set search_path = public as $$
declare p uuid;
begin
  if new.status = 'sent' and old.status is distinct from 'sent' then
    for p in select parent_id from public.parent_links where learner_id = new.learner_id and tutor_id = new.tutor_id loop
      perform public.notify_user(p, 'report', 'Weekly report: ' || coalesce(new.data ->> 'learner', ''),
        'From ' || coalesce(new.data ->> 'tutor', 'the tutor') || '. Open StudyBridge to read it.', jsonb_build_object('learner_id', new.learner_id, 'report_id', new.id));
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists parent_reports_sent on public.parent_reports;
create trigger parent_reports_sent after update of status on public.parent_reports for each row execute function public.on_report_sent();

-- How many parent accounts each of my learners has (for the Reports page)
create or replace function public.my_parent_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(learner_id, n), '{}') from (
    select pl.learner_id, count(*) n from public.parent_links pl join public.profiles l on l.id = pl.learner_id and l.tutor_id = pl.tutor_id
     where pl.tutor_id = auth.uid() group by pl.learner_id) z
$$;

-- Does one of my learners have a parent account linked? (for the rule below; the links table itself stays closed)
create or replace function public._has_parent(p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.parent_links where learner_id = p_learner and tutor_id = auth.uid())
$$;
-- A tutor can approve a report when the learner switched on sending, or a parent is linked
drop policy if exists parent_reports_tutor on public.parent_reports;
create policy parent_reports_tutor on public.parent_reports for all
  using (tutor_id = auth.uid())
  with check (tutor_id = auth.uid() and public.is_my_learner(learner_id)
              and (status = 'draft'
                   or exists (select 1 from public.learner_reports r where r.learner_id = parent_reports.learner_id and r.tutor_id = auth.uid() and r.enabled)
                   or public._has_parent(learner_id)));


-- =====================================================================
-- 1.6: exams that really lock. A locked-down test or exam has no way out but handing in: each try to leave
-- (switching window, a blocked shortcut, closing StudyBridge, coming back after forcing it shut) is a
-- strike; after the tutor's number of warnings the next one hands it in. Time running out hands it in on
-- the server, even with the app closed. Only the tutor can let a learner out early.
-- =====================================================================
create or replace function public.lockdown_strike(p_attempt uuid, p_event text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t public.attempts;
  a public.assignments;
begin
  select * into t from public.attempts where id = p_attempt and learner_id = auth.uid() for update;
  if t.id is null then raise exception 'Attempt not found.'; end if;
  if t.status <> 'in_progress' then return jsonb_build_object('handed_in', true); end if;
  select * into a from public.assignments where id = t.assignment_id;
  perform public.log_lockdown_event(p_attempt, p_event);
  if not a.lockdown then return jsonb_build_object('handed_in', false); end if;
  update public.attempts set strikes = strikes + 1 where id = t.id returning * into t;
  if t.strikes > a.leave_warnings then
    perform public._hand_in(t.id, 'tried to leave the ' || coalesce(a.kind, 'exam') || ' ' || t.strikes || ' time' || case when t.strikes = 1 then '' else 's' end);
    return jsonb_build_object('handed_in', true);
  end if;
  return jsonb_build_object('handed_in', false, 'warnings_left', a.leave_warnings - t.strikes);
end $$;

-- The tutor ends an exam early: hand it in now, or cancel the attempt so it can be started again later
create or replace function public.end_attempt(p_attempt uuid, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
declare
  t public.attempts;
  v_title text;
begin
  select * into t from public.attempts where id = p_attempt and tutor_id = auth.uid() for update;
  if t.id is null then raise exception 'Not found.'; end if;
  if t.status <> 'in_progress' then raise exception 'It’s already been handed in.'; end if;
  if p_mode = 'hand_in' then
    perform public._hand_in(t.id, 'your tutor ended it');
  elsif p_mode = 'cancel' then
    select title into v_title from public.assignments where id = t.assignment_id;
    delete from public.attempts where id = t.id;
    perform public.notify_user(t.learner_id, 'attempt_cancelled', 'Your tutor stopped ' || coalesce(v_title, 'the exam'),
      'Nothing was handed in. You can start it again when your tutor says so.', jsonb_build_object('assignment_id', t.assignment_id));
  else
    raise exception 'Choose hand in or cancel.';
  end if;
end $$;

-- Every minute: hand in anything whose time ran out (the learner may have closed the app)
create or replace function public._auto_hand_in() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in select x.id from public.attempts x
            where x.status = 'in_progress' and public._attempt_timed_out(x)
            for update skip locked loop
    perform public._hand_in(r.id, 'time ran out');
    n := n + 1;
  end loop;
  return n;
end $$;

-- =====================================================================
-- 1.6: teaching plans. From the subject's syllabus, a plan by week, by month or by chapter: which topics
-- when. Spread evenly by StudyBridge, or worked out by Prof (bigger topics get more time, revision before
-- the exam); the tutor checks and edits it. One plan per subject.
-- =====================================================================
create table if not exists public.teaching_plans (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  subject_id uuid not null unique references public.subjects (id) on delete cascade,
  kind text not null default 'week' check (kind in ('week', 'month', 'chapter')),
  starts_on date,
  ends_on date,
  lessons_per_week int,
  items jsonb not null default '[]',   -- [{ label, starts_on, ends_on, topics: [names], focus, notes }]
  note text,
  source text not null default 'tutor' check (source in ('tutor', 'prof')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.teaching_plans enable row level security;
revoke all on public.teaching_plans from public, anon, authenticated;
grant select, insert, update, delete on public.teaching_plans to authenticated;
drop policy if exists plans_tutor on public.teaching_plans;
create policy plans_tutor on public.teaching_plans for all using (tutor_id = auth.uid())
  with check (tutor_id = auth.uid() and exists (select 1 from public.subjects s where s.id = subject_id and s.tutor_id = auth.uid()));

create or replace function public.prof_plan(p_subject uuid, p_kind text, p_start date, p_end date, p_lessons int default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text;
  v_id uuid;
  s public.subjects;
  v_topics jsonb;
begin
  v_err := public._prof_ready(auth.uid());
  if v_err is not null then raise exception '%', v_err; end if;
  select * into s from public.subjects where id = p_subject and tutor_id = auth.uid();
  if s.id is null then raise exception 'Unknown subject.'; end if;
  if p_kind not in ('week', 'month', 'chapter') then raise exception 'Choose week by week, month by month or chapter by chapter.'; end if;
  if p_start is null or p_end is null or p_end <= p_start then raise exception 'Choose a start date and an end date after it.'; end if;
  if p_end > p_start + 800 then raise exception 'Plans can cover up to about two years.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'details', details) order by position, name), '[]') into v_topics
    from public.topics where subject_id = s.id;
  if jsonb_array_length(v_topics) = 0 then raise exception 'Set out the syllabus first: the plan is made from its topics.'; end if;
  insert into public.prof_jobs (tutor_id, kind, prompt, context)
  values (auth.uid(), 'plan', format('Plan %s %s', s.name, case p_kind when 'week' then 'week by week' when 'month' then 'month by month' else 'chapter by chapter' end),
          jsonb_build_object('subject_id', s.id, 'subject', s.name, 'exam', s.exam, 'kind', p_kind, 'start', p_start, 'end', p_end,
                             'lessons_per_week', p_lessons, 'note', left(coalesce(p_note, ''), 1000), 'topics', v_topics))
  returning id into v_id;
  perform public._prof_kick();
  return jsonb_build_object('id', v_id);
end $$;

-- =====================================================================
-- 1.6 part 5: selling basics. Plans (Free 1 learner, Starter 5, Pro 25) with limits the admin switches on
-- when StudyBridge starts charging; payments through Stripe once the admin adds its keys; emails through
-- Resend once there's a domain; Google sign-in once it's set up in Supabase. Everyone can download their
-- data and delete their own account.
-- =====================================================================
alter table public.app_config add column if not exists enforce_plans boolean not null default false;
alter table public.app_config add column if not exists google_on boolean not null default false;
alter table public.app_config add column if not exists email_from text;
alter table public.app_config add column if not exists stripe_prices jsonb not null default '{}';  -- {"starter_month": "price_…", …}
alter table public.platform_secrets add column if not exists stripe_secret text;
alter table public.platform_secrets add column if not exists stripe_webhook_secret text;
alter table public.platform_secrets add column if not exists resend_key text;
alter table public.profiles add column if not exists stripe_customer text;
alter table public.profiles add column if not exists plan_period text;
alter table public.profiles add column if not exists plan_renews_at timestamptz;

-- How many learners a plan has room for
create or replace function public._plan_learners(p_plan text) returns int
language sql immutable as $$
  select case coalesce(p_plan, 'free') when 'free' then 1 when 'starter' then 5 when 'pro' then 25 when 'complimentary' then 25 else 1 end
$$;

-- How many learners this tutor has room for: their plan, a Custom plan's own number, or a Complimentary plan
-- (Pro-sized) until its end date, then Free
create or replace function public._tutor_limit(p_tutor uuid) returns int
language sql stable security definer set search_path = public as $$
  select case p.plan
    when 'custom' then greatest(coalesce(p.plan_learners, 1), 1)
    when 'complimentary' then case when p.plan_until is null or p.plan_until >= current_date then 25 else 1 end
    else public._plan_learners(p.plan) end
  from public.profiles p where p.id = p_tutor
$$;

-- What the app may know about how StudyBridge is set up (no secrets); also before signing in
create or replace function public.public_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'enforce_plans', c.enforce_plans,
    'google_on', c.google_on,
    'payments_on', s.stripe_secret is not null and c.stripe_prices <> '{}'::jsonb,
    'email_on', s.resend_key is not null and c.email_from is not null)
    from public.app_config c, public.platform_secrets s where c.id = 1 and s.id = 1
$$;
grant execute on function public.public_settings() to anon;

-- The tutor's plan and how full it is
create or replace function public.my_plan() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('plan', p.plan, 'period', p.plan_period, 'renews_at', p.plan_renews_at,
    'learners', (select count(*) from public.profiles l where l.tutor_id = p.id and l.role = 'learner'),
    'limit', public._tutor_limit(p.id), 'until', p.plan_until,
    'enforced', (select enforce_plans from public.app_config where id = 1),
    'has_billing', p.stripe_customer is not null)
    from public.profiles p where p.id = auth.uid() and p.role = 'tutor'
$$;

-- A learner joining a full plan is stopped (only once the admin switches limits on)
create or replace function public._check_plan_room() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if new.role = 'learner' and new.tutor_id is not null and new.tutor_id is distinct from old.tutor_id
     and (select enforce_plans from public.app_config where id = 1) then
    select count(*) into v_n from public.profiles where tutor_id = new.tutor_id and role = 'learner' and id <> new.id;
    if v_n >= public._tutor_limit(new.tutor_id) then
      raise exception 'Your tutor’s StudyBridge plan is full. Ask them to upgrade, then use the invite again.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_plan_room on public.profiles;
create trigger profiles_plan_room before update of tutor_id, role on public.profiles for each row execute function public._check_plan_room();

-- Admin: payments, email, Google sign-in and plan limits. Keys are write-only.
create or replace function public.admin_set_selling(p_enforce boolean default null, p_google boolean default null, p_email_from text default null,
  p_resend_key text default null, p_stripe_secret text default null, p_stripe_webhook text default null, p_prices jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  update public.app_config set
    enforce_plans = coalesce(p_enforce, enforce_plans),
    google_on = coalesce(p_google, google_on),
    email_from = case when p_email_from is null then email_from else nullif(trim(p_email_from), '') end,
    stripe_prices = coalesce(p_prices, stripe_prices)
   where id = 1;
  update public.platform_secrets set
    resend_key = coalesce(nullif(trim(p_resend_key), ''), resend_key),
    stripe_secret = coalesce(nullif(trim(p_stripe_secret), ''), stripe_secret),
    stripe_webhook_secret = coalesce(nullif(trim(p_stripe_webhook), ''), stripe_webhook_secret)
   where id = 1;
  perform public._admin_log('settings', null, jsonb_build_object('selling', true));
end $$;
create or replace function public.admin_selling() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return (select jsonb_build_object('enforce_plans', c.enforce_plans, 'google_on', c.google_on, 'email_from', c.email_from,
      'resend_set', s.resend_key is not null, 'stripe_set', s.stripe_secret is not null, 'webhook_set', s.stripe_webhook_secret is not null,
      'prices', c.stripe_prices,
      'plans', (select jsonb_object_agg(coalesce(plan, 'free'), n) from (select plan, count(*) n from public.profiles where role = 'tutor' group by plan) z))
    from public.app_config c, public.platform_secrets s where c.id = 1 and s.id = 1);
end $$;

-- The Prof server (service role) records a Stripe payment or cancellation
create or replace function public._set_paid_plan(p_tutor uuid, p_plan text, p_period text, p_customer text, p_renews timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set plan = coalesce(nullif(p_plan, ''), 'free'), plan_period = p_period,
         stripe_customer = coalesce(p_customer, stripe_customer), plan_renews_at = p_renews
   where id = p_tutor and role = 'tutor';
  if found then
    perform public.notify_user(p_tutor, 'plan', case when coalesce(p_plan, 'free') = 'free' then 'You’re on the Free plan' else 'You’re on the ' || initcap(p_plan) || ' plan' end,
      case when coalesce(p_plan, 'free') = 'free' then 'Your paid plan has ended.' else 'Thank you! Your plan is active.' end, '{}');
  end if;
end $$;

-- Everything that's yours, to download (Settings → Download my data). Tutors get everything they run;
-- learners get their own work (marks only once given back); parents get their account and links.
create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me public.profiles;
  v jsonb;
  t text;
  rows jsonb;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then raise exception 'Not signed in.'; end if;
  v := jsonb_build_object('exported_at', now(), 'account',
         jsonb_build_object('name', me.display_name, 'email', me.email, 'role', me.role, 'timezone', me.timezone, 'plan', me.plan, 'created_at', me.created_at));
  if me.role = 'tutor' then
    foreach t in array array['programmes', 'subjects', 'topics', 'invites', 'files', 'lessons', 'assignments', 'questions', 'question_keys',
                             'attempts', 'responses', 'comments', 'sessions', 'lesson_series', 'parent_reports', 'learner_reports', 'cards',
                             'mocks', 'grade_boundaries', 'teaching_plans', 'taught_topics', 'parent_invites', 'activity', 'classes'] loop
      if to_regclass('public.' || t) is not null then
        execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.%I x where x.tutor_id = $1', t) into rows using me.id;
        v := v || jsonb_build_object(t, rows);
      end if;
    end loop;
    v := v || jsonb_build_object(
      'learners', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.display_name, 'email', l.email, 'timezone', l.timezone, 'joined', l.created_at,
                     'subjects', (select coalesce(jsonb_agg(ls.subject_id), '[]') from public.learner_subjects ls where ls.learner_id = l.id))), '[]')
                     from public.profiles l where l.tutor_id = me.id and l.role = 'learner'),
      'question_bank', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from public.bank_questions b where b.owner_id = me.id));
    if to_regclass('public.class_members') is not null then
      execute 'select coalesce(jsonb_agg(to_jsonb(m)), ''[]'') from public.class_members m join public.classes c on c.id = m.class_id where c.tutor_id = $1'
        into rows using me.id;
      v := v || jsonb_build_object('class_members', rows);
    end if;
  elsif me.role = 'learner' then
    v := v || jsonb_build_object(
      'tutor', (select display_name from public.profiles where id = me.tutor_id),
      'work', (select coalesce(jsonb_agg(jsonb_build_object(
                  'assignment', a.title, 'kind', a.kind, 'started_at', x.started_at, 'submitted_at', x.submitted_at, 'status', x.status,
                  'score', case when public._is_released(x) then x.score end, 'max', x.max_score,
                  'feedback', case when public._is_released(x) then x.feedback_md end,
                  'answers', (select coalesce(jsonb_agg(jsonb_build_object('question', q.prompt_md, 'answer', r.answer,
                                 'marks', case when public._is_released(x) then r.marks end,
                                 'feedback', case when public._is_released(x) then r.feedback_md end) order by q.position), '[]')
                                from public.responses r join public.questions q on q.id = r.question_id where r.attempt_id = x.id)) order by x.started_at), '[]')
                 from public.attempts x join public.assignments a on a.id = x.assignment_id where x.learner_id = me.id),
      'messages', (select coalesce(jsonb_agg(jsonb_build_object('at', c.created_at, 'from_me', c.author_id = me.id, 'text', c.body) order by c.created_at), '[]')
                     from public.comments c where c.learner_id = me.id),
      'time_studied', (select coalesce(jsonb_agg(to_jsonb(x) - 'tutor_id'), '[]') from public.activity x where x.learner_id = me.id),
      'flashcard_reviews', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.card_reviews x where x.learner_id = me.id),
      'my_flashcards', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.cards x where x.learner_id = me.id and x.source in ('own', 'mistake')),
      'study_notes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.study_notes x where x.learner_id = me.id),
      'weekly_reports', (select coalesce(jsonb_agg(jsonb_build_object('week', x.week_start, 'report', x.data, 'comment', x.comment)), '[]')
                           from public.parent_reports x where x.learner_id = me.id and x.status = 'sent'),
      'parent_report_settings', (select to_jsonb(x) from public.learner_reports x where x.learner_id = me.id));
  elsif me.role = 'parent' then
    v := v || jsonb_build_object('children', public.parent_children());
  end if;
  return v;
end $$;

-- Delete my own account. A tutor's learners are released (they can join another tutor with a new invite)
-- and everything the tutor ran goes with the account; a learner's own work goes with theirs.
create or replace function public.delete_my_account(p_confirm text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.profiles;
  l uuid;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then raise exception 'Not signed in.'; end if;
  if upper(trim(coalesce(p_confirm, ''))) <> 'DELETE' then raise exception 'Type DELETE to confirm.'; end if;
  if exists (select 1 from public.platform_admins where user_id = me.id) then raise exception 'The StudyBridge admin account can’t be deleted here.'; end if;
  if me.role = 'tutor' then
    for l in select id from public.profiles where tutor_id = me.id and role = 'learner' loop
      perform public.notify_user(l, 'tutor_left', 'Your tutor closed their StudyBridge account',
        'Your work with them was deleted. You can join another tutor with a new invite.', '{}');
    end loop;
    delete from public.learner_subjects where tutor_id = me.id;
    update public.profiles set role = null, tutor_id = null, programme_id = null where tutor_id = me.id and role = 'learner';
  elsif me.role = 'learner' and me.tutor_id is not null then
    perform public.notify_user(me.tutor_id, 'learner_left', coalesce(me.display_name, 'A learner') || ' deleted their account',
      'Their work and marks were deleted with it.', '{}');
  end if;
  delete from public.invites where accepted_by = me.id;
  delete from auth.users where id = me.id;
end $$;

-- 2.0: the early-access list from the website (students on their own, parents, tutors, centres, schools).
-- Anyone can join from the website without an account; only the Owner (admin) can read it.
create table if not exists public.early_access (
  email text primary key,
  role text not null default 'student' check (role in ('student', 'parent', 'tutor', 'centre', 'school')),
  curriculum text,
  subjects text,
  exam text,
  country text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.early_access enable row level security;

-- Emails to StudyBridge's own inboxes: hello@ (the website: contact, early access, subject requests) and support@
-- (the app: "Contact StudyBridge"). Prof sends them through Resend once email is set up in Admin → Selling; until
-- then they wait here, and everything is in Admin anyway.
alter table public.app_config add column if not exists contact_email text not null default 'hello@gostudybridge.com';
alter table public.app_config add column if not exists support_email text not null default 'support@gostudybridge.com';
create table if not exists public.outgoing_emails (
  id uuid primary key default gen_random_uuid(),
  to_addr text not null,
  subject text not null,
  body text not null,
  reply_to text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  tries int not null default 0,
  error text
);
alter table public.outgoing_emails enable row level security;
revoke all on public.outgoing_emails from anon, authenticated;

create or replace function public._email_us(p_box text, p_subject text, p_body text, p_reply_to text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_to text;
begin
  select case when p_box = 'support' then support_email else contact_email end into v_to from public.app_config where id = 1;
  if coalesce(v_to, '') = '' then return; end if;
  insert into public.outgoing_emails (to_addr, subject, body, reply_to)
  values (v_to, left(p_subject, 200), left(p_body, 8000), nullif(btrim(coalesce(p_reply_to, '')), ''));
  perform public._prof_kick();
end $$;

-- The website's Contact page: anyone can write (no account); the Owner reads them in Admin → Selling and by email
create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text not null,
  role text,
  message text not null,
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
alter table public.contact_messages enable row level security;
revoke all on public.contact_messages from anon, authenticated;

create or replace function public.send_contact(p_name text, p_email text, p_role text default null, p_message text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := left(nullif(btrim(coalesce(p_name, '')), ''), 120);
  v_msg text := btrim(coalesce(p_message, ''));
begin
  if length(v_email) > 200 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then raise exception 'Please check your email address.'; end if;
  if length(v_msg) < 2 then raise exception 'Please write a message.'; end if;
  if length(v_msg) > 4000 then raise exception 'That message is too long. Please keep it under 4,000 characters.'; end if;
  if (select count(*) from public.contact_messages where email = v_email and created_at > now() - interval '1 day') >= 5 then
    raise exception 'That’s a lot of messages today. Please try again tomorrow.';
  end if;
  insert into public.contact_messages (name, email, role, message) values (v_name, v_email, left(nullif(btrim(coalesce(p_role, '')), ''), 40), v_msg);
  perform public._email_us('hello', 'Website message from ' || coalesce(v_name, v_email),
    'From: ' || coalesce(v_name || ' ', '') || '<' || v_email || '>' || E'\n' || 'I am: ' || coalesce(nullif(btrim(coalesce(p_role, '')), ''), 'not said')
      || E'\n\n' || v_msg || E'\n\n(Reply to this email to answer them.)', v_email);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.send_contact(text, text, text, text) to anon;

create or replace function public.admin_contact_messages() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return coalesce((select jsonb_agg(to_jsonb(m) order by (m.handled_at is null) desc, m.created_at desc)
    from (select * from public.contact_messages order by created_at desc limit 300) m), '[]'::jsonb);
end $$;

create or replace function public.admin_contact_done(p_id uuid, p_done boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  update public.contact_messages set handled_at = case when p_done then now() end where id = p_id;
end $$;

-- What the admin can see about the email queue (never the content of other people's mail beyond what Admin shows)
create or replace function public.admin_email_queue() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return jsonb_build_object(
    'waiting', (select count(*) from public.outgoing_emails where sent_at is null and tries < 5),
    'failed', (select count(*) from public.outgoing_emails where sent_at is null and tries >= 5),
    'sent_week', (select count(*) from public.outgoing_emails where sent_at > now() - interval '7 days'),
    'last_error', (select error from public.outgoing_emails where error is not null order by created_at desc limit 1),
    'contact_email', (select contact_email from public.app_config where id = 1),
    'support_email', (select support_email from public.app_config where id = 1));
end $$;

create or replace function public.join_early_access(p_email text, p_role text default 'student', p_curriculum text default null,
  p_subjects text default null, p_exam text default null, p_country text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if length(v_email) > 200 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then
    raise exception 'Please check your email address.';
  end if;
  if coalesce(p_role, 'student') not in ('student', 'parent', 'tutor', 'centre', 'school') then
    raise exception 'Please choose who you are.';
  end if;
  insert into public.early_access (email, role, curriculum, subjects, exam, country, note)
  values (v_email, coalesce(p_role, 'student'), left(nullif(btrim(p_curriculum), ''), 80), left(nullif(btrim(p_subjects), ''), 400),
          left(nullif(btrim(p_exam), ''), 80), left(nullif(btrim(p_country), ''), 80), left(nullif(btrim(p_note), ''), 600))
  on conflict (email) do update set role = excluded.role,
    curriculum = coalesce(excluded.curriculum, early_access.curriculum), subjects = coalesce(excluded.subjects, early_access.subjects),
    exam = coalesce(excluded.exam, early_access.exam), country = coalesce(excluded.country, early_access.country),
    note = coalesce(excluded.note, early_access.note), updated_at = now();
  perform public._email_us('hello',
    case when coalesce(p_note, '') ilike 'subject request:%' then 'Subject request: ' || left(btrim(substr(p_note, 17)), 120)
         else 'Early access: ' || v_email || ' (' || coalesce(p_role, 'student') || ')' end,
    concat_ws(E'\n', 'Email: ' || v_email, 'I am: ' || coalesce(p_role, 'student'),
      case when nullif(btrim(coalesce(p_curriculum, '')), '') is not null then 'Curriculum: ' || btrim(p_curriculum) end,
      case when nullif(btrim(coalesce(p_subjects, '')), '') is not null then 'Subjects: ' || btrim(p_subjects) end,
      case when nullif(btrim(coalesce(p_exam, '')), '') is not null then 'Exam: ' || btrim(p_exam) end,
      case when nullif(btrim(coalesce(p_country, '')), '') is not null then 'Country: ' || btrim(p_country) end,
      case when nullif(btrim(coalesce(p_note, '')), '') is not null then E'\n' || btrim(p_note) end,
      E'\n(Everyone who asks is listed in Admin → Selling → Early access.)'), v_email);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.join_early_access(text, text, text, text, text, text, text) to anon;

create or replace function public.admin_early_access() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from public.early_access e), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- Self-learners (launch 1, part 1): students on their own
-- ---------------------------------------------------------------------
-- One tutor account holds StudyBridge's own content; the Owner picks it in Admin → Students. Its subjects are the
-- catalogue (every board, level and subject on the website), each opened to students when its content is ready.
-- A self-learner is a learner whose "tutor" is that account, so everything learners already have works for them.
alter table public.profiles add column if not exists is_studybridge boolean not null default false;
create unique index if not exists one_studybridge_account on public.profiles (is_studybridge) where is_studybridge;
alter table public.subjects add column if not exists catalogue text;   -- e.g. 'cambridge:igcse:0607'
alter table public.subjects add column if not exists board text;       -- 'Cambridge'
alter table public.subjects add column if not exists level text;       -- 'IGCSE'
alter table public.subjects add column if not exists code text;        -- '0607'
alter table public.subjects add column if not exists live boolean not null default false; -- students can choose it
create unique index if not exists subjects_catalogue on public.subjects (tutor_id, catalogue) where catalogue is not null;
alter table public.profiles add column if not exists self_learner boolean not null default false;
alter table public.profiles add column if not exists grade int;            -- 6–12, 13 = finished school
alter table public.profiles add column if not exists country text;
alter table public.profiles add column if not exists trial_until timestamptz;
alter table public.profiles add column if not exists paid_until date;      -- set by the Owner when they've paid
alter table public.profiles add column if not exists paid_plan text;       -- 'monthly' or 'pass'
alter table public.profiles add column if not exists exam_date date;
alter table public.profiles add column if not exists exam_label text;      -- 'Cambridge May/June 2027'
alter table public.profiles add column if not exists study_board text;
alter table public.profiles add column if not exists study_level text;
alter table public.profiles add column if not exists study_hours int;      -- hours a week
alter table public.profiles add column if not exists plan_start date;
alter table public.profiles add column if not exists setup_done boolean not null default false;
do $$ begin
  alter table public.profiles add constraint profiles_paid_plan_check check (paid_plan is null or paid_plan in ('monthly', 'pass'));
exception when duplicate_object then null; end $$;
alter table public.app_config add column if not exists students_open boolean not null default false;  -- no longer used (10 Oct 2026)
-- Students can sign up as soon as a subject is open to them; the Owner can pause new sign-ups (Admin → Students)
alter table public.app_config add column if not exists students_paused boolean not null default false;

create or replace function public._studybridge_account() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.profiles where is_studybridge and role = 'tutor' limit 1
$$;

-- The content account never runs out of room for students
create or replace function public._tutor_limit(p_tutor uuid) returns int
language sql stable security definer set search_path = public as $$
  select case when p.is_studybridge then 1000000 else case p.plan
    when 'custom' then greatest(coalesce(p.plan_learners, 1), 1)
    when 'complimentary' then case when p.plan_until is null or p.plan_until >= current_date then 25 else 1 end
    else public._plan_learners(p.plan) end end
  from public.profiles p where p.id = p_tutor
$$;

-- What the app may know before signing in: now also whether students can sign up on their own
create or replace function public.public_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'enforce_plans', c.enforce_plans,
    'google_on', c.google_on,
    'payments_on', s.stripe_secret is not null and c.stripe_prices <> '{}'::jsonb,
    'email_on', s.resend_key is not null and c.email_from is not null,
    'students_open', not c.students_paused and public._studybridge_account() is not null
                     and exists (select 1 from public.subjects s where s.tutor_id = public._studybridge_account() and s.live))
    from public.app_config c, public.platform_secrets s where c.id = 1 and s.id = 1
$$;
grant execute on function public.public_settings() to anon;

-- The Owner picks the tutor account (signed up for this) that holds StudyBridge's own content
create or replace function public.admin_set_content_account(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  perform public._admin();
  select * into v from public.profiles where lower(email) = lower(trim(coalesce(p_email, '')));
  if v.id is null then raise exception 'No account with that email. Sign up a tutor account for StudyBridge’s content first.'; end if;
  if v.role is distinct from 'tutor' then raise exception 'That isn’t a tutor account. Sign up a new tutor account for StudyBridge’s content.'; end if;
  if exists (select 1 from public.profiles where tutor_id = v.id and role = 'learner' and not self_learner) then
    raise exception 'That tutor already teaches their own learners. Use a separate account for StudyBridge’s content.';
  end if;
  update public.profiles set is_studybridge = false where is_studybridge and id <> v.id;
  update public.profiles set is_studybridge = true, status = 'active' where id = v.id;
  perform public._admin_log('content_account', v.id, jsonb_build_object('email', v.email));
  return jsonb_build_object('id', v.id, 'email', v.email, 'name', v.display_name);
end $$;

-- Every subject from the catalogue (the app sends the website's list) goes into the content account, switched off
create or replace function public.admin_seed_catalogue(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c uuid := public._studybridge_account();
  i jsonb;
  n int := 0;
  pos int;
begin
  perform public._admin();
  if c is null then raise exception 'Choose the StudyBridge content account first.'; end if;
  select coalesce(max(position), 0) into pos from public.subjects where tutor_id = c;
  for i in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when coalesce(i ->> 'key', '') = '' or coalesce(i ->> 'name', '') = '';
    if not exists (select 1 from public.subjects where tutor_id = c and catalogue = i ->> 'key') then
      pos := pos + 1;
      insert into public.subjects (tutor_id, name, catalogue, board, level, code, exam, position)
      values (c, left(i ->> 'name', 200), left(i ->> 'key', 120), left(i ->> 'board', 60), left(i ->> 'level', 60),
              nullif(left(coalesce(i ->> 'code', ''), 20), ''),
              case when coalesce(i ->> 'exam', '') ~ '^(cie|ib):[a-z0-9-]{2,40}$' then i ->> 'exam' end, pos);
      n := n + 1;
    end if;
  end loop;
  return jsonb_build_object('added', n, 'total', (select count(*) from public.subjects where tutor_id = c and catalogue is not null));
end $$;

-- On: students can sign up whenever a subject is open to them. Off: new sign-ups are paused.
create or replace function public.admin_students_open(p_open boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  if p_open and public._studybridge_account() is null then raise exception 'Choose the StudyBridge content account first.'; end if;
  update public.app_config set students_paused = not coalesce(p_open, false) where id = 1;
end $$;

-- Launch 1, part 3: test students the Owner signs up (Admin → Students), a parent's consent below grade 8, and the
-- codes a parent's account makes for a child studying on their own (8 digits; the child signs up with it)
alter table public.profiles add column if not exists test_student boolean not null default false;
alter table public.profiles add column if not exists consent_parent uuid references public.profiles (id) on delete set null;
alter table public.profiles add column if not exists consent_at timestamptz;
alter table public.app_config add column if not exists test_emails text[] not null default '{}';
create table if not exists public.child_codes (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles (id) on delete cascade,
  code text not null unique,
  name text not null default '',
  grade int,
  used_by uuid references public.profiles (id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.child_codes enable row level security;
revoke all on public.child_codes from public, anon, authenticated;

-- A new account becomes a student studying on their own, with a 7-day free trial. Below grade 8 a parent sets it up:
-- the child signs up with the code from the parent's account (the parent's consent is kept with the account).
-- The Owner's test students (Admin → Students) can sign up while sign-up is closed and never need to pay.
drop function if exists public.start_self_learner(text, int, text, text);
create or replace function public.start_self_learner(p_name text, p_grade int, p_country text, p_timezone text default 'UTC',
  p_parent_code text default null)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  c uuid := public._studybridge_account();
  k public.child_codes;
  v_test boolean;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into v from public.profiles where id = auth.uid();
  if v.role is not null then
    if v.self_learner then return v; end if;
    raise exception 'This account is already set up for something else. Use a new email for your student account.';
  end if;
  v_test := lower(coalesce(v.email, '')) = any (coalesce((select test_emails from public.app_config where id = 1), '{}'));
  if c is null or (not v_test and ((select students_paused from public.app_config where id = 1)
     or not exists (select 1 from public.subjects where tutor_id = c and live))) then
    raise exception 'Student sign-up isn’t open right now. Please try again later.';
  end if;
  if nullif(regexp_replace(coalesce(p_parent_code, ''), '\D', '', 'g'), '') is not null then
    -- wrong codes are counted like tutors' invite codes (an error would undo the count): 10 in an hour and it waits
    if (select count(*) from public.invite_tries where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
      raise exception 'Too many wrong codes. Wait an hour, then try again.';
    end if;
    select * into k from public.child_codes where code = regexp_replace(p_parent_code, '\D', '', 'g') for update;
    if k.id is null or (k.used_by is not null and k.used_by <> auth.uid()) then
      insert into public.invite_tries (user_id) values (auth.uid());
      return null;
    end if;
  end if;
  if p_grade is null or (p_grade < 8 and k.id is null) then
    raise exception 'Below grade 8, a parent sets up your account with you. Ask them to open StudyBridge, choose “I’m a parent”, and give you the code it makes.';
  end if;
  -- where the law asks for a parent's consent under 18 (India), any student still at school needs the code too
  if lower(trim(coalesce(p_country, ''))) in ('india', 'bharat', 'in') and p_grade < 13 and k.id is null then
    raise exception 'In India, a parent sets up the account for students under 18. Ask them to open StudyBridge, choose “I’m a parent”, and give you the code it makes.';
  end if;
  update public.profiles
     set role = 'learner', tutor_id = c, self_learner = true, test_student = v_test,
         display_name = coalesce(nullif(trim(coalesce(p_name, '')), ''), display_name),
         timezone = coalesce(nullif(p_timezone, ''), timezone),
         grade = least(coalesce(k.grade, p_grade), 13), country = nullif(left(trim(coalesce(p_country, '')), 60), ''),
         trial_until = now() + interval '7 days',
         consent_parent = k.parent_id, consent_at = case when k.id is not null then now() end
   where id = auth.uid() returning * into v;
  if k.id is not null then
    update public.child_codes set used_by = auth.uid(), used_at = now() where id = k.id;
    insert into public.parent_links (parent_id, learner_id, tutor_id) values (k.parent_id, auth.uid(), c)
    on conflict (parent_id, learner_id) do update set tutor_id = excluded.tutor_id;
    perform public.notify_user(k.parent_id, 'parent_joined', coalesce(v.display_name, 'Your child') || ' has set up their StudyBridge account',
      'You can follow their plan and progress in StudyBridge. Their free week has started.', jsonb_build_object('learner_id', v.id));
  end if;
  perform public._email_welcome(v.id);
  return v;
end $$;

-- The guided setup: subjects (only ones open to students), when the exams are, and hours a week
create or replace function public.self_setup(p_board text, p_level text, p_subjects uuid[], p_exam_date date, p_exam_label text, p_hours int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v public.profiles;
  c uuid := public._studybridge_account();
  n int;
  h int := greatest(1, least(coalesce(p_hours, 4), 40));
begin
  select * into v from public.profiles where id = auth.uid();
  if v.id is null or not v.self_learner then raise exception 'This is for students studying on their own.'; end if;
  select count(*) into n from public.subjects where id = any(coalesce(p_subjects, '{}')) and tutor_id = c and (live or v.test_student);
  if n = 0 then raise exception 'Pick at least one subject.'; end if;
  if n <> (select count(distinct s) from unnest(p_subjects) s) then raise exception 'One of those subjects isn’t open yet.'; end if;
  if p_exam_date is null or p_exam_date <= current_date then raise exception 'Pick when your exams are.'; end if;
  delete from public.learner_subjects where learner_id = auth.uid();
  insert into public.learner_subjects (learner_id, subject_id, tutor_id)
    select distinct auth.uid(), s, c from unnest(p_subjects) s;
  update public.profiles
     set study_board = left(p_board, 60), study_level = left(p_level, 60), exam_date = p_exam_date,
         exam_label = nullif(left(coalesce(p_exam_label, ''), 80), ''), study_hours = h,
         study_goal_min = greatest(10, least(240, round(h * 60.0 / 7)::int)),
         plan_start = current_date, setup_done = true
   where id = auth.uid();
  return jsonb_build_object('subjects', n);
end $$;

-- Admin → Students: the content account, the catalogue, and every student with their trial or payment
create or replace function public.admin_students() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return jsonb_build_object(
    'open', not (select students_paused from public.app_config where id = 1),
    'test_emails', (select to_jsonb(test_emails) from public.app_config where id = 1),
    'pay_links', (select jsonb_build_object('monthly', pay_link_monthly, 'pass', pay_link_pass) from public.app_config where id = 1),
    'content', (select jsonb_build_object('id', p.id, 'email', p.email, 'name', p.display_name,
                  'subjects', (select count(*) from public.subjects s where s.tutor_id = p.id and s.catalogue is not null),
                  'live', (select count(*) from public.subjects s where s.tutor_id = p.id and s.live))
                from public.profiles p where p.is_studybridge and p.role = 'tutor' limit 1),
    'students', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.display_name, 'email', p.email, 'grade', p.grade, 'country', p.country,
        'joined', p.created_at, 'trial_until', p.trial_until, 'paid_until', p.paid_until, 'paid_plan', p.paid_plan,
        'exam_date', p.exam_date, 'exam_label', p.exam_label, 'setup_done', p.setup_done, 'last_seen_at', p.last_seen_at,
        'test', p.test_student, 'parent_set_up', p.consent_parent is not null,
        'parents', (select count(*) from public.parent_links pl where pl.learner_id = p.id),
        'subjects', (select coalesce(jsonb_agg(s.name order by s.position), '[]'::jsonb)
                       from public.learner_subjects ls join public.subjects s on s.id = ls.subject_id where ls.learner_id = p.id))
      order by p.created_at desc) from public.profiles p where p.self_learner and not p.demo), '[]'::jsonb));
end $$;

-- The Owner records a payment taken by hand (monthly, or an exam pass), or takes it away
create or replace function public.admin_set_student_paid(p_user uuid, p_plan text, p_until date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  if p_plan is not null and p_plan not in ('monthly', 'pass') then raise exception 'Choose monthly or an exam pass.'; end if;
  if p_plan is not null and (p_until is null or p_until < current_date) then raise exception 'Pick the day they’ve paid until.'; end if;
  update public.profiles set paid_plan = p_plan, paid_until = case when p_plan is null then null else p_until end
   where id = p_user and self_learner;
  if not found then raise exception 'That isn’t a student account.'; end if;
  perform public._admin_log(case when p_plan is null then 'student_unpaid' else 'student_paid' end, p_user,
    jsonb_build_object('plan', p_plan, 'until', p_until));
  if p_plan is not null then perform public._email_all_set(p_user); end if;
end $$;

create or replace function public.admin_extend_trial(p_user uuid, p_days int default 7) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  update public.profiles
     set trial_until = greatest(coalesce(trial_until, now()), now()) + make_interval(days => greatest(1, least(coalesce(p_days, 7), 60))),
         trial_reminded = false
   where id = p_user and self_learner;
  if not found then raise exception 'That isn’t a student account.'; end if;
  perform public._admin_log('student_trial', p_user, jsonb_build_object('days', p_days));
end $$;

-- Emails to students on their own, and to the parents who follow them (19 Oct 2026): welcome, "your free week ends
-- in 2 days" and "you're all set". They go in the email queue (outgoing_emails) and Prof sends them through Resend
-- once email is set up in Admin → Selling, from StudyBridge's address; replies go to support@.
alter table public.profiles add column if not exists trial_reminded boolean not null default false;
alter table public.profiles add column if not exists stripe_student_sub text; -- a monthly card subscription, to renew

create or replace function public._app_link() returns text language sql immutable as $$ select 'https://gostudybridge.com/app/' $$;
create or replace function public._nice_date(d date) returns text language sql immutable as $$ select to_char(d, 'FMDD FMMonth YYYY') $$;

-- One email to the student and one to each parent who follows them (each in their own words)
create or replace function public._email_student(p_user uuid, p_subject text, p_body text, p_parent_subject text, p_parent_body text)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.profiles;
  p record;
  v_reply text := (select support_email from public.app_config where id = 1);
  v_sign text := E'\n\nQuestions? Just reply to this email.\n\nThe StudyBridge team';
begin
  select * into s from public.profiles where id = p_user;
  if s.id is null or s.test_student then return; end if;
  if coalesce(s.email, '') <> '' then
    insert into public.outgoing_emails (to_addr, subject, body, reply_to)
    values (s.email, left(p_subject, 200), left(p_body || v_sign, 8000), v_reply);
  end if;
  for p in select pr.email from public.parent_links pl join public.profiles pr on pr.id = pl.parent_id
            where pl.learner_id = p_user and coalesce(pr.email, '') <> '' loop
    insert into public.outgoing_emails (to_addr, subject, body, reply_to)
    values (p.email, left(p_parent_subject, 200), left(p_parent_body || v_sign, 8000), v_reply);
  end loop;
  perform public._prof_kick();
end $$;

-- "Welcome": after sign-up (the parent who made the code hears too)
create or replace function public._email_welcome(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.profiles; v_first text;
begin
  select * into s from public.profiles where id = p_user;
  if s.id is null then return; end if;
  v_first := coalesce(nullif(split_part(trim(coalesce(s.display_name, '')), ' ', 1), ''), 'there');
  perform public._email_student(p_user,
    'Welcome to StudyBridge, ' || v_first || '!',
    'Hi ' || v_first || E',\n\nWelcome to StudyBridge. Your free week has started and runs until '
      || public._nice_date((s.trial_until at time zone 'UTC')::date) || E'.\n\nHow to get going:\n'
      || E'1. Set up your plan: your subjects, when your exams are and how much time you have.\n'
      || E'2. Take the starting check, so your plan shows what to work on first.\n'
      || E'3. Study a little every day: lessons, practice with hints, flashcards and practice papers.\n\n'
      || 'Open StudyBridge: ' || public._app_link()
      || E'\n\nWhen your free week ends, you can choose a plan in Settings → Your plan.',
    v_first || ' has started StudyBridge',
    'Hello,' || E'\n\n' || v_first || ' has set up their StudyBridge account with your code, and their free week has started (until '
      || public._nice_date((s.trial_until at time zone 'UTC')::date) || E').\n\nYou can follow their plan and progress in your parent account: '
      || public._app_link() || E'\n\nWhen the free week ends, you can pay for them from your account.');
end $$;

-- "You're all set": when a payment is recorded (by the Owner, or a card payment through Stripe)
create or replace function public._email_all_set(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.profiles; v_first text; v_what text;
begin
  select * into s from public.profiles where id = p_user;
  if s.id is null or s.paid_until is null then return; end if;
  v_first := coalesce(nullif(split_part(trim(coalesce(s.display_name, '')), ' ', 1), ''), 'there');
  v_what := case when s.paid_plan = 'pass' then 'exam pass' else 'monthly plan' end;
  perform public._email_student(p_user,
    'You''re all set',
    'Hi ' || v_first || E',\n\nThank you! Your StudyBridge ' || v_what || ' is active until ' || public._nice_date(s.paid_until)
      || E'. Everything is open: your plan, lessons, practice, papers and mocks.\n\nKeep going: ' || public._app_link(),
    v_first || '''s StudyBridge is paid',
    'Hello,' || E'\n\nThank you! ' || v_first || '''s StudyBridge ' || v_what || ' is active until ' || public._nice_date(s.paid_until)
      || E'.\n\nYou can follow their progress in your parent account: ' || public._app_link());
end $$;

-- Every hour: "your free week ends in 2 days", once, to students who haven't paid (and their parents)
create or replace function public._student_emails_tick() returns int
language plpgsql security definer set search_path = public as $$
declare s public.profiles; n int := 0; v_first text; v_end text;
begin
  for s in select * from public.profiles
            where self_learner and not test_student and not trial_reminded
              and trial_until > now() and trial_until <= now() + interval '2 days'
              and (paid_until is null or paid_until < current_date) loop
    update public.profiles set trial_reminded = true where id = s.id;
    v_first := coalesce(nullif(split_part(trim(coalesce(s.display_name, '')), ' ', 1), ''), 'there');
    v_end := public._nice_date((s.trial_until at time zone 'UTC')::date);
    perform public._email_student(s.id,
      'Your free week ends in 2 days',
      'Hi ' || v_first || E',\n\nYour free StudyBridge week ends on ' || v_end || E'. Everything you''ve done stays saved.\n\n'
        || 'To keep going, choose a plan: open StudyBridge, then Settings → Your plan. ' || public._app_link(),
      v_first || '''s free week ends in 2 days',
      'Hello,' || E'\n\n' || v_first || '''s free StudyBridge week ends on ' || v_end
        || E'. Everything they''ve done stays saved.\n\nYou can pay for them from your parent account: ' || public._app_link());
    n := n + 1;
  end loop;
  return n;
end $$;

-- A card payment through the Owner's Pay by card links (Prof's Stripe webhook, never the app): monthly adds a month
-- (from today, or from the end of what's paid); an exam pass bought for enough months lasts until about 60 days after
-- the first exam, the same as "Mark as paid" in Admin, otherwise for the months bought
create or replace function public._student_paid_by_card(p_user uuid, p_plan text, p_months int, p_subscription text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.profiles;
  v_until date;
  v_need int;
  m int := greatest(1, coalesce(p_months, 1));
begin
  select * into s from public.profiles where id = p_user;
  if s.id is null or not s.self_learner or p_plan not in ('monthly', 'pass') then return; end if;
  if p_plan = 'monthly' then
    v_until := (greatest(coalesce(s.paid_until, current_date), current_date) + interval '1 month')::date;
  else
    v_need := case when s.exam_date is not null then greatest(1, ceil((s.exam_date - current_date) / 30.44)::int) end;
    v_until := case when v_need is not null and m >= v_need then s.exam_date + 60 else (current_date + make_interval(months => m))::date end;
  end if;
  update public.profiles set paid_plan = p_plan, paid_until = greatest(v_until, coalesce(paid_until, v_until)),
         stripe_student_sub = coalesce(p_subscription, stripe_student_sub)
   where id = p_user;
  perform public._admin_log('student_paid_card', p_user, jsonb_build_object('plan', p_plan, 'months', m, 'until', v_until));
  perform public._content_alert('student_paid', coalesce(s.display_name, s.email, 'A student') || ' paid by card',
    case when p_plan = 'pass' then 'Exam pass' else 'Monthly' end || ', until ' || public._nice_date(v_until) || '. It''s recorded already.',
    jsonb_build_object('student', p_user));
  perform public._email_all_set(p_user);
end $$;

-- The next month of a monthly card subscription (Stripe's invoice.paid)
create or replace function public._student_renewed(p_subscription text) returns void
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  update public.profiles
     set paid_plan = 'monthly', paid_until = (greatest(coalesce(paid_until, current_date), current_date) + interval '1 month')::date
   where self_learner and stripe_student_sub = p_subscription and coalesce(p_subscription, '') <> ''
  returning id into v;
  if v is not null then perform public._email_all_set(v); end if;
end $$;

-- ---------------------------------------------------------------------
-- StudyBridge's own content (launch 1, part 2): made by the Owner, checked twice, reported, reviewed
-- ---------------------------------------------------------------------
-- The Owner makes content in Claude Desktop, signed in to the content account. Before a student sees a question it
-- passes plain checks here (complete, the maths well formed, the answer fits its type) and a second solve in a fresh
-- chat that never sees the answer. Anything that fails waits in Admin → Content. Students can report anything; a
-- report leaves the item up and alerts the Owner (hiding it could make a student think it was fixed).
alter table public.bank_questions add column if not exists hint_md text;
alter table public.questions add column if not exists hint_md text;
alter table public.questions add column if not exists bank_id uuid references public.bank_questions (id) on delete set null;
alter table public.question_keys add column if not exists check_result jsonb;
alter table public.lessons add column if not exists check_result jsonb;
alter table public.app_config add column if not exists pay_link_monthly text;
alter table public.app_config add column if not exists pay_link_pass text;

-- Only the content account may use the content tools
create or replace function public._content_me() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare c uuid := public._studybridge_account();
begin
  if c is null or auth.uid() is distinct from c then
    raise exception 'These tools are only for StudyBridge’s own content account. Sign the connector in with that account.';
  end if;
  return c;
end $$;

-- A topic of one of the content account's subjects, by name or code ("Algebra", "C2.1")
create or replace function public._content_topic(p_subject uuid, p_topic text) returns public.topics
language plpgsql stable security definer set search_path = public as $$
declare
  t public.topics;
  names text;
begin
  select * into t from public.topics
   where subject_id = p_subject and (lower(name) = lower(btrim(coalesce(p_topic, ''))) or lower(code) = lower(btrim(coalesce(p_topic, ''))))
   order by position limit 1;
  if t.id is null then
    select string_agg(name, ', ' order by position) into names from (select name, position from public.topics where subject_id = p_subject order by position limit 60) z;
    if names is null then raise exception 'This subject has no syllabus yet. Set its topics first (set_syllabus).'; end if;
    raise exception 'There’s no topic “%” in this subject. Its topics are: %', left(coalesce(p_topic, ''), 80), names;
  end if;
  return t;
end $$;

-- Plain checks, no AI: is it complete, does the maths open and close, does the answer fit the question type?
create or replace function public._content_problems(p_type text, p_prompt text, p_options jsonb, p_answer jsonb,
  p_solution text, p_hint text, p_scheme text, p_marks numeric, p_need_hint boolean) returns text[]
language plpgsql immutable set search_path = public as $$
declare
  out text[] := '{}';
  txt text := coalesce(p_prompt, '') || ' ' || coalesce(p_solution, '') || ' ' || coalesce(p_hint, '') || ' ' || coalesce(p_scheme, '');
  plain text;
  opts jsonb := case when jsonb_typeof(p_options) = 'object' then coalesce(p_options -> 'items', '[]') else coalesce(p_options, '[]') end;
  n int;
  c text;
begin
  if length(btrim(coalesce(p_prompt, ''))) < 5 then out := out || 'The question is empty or too short.'::text; end if;
  if coalesce(p_marks, 0) <= 0 then out := out || 'It needs at least 1 mark.'::text; end if;
  if length(btrim(coalesce(p_solution, ''))) < 5 then out := out || 'It needs a worked solution.'::text; end if;
  if p_need_hint and length(btrim(coalesce(p_hint, ''))) < 5 then out := out || 'It needs a hint.'::text; end if;
  -- maths in $...$ must open and close (\$ is a dollar sign); braces must pair up
  plain := replace(txt, '\$', '');
  if (length(plain) - length(replace(plain, '$', ''))) % 2 = 1 then out := out || 'A $ in the maths isn’t closed.'::text; end if;
  if length(txt) - length(replace(txt, '{', '')) <> length(txt) - length(replace(txt, '}', '')) then
    out := out || 'The maths has a { without a matching }.'::text;
  end if;
  if txt ~* '(©|\mUCLES\M|all rights reserved)' then
    out := out || 'It mentions © or UCLES, which suggests it came from a real paper. StudyBridge only uses original questions.'::text;
  end if;
  if p_type = 'mcq' then
    n := jsonb_array_length(case when jsonb_typeof(opts) = 'array' then opts else '[]' end);
    if n < 2 then out := out || 'A multiple-choice question needs at least 2 options.'::text;
    elsif exists (select 1 from jsonb_array_elements_text(opts) o where btrim(o) = '') then out := out || 'One of the options is empty.'::text;
    elsif (select count(distinct lower(btrim(o))) from jsonb_array_elements_text(opts) o) < n then out := out || 'Two options are the same.'::text;
    end if;
    if p_answer ? 'choices' then
      if jsonb_typeof(p_answer -> 'choices') <> 'array' or jsonb_array_length(p_answer -> 'choices') = 0
         or exists (select 1 from jsonb_array_elements_text(p_answer -> 'choices') x where x !~ '^\d+$' or x::int >= n) then
        out := out || 'The correct options don’t match the list of options.'::text;
      end if;
    else
      c := p_answer ->> 'choice';
      if c is null or c !~ '^\d+$' or c::int >= n then out := out || 'The correct option doesn’t match the list of options.'::text; end if;
    end if;
  elsif p_type = 'numeric' then
    if coalesce(p_answer ->> 'value', '') !~ '^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$' then out := out || 'A number question needs its answer as a number.'::text; end if;
    if coalesce(p_answer ->> 'tolerance', '0') !~ '^\s*\d+(\.\d+)?\s*$' then out := out || 'The allowed margin must be a number.'::text; end if;
  elsif p_type = 'steps' then
    if length(btrim(coalesce(p_answer ->> 'final', ''))) = 0 then out := out || 'A working question needs its final line, for example x = 4.'::text; end if;
  elsif p_type in ('short', 'upload', 'drawing') then
    if length(btrim(coalesce(p_answer ->> 'text', ''))) = 0 and length(btrim(coalesce(p_scheme, ''))) < 5 then
      out := out || 'It needs a model answer or a mark scheme.'::text;
    end if;
  else
    out := out || 'Unknown question type.'::text;
  end if;
  return out;
end $$;

-- Does a second, separate answer agree with the answer key? 'same', 'different', or 'compare' (written answers:
-- the checker is shown both and says honestly whether they mean the same)
create or replace function public._content_compare(p_type text, p_key jsonb, p_second jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare
  a numeric;
  b numeric;
  tol numeric;
  k text[];
  s text[];
  norm_k text;
  norm_s text;
begin
  if p_second is null or p_second = '{}'::jsonb then return 'different'; end if;
  if p_type = 'mcq' then
    k := case when p_key ? 'choices' then array(select x from jsonb_array_elements_text(p_key -> 'choices') x order by x) else array[p_key ->> 'choice'] end;
    s := case when p_second ? 'choices' then array(select x from jsonb_array_elements_text(p_second -> 'choices') x order by x) else array[p_second ->> 'choice'] end;
    return case when k = s then 'same' else 'different' end;
  elsif p_type = 'numeric' then
    begin
      a := btrim(p_key ->> 'value')::numeric;
      b := btrim(p_second ->> 'value')::numeric;
    exception when others then return 'different';
    end;
    if b is null then return 'different'; end if;
    tol := coalesce(nullif(btrim(coalesce(p_key ->> 'tolerance', '')), '')::numeric, 0);
    -- within the margin, or the same to about 3 significant figures
    return case when abs(a - b) <= greatest(tol, abs(a) * 0.005, 0.000000001) then 'same' else 'different' end;
  elsif p_type = 'steps' then
    norm_k := lower(regexp_replace(regexp_replace(coalesce(p_key ->> 'final', ''), '\\(left|right|,|;|!|quad)', '', 'g'), '[\s.]', '', 'g'));
    norm_s := lower(regexp_replace(regexp_replace(coalesce(p_second ->> 'final', p_second ->> 'text', ''), '\\(left|right|,|;|!|quad)', '', 'g'), '[\s.]', '', 'g'));
    norm_k := replace(replace(norm_k, '\times', '*'), '\cdot', '*');
    norm_s := replace(replace(norm_s, '\times', '*'), '\cdot', '*');
    return case when norm_k <> '' and norm_k = norm_s then 'same' else 'compare' end;
  end if;
  return 'compare';
end $$;

-- A paper goes live once every one of its questions has passed (or the Owner approved it)
create or replace function public._content_paper_ready(p_paper uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.questions q join public.question_keys k on k.question_id = q.id
              where q.assignment_id = p_paper and coalesce(k.check_result ->> 'state', '') not in ('passed', 'approved')) then
    return false;
  end if;
  update public.assignments set draft = false, visibility = 'visible', updated_at = now()
   where id = p_paper and draft and source = 'studybridge';
  return true;
end $$;

-- Tell the Owner (Admin) something needs them
create or replace function public._content_alert(p_kind text, p_title text, p_body text, p_ref jsonb default '{}') returns void
language plpgsql security definer set search_path = public as $$
declare a uuid;
begin
  for a in select pa.user_id from public.platform_admins pa join public.profiles p on p.id = pa.user_id where p.role = 'admin' loop
    perform public.notify_user(a, p_kind, p_title, left(coalesce(p_body, ''), 200), coalesce(p_ref, '{}'));
  end loop;
end $$;

-- ---------------- the Owner's tools (Claude Desktop, signed in as the content account) ----------------
-- Where each subject is: topics, questions live / waiting / needing the Owner, lessons, flashcards, papers
create or replace function public.content_status(p_subject uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c uuid := public._content_me();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'board', s.board, 'level', s.level, 'code', s.code, 'open_to_students', s.live,
      'topics', (select count(*) from public.topics t where t.subject_id = s.id),
      'questions_live', (select count(*) from public.bank_questions b where b.subject_id = s.id and b.owner_id = c and b.status = 'approved'),
      'questions_waiting_for_check', (select count(*) from public.bank_questions b where b.subject_id = s.id and b.owner_id = c and b.status = 'review'
                                        and b.check_result ->> 'state' = 'waiting'),
      'questions_needing_owner', (select count(*) from public.bank_questions b where b.subject_id = s.id and b.owner_id = c and b.status = 'review'
                                    and coalesce(b.check_result ->> 'state', '') <> 'waiting'),
      'lessons', (select count(*) from public.lessons l where l.subject_id = s.id and l.tutor_id = c and l.visibility = 'visible' and not l.draft),
      'flashcards', (select count(*) from public.cards k where k.subject_id = s.id and k.tutor_id = c and k.learner_id is null),
      'papers_live', (select count(*) from public.assignments a where a.subject_id = s.id and a.tutor_id = c and a.source = 'studybridge' and not a.draft
                        and a.visibility = 'visible'),
      'papers_waiting', (select count(*) from public.assignments a where a.subject_id = s.id and a.tutor_id = c and a.source = 'studybridge' and a.draft))
    order by s.position)
    from public.subjects s where s.tutor_id = c and s.catalogue is not null and (p_subject is null or s.id = p_subject)), '[]'::jsonb);
end $$;

-- The syllabus in order: topics are matched by name (kept, renumbered, details updated) or added; others move to the end
create or replace function public.content_set_syllabus(p_subject uuid, p_topics jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c uuid := public._content_me();
  s public.subjects;
  i jsonb;
  t public.topics;
  pos int := 0;
  added int := 0;
  v_name text;
begin
  select * into s from public.subjects where id = p_subject and tutor_id = c;
  if s.id is null then raise exception 'Unknown subject.'; end if;
  if jsonb_typeof(p_topics) <> 'array' or jsonb_array_length(p_topics) = 0 then raise exception 'Send the topics in order.'; end if;
  if jsonb_array_length(p_topics) > 200 then raise exception 'That’s more than 200 topics. Group them into main topics with details.'; end if;
  update public.topics set position = position + 10000 where subject_id = s.id;
  for i in select * from jsonb_array_elements(p_topics) loop
    v_name := left(btrim(coalesce(i ->> 'name', '')), 200);
    continue when v_name = '';
    pos := pos + 1;
    select * into t from public.topics where subject_id = s.id and lower(name) = lower(v_name) limit 1;
    if t.id is null then
      insert into public.topics (tutor_id, subject_id, name, position, code, details)
      values (c, s.id, v_name, pos, nullif(left(btrim(coalesce(i ->> 'code', '')), 20), ''),
              coalesce(array(select left(btrim(x), 300) from jsonb_array_elements_text(coalesce(i -> 'details', '[]')) x where btrim(x) <> ''), '{}'));
      added := added + 1;
    else
      update public.topics set position = pos, code = coalesce(nullif(left(btrim(coalesce(i ->> 'code', '')), 20), ''), code),
             details = case when jsonb_typeof(i -> 'details') = 'array'
                            then array(select left(btrim(x), 300) from jsonb_array_elements_text(i -> 'details') x where btrim(x) <> '') else details end
       where id = t.id;
    end if;
  end loop;
  -- topics not in the list keep their order after the new ones
  update public.topics set position = pos + (position - 10000) where subject_id = s.id and position > 10000;
  return jsonb_build_object('topics', (select count(*) from public.topics where subject_id = s.id), 'added', added);
end $$;

-- Practice questions (with a hint and a worked solution) into the subject's question bank. Each waits for its check.
create or replace function public.content_add_questions(p_subject uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c uuid := public._content_me();
  s public.subjects;
  i jsonb;
  t public.topics;
  probs text[];
  k int := 0;
  w int := 0;
  bad jsonb := '[]'::jsonb;
  v_type text;
  v_marks numeric;
  v_exam text;
begin
  select * into s from public.subjects where id = p_subject and tutor_id = c;
  if s.id is null then raise exception 'Unknown subject.'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Send at least one question.'; end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'Send up to 50 questions at a time.'; end if;
  -- the subject's exam ('cie:0607'), so tutors teaching that exam get the questions too
  v_exam := public._subject_exam(s);
  -- every topic must be in the syllabus, so practice and the plan line up (checked first: nothing half-saves)
  for i in select * from jsonb_array_elements(p_items) loop
    perform public._content_topic(s.id, i ->> 'topic');
  end loop;
  for i in select * from jsonb_array_elements(p_items) loop
    k := k + 1;
    t := public._content_topic(s.id, i ->> 'topic');
    v_type := coalesce(i ->> 'type', '');
    v_marks := case when coalesce(i ->> 'marks', '') ~ '^\d+(\.\d+)?$' then (i ->> 'marks')::numeric else 1 end;
    probs := public._content_problems(v_type, i ->> 'prompt', coalesce(i -> 'options', '[]'), coalesce(i -> 'answer', '{}'),
               i ->> 'solution', i ->> 'hint', i ->> 'mark_scheme', v_marks, true);
    if v_type not in ('mcq', 'numeric', 'short', 'steps', 'upload', 'drawing') then v_type := 'short'; end if;
    insert into public.bank_questions (owner_id, status, exam_board, exam_code, subject_id, topic, difficulty, type, prompt_md, options, marks,
       answer, mark_scheme_md, solution_md, hint_md, source, check_result)
    values (c, 'review', coalesce(split_part(v_exam, ':', 1), s.board), split_part(v_exam, ':', 2), s.id, t.name,
       case when coalesce(i ->> 'difficulty', '') ~ '^[123]$' then (i ->> 'difficulty')::int end,
       v_type, coalesce(i ->> 'prompt', ''), coalesce(i -> 'options', '[]'), v_marks, coalesce(i -> 'answer', '{}'),
       nullif(i ->> 'mark_scheme', ''), nullif(i ->> 'solution', ''), nullif(i ->> 'hint', ''), 'studybridge',
       jsonb_build_object('state', case when cardinality(probs) > 0 then 'problems' else 'waiting' end, 'problems', to_jsonb(probs), 'at', now()));
    if cardinality(probs) > 0 then bad := bad || jsonb_build_object('number', k, 'problems', to_jsonb(probs)); else w := w + 1; end if;
  end loop;
  return jsonb_build_object('added', k, 'waiting_for_check', w, 'with_problems', bad);
end $$;

-- A lesson for one topic. Sending the same title again replaces it (fix one lesson without touching the rest).
create or replace function public.content_add_lesson(p_subject uuid, p_topic text, p_title text, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c uuid := public._content_me();
  s public.subjects;
  t public.topics;
  probs text[] := '{}';
  txt text := coalesce(p_title, '') || ' ' || coalesce(p_body, '');
  plain text;
  v_id uuid;
  v_replaced boolean := false;
begin
  select * into s from public.subjects where id = p_subject and tutor_id = c;
  if s.id is null then raise exception 'Unknown subject.'; end if;
  t := public._content_topic(s.id, p_topic);
  if length(btrim(coalesce(p_title, ''))) < 3 then raise exception 'Give the lesson a title.'; end if;
  if length(btrim(coalesce(p_body, ''))) < 200 then probs := probs || 'The lesson is very short.'::text; end if;
  plain := replace(txt, '\$', '');
  if (length(plain) - length(replace(plain, '$', ''))) % 2 = 1 then probs := probs || 'A $ in the maths isn’t closed.'::text; end if;
  if length(txt) - length(replace(txt, '{', '')) <> length(txt) - length(replace(txt, '}', '')) then probs := probs || 'The maths has a { without a matching }.'::text; end if;
  if txt ~* '(©|\mUCLES\M|all rights reserved)' then probs := probs || 'It mentions © or UCLES, which suggests copied material.'::text; end if;
  select id into v_id from public.lessons where tutor_id = c and subject_id = s.id and lower(title) = lower(btrim(p_title)) limit 1;
  if v_id is not null then
    update public.lessons set body_md = p_body, topic_id = t.id, draft = false, source = 'studybridge', updated_at = now(),
           visibility = case when cardinality(probs) > 0 then 'hidden' else 'visible' end,
           check_result = jsonb_build_object('state', case when cardinality(probs) > 0 then 'problems' else 'passed' end, 'problems', to_jsonb(probs), 'at', now())
     where id = v_id;
    v_replaced := true;
  else
    insert into public.lessons (tutor_id, title, body_md, subject_id, topic_id, draft, source, visibility, check_result)
    values (c, left(btrim(p_title), 200), p_body, s.id, t.id, false, 'studybridge',
            case when cardinality(probs) > 0 then 'hidden' else 'visible' end,
            jsonb_build_object('state', case when cardinality(probs) > 0 then 'problems' else 'passed' end, 'problems', to_jsonb(probs), 'at', now()))
    returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id, 'live', cardinality(probs) = 0, 'replaced', v_replaced, 'problems', to_jsonb(probs));
end $$;

-- Flashcards for the subject's students. Cards with problems are left out and listed back; repeats are skipped.
create or replace function public.content_add_cards(p_subject uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c uuid := public._content_me();
  s public.subjects;
  i jsonb;
  t public.topics;
  k int := 0;
  n int := 0;
  bad jsonb := '[]'::jsonb;
  probs text[];
  txt text;
  plain text;
begin
  select * into s from public.subjects where id = p_subject and tutor_id = c;
  if s.id is null then raise exception 'Unknown subject.'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Send at least one card.'; end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'Send up to 100 cards at a time.'; end if;
  for i in select * from jsonb_array_elements(p_items) loop
    perform public._content_topic(s.id, i ->> 'topic');
  end loop;
  for i in select * from jsonb_array_elements(p_items) loop
    k := k + 1;
    t := public._content_topic(s.id, i ->> 'topic');
    probs := '{}';
    txt := coalesce(i ->> 'front', '') || ' ' || coalesce(i ->> 'back', '');
    plain := replace(txt, '\$', '');
    if length(btrim(coalesce(i ->> 'front', ''))) < 2 then probs := probs || 'The front is empty.'::text; end if;
    if length(btrim(coalesce(i ->> 'back', ''))) < 1 then probs := probs || 'The back is empty.'::text; end if;
    if length(coalesce(i ->> 'front', '')) > 4000 or length(coalesce(i ->> 'back', '')) > 8000 then probs := probs || 'It’s too long for a card.'::text; end if;
    if (length(plain) - length(replace(plain, '$', ''))) % 2 = 1 then probs := probs || 'A $ in the maths isn’t closed.'::text; end if;
    if cardinality(probs) > 0 then
      bad := bad || jsonb_build_object('number', k, 'problems', to_jsonb(probs));
    elsif not exists (select 1 from public.cards where tutor_id = c and subject_id = s.id and learner_id is null and lower(front_md) = lower(btrim(i ->> 'front'))) then
      insert into public.cards (tutor_id, subject_id, topic_id, front_md, back_md, source, created_by)
      values (c, s.id, t.id, btrim(i ->> 'front'), btrim(i ->> 'back'), 'tutor', c);
      n := n + 1;
    end if;
  end loop;
  return jsonb_build_object('added', n, 'left_out', bad);
end $$;

-- An original practice paper in the exam's format. Students mark it themselves with the mark scheme afterwards.
-- It goes live once every question has passed its check.
create or replace function public.content_add_paper(p_subject uuid, p_title text, p_minutes int, p_instructions text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c uuid := public._content_me();
  s public.subjects;
  i jsonb;
  t public.topics;
  probs text[];
  k int := 0;
  w int := 0;
  bad jsonb := '[]'::jsonb;
  v_id uuid;
  qid uuid;
  v_type text;
  v_marks numeric;
begin
  select * into s from public.subjects where id = p_subject and tutor_id = c;
  if s.id is null then raise exception 'Unknown subject.'; end if;
  if length(btrim(coalesce(p_title, ''))) < 3 then raise exception 'Give the paper a title.'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'A paper needs questions.'; end if;
  if jsonb_array_length(p_items) > 60 then raise exception 'Up to 60 questions in a paper.'; end if;
  if exists (select 1 from public.assignments where tutor_id = c and subject_id = s.id and source = 'studybridge' and lower(title) = lower(btrim(p_title))) then
    raise exception 'There’s already a paper called “%” in this subject. Use a new title.', btrim(p_title);
  end if;
  for i in select * from jsonb_array_elements(p_items) loop
    if nullif(btrim(coalesce(i ->> 'topic', '')), '') is not null then perform public._content_topic(s.id, i ->> 'topic'); end if;
  end loop;
  insert into public.assignments (tutor_id, kind, title, instructions_md, subject_id, visibility, draft, source, self_mark, max_attempts,
     release_mode, show_answers, time_limit_min, lockdown, camera, allow_notes)
  values (c, 'test', left(btrim(p_title), 200),
     coalesce(nullif(btrim(coalesce(p_instructions, '')), '') || E'\n\n', '')
       || '*An original practice paper written by StudyBridge in the style of ' || s.name || '. Not affiliated with or endorsed by '
       || coalesce(nullif(s.board, ''), 'the exam board') || '. When you hand it in, mark it yourself with the mark scheme.*',
     s.id, 'hidden', true, 'studybridge', true, 1, 'on_submit', true,
     case when coalesce(p_minutes, 0) between 1 and 300 then p_minutes end, false, false, false)
  returning id into v_id;
  for i in select * from jsonb_array_elements(p_items) loop
    k := k + 1;
    t := case when nullif(btrim(coalesce(i ->> 'topic', '')), '') is not null then public._content_topic(s.id, i ->> 'topic') end;
    v_type := coalesce(i ->> 'type', '');
    v_marks := case when coalesce(i ->> 'marks', '') ~ '^\d+(\.\d+)?$' then (i ->> 'marks')::numeric else 1 end;
    probs := public._content_problems(v_type, i ->> 'prompt', coalesce(i -> 'options', '[]'), coalesce(i -> 'answer', '{}'),
               i ->> 'solution', null, i ->> 'mark_scheme', v_marks, false);
    if v_type not in ('mcq', 'numeric', 'short', 'steps', 'upload', 'drawing') then v_type := 'short'; end if;
    insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, options, marks, topic_id)
    values (v_id, c, k - 1, v_type, coalesce(i ->> 'prompt', ''), coalesce(i -> 'options', '[]'), v_marks, t.id)
    returning id into qid;
    insert into public.question_keys (question_id, tutor_id, answer, mark_scheme_md, solution_md, check_result)
    values (qid, c, coalesce(i -> 'answer', '{}'), nullif(i ->> 'mark_scheme', ''), nullif(i ->> 'solution', ''),
            jsonb_build_object('state', case when cardinality(probs) > 0 then 'problems' else 'waiting' end, 'problems', to_jsonb(probs), 'at', now()));
    if cardinality(probs) > 0 then bad := bad || jsonb_build_object('number', k, 'problems', to_jsonb(probs)); else w := w + 1; end if;
  end loop;
  return jsonb_build_object('id', v_id, 'questions', k, 'waiting_for_check', w, 'with_problems', bad);
end $$;

-- The questions waiting for their second check: never the answer, hint, solution or mark scheme
create or replace function public.content_to_check(p_limit int default 10) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c uuid := public._content_me();
begin
  return jsonb_build_object(
    'waiting', (select count(*) from public.bank_questions b where b.owner_id = c and b.status = 'review' and b.check_result ->> 'state' = 'waiting')
             + (select count(*) from public.question_keys k join public.questions q on q.id = k.question_id join public.assignments a on a.id = q.assignment_id
                 where a.tutor_id = c and a.source = 'studybridge' and k.check_result ->> 'state' = 'waiting'),
    'questions', coalesce((select jsonb_agg(to_jsonb(z) - 'created_at' order by z.created_at) from (
        select 'question' as kind, b.id, b.type, s.name as subject, b.topic, b.prompt_md as prompt,
               case when b.type = 'mcq' then b.options end as options, b.answer ->> 'unit' as unit, b.marks, b.created_at
          from public.bank_questions b left join public.subjects s on s.id = b.subject_id
         where b.owner_id = c and b.status = 'review' and b.check_result ->> 'state' = 'waiting'
        union all
        select 'paper', q.id, q.type, s.name, tp.name, q.prompt_md, case when q.type = 'mcq' then q.options end, k.answer ->> 'unit', q.marks, q.created_at
          from public.questions q join public.question_keys k on k.question_id = q.id join public.assignments a on a.id = q.assignment_id
          left join public.subjects s on s.id = a.subject_id left join public.topics tp on tp.id = q.topic_id
         where a.tutor_id = c and a.source = 'studybridge' and k.check_result ->> 'state' = 'waiting'
         order by created_at limit greatest(1, least(coalesce(p_limit, 10), 30))) z), '[]'::jsonb));
end $$;

-- Save the outcome of a check on one question (bank or paper)
create or replace function public._content_mark(p_kind text, p_id uuid, p_state text, p_detail jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_paper uuid;
begin
  if p_kind = 'paper' then
    update public.question_keys set check_result = coalesce(check_result, '{}') || jsonb_build_object('state', p_state, 'at', now()) || coalesce(p_detail, '{}')
     where question_id = p_id;
    if p_state in ('passed', 'approved') then
      select assignment_id into v_paper from public.questions where id = p_id;
      perform public._content_paper_ready(v_paper);
    end if;
  else
    update public.bank_questions
       set status = case when p_state in ('passed', 'approved') then 'approved' else status end, updated_at = now(),
           check_result = coalesce(check_result, '{}') || jsonb_build_object('state', p_state, 'at', now()) || coalesce(p_detail, '{}')
     where id = p_id;
  end if;
end $$;

-- The second solve's answers. Choices and numbers are compared here; written answers come back to compare by meaning.
create or replace function public.content_submit_checks(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c uuid := public._content_me();
  i jsonb;
  v_kind text;
  v_id uuid;
  v_type text;
  v_key jsonb;
  v_scheme text;
  v_solution text;
  v_prompt text;
  v_state text;
  v_res text;
  passed int := 0;
  failed int := 0;
  cmp jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' then raise exception 'Send a list of answers.'; end if;
  for i in select * from jsonb_array_elements(p_items) loop
    v_kind := coalesce(i ->> 'kind', 'question');
    begin v_id := (i ->> 'id')::uuid; exception when others then continue; end;
    v_state := null;
    if v_kind = 'paper' then
      select q.type, k.answer, k.mark_scheme_md, k.solution_md, q.prompt_md, k.check_result ->> 'state'
        into v_type, v_key, v_scheme, v_solution, v_prompt, v_state
        from public.questions q join public.question_keys k on k.question_id = q.id join public.assignments a on a.id = q.assignment_id
       where q.id = v_id and a.tutor_id = c and a.source = 'studybridge';
    else
      v_kind := 'question';
      select b.type, b.answer, b.mark_scheme_md, b.solution_md, b.prompt_md, b.check_result ->> 'state'
        into v_type, v_key, v_scheme, v_solution, v_prompt, v_state
        from public.bank_questions b where b.id = v_id and b.owner_id = c;
    end if;
    continue when v_state is distinct from 'waiting';
    v_res := public._content_compare(v_type, v_key, coalesce(i -> 'answer', '{}'));
    if v_res = 'same' then
      perform public._content_mark(v_kind, v_id, 'passed', jsonb_build_object('second', i -> 'answer'));
      passed := passed + 1;
    elsif v_res = 'different' then
      perform public._content_mark(v_kind, v_id, 'failed', jsonb_build_object('second', i -> 'answer', 'second_working', left(i ->> 'working', 4000),
        'reason', 'The second solve got a different answer.'));
      failed := failed + 1;
    else
      perform public._content_mark(v_kind, v_id, 'compare', jsonb_build_object('second', i -> 'answer', 'second_working', left(i ->> 'working', 4000)));
      cmp := cmp || jsonb_build_object('kind', v_kind, 'id', v_id, 'question', v_prompt, 'your_answer', i -> 'answer',
        'answer_key', v_key, 'mark_scheme', v_scheme, 'worked_solution', v_solution);
    end if;
  end loop;
  if failed > 0 then
    perform public._content_alert('content_check', failed || case when failed = 1 then ' StudyBridge question needs you' else ' StudyBridge questions need you' end,
      'The second check got a different answer. See Admin → Content.', '{}');
  end if;
  return jsonb_build_object('passed', passed, 'failed', failed, 'compare_these', cmp);
end $$;

-- For written answers: does the second answer mean the same as the answer key? (Said honestly by the checker.)
create or replace function public.content_confirm_checks(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c uuid := public._content_me();
  i jsonb;
  v_kind text;
  v_id uuid;
  v_state text;
  passed int := 0;
  failed int := 0;
begin
  if jsonb_typeof(p_items) <> 'array' then raise exception 'Send a list of results.'; end if;
  for i in select * from jsonb_array_elements(p_items) loop
    v_kind := case when i ->> 'kind' = 'paper' then 'paper' else 'question' end;
    begin v_id := (i ->> 'id')::uuid; exception when others then continue; end;
    v_state := null;
    if v_kind = 'paper' then
      select k.check_result ->> 'state' into v_state from public.question_keys k join public.questions q on q.id = k.question_id
        join public.assignments a on a.id = q.assignment_id where q.id = v_id and a.tutor_id = c and a.source = 'studybridge';
    else
      select b.check_result ->> 'state' into v_state from public.bank_questions b where b.id = v_id and b.owner_id = c;
    end if;
    continue when v_state is distinct from 'compare';
    if coalesce((i ->> 'same')::boolean, false) then
      perform public._content_mark(v_kind, v_id, 'passed', jsonb_build_object('note', left(i ->> 'note', 1000)));
      passed := passed + 1;
    else
      perform public._content_mark(v_kind, v_id, 'failed', jsonb_build_object('note', left(i ->> 'note', 1000),
        'reason', 'The second solve’s answer means something different.'));
      failed := failed + 1;
    end if;
  end loop;
  if failed > 0 then
    perform public._content_alert('content_check', failed || case when failed = 1 then ' StudyBridge question needs you' else ' StudyBridge questions need you' end,
      'The second check disagreed with the answer. See Admin → Content.', '{}');
  end if;
  return jsonb_build_object('passed', passed, 'failed', failed);
end $$;

-- ---------------- students report a problem ----------------
create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('question', 'paper', 'lesson', 'card')),  -- paper = a question in a practice paper
  item_id uuid not null,      -- the bank question, paper question, lesson or card
  question_id uuid,           -- the copy of the question the student saw
  message text not null check (length(message) between 2 and 2000),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  reply text
);
create index if not exists idx_content_reports_open on public.content_reports (created_at) where done_at is null;
alter table public.content_reports enable row level security;
revoke all on public.content_reports from anon, authenticated;

create or replace function public.report_content(p_kind text, p_id uuid, p_message text) returns void
language plpgsql security definer set search_path = public as $$
declare
  me public.profiles;
  c uuid := public._studybridge_account();
  v_kind text;
  v_item uuid;
  v_q uuid;
  v_what text;
  v_subject text;
  v_msg text := btrim(coalesce(p_message, ''));
  a public.assignments;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or not me.self_learner or c is null or me.tutor_id is distinct from c then
    raise exception 'Reports are for StudyBridge’s own lessons and questions.';
  end if;
  if length(v_msg) < 2 then raise exception 'Say what’s wrong.'; end if;
  if (select count(*) from public.content_reports where reporter_id = me.id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'That’s a lot of reports today. Try again tomorrow.';
  end if;
  if p_kind = 'question' then
    select a2.* into a from public.questions q join public.assignments a2 on a2.id = q.assignment_id where q.id = p_id and a2.tutor_id = c;
    if a.id is null or not (public._assignment_visible_to(a, me.id) or me.id = any (coalesce(a.learner_ids, '{}'))) then
      raise exception 'Question not found.';
    end if;
    select q.id, q.bank_id, left(q.prompt_md, 140) into v_q, v_item, v_what from public.questions q where q.id = p_id;
    v_kind := case when v_item is null then 'paper' else 'question' end;
    v_item := coalesce(v_item, v_q);
    select name into v_subject from public.subjects where id = a.subject_id;
  elsif p_kind = 'lesson' then
    select l.id, l.title, s.name into v_item, v_what, v_subject from public.lessons l left join public.subjects s on s.id = l.subject_id
     where l.id = p_id and l.tutor_id = c and not l.draft and public.can_learner_see(l.tutor_id, l.learner_ids, l.subject_id, l.visibility, l.visible_from);
    if v_item is null then raise exception 'Lesson not found.'; end if;
    v_kind := 'lesson';
  elsif p_kind = 'card' then
    select k.id, left(k.front_md, 140), s.name into v_item, v_what, v_subject from public.cards k left join public.subjects s on s.id = k.subject_id
     where k.id = p_id and k.tutor_id = c and k.learner_id is null
       and (k.subject_id is null or exists (select 1 from public.learner_subjects ls where ls.learner_id = me.id and ls.subject_id = k.subject_id));
    if v_item is null then raise exception 'Card not found.'; end if;
    v_kind := 'card';
  else
    raise exception 'Unknown kind of report.';
  end if;
  insert into public.content_reports (reporter_id, kind, item_id, question_id, message)
  values (me.id, v_kind, v_item, v_q, left(v_msg, 2000));
  perform public._content_alert('content_report', coalesce(me.display_name, 'A student') || ' reported a problem',
    coalesce(v_subject || ': ', '') || v_msg, '{}');
  perform public._email_us('support', 'Report from ' || coalesce(me.display_name, 'a student') || coalesce(': ' || v_subject, ''),
    'From: ' || coalesce(me.display_name, 'a student') || ' <' || coalesce((select email::text from auth.users where id = me.id), me.email, '') || '>'
      || E'\nAbout ' || case v_kind when 'lesson' then 'the lesson' when 'card' then 'the flashcard' else 'the question' end
      || coalesce(' in ' || v_subject, '') || ': ' || coalesce(v_what, '') || E'\n\n' || v_msg
      || E'\n\n(It stays up for students. Sort it in Admin → Content.)',
    (select email::text from auth.users where id = me.id));
end $$;

-- ---------------- Admin → Content: what needs the Owner ----------------
create or replace function public.admin_content_review() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c uuid := public._studybridge_account();
begin
  perform public._admin();
  return jsonb_build_object(
    'waiting', (select count(*) from public.bank_questions b where b.owner_id = c and b.status = 'review' and b.check_result ->> 'state' = 'waiting')
             + (select count(*) from public.question_keys k join public.questions q on q.id = k.question_id join public.assignments a on a.id = q.assignment_id
                 where a.tutor_id = c and a.source = 'studybridge' and k.check_result ->> 'state' = 'waiting'),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('kind', 'question', 'id', b.id, 'subject', s.name, 'topic', b.topic, 'type', b.type,
        'prompt', b.prompt_md, 'options', b.options, 'marks', b.marks, 'answer', b.answer, 'hint', b.hint_md, 'solution', b.solution_md,
        'mark_scheme', b.mark_scheme_md, 'check', b.check_result, 'created_at', b.created_at) order by b.created_at)
      from public.bank_questions b left join public.subjects s on s.id = b.subject_id
     where c is not null and b.owner_id = c and b.status = 'review' and coalesce(b.check_result ->> 'state', '') <> 'waiting'), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('kind', 'paper', 'id', q.id, 'paper', a.title, 'paper_id', a.id, 'number', q.position + 1,
        'subject', s.name, 'topic', tp.name, 'type', q.type, 'prompt', q.prompt_md, 'options', q.options, 'marks', q.marks, 'answer', k.answer,
        'solution', k.solution_md, 'mark_scheme', k.mark_scheme_md, 'check', k.check_result, 'created_at', q.created_at) order by a.created_at, q.position)
      from public.questions q join public.question_keys k on k.question_id = q.id join public.assignments a on a.id = q.assignment_id
      left join public.subjects s on s.id = a.subject_id left join public.topics tp on tp.id = q.topic_id
     where c is not null and a.tutor_id = c and a.source = 'studybridge' and k.check_result ->> 'state' in ('problems', 'failed', 'compare')), '[]'::jsonb),
    'lessons', coalesce((select jsonb_agg(jsonb_build_object('kind', 'lesson', 'id', l.id, 'subject', s.name, 'title', l.title, 'body', l.body_md,
        'check', l.check_result) order by l.created_at)
      from public.lessons l left join public.subjects s on s.id = l.subject_id
     where c is not null and l.tutor_id = c and l.check_result ->> 'state' = 'problems'), '[]'::jsonb),
    'reports', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'item_id', r.item_id, 'message', r.message,
        'created_at', r.created_at, 'student', p.display_name, 'email', p.email,
        'item', case r.kind
          when 'question' then (select jsonb_build_object('subject', s.name, 'topic', b.topic, 'type', b.type, 'prompt', b.prompt_md, 'options', b.options,
                                 'answer', b.answer, 'hint', b.hint_md, 'solution', b.solution_md, 'status', b.status)
                                from public.bank_questions b left join public.subjects s on s.id = b.subject_id where b.id = r.item_id)
          when 'paper' then (select jsonb_build_object('subject', s.name, 'paper', a.title, 'number', q.position + 1, 'type', q.type, 'prompt', q.prompt_md,
                                 'options', q.options, 'answer', k.answer, 'solution', k.solution_md, 'mark_scheme', k.mark_scheme_md)
                                from public.questions q join public.question_keys k on k.question_id = q.id join public.assignments a on a.id = q.assignment_id
                                left join public.subjects s on s.id = a.subject_id where q.id = r.item_id)
          when 'lesson' then (select jsonb_build_object('subject', s.name, 'title', l.title, 'body', l.body_md, 'visible', l.visibility = 'visible')
                                from public.lessons l left join public.subjects s on s.id = l.subject_id where l.id = r.item_id)
          else (select jsonb_build_object('subject', s.name, 'front', k.front_md, 'back', k.back_md)
                  from public.cards k left join public.subjects s on s.id = k.subject_id where k.id = r.item_id) end)
      order by r.created_at)
      from public.content_reports r join public.profiles p on p.id = r.reporter_id where r.done_at is null), '[]'::jsonb),
    'done', coalesce((select jsonb_agg(jsonb_build_object('id', z.id, 'kind', z.kind, 'message', z.message, 'student', z.display_name,
        'done_at', z.done_at, 'reply', z.reply) order by z.done_at desc)
      from (select r.*, p.display_name from public.content_reports r join public.profiles p on p.id = r.reporter_id
             where r.done_at is not null order by r.done_at desc limit 20) z), '[]'::jsonb));
end $$;

-- The Owner decides: approve as it is, fix it (then it's live), hide it, or remove it
create or replace function public.admin_content_decide(p_kind text, p_id uuid, p_action text, p_fix jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  c uuid := public._studybridge_account();
  b public.bank_questions;
  q public.questions;
  k public.question_keys;
  probs text[];
  f jsonb := coalesce(p_fix, '{}'::jsonb);
  v_paper uuid;
begin
  perform public._admin();
  if p_action not in ('approve', 'fix', 'hide', 'remove') then raise exception 'Unknown action.'; end if;
  if p_kind = 'question' then
    select * into b from public.bank_questions where id = p_id and (owner_id = c or owner_id is null);
    if b.id is null then raise exception 'Question not found.'; end if;
    if p_action = 'fix' then
      b.prompt_md := coalesce(f ->> 'prompt', b.prompt_md);
      b.options := coalesce(f -> 'options', b.options);
      b.answer := coalesce(f -> 'answer', b.answer);
      b.hint_md := coalesce(f ->> 'hint', b.hint_md);
      b.solution_md := coalesce(f ->> 'solution', b.solution_md);
      b.mark_scheme_md := coalesce(f ->> 'mark_scheme', b.mark_scheme_md);
      probs := public._content_problems(b.type, b.prompt_md, b.options, b.answer, b.solution_md, b.hint_md, b.mark_scheme_md, b.marks, b.owner_id is not null);
      if cardinality(probs) > 0 then raise exception '%', array_to_string(probs, ' '); end if;
      update public.bank_questions set prompt_md = b.prompt_md, options = b.options, answer = b.answer, hint_md = b.hint_md,
             solution_md = b.solution_md, mark_scheme_md = b.mark_scheme_md, updated_at = now() where id = b.id;
    end if;
    if p_action in ('approve', 'fix') then
      update public.bank_questions set status = 'approved', updated_at = now(),
             check_result = coalesce(check_result, '{}') || jsonb_build_object('state', 'approved', 'by_owner', now())
       where id = b.id;
    else
      update public.bank_questions set status = 'rejected', updated_at = now(),
             check_result = coalesce(check_result, '{}') || jsonb_build_object('state', 'removed', 'by_owner', now())
       where id = b.id;
    end if;
  elsif p_kind = 'paper' then
    select q2.* into q from public.questions q2 join public.assignments a on a.id = q2.assignment_id
     where q2.id = p_id and a.tutor_id = c and a.source = 'studybridge';
    if q.id is null then raise exception 'Question not found.'; end if;
    select * into k from public.question_keys where question_id = q.id;
    v_paper := q.assignment_id;
    if p_action in ('hide', 'remove') then
      if exists (select 1 from public.attempts where assignment_id = v_paper) then
        raise exception 'Students have already taken this paper. Fix the question instead.';
      end if;
      delete from public.questions where id = q.id;
      perform public._content_paper_ready(v_paper);
    else
      if p_action = 'fix' then
        q.prompt_md := coalesce(f ->> 'prompt', q.prompt_md);
        q.options := coalesce(f -> 'options', q.options);
        k.answer := coalesce(f -> 'answer', k.answer);
        k.solution_md := coalesce(f ->> 'solution', k.solution_md);
        k.mark_scheme_md := coalesce(f ->> 'mark_scheme', k.mark_scheme_md);
        probs := public._content_problems(q.type, q.prompt_md, q.options, k.answer, k.solution_md, null, k.mark_scheme_md, q.marks, false);
        if cardinality(probs) > 0 then raise exception '%', array_to_string(probs, ' '); end if;
        update public.questions set prompt_md = q.prompt_md, options = q.options where id = q.id;
        update public.question_keys set answer = k.answer, solution_md = k.solution_md, mark_scheme_md = k.mark_scheme_md where question_id = q.id;
      end if;
      perform public._content_mark('paper', q.id, 'approved', jsonb_build_object('by_owner', now()));
    end if;
  elsif p_kind = 'lesson' then
    if not exists (select 1 from public.lessons where id = p_id and tutor_id = c) then raise exception 'Lesson not found.'; end if;
    if p_action = 'remove' then
      delete from public.lessons where id = p_id;
    elsif p_action = 'hide' then
      update public.lessons set visibility = 'hidden', updated_at = now() where id = p_id;
    else
      update public.lessons
         set title = coalesce(nullif(btrim(f ->> 'title'), ''), title), body_md = coalesce(f ->> 'body', body_md),
             visibility = 'visible', draft = false, updated_at = now(),
             check_result = coalesce(check_result, '{}') || jsonb_build_object('state', 'approved', 'by_owner', now())
       where id = p_id;
    end if;
  elsif p_kind = 'card' then
    if not exists (select 1 from public.cards where id = p_id and tutor_id = c) then raise exception 'Card not found.'; end if;
    if p_action in ('hide', 'remove') then
      delete from public.cards where id = p_id;
    elsif p_action = 'fix' then
      update public.cards set front_md = coalesce(nullif(btrim(f ->> 'front'), ''), front_md), back_md = coalesce(f ->> 'back', back_md) where id = p_id;
    end if;
  elsif p_kind = 'practice_paper' then
    -- a whole practice paper (Admin → Content → Browse): put it up with every question approved, hide it, or remove it
    select id into v_paper from public.assignments where id = p_id and tutor_id = c and source = 'studybridge';
    if v_paper is null then raise exception 'Paper not found.'; end if;
    if p_action = 'remove' then
      if exists (select 1 from public.attempts where assignment_id = v_paper) then
        raise exception 'Students have already taken this paper. Hide it instead.';
      end if;
      delete from public.assignments where id = v_paper;
    elsif p_action = 'hide' then
      -- no longer a draft either, so passing its checks later doesn't put it back up by itself
      update public.assignments set visibility = 'hidden', draft = false, updated_at = now() where id = v_paper;
    elsif p_action = 'approve' then
      if not exists (select 1 from public.questions where assignment_id = v_paper) then raise exception 'This paper has no questions left.'; end if;
      update public.question_keys qk set check_result = coalesce(qk.check_result, '{}') || jsonb_build_object('state', 'approved', 'by_owner', now(), 'at', now())
        from public.questions qq
       where qq.id = qk.question_id and qq.assignment_id = v_paper and coalesce(qk.check_result ->> 'state', '') not in ('passed', 'approved');
      update public.assignments set visibility = 'visible', draft = false, updated_at = now() where id = v_paper;
    else
      raise exception 'Fix a paper one question at a time.';
    end if;
  else
    raise exception 'Unknown kind.';
  end if;
  perform public._admin_log('content_' || p_action, c, jsonb_build_object('kind', p_kind, 'id', p_id));
end $$;

-- Admin → Content → Browse: everything the content account has made (practice questions, lessons, flashcards and
-- practice papers), newest first, narrowed by subject, kind, status (live, waiting, problems, hidden) and words.
-- Counts per status are for the subject, kind and words chosen, so the status filter can show them.
create or replace function public.admin_content_browse(p_subject uuid default null, p_kind text default null, p_status text default null,
  p_search text default null, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c uuid := public._studybridge_account();
  v_q text := lower(nullif(btrim(coalesce(p_search, '')), ''));
  v_kind text := nullif(p_kind, '');
  v_status text := nullif(p_status, '');
  v_lim int := greatest(1, least(coalesce(p_limit, 100), 300));
begin
  perform public._admin();
  if v_kind is not null and v_kind not in ('question', 'lesson', 'card', 'practice_paper') then raise exception 'Unknown kind.'; end if;
  if v_status is not null and v_status not in ('live', 'waiting', 'problems', 'hidden') then raise exception 'Unknown status.'; end if;
  if c is null then
    return jsonb_build_object('subjects', '[]'::jsonb, 'counts', jsonb_build_object('live', 0, 'waiting', 0, 'problems', 0, 'hidden', 0),
                              'total', 0, 'items', '[]'::jsonb);
  end if;
  return (
    with items as (
      -- practice questions: live once approved; hidden (removed) ones can be approved again
      select 'question'::text as kind, b.id, b.subject_id, b.created_at,
             case when b.status = 'approved' then 'live' when b.status = 'rejected' then 'hidden'
                  when b.check_result ->> 'state' = 'waiting' then 'waiting' else 'problems' end as status,
             concat_ws(' ', b.topic, b.prompt_md, b.hint_md, b.solution_md) as words
        from public.bank_questions b where b.owner_id = c
      union all
      select 'lesson', l.id, l.subject_id, l.created_at,
             case when coalesce(l.check_result ->> 'state', '') = 'problems' and l.visibility = 'hidden' then 'problems'
                  when not l.draft and l.visibility <> 'hidden' then 'live' else 'hidden' end,
             concat_ws(' ', l.title, l.body_md)
        from public.lessons l where l.tutor_id = c
      union all
      -- StudyBridge's flashcards (never students' own cards); a card is up or gone
      select 'card', k.id, k.subject_id, k.created_at, 'live', concat_ws(' ', k.front_md, k.back_md)
        from public.cards k where k.tutor_id = c and k.learner_id is null
      union all
      select 'practice_paper', a.id, a.subject_id, a.created_at,
             case when exists (select 1 from public.questions q join public.question_keys qk on qk.question_id = q.id
                                where q.assignment_id = a.id and qk.check_result ->> 'state' in ('problems', 'failed', 'compare')) then 'problems'
                  when a.draft and exists (select 1 from public.questions q join public.question_keys qk on qk.question_id = q.id
                                            where q.assignment_id = a.id and qk.check_result ->> 'state' = 'waiting') then 'waiting'
                  when not a.draft and a.visibility = 'visible' then 'live' else 'hidden' end,
             concat_ws(' ', a.title, a.instructions_md)
        from public.assignments a where a.tutor_id = c and a.source = 'studybridge'
    ),
    picked as (
      select i.* from items i
       where (p_subject is null or i.subject_id = p_subject) and (v_kind is null or i.kind = v_kind)
         and (v_q is null or strpos(lower(i.words), v_q) > 0)
    ),
    shown as (
      select p.* from picked p where v_status is null or p.status = v_status order by p.created_at desc limit v_lim
    )
    select jsonb_build_object(
      'subjects', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'board', s.board, 'level', s.level, 'live', s.live,
                     'items', (select count(*) from items i where i.subject_id = s.id)) order by s.position, s.name)
                   from public.subjects s where s.tutor_id = c), '[]'::jsonb),
      'counts', (select jsonb_build_object('live', count(*) filter (where status = 'live'), 'waiting', count(*) filter (where status = 'waiting'),
                   'problems', count(*) filter (where status = 'problems'), 'hidden', count(*) filter (where status = 'hidden')) from picked),
      'total', (select count(*) from picked where v_status is null or status = v_status),
      'items', coalesce((select jsonb_agg(z.item order by z.created_at desc) from (
          select sh.created_at, jsonb_build_object('kind', sh.kind, 'id', sh.id, 'status', sh.status, 'subject_id', sh.subject_id,
                   'subject', (select name from public.subjects where id = sh.subject_id), 'created_at', sh.created_at)
                 || coalesce(case sh.kind
                      when 'question' then (select jsonb_build_object('topic', b.topic, 'type', b.type, 'prompt', b.prompt_md, 'options', b.options,
                          'marks', b.marks, 'answer', b.answer, 'hint', b.hint_md, 'solution', b.solution_md, 'mark_scheme', b.mark_scheme_md,
                          'check', b.check_result, 'uses', b.uses) from public.bank_questions b where b.id = sh.id)
                      when 'lesson' then (select jsonb_build_object('topic', tp.name, 'title', l.title, 'body', l.body_md, 'check', l.check_result,
                          'updated_at', l.updated_at) from public.lessons l left join public.topics tp on tp.id = l.topic_id where l.id = sh.id)
                      when 'card' then (select jsonb_build_object('topic', tp.name, 'front', k.front_md, 'back', k.back_md)
                          from public.cards k left join public.topics tp on tp.id = k.topic_id where k.id = sh.id)
                      else (select jsonb_build_object('title', a.title, 'minutes', a.time_limit_min,
                          'taken', (select count(*) from public.attempts t where t.assignment_id = a.id),
                          'marks', (select coalesce(sum(q.marks), 0) from public.questions q where q.assignment_id = a.id),
                          'questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'number', q.position + 1, 'topic', tp.name, 'type', q.type,
                              'prompt', q.prompt_md, 'options', q.options, 'marks', q.marks, 'answer', qk.answer, 'solution', qk.solution_md,
                              'mark_scheme', qk.mark_scheme_md, 'check', qk.check_result) order by q.position)
                            from public.questions q left join public.question_keys qk on qk.question_id = q.id left join public.topics tp on tp.id = q.topic_id
                           where q.assignment_id = a.id), '[]'::jsonb))
                          from public.assignments a where a.id = sh.id)
                    end, '{}'::jsonb) as item
            from shown sh) z), '[]'::jsonb))
  );
end $$;

-- A report is sorted; an optional reply goes to the student as a notification
create or replace function public.admin_report_done(p_report uuid, p_reply text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.content_reports;
begin
  perform public._admin();
  update public.content_reports set done_at = now(), reply = nullif(btrim(coalesce(p_reply, '')), '')
   where id = p_report and done_at is null returning * into r;
  if r.id is null then raise exception 'That report is already sorted.'; end if;
  if r.reply is not null then
    perform public.notify_user(r.reporter_id, 'report_reply', 'StudyBridge looked at your report', left(r.reply, 200), jsonb_build_object('report_id', r.id));
  end if;
end $$;

-- ---------------- paying by card (Stripe Payment Links the Owner makes) ----------------
create or replace function public.admin_set_pay_links(p_monthly text, p_pass text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  if coalesce(btrim(p_monthly), '') <> '' and btrim(p_monthly) !~ '^https://\S+$' then raise exception 'The monthly link must start with https://'; end if;
  if coalesce(btrim(p_pass), '') <> '' and btrim(p_pass) !~ '^https://\S+$' then raise exception 'The exam pass link must start with https://'; end if;
  update public.app_config set pay_link_monthly = nullif(btrim(coalesce(p_monthly, '')), ''), pay_link_pass = nullif(btrim(coalesce(p_pass, '')), '')
   where id = 1;
end $$;

create or replace function public.student_pay_links() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  -- students on their own, and parents (who can pay for a child studying on their own)
  if not coalesce((select self_learner or role = 'parent' from public.profiles where id = auth.uid()), false) then return '{}'::jsonb; end if;
  return (select jsonb_build_object('monthly', pay_link_monthly, 'pass', pay_link_pass) from public.app_config where id = 1);
end $$;

-- ---------------------------------------------------------------------
-- Basic fixes (9 Oct 2026): let a learner try again, skip or withdraw a weekly report, clear your own practice,
-- a parent stops following a child
-- ---------------------------------------------------------------------
-- The tutor reopens a handed-in attempt (for example one handed in by accident): the answers stay, marks are cleared,
-- and a timed one gets the time it had left (at least 5 minutes). The learner hands it in again.
create or replace function public.reopen_attempt(p_attempt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.attempts;
  a public.assignments;
  v_left int;
begin
  select * into t from public.attempts where id = p_attempt and tutor_id = auth.uid() for update;
  if t.id is null then raise exception 'Not found.'; end if;
  if t.status = 'in_progress' then raise exception 'They’re still working on it.'; end if;
  select * into a from public.assignments where id = t.assignment_id;
  if a.time_limit_min is not null then
    v_left := greatest(300, a.time_limit_min * 60 - coalesce(t.time_spent_sec, 0));
  end if;
  update public.attempts
     set status = 'in_progress', submitted_at = null, score = null, released = false, released_at = null,
         auto_reason = null, strikes = 0, self_marked_at = null,
         started_at = case when a.time_limit_min is null then started_at
                           else now() - make_interval(secs => a.time_limit_min * 60 - v_left) end
   where id = t.id;
  update public.responses set marks = null, auto_marks = null, step_marks = '[]', mistake = null, self_marks = null
   where attempt_id = t.id;
  perform public.notify_user(t.learner_id, 'assignment', 'You can carry on with ' || a.title,
    'Your tutor reopened it. Your answers are still there; hand it in again when you’re done.', jsonb_build_object('assignment_id', a.id));
end $$;

-- Weekly reports: a finished week can be skipped (it stops waiting); an approved one can be withdrawn to fix it
do $$ begin
  alter table public.parent_reports drop constraint if exists parent_reports_status_check;
  alter table public.parent_reports add constraint parent_reports_status_check check (status in ('draft', 'sent', 'skipped'));
exception when duplicate_object then null; end $$;

create or replace function public.skip_report(p_report uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.parent_reports set status = 'skipped', updated_at = now()
   where id = p_report and tutor_id = auth.uid() and status = 'draft';
  if not found then raise exception 'Report not found.'; end if;
end $$;

create or replace function public.withdraw_report(p_report uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.parent_reports set status = 'draft', sent_at = null, sent_via = null, updated_at = now()
   where id = p_report and tutor_id = auth.uid() and status = 'sent';
  if not found then raise exception 'Report not found.'; end if;
end $$;

-- Practice a learner started themselves can be cleared from their list (their progress keeps it)
alter table public.assignments add column if not exists learner_hidden boolean not null default false;
create or replace function public.hide_my_practice(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.assignments set learner_hidden = true
   where id = any (coalesce(p_ids, '{}')) and source = 'self' and learner_ids = array[auth.uid()];
  get diagnostics n = row_count;
  return n;
end $$;

-- A parent stops following a child; the tutor is told
create or replace function public.parent_unlink(p_learner uuid) returns void
language plpgsql security definer set search_path = public as $$
declare pl public.parent_links;
begin
  delete from public.parent_links where parent_id = auth.uid() and learner_id = p_learner returning * into pl;
  if pl.id is null then raise exception 'Not found.'; end if;
  perform public.notify_user(pl.tutor_id, 'parent_removed',
    coalesce((select display_name from public.profiles where id = auth.uid()), 'A parent') || ' stopped following '
      || coalesce((select display_name from public.profiles where id = pl.learner_id), 'a learner'), null, jsonb_build_object('learner_id', pl.learner_id));
end $$;

-- =====================================================================
-- Launch 1, parts 3 and 4 (19 Oct 2026): the starting check, exam conditions, parents for young students and for
-- students on their own, test students for the Owner, the free trial checked on the server, and which subjects
-- are open (for the website)
-- =====================================================================
alter table public.assignments add column if not exists starting_check boolean not null default false;
alter table public.attempts add column if not exists left_full_screen int not null default 0;

-- Students on their own use StudyBridge's content during the free week, once they've paid, or as the Owner's test
-- student. Everyone else (tutors' learners, tutors, parents) is never affected.
create or replace function public._student_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select not p.self_learner or p.test_student or coalesce(p.trial_until > now(), false) or coalesce(p.paid_until >= current_date, false)
                     from public.profiles p where p.id = auth.uid()), true)
$$;

-- What a learner may see (files, lessons, assignments and their questions): now also the free week or a plan
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
    and public._student_ok()
$$;

-- Shared flashcards too (a student's own cards and cards from their mistakes always stay theirs)
drop policy if exists cards_learner_read on public.cards;
create policy cards_learner_read on public.cards for select using (
  tutor_id = public.my_tutor() and public.my_role() = 'learner'
  and (learner_id = auth.uid()
       or (learner_id is null and public._student_ok()
           and (subject_id is null or exists (select 1 from public.learner_subjects ls where ls.learner_id = auth.uid() and ls.subject_id = cards.subject_id)))));

-- Practice a student starts themselves (daily quiz, topics, drills, the starting check) needs the free week or a plan
create or replace function public._self_practice_ok() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'self' and not public._student_ok() then
    raise exception 'Your free week is over. Choose a plan in Settings to keep practising.';
  end if;
  return new;
end $$;
drop trigger if exists assignments_self_ok on public.assignments;
create trigger assignments_self_ok before insert on public.assignments for each row execute function public._self_practice_ok();

-- The starting check for each of my subjects: done (with the score), or started and not finished
create or replace function public.my_starting_checks() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(z.subject_id, jsonb_build_object('assignment_id', z.id, 'attempt_id', z.attempt_id,
           'done', z.submitted_at is not null, 'score', z.score, 'max', z.max_score, 'at', z.submitted_at)), '{}')
  from (select distinct on (a.subject_id) a.subject_id, a.id, t.id as attempt_id, t.submitted_at, t.score, t.max_score
          from public.assignments a
          left join lateral (select * from public.attempts x where x.assignment_id = a.id and x.learner_id = auth.uid()
                              order by x.number desc limit 1) t on true
         where a.starting_check and a.learner_ids = array[auth.uid()] and a.subject_id is not null
         order by a.subject_id, (t.submitted_at is not null) desc, coalesce(t.submitted_at, a.created_at) desc) z
$$;

-- Exam conditions (students on their own, in a browser): each time they leave full screen is counted on the attempt
create or replace function public.note_left_full_screen(p_attempt uuid) returns int
language sql security definer set search_path = public as $$
  update public.attempts set left_full_screen = left_full_screen + 1
   where id = p_attempt and learner_id = auth.uid() and status = 'in_progress'
  returning left_full_screen
$$;

-- A new account becomes a parent without a tutor's code: to set up a child who studies on their own
create or replace function public.start_parent(p_name text, p_timezone text default 'UTC') returns public.profiles
language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into v from public.profiles where id = auth.uid();
  if v.role = 'parent' then return v; end if;
  if v.role is not null then raise exception 'This account is already a % account. Use a different email for the parent account.', v.role; end if;
  update public.profiles
     set role = 'parent', tutor_id = null, programme_id = null,
         display_name = coalesce(nullif(trim(coalesce(p_name, '')), ''), nullif(display_name, ''), 'Parent'),
         timezone = coalesce(nullif(p_timezone, ''), timezone)
   where id = auth.uid() returning * into v;
  return v;
end $$;

-- The parent makes a code for their child to sign up with (8 digits). Below grade 8 the child needs one; it links
-- them to the parent's account and records the parent's consent.
create or replace function public.parent_child_code(p_name text, p_grade int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.child_codes;
  c text;
begin
  if public.my_role() is distinct from 'parent' then raise exception 'This is for parent accounts.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Add your child’s first name.'; end if;
  if p_grade is null or p_grade < 1 or p_grade > 13 then raise exception 'Choose your child’s grade.'; end if;
  if (select count(*) from public.child_codes where parent_id = auth.uid() and used_by is null) >= 5 then
    raise exception 'You already have 5 codes waiting to be used. Cancel one first.';
  end if;
  loop
    c := lpad((floor(random() * 100000000))::bigint::text, 8, '0');
    exit when not exists (select 1 from public.child_codes where code = c);
  end loop;
  insert into public.child_codes (parent_id, code, name, grade) values (auth.uid(), c, left(trim(p_name), 80), p_grade)
  returning * into v;
  return jsonb_build_object('id', v.id, 'code', v.code, 'name', v.name, 'grade', v.grade, 'created_at', v.created_at);
end $$;

create or replace function public.parent_child_codes() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'grade', grade, 'created_at', created_at) order by created_at), '[]')
    from public.child_codes where parent_id = auth.uid() and used_by is null
$$;

create or replace function public.parent_cancel_child_code(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.child_codes where id = p_id and parent_id = auth.uid() and used_by is null;
  if not found then raise exception 'Not found.'; end if;
end $$;

-- A student on their own (grade 8 and up) gives a parent a code to follow their progress
create or replace function public.self_parent_invite(p_name text default null) returns public.parent_invites
language plpgsql security definer set search_path = public as $$
declare
  me public.profiles;
  v public.parent_invites;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or not me.self_learner then raise exception 'This is for students studying on their own.'; end if;
  if (select count(*) from public.parent_invites where learner_id = me.id and accepted_by is null and not revoked) >= 5 then
    raise exception 'You already have 5 parent codes waiting. Cancel one first.';
  end if;
  insert into public.parent_invites (tutor_id, learner_id, name) values (me.tutor_id, me.id, left(trim(coalesce(p_name, '')), 80))
  returning * into v;
  return v;
end $$;

-- Children's privacy: the parent who set up a young child's account can close it, with everything in it
create or replace function public.parent_delete_child(p_learner uuid, p_confirm text) returns void
language plpgsql security definer set search_path = public as $$
declare l public.profiles;
begin
  select * into l from public.profiles where id = p_learner;
  if l.id is null or l.consent_parent is distinct from auth.uid() or public.my_role() is distinct from 'parent' then
    raise exception 'Only the parent who set up this account can close it.';
  end if;
  if upper(trim(coalesce(p_confirm, ''))) <> 'DELETE' then raise exception 'Type DELETE to confirm.'; end if;
  delete from auth.users where id = l.id;
end $$;

-- The parent's children (again, now saying who studies on their own)
create or replace function public.parent_children() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.display_name, 'tutor', t.display_name, 'timezone', l.timezone, 'self', l.self_learner, 'set_up_by_me', l.consent_parent = auth.uid(),
      'next_lesson', (select min(s.starts_at) from public.sessions s where s.tutor_id = pl.tutor_id and l.id = any (s.learner_ids)
                       and not s.cancelled and s.starts_at > now()),
      'reports', (select count(*) from public.parent_reports r where r.learner_id = l.id and r.tutor_id = pl.tutor_id and r.status = 'sent'),
      'latest_report', (select max(r.week_start) from public.parent_reports r where r.learner_id = l.id and r.tutor_id = pl.tutor_id and r.status = 'sent'))
      order by l.display_name), '[]')
    from public.parent_links pl
    join public.profiles l on l.id = pl.learner_id and l.role = 'learner' and l.tutor_id = pl.tutor_id
    join public.profiles t on t.id = pl.tutor_id
   where pl.parent_id = auth.uid() and public.my_role() = 'parent'
$$;

-- The website: which catalogue subjects students can start now (shown on the subjects list)
create or replace function public.open_subjects() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(s.catalogue order by s.catalogue), '[]')
    from public.subjects s
   where s.tutor_id = public._studybridge_account() and s.live and s.catalogue is not null
     and not (select students_paused from public.app_config where id = 1)
$$;
grant execute on function public.open_subjects() to anon;

-- The Owner's test students: emails that can sign up as a student while sign-up is closed, see subjects that
-- aren't open yet, and never need to pay (Admin → Students → Try it as a student)
create or replace function public.admin_set_test_emails(p_emails text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v text[];
begin
  perform public._admin();
  select coalesce(array_agg(distinct lower(trim(e))), '{}') into v
    from unnest(coalesce(p_emails, '{}')) e where trim(e) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';
  if cardinality(v) > 10 then raise exception 'Up to 10 test emails.'; end if;
  update public.app_config set test_emails = v where id = 1;
  update public.profiles set test_student = (lower(email) = any (v)) where self_learner;
  perform public._admin_log('test_students', null, jsonb_build_object('emails', v));
  return to_jsonb(v);
end $$;

-- =====================================================================
-- Daily study reminder (20 Oct 2026). A learner picks a time; if they haven't studied that day by then, they get a
-- nudge: in StudyBridge, on their phone through ntfy (if phone alerts are on), and as the browser's own notification
-- (web push) on each device where they switched it on. The push carries no message, so there's nothing to encrypt:
-- the device shows StudyBridge's fixed reminder (public/sw.js). Prof sends the pushes, signed with StudyBridge's own
-- key pair, which Prof makes the first time it's needed (nobody pastes a key).
-- =====================================================================
alter table public.profiles add column if not exists remind_on boolean not null default false;
alter table public.profiles add column if not exists remind_time time not null default '17:00'; -- the learner's own clock
alter table public.profiles add column if not exists reminded_on date;                          -- the learner's own day
alter table public.app_config add column if not exists vapid_public text;        -- the public half: the app needs it to subscribe
alter table public.platform_secrets add column if not exists vapid_private text; -- the private half (a JWK): only Prof reads it

-- Devices that get the reminder as a browser notification. Only through the functions below, each person their own.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text,
  auth text,
  created_at timestamptz not null default now()
);
create index if not exists idx_push_subscriptions_user on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;

-- Pushes waiting for Prof to send (it tries each up to 3 times; a reminder more than 6 hours late isn't sent)
create table if not exists public.push_outbox (
  id bigserial primary key,
  subscription_id uuid not null references public.push_subscriptions (id) on delete cascade,
  created_at timestamptz not null default now(),
  lease_until timestamptz,
  tries int not null default 0,
  sent_at timestamptz,
  error text
);
create index if not exists idx_push_outbox_waiting on public.push_outbox (id) where sent_at is null;
alter table public.push_outbox enable row level security;
revoke all on public.push_outbox from public, anon, authenticated;

-- My reminder: on or off, the time, and whether this device (its push address) gets it
create or replace function public.my_study_reminder(p_endpoint text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me public.profiles;
  v_tz text;
  v_today date;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then return null; end if;
  v_tz := public._tz_of(me.id);
  v_today := (now() at time zone v_tz)::date;
  return jsonb_build_object(
    'on', me.remind_on,
    'time', to_char(me.remind_time, 'HH24:MI'),
    'timezone', v_tz,
    -- reminded already, or studied already: the next one is tomorrow
    'today_done', coalesce(me.reminded_on >= v_today, false)
                  or exists (select 1 from public.activity a where a.learner_id = me.id and a.day = v_today),
    'devices', (select count(*) from public.push_subscriptions s where s.user_id = me.id),
    'this_device', p_endpoint is not null
                   and exists (select 1 from public.push_subscriptions s where s.user_id = me.id and s.endpoint = p_endpoint));
end $$;

create or replace function public.set_study_reminder(p_on boolean, p_time text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me public.profiles;
  v_on boolean;
  v_time time;
  v_local timestamp;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or me.role is distinct from 'learner' then raise exception 'The daily study reminder is for learners.'; end if;
  if p_time is not null and trim(p_time) !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Choose a time like 17:00.';
  end if;
  v_on := coalesce(p_on, me.remind_on);
  v_time := coalesce(trim(p_time)::time, me.remind_time);
  v_local := now() at time zone public._tz_of(me.id);
  update public.profiles
     set remind_on = v_on, remind_time = v_time,
         -- switched on (or moved) after today's time has already gone by: the first reminder is tomorrow
         reminded_on = case when v_on and (not me.remind_on or me.remind_time <> v_time)
                                 and v_local::time >= least(v_time, time '23:50')
                            then v_local::date else reminded_on end
   where id = me.id;
  -- off: forget this account's devices (each one is set up again when it's switched back on there)
  if not v_on then delete from public.push_subscriptions where user_id = me.id; end if;
  return public.my_study_reminder(null);
end $$;

-- This device's push address, from the browser. Only the browsers' own push services (Chrome and Android, Firefox,
-- Safari and iPhone, Edge), so Prof never posts anywhere else. An address another account saved can only be taken
-- over from that same browser (its secret matches): a shared computer moves the reminder to whoever switched it on last.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.push_subscriptions;
begin
  if public.my_role() is distinct from 'learner' then raise exception 'The daily study reminder is for learners.'; end if;
  if p_endpoint is null or length(p_endpoint) > 1000
     or p_endpoint !~ '^https://([a-z0-9-]+\.)*(googleapis\.com|mozilla\.com|push\.apple\.com|notify\.windows\.com)(:[0-9]+)?/' then
    raise exception 'This browser’s notifications can’t be used for reminders.';
  end if;
  select * into v from public.push_subscriptions where endpoint = p_endpoint;
  if v.id is not null and v.user_id <> auth.uid() and v.auth is distinct from p_auth then
    raise exception 'This browser’s notifications can’t be used for reminders.';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
  -- the 10 newest devices are plenty
  delete from public.push_subscriptions where user_id = auth.uid() and id not in
    (select id from public.push_subscriptions where user_id = auth.uid() order by created_at desc limit 10);
  return jsonb_build_object('devices', (select count(*) from public.push_subscriptions where user_id = auth.uid()));
end $$;

create or replace function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- "Send me a test": the reminder right now, everywhere it would go
create or replace function public.send_test_reminder() returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if public.my_role() is distinct from 'learner' then raise exception 'The daily study reminder is for learners.'; end if;
  if exists (select 1 from public.notifications where user_id = auth.uid() and kind = 'study_reminder'
              and ref @> '{"test": true}' and created_at > now() - interval '30 seconds') then
    raise exception 'A test is on its way. Give it a moment to arrive.';
  end if;
  perform public.notify_user(auth.uid(), 'study_reminder', 'Time for StudyBridge', 'A few minutes today keeps your streak going.', '{"test": true}');
  insert into public.push_outbox (subscription_id) select id from public.push_subscriptions where user_id = auth.uid();
  get diagnostics n = row_count;
  perform public._prof_kick();
  return jsonb_build_object('devices', n);
end $$;

-- StudyBridge's public push key (empty until Prof has made the pair; the app then asks Prof)
create or replace function public.push_key() returns text
language sql stable security definer set search_path = public as $$
  select vapid_public from public.app_config where id = 1
$$;

-- Every 10 minutes (pg_cron): learners whose own clock has reached their time today, who haven't been reminded
-- today and haven't studied today. Once a day each. (A time after 23:50 counts as 23:50, the day's last run.)
-- p_now is for the tests.
create or replace function public._study_reminders(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    with zones as materialized (select name from pg_timezone_names),
    due as (select p.id, p.remind_time, p.reminded_on, (p_now at time zone coalesce(z.name, 'UTC')) as local_now
              from public.profiles p left join zones z on z.name = p.timezone
             where p.role = 'learner' and p.remind_on
               -- a student on their own whose free week is over (and nothing paid) isn't nudged to study
               and (not p.self_learner or p.test_student or coalesce(p.trial_until > p_now, false) or coalesce(p.paid_until >= current_date, false)))
    select d.id, d.local_now::date as today from due d
     where d.local_now::time >= least(d.remind_time, time '23:50')
       and (d.reminded_on is null or d.reminded_on < d.local_now::date)
       and not exists (select 1 from public.activity a where a.learner_id = d.id and a.day = d.local_now::date)
  loop
    -- once a day, even if two runs overlap
    update public.profiles set reminded_on = r.today where id = r.id and (reminded_on is null or reminded_on < r.today);
    continue when not found;
    perform public.notify_user(r.id, 'study_reminder', 'Time for StudyBridge', 'A few minutes today keeps your streak going.', '{}');
    insert into public.push_outbox (subscription_id) select id from public.push_subscriptions where user_id = r.id;
    n := n + 1;
  end loop;
  delete from public.push_outbox where created_at < now() - interval '3 days';
  -- wake Prof to send them (and anything an earlier run couldn't)
  if exists (select 1 from public.push_outbox where sent_at is null and tries < 3 and created_at > now() - interval '6 hours') then
    perform public._prof_kick();
  end if;
  return n;
end $$;

-- Prof only: StudyBridge's push key pair. Prof makes it the first time it's needed; the first one saved is kept.
create or replace function public._push_keys(p_public text default null, p_private text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.platform_secrets where id = 1 for update;
  if p_public is not null and p_private is not null and (select vapid_private from public.platform_secrets where id = 1) is null then
    update public.platform_secrets set vapid_private = p_private where id = 1;
    update public.app_config set vapid_public = p_public where id = 1;
  end if;
  return (select jsonb_build_object('public', c.vapid_public, 'private', s.vapid_private)
            from public.app_config c, public.platform_secrets s where c.id = 1 and s.id = 1);
end $$;

-- Prof only: the next pushes to send (each handed out once at a time), and who StudyBridge is to the push services
create or replace function public._push_claim(p_limit int default 100) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  with c as (
    update public.push_outbox o set lease_until = now() + interval '2 minutes', tries = o.tries + 1
     where o.id in (select x.id from public.push_outbox x
                     where x.sent_at is null and x.tries < 3 and x.created_at > now() - interval '6 hours'
                       and (x.lease_until is null or x.lease_until < now())
                     order by x.id limit greatest(1, least(coalesce(p_limit, 100), 500)) for update skip locked)
    returning o.id, o.subscription_id)
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'endpoint', s.endpoint) order by c.id), '[]') into v
    from c join public.push_subscriptions s on s.id = c.subscription_id;
  return jsonb_build_object('pushes', v,
    'contact', 'mailto:' || coalesce((select nullif(trim(support_email), '') from public.app_config where id = 1), 'support@gostudybridge.com'));
end $$;

-- Prof only: how a push went. 404 or 410 means the browser stopped that subscription, so the device is forgotten.
create or replace function public._push_done(p_id bigint, p_status int, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status between 200 and 299 then
    update public.push_outbox set sent_at = now(), lease_until = null, error = null where id = p_id;
  elsif p_status in (404, 410) then
    delete from public.push_subscriptions where id = (select subscription_id from public.push_outbox where id = p_id);
  else
    update public.push_outbox set lease_until = null, error = left(coalesce(nullif(p_error, ''), 'Push service said ' || coalesce(p_status, 0)), 300)
     where id = p_id;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- One StudyBridge library (20 Oct 2026): everything StudyBridge makes comes from the content account (made in
-- Claude Desktop, checked twice), for students on their own and for tutors. Tutors find its checked practice
-- questions in their question bank (for the exams their subjects are for; they can't change them), their learners
-- practise with them, and its practice papers can be copied into a draft test. The old shared bank (owner_id null)
-- and Prof's StudyBridge papers (sb_papers) no longer reach tutors.
-- ---------------------------------------------------------------------
-- The exam a content subject is for, as 'cie:0607' or 'ib:math-aa' (the codes tutors pick for their subjects): its
-- own exam, else its Cambridge code, else (IB) its name in the app's IB list (src/lib/exams.js)
create or replace function public._subject_exam(s public.subjects) returns text
language sql stable set search_path = public as $$
  select coalesce(s.exam,
    case when coalesce(s.board, '') ilike 'cambridge%' and btrim(coalesce(s.code, '')) ~* '^[0-9a-z]{4}$' then 'cie:' || lower(btrim(s.code)) end,
    case when coalesce(s.board, '') ilike 'ib%' or coalesce(s.catalogue, '') like 'ib:%' then
      (select 'ib:' || x.code from (values
          ('math-aa', 'mathematics: analysis and approaches'), ('math-ai', 'mathematics: applications and interpretation'),
          ('physics', 'physics'), ('chemistry', 'chemistry'), ('biology', 'biology'), ('computer-science', 'computer science'),
          ('design-tech', 'design technology'), ('sehs', 'sports, exercise and health science'), ('ess', 'environmental systems and societies'),
          ('economics', 'economics'), ('business', 'business management'), ('geography', 'geography'), ('history', 'history'),
          ('psychology', 'psychology'), ('global-politics', 'global politics'), ('digital-society', 'digital society'),
          ('philosophy', 'philosophy'), ('sca', 'social and cultural anthropology'), ('world-religions', 'world religions'),
          ('english-a-lit', 'english a: literature'), ('english-a-langlit', 'english a: language and literature'), ('english-b', 'english b'),
          ('french-b', 'french b'), ('spanish-b', 'spanish b'), ('german-b', 'german b'), ('mandarin-b', 'mandarin b'),
          ('french-ab', 'french ab initio'), ('spanish-ab', 'spanish ab initio'), ('mandarin-ab', 'mandarin ab initio'),
          ('visual-arts', 'visual arts'), ('music', 'music'), ('theatre', 'theatre'), ('film', 'film')) x(code, name)
        where x.name = lower(regexp_replace(btrim(s.name), '^IB\s+', '', 'i'))) end)
$$;

-- Who gets StudyBridge's library: every active tutor for now (not the content account itself: it's its own content).
-- Later only tutors on the Plus plan: check the tutor's plan here. Gives the content account to read from, or null.
create or replace function public._sb_library(p_tutor uuid default null) returns uuid
language sql stable security definer set search_path = public as $$
  select c from (select public._studybridge_account() as c) x
   where c is not null and c is distinct from coalesce(p_tutor, auth.uid()) and public._tutor_active(coalesce(p_tutor, auth.uid()))
$$;

-- Content questions carry their subject's exam, so tutors' subjects match them; older ones are filled in here
update public.bank_questions b
   set exam_code = split_part(public._subject_exam(s), ':', 2), exam_board = split_part(public._subject_exam(s), ':', 1)
  from public.subjects s
 where b.exam_code is null and b.owner_id = public._studybridge_account() and s.id = b.subject_id and s.tutor_id = b.owner_id
   and public._subject_exam(s) is not null;

-- Tutors read StudyBridge's checked questions for the exams their subjects are for. Reading only: bank_own lets a
-- tutor change just their own questions.
drop policy if exists bank_studybridge_read on public.bank_questions;
create policy bank_studybridge_read on public.bank_questions for select
  using (status = 'approved' and owner_id = public._sb_library()
         and exam_code in (select split_part(s.exam, ':', 2) from public.subjects s where s.tutor_id = auth.uid() and s.exam is not null));

-- StudyBridge's practice papers for one exam ('cie:0607' or just '0607'), for a tutor to look through and copy: the
-- ones that are up for students (every question passed its checks, or the Owner put it up), with answers and mark schemes
create or replace function public.studybridge_papers(p_exam text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c uuid := public._sb_library();
  v_exam text := lower(btrim(coalesce(p_exam, '')));
begin
  if not public._tutor_active() then raise exception 'StudyBridge’s practice papers are for tutors.'; end if;
  if c is null or v_exam = '' then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'minutes', a.time_limit_min,
      'instructions', a.instructions_md, 'subject', s.name, 'exam', public._subject_exam(s), 'created_at', a.created_at,
      'marks', (select coalesce(sum(q.marks), 0) from public.questions q where q.assignment_id = a.id),
      'questions', coalesce((select jsonb_agg(jsonb_build_object('number', q.position + 1, 'type', q.type, 'prompt', q.prompt_md,
          'options', q.options, 'marks', q.marks, 'topic', tp.name, 'answer', k.answer, 'mark_scheme', k.mark_scheme_md,
          'solution', k.solution_md) order by q.position)
        from public.questions q left join public.question_keys k on k.question_id = q.id left join public.topics tp on tp.id = q.topic_id
       where q.assignment_id = a.id), '[]'::jsonb))
    order by a.created_at)
    from public.assignments a join public.subjects s on s.id = a.subject_id
   where a.tutor_id = c and a.source = 'studybridge' and not a.draft and a.visibility = 'visible'
     and exists (select 1 from public.questions q where q.assignment_id = a.id)
     and (public._subject_exam(s) = v_exam or split_part(public._subject_exam(s), ':', 2) = v_exam)), '[]'::jsonb);
end $$;

-- Copy one into a draft test of the tutor's own (hidden until they check and post it), in their subject for that
-- exam: the questions with their answers, mark schemes and worked solutions. The tutor marks it, so the "mark it
-- yourself" line goes; the "Not affiliated with or endorsed by" line stays.
create or replace function public.copy_studybridge_paper(p_assignment uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  c uuid := public._sb_library();
  a public.assignments;
  v_code text;
  v_subject uuid;
  v_id uuid;
  q record;
  qid uuid;
begin
  if not public._tutor_active() then raise exception 'StudyBridge’s practice papers are for tutors.'; end if;
  select * into a from public.assignments
   where id = p_assignment and c is not null and tutor_id = c and source = 'studybridge' and not draft and visibility = 'visible';
  if a.id is null then raise exception 'That practice paper isn’t available.'; end if;
  select split_part(public._subject_exam(s), ':', 2) into v_code from public.subjects s where s.id = a.subject_id;
  select id into v_subject from public.subjects
   where tutor_id = me and exam is not null and split_part(exam, ':', 2) = v_code order by position, created_at limit 1;
  insert into public.assignments (tutor_id, kind, title, instructions_md, subject_id, visibility, draft, source, show_answers, time_limit_min)
  values (me, 'test', a.title, btrim(replace(a.instructions_md, ' When you hand it in, mark it yourself with the mark scheme.', '')),
          v_subject, 'hidden', true, 'studybridge', true, a.time_limit_min)
  returning id into v_id;
  for q in select q2.position, q2.type, q2.prompt_md, q2.options, q2.marks, tp.name as topic, k.answer, k.mark_scheme_md, k.solution_md
             from public.questions q2 left join public.question_keys k on k.question_id = q2.id left join public.topics tp on tp.id = q2.topic_id
            where q2.assignment_id = a.id order by q2.position loop
    insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, options, marks, topic_id)
    values (v_id, me, q.position, q.type, q.prompt_md, q.options, q.marks,
            (select t.id from public.topics t where t.tutor_id = me and t.subject_id = v_subject and lower(t.name) = lower(q.topic) limit 1))
    returning id into qid;
    insert into public.question_keys (question_id, tutor_id, answer, mark_scheme_md, solution_md)
    values (qid, me, coalesce(q.answer, '{}'::jsonb), q.mark_scheme_md, q.solution_md);
  end loop;
  return v_id;
end $$;

-- =====================================================================
-- Launch 2, part 1 (22 Oct 2026): organisations and classes.
-- Organisations sit underneath everything. Every tutor is in one (their own, made for them); a tuition centre is
-- one with several tutors and a centre manager; students on their own are in StudyBridge's (their "tutor" is the
-- content account). A learner belongs to their tutor's organisation. Approval doesn't change: in a centre each
-- tutor approves everything for their own learners, and the manager only looks.
-- Classes are a tutor's teaching groups. Work, lesson notes, files and live lessons can be for a class: whoever is
-- in it gets them (joining later included). learner_ids is kept in step, so every rule that reads it still works.
-- =====================================================================
create table if not exists public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'tutor' check (kind in ('tutor', 'centre', 'school', 'studybridge')),
  join_code text unique,
  created_at timestamptz not null default now()
);
create table if not exists public.org_members (
  org_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'tutor' check (role in ('manager', 'tutor')),
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create unique index if not exists org_members_one_each on public.org_members (user_id); -- one organisation each, for now
alter table public.organisations enable row level security;
alter table public.org_members enable row level security;
revoke all on public.organisations, public.org_members from public, anon, authenticated; -- only through the functions below

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null,
  subject_id uuid references public.subjects (id) on delete set null,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.class_members (
  class_id uuid not null references public.classes (id) on delete cascade,
  learner_id uuid not null references public.profiles (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (class_id, learner_id)
);
create index if not exists class_members_learner on public.class_members (learner_id);
alter table public.classes enable row level security;
alter table public.class_members enable row level security;
revoke all on public.classes, public.class_members from public, anon, authenticated;
grant select on public.classes, public.class_members to authenticated; -- changes go through save_class and the rest

create or replace function public._class_tutor(p_class uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select tutor_id from public.classes where id = p_class
$$;
create or replace function public._in_class(p_class uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.class_members where class_id = p_class and learner_id = auth.uid())
$$;
drop policy if exists classes_tutor on public.classes;
create policy classes_tutor on public.classes for select using (tutor_id = auth.uid());
drop policy if exists classes_learner on public.classes;
create policy classes_learner on public.classes for select using (public._in_class(id));
drop policy if exists class_members_tutor on public.class_members;
create policy class_members_tutor on public.class_members for select using (public._class_tutor(class_id) = auth.uid());
drop policy if exists class_members_learner on public.class_members;
create policy class_members_learner on public.class_members for select using (learner_id = auth.uid()); -- never the others in it

alter table public.assignments add column if not exists class_id uuid references public.classes (id) on delete set null;
alter table public.lessons add column if not exists class_id uuid references public.classes (id) on delete set null;
alter table public.files add column if not exists class_id uuid references public.classes (id) on delete set null;
alter table public.sessions add column if not exists class_id uuid references public.classes (id) on delete set null;
alter table public.lesson_series add column if not exists class_id uuid references public.classes (id) on delete set null;
alter table public.invites add column if not exists class_ids uuid[] not null default '{}';

-- ---------------- organisations ----------------
-- The organisation someone is in: a tutor's own, a learner's tutor's
create or replace function public._org_of(p_user uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select m.org_id from public.org_members m
   where m.user_id = (select case when p.role = 'learner' then p.tutor_id else p.id end from public.profiles p where p.id = p_user)
$$;

create or replace function public._org_manager(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.org_members m join public.profiles p on p.id = m.user_id
                  where m.org_id = p_org and m.user_id = auth.uid() and m.role = 'manager' and p.role = 'tutor')
$$;

-- Every tutor has an organisation: their own, made the first time it's needed
create or replace function public._ensure_org(p_tutor uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid; p public.profiles;
begin
  select org_id into v from public.org_members where user_id = p_tutor;
  if v is not null then return v; end if;
  select * into p from public.profiles where id = p_tutor;
  if p.id is null or p.role is distinct from 'tutor' then return null; end if;
  insert into public.organisations (name, kind)
  values (case when p.is_studybridge then 'StudyBridge' else coalesce(nullif(trim(p.display_name), ''), 'My') || '’s tutoring' end,
          case when p.is_studybridge then 'studybridge' else 'tutor' end)
  returning id into v;
  insert into public.org_members (org_id, user_id, role) values (v, p_tutor, 'manager');
  return v;
end $$;

-- 8 digits, like a learner's code, never the same as one
create or replace function public._new_org_code() returns text
language plpgsql volatile security definer set search_path = public as $$
declare b bytea; c text;
begin
  loop
    b := extensions.gen_random_bytes(4);
    c := lpad(((get_byte(b, 0)::bigint * 16777216 + get_byte(b, 1) * 65536 + get_byte(b, 2) * 256 + get_byte(b, 3)) % 100000000)::text, 8, '0');
    exit when not exists (select 1 from public.organisations where join_code = c) and not exists (select 1 from public.invites where code = c);
  end loop;
  return c;
end $$;

-- A new tutor gets their own organisation; the content account's is StudyBridge's; a learner who leaves their
-- tutor leaves that tutor's classes
create or replace function public._profile_org() returns trigger
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if new.role = 'tutor' then
    v := public._ensure_org(new.id);
    if tg_op = 'UPDATE' and new.is_studybridge is distinct from old.is_studybridge
       and (select count(*) from public.org_members where org_id = v) = 1 then
      update public.organisations
         set kind = case when new.is_studybridge then 'studybridge' else 'tutor' end,
             name = case when new.is_studybridge then 'StudyBridge' else coalesce(nullif(trim(new.display_name), ''), 'My') || '’s tutoring' end,
             join_code = null
       where id = v;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.tutor_id is distinct from old.tutor_id and old.tutor_id is not null then
    delete from public.class_members m using public.classes c
     where m.learner_id = new.id and c.id = m.class_id
       and (c.tutor_id = old.tutor_id or exists (select 1 from public.class_teachers ct where ct.class_id = c.id and ct.teacher_id = old.tutor_id))
       and (new.tutor_id is null or not exists (select 1 from public.class_teachers ct where ct.class_id = c.id and ct.teacher_id = new.tutor_id));
  end if;
  return null;
end $$;
drop trigger if exists profiles_org on public.profiles;
create trigger profiles_org after insert or update of role, tutor_id, is_studybridge on public.profiles
  for each row execute function public._profile_org();

-- An organisation with nobody left goes; one with no manager left gets its longest-standing tutor as manager
create or replace function public._org_tidy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.org_members where org_id = old.org_id) then
    delete from public.organisations where id = old.org_id;
  elsif not exists (select 1 from public.org_members where org_id = old.org_id and role = 'manager') then
    update public.org_members set role = 'manager'
     where org_id = old.org_id and user_id = (select user_id from public.org_members where org_id = old.org_id order by joined_at limit 1);
  end if;
  return null;
end $$;
drop trigger if exists org_members_tidy on public.org_members;
create trigger org_members_tidy after delete on public.org_members for each row execute function public._org_tidy();

-- Tutors who were here before organisations get theirs now
do $$
declare r record;
begin
  for r in select id from public.profiles where role = 'tutor' loop
    perform public._ensure_org(r.id);
  end loop;
end $$;

-- A tutor's organisation: its name and kind, who's in it, and (for its managers) the code other tutors join with
create or replace function public.my_org() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v uuid; o public.organisations; v_role text;
begin
  if public.my_role() is distinct from 'tutor' then return null; end if;
  v := public._ensure_org(auth.uid());
  select * into o from public.organisations where id = v;
  select role into v_role from public.org_members where org_id = v and user_id = auth.uid();
  return jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind, 'role', v_role,
    'code', case when v_role = 'manager' and o.kind in ('centre', 'school') then o.join_code end,
    'members', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'role', m.role, 'joined_at', m.joined_at,
                   'me', p.id = auth.uid(), 'learners', (select count(*) from public.profiles l where l.tutor_id = p.id and l.role = 'learner'))
                   order by m.role = 'manager' desc, p.display_name), '[]')
                  from public.org_members m join public.profiles p on p.id = m.user_id where m.org_id = v));
end $$;

create or replace function public._org_mine_to_change() returns public.organisations
language plpgsql security definer set search_path = public as $$
declare o public.organisations;
begin
  select * into o from public.organisations where id = public._org_of(auth.uid());
  if o.id is null or public.my_role() is distinct from 'tutor' or not public._org_manager(o.id) then
    raise exception 'Only the manager can change this.';
  end if;
  if o.kind = 'studybridge' then raise exception 'StudyBridge’s own organisation stays as it is.'; end if;
  return o;
end $$;

create or replace function public.org_rename(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.organisations := public._org_mine_to_change();
begin
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Give it a name.'; end if;
  update public.organisations set name = left(trim(p_name), 80) where id = o.id;
  return public.my_org();
end $$;

-- A tutor's own organisation becomes a tuition centre: other tutors join it with its code, and its managers see
-- every tutor and learner in it
create or replace function public.org_make_centre(p_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.organisations := public._org_mine_to_change();
begin
  if not public._tutor_active() then raise exception 'Your account isn’t approved yet.'; end if;
  update public.organisations
     set kind = case when kind = 'tutor' then 'centre' else kind end,
         name = coalesce(left(nullif(trim(coalesce(p_name, '')), ''), 80), name),
         join_code = coalesce(join_code, public._new_org_code())
   where id = o.id;
  return public.my_org();
end $$;

-- A new code (the old one stops working)
create or replace function public.org_new_code() returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.organisations := public._org_mine_to_change();
begin
  if o.kind not in ('centre', 'school') then raise exception 'Make it a centre first.'; end if;
  update public.organisations set join_code = public._new_org_code() where id = o.id;
  return public.my_org();
end $$;

-- A tutor joins a centre with its code, bringing their learners, classes and work (nothing moves or changes hands).
-- A wrong code is counted like a wrong learner code and returns nothing (an error would undo the count).
create or replace function public.org_join(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c text := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
  o public.organisations;
  mine uuid;
  me text := (select display_name from public.profiles where id = auth.uid());
begin
  if not public._tutor_active() then raise exception 'Only an approved tutor can join a centre.'; end if;
  if (select count(*) from public.invite_tries where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many wrong codes. Wait an hour, or ask the centre for its code again.';
  end if;
  select * into o from public.organisations where join_code = c and length(c) = 8 and kind in ('centre', 'school');
  if o.id is null then
    insert into public.invite_tries (user_id) values (auth.uid());
    return null;
  end if;
  mine := public._ensure_org(auth.uid());
  if mine = o.id then return public.my_org(); end if;
  if (select kind from public.organisations where id = mine) = 'studybridge' then
    raise exception 'The StudyBridge content account stays in StudyBridge’s own organisation.';
  end if;
  if exists (select 1 from public.org_members where org_id = mine and user_id <> auth.uid()) then
    raise exception 'Other tutors are in your centre. Leave it first (Settings → Your organisation).';
  end if;
  delete from public.org_members where user_id = auth.uid();
  insert into public.org_members (org_id, user_id, role) values (o.id, auth.uid(), 'tutor');
  perform public.notify_user(m.user_id, 'org', me || ' joined ' || o.name, 'They’re a tutor in your centre now. See them in Centre.', jsonb_build_object('org_id', o.id))
     from public.org_members m where m.org_id = o.id and m.role = 'manager' and m.user_id <> auth.uid();
  return public.my_org();
end $$;

-- Leave a centre: the tutor goes back to an organisation of their own, with their learners and work.
-- The last one in a centre turns it back into their own.
create or replace function public.org_leave() returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.organisations; v_role text; me text := (select display_name from public.profiles where id = auth.uid());
begin
  select * into o from public.organisations where id = public._org_of(auth.uid());
  if o.id is null or public.my_role() is distinct from 'tutor' then raise exception 'Tutors only.'; end if;
  if o.kind not in ('centre', 'school') then raise exception 'This is your own organisation.'; end if;
  select role into v_role from public.org_members where org_id = o.id and user_id = auth.uid();
  if not exists (select 1 from public.org_members where org_id = o.id and user_id <> auth.uid()) then
    update public.organisations set kind = 'tutor', join_code = null where id = o.id;
    return public.my_org();
  end if;
  if v_role = 'manager' and not exists (select 1 from public.org_members where org_id = o.id and role = 'manager' and user_id <> auth.uid()) then
    raise exception 'You’re its only manager. Make another tutor a manager first.';
  end if;
  delete from public.org_members where org_id = o.id and user_id = auth.uid();
  perform public._ensure_org(auth.uid());
  perform public.notify_user(m.user_id, 'org', me || ' left ' || o.name, 'Their learners and work went with them.', jsonb_build_object('org_id', o.id))
     from public.org_members m where m.org_id = o.id and m.role = 'manager';
  return public.my_org();
end $$;

-- A manager takes a tutor out of the centre (they keep their learners and work, in an organisation of their own),
-- or makes them a manager too (or not)
create or replace function public.org_remove(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.organisations := public._org_mine_to_change();
begin
  if p_user = auth.uid() then raise exception 'To leave, use Leave the centre.'; end if;
  delete from public.org_members where org_id = o.id and user_id = p_user;
  if not found then raise exception 'They aren’t in your centre.'; end if;
  perform public._ensure_org(p_user);
  perform public.notify_user(p_user, 'org', 'You’re no longer in ' || o.name, 'Your learners, classes and work stay with you.', '{}');
  return public.my_org();
end $$;

create or replace function public.org_set_role(p_user uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.organisations := public._org_mine_to_change();
begin
  if p_role not in ('manager', 'tutor') then raise exception 'Unknown role.'; end if;
  if p_role = 'tutor' and not exists (select 1 from public.org_members where org_id = o.id and role = 'manager' and user_id <> p_user) then
    raise exception 'A centre needs at least one manager.';
  end if;
  update public.org_members set role = p_role where org_id = o.id and user_id = p_user;
  if not found then raise exception 'They aren’t in your centre.'; end if;
  return public.my_org();
end $$;

-- What a centre's manager sees: every tutor and every learner in the centre, with how they're getting on.
-- Read-only: no work, answers, marks or messages, and nothing to approve (each tutor does that for their own learners).
create or replace function public.org_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v uuid := public._org_of(auth.uid()); wk date := (now() - interval '6 days')::date;
begin
  if public.my_role() is distinct from 'tutor' or not public._org_manager(v)
     or (select kind from public.organisations where id = v) not in ('centre', 'school') then
    raise exception 'Only a centre’s manager can see this.';
  end if;
  return jsonb_build_object(
    'name', (select name from public.organisations where id = v),
    'tutors', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'role', m.role, 'last_seen_at', p.last_seen_at,
                  'learners', (select count(*) from public.profiles l where l.tutor_id = p.id and l.role = 'learner'),
                  'classes', (select count(*) from public.classes c where c.tutor_id = p.id and not c.archived),
                  'to_mark', (select count(*) from public.attempts a where a.tutor_id = p.id and a.status = 'submitted'))
                  order by m.role = 'manager' desc, p.display_name), '[]')
                 from public.org_members m join public.profiles p on p.id = m.user_id where m.org_id = v),
    'learners', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.display_name, 'tutor_id', l.tutor_id, 'joined_at', l.created_at,
                  'subjects', (select coalesce(jsonb_agg(s.name order by s.name), '[]') from public.learner_subjects ls join public.subjects s on s.id = ls.subject_id where ls.learner_id = l.id),
                  'classes', (select coalesce(jsonb_agg(c.name order by c.name), '[]') from public.class_members cm join public.classes c on c.id = cm.class_id where cm.learner_id = l.id and not c.archived),
                  'week_min', (select coalesce(sum(x.seconds), 0) / 60 from public.activity x where x.learner_id = l.id and x.day >= wk),
                  'last_active', (select max(x.day) from public.activity x where x.learner_id = l.id),
                  'handed_in_week', (select count(*) from public.attempts a where a.learner_id = l.id and a.submitted_at >= now() - interval '7 days'))
                  order by l.display_name), '[]')
                 from public.profiles l where l.role = 'learner' and (l.tutor_id in (select user_id from public.org_members where org_id = v)
                   or l.id in (select cm.learner_id from public.class_members cm join public.classes c on c.id = cm.class_id where c.org_id = v))));
end $$;

-- ---------------- classes ----------------
-- An item for a class is for whoever is in it now. Work someone has already started stays theirs after they leave,
-- and past live lessons keep who was there. An empty class means nobody yet (an empty list would mean everyone).
create or replace function public._class_audience() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ids uuid[];
begin
  if new.class_id is null then return new; end if;
  if public._class_tutor(new.class_id) is distinct from new.tutor_id then raise exception 'Unknown class.'; end if;
  if tg_table_name = 'sessions' and tg_op = 'UPDATE' then
    if old.starts_at <= now() then return new; end if; -- (only sessions have a start)
  end if;
  select coalesce(array_agg(m.learner_id order by m.added_at), '{}') into v_ids from public.class_members m where m.class_id = new.class_id;
  if tg_table_name = 'assignments' and tg_op = 'UPDATE' then
    select coalesce(array_agg(x order by x), '{}') into v_ids from (
      select unnest(v_ids) x
      union
      select distinct t.learner_id from public.attempts t where t.assignment_id = new.id and t.learner_id = any (coalesce(old.learner_ids, '{}'))) y;
  end if;
  if cardinality(v_ids) = 0 and tg_table_name in ('assignments', 'lessons', 'files') then v_ids := array[new.class_id]; end if;
  new.learner_ids := v_ids;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['assignments', 'lessons', 'files', 'sessions', 'lesson_series'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_class', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public._class_audience()', t || '_class', t);
  end loop;
end $$;

-- Someone joins or leaves a class: everything for the class follows (coming live lessons only)
create or replace function public._class_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare c uuid := coalesce(new.class_id, old.class_id);
begin
  if not exists (select 1 from public.classes where id = c) then return null; end if; -- the class itself is being deleted
  update public.assignments set class_id = class_id where class_id = c;
  update public.lessons set class_id = class_id where class_id = c;
  update public.files set class_id = class_id where class_id = c;
  update public.sessions set class_id = class_id where class_id = c and starts_at > now();
  update public.lesson_series set class_id = class_id where class_id = c and (ends_on is null or ends_on >= current_date);
  update public.sessions s set learner_ids = r.learner_ids from public.lesson_series r
   where s.series_id = r.id and r.class_id = c and s.starts_at > now() and s.learner_ids is distinct from r.learner_ids;
  return null;
end $$;
drop trigger if exists class_members_sync on public.class_members;
create trigger class_members_sync after insert or delete on public.class_members for each row execute function public._class_sync();

-- Make or change a class: its name, subject (optional) and who's in it. Learners added are told.
create or replace function public.save_class(p_id uuid, p_name text, p_subject uuid, p_learner_ids uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id; v_name text := left(trim(coalesce(p_name, '')), 80); l uuid;
begin
  if public.my_role() is distinct from 'tutor' or not public._tutor_active() then raise exception 'Tutors only.'; end if;
  if v_name = '' then raise exception 'Give the class a name.'; end if;
  if p_subject is not null and not exists (select 1 from public.subjects where id = p_subject and tutor_id = auth.uid()) then
    raise exception 'Unknown subject.';
  end if;
  foreach l in array coalesce(p_learner_ids, '{}') loop
    if not public.is_my_learner(l) then raise exception 'Not your learner.'; end if;
  end loop;
  if v_id is null then
    insert into public.classes (tutor_id, name, subject_id) values (auth.uid(), v_name, p_subject) returning id into v_id;
  else
    update public.classes set name = v_name, subject_id = p_subject where id = v_id and tutor_id = auth.uid();
    if not found then raise exception 'Not your class.'; end if;
  end if;
  delete from public.class_members where class_id = v_id and not learner_id = any (coalesce(p_learner_ids, '{}'));
  for l in select distinct x from unnest(coalesce(p_learner_ids, '{}')) x
            where not exists (select 1 from public.class_members m where m.class_id = v_id and m.learner_id = x) loop
    insert into public.class_members (class_id, learner_id) values (v_id, l);
    perform public.notify_user(l, 'class', 'You’re in ' || v_name || ' now',
      'Work, lesson notes and live lessons for this class show in StudyBridge.', jsonb_build_object('class_id', v_id));
  end loop;
  return v_id;
end $$;

-- Put a class away (it stays on everything it was used for) or bring it back
create or replace function public.archive_class(p_id uuid, p_archived boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.classes set archived = coalesce(p_archived, true) where id = p_id and tutor_id = auth.uid();
  if not found then raise exception 'Not your class.'; end if;
end $$;

-- Delete a class. Everything that was for it keeps the learners it has; anything only for an empty class is hidden
-- (so it never turns into "everyone").
create or replace function public.delete_class(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public._class_tutor(p_id) is distinct from auth.uid() then raise exception 'Not your class.'; end if;
  update public.assignments set class_id = null, learner_ids = null, visibility = 'hidden' where class_id = p_id and learner_ids = array[p_id];
  update public.lessons set class_id = null, learner_ids = null, visibility = 'hidden' where class_id = p_id and learner_ids = array[p_id];
  update public.files set class_id = null, learner_ids = null, visibility = 'hidden' where class_id = p_id and learner_ids = array[p_id];
  delete from public.classes where id = p_id;
end $$;

-- A learner who joins with an invite that names classes goes straight into them
create or replace function public._invite_classes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.accepted_by is not null and old.accepted_by is null and cardinality(new.class_ids) > 0 then
    perform public._add_to_class(c.id, new.accepted_by) from public.classes c
     where c.id = any (new.class_ids) and (c.tutor_id = new.tutor_id or exists (
             select 1 from public.class_teachers ct where ct.class_id = c.id and ct.teacher_id = new.tutor_id));
  end if;
  return null;
end $$;
drop trigger if exists invites_classes on public.invites;
create trigger invites_classes after update of accepted_by on public.invites for each row execute function public._invite_classes();

-- Weekly lessons for a class: the same as before, with the class's learners (and whoever joins it later)
drop function if exists public.create_lesson_series(text, timestamptz, int, uuid[], text, date, text);
drop function if exists public.change_lesson_series(uuid, text, timestamptz, int, uuid[], text, date, text, timestamptz);
create or replace function public._series_learners(p_class uuid, p_learner_ids uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = public as $$
declare v uuid[];
begin
  if p_class is null then return p_learner_ids; end if;
  if public._class_tutor(p_class) is distinct from auth.uid() then raise exception 'Unknown class.'; end if;
  select coalesce(array_agg(learner_id order by added_at), '{}') into v from public.class_members where class_id = p_class;
  if cardinality(v) = 0 then raise exception 'Nobody is in this class yet. Add learners to it first.'; end if;
  return v;
end $$;

create or replace function public.create_lesson_series(p_title text, p_first timestamptz, p_duration int, p_learner_ids uuid[],
  p_timezone text, p_until date default null, p_notes text default null, p_class uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_local timestamp; v_tz text; v_id uuid; v_ids uuid[] := public._series_learners(p_class, p_learner_ids);
begin
  v_local := public._series_check(p_title, p_first, v_ids, p_timezone, p_until);
  v_tz := coalesce((select name from pg_timezone_names where name = p_timezone), public._tz_of(auth.uid()));
  insert into public.lesson_series (tutor_id, title, learner_ids, class_id, weekday, start_time, timezone, duration_min, starts_on, ends_on, notes_md)
  values (auth.uid(), trim(p_title), v_ids, p_class, extract(dow from v_local)::int, v_local::time, v_tz,
          greatest(10, least(coalesce(p_duration, 60), 480)), v_local::date, p_until, nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  perform public._fill_series(v_id);
  perform public._series_notify(v_id, 'Weekly lesson: ');
  return v_id;
end $$;

-- Change a weekly lesson from now on (time, day, length, learners or class, title). Lessons before p_from
-- (default: now) stay as they are.
create or replace function public.change_lesson_series(p_series uuid, p_title text, p_first timestamptz, p_duration int, p_learner_ids uuid[],
  p_timezone text, p_until date default null, p_notes text default null, p_from timestamptz default null, p_class uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_local timestamp; v_tz text; v_old uuid[]; l uuid; v_ids uuid[] := public._series_learners(p_class, p_learner_ids);
begin
  select learner_ids into v_old from public.lesson_series where id = p_series and tutor_id = auth.uid();
  if not found then raise exception 'Not your lesson.'; end if;
  v_local := public._series_check(p_title, p_first, v_ids, p_timezone, p_until);
  v_tz := coalesce((select name from pg_timezone_names where name = p_timezone), public._tz_of(auth.uid()));
  update public.lesson_series set title = trim(p_title), learner_ids = v_ids, class_id = p_class, weekday = extract(dow from v_local)::int,
    start_time = v_local::time, timezone = v_tz, duration_min = greatest(10, least(coalesce(p_duration, 60), 480)),
    starts_on = v_local::date, ends_on = p_until, notes_md = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_series;
  delete from public.sessions where series_id = p_series and starts_at > now() and starts_at >= coalesce(p_from, now());
  perform public._fill_series(p_series);
  perform public._series_notify(p_series, 'Weekly lesson changed: ');
  foreach l in array v_old loop
    if not l = any (v_ids) then
      perform public.notify_user(l, 'session', 'Weekly lesson stopped: ' || trim(p_title), 'This weekly lesson no longer includes you.', '{}');
    end if;
  end loop;
end $$;

-- Admin → Tutors shows each tutor's organisation too
create or replace function public.admin_tutors() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.display_name, 'email', coalesce(u.email::text, p.email), 'status', p.status, 'plan', p.plan,
      'plan_learners', p.plan_learners, 'plan_until', p.plan_until, 'plan_limit', public._tutor_limit(p.id),
      'joined_at', coalesce(u.created_at, p.created_at), 'last_sign_in_at', u.last_sign_in_at,
      'is_admin', exists (select 1 from public.platform_admins a where a.user_id = p.id),
      'learners', (select count(*) from public.profiles l where l.tutor_id = p.id and l.role = 'learner'),
      'storage_bytes', public._storage_bytes(p.id),
      'ai_cents', public._prof_month_cents(p.id),
      'ai_limit_cents', public._prof_limit(p.id),
      'ai_limit_custom', exists (select 1 from public.prof_limits pl where pl.tutor_id = p.id),
      'signup', p.signup, 'app_version', p.app_version, 'last_seen_at', p.last_seen_at,
      'org', (select jsonb_build_object('name', o.name, 'kind', o.kind, 'role', m.role,
                                        'tutors', (select count(*) from public.org_members x where x.org_id = o.id))
                from public.org_members m join public.organisations o on o.id = m.org_id where m.user_id = p.id),
      'classes', (select count(*) from public.classes c where c.tutor_id = p.id and not c.archived)
    ) order by (p.status = 'pending') desc, p.created_at)
    from public.profiles p left join auth.users u on u.id = p.id where p.role = 'tutor' and not p.demo), '[]');
end $$;

-- =====================================================================
-- The demo StudyBridge (22 Oct 2026): for the Owner only, a pretend tuition centre made of fake accounts with
-- sample work, to see every kind of user's screens. The app makes the accounts (plain sign-ups with throwaway
-- passwords, emails demo-<who>-<random>@gostudybridge.com), then admin_demo_build fills them in. Demo accounts are
-- fenced off: marked profiles.demo, never in Admin's numbers or lists, never emailed, and the Owner opens them with
-- a fresh password made here (only ever for a demo account). Remove deletes them and everything in them.
-- =====================================================================
-- Admin → Demo: the demo accounts (if made) and whether a student on their own can be part of it
create or replace function public.admin_demo() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin();
  return jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'label', p.demo_label, 'role', p.role, 'name', p.display_name, 'email', p.email)
                           order by array_position(array['manager', 'tutor1', 'tutor2', 'tutor3', 'learner1', 'learner2', 'learner3', 'learner4', 'learner5', 'learner6', 'parent', 'student'], p.demo_label))
                          from public.profiles p where p.demo), '[]'),
    'made_at', (select min(created_at) from public.profiles where demo),
    'content', public._studybridge_account() is not null);
end $$;

-- Fill in the accounts the app just made. p_accounts: {"manager", "tutor1".."tutor3", "learner1".."learner6", "parent": id,
-- "student": id (optional)}. Each must be a brand-new account with no role yet and a demo address.
-- Riverside Tuition (demo): Grace runs it and doesn't teach; Mercy (maths), Daniel (physics) and Joseph (biology) each have a
-- class of two.
create or replace function public.admin_demo_build(p_accounts jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  k text;
  v_id uuid;
  g uuid := (p_accounts ->> 'manager')::uuid;
  m uuid := (p_accounts ->> 'tutor1')::uuid;
  t uuid := (p_accounts ->> 'tutor2')::uuid;
  j uuid := (p_accounts ->> 'tutor3')::uuid;
  l1 uuid := (p_accounts ->> 'learner1')::uuid;
  l2 uuid := (p_accounts ->> 'learner2')::uuid;
  l3 uuid := (p_accounts ->> 'learner3')::uuid;
  l4 uuid := (p_accounts ->> 'learner4')::uuid;
  l5 uuid := (p_accounts ->> 'learner5')::uuid;
  l6 uuid := (p_accounts ->> 'learner6')::uuid;
  par uuid := (p_accounts ->> 'parent')::uuid;
  stu uuid := (p_accounts ->> 'student')::uuid;
  c uuid := public._studybridge_account();
  org uuid;
  maths uuid; phys uuid; bio uuid; t_alg uuid; t_num uuid; t_geo uuid; t_stat uuid; t_mot uuid; t_elec uuid; t_cell uuid; t_eco uuid;
  y10 uuid; y11 uuid; y9 uuid;
  hw uuid; quiz uuid; paper uuid; mock uuid; series uuid; bhw uuid;
  q1 uuid; q2 uuid; q3 uuid; pq1 uuid; pq2 uuid; qq1 uuid; qq2 uuid; bq1 uuid; bq2 uuid;
  a1 uuid; a3 uuid; ma uuid;
  wk date := (date_trunc('week', now()) - interval '7 days')::date;
  d int;
  sub uuid;
begin
  perform public._admin();
  if exists (select 1 from public.profiles where demo) then raise exception 'There’s a demo already. Remove it first, or use Reset.'; end if;
  foreach k in array array['manager', 'tutor1', 'tutor2', 'tutor3', 'learner1', 'learner2', 'learner3', 'learner4', 'learner5', 'learner6', 'parent', 'student'] loop
    v_id := (p_accounts ->> k)::uuid;
    if v_id is null then
      if k = 'student' then continue; end if;
      raise exception 'The demo needs a % account.', k;
    end if;
    if not exists (select 1 from public.profiles p where p.id = v_id and p.role is null and p.email like 'demo-%'
                     and p.created_at > now() - interval '1 hour') then
      raise exception 'That isn’t a new demo account.';
    end if;
    update public.profiles set demo = true, demo_label = k where id = v_id;
  end loop;

  -- the centre: Grace runs it; three tutors teach in it; all approved, on a plan with room
  update public.profiles set display_name = 'Grace Mwansa', timezone = 'Africa/Lusaka' where id = g;
  update public.profiles set display_name = 'Mercy Tembo', timezone = 'Africa/Lusaka' where id = m;
  update public.profiles set display_name = 'Daniel Okafor', timezone = 'Africa/Lusaka' where id = t;
  update public.profiles set display_name = 'Joseph Lungu', timezone = 'Africa/Lusaka' where id = j;
  update public.profiles set role = 'tutor', status = 'active', plan = 'custom', plan_learners = 50 where id in (g, m, t, j);
  org := public._ensure_org(g);
  update public.organisations set kind = 'centre', name = 'Riverside Tuition (demo)', join_code = public._new_org_code() where id = org;
  delete from public.org_members where user_id in (m, t, j);
  insert into public.org_members (org_id, user_id, role) values (org, m, 'tutor'), (org, t, 'tutor'), (org, j, 'tutor');

  -- subjects and topics
  insert into public.subjects (tutor_id, name, color, exam) values (m, 'IGCSE Maths', '#0E6B6B', 'cie:0607') returning id into maths;
  insert into public.topics (tutor_id, subject_id, name, position) values (m, maths, 'Number', 1) returning id into t_num;
  insert into public.topics (tutor_id, subject_id, name, position) values (m, maths, 'Algebra', 2) returning id into t_alg;
  insert into public.topics (tutor_id, subject_id, name, position) values (m, maths, 'Geometry', 3) returning id into t_geo;
  insert into public.topics (tutor_id, subject_id, name, position) values (m, maths, 'Statistics', 4) returning id into t_stat;
  insert into public.subjects (tutor_id, name, color, exam) values (t, 'IGCSE Physics', '#2F5C9A', 'cie:0625') returning id into phys;
  insert into public.topics (tutor_id, subject_id, name, position) values (t, phys, 'Motion and forces', 1) returning id into t_mot;
  insert into public.topics (tutor_id, subject_id, name, position) values (t, phys, 'Electricity', 2) returning id into t_elec;
  insert into public.subjects (tutor_id, name, color, exam) values (j, 'IGCSE Biology', '#3F7D3A', 'cie:0610') returning id into bio;
  insert into public.topics (tutor_id, subject_id, name, position) values (j, bio, 'Cells', 1) returning id into t_cell;
  insert into public.topics (tutor_id, subject_id, name, position) values (j, bio, 'Ecology', 2) returning id into t_eco;

  -- learners: two for each tutor, in Lusaka
  update public.profiles set role = 'learner', tutor_id = m, timezone = 'Africa/Lusaka', display_name = 'Chipo Banda' where id = l1;
  update public.profiles set role = 'learner', tutor_id = m, timezone = 'Africa/Lusaka', display_name = 'Tendai Moyo' where id = l2;
  update public.profiles set role = 'learner', tutor_id = t, timezone = 'Africa/Lusaka', display_name = 'Amara Phiri' where id = l3;
  update public.profiles set role = 'learner', tutor_id = t, timezone = 'Africa/Lusaka', display_name = 'Kofi Mensah' where id = l4;
  update public.profiles set role = 'learner', tutor_id = j, timezone = 'Africa/Lusaka', display_name = 'Natasha Mwale' where id = l5;
  update public.profiles set role = 'learner', tutor_id = j, timezone = 'Africa/Lusaka', display_name = 'Mwila Zulu' where id = l6;
  insert into public.learner_subjects (learner_id, subject_id, tutor_id)
  values (l1, maths, m), (l2, maths, m), (l3, phys, t), (l4, phys, t), (l5, bio, j), (l6, bio, j);
  -- exams in the reports' countdown
  insert into public.learner_reports (learner_id, tutor_id, exam_name, exam_date)
  select x, tt, 'IGCSE (May/June)', make_date(extract(year from now() + interval '6 months')::int, 5, 4)
    from (values (l1, m), (l2, m), (l3, t), (l4, t), (l5, j), (l6, j)) v (x, tt)
  on conflict (learner_id) do update set tutor_id = excluded.tutor_id, exam_name = excluded.exam_name, exam_date = excluded.exam_date;

  -- a class each
  insert into public.classes (tutor_id, name, subject_id) values (m, 'Year 10 maths', maths) returning id into y10;
  insert into public.class_members (class_id, learner_id) values (y10, l1), (y10, l2);
  insert into public.classes (tutor_id, name, subject_id) values (t, 'Year 11 physics', phys) returning id into y11;
  insert into public.class_members (class_id, learner_id) values (y11, l3), (y11, l4);
  insert into public.classes (tutor_id, name, subject_id) values (j, 'Year 9 biology', bio) returning id into y9;
  insert into public.class_members (class_id, learner_id) values (y9, l5), (y9, l6);

  -- Mercy's teaching plan: this week is algebra
  insert into public.teaching_plans (tutor_id, subject_id, kind, starts_on, ends_on, items)
  values (m, maths, 'week', date_trunc('week', now())::date - 7, date_trunc('week', now())::date + 20, jsonb_build_array(
    jsonb_build_object('label', 'Last week', 'starts_on', date_trunc('week', now())::date - 7, 'ends_on', date_trunc('week', now())::date - 1, 'topics', jsonb_build_array('Number')),
    jsonb_build_object('label', 'This week', 'starts_on', date_trunc('week', now())::date, 'ends_on', date_trunc('week', now())::date + 6, 'topics', jsonb_build_array('Algebra')),
    jsonb_build_object('label', 'Next week', 'starts_on', date_trunc('week', now())::date + 7, 'ends_on', date_trunc('week', now())::date + 13, 'topics', jsonb_build_array('Geometry'))));

  -- Mercy's homework for Year 10: Chipo handed it in and has it back, marked; Tendai hasn't started
  insert into public.assignments (tutor_id, kind, title, instructions_md, subject_id, topic_id, class_id, visibility, due_at)
  values (m, 'homework', 'Simultaneous equations', 'Show your working for each one.', maths, t_alg, y10, 'visible', now() + interval '3 days')
  returning id into hw;
  insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, marks, topic_id)
  values (hw, m, 1, 'numeric', 'Solve $2x + 3 = 11$. What is $x$?', 1, t_alg) returning id into q1;
  insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, marks, topic_id)
  values (hw, m, 2, 'numeric', '$x + y = 10$ and $x - y = 4$. What is $x$?', 2, t_alg) returning id into q2;
  insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, options, marks, topic_id)
  values (hw, m, 3, 'mcq', 'Which pair solves $x + 2y = 5$ and $x - y = 2$?', '["x = 1, y = 2", "x = 3, y = 1", "x = 2, y = 3"]', 1, t_alg) returning id into q3;
  insert into public.question_keys (question_id, tutor_id, answer, solution_md) values
    (q1, m, '{"value": "4"}', '$2x = 8$, so $x = 4$.'),
    (q2, m, '{"value": "7"}', 'Add the equations: $2x = 14$, so $x = 7$.'),
    (q3, m, '{"choice": 1}', 'Subtract: $3y = 3$, so $y = 1$ and $x = 3$.');
  insert into public.attempts (assignment_id, learner_id, tutor_id, status, started_at, submitted_at, time_spent_sec, score, max_score, released, released_at, feedback_md)
  values (hw, l1, m, 'returned', now() - interval '26 hours', now() - interval '25 hours', 1260, 3, 4, true, now() - interval '20 hours',
          'Good work, Chipo. Question 2: add the two equations first, then $x$ falls out.')
  returning id into a1;
  insert into public.responses (attempt_id, question_id, learner_id, tutor_id, answer, auto_marks, marks, feedback_md) values
    (a1, q1, l1, m, '{"value": "4"}', 1, 1, null),
    (a1, q2, l1, m, '{"value": "6"}', 0, 1, 'Right method, one slip at the end: $14 \div 2 = 7$.'),
    (a1, q3, l1, m, '{"choice": 1}', 1, 1, null);

  -- lesson notes for the class, and a weekly lesson
  insert into public.lessons (tutor_id, title, body_md, subject_id, topic_id, class_id, visibility)
  values (m, 'Simultaneous equations: elimination', E'## Elimination\n\nAdd or subtract the equations so one letter disappears.\n\n**Example:** $x + y = 10$ and $x - y = 4$. Adding gives $2x = 14$, so $x = 7$ and $y = 3$.',
          maths, t_alg, y10, 'visible');
  insert into public.lesson_series (tutor_id, title, learner_ids, class_id, weekday, start_time, timezone, duration_min, starts_on)
  values (m, 'Year 10 maths', array[l1, l2], y10, extract(dow from current_date + 1)::int, '16:00', 'Africa/Lusaka', 60, current_date + 1)
  returning id into series;
  perform public._fill_series(series);

  -- a mock: Chipo's grade is back (the boundaries stay Mercy's own)
  insert into public.grade_boundaries (tutor_id, exam, session, option_label, max_mark, grades)
  values (m, 'cie:0607', 'June 2025', 'Extended', 100,
          '[{"grade": "A*", "min": 80}, {"grade": "A", "min": 70}, {"grade": "B", "min": 60}, {"grade": "C", "min": 50}, {"grade": "D", "min": 40}, {"grade": "E", "min": 30}]');
  insert into public.mocks (tutor_id, title, subject_id, exam) values (m, 'Term 1 mock', maths, 'cie:0607') returning id into mock;
  insert into public.assignments (tutor_id, kind, title, subject_id, class_id, visibility, mock_id, mock_position, time_limit_min)
  values (m, 'test', 'Term 1 mock · Paper 2', maths, y10, 'visible', mock, 1, 90) returning id into paper;
  insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, marks, topic_id)
  values (paper, m, 1, 'short', 'Number and algebra (section A)', 25, t_num) returning id into pq1;
  insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, marks, topic_id)
  values (paper, m, 2, 'short', 'Geometry and statistics (section B)', 25, t_geo) returning id into pq2;
  insert into public.attempts (assignment_id, learner_id, tutor_id, status, started_at, submitted_at, time_spent_sec, score, max_score, released, released_at)
  values (paper, l1, m, 'returned', now() - interval '4 days', now() - interval '4 days' + interval '85 minutes', 5100, 34, 50, true, now() - interval '3 days')
  returning id into ma;
  insert into public.responses (attempt_id, question_id, learner_id, tutor_id, answer, marks) values
    (ma, pq1, l1, m, '{"text": "(answers written on paper)"}', 19),
    (ma, pq2, l1, m, '{"text": "(answers written on paper)"}', 15);

  -- Daniel's Year 11 physics: a quiz Amara has handed in, waiting for him to mark
  insert into public.assignments (tutor_id, kind, title, subject_id, topic_id, class_id, visibility, due_at)
  values (t, 'quiz', 'Speed, distance and time', phys, t_mot, y11, 'visible', now() + interval '2 days') returning id into quiz;
  insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, marks, topic_id)
  values (quiz, t, 1, 'numeric', 'A cyclist travels 120 m in 20 s. What is their speed in m/s?', 1, t_mot) returning id into qq1;
  insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, marks, topic_id)
  values (quiz, t, 2, 'short', 'Explain why a ball thrown upwards slows down.', 2, t_mot) returning id into qq2;
  insert into public.question_keys (question_id, tutor_id, answer) values (qq1, t, '{"value": "6"}'), (qq2, t, '{}');
  insert into public.attempts (assignment_id, learner_id, tutor_id, status, started_at, submitted_at, time_spent_sec, score, max_score)
  values (quiz, l3, t, 'submitted', now() - interval '3 hours', now() - interval '2 hours', 640, null, 3) returning id into a3;
  insert into public.responses (attempt_id, question_id, learner_id, tutor_id, answer, auto_marks) values
    (a3, qq1, l3, t, '{"value": "6"}', 1),
    (a3, qq2, l3, t, '{"text": "Gravity pulls it down, against the way it is moving, so it loses speed."}', null);

  -- Joseph's Year 9 biology: homework nobody has started yet (try Nudge), and notes
  insert into public.assignments (tutor_id, kind, title, instructions_md, subject_id, topic_id, class_id, visibility, due_at)
  values (j, 'homework', 'Cells and organelles', 'Label the diagram in your book, then answer these.', bio, t_cell, y9, 'visible', now() + interval '5 days')
  returning id into bhw;
  insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, options, marks, topic_id)
  values (bhw, j, 1, 'mcq', 'Where does respiration happen?', '["Nucleus", "Mitochondria", "Cell wall"]', 1, t_cell) returning id into bq1;
  insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, marks, topic_id)
  values (bhw, j, 2, 'short', 'Name two things a plant cell has that an animal cell doesn’t.', 2, t_cell) returning id into bq2;
  insert into public.question_keys (question_id, tutor_id, answer) values (bq1, j, '{"choice": 1}'), (bq2, j, '{}');
  insert into public.lessons (tutor_id, title, body_md, subject_id, topic_id, class_id, visibility)
  values (j, 'Plant and animal cells', E'## What every cell has\n\nA cell membrane, cytoplasm, a nucleus and mitochondria.\n\n**Plant cells also have** a cell wall, chloroplasts and a large vacuole.',
          bio, t_cell, y9, 'visible');

  -- messages between Mercy and Chipo
  insert into public.comments (tutor_id, learner_id, author_id, body, created_at) values
    (m, l1, l1, 'I got stuck on question 2. Do I add or take away?', now() - interval '27 hours'),
    (m, l1, m, 'Add them: the $y$s cancel out. Then try it again!', now() - interval '26 hours');

  -- time studied over the last week
  for d in 0..6 loop
    insert into public.activity (learner_id, tutor_id, kind, subject_id, seconds, day) values
      (l1, m, 'study', maths, 1200 + d * 180, current_date - d),
      (l2, m, 'study', maths, case when d % 2 = 0 then 900 else 0 end, current_date - d),
      (l3, t, 'study', phys, 1500, current_date - d),
      (l4, t, 'study', phys, case when d < 3 then 600 else 0 end, current_date - d),
      (l5, j, 'study', bio, case when d between 1 and 4 then 1100 else 0 end, current_date - d),
      (l6, j, 'study', bio, case when d = 2 then 700 else 0 end, current_date - d);
  end loop;
  delete from public.activity where seconds = 0 and learner_id in (l1, l2, l3, l4, l5, l6);

  -- Chipo's mum, Ruth: a parent account with last week's report, approved by Mercy
  update public.profiles set role = 'parent', display_name = 'Ruth Banda', timezone = 'Africa/Lusaka' where id = par;
  insert into public.parent_links (parent_id, learner_id, tutor_id) values (par, l1, m);
  insert into public.parent_reports (tutor_id, learner_id, week_start, status, data, comment, next_week, sent_at, sent_via)
  values (m, l1, wk, 'sent', public._report_numbers(m, l1, wk::timestamptz, (wk + 7)::timestamptz),
          'Chipo worked steadily this week and her algebra is getting much stronger.', 'More practice with elimination, then the mock review.',
          now() - interval '2 days', 'parent');

  -- a student on their own (a test student: they never pay), studying the first open subject (0607 if there is one)
  if stu is not null then
    if c is null then raise exception 'Pick the content account first (Admin → Students), or make the demo without a student.'; end if;
    select id into sub from public.subjects where tutor_id = c
     order by (catalogue = 'cambridge:igcse:0607') desc, live desc, position, created_at limit 1;
    update public.profiles
       set role = 'learner', tutor_id = c, self_learner = true, test_student = true, display_name = 'Lina Haddad', timezone = 'Africa/Lusaka',
           grade = 10, country = 'Zambia', trial_until = now() + interval '7 days', study_board = 'Cambridge', study_level = 'IGCSE',
           exam_date = make_date(extract(year from now() + interval '6 months')::int, 5, 1), exam_label = 'May/June',
           study_hours = 4, study_goal_min = 34, plan_start = current_date, setup_done = true
     where id = stu;
    if sub is not null then insert into public.learner_subjects (learner_id, subject_id, tutor_id) values (stu, sub, c) on conflict do nothing; end if;
    insert into public.parent_links (parent_id, learner_id, tutor_id) values (par, stu, c) on conflict do nothing;
  end if;

  perform public._admin_log('demo_made', null, jsonb_build_object('accounts', p_accounts));
  return public.admin_demo();
end $$;

-- Open a demo account: a fresh password for it (only ever a demo account), which the Owner's app signs in with
create or replace function public.admin_demo_open(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.profiles; pw text := encode(extensions.gen_random_bytes(18), 'hex');
begin
  perform public._admin();
  select * into p from public.profiles where id = p_user and demo;
  if p.id is null then raise exception 'That isn’t a demo account.'; end if;
  update auth.users set encrypted_password = extensions.crypt(pw, extensions.gen_salt('bf')) where id = p_user;
  return jsonb_build_object('id', p.id, 'email', p.email, 'password', pw, 'role', p.role, 'name', p.display_name);
end $$;

-- Remove the demo: its accounts and everything in them
create or replace function public.admin_demo_remove() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public._admin();
  delete from auth.users where id in (select id from public.profiles where demo);
  get diagnostics n = row_count;
  -- and any demo sign-ups left half-made (the app stopped before they were filled in)
  delete from auth.users where id in (select id from public.profiles where role is null and email like 'demo-%@gostudybridge.com');
  delete from public.profiles where demo; -- (if the account itself had already gone)
  perform public._admin_log('demo_removed', null, jsonb_build_object('accounts', n));
  return n;
end $$;

-- =====================================================================
-- The new tutor Home (22 Oct 2026): one card per learner (their streak, last mark back, latest mock grade, weeks to
-- their exam and what the teaching plan says for this week), and "Nudge" for work nobody has started.
-- =====================================================================
create or replace function public.tutor_home() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); v_today date;
begin
  if public.my_role() is distinct from 'tutor' then return null; end if;
  v_today := (now() at time zone public._tz_of(me))::date;
  return jsonb_build_object('learners', coalesce((select jsonb_agg(jsonb_build_object(
      'id', l.id,
      'streak', (public.study_summary(l.id) ->> 'streak')::int,
      'last_mark', (select jsonb_build_object('title', a.title, 'score', t.score, 'max', t.max_score, 'attempt_id', t.id,
                                              'at', coalesce(t.released_at, t.submitted_at))
                      from public.attempts t join public.assignments a on a.id = t.assignment_id
                     where t.learner_id = l.id and t.tutor_id = me and not a.practice and t.score is not null and public._is_released(t)
                     order by coalesce(t.released_at, t.submitted_at) desc limit 1),
      'mock', (select z.r from (select jsonb_build_object('title', m.title) || (public._mock_result(m.id, l.id, true) - 'papers') as r
                                  from public.mocks m where m.tutor_id = me) z
                where (z.r ->> 'released')::boolean and z.r ->> 'grade' is not null order by z.r ->> 'last_at' desc limit 1),
      'exam', (select jsonb_build_object('name', r.exam_name, 'date', r.exam_date) from public.learner_reports r
                where r.learner_id = l.id and r.tutor_id = me and r.exam_date is not null and r.exam_date >= v_today),
      -- this week in the teaching plan of each subject they take
      'plan', coalesce((select jsonb_agg(jsonb_build_object('subject_id', p.subject_id, 'label', i ->> 'label', 'topics', coalesce(i -> 'topics', '[]')))
                          from public.teaching_plans p cross join lateral jsonb_array_elements(p.items) i
                         where p.tutor_id = me and p.subject_id in (select ls.subject_id from public.learner_subjects ls where ls.learner_id = l.id)
                           and (i ->> 'starts_on') is not null and (i ->> 'starts_on')::date <= v_today
                           and coalesce((i ->> 'ends_on')::date, (i ->> 'starts_on')::date + 6) >= v_today), '[]')
    ) order by l.display_name) from public.profiles l where l.id in (select public._home_learners())), '[]'));
end $$;

-- A reminder to everyone it's for who hasn't handed it in yet (once in 12 hours); returns how many were told
alter table public.assignments add column if not exists nudged_at timestamptz;
create or replace function public.nudge_assignment(p_assignment uuid) returns int
language plpgsql security definer set search_path = public as $$
declare a public.assignments; l uuid; n int := 0;
begin
  select * into a from public.assignments where id = p_assignment and tutor_id = auth.uid();
  if a.id is null then raise exception 'Not your work.'; end if;
  if a.draft or not (a.visibility = 'visible' or (a.visibility = 'scheduled' and a.visible_from <= now())) then
    raise exception 'Learners can’t see this yet. Post it first.';
  end if;
  if a.nudged_at > now() - interval '12 hours' then raise exception 'You sent a reminder about this in the last 12 hours.'; end if;
  for l in select public._audience(a.tutor_id, a.learner_ids, a.subject_id) loop
    if not exists (select 1 from public.attempts t where t.assignment_id = a.id and t.learner_id = l and t.status <> 'in_progress') then
      perform public.notify_user(l, 'assignment', 'Reminder: ' || a.title,
        case when a.due_at is not null then 'Due ' || to_char(a.due_at at time zone public._tz_of(l), 'Dy DD Mon, HH24:MI') || ' your time.'
             else 'Your tutor sent a reminder.' end,
        jsonb_build_object('assignment_id', a.id));
      n := n + 1;
    end if;
  end loop;
  update public.assignments set nudged_at = now() where id = a.id;
  return n;
end $$;

-- =====================================================================
-- Launch 2, part 2 (22 Oct 2026): classes with teachers. A class has one or more teachers. A learner is taught by
-- their own tutor (profiles.tutor_id, as before) and by the teachers of every class they're in, even in another
-- organisation: a school and a private tutor at once. Each teacher sees, marks and approves only what's theirs:
-- their own learners, and the learners in the classes they teach. Only a learner's own tutor can change their
-- account, subjects list, parents or reports. In a centre or school the manager makes classes for any of its
-- teachers, from the organisation's learners; a class's code lets a learner from anywhere join it.
-- =====================================================================
create table if not exists public.class_teachers (
  class_id uuid not null references public.classes (id) on delete cascade,
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (class_id, teacher_id)
);
create index if not exists class_teachers_teacher on public.class_teachers (teacher_id);
alter table public.class_teachers enable row level security;
revoke all on public.class_teachers from public, anon, authenticated;
grant select on public.class_teachers to authenticated;
alter table public.classes add column if not exists org_id uuid references public.organisations (id) on delete set null;
alter table public.classes add column if not exists join_code text unique;
-- classes from before: the tutor who made it teaches it, in their organisation
insert into public.class_teachers (class_id, teacher_id) select id, tutor_id from public.classes on conflict do nothing;
update public.classes c set org_id = public._org_of(c.tutor_id) where org_id is null;

-- However a class is made, whoever made it teaches it, in their organisation (a manager's save_class then sets the teachers)
create or replace function public._class_made() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.class_teachers (class_id, teacher_id) values (new.id, new.tutor_id) on conflict do nothing;
  if new.org_id is null then update public.classes set org_id = public._org_of(new.tutor_id) where id = new.id; end if;
  return null;
end $$;
drop trigger if exists classes_made on public.classes;
create trigger classes_made after insert on public.classes for each row execute function public._class_made();

-- Does this teacher teach this learner (their own learner, or one in a class they teach)?
create or replace function public._teaches(p_teacher uuid, p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_learner and tutor_id = p_teacher and role = 'learner')
      or exists (select 1 from public.class_teachers ct join public.class_members cm on cm.class_id = ct.class_id
                  where ct.teacher_id = p_teacher and cm.learner_id = p_learner)
$$;
-- Everyone who teaches the signed-in learner
create or replace function public._my_teachers() returns setof uuid
language sql stable security definer set search_path = public as $$
  select tutor_id from public.profiles where id = auth.uid() and role = 'learner' and tutor_id is not null
  union
  select ct.teacher_id from public.class_members cm join public.class_teachers ct on ct.class_id = cm.class_id where cm.learner_id = auth.uid()
$$;
create or replace function public._teaches_class(p_class uuid, p_teacher uuid default null) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.class_teachers where class_id = p_class and teacher_id = coalesce(p_teacher, auth.uid()))
$$;
create or replace function public._class_org_manager(p_class uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public._org_manager((select org_id from public.classes where id = p_class))
$$;

-- Who can read what about classes: their teachers and the organisation's managers; learners only their own place
drop policy if exists classes_tutor on public.classes;
create policy classes_tutor on public.classes for select
  using (tutor_id = auth.uid() or public._teaches_class(id) or public._org_manager(org_id));
drop policy if exists class_members_tutor on public.class_members;
create policy class_members_tutor on public.class_members for select
  using (public._teaches_class(class_id) or public._class_tutor(class_id) = auth.uid() or public._class_org_manager(class_id));
drop policy if exists class_teachers_read on public.class_teachers;
create policy class_teachers_read on public.class_teachers for select
  using (teacher_id = auth.uid() or public._teaches_class(class_id) or public._class_org_manager(class_id) or public._in_class(class_id));

-- A learner reads the subjects, topics and work of everyone who teaches them; a teacher reads their learners
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select
  using (id = auth.uid() or tutor_id = auth.uid() or id = public.my_tutor()
         or (role = 'learner' and public._teaches(auth.uid(), id))
         or (role = 'tutor' and id in (select public._my_teachers())));
drop policy if exists subjects_learner on public.subjects;
create policy subjects_learner on public.subjects for select using (tutor_id in (select public._my_teachers()));
drop policy if exists topics_learner on public.topics;
create policy topics_learner on public.topics for select using (tutor_id in (select public._my_teachers()));
drop policy if exists comments_tutor_write on public.comments;
create policy comments_tutor_write on public.comments for insert
  with check (tutor_id = auth.uid() and author_id = auth.uid() and public._teaches(auth.uid(), learner_id));
drop policy if exists comments_learner_write on public.comments;
create policy comments_learner_write on public.comments for insert
  with check (learner_id = auth.uid() and author_id = auth.uid() and tutor_id in (select public._my_teachers()));

create or replace function public.can_learner_see(
  p_tutor uuid, p_learner_ids uuid[], p_subject uuid, p_visibility text, p_visible_from timestamptz
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'learner')
    and p_tutor in (select public._my_teachers())
    and (p_visibility = 'visible' or (p_visibility = 'scheduled' and p_visible_from is not null and p_visible_from <= now()))
    and (case
           when p_learner_ids is not null and cardinality(p_learner_ids) > 0 then auth.uid() = any (p_learner_ids)
           when p_subject is not null then exists (
             select 1 from public.learner_subjects ls where ls.learner_id = auth.uid() and ls.subject_id = p_subject)
           else true
         end)
    and public._student_ok()
$$;

-- Progress, summaries, marking photos: anyone who teaches them
create or replace function public._can_view_learner(p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_learner = auth.uid() or public.is_my_learner(p_learner) or public._teaches(auth.uid(), p_learner)
$$;
create or replace function public.learner_work_paths(p_learner uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct p), '{}') from (
    select f ->> 'path' as p from public.responses r, jsonb_array_elements(coalesce(r.answer -> 'files', '[]'::jsonb)) f
     where r.learner_id = p_learner and r.tutor_id = auth.uid() and public._teaches(auth.uid(), p_learner)
    union all
    select annotation_path from public.responses where learner_id = p_learner and tutor_id = auth.uid() and public._teaches(auth.uid(), p_learner)
    union all
    select attachment_path from public.comments where learner_id = p_learner and tutor_id = auth.uid() and public._teaches(auth.uid(), p_learner)
  ) x where p is not null
$$;
drop policy if exists sb_library_learner on storage.objects;
create policy sb_library_learner on storage.objects for select to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] in (select t::text from public._my_teachers() t) and (
    (storage.foldername(name))[2] in ('questions', 'lessons')
    or exists (select 1 from public.files f where f.storage_path = storage.objects.name
               and public.can_learner_see(f.tutor_id, f.learner_ids, f.subject_id, f.visibility, f.visible_from))));
drop policy if exists sb_work_tutor on storage.objects;
create policy sb_work_tutor on storage.objects for all to authenticated
  using (bucket_id = 'work' and public._teaches(auth.uid(), ((storage.foldername(name))[1])::uuid))
  with check (bucket_id = 'work' and public._teaches(auth.uid(), ((storage.foldername(name))[1])::uuid));

-- Work for a class may be set by any of its teachers
create or replace function public._class_audience() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ids uuid[];
begin
  if new.class_id is null then return new; end if;
  if not public._teaches_class(new.class_id, new.tutor_id) then raise exception 'Unknown class.'; end if;
  if tg_table_name = 'sessions' and tg_op = 'UPDATE' then
    if old.starts_at <= now() then return new; end if; -- (only sessions have a start)
  end if;
  select coalesce(array_agg(m.learner_id order by m.added_at), '{}') into v_ids from public.class_members m where m.class_id = new.class_id;
  if tg_table_name = 'assignments' and tg_op = 'UPDATE' then
    select coalesce(array_agg(x order by x), '{}') into v_ids from (
      select unnest(v_ids) x
      union
      select distinct t.learner_id from public.attempts t where t.assignment_id = new.id and t.learner_id = any (coalesce(old.learner_ids, '{}'))) y;
  end if;
  if cardinality(v_ids) = 0 and tg_table_name in ('assignments', 'lessons', 'files') then v_ids := array[new.class_id]; end if;
  new.learner_ids := v_ids;
  return new;
end $$;
create or replace function public._series_learners(p_class uuid, p_learner_ids uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = public as $$
declare v uuid[];
begin
  if p_class is null then return p_learner_ids; end if;
  if not public._teaches_class(p_class) then raise exception 'Unknown class.'; end if;
  select coalesce(array_agg(learner_id order by added_at), '{}') into v from public.class_members where class_id = p_class;
  if cardinality(v) = 0 then raise exception 'Nobody is in this class yet. Add learners to it first.'; end if;
  return v;
end $$;
-- a weekly lesson for a class checks its learners against the class, not the tutor's own list
create or replace function public._series_check(p_title text, p_first timestamptz, p_learner_ids uuid[], p_timezone text, p_until date)
returns timestamp language plpgsql stable security definer set search_path = public as $$
declare l uuid; v_tz text; v_local timestamp;
begin
  if public.my_role() is distinct from 'tutor' or not public._tutor_active() then raise exception 'Tutors only.'; end if;
  if nullif(trim(coalesce(p_title, '')), '') is null then raise exception 'Give the lesson a title.'; end if;
  if p_first is null then raise exception 'Choose when the first lesson is.'; end if;
  if coalesce(array_length(p_learner_ids, 1), 0) = 0 then raise exception 'Choose at least one learner.'; end if;
  foreach l in array p_learner_ids loop
    if not public._teaches(auth.uid(), l) then raise exception 'Not your learner.'; end if;
  end loop;
  v_tz := coalesce((select name from pg_timezone_names where name = p_timezone), public._tz_of(auth.uid()));
  v_local := date_trunc('minute', p_first at time zone v_tz);
  if p_until is not null and p_until < v_local::date then raise exception 'The last date is before the first lesson.'; end if;
  return v_local;
end $$;

-- The learners someone may put in a class: a manager, everyone in the organisation (its tutors' learners and anyone
-- already in one of its classes); anyone else, their own learners and the learners already in their classes
create or replace function public._class_pool(p_org uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select l.id from public.profiles l where l.role = 'learner' and l.tutor_id = auth.uid()
  union
  select cm.learner_id from public.class_members cm join public.class_teachers ct on ct.class_id = cm.class_id where ct.teacher_id = auth.uid()
  union
  select l.id from public.profiles l join public.org_members m on m.user_id = l.tutor_id
   where public._org_manager(p_org) and m.org_id = p_org and l.role = 'learner'
  union
  select cm.learner_id from public.class_members cm join public.classes c on c.id = cm.class_id
   where public._org_manager(p_org) and c.org_id = p_org
$$;

-- Everyone a manager (or a teacher) can put in a class, with their own tutor's name
create or replace function public.class_pool() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid := public._org_of(auth.uid());
begin
  if public.my_role() is distinct from 'tutor' then return '[]'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.display_name, 'tutor_id', l.tutor_id,
            'tutor', (select display_name from public.profiles t where t.id = l.tutor_id)) order by l.display_name)
          from public.profiles l where l.id in (select public._class_pool(v_org))), '[]');
end $$;

-- Make or change a class: name, subject (optional), teachers (a manager chooses; anyone else teaches their own
-- classes) and who's in it. Learners added are told, and take the class's subject.
drop function if exists public.save_class(uuid, text, uuid, uuid[]);
create or replace function public.save_class(p_id uuid, p_name text, p_subject uuid, p_learner_ids uuid[], p_teacher_ids uuid[] default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := p_id;
  v_name text := left(trim(coalesce(p_name, '')), 80);
  v_org uuid := public._org_of(auth.uid());
  v_manager boolean := public._org_manager(public._org_of(auth.uid()));
  v_teachers uuid[];
  c public.classes;
  l uuid;
  t uuid;
  v_sub_tutor uuid;
begin
  if public.my_role() is distinct from 'tutor' or not public._tutor_active() then raise exception 'Tutors only.'; end if;
  if v_name = '' then raise exception 'Give the class a name.'; end if;
  if v_id is not null then
    select * into c from public.classes where id = v_id;
    if c.id is null or not (c.tutor_id = auth.uid() or public._teaches_class(v_id) or public._org_manager(c.org_id)) then
      raise exception 'Not your class.';
    end if;
    v_org := coalesce(c.org_id, v_org);
    v_manager := public._org_manager(v_org);
  end if;
  -- teachers: a manager picks any of the organisation's tutors; otherwise it stays as it is (a new class: you)
  if p_teacher_ids is not null and cardinality(p_teacher_ids) > 0 and v_manager then
    foreach t in array p_teacher_ids loop
      if not exists (select 1 from public.org_members m join public.profiles p on p.id = m.user_id
                      where m.org_id = v_org and m.user_id = t and p.role = 'tutor') then
        raise exception 'Teachers come from your centre’s tutors.';
      end if;
    end loop;
    v_teachers := p_teacher_ids;
  elsif v_id is null then
    v_teachers := array[auth.uid()];
  end if;
  if p_subject is not null then
    select tutor_id into v_sub_tutor from public.subjects where id = p_subject;
    if v_sub_tutor is null or not (v_sub_tutor = any (coalesce(v_teachers, array(select teacher_id from public.class_teachers where class_id = v_id))) or v_sub_tutor = auth.uid()) then
      raise exception 'The subject has to be one of its teacher’s.';
    end if;
  end if;
  foreach l in array coalesce(p_learner_ids, '{}') loop
    if not (l in (select public._class_pool(v_org)) or (v_id is not null and exists (select 1 from public.class_members where class_id = v_id and learner_id = l))) then
      raise exception 'Not your learner.';
    end if;
  end loop;
  if v_id is null then
    insert into public.classes (tutor_id, name, subject_id, org_id) values (auth.uid(), v_name, p_subject, v_org) returning id into v_id;
  else
    update public.classes set name = v_name, subject_id = p_subject where id = v_id;
  end if;
  if v_teachers is not null then
    delete from public.class_teachers where class_id = v_id and not teacher_id = any (v_teachers);
    insert into public.class_teachers (class_id, teacher_id) select v_id, x from unnest(v_teachers) x on conflict do nothing;
  end if;
  delete from public.class_members where class_id = v_id and not learner_id = any (coalesce(p_learner_ids, '{}'));
  for l in select distinct x from unnest(coalesce(p_learner_ids, '{}')) x
            where not exists (select 1 from public.class_members m where m.class_id = v_id and m.learner_id = x) loop
    perform public._add_to_class(v_id, l);
  end loop;
  return v_id;
end $$;

-- Put someone in a class: they take its subject, and are told
create or replace function public._add_to_class(p_class uuid, p_learner uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.classes;
begin
  select * into c from public.classes where id = p_class;
  insert into public.class_members (class_id, learner_id) values (p_class, p_learner) on conflict do nothing;
  if c.subject_id is not null then
    insert into public.learner_subjects (learner_id, subject_id, tutor_id)
    select p_learner, c.subject_id, s.tutor_id from public.subjects s where s.id = c.subject_id
    on conflict do nothing;
  end if;
  perform public.notify_user(p_learner, 'class', 'You’re in ' || c.name || ' now',
    'Work, lesson notes and live lessons for this class show in StudyBridge.', jsonb_build_object('class_id', p_class));
end $$;

create or replace function public.archive_class(p_id uuid, p_archived boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.classes set archived = coalesce(p_archived, true)
   where id = p_id and (tutor_id = auth.uid() or public._teaches_class(id) or public._org_manager(org_id));
  if not found then raise exception 'Not your class.'; end if;
end $$;

create or replace function public.delete_class(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.classes where id = p_id and (tutor_id = auth.uid() or public._teaches_class(id) or public._org_manager(org_id))) then
    raise exception 'Not your class.';
  end if;
  update public.assignments set class_id = null, learner_ids = null, visibility = 'hidden' where class_id = p_id and learner_ids = array[p_id];
  update public.lessons set class_id = null, learner_ids = null, visibility = 'hidden' where class_id = p_id and learner_ids = array[p_id];
  update public.files set class_id = null, learner_ids = null, visibility = 'hidden' where class_id = p_id and learner_ids = array[p_id];
  delete from public.classes where id = p_id;
end $$;

-- A class's code: anyone with it can join the class, from any tutor, centre or school (a new account becomes a
-- learner of its first teacher)
create or replace function public.class_code(p_class uuid, p_new boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare c public.classes;
begin
  select * into c from public.classes where id = p_class;
  if c.id is null or not (c.tutor_id = auth.uid() or public._teaches_class(c.id) or public._org_manager(c.org_id)) then
    raise exception 'Not your class.';
  end if;
  if c.join_code is null or p_new then
    update public.classes set join_code = public._new_org_code() where id = c.id returning join_code into c.join_code;
  end if;
  return c.join_code;
end $$;

-- Join with a class code (Settings → Join a class). A wrong code is counted and returns nothing.
create or replace function public.join_class(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  k text := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
  c public.classes;
  me public.profiles;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then raise exception 'Not signed in.'; end if;
  if me.role is not null and me.role <> 'learner' then raise exception 'Only learners join classes.'; end if;
  if (select count(*) from public.invite_tries where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many wrong codes. Wait an hour, or ask for the code again.';
  end if;
  select * into c from public.classes where join_code = k and length(k) = 8 and not archived;
  if c.id is null then
    insert into public.invite_tries (user_id) values (auth.uid());
    return null;
  end if;
  if me.self_learner then raise exception 'This account studies on its own with StudyBridge. Use another account for a class.'; end if;
  if me.role is null then
    update public.profiles set role = 'learner',
           tutor_id = (select teacher_id from public.class_teachers where class_id = c.id order by added_at limit 1)
     where id = auth.uid();
  end if;
  if exists (select 1 from public.class_members where class_id = c.id and learner_id = auth.uid()) then
    return jsonb_build_object('class', c.name, 'already', true);
  end if;
  perform public._add_to_class(c.id, auth.uid());
  perform public.notify_user(ct.teacher_id, 'joined', coalesce(me.display_name, 'A learner') || ' joined ' || c.name, 'They used the class code.',
    jsonb_build_object('learner_id', auth.uid())) from public.class_teachers ct where ct.class_id = c.id;
  return jsonb_build_object('class', c.name, 'already', false);
end $$;

-- A learner's teachers, for their Messages (their own tutor first)
create or replace function public.my_teachers() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'main', p.id = (select tutor_id from public.profiles where id = auth.uid()),
           'classes', (select coalesce(jsonb_agg(c.name order by c.name), '[]') from public.class_teachers ct join public.classes c on c.id = ct.class_id
                        join public.class_members cm on cm.class_id = c.id where ct.teacher_id = p.id and cm.learner_id = auth.uid()))
         order by p.id = (select tutor_id from public.profiles where id = auth.uid()) desc, p.display_name), '[]')
    from public.profiles p where p.id in (select public._my_teachers())
$$;

-- The tutor's Home: the learners in their classes have cards too
create or replace function public._home_learners() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.profiles where tutor_id = auth.uid() and role = 'learner'
  union
  select cm.learner_id from public.class_teachers ct join public.class_members cm on cm.class_id = ct.class_id where ct.teacher_id = auth.uid()
$$;

grant execute on all functions in schema public to authenticated;
-- Only the Prof server may call these
do $$
declare f text;
begin
  foreach f in array array['prof_hello(text)', 'prof_claim(uuid)', 'prof_save(uuid, text, jsonb, jsonb, text, text, int, int, numeric, text, int, jsonb)',
                           'prof_context(uuid)', 'prof_mark_context(uuid)', 'prof_orphan_files()', 'prof_tick()', '_prof_kick()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
grant execute on all functions in schema public to service_role;
revoke execute on function public._admin_log(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public._studybridge_account() from public, anon, authenticated;
revoke execute on function public._content_me() from public, anon, authenticated;
revoke execute on function public._content_topic(uuid, text) from public, anon, authenticated;
revoke execute on function public._content_paper_ready(uuid) from public, anon, authenticated;
revoke execute on function public._content_mark(text, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public._content_alert(text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public._storage_bytes(uuid) from public, anon, authenticated;
revoke execute on function public._learner_topics(uuid, boolean, uuid) from public, anon, authenticated;
revoke execute on function public._assignment_visible_to(public.assignments, uuid) from public, anon, authenticated;
revoke execute on function public._report_numbers(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public._refresh_reports() from public, anon, authenticated;
revoke execute on function public._prof_month_cents(uuid) from public, anon, authenticated;
revoke execute on function public.notify_user(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public._make_admin(text, uuid) from public, anon, authenticated, service_role;
revoke execute on function public._prof_alert(uuid) from public, anon, authenticated;
revoke execute on function public.calendar_feed(text) from public, anon, authenticated;
revoke execute on function public.make_admin(text) from public, anon, authenticated, service_role;
revoke execute on function public._fill_series(uuid, int) from public, anon, authenticated;
revoke execute on function public._series_notify(uuid, text) from public, anon, authenticated;
revoke execute on function public._series_check(text, timestamptz, uuid[], text, date) from public, anon, authenticated;
revoke execute on function public._lesson_reminders() from public, anon, authenticated;
revoke execute on function public._lesson_tick() from public, anon, authenticated;
revoke execute on function public._tz_of(uuid) from public, anon, authenticated;
revoke execute on function public._in_audience(public.assignments, uuid) from public, anon, authenticated;
revoke execute on function public._mock_boundary(uuid) from public, anon, authenticated;
revoke execute on function public._grade_for(jsonb, numeric, numeric, numeric) from public, anon, authenticated;
revoke execute on function public._mock_result(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public._parent_link(uuid) from public, anon, authenticated;
revoke execute on function public._hand_in(uuid, text) from public, anon, authenticated;
revoke execute on function public._auto_hand_in() from public, anon, authenticated;
revoke execute on function public._study_reminders(timestamptz) from public, anon, authenticated;
revoke execute on function public._push_keys(text, text) from public, anon, authenticated;
revoke execute on function public._push_claim(int) from public, anon, authenticated;
revoke execute on function public._push_done(bigint, int, text) from public, anon, authenticated;
revoke execute on function public._set_paid_plan(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public._email_us(text, text, text, text) from public, anon, authenticated;
revoke execute on function public._check_plan_room() from public, anon, authenticated;
revoke execute on function public._self_practice_ok() from public, anon, authenticated;
revoke execute on function public._email_student(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public._email_welcome(uuid) from public, anon, authenticated;
revoke execute on function public._email_all_set(uuid) from public, anon, authenticated;
revoke execute on function public._student_emails_tick() from public, anon, authenticated;
revoke execute on function public._student_paid_by_card(uuid, text, int, text) from public, anon, authenticated;
revoke execute on function public._student_renewed(text) from public, anon, authenticated;
revoke execute on function public._org_of(uuid) from public, anon, authenticated;
revoke execute on function public._ensure_org(uuid) from public, anon, authenticated;
revoke execute on function public._new_org_code() from public, anon, authenticated;
revoke execute on function public._profile_org() from public, anon, authenticated;
revoke execute on function public._org_tidy() from public, anon, authenticated;
revoke execute on function public._org_mine_to_change() from public, anon, authenticated;
revoke execute on function public._class_audience() from public, anon, authenticated;
revoke execute on function public._class_sync() from public, anon, authenticated;
revoke execute on function public._invite_classes() from public, anon, authenticated;
revoke execute on function public._series_learners(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public._class_pool(uuid) from public, anon, authenticated;
revoke execute on function public._add_to_class(uuid, uuid) from public, anon, authenticated;
revoke execute on function public._home_learners() from public, anon, authenticated;
revoke execute on function public._class_made() from public, anon, authenticated;
-- Prof money is the admin's business only: tutors can't ask for their allowance or read it
revoke execute on function public._prof_limit(uuid) from public, anon, authenticated;
revoke execute on function public._prof_ready(uuid) from public, anon, authenticated;
revoke execute on function public._prof_credit_spend(numeric) from public, anon, authenticated;
revoke all on public.prof_credit from public, anon, authenticated;
revoke all on public.prof_limits from public, anon, authenticated;
revoke all on public.calendar_tokens from public, anon, authenticated;
-- The app only needs the minimum version from the settings row; the rest goes through admin functions
revoke select on public.app_config from public, anon, authenticated;
grant select (id, min_version) on public.app_config to authenticated;

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
    foreach t in array array['notifications', 'comments', 'attempts', 'responses', 'assignments', 'sessions', 'claude_drafts', 'prof_jobs', 'lessons'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when others then null;
      end;
    end loop;
  end if;
end $$;

-- Prof's minute-by-minute check (restarts stuck jobs, runs weekly auto-created work)
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('studybridge-prof', '* * * * *', 'select public.prof_tick()');
  perform cron.schedule('studybridge-lessons', '*/5 * * * *', 'select public._lesson_tick()');
  perform cron.schedule('studybridge-handin', '* * * * *', 'select public._auto_hand_in()');
  perform cron.schedule('studybridge-reminders', '*/10 * * * *', 'select public._study_reminders()');
  perform cron.schedule('studybridge-students', '17 * * * *', 'select public._student_emails_tick()');
exception when others then
  raise notice 'pg_cron is not available; Prof still works when asked, but weekly auto-created work needs Cron (Supabase → Integrations → Cron)';
end $$;

select 'StudyBridge database is ready' as status;
