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

-- The question bank: questions a tutor keeps to reuse (their own), and StudyBridge's shared exam-style
-- questions (owner_id null), which every tutor can use once the StudyBridge admin has approved them.
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
-- question bank: a tutor's own questions; shared ones once approved; the admin reviews shared ones
create policy bank_own on public.bank_questions for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid() and public.my_role() = 'tutor');
create policy bank_shared_read on public.bank_questions for select
  using (owner_id is null and status = 'approved' and public._tutor_active());
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
  delete from public.learner_subjects where learner_id = p_learner;
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
  select s.livekit_url, k.livekit_api_key, k.livekit_api_secret into v_url, v_key, v_secret
    from public.tutor_settings s left join public.tutor_secrets k on k.tutor_id = s.tutor_id where s.tutor_id = v_tutor;
  if v_url is null or v_key is null or v_secret is null then
    -- the tutor hasn't added their own: use StudyBridge's shared live video, if the admin set it up
    select c.livekit_url, ps.livekit_api_key, ps.livekit_api_secret into v_url, v_key, v_secret
      from public.app_config c, public.platform_secrets ps where c.id = 1 and ps.id = 1;
  end if;
  if v_url is null or v_key is null or v_secret is null then
    raise exception 'Live video is not set up yet. The tutor adds the LiveKit keys in Settings.';
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
    'url', coalesce((select livekit_url from public.tutor_settings where tutor_id = public.my_tutor()), (select livekit_url from public.app_config where id = 1)))
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

create or replace function public.admin_set_plan(p_user uuid, p_plan text, p_ai_limit_cents int default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin();
  if not exists (select 1 from public.profiles where id = p_user and role = 'tutor') then raise exception 'That isn’t a tutor account.'; end if;
  if p_ai_limit_cents is not null and p_ai_limit_cents < 0 then raise exception 'The AI limit can’t be negative.'; end if;
  update public.profiles set plan = coalesce(nullif(trim(p_plan), ''), plan) where id = p_user;
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

-- Counts how often bank questions are used (shared ones can't be edited by tutors)
create or replace function public.bank_used(p_ids uuid[])
returns void language sql security definer set search_path = public as $$
  update public.bank_questions set uses = uses + 1
   where id = any(p_ids) and (owner_id = auth.uid() or (owner_id is null and status = 'approved' and public._tutor_active()))
$$;

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
-- Built from the tutor's approved question bank (their own questions + StudyBridge's shared ones),
-- auto-marked questions only, any number of tries, answers shown straight away.
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
begin
  select * into me from public.profiles where id = auth.uid();
  if me.role is distinct from 'learner' then raise exception 'For learners.'; end if;
  if not public._tutor_active(me.tutor_id) then raise exception 'Practice isn’t available right now.'; end if;
  if p_mode not in ('daily', 'topic', 'learn', 'drill') then raise exception 'Unknown practice.'; end if;
  v_today := (now() at time zone coalesce((select name from pg_timezone_names where name = me.timezone), 'UTC'))::date;
  -- one daily quiz a day
  if p_mode = 'daily' then
    select id into v_id from public.assignments
     where tutor_id = me.tutor_id and source = 'self' and learner_ids = array[me.id] and title = 'Daily quiz · ' || to_char(v_today, 'DD Mon')
     order by created_at desc limit 1;
    if v_id is not null then return jsonb_build_object('assignment_id', v_id, 'existing', true); end if;
    n := 5;
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
     where bq.status = 'approved' and (bq.owner_id = me.tutor_id or bq.owner_id is null)
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
  insert into _picked
  select bq.id, row_number() over () from (
    select bq.id from public.bank_questions bq
     where bq.status = 'approved' and (bq.owner_id = me.tutor_id or bq.owner_id is null)
       and bq.type in ('mcq', 'numeric') and bq.image_path is null
       and ((v_subject is null and (bq.subject_id = any (coalesce(v_subjects, '{}')) or bq.exam_code = any (coalesce(v_codes, '{}'))))
            or (v_subject is not null and (bq.subject_id = v_subject or bq.exam_code = any (coalesce(v_codes, '{}')))))
       and (p_topic is null or lower(bq.topic) = lower(trim(p_topic)))
       and bq.id is distinct from v_ex.id
     order by case when p_mode = 'daily' and lower(bq.topic) = any (coalesce(v_weak, '{}')) then 0 else 1 end, random()
     limit n) bq;
  if not exists (select 1 from _picked) then
    raise exception '%', case when p_mode = 'learn' then 'There aren’t enough questions on this topic yet for “you try”.'
                              else 'There aren’t any practice questions for this yet. Ask your tutor to add some to the question bank.' end;
  end if;
  if v_subject is null then
    select coalesce(bq.subject_id, (select s.id from public.subjects s where s.id = any (coalesce(v_subjects, '{}')) and split_part(s.exam, ':', 2) = bq.exam_code limit 1))
      into v_subject from public.bank_questions bq join _picked p on p.bid = bq.id order by p.ord limit 1;
  end if;
  v_title := case p_mode
    when 'daily' then 'Daily quiz · ' || to_char(v_today, 'DD Mon')
    when 'learn' then 'Worked example: ' || coalesce(nullif(trim(p_topic), ''), 'mixed')
    when 'drill' then 'Timed drill' || coalesce(': ' || nullif(trim(p_topic), ''), '') || coalesce(' · ' || p_minutes || ' min', '')
    else 'Practice: ' || coalesce(nullif(trim(p_topic), ''), 'mixed') end;
  insert into public.assignments (tutor_id, title, kind, practice, subject_id, learner_ids, visibility, draft, max_attempts,
     release_mode, show_answers, time_limit_min, lockdown, camera, allow_notes, source, instructions_md)
  values (me.tutor_id, left(v_title, 200), 'quiz', true, v_subject, array[me.id], 'visible', false, 50,
     'on_submit', true, case when p_mode = 'drill' then greatest(1, least(coalesce(p_minutes, 10), 180)) end, false, false, true, 'self', v_instr)
  returning id into v_id;
  for b in select bq.* from public.bank_questions bq join _picked p on p.bid = bq.id order by p.ord loop
    insert into public.questions (assignment_id, tutor_id, position, type, prompt_md, options, marks, topic_id)
    values (v_id, me.tutor_id, i, b.type, b.prompt_md, b.options, b.marks,
            (select t.id from public.topics t where t.tutor_id = me.tutor_id and lower(t.name) = lower(b.topic)
               and (t.subject_id = v_subject or v_subject is null) limit 1))
    returning id into qid;
    insert into public.question_keys (question_id, tutor_id, answer, mark_scheme_md, solution_md)
    values (qid, me.tutor_id, b.answer, b.mark_scheme_md, b.solution_md);
    i := i + 1;
  end loop;
  update public.bank_questions set uses = uses + 1 where id in (select bid from _picked) or id = v_ex.id;
  return jsonb_build_object('assignment_id', v_id, 'questions', i);
end $$;

-- Topics a learner can practise (from the bank their tutor approved), per subject
create or replace function public.practice_topics()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('subject_id', z.subject_id, 'topic', z.topic, 'questions', z.n, 'examples', z.ex) order by z.topic), '[]')
  from (
    select s.id subject_id, bq.topic, count(*) n, count(*) filter (where nullif(bq.solution_md, '') is not null) ex
      from public.learner_subjects ls
      join public.subjects s on s.id = ls.subject_id
      join public.bank_questions bq on (bq.subject_id = s.id or (s.exam is not null and bq.exam_code = split_part(s.exam, ':', 2)))
     where ls.learner_id = auth.uid() and bq.status = 'approved' and (bq.owner_id = public.my_tutor() or bq.owner_id is null)
       and bq.type in ('mcq', 'numeric') and bq.image_path is null and bq.topic is not null and public.my_role() = 'learner'
     group by s.id, bq.topic) z
