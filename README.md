# StudyBridge

A tutoring portal: tutors set up programmes and subjects, upload textbooks, set homework, quizzes, tests and exams, mark work and follow progress. Learners do their work in StudyBridge (on a laptop, even offline), leave notes, and get their marks and feedback back. **Prof**, the built-in AI teaching assistant, drafts work and marking for tutors; nothing it makes reaches a learner until the tutor approves it. Learners never use AI.

StudyBridge runs as a service: **anyone can sign up as a tutor and you (the StudyBridge admin) approve them**. Learners only ever join through their tutor's invite, which always makes a learner account. As admin you manage accounts and access (approve, pause, passwords, delete, Prof allowances) but never see anyone's work.

One app: **StudyBridge for Windows and Mac** (tutors and learners), plus the same app in a phone browser. Installed apps **update themselves**.

## What's in it

**Tutor**
- Programmes → subjects (with colours) → topics, all named by you. Add learners any time with an invite.
- Library: upload any file (PDFs open inside the app). Every file and lesson is **hidden**, **visible**, or **visible from a date**, for everyone in the subject or chosen learners.
- Lessons with maths (`$x^2$`), images and attached files.
- Assignments: homework, quiz, test, exam. Six question kinds: multiple choice, number, **maths with working (line by line)**, written, photo of work on paper, drawing.
- Per assignment: **lockdown** (screen stays on StudyBridge until handed in), **camera** (watch their camera and screen live), time limit, attempts, when marks are released, whether answers are shown, notes allowed.
- Marking: auto-marking for multiple choice and numbers; tick or cross each line of working (a built-in checker flags lines that don't follow); draw on photos; feedback, mistake labels, "redo this question".
- Progress: strengths per topic, time studied per day and subject, weekly and monthly summaries, missed deadlines, mistakes.
- Notes from learners arrive instantly (desktop notification, and phone push through the free ntfy app).
- Live lessons: video, screen sharing and a shared whiteboard.
- **Prof**: ask for homework, quizzes, tests, exams or lessons (optionally from pages of your own textbooks); switch on **auto-marking** and **weekly work**. Everything waits in Prof → *Waiting for you*.

**Learner**
- Today: what's due, streak, marks back, next live lesson.
- Doing work: answers save as they type; works offline and hands in when the connection is back; photos of paper working; whiteboard; textbook open beside the questions; notes to the tutor on any question.
- Results with feedback, ticked working, marked-up photos and (if allowed) worked solutions. Redo when asked.
- Library, progress, messages, live lessons.

**StudyBridge admin (you)**
- Admin is its **own account**, separate from your tutor account, and needs **two-step sign-in** (a code from an authenticator app) every time. A tutor account never has admin powers.
- Admin pages: tutors waiting for approval, every tutor's account (status, plan, learners, files used, Prof spend), their learners' accounts, unfinished sign-ups.
- Approve or decline tutors, pause (suspend) and switch back on, set passwords, delete accounts, plans and Prof allowances.
- The Claude key for Prof (write-only: it can never be read back), the model, and shared live video for every tutor.
- A log of everything done; tutors see what was done to their own account (Settings).

## Setting it up (you, once)

You need: a **Supabase** project (your existing one is fine: it becomes the central StudyBridge server, and your account becomes the admin), a **Claude API key** from [console.anthropic.com](https://console.anthropic.com), and optionally a **LiveKit Cloud** project for video. Never paste keys or passwords into a chat; they go into the boxes named below.

1. **Database.** Supabase → **SQL Editor** → paste [`supabase/setup.sql`](supabase/setup.sql) → **Run** ("StudyBridge database is ready"). Then **Authentication → Sign In / Providers → Email** → turn off **Confirm email**. In **Database → Extensions** turn on **pg_net**, and in **Integrations → Cron** turn on Cron (setup.sql tries both itself).
2. **A public page for app downloads and updates.** On GitHub create an empty **public** repository named `studybridge-releases`. Then GitHub → Settings → Developer settings → **Fine-grained tokens** → generate one with access to *only* `studybridge-releases`, permission **Contents: Read and write**.
3. **Tell GitHub about your server** (this repo → Settings → Secrets and variables → Actions):
   - *Variables*: `SUPABASE_URL` (Project URL) and `SUPABASE_ANON_KEY` (anon / publishable key). These are built into the apps so nobody types them.
   - *Secrets*: `RELEASES_TOKEN` (the token from step 2); `SUPABASE_DB_URL` (Supabase → **Connect** → *Session pooler* connection string, with your database password in it); `SUPABASE_ACCESS_TOKEN` (from [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)); `BACKUP_PASSWORD` (any long password, to encrypt backups; keep it somewhere safe).
4. **Build.** Push to `main` (or Actions → Build → Run workflow). Every build now also updates the database, deploys the Prof server, and publishes the apps to `studybridge-releases`.
5. **Install** StudyBridge from `studybridge-releases` → the latest release (Windows: `StudyBridge-Setup-….exe`, Mac: the `.dmg` for your chip). Windows may warn about an unknown publisher: **More info → Run anyway**. Mac: open it once, then **System Settings → Privacy & Security → Open Anyway**. After this, it updates itself.
6. **Sign in** with your usual (tutor) account. The first time, **Admin** in the menu asks for the email of your separate admin account (a Gmail `you+admin@gmail.com` works). Sign out, create an account with that email, choose **Set up admin account**, and scan the code with an authenticator app. From then on, sign in with that email to open Admin.
   - Lost the phone with the authenticator? In Supabase → SQL Editor run `delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'you+admin@gmail.com');` and sign in again to set up a new one. To make a different account the admin: `select public.make_admin('new@example.com');`
7. **Switch Prof on**: Admin → StudyBridge settings → Prof → paste the Claude API key, pick the model (Sonnet 5.5 is the sweet spot), set the default monthly allowance per tutor → **Save** → **Check the Prof server**.
8. **Live video for everyone (optional)**: at [cloud.livekit.io](https://cloud.livekit.io) → Settings → API keys, then Admin → *Live video for every tutor*.
9. **Phone alerts**: install **ntfy** on your phone and subscribe to the topic in Settings → Phone alerts. You'll get a push when a tutor signs up.

### New tutors

Send them the download link (your `studybridge-releases` page). They open StudyBridge → **I'm a tutor** → create an account and see *Waiting for approval*. Your admin account gets a notification; open **Tutors** → **Approve**. They can then set up subjects and invite learners. Pausing a tutor stops them signing in (their learners can still sign in and see past work); nothing is deleted.

## Prof (the AI teaching assistant)

- **Ask**: Prof → *Ask Prof*, e.g. "a 10-question quiz on simultaneous equations for Anaya, due Friday". Add pages from a PDF in your library (or a photo) and Prof bases the questions on them. It writes the questions, answers, mark schemes and worked solutions as a **draft**.
- **Auto-marking**: when a learner hands in, Prof suggests marks, ticks each line of working, labels mistakes and writes feedback. You check it (Marking → *Use Prof's marks*, or Prof → *Waiting for you*) before anything goes back.
- **Weekly work**: once a week Prof drafts work for each learner, aimed at the topics they find hardest.
- **How Prof should write for you**: your syllabus, level and style (Prof → settings).
- **Drafts only, enforced by the database**: the server's key can't post work, change marks or message anyone.
- **Cost**: you pay Anthropic for the API. A 10-question assignment is roughly 3–10¢ with Sonnet 5.5; marking one submission a few cents. Every tutor has a monthly allowance (Admin) and sees their own use in Prof.
- It runs on Supabase (Edge Function `prof`), so it works while every laptop is closed.

## Updating

Installed apps update themselves: new screens and features download in the background and apply on the next start (a banner offers **Restart now**). If an update ever fails to start, the app goes back to the version it came with. When the desktop shell itself changes, Windows installs the new version quietly on restart; a Mac downloads the new `.dmg` and asks you to drag it into Applications. The database and Prof server are updated by the same build, so they always match.

## Backups

Every night GitHub Actions saves an encrypted copy of the database (Actions → **Nightly backup** → a run → Artifacts; kept 30 days). To restore: decrypt with `gpg -d studybridge-….tgz.gpg | tar xz`, then `pg_restore --no-owner -d "<connection string>" public.dump` and `pg_restore --no-owner --data-only -d "<connection string>" auth.dump` into a fresh project that has had setup.sql run. Uploaded files (PDFs, photos) live in Supabase Storage and aren't in this copy.

## Adding a learner

Learners → **Invite a learner** → choose their programme and subjects → **Copy message**. Send them the download link and the message. They open the app, choose **I'm a learner**, paste the invite and make an account: it's always a learner account, linked to the tutor who invited them.

## Passwords

- **A learner forgot theirs:** Learners → their name → **Account** → set a new password (or press **Make one up**) and tell them. They can change it in Settings afterwards.
- **A tutor forgot theirs:** Admin → their name → **Password**.
- **You (the admin) forgot yours:** in the Supabase SQL Editor run
  `update auth.users set encrypted_password = extensions.crypt('your-new-password', extensions.gen_salt('bf')) where email = 'you@example.com';`

## Good to know

- **Lockdown** fills the screen, blocks the usual shortcuts, brings the window back if they switch away, and reports every attempt to you instantly. It can't stop a second device (a phone), so use **camera** for tests that matter. A learner can leave in an emergency, and you're told when they do.
- Tests and exams with lockdown or camera need the desktop app; everything else also works in a browser.
- Questions of tests and exams stay hidden until the learner starts.
- Answers are never visible to learners early: mark schemes live in a separate table only you can read, and marks stay hidden until you release them.
- **Offline:** the app keeps a copy of everything a learner has opened (work, lessons, PDFs). Answers and hand-ins made offline send automatically when the connection returns. Starting a brand-new assignment needs a connection once.
- Storage: Supabase's free plan includes 1 GB of files. Lots of textbook PDFs may need the Pro plan later.
- Each tutor only ever sees their own learners and work; learners only their own. The admin sees account details, never content (enforced by the database's security rules, with every admin action logged).
- Storage: Supabase's free plan includes 1 GB of files and 500 MB of database. Admin shows each tutor's files; move to Supabase Pro when it fills up.

## Develop

```sh
npm install
(cd connector && npm install)
npm test            # database rules, fake server, Prof (with a stand-in Claude), maths checker, Claude connector
npm run build       # web app into dist/ (same files for desktop and phone)
npm start           # desktop app
npm run walkthrough # tutor + learner + phone + offline, end to end in Chromium (screenshots in test/screenshots)
npm run product     # tutor sign-up + approval, admin console, Prof making and approving a quiz
xvfb-run -a node test/electron-lockdown.mjs   # desktop lockdown (add LIVEKIT_URL=ws://… to include the exam camera)
xvfb-run -a node test/electron-update.mjs     # desktop self-updates (download, switch, roll back)
node test/live.mjs  # live lesson with video + whiteboard (needs livekit-server --dev)
npm run dist        # installers into release/
```

The tests run the real `supabase/setup.sql` inside PGlite (Postgres compiled to WebAssembly) behind a small stand-in for the Supabase API ([`test/fake-supabase.mjs`](test/fake-supabase.mjs)), so every screen is exercised against the real security rules. `node test/fake-supabase.mjs` starts it on port 54321 for trying the app locally (URL `http://127.0.0.1:54321`, key `fake-anon-key-for-local-testing-only`).

Every push to `main` runs all of this in GitHub Actions, builds the Windows and Mac installers, the update bundle and the web version, updates the database and the Prof server, and publishes the release installed apps update from.

| Path | What it is |
| --- | --- |
| `supabase/setup.sql` | Tables, security rules, marking, progress, notifications, live-video passes, admin console, Prof's job queue |
| `supabase/functions/prof/` | Prof: the AI teaching assistant (Supabase Edge Function) |
| `electron/` | Desktop shell: window, lockdown, camera/screen permissions, tray, self-updates (`updater.cjs`) |
| `scripts/` | Icons, Claude connector, update bundle + manifest |
| `src/lib/` | Server calls, offline cache and outbox, maths step checker, markdown + maths |
| `src/screens/tutor/`, `src/screens/learner/`, `src/screens/shared/` | The screens |
| `src/ui/` | PDF viewer, maths input, drawing pad, whiteboard, shared parts |
| `connector/` | StudyBridge for Claude (MCP), tutor only |
| `test/` | Database, connector and end-to-end tests |
