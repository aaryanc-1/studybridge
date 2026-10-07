# StudyBridge master document

Oct 5, 2026 · @Aaryan Chouhan

StudyBridge is a desktop and phone app where tutors set, mark and track work for their own learners, with Prof, a tutor-only AI assistant, drafting work for the tutor to approve. This doc is the master copy and is kept up to date as StudyBridge changes; a backup copy lives in the repo at `docs/MASTER.md`.

## At a glance

StudyBridge is a paid service for private tutors: each tutor brings their own learners, and StudyBridge runs the teaching, homework, exams, marking and progress in one app.

|  |  |
| --- | --- |
| Who uses it | Tutors (sign up, approved by the StudyBridge admin) and their learners (join only by the tutor's invite) |
| Where | Desktop app for Windows and Mac (main), the same app in a phone browser (add to home screen) |
| First real user | Aaryan tutoring his sister (Cambridge IGCSE International Maths 0607, Lusaka) from NYC |
| Admin | Aaryan is the StudyBridge admin, on a separate admin account: approves tutors, manages accounts and access, never sees content |
| Business model | Monthly or yearly subscription per tutor (Free: 1 learner; Starter: 5 learners, $15; Pro: 25 learners, $29; yearly = 2 months free; parents free), no commission. Free for everyone until paid plans are switched on; StudyBridge pays the AI and video costs |
| Version | 1.5 (app 1.1.30), live since 1 Oct 2026; updates install themselves; 1.6 part 5 out 6 Oct 2026 (app 1.1.49) |

**Rules StudyBridge lives by**

- Learners never use AI. Prof works for the tutor only.
- Nothing Prof makes reaches a learner until the tutor approves it (the admin, for shared StudyBridge content); the database enforces this.
- The admin manages accounts but can never read anyone's work, files, marks or messages; every admin action is logged and visible to the tutor.
- Tutors never see Prof money or usage; only the admin does.
- StudyBridge never hosts or shares exam-board papers: official papers stay private to the tutor who imports them, and only original papers are shared.
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
| **Total** | **5 apps, 5 logins** | **$45.99** | **One app: Starter $15, Pro $29** |

**The pitch:** one app, one login, everything from the lesson to the marked exam, for well under the price of the stack it replaces.

**Where the claim is still thin:** products sold as "all-in-one" for tutors (TutorBird, Teach 'n Go, Wise) mean the business side. StudyBridge has little of that yet. A tutor would still need separate tools for:

- scheduling and lesson reminders (recurring lessons with reminders come in 1.6; a calendar link already exists)
- invoices and taking payments
- recording lessons

Until those exist, say "all-in-one for teaching", not "all-in-one tutoring business". Prices from the Tutoring apps price comparison, 1 Oct 2026.

## Features today

Everything below is built, tested and live as of 1.5.

| Area | Features |
| --- | --- |
| Structure | Programmes, subjects (with colours) and topics, all named by the tutor; each subject can say which exam it's for; learners put on a programme and chosen subjects |
| Learners and invites | Invite codes (`SB1-…`) that always create a learner account; learner accounts list, password reset, delete account, remove from my learners |
| Library | Any file (PDFs open in the app, including scanned books); each item hidden, visible or visible from a date, for a subject or chosen learners; your own links; free openly licensed textbooks (OpenStax, Siyavula); a syllabus per subject in order: numbered topics with subtopics, edited in place (Prof sets it out, or the tutor pastes or types it, and it merges with topics already there; Prof can also read the tutor's own syllabus PDF); a teaching plan per subject, week by week, month by month or chapter by chapter, spread evenly or planned by Prof, editable; tabs are called My files and Lesson notes |
| Past papers | Every IGCSE and IB subject by year, session and paper with gaps shown; your learners' exams first, and a subject's exam can be set right there; Cambridge's own papers open from its website (desktop); import a whole folder (filed from names or cover pages, paired with mark schemes, duplicates skipped, kept on the computer until shared) with a review to fix what a file was read as; IB filed by level and paper, your papers private; find a paper by typing it; StudyBridge practice papers (original papers in each exam's format, checked twice, approved by the admin) to copy into a test |
| Question bank | Your questions plus StudyBridge's shared exam-style questions, by subject, topic and difficulty |
| Lesson notes | Written lesson notes with maths, images and attached files; draft or post |
| Assignments | Homework, quiz, test, exam; save draft, post or schedule; "Goes to" names; per-assignment time limit, attempts, release of marks, show answers, notes allowed; add questions from the bank or save them to it; practice sets for a learner (any number of tries, marked instantly) |
| Question types | Multiple choice, number, maths with working line by line, written answer, photo of work, drawing |
| Working out | Maths keyboard (MathLive); automatic step checker flags lines that don't follow; whiteboard for working; draw on a photo |
| Exams | Lockdown (screen locked in the desktop app with no way out: each try to leave is reported, a warning first, then it hands in; the tutor sets how many warnings; time-up hands in on the server even with the app closed; only the tutor can end it early); exam camera the tutor watches live; mock exams: one or more papers add up to one total and a grade from the tutor's own grade boundaries for the exam and session (typed in, or read by Prof from a grade-threshold PDF and checked), scaled when the mock's total differs; learners see only their grade and how many marks short of the next one, once every paper is given back |
| Marking | Auto-marking for multiple choice and numbers; tick or cross each line of working; draw on photos; drawings marked by Prof from a picture (what Prof read a drawing or photo as shows only to the tutor, never in the learner's feedback); feedback, comments and solutions show maths and formatting as they'll look, with a small maths keyboard; mistake labels, redo requests, release control |
| Progress | Strengths per topic, time studied per day and subject, weekly and monthly summaries, missed deadlines, mistakes; coverage map per learner (the tutor sets each cell: Strong, Getting there, Needs work, Taught, Not yet); mock exam grades over time; weekly parent reports (learner switches them on; kept up to date by the server; the tutor can read any report any time; a designed report filled in by StudyBridge (lessons, work, marks and trend, topics, latest mock grade, exam countdown); the tutor adds a comment (Prof can suggest one) and approves; it goes to parent accounts, and by WhatsApp or email if the learner switched that on, with maths written in plain words; once StudyBridge email is switched on, it emails straight from StudyBridge; prints as a PDF) |
| Parent accounts | Read-only: the tutor makes a one-use parent invite for a learner (learner page → Parents); the parent sees approved weekly reports, upcoming lessons and due dates, marks once given back, topic strengths, mock grades and the exam countdown; never messages, working, photos, the exam camera or anything from Prof. The learner sees linked parents in Settings and can remove them |
| Study (learners) | Flashcards with spaced repetition (the tutor's, Prof's after approval, the learner's own, mistake cards); daily quiz; worked example then you try; timed drills; formula sheets; daily goal and streak; self-marked work (one attempt; the mark scheme shows only when nothing can change) |
| Calendar | A private calendar link with lessons and due dates for Google, Apple or Outlook calendar |
| Messages | Notes from learners on any question, messages both ways, instant desktop notifications, phone push via ntfy |
| Live lessons | Video, screen sharing, shared whiteboard (LiveKit, shared keys from StudyBridge); one-off or weekly lessons at the tutor's clock time, each learner's own time shown; skip one week, move one, change from a lesson on, or stop; reminders a day and 15 minutes before, in the app and on learners' phones through ntfy; on data saver, low-quality or audio-only video |
| Learner experience | Friendly theme, streaks, week dots, Up next, score ring, confetti; works offline and hands in when back online |
| Prof (AI, tutor only) | Ask in plain words for homework, quizzes, tests, exams or lessons; use pages or a whole book from the library (Prof asks for the pages it needs); reply to Prof under its answer; auto-mark hand-ins; weekly work aimed at weak topics; style notes; turn your copy of a past paper into a test; original practice papers in a past paper's style; bank questions and flashcards with an automatic second check; syllabuses; weekly parent reports; notes on book pages it has read so re-reading is cheap; reads grade-threshold PDFs for mock exams; the Prof page shows the latest 5 requests with a searchable History; a monthly allowance per tutor that only the admin sees |
| Admin (StudyBridge) | Its own account; Overview, tutor pages, Inbox, Problems, Announcements; approve, decline, pause, switch back on, reset passwords, delete; plans and Prof allowances with alerts at 80% and 100%; Admin → Prof page (Claude credit countdown, daily spend, who used Prof and for what); crash reports; minimum app version; Claude key (write-only), model; shared live video; log of every action; shared question bank and StudyBridge practice papers (ask Prof, review, approve for every tutor) |
| Accounts | One sign-in page for tutors, learners and the admin (the account decides which); anyone signs up as a tutor, answers a few sign-up questions and waits for approval; paused tutors can't sign in; tutors see changes the admin made to their account; a 7-step getting-started checklist on tutor Home; one-click account switching on the admin's own device; forgot password by email; download my data (a ZIP file) and delete my account in Settings; Continue with Google (built, off until set up) |
| Plans and payments | Free (1 learner), Starter (5), Pro (25); a tutor's plan and how full it is in Settings; limits off until the admin switches them on; Stripe checkout, billing and cancel built and off until keys and prices are added (Admin → Selling) |
| Website | Home, features for tutors, learners and parents, pricing with a calculator in dollars, kwacha and rupees, Get the app (the right download for the device, QR code, Add to Home Screen steps), FAQ, terms and privacy drafts; light and dark; at `aaryanc-1.github.io/studybridge-releases/` until there's a domain; name and prices in one file for a rename |
| Updates | Desktop app downloads new versions and offers Restart now; rolls back a version that fails to start; Windows installs shell updates quietly, Mac downloads the new .dmg; the phone version is published automatically with every release; a new logo reinstalls the desktop shell so the app icon updates |
| Claude Desktop | Optional connector so a tutor's own Claude can read StudyBridge and draft work into Prof's queue |
| This device | Light, dark or same-as-device appearance; data saver (smaller photo uploads, PDFs a page at a time, pictures on tap, low-quality or audio-only live lessons; suggested on slow connections; shows how much it saved) |

## How it's built

&#91;embedded content: StudyBridge architecture · app, Supabase and the services around it\]

The app holds no secrets: Supabase's security rules decide who sees what, the Claude key lives where only the Prof server reads it, and the database wakes Prof when there's work. Code: `aaryanc-1/studybridge` (React 19 + Vite + Electron, `supabase/setup.sql`, `supabase/functions/prof`). Every push runs the tests (`npm test`, `npm run product`, `npm run walkthrough`) and publishes the desktop release and the phone version. Hand-off notes for Claude live in `CLAUDE.md` in the repo.

## Setup and running it

The apps, the update page, the phone version and Prof are running; every push to GitHub now updates the database and the Prof server by itself (since 5 Oct 2026).

| Service or setting | What it's for | Status |
| --- | --- | --- |
| Supabase project | Database, sign-in, file storage, Prof server (Edge Function `prof`) | Running |
| Supabase sign-up settings | "Confirm email" off, so invite sign-ups go straight in; Site URL is the phone web app, so any email link opens StudyBridge | Set 6 Oct 2026 |
| Claude API key (Admin → Prof) | Prof's AI, Sonnet 5.5; default allowance $2 per tutor per month | Saved |
| LiveKit Cloud (Admin → Live video) | Video for every tutor's live lessons and exam cameras | Saved; check it works after the key mix-up |
| GitHub repo `studybridge` | Code; every push tests, builds and publishes | Running; publicly readable (see Known issues) |
| GitHub repo `studybridge-releases` (public) | Download page, the updates apps check, and the phone version on GitHub Pages | Running; latest release 1.1.49 |
| Website | Published with every release next to the phone version | Live at `aaryanc-1.github.io/studybridge-releases/` |
| Admin → Selling | Plan limits, Stripe (secret key, webhook secret, four price IDs), Resend email (sender and key), Google sign-in | Nothing set; all off |
| Secret `RELEASES_TOKEN` | Lets the build publish to the public repo | Added |
| Variables `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Built into the apps so nobody types a server address | Added |
| Secret `SUPABASE_DB_URL` | Runs `setup.sql` and nightly backups automatically | Added 5 Oct 2026; works |
| Secret `SUPABASE_ACCESS_TOKEN` | Deploys Prof's code automatically | Added 5 Oct 2026; works |
| Secret `BACKUP_PASSWORD` | Encrypts nightly backups | Missing |
| ntfy app on phone | Push alerts (new tutor sign-ups, notes) | Set up |

**If an automatic server update ever fails (GitHub → Actions → the run → server), do it by hand:**

1. Supabase → SQL Editor → paste the latest `supabase/setup.sql` → Run.
2. Supabase → Edge Functions → `prof` → replace the code with the latest `supabase/functions/prof/index.ts` → Deploy (JWT verification stays off).
3. Restart StudyBridge when the new-version bar appears.

**Links to give people:** the website is `aaryanc-1.github.io/studybridge-releases/` (sign-up, invites, downloads); tutors and learners download from `github.com/aaryanc-1/studybridge-releases/releases/latest`. On a Mac, the first open needs System Settings → Privacy & Security → Open Anyway. The phone version is at `aaryanc-1.github.io/studybridge-releases/app/` (add it to the home screen); it updates itself with every release.

## Costs and pricing

A tutor costs StudyBridge roughly $2–12 a month in AI plus a dollar or two of shared services. Prices were set on 6 Oct 2026 (raised slightly from the draft); StudyBridge stays free until paid plans are switched on.

**What Prof costs per task** (Claude Sonnet 5.5: $2 per million tokens in, $10 out)

| Task | Approx. cost |
| --- | --- |
| 10–20 questions from book pages | 15–30¢ (page pictures cut by a third on 1 Oct) |
| 10–20 questions without a book | 5–10¢ |
| Marking one hand-in | 1–5¢ (more with photos) |
| Light tutor month (8 assignments, 30 markings) | about $2–3 |
| Heavy tutor month (30 assignments, 100 markings) | about $8–12 |

**Running costs:** Supabase free now, Pro $25/month when files pass 1 GB or the database 500 MB; LiveKit free tier, then pay per video minute; card fees about 3% + 30¢ per payment; a domain about $10–15 a year when email is added.

**Prices** (charged in US dollars; the website shows kwacha and rupees at 1 USD = 19.69 kwacha = 96.22 rupees, Wise, 1 Oct 2026; yearly = 10 months, 2 free)

| Plan | Learners | USD month / year | About in kwacha | About in rupees |
| --- | --- | --- | --- | --- |
| Free | 1 | $0 | K0 | ₹0 |
| Starter | up to 5 | $15 / $150 | K295 / K2,950 | ₹1,445 / ₹14,450 |
| Pro | up to 25 | $29 / $290 | K570 / K5,700 | ₹2,790 / ₹27,900 |
| Parent accounts | any | free | free | free |

Open questions: ask 3–5 tutors what they would pay; mobile money for Zambia (Flutterwave or DPO Pay), UPI for India (Razorpay); see the competitor comparison doc for how these compare.

## 1.6 plan

1.6 adds recurring lessons, mock exams, parent accounts and a data saver, then the basics needed to sell. Each part ships as its own auto-update, built and tested by Claude and pushed to the repo.

| Part | What it does | Decided | Status |
| --- | --- | --- | --- |
| 1. Recurring lessons + reminders | Weekly lessons for one or more learners, shown in both time zones (e.g. "Tue 16:00 Lusaka · 10:00 New York"); skip or move one lesson; in the calendar link; reminders a day and 15 minutes before, in the app, on the desktop and by ntfy (the learner can opt in too) | Lessons keep the tutor's New York time when clocks change, so the learner's time moves (16:00 becomes 17:00 in Lusaka after US clocks go back on 1 Nov 2026) | Shipped |
| 2. Mock exam + predicted grade | A timed, locked-down exam of one or more papers; marks add up to a total and a grade comes from grade boundaries by plain maths, no AI; the learner sees it when marks are released | Boundaries per exam and session (changed from per mock on 5 Oct 2026): typed by the tutor, or read by Prof from the tutor's own threshold PDF and checked; every mock uses the newest unless pinned to a session. Called Mock grade, not predicted. Boundaries stay private to the tutor | Shipped |
| 3. Parent accounts | A parent invite code tied to one learner, who sees which parents are linked; parents see approved reports, upcoming lessons and due dates, released marks, topic strengths and the exam countdown; never messages, working, photos, the exam camera or AI | Read-only | Shipped |
| 4. Data-saver mode | A switch per device, suggested on slow connections: smaller photo uploads, PDFs a page at a time, images on tap, low-video or audio-only live lessons |  | Shipped |
| 5. Selling basics + website | Website and landing page; forgot password; download my data and delete my account; terms and privacy drafts (under-18s with a parent's OK); plans with limits off; Google sign-in, StudyBridge email and Stripe payments built and off. Also: Prof marks drawings from a picture; maths shown as finished text | Prices raised slightly (Starter $15, Pro $29); website on GitHub Pages until a domain; a rename is likely, so the name and prices sit in one file. Still needs Aaryan: the domain, a Google sign-in client, Stripe and Resend accounts, a lawyer's check | Shipped |

## 2.0 plan: open to every learner

Agreed with Aaryan on 7 Oct 2026; nothing is built yet. StudyBridge grows from "a tutor and their learners" into a learning resource for anyone in education: a student on their own, a tutor and their learners, tuition centres, then schools. A student without a tutor gets Prof as their guide, with content made and checked ahead of time. The big goal is to be the most complete and trustworthy place to prepare for an exam, better than studybridge.tech (an AI-first South African platform with the same name).

**Who uses it**

| Group | People in it | Who approves AI-made content |
| --- | --- | --- |
| StudyBridge team | Owner (Aaryan; the final say on everything, including who gets admin access), Admin, Reviewer (content quality only). Aaryan is all three until he adds a team | Automatic checks for shared content; reports come to the Owner |
| A student on their own | Learner (grade 8 and up starts alone; below grade 8 needs a parent; in countries whose law needs it, such as India under 18, a parent also confirms by email), Parent (optional, read-only, can pay) | Automatic checks, then it goes out with a report button |
| An independent tutor | Tutor → learners → parents | The tutor approves everything (as today) |
| A tuition centre | Centre manager (tutors, every learner, billing) → tutors → learners → parents | Each tutor, for their own learners |
| A school | School admin → head of department (optional) → teachers → classes → students → parents | The teacher (or head of department) |

A self-learner who later joins a tutor keeps their history and their own study space; work the tutor sets follows the tutor's rules.

**Rules for 2.0**

- The Owner decides everything, including who gets Admin or Reviewer access.
- Learners with a tutor, centre or school: nothing AI-made reaches them until a person approves it (unchanged).
- Self-learners: StudyBridge's own content goes out after automatic checks (a second, separate solve plus the maths checker), with a report button on everything; reports go to the Owner.
- Practice papers are original: the same format as the real paper (structure, timing, sections, marks, command terms, topic spread), never copied or reworded from real papers, and labelled "not affiliated with or endorsed by" the exam board. Real past papers are never hosted: the catalogue opens them from the exam board's own site.
- Payment happens on the website only, never through Apple's or Google's stores.
- The Claude Desktop connector is for the Owner only (to make content on his own Claude subscription, with no API cost). Tutors and learners don't get it, because Prof is what they pay for.

**What students get**

1. **Guided setup**, before making an account, on the website or in the app (one flow, never asked twice): who you are, grade, curriculum and subjects, exam session or date, "is this your syllabus?" (or upload it, or request it), your goal and time each week, how you like to learn, an optional 10-minute starting check, then your plan, then "create your account to keep it".
2. **Exam countdown plan**: every topic spread over the weeks left, weak topics first, the last weeks for practice papers and a full mock; it re-plans itself when days are missed.
3. **Ready-made lessons** per syllabus point: a short explanation, a worked example, practice and a quick check, with "say it more simply" and "explain it another way".
4. **Practice and papers**: the question bank, instant marking, flashcards, past papers opened from the official site, three original practice papers per paper type, and timed mocks with estimated grade boundaries.
5. **Bring your own course**: anyone not covered (grade 7, a university module, a national exam) uploads a syllabus or course outline and Prof builds the plan and practice, with the same checks.
6. **Accessibility**: screen reader and keyboard support, colour-blind-safe charts, focus mode, reading mode, read-aloud, voice answers, dyslexia-friendly font, text size and contrast, extra time on timed tests. Languages: English, French, Spanish, Portuguese, Hindi and Arabic (the app first, then lessons).

**Curricula at launch** (the common international-school subjects; anything else by "Request a subject")

- **IGCSE (Cambridge and Pearson Edexcel International GCSE)**: Maths, International Maths, Additional Maths, English First Language, English as a Second Language, English Literature, Biology, Chemistry, Physics, Co-ordinated Sciences, Computer Science, ICT, Business, Economics, Accounting, Geography, History, Global Perspectives, Environmental Management, French, Spanish, Hindi.
- **A-Level (Cambridge International and Pearson Edexcel International A Level)**: Maths, Further Maths, Physics, Chemistry, Biology, Computer Science, Economics, Business, Accounting, Psychology, English Language, English Literature, Sociology, Geography, History.
- **IB Diploma, every subject at SL and HL**: Maths AA and AI, Physics, Chemistry, Biology, Computer Science, Economics, Business Management, Psychology, History, Geography, English A (Language and Literature; Literature), French B, Spanish B, ESS; support for TOK and the Extended Essay.

**Website and app**

- The website is the front door: setup, plan, sign-up and payment all happen there, and studying works straight away in the browser.
- One account everywhere (browser, desktop app, phone): nothing to sync.
- The browser is enough for most students. It says plainly what the desktop app adds: fully locked-down mock exams, the exam camera, a smoother experience for big PDFs, desktop notifications. Tutors, centres and schools are recommended the desktop app.

**Growth**

- Free tools with no sign-up: exam countdown, grade estimator, try one question.
- Refer a friend: both get a discount.
- A shareable progress card for WhatsApp and Instagram.
- A public page per syllabus (for example "IGCSE Physics 0625: 12-week revision plan"), so students find StudyBridge from Google.
- Later: university student ambassadors, and self-learners finding a tutor on StudyBridge.

**Build order**

| Step | What | Status |
| --- | --- | --- |
| 0 | Plan written into this doc and the repo's rules | Done 7 Oct 2026 |
| 1 | Choose the new name and buy the domain (Aaryan) | Next |
| 2 | Website 2.0 under the new name: students first ("exam in 9 weeks? get your plan"), a switcher for students, parents, tutors, centres and schools, curricula and subjects, accessibility, how Prof works and its rules, an early-access list for the student version | Before any app build |
| 3 | Fixes from 6 Oct (test vs exam wording, a panel that stays in view when marking, return marks without a redo, Prof's line breaks, blank drawings, plans chosen from a list) | Planned |
| 4 | Foundations: account types (Owner, Admin, Reviewer, self-learner), the curriculum catalogue (boards, subjects, levels, paper formats), Owner-only content tools in the Claude Desktop connector, removing the connector from tutors | Planned |
| 5 | Content: practice papers, lessons, questions and flashcards made on the Owner's Claude subscription, the automatic checks, the report button and the review queue. Hundreds of paper types, so this runs as steady batches over weeks, most-taken subjects first | Planned |
| 6 | The student experience: guided setup, starting check, exam countdown plan, daily "today" screen, practice and mocks, browser vs desktop, parent approval by grade and country | Planned |
| 7 | Accessibility pack, then languages | Planned |
| 8 | Growth: free tools, referral discount, progress card, syllabus pages | Planned |
| 9 | Prices and payments (website), email from the domain, WhatsApp | With the domain |
| 10 | Tuition centres and schools (an organisation layer), university ambassadors, finding a tutor | Later |

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

1.6 ships in parts (see 1.6 plan); say "new" to bring this list up in chat.

| Idea | Why it matters | Release | Status |
| --- | --- | --- | --- |
| Scheduling | Weekly recurring lessons, reminders, both time zones, calendar | 1.6 part 1 | Shipped |
| Mock exam mode + predicted grade | The learner sees where they stand before the real exam | 1.6 part 2 | Shipped |
| Parent accounts | Parents pay the bills; a read-only view of their child's progress | 1.6 part 3 | Shipped |
| Data-saver mode | Learners on phone data use less of it | 1.6 part 4 | Shipped |
| Email and a domain | Forgot-password emails (working now from Supabase's sender), parent reports from StudyBridge's own address once Resend and a domain are added | 1.6 part 5 (built, off) | Planned |
| Google sign-in | Sign in without another password (phone and web version) | 1.6 part 5 (built, off) | Planned |
| Terms, privacy, data export and delete | Needed before charging; learners may be under 18 | 1.6 part 5 | Shipped |
| Payments and billing | Stripe subscriptions built (off until keys and prices are added); still to come: mobile money for Zambia, UPI for India, tutors invoicing and taking payments from learners | 1.6 part 5 (Stripe, off) | Planned |
| Landing page and website | Pricing, download link, sign-up | 1.6 part 5 | Shipped |
| 2.0: open to every learner | Students on their own (Prof as guide), then tuition centres and schools; guided setup, exam countdown plan, lessons, original practice papers, accessibility, six languages. See 2.0 plan | 2.0 | Planned |
| Lesson recording + Prof notes | Recording with notes for the learner afterwards (Bramble gives this free). On hold since 5 Oct 2026: needs paid speech-to-text (about $0.35 per lesson hour) and LiveKit recording |  | Idea |
| Exam camera alerts | Flag no face or a second face on the existing exam camera |  | Idea |
| Native phone apps | App Store ($99/yr) and Google Play ($25 once) |  | Idea |
| Mac signing | Apple Developer account so Macs open and update without warnings |  | Idea |
| Syllabus coverage map | Prof sets up topics from a syllabus (e.g. IGCSE 0607, ECZ); map of taught, practised, mastered | 1.4 | Shipped |
| Mistake-review flashcards | Old mistakes come back days later until right | 1.4 | Shipped |
| Crash reports | Hear about errors before tutors report them | 1.4 | Shipped |
| Phone version auto-deploy | The phone app updates itself with every release (GitHub Pages) | 1.4 | Shipped |
| Weekly parent reports | Prof writes each learner's week for the parent; tutor approves; email or WhatsApp. Parents pay the bills | 1.2 | Shipped |
| Past papers in one click + question bank | Upload a past paper and mark scheme, Prof splits it into questions; every question saved by topic and difficulty | 1.2 | Shipped |
| Practice mode for learners | Tutor-approved extra questions on weak topics, marked instantly, no AI for learners | 1.2 | Shipped |
| Prof cost savings | Notes from pages Prof already read, more questions per round: about half the cost | 1.2 | Shipped |

## Known issues and open questions

- **Server updates are automatic since 5 Oct 2026:** every push runs `setup.sql` and deploys the Prof code (first run on release 1.1.35, both steps passed). Nightly backups still need the `BACKUP_PASSWORD` secret.
- **Lockdown can't block Ctrl+Alt+Del, the power button or closing the lid** (no exam software can): those exits reopen the exam when StudyBridge starts again, and count as a try to leave.
- **Data saver's page-by-page PDFs** need the file server to allow partial downloads; if it doesn't, the whole PDF downloads as before.
- **The code repo is publicly readable:** it was listed as private, but anyone can read the code on GitHub. Nothing secret is in it by design. Decide before selling; check GitHub Actions minutes first, as private repos get a limited allowance and Mac builds use it fastest.
- **Opening Cambridge's papers from the desktop app is untested on a real computer:** Cambridge's site sits behind Cloudflare. If it blocks the app, the page shows a link to Cambridge's own page instead.
- **The IB doesn't publish free past papers;** IB subjects fill only with copies the tutor imports.
- **Weekly reports are refreshed by the server every hour or so** (needs pg\_cron, already set up); sending is one tap on WhatsApp, or straight from StudyBridge by email once email is switched on in Admin → Selling.
- Live video showed "invalid API key" on 1 Oct; new LiveKit keys were pasted into Admin and Settings. Confirm a live lesson works.
- **Forgot-password emails** come from Supabase's built-in sender: only a few an hour and they may land in spam. Add Resend's SMTP details in Supabase once there's a domain.
- **Payments, StudyBridge email and Google sign-in are tested against stand-ins, not the real services;** check each once when switching it on (Admin → Selling has the steps).
- Prof reading a whole book needs StudyBridge open on the tutor's laptop; if it's closed, Prof waits.
- Macs show a security warning on first open and can't take silent shell updates (no Apple Developer account).
- **Prices are set but untested with tutors:** still worth asking 3–5 tutors. Kwacha and rupee prices are straight conversions (K295 and ₹1,445 for Starter), not lower local prices; decide whether Zambia and India get their own.
- **Terms and privacy are drafts** on the website (under-18s with a parent's OK, Prof for tutors only, the services used); a lawyer should check them before charging.
- **Name clash:** studybridge.tech is an AI learning platform in South Africa with the same name and an African audience, so families could mix the two up. Another reason to rename before 2.0.
- **A new name is likely:** the website's name and prices live in `website/site.config.json`; the app itself still says StudyBridge in many places, so a rename is its own small update.

## Changelog

| Date | Change |
| --- | --- |
| 6 Oct 2026 | 1.6 part 5 (app 1.1.49): the website (home, features, pricing calculator, Get the app, FAQ, terms and privacy drafts); prices raised slightly (Starter $15, Pro $29, yearly 2 months free, parents free, free until paid plans start); forgot password by email; download my data and delete my account; plan limits (off); Admin → Selling with Google sign-in, StudyBridge email and Stripe payments built and off; Prof marks whiteboard drawings from a picture and tells only the tutor what it read; feedback and comments show maths as finished text with a maths keyboard, and plain maths in WhatsApp and email |
| 6 Oct 2026 | 1.6 part 4 (app 1.1.46): data saver per device; light, dark or same-as-device appearance; lockdown with no way out (a warning, then the next try hands in; forced exits reopen the exam; time-up hands in on the server; tutor can hand in now or let them leave); account switcher on the admin's device; parent invites explain the phone link and home screen; a new logo now reinstalls the desktop shell so the icon updates; Prof reads a syllabus PDF; teaching plans week by week, month by month or chapter by chapter |
| 6 Oct 2026 | 1.6 part 3 (app 1.1.44): read-only parent accounts (one-use parent invites from the learner's Parents tab; I'm a parent on the welcome screen; parents see approved reports, upcoming lessons and due dates, released marks, topics, released mock grades and the exam countdown; learners see and remove linked parents). Weekly report redesigned as a filled-in report page that prints as a PDF; the tutor only writes a comment (Prof can suggest one) and approves it before any parent sees it |
| 6 Oct 2026 | Fix (app 1.1.40): a stray key press in Past papers could set the wrong exam for a subject (it saved as soon as the list changed); it now saves only with Save. The Syllabus page shows each subject's exam with a Change button |
| 5 Oct 2026 | 1.6 part 2 (app 1.1.38): mock exams, one or more papers adding up to a total and a Mock grade from the tutor's own grade boundaries per exam and session (typed in, or read by Prof from a grade-threshold PDF); learners see their grade on Progress, the paper's results and the weekly report once every paper is given back. Syllabus shown in order with numbered subtopics, editable in place, and Set up the whole syllabus merges with existing topics. Library tabs renamed My files and Lesson notes. Prof shows the latest 5 requests plus a searchable History |
| 5 Oct 2026 | Database and Prof server now update themselves on every push (SUPABASE_DB_URL and SUPABASE_ACCESS_TOKEN added); first automatic run on 1.1.35 put 1.6 part 1's weekly lessons, reminders and phone alerts live |
| 5 Oct 2026 | 1.6 part 1: weekly lessons that keep the tutor's clock time, each learner's time shown (10:00 New York moves from 16:00 to 17:00 Lusaka on 1 Nov); skip one week and put it back, move one, change from a lesson on, stop; reminders a day and 15 minutes before to tutor and learners; learners' own ntfy phone alerts; learners told when a one-off lesson is cancelled or a lesson moves; skipped lessons left out of calendars and reports. Also: Prof's book picker no longer says "Choose a PDF" with a book showing |
| 5 Oct 2026 | Master doc moved to this Claude Doc (backup copy in the repo at `docs/MASTER.md`); `CLAUDE.md` hand-off notes added to the repo |
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
