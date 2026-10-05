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
  from this account, make a new Claude Doc from `docs/MASTER.md` and keep both in step.

## Done so far
1.0 core (assignments, marking, lessons, live video, offline, lockdown) · 1.1 service (tutor approval,
Admin, Prof on the server, auto-update, backups) · 1.2 past papers, question bank, practice, parent
reports · 1.3 separate admin account, exams per subject, IB filing · 1.4 crash reports, admin pages,
syllabus + coverage map, Study (flashcards, daily quiz, drills, formula sheets, goal/streak),
self-marking, calendar link, StudyBridge practice papers · coverage you can set, Admin → Prof page
(credit countdown) · 1.5 (app 1.1.30) new logo, getting-started checklist, polish.

## Next (1.6, agreed)
Recurring lessons with reminders in both time zones · mock exam mode with predicted grade (Cambridge
grade boundaries) · parent accounts (read-only) · data-saver mode · then selling basics: email from his
domain, Google sign-in, terms/privacy, data export/delete, payments (after pricing), landing page.
