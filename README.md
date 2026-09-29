# StudyBridge

A private tutoring portal for one tutor and their learners. The tutor sets up programmes and subjects, uploads textbooks, sets homework, quizzes, tests and exams, marks work and follows progress. Learners do their work in StudyBridge (on a laptop, even offline), leave notes, and get their marks and feedback back. Learners never use AI. The tutor can connect **Claude Desktop** to draft questions and marking, and nothing Claude makes reaches a learner until the tutor approves it.

One app: **StudyBridge for Windows and Mac** (tutor and learners), plus the same app in a phone browser for the tutor.

## What's in it

**Tutor**
- Programmes → subjects (with colours) → topics, all named by you. Add learners any time with an invite.
- Library: upload any file (PDFs open inside the app). Every file and lesson is **hidden**, **visible**, or **visible from a date**, for everyone in the subject or chosen learners.
- Lessons with maths (`$x^2$`), images and attached files.
- Assignments: homework, quiz, test, exam. Six question kinds: multiple choice, number, **maths with working (line by line)**, written, photo of work on paper, drawing.
- Per assignment: **lockdown** (screen stays on StudyBridge until handed in), **camera** (watch their camera and screen live), time limit, attempts, when marks are released, whether answers are shown, notes allowed.
- Marking: auto-marking for multiple choice and numbers; tick or cross each line of working (a built-in checker flags lines that don't follow); draw on photos; feedback, mistake labels, "redo this question".
- Progress: strengths per topic (strong / developing / needs work), time studied per day and subject, weekly and monthly summaries (copy or print them), missed deadlines, mistakes.
- Notes from learners arrive instantly (desktop notification, and phone push through the free ntfy app).
- Live lessons: video, screen sharing and a shared whiteboard.
- From Claude: drafts made in Claude Desktop, waiting for your approval.

**Learner**
- Today: what's due, marks back, next live lesson.
- Doing work: answers save as they type; works offline and hands in when the connection is back; photos of paper working; drawing pad; textbook open beside the questions; notes to the tutor on any question.
- Results with feedback, ticked working, marked-up photos and (if allowed) worked solutions. Redo when asked.
- Library, progress, messages, live lessons.

## Setting it up (tutor, once)

You need: a free **Supabase** project (database, sign-in, file storage) and, for video, a free **LiveKit Cloud** project. Both let you sign in with GitHub.

1. **Install StudyBridge** on your laptop: download `StudyBridge-Setup-….exe` (Windows) or the `.dmg` (Mac) from this repo's Releases page → **StudyBridge (latest build)**. Windows SmartScreen may warn about an unknown publisher: **More info → Run anyway**. On a Mac, right-click the app → **Open** the first time.
2. **Create the database.** At [supabase.com](https://supabase.com/dashboard) create a project. Open **SQL Editor**, paste the whole of [`supabase/setup.sql`](supabase/setup.sql) (or press **Copy setup.sql** in the app) and press **Run**. You should see "StudyBridge database is ready".
3. **Turn off email confirmation.** Supabase → **Authentication → Sign In / Providers → Email** → turn off **Confirm email** → Save.
4. **Connect the app.** Open StudyBridge → **I'm the tutor**. Paste the **Project URL** and the **anon / publishable key** (Supabase → Project Settings → Data API, or the **Connect** button). Never use the secret / service_role key. Create your tutor account.
5. **Phone alerts (optional).** Supabase → **Database → Extensions** → turn on **pg_net**. Install the **ntfy** app on your phone and subscribe to the topic shown in StudyBridge → Settings → Phone alerts. Press **Send a test alert**.
6. **Live video (optional).** At [cloud.livekit.io](https://cloud.livekit.io) open your project → **Settings → API keys** → create a key. In StudyBridge → Settings → Live video, paste the WebSocket URL, API key and secret. They're stored in your database where only the video sign-in function can read the secret. Don't paste keys into chats.
7. **Your phone.** Download `StudyBridge-web.zip` from the release, unzip it, and drag the folder onto [Netlify Drop](https://app.netlify.com/drop) (free). Put the address it gives you into StudyBridge → Settings → Use on your phone, scan the QR code, sign in, and **Add to Home Screen**.
8. **Claude (optional, tutor only).** StudyBridge → Settings → Claude → **Install in Claude Desktop**, then fill in the server URL, anon key, your email and password when Claude asks. Try: *"Using StudyBridge, make a 10-question quiz on simultaneous equations for Anaya, due Friday."*

## Adding a learner

Learners → **Invite a learner** → choose their programme and subjects → **Copy message**. Send them the StudyBridge installer and the message. They open the app, choose **I'm a learner**, paste the invite and make an account. The invite already contains your server details, so they never type a URL or key.

## Good to know

- **Lockdown** fills the screen, blocks the usual shortcuts, brings the window back if they switch away, and reports every attempt to you instantly. It can't stop a second device (a phone), so use **camera** for tests that matter. A learner can leave in an emergency, and you're told when they do.
- Tests and exams with lockdown or camera need the desktop app; everything else also works in a browser.
- Questions of tests and exams stay hidden until the learner starts.
- Answers are never visible to learners early: mark schemes live in a separate table only you can read, and marks stay hidden until you release them.
- **Offline:** the app keeps a copy of everything a learner has opened (work, lessons, PDFs). Answers and hand-ins made offline send automatically when the connection returns. Starting a brand-new assignment needs a connection once.
- Storage: Supabase's free plan includes 1 GB of files. Lots of textbook PDFs may need the Pro plan later.
- Only the first account can be the tutor. To let another tutor share your StudyBridge, run `update app_config set allow_new_tutors = true;` in the Supabase SQL Editor (each tutor only ever sees their own learners and work). Or give them their own Supabase project.

## Develop

```sh
npm install
(cd connector && npm install)
npm test            # database rules, fake server, maths checker, Claude connector
npm run build       # web app into dist/ (same files for desktop and phone)
npm start           # desktop app
npm run walkthrough # tutor + learner + phone + offline, end to end in Chromium (screenshots in test/screenshots)
xvfb-run -a node test/electron-lockdown.mjs   # desktop lockdown (add LIVEKIT_URL=ws://… to include the exam camera)
node test/live.mjs  # live lesson with video + whiteboard (needs livekit-server --dev)
npm run dist        # installers into release/
```

The tests run the real `supabase/setup.sql` inside PGlite (Postgres compiled to WebAssembly) behind a small stand-in for the Supabase API ([`test/fake-supabase.mjs`](test/fake-supabase.mjs)), so every screen is exercised against the real security rules. `node test/fake-supabase.mjs` starts it on port 54321 for trying the app locally (URL `http://127.0.0.1:54321`, key `fake-anon-key-for-local-testing-only`).

Every push to `main` runs all of this in GitHub Actions, builds the Windows and Mac installers and the web version, and refreshes the **StudyBridge (latest build)** release.

| Path | What it is |
| --- | --- |
| `supabase/setup.sql` | Tables, security rules, marking, progress, notifications, live-video passes |
| `electron/` | Desktop shell: window, lockdown, camera/screen permissions, tray |
| `src/lib/` | Server calls, offline cache and outbox, maths step checker, markdown + maths |
| `src/screens/tutor/`, `src/screens/learner/`, `src/screens/shared/` | The screens |
| `src/ui/` | PDF viewer, maths input, drawing pad, whiteboard, shared parts |
| `connector/` | StudyBridge for Claude (MCP), tutor only |
| `test/` | Database, connector and end-to-end tests |
