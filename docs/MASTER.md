# StudyBridge master document

Oct 2, 2026 · @Aaryan Chouhan

StudyBridge is a desktop and phone app where tutors set, mark and track work for their own learners, with Prof, a tutor-only AI assistant, drafting work for the tutor to approve. This doc is kept up to date as StudyBridge changes.

## At a glance

StudyBridge is a paid service for private tutors: each tutor brings their own learners, and StudyBridge runs the teaching, homework, exams, marking and progress in one app.

|  |  |
| --- | --- |
| Who uses it | Tutors (sign up, approved by the StudyBridge admin) and their learners (join only by the tutor's invite) |
| Where | Desktop app for Windows and Mac (main), the same app in a phone browser (add to home screen) |
| First real user | Aaryan tutoring his sister (Cambridge IGCSE International Maths 0607, Lusaka) from NYC |
| Admin | Aaryan is the StudyBridge admin: approves tutors, manages accounts and access, never sees content |
| Business model | Monthly subscription per tutor (prices not final), no commission; StudyBridge pays the AI and video costs |
| Version | 1.1.x, live since 1 Oct 2026; updates install themselves |

**Rules StudyBridge lives by**

- Learners never use AI. Prof works for the tutor only.
- Nothing Prof makes reaches a learner until the tutor approves it; the database enforces this.
- The admin manages accounts but can never read anyone's work, files, marks or messages; every admin action is logged and visible to the tutor.
- It stays an installed app, and nobody ever reinstalls: updates arrive by themselves.
- Each tutor only sees their own learners; each learner only sees their own work.

## Positioning

**StudyBridge is the all-in-one teaching app for independent tutors.** Every other product we found does one piece of the job. A tutor using them has to stitch four or five together, and still gets no maths line checker or exam lockdown.

| Job | What a tutor uses today | Cost per month (USD) | In StudyBridge |
| --- | --- | --- | --- |
| Live lesson with whiteboard | Lessonspace Basic (10 hours) | $9.00 | Yes |
| Homework and class space | Google Classroom | Free | Yes |
| Quizzes | Kahoot! Bronze | $9.00 | Yes, with maths answers checked line by line |
| AI drafting of questions | MagicSchool Plus | $12.99 | Yes, Prof drafts from the tutor's own books |
| AI marking | CoGrader Standard (essays only) | $15.00 | Yes, maths working, tutor approves |
| Exam lockdown and camera | Not sold to single tutors (Respondus, Proctorio are institutional) | – | Yes |
| Maths step checker | Not sold to tutors | – | Yes |
| **Total** | **5 apps, 5 logins** | **$45.99** | **One app: Starter $12, Pro $25** |

**The pitch:** one app, one login, everything from the lesson to the marked exam, for about half the price of the stack it replaces.

**Where the claim is still thin:** products sold as "all-in-one" for tutors (TutorBird, Teach 'n Go, Wise) mean the business side. StudyBridge has none of that yet. A tutor would still need separate tools for:

- scheduling and a lesson calendar
- invoices and taking payments
- a parent view of progress
- recording lessons

Until those exist, say "all-in-one for teaching", not "all-in-one tutoring business". Prices from the Tutoring apps price comparison, 1 Oct 2026.

## Features today

Everything below is built, tested and live.

| Area | Features |
| --- | --- |
| Structure | Programmes, subjects (with colours) and topics, all named by the tutor; learners put on a programme and chosen subjects |
| Learners and invites | Invite codes (`SB1-…`) that always create a learner account; learner accounts list, password reset, delete account, remove from my learners |
| Library | Any file (PDFs open in the app, including scanned books); each item hidden, visible or visible from a date, for a subject or chosen learners. Past papers: every IGCSE and IB subject by year, session and paper with gaps shown; Cambridge's own papers open from its website (desktop); import a whole folder (filed from names or cover pages, paired with mark schemes, duplicates skipped, kept on the computer until shared); your own links; find a paper by typing it. Free openly licensed textbooks. Question bank: your questions plus StudyBridge's shared exam-style questions |
| Lessons | Written lessons with maths, images and attached files; draft or post |
| Assignments | Homework, quiz, test, exam; save draft, post or schedule; "Goes to" names; per-assignment time limit, attempts, release of marks, show answers, notes allowed; add questions from the bank or save them to it; practice sets for a learner (any number of tries, marked instantly) |
| Question types | Multiple choice, number, maths with working line by line, written answer, photo of work, drawing |
| Working out | Maths keyboard (MathLive); automatic step checker flags lines that don't follow; whiteboard for working; draw on a photo |
| Exams | Lockdown (screen locked in the desktop app, leaving is reported instantly); exam camera the tutor watches live |
| Marking | Auto-marking for multiple choice and numbers; tick or cross each line of working; draw on photos; feedback, mistake labels, redo requests, release control |
| Progress | Strengths per topic, time studied per day and subject, weekly and monthly summaries, missed deadlines, mistakes; weekly parent reports (learner switches them on; sent on WhatsApp or email after the tutor approves) |
| Messages | Notes from learners on any question, messages both ways, instant desktop notifications, phone push via ntfy |
| Live lessons | Video, screen sharing, shared whiteboard (LiveKit, shared keys from StudyBridge) |
| Learner experience | Friendly theme, streaks, week dots, Up next, score ring, confetti; works offline and hands in when back online |
| Prof (AI, tutor only) | Ask in plain words for homework, quizzes, tests, exams or lessons; use pages or a whole book from the library (Prof asks for the pages it needs); reply to Prof under its answer; auto-mark hand-ins; weekly work aimed at weak topics; style notes; monthly allowance per tutor; turn your copy of a past paper into a test; original practice papers in a past paper's style; bank questions with an automatic second check; weekly parent reports; notes on book pages it has read so re-reading is cheap |
| Admin (StudyBridge) | Approve, decline, pause, switch back on, reset passwords, delete; plans and Prof allowances; Claude key (write-only), model; shared live video; log of every action; shared StudyBridge question bank (ask Prof, review, approve for every tutor) |
| Accounts | Anyone signs up as a tutor and waits for approval; paused tutors can't sign in; tutors see changes the admin made to their account |
| Updates | Desktop app downloads new versions and offers Restart now; rolls back a version that fails to start; Windows installs shell updates quietly, Mac downloads the new .dmg |
| Claude Desktop | Optional connector so a tutor's own Claude can read StudyBridge and draft work into Prof's queue |

## How it's built

&#91;embedded content: StudyBridge architecture · app, Supabase and the services around it\]

The app holds no secrets: Supabase's security rules decide who sees what, the Claude key lives where only the Prof server reads it, and the database wakes Prof when there's work. Code: `aaryanc-1/studybridge` (React + Electron, `supabase/setup.sql`, `supabase/functions/prof`); every push runs the tests and publishes a release.

## Setup and running it

The apps, the update page and Prof are running; two GitHub secrets are still missing, so database and Prof updates are done by hand.

| Service or setting | What it's for | Status |
| --- | --- | --- |
| Supabase project | Database, sign-in, file storage, Prof server (Edge Function `prof`) | Running |
| Claude API key (Admin → Prof) | Prof's AI, Sonnet 5.5; default allowance $2 per tutor per month | Saved |
| LiveKit Cloud (Admin → Live video) | Video for every tutor's live lessons and exam cameras | Saved; check it works after the key mix-up |
| GitHub repo `studybridge` (private) | Code; every push tests, builds and publishes | Running |
| GitHub repo `studybridge-releases` (public) | Download page and the updates apps check | Running, first release 1.1.9 |
| Secret `RELEASES_TOKEN` | Lets the build publish to the public repo | Added |
| Variables `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Built into the apps so nobody types a server address | Added |
| Secret `SUPABASE_DB_URL` | Runs `setup.sql` and nightly backups automatically | Missing |
| Secret `SUPABASE_ACCESS_TOKEN` | Deploys Prof's code automatically | Missing |
| Secret `BACKUP_PASSWORD` | Encrypts nightly backups | Missing |
| ntfy app on phone | Push alerts (new tutor sign-ups, notes) | Set up |

**While the two secrets are missing, after an update that changes the server:**

1. Supabase → SQL Editor → paste the latest `supabase/setup.sql` → Run.
2. Supabase → Edge Functions → `prof` → replace the code with the latest `supabase/functions/prof/index.ts` → Deploy (JWT verification stays off).
3. Restart StudyBridge when the new-version bar appears.

**Links to give people:** tutors and learners download from `github.com/aaryanc-1/studybridge-releases/releases/latest`. On a Mac, the first open needs System Settings → Privacy & Security → Open Anyway. The phone version is `StudyBridge-web.zip` dragged onto Netlify Drop (not automatic yet).

## Costs and pricing

A tutor costs StudyBridge roughly $2–12 a month in AI plus a dollar or two of shared services; prices below are a draft, not decided.

**What Prof costs per task** (Claude Sonnet 5.5: $2 per million tokens in, $10 out)

| Task | Approx. cost |
| --- | --- |
| 10–20 questions from book pages | 15–30¢ (page pictures cut by a third on 1 Oct) |
| 10–20 questions without a book | 5–10¢ |
| Marking one hand-in | 1–5¢ (more with photos) |
| Light tutor month (8 assignments, 30 markings) | about $2–3 |
| Heavy tutor month (30 assignments, 100 markings) | about $8–12 |

**Running costs:** Supabase free now, Pro $25/month when files pass 1 GB or the database 500 MB; LiveKit free tier, then pay per video minute; card fees about 3% + 30¢ per payment; a domain about $10–15 a year when email is added.

**Draft prices** (1 USD = 19.69 kwacha = 96.22 rupees, Wise, 1 Oct 2026; yearly = 10 months, 2 free)

| Plan | Learners | Prof included | USD month / year | Kwacha month / year | Rupees month / year |
| --- | --- | --- | --- | --- | --- |
| Free trial | any | small | 14 days | 14 days | 14 days |
| Starter | up to 5 | $3 (ZM/IN $2) | $12 / $120 | K149 / K1,490 | ₹599 / ₹5,990 |
| Pro | up to 25 | $10 (ZM/IN $6) | $25 / $250 | K299 / K2,990 | ₹1,199 / ₹11,990 |
| Prof top-up |  | more AI | $5 | K99 | ₹399 |

Open questions: ask 3–5 tutors what they would pay; mobile money for Zambia (Flutterwave or DPO Pay), UPI for India (Razorpay); see the competitor comparison doc for how these compare.

## Update 1.2: library, question bank and parent reports

Shipped 2–3 Oct 2026, each part as its own auto-update. Needs the server update (new setup.sql and Prof code) before it all works.

1. **Library 2.0.** A catalogue of every IGCSE and IB paper (subject, code, year, session, paper, variant), with question paper, mark scheme and examiner report grouped together and missing slots greyed out. Officially published papers open straight from the exam board's own site and are kept on the tutor's device; StudyBridge never stores or shares exam-board files. Drag in a folder and every paper is filed from its name or cover page, paired with its mark scheme, duplicates skipped. Request a paper checks official sources only. Each slot can hold the tutor's own private link. Open textbooks (OpenStax, Siyavula) preloaded.
2. **Paper to questions.** Prof splits an uploaded paper and mark scheme into questions tagged by topic and difficulty; the tutor approves them.
3. **Same-style papers.** For a paper the tutor doesn't have, Prof writes an original paper with the same structure, topics, marks and difficulty, plus its own mark scheme, labelled as a practice paper. StudyBridge never collects real past-paper questions from the web.
4. **Question bank.** Browse by subject, topic and difficulty; build an assignment from it in a few clicks. StudyBridge's own exam-style questions, starting with IGCSE 0607, written by Prof, double-checked automatically, and approved by the admin in batches of about 20 before every tutor gets them.
5. **Practice mode.** Tutor-approved bank questions on each learner's weak topics, marked instantly by the maths checker. Learners still never use AI.
6. **Weekly parent reports.** Summary, lessons held and missed, work handed in or missing, marks and trend, strongest and weakest topics, tutor comment, next week, exam countdown. Prof drafts, tutor approves. The learner switches it on. Sent with a WhatsApp button; automatic email once the domain is bought.
7. **Prof cost savings.** Notes on pages Prof has already read, more questions per round.

**Not in 1.2:** payments and invoices (after pricing research), scheduling, lesson recording, website.

**Decided along the way:** IP lawyer consulted and flagged nothing; domain to be bought later (studybridgehq.com is the front-runner); the name stays StudyBridge.

## Roadmap

Nothing is being built right now; the first three are the suggested next builds (say "new" to bring this list up in chat).

| Idea | Why it matters | Status |
| --- | --- | --- |
| Weekly parent reports | Prof writes each learner's week for the parent; tutor approves; email or WhatsApp. Parents pay the bills | Shipped |
| Past papers in one click + question bank | Upload a past paper and mark scheme, Prof splits it into questions; every question saved by topic and difficulty | Shipped |
| Practice mode for learners | Tutor-approved extra questions on weak topics, marked instantly, no AI for learners | Shipped |
| Prof cost savings | Notes from pages Prof already read, more questions per round: about half the cost | Shipped |
| Scheduling | Weekly recurring lessons, reminders, both time zones, Google Calendar | Idea |
| Payments and billing | Stripe subscriptions and free trial; mobile money for Zambia; UPI for India; tutors invoicing and taking payments from learners. Comes once pricing is set, after your own market research | Idea |
| Email and a domain | Forgot-password emails, welcome emails, parent reports | Idea |
| Lesson recording + Prof notes | Recording with notes for the learner afterwards (Bramble gives this free) | Idea |
| Syllabus coverage map | Prof sets up topics from a syllabus (e.g. IGCSE 0607, ECZ); map of taught, practised, mastered | Idea |
| Mistake-review flashcards | Old mistakes come back days later until right | Idea |
| Exam camera alerts | Flag no face or a second face on the existing exam camera | Idea |
| Landing page and website | Pricing, download link, sign-up | Idea |
| Crash reports | Hear about errors before tutors report them | Idea |
| Phone version auto-deploy | Netlify connected to GitHub so the phone app updates itself | Idea |
| Native phone apps | App Store ($99/yr) and Google Play ($25 once) | Idea |
| Mac signing | Apple Developer account so Macs open and update without warnings | Idea |

## Known issues and open questions

- **1.2 needs the server update:** re-run the new `setup.sql` in Supabase and paste the new Prof code, or past papers, the question bank, practice and reports won't work.
- **Opening Cambridge's papers from the desktop app is untested on a real computer:** Cambridge's site sits behind Cloudflare. If it blocks the app, the page shows a link to Cambridge's own page instead.
- **The IB doesn't publish free past papers;** IB subjects fill only with copies the tutor imports.
- **Weekly reports are refreshed by the server every hour or so** (needs pg\_cron, already set up); sending is still one tap on WhatsApp until a domain and email service exist.

* Live video showed "invalid API key" on 1 Oct; new LiveKit keys were pasted into Admin and Settings. Confirm a live lesson works.
* Database and Prof updates are manual until `SUPABASE_DB_URL` and `SUPABASE_ACCESS_TOKEN` are added; no nightly backups yet either.
* Forgot-password emails don't reach anyone (no email service yet); tutors reset learners' passwords, the admin resets tutors'.
* Prof reading a whole book needs StudyBridge open on the tutor's laptop; if it's closed, Prof waits.
* Macs show a security warning on first open and can't take silent shell updates (no Apple Developer account).
* The phone version doesn't update itself yet (Netlify Drop by hand).
* Pricing not decided; talk to 3–5 tutors first.
* Terms and privacy policy needed before charging; learners may be under 18, so terms should allow under-18s with a parent's OK.

## Changelog

| Date | Change |
| --- | --- |
| 4 Oct 2026 | 1.5 (app 1.1.30): new StudyBridge logo everywhere (app, installer, tray, phone icons, sign-in); clearer 7-step getting-started checklist on tutor Home; sign-in page restyled; learner streak consistent |
| 4 Oct 2026 | Coverage cells set by the tutor (Strong / Getting there / Needs work / Taught / Not yet); set a subject's exam right in Past papers; Admin → Prof page with Claude credit countdown, daily spend, who used Prof and for what |
| 4 Oct 2026 | 1.4 review fixes: calendar links in a private table; self-marked work has one attempt and shows the mark scheme only when nothing can change; tutors can't see Prof allowances anywhere; flashcard time counted once; own practice doesn't count as taught; learners see only their subjects; failed practice papers show with Try again; calendar feed folding fixed; signed-out crash reports limited per address |
| 4 Oct 2026 | 1.4 part 5: StudyBridge practice papers. Prof works out each exam's papers (ISL's IB and IGCSE subjects), writes original papers in the same format with a second check; admin approves; tutors copy one into a test |
| 4 Oct 2026 | 1.4 part 4: calendar link (lessons and due dates in Google, Apple or Outlook calendar), served by Prof |
| 4 Oct 2026 | 1.4 part 3: Study for learners. Flashcards with spaced repetition (tutor's, Prof's after approval, their own, mistake cards), daily quiz, worked example then you try, timed drills, formula sheets, daily goal and streak; self-marked work |
| 3 Oct 2026 | 1.4 part 2: syllabus in the Library (Prof sets it out or the tutor writes it) and a coverage map per learner |
| 3 Oct 2026 | 1.4 part 1: crash reports to the admin; admin Overview, tutor pages, Inbox, Problems, Announcements; minimum app version; tutor sign-up questions; admin told when a tutor nears their Prof allowance; phone version published automatically |
| 3 Oct 2026 | 1.3 fixes: no authenticator code, one sign-in page for tutor, learner and admin; Prof's weekly reports work with models that refuse a forced tool; notifications panel no longer makes the sidebar scroll sideways |
| 3 Oct 2026 | 1.3: Admin is its own account with two-step sign-in (authenticator app), tutor accounts have no admin powers; subjects can say which exam they're for and Past papers shows your learners' exams first; IB section filed by level and paper (your papers stay private) with Prof's practice papers; import review lets you fix what a file was read as |
| 3 Oct 2026 | Reports kept up to date by the server (this week daily, last week when it ends, tutor notified); tutor can view any learner's report any time; Ask button for learners to switch sending on; drafts show 'Hidden until you approve'; clearer tutor sign-up switch |
| 3 Oct 2026 | 1.2 part 5: Prof keeps notes on book pages it has read and reads those next time (cheaper, no waiting); up to 8 questions per step. Review fixes: parent contact stays private when a learner changes tutor; exam-board fetch checks redirects |
| 3 Oct 2026 | 1.2 part 4: weekly parent reports. Learner switches them on; drafted each week; Prof can write the words; tutor approves; sent on WhatsApp, email or copy; exam countdown |
| 2 Oct 2026 | 1.2 part 3: practice mode. Bank questions on a learner's weak topics, any number of tries, marked instantly; quizzes show the score the moment they're handed in |
| 2 Oct 2026 | 1.2 part 2: question bank (own + shared StudyBridge questions approved by the admin); Prof writes bank questions with an automatic second check |
| 2 Oct 2026 | 1.2 part 1: Library 2.0. Past papers for every IGCSE and IB subject, Cambridge's own papers open from its site, import a folder, own links, find a paper; Prof turns a paper into a test or writes a same-style practice paper; free textbooks |
| 1 Oct 2026 | Fixed blank space you could scroll into; Prof's page pictures a third smaller (cheaper) |
| 1 Oct 2026 | Prof: use a whole book (Prof finds the pages), reply to Prof, sensible choices for vague requests |
| 1 Oct 2026 | Live video: switch back to StudyBridge's shared keys; clear message when LiveKit keys don't match |
| 1 Oct 2026 | First self-updating release (1.1.9) on `studybridge-releases`, server built into the app |
| 30 Sep 2026 | StudyBridge as a service: tutor sign-up approval, Admin, Prof on the server, self-updating desktop app, nightly backups (needs secret) |
| 29 Sep 2026 | Tutor admin for learner accounts, Post button, working-out whiteboard, friendlier learner design |
| 29 Sep 2026 | PDFs show their text (scanned books fixed) |
| 29 Sep 2026 | Live video with LiveKit; Windows and Mac installers, phone web version, Claude Desktop connector |
| 29 Sep 2026 | First version: tutor and learner screens, assignments, marking, progress, messages, offline, lockdown, exam camera |