$$;

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
  if auth.uid() is null or v_l is null or not (v_l = auth.uid() or coalesce(public.is_my_learner(v_l), false)) then raise exception 'Not your learner.'; end if;
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
create policy sb_papers_read on public.sb_papers for select using (public.is_platform_admin() or (status = 'approved' and public._tutor_active()));

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
  if public.my_role() is distinct from 'tutor' then raise exception 'Only tutors can send these.'; end if;
  if (select count(*) from public.feedback where user_id = auth.uid() and created_at > now() - interval '1 day') >= 20 then
    raise exception 'That’s a lot of messages today. Try again tomorrow.';
  end if;
  insert into public.feedback (user_id, kind, body, app_version) values (auth.uid(), coalesce(p_kind, 'question'), trim(p_body), left(p_version, 30))
  returning id into v;
  select display_name into who from public.profiles where id = auth.uid();
  for a in select user_id from public.platform_admins pa join public.profiles p on p.id = pa.user_id where p.role = 'admin' loop
    perform public.notify_user(a, 'feedback', coalesce(who, 'Someone') || ' wrote to StudyBridge', left(trim(p_body), 200), jsonb_build_object('feedback_id', v));
  end loop;
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
    'tutors', (select count(*) from public.profiles where role = 'tutor' and status = 'active'),
    'pending', (select count(*) from public.profiles where role = 'tutor' and status = 'pending'),
    'learners', (select count(*) from public.profiles where role = 'learner'),
    'active_7d', (select count(*) from public.profiles where role in ('tutor', 'learner') and last_seen_at > now() - interval '7 days'),
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
  update public.parent_invites set revoked = true where id = p_invite and tutor_id = auth.uid() and accepted_by is null;
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
  perform public.notify_user(inv.tutor_id, 'parent_joined', v.display_name || ' can now follow ' || l.display_name || '’s progress',
    'They joined as a parent. They see approved reports, lessons, due dates and marks you’ve given back.', jsonb_build_object('learner_id', l.id));
  perform public.notify_user(l.id, 'parent_joined', v.display_name || ' can now see your progress',
    'They see your weekly reports, lessons, due dates and marks once they’re given back. Never your messages or working. You can remove them in Settings.', '{}');
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
                                                   and i.accepted_by is null and not i.revoked), '[]') end);
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
    perform public._hand_in(t.id, 'tried to leave the exam ' || t.strikes || ' time' || case when t.strikes = 1 then '' else 's' end);
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
exception when others then
  raise notice 'pg_cron is not available; Prof still works when asked, but weekly auto-created work needs Cron (Supabase → Integrations → Cron)';
end $$;

select 'StudyBridge database is ready' as status;
