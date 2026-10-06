# StudyBridge — notes for Claude

Read this first in any new chat. It's the hand-off from the chat that built 1.0–1.5.

## What it is
A tutor–learner app by Aaryan Chouhan (GitHub aaryanc-1): Electron desktop app (Windows/Mac) plus a
phone web app, React 19 + Vite (`base: './'`, hash routing), Supabase behind it. Not sold yet; Aaryan is
the only tutor and his sister is a test learner. It's meant to become a paid product for other tutors.

- **Database:** `supabase/setup.sql` (RLS, SECURITY DEFINER functions, pg_cron). Safe to re-run; Aaryan
  pastes it into the Supabase SQL editor after every change to it.
- **Prof** (the tutor-only AI assistant): Supabase edge function `supabase/functions/prof/index.ts`
  (service role, `--no-verify-jwt`). Aaryan pastes it into Supabase and redeploys after changes. It also
  serves the calendar (ICS) links.
- **Accounts:** one sign-in page; the role decides tutor / learner / admin. The admin is a separate
  account (role 'admin', `aaryanchouhan1+admin@gmail.com`). No authenticator/two-step.
- **Releases:** `.github/workflows/build.yml` builds version 1.1.<run>, publishes to the public repo
  `aaryanc-1/studybridge-releases` (desktop auto-updates) and the phone app to GitHub Pages at
  https://aaryanc-1.github.io/studybridge-releases/app/
- **Logo:** `brand/` → `npm run icons` (scripts/make-icons.py) makes every icon.

## Tests (run before every commit)
- `npm test` — PGlite runs the real setup.sql (`test/db.test.mjs`), fake Supabase/Claude, Prof tests (57)
- `npm run product` and `npm run walkthrough` — Playwright end-to-end, screenshots in `test/screenshots`

## Rules Aaryan set (always)
- Never ask him to paste keys or secrets in chat. Keys go in app settings, Admin, or the server.
- Learners never use AI. Everything AI-made needs tutor approval (admin approval for shared StudyBridge content).
- Tutors never see Prof money or usage; only the admin does.
- Never host or redistribute exam-board papers. Official papers stay private to the tutor who imports
  them; only original (tutor- or Prof-written) papers are shared.
- When he says "discuss", discuss before building. The landing page is built only when he says "build".
- Commit as `git -c user.name="Aaryan Chouhan" -c user.email="aaryanchouhan1@gmail.com" commit`.
- Plain, friendly wording in the app; explain setup steps simply (he's not a database person).
- Keep the master doc updated after each release. A full copy is in `docs/MASTER.md` (features, setup,
  costs and draft pricing, roadmap, known issues, changelog). If the Claude Docs version isn't reachable
  from this account, make a new Claude Doc from `docs/MASTER.md` and keep both in step. Done 5 Oct 2026:
  the master is now the Claude Doc at https://claude.ai/code/artifact/3b8ca1b2-2874-4413-9c2a-d73cdb1eed8f

## Done so far
1.0 core (assignments, marking, lessons, live video, offline, lockdown) · 1.1 service (tutor approval,
Admin, Prof on the server, auto-update, backups) · 1.2 past papers, question bank, practice, parent
reports · 1.3 separate admin account, exams per subject, IB filing · 1.4 crash reports, admin pages,
syllabus + coverage map, Study (flashcards, daily quiz, drills, formula sheets, goal/streak),
self-marking, calendar link, StudyBridge practice papers · coverage you can set, Admin → Prof page
(credit countdown) · 1.5 (app 1.1.30) new logo, getting-started checklist, polish.
1.6 part 1: weekly lessons (`lesson_series` → `sessions` with series_id/series_date, made 8 weeks ahead and topped
up hourly by pg_cron `studybridge-lessons`), skip / move / change-from-here / stop, reminders a day and 15 minutes
before (`_lesson_reminders`), both time zones shown, learners' own ntfy phone alerts (`phone_alerts`).
1.6 part 2: mock exams (`mocks`; papers are assignments with `mock_id`/`mock_position`), grade boundaries per exam and
session (`grade_boundaries`, tutor-only; `_grade_for` scales them to the mock's total; `mock_results`, `my_mocks`,
`mock_history`; latest released mock grade in `_report_numbers`), Prof reads a grade-threshold PDF (job kind
`boundaries`, tutor saves what they check), syllabus shown in order with subtopics and "Set up the whole syllabus"
merging (`applyTopics(..., { reorder: true })`), Library tabs renamed "My files" and "Lesson notes", Prof page shows
the latest 5 requests + History (`/prof/history`).
1.6 part 3: parent accounts (role 'parent', never a tutor_id, so no tutor/learner tables open; `parent_links`,
`parent_invites` with codes 'P'+10 hex, `accept_parent_invite`, `parent_children`, `parent_view` hand out only approved
reports, upcoming lessons/due dates, released marks, topics, released mock grades, exam countdown; learner and tutor
see/remove links via `learner_parents`/`remove_parent`). Weekly report is now a template (`ReportCard.jsx`, prints
as PDF) filled from `_report_numbers`; the tutor writes only a comment (Prof can suggest one) and approves; approving
needs a linked parent or the learner's WhatsApp/email switch. Parent app: `src/screens/parent/ParentApp.jsx`.

## Next (1.6, agreed)
Recurring lessons with reminders in both time zones · mock exam mode with predicted grade (Cambridge
grade boundaries) · parent accounts (read-only) · data-saver mode · then selling basics: email from his
domain, Google sign-in, terms/privacy, data export/delete, payments (after pricing), landing page.

Decided 5 Oct 2026, before building 1.6:
- Build 1.6 in parts, each its own auto-update; update the master doc after each part.
- Recurring lessons keep the tutor's clock time when clocks change (Aaryan is in New York, his sister in Lusaka,
  which has no daylight saving): US clocks go back on 1 Nov 2026, so 10:00 New York moves from 16:00 to 17:00 Lusaka.
- Mock exam grade boundaries are set once per exam and session (changed 5 Oct 2026 from "per mock"): every mock for
  that exam uses the newest, and a mock can be pinned to another session. The tutor types them, or Prof reads the
  tutor's own grade-threshold PDF and the tutor checks them. Boundaries stay private to that tutor; learners see
  only their grade ("Mock grade", not "predicted") and how many marks short of the next one. Plain maths, never AI.
- Weekly parent reports always wait for the tutor's approval before going to a parent.
- Lesson recording + Prof notes: on hold (paid services: speech-to-text and LiveKit recording).
- Website/landing page: Aaryan said "build" (5 Oct 2026); host on GitHub Pages until he gives a domain; pricing is
  Claude's call from the competitor comparison; interactive and modern.
- The repo `aaryanc-1/studybridge` is publicly readable (it was thought to be private). Raise it with Aaryan
  before selling; private repos get limited Actions minutes and the Mac builds use them fastest.
