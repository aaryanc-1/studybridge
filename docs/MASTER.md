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
| Version | 1.5 (app 1.1.30), live since 1 Oct 2026; updates install themselves; 1.6 part 5 out 6 Oct 2026 (app 1.1.49); 2.0 website and the 6 Oct fixes out 7 Oct 2026; on gostudybridge.com since 7 Oct 2026; fixes and polish 8 Oct 2026 (app 1.1.56); account menu fix and Discard 8 Oct 2026 (app 1.1.57); new prices and self-learners-first plan on the website 8 Oct 2026 (app 1.1.58); Pricing page, livelier website and 8-digit join codes 9 Oct 2026 (app 1.1.59); flowing website background 9 Oct 2026 (app 1.1.60); one continuous website, Ctrl+, for Settings and clearer updates 9 Oct 2026 (apps 1.1.61–1.1.62); students on their own, part 1 (sign-up, free week, plan to the exams, payments in Admin) 9 Oct 2026 (app 1.1.63) |

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
| Learners and invites | An 8-digit code per learner (shown as 4829 1375), sent with a link that fills it in, or typed in the app; 10 wrong codes in an hour make that account wait; learner accounts list, password reset, delete account, remove from my learners |
| Library | Any file (PDFs open in the app, including scanned books); each item hidden, visible or visible from a date, for a subject or chosen learners; your own links; free openly licensed textbooks (OpenStax, Siyavula); a syllabus per subject in order: numbered topics with subtopics, edited in place (Prof sets it out, or the tutor pastes or types it, and it merges with topics already there; Prof can also read the tutor's own syllabus PDF); a teaching plan per subject, week by week, month by month or chapter by chapter, spread evenly or planned by Prof, editable; tabs are called My files and Lesson notes |
| Past papers | Every IGCSE and IB subject by year, session and paper with gaps shown; your learners' exams first, and a subject's exam can be set right there; Cambridge's own papers open from its website (desktop); import a whole folder (filed from names or cover pages, paired with mark schemes, duplicates skipped, kept on the computer until shared) with a review to fix what a file was read as; IB filed by level and paper, your papers private; find a paper by typing it; StudyBridge practice papers (original papers in each exam's format, checked twice, approved by the admin) to copy into a test |
| Question bank | Your questions plus StudyBridge's shared exam-style questions, by subject, topic and difficulty |
| Lesson notes | Written lesson notes with maths, images and attached files; draft or post |
| Assignments | Homework, quiz, test, exam; save draft, post or schedule; "Goes to" names; per-assignment time limit, attempts, release of marks, show answers, notes allowed; add questions from the bank or save them to it; practice sets for a learner (any number of tries, marked instantly) |
| Question types | Multiple choice, number, maths with working line by line, written answer, photo of work, drawing |
| Working out | Maths keyboard (MathLive); automatic step checker flags lines that don't follow; whiteboard for working; draw on a photo |
| Exams | Lockdown (screen locked in the desktop app with no way out: each try to leave is reported (as a test, quiz or exam, whichever it is), a warning first, then it hands in; the tutor sets how many warnings; time-up hands in on the server even with the app closed; only the tutor can end it early); exam camera the tutor watches live; mock exams: one or more papers add up to one total and a grade from the tutor's own grade boundaries for the exam and session (typed in, or read by Prof from a grade-threshold PDF and checked), scaled when the mock's total differs; learners see only their grade and how many marks short of the next one, once every paper is given back |
| Marking | Auto-marking for multiple choice and numbers; tick or cross each line of working; draw on photos; drawings marked by Prof from a picture (what Prof read a drawing or photo as shows only to the tutor, never in the learner's feedback); feedback, comments and solutions show maths and formatting as they'll look, with a small maths keyboard; mistake labels; return marks, or return them and ask for a redo of the questions you tick (Prof never ticks redo itself, it can suggest one); release control; the total and return buttons stay in view while marking; blank or rubbed-out drawings count as no answer |
| Progress | Strengths per topic, time studied per day and subject, weekly and monthly summaries, missed deadlines, mistakes; coverage map per learner (the tutor sets each cell: Strong, Getting there, Needs work, Taught, Not yet); mock exam grades over time; weekly parent reports (learner switches them on; kept up to date by the server; the tutor can read any report any time; a designed report filled in by StudyBridge (lessons, work, marks and trend, topics, latest mock grade, exam countdown); the tutor adds a comment (Prof can suggest one) and approves; it goes to parent accounts, and by WhatsApp or email if the learner switched that on, with maths written in plain words; once StudyBridge email is switched on, it emails straight from StudyBridge; prints as a PDF) |
| Parent accounts | Read-only: the tutor makes a one-use parent invite for a learner (learner page → Parents); the parent sees approved weekly reports, upcoming lessons and due dates, marks once given back, topic strengths, mock grades and the exam countdown; never messages, working, photos, the exam camera or anything from Prof. The learner sees linked parents in Settings and can remove them. Four big tabs on phones: This week, Coming up, Marks and Settings, with a child picker for parents of two or more |
| Study (learners) | Flashcards with spaced repetition (the tutor's, Prof's after approval, the learner's own, mistake cards); daily quiz; worked example then you try; timed drills; formula sheets; daily goal and streak; self-marked work (one attempt; the mark scheme shows only when nothing can change) |
| Calendar | A private calendar link with lessons and due dates for Google, Apple or Outlook calendar |
| Messages | Notes from learners on any question, messages both ways, instant desktop notifications, phone push via ntfy |
| Live lessons | Video, screen sharing, shared whiteboard (LiveKit, shared keys from StudyBridge); one-off or weekly lessons at the tutor's clock time, each learner's own time shown; skip one week, move one, change from a lesson on, or stop; reminders a day and 15 minutes before, in the app and on learners' phones through ntfy; on data saver, low-quality or audio-only video |
| Learner experience | Friendly theme, streaks, week dots, Up next, score ring, confetti; works offline and hands in when back online |
| Prof (AI, tutor only) | Ask in plain words for homework, quizzes, tests, exams or lessons; use pages or a whole book from the library (Prof asks for the pages it needs); reply to Prof under its answer; auto-mark hand-ins; weekly work aimed at weak topics; style notes; turn your copy of a past paper into a test; original practice papers in a past paper's style; bank questions and flashcards with an automatic second check; syllabuses; weekly parent reports; notes on book pages it has read so re-reading is cheap; reads grade-threshold PDFs for mock exams; the Prof page shows the latest 5 requests with a searchable History; a monthly allowance per tutor that only the admin sees |
| Admin (StudyBridge) | Its own account; Overview, tutor pages, Inbox, Problems, Announcements; approve, decline, pause, switch back on, reset passwords, delete; plans chosen from a list (Free, Starter, Pro, Custom with your own learner limit, Complimentary: Pro for free with an optional end date) and Prof allowances with alerts at 80% and 100%; Admin → Prof page (Claude credit countdown, daily spend, who used Prof and for what); crash reports; minimum app version; Claude key (write-only), model; shared live video; log of every action; shared question bank and StudyBridge practice papers (ask Prof, review, approve for every tutor); Students page: the content account, Add every subject, the Students can sign up switch, each student's trial or payment, Mark as paid (monthly, or an exam pass lasting about two months past the first exam) and +7 days free |
| Accounts | One sign-in page for tutors, learners and the admin (the account decides which); anyone signs up as a tutor, answers a few sign-up questions and waits for approval; paused tutors can't sign in; tutors see changes the admin made to their account; a 7-step getting-started checklist on tutor Home; one-click account switching on the admin's own device; forgot password by email; download my data (a ZIP file) and delete my account in Settings; Continue with Google (built, off until set up); an account menu on every screen (Settings, switch account, Sign out); text size Normal, Large or Extra large per device (parents start on Large) |
| Students on their own | Launch 1, part 1 (9 Oct 2026): "I'm a student" on the welcome screen once the Owner opens sign-up (grade 8 and up; younger students will join through a parent); a 7-day free trial; a short setup (exam board, level, subjects, exam session or their own date, hours a week) and a plan on Today that spreads each subject's syllabus week by week to the exams, keeping the last part for practice papers and a mock; only subjects whose content is ready can be chosen, the rest say coming soon; after the free week without payment they see what they've done and how to pay, and nothing is deleted. Every catalogue subject (87: Cambridge, Pearson Edexcel and IB) sits in StudyBridge's own content account and opens one by one |
| Plans and payments | Free (1 learner), Starter (5), Pro (25); a tutor's plan and how full it is in Settings; limits off until the admin switches them on; Stripe checkout, billing and cancel built and off until keys and prices are added (Admin → Selling) |
| Website | Website 2.0 (7 Oct 2026), one page per audience: Home (what StudyBridge is in four ideas, who it's for, how it works, the countdown, boards, why trust it), Students, Tutors, Parents, Schools and centres, Subjects and Get the app. Across them: students first ("Get exam-ready, step by step"), "Where do you fit?" cards for students, learners with a tutor, parents, centres and schools, a free exam countdown for Cambridge, Pearson Edexcel and IB sessions, how it works for students, Prof's rules, every subject by board plus a searchable subjects page with "Ask for a subject", accessibility and languages, browser vs desktop with the right download, tutor features and pricing calculator, FAQ, an early-access form (the list is in Admin → Selling, with a CSV download), a Contact page (hello@gostudybridge.com; messages in Admin → Selling and emailed once Resend is set up), and "Open my StudyBridge" when you're signed in, terms and privacy drafts; light and dark; at `aaryanc-1.github.io/studybridge-releases/` until there's a domain; name and prices in one file for a rename |
| Updates | Desktop app downloads new versions and offers Restart now; rolls back a version that fails to start; Windows installs shell updates quietly, Mac downloads the new .dmg; the phone version is published automatically with every release; a new logo reinstalls the desktop shell so the app icon updates; the version that was running stays as a spare during updates, and if part of the app can't load after an update a bar offers to restart |
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
| GitHub repo `studybridge-releases` (public) | Download page, the updates apps check, and the phone version on GitHub Pages | Running; latest release 1.1.63 |
| Website | Published with every release next to the phone version; its early-access form saves to the server (Admin → Selling shows the list) | Live at gostudybridge.com (app at gostudybridge.com/app/), served by Cloudflare Pages (project gostudybridge) from the releases repo's gh-pages branch; old github.io links redirect |
| Admin → Students | The content account (a tutor account just for StudyBridge's own subjects), every subject added to it, and the Students can sign up switch | To do: sign up the content account, approve it, set it here, add every subject; fill 0607 first and tick Open to students; then switch sign-up on |
| Admin → Selling | Plan limits, Stripe (secret key, webhook secret, four price IDs), Resend email (sender and key), Google sign-in | Nothing set; all off |
| Domain gostudybridge.com (Cloudflare) | The website and the phone/web version; Cloudflare Pages serves them free and fast worldwide. Later: email from the domain (Resend) and hello@ forwarding (Cloudflare Email Routing) | Live 7 Oct 2026; Supabase Site URL set to gostudybridge.com/app/ (8 Oct 2026); Cloudflare Web Analytics on |
| Email hello@ and support@ (Cloudflare Email Routing) | hello@ for the website, support@ for help inside the app; both forward to gostudybridge.hq@gmail.com. Sending from the domain needs Resend, then Gmail "Send mail as", Supabase SMTP and Admin → Selling → Email | Receiving works (8 Oct 2026). Resend not set up yet: website and in-app messages wait in a queue and are in Admin meanwhile |
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

**Links to give people:** the website is `gostudybridge.com` (sign-up, invites, downloads) and the phone and web version is `gostudybridge.com/app/`; tutors and learners download from `github.com/aaryanc-1/studybridge-releases/releases/latest`. On a Mac, the first open needs System Settings → Privacy & Security → Open Anyway. The phone version is at `gostudybridge.com/app/` (add it to the home screen); it updates itself with every release.

## Costs and pricing

A tutor costs StudyBridge roughly $2–12 a month in AI plus a dollar or two of shared services. Prices were agreed on 8 Oct 2026 (the full working is in the price sheet doc). During early access Aaryan takes payment himself and sets each plan in Admin; online checkout comes last.

**What Prof costs per task** (Claude Sonnet 5.5: $2 per million tokens in, $10 out)

| Task | Approx. cost |
| --- | --- |
| 10–20 questions from book pages | 15–30¢ (page pictures cut by a third on 1 Oct) |
| 10–20 questions without a book | 5–10¢ |
| Marking one hand-in | 1–5¢ (more with photos) |
| Light tutor month (8 assignments, 30 markings) | about $2–3 |
| Heavy tutor month (30 assignments, 100 markings) | about $8–12 |

**Running costs:** Supabase free now, Pro $25/month when files pass 1 GB or the database 500 MB; LiveKit free tier, then pay per video minute; card fees about 3% + 30¢ per payment; a domain about $10–15 a year when email is added.

**Prices** (agreed 8 Oct 2026; one price in US dollars, shown in the visitor's currency; every paid plan starts with a 7-day free trial; no discounts)

| Who | How they pay | Monthly | Yearly or pass |
| --- | --- | --- | --- |
| Tutor, Essentials (no Prof) | Per learner, in steps | $5 each for learners 1–10, $4 for 11–30, $3 after 30 | 11 months' price for 12 (1 month free) |
| Tutor, Plus (unlimited Prof, mocks with grades, exam camera, StudyBridge content) | Per learner, in steps | $9, $7, $5 | 11 months' price for 12 |
| Self-learner | Every subject at their level | $12 | Exam pass: $10 a month, paid once, until their exams |
| A tutor's learner, parents | Free | Free | Free |

Examples: 5 learners cost $25 (Essentials) or $45 (Plus) a month; 25 learners $110 or $195. A self-learner 8 months from their exams pays $80 with a pass. Prof has no limit on Plus; Admin gets an alert if one tutor's Prof costs more than they pay.

Payments: during early access, by arrangement with Aaryan. Online checkout later: Stripe for cards (Adaptive Pricing charges in local currency), mobile money through Flutterwave or DPO, tax through Stripe Tax.

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

Agreed with Aaryan on 7 Oct 2026 and updated on 8 Oct. StudyBridge grows from "a tutor and their learners" into one whole education platform: what ManageBac, Canvas and Google Classroom give, plus lockdown exams, for a student on their own, a tutor and their learners, tuition centres, then schools. Students never chat with AI: a student without a tutor gets lessons, hints and worked solutions made and checked ahead of time. The big goal is to be the most complete and trustworthy place to prepare for an exam, better than studybridge.tech (an AI-first South African platform with the same name).

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
5. **Bring your own course** (later, to decide): anyone not covered uploads a syllabus and gets a plan and practice. It would need Prof to work for a student directly, so it waits.
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

**Build order** (changed on 8 Oct 2026: self-learners launch first; the launch priorities doc has the full checklist)

| Step | What | Status |
| --- | --- | --- |
| Done | Name and domain (StudyBridge, gostudybridge.com); website 2.0; the 6 Oct fixes; fixes and polish | Done 7–8 Oct 2026 (apps 1.1.51–1.1.57) |
| Now | The website and docs match the new plan: prices, the two tutor levels, the trial, no AI chat for students, terms and privacy | Done 8 Oct 2026 (app 1.1.58) |
| Launch 1 | Self-learners on the web and phones: accounts in StudyBridge's own organisation, guided setup, starting check, countdown plan, Today, exam conditions (full screen and a timer), Owner-only content tools with automatic checks and a report button, subjects switching on as their content is ready (every subject), parent approval for young learners, manual billing in Admin, accessibility basics, privacy pack | Part 1 out 9 Oct 2026 (app 1.1.63): accounts, setup, plan, subjects opening one by one, manual billing. Next: part 2, content tools and checks |
| Launch 2 | Tutors: organisations and classes, the new Home and shorter menu, Essentials and Plus, watched mode, pausing a learner, "change this part" with Prof, cheaper Prof behind the scenes, the connector removed for tutors, signed Windows and Mac apps | After launch 1 |
| Checkout | Online payment: Stripe for cards, mobile money, tax | When everything is ready |
| iPad | The iPad app with Apple's exam mode | After the Apple account |
| Waves | Classroom (stream, rubrics, gradebook, school sign-in, exam-room view); running a school (planners, IB criteria, report cards, attendance, timetable, CAS/EE/TOK, Chromebook extension); reach (six languages, school systems, analytics, growth) | After the launches |

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
| Launch 1: students on their own | Sign-up, free week, setup, a plan to the exams, payments in Admin | Launch 1 part 1 | Shipped (9 Oct 2026) |
| 2.0: open to every learner | Students on their own (hints and solutions written ahead, never AI chat), then tuition centres and schools; guided setup, exam countdown plan, lessons, original practice papers, accessibility, six languages. See 2.0 plan | 2.0 | Planned |
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
- **Students' free week is checked in the app only:** a student who knows how could still reach their data after the trial through the server. Tighten on the server before student sign-up opens on the website (launch 1 part 4).
- **A new name is likely:** the website's name and prices live in `website/site.config.json`; the app itself still says StudyBridge in many places, so a rename is its own small update.

## Changelog

| Date | Change |
| --- | --- |
| 8 Oct 2026 | Fixes and polish (app 1.1.56): handed-in work drops off tutor Home's Coming up; the desktop app keeps the running version during updates and offers a restart if part of the app can't load (the exam-camera error); the lockdown box says test or quiz; an account menu on every screen with Sign out; parents get four big tabs and a child picker; text size per device; the welcome screen matches the website with a link back; the website shows Open my StudyBridge when signed in; a Contact page; hello@ (website) and support@ (in the app) set up, and website messages, early access and Contact StudyBridge are emailed once Resend is set up; weekly report replies go to the tutor |
| 9 Oct 2026 | Students on their own, part 1 (app 1.1.63): Admin → Students picks StudyBridge's content account, adds every subject (87) to it and switches student sign-up on; I'm a student on the welcome screen (grade 8 and up) with a 7-day free trial; a short setup (board, level, subjects, exams, hours a week) and a plan on Today, week by week to the exams; only subjects ticked Open to students can be chosen; after the free week, a page on how to pay; the Owner marks students as paid (monthly or exam pass) or adds a free week |
| 9 Oct 2026 | Smoother website and clearer updates (apps 1.1.61–1.1.62): the website reads as one continuous page (no section bands), and every page loads that release's own styles, because browsers kept the old stylesheet for up to 4 hours; in the app, Ctrl+, opens Settings from anywhere, and the update banner also shows a download in progress and a failed update (Try again, or download from the website); empty "Script error." reports (from other sites' scripts) no longer reach Problems |
| 9 Oct 2026 | Flowing background (app 1.1.60): every page of the website has one soft background whose colours (teal, gold, blue, green) fade into one another as you scroll down and back as you scroll up; the hero glow with a hard edge is gone, banded sections fade in and out, and cards let a little colour through |
| 9 Oct 2026 | Website 3 and join codes (app 1.1.59): a separate Pricing page where you pick who you are (student, tutor, parent, school), linked from the menu and the tutors and students pages; a tidier footer (even columns, no repeated email); livelier pages (drifting colour, rotating words, cards that light up under the pointer, items arriving in turn, subjects drifting past); learners join with an 8-digit code or a link that fills it in, and 10 wrong codes in an hour make that account wait |
| 8 Oct 2026 | New prices and plan (app 1.1.58): the website shows per-learner tutor pricing on Essentials and Plus (1 month free yearly, 7-day trial) and self-learner prices ($12 a month or an exam pass); students never chat with AI (hints and worked solutions written ahead, on the students page, home, parents, terms and privacy); Settings and Admin describe the same plans; the plan now launches self-learners first |
| 8 Oct 2026 | Account menu and Discard (app 1.1.57): the account menu at the bottom of the sidebar opens again (it was opening but hidden), with Settings, Switch account and Sign out; Prof's drafts can be discarded straight from Waiting for you or inside the draft |
| 7 Oct 2026 | Moved to gostudybridge.com (app 1.1.55): the domain was bought on Cloudflare; Cloudflare Pages serves the website and the app at /app/; invites, parent invites, password-reset links, Stripe returns and the QR code use it; old github.io links redirect (signed-in phone users get a note first). The backend stays on Supabase (decided: not GoDaddy shared hosting, which can't run it safely) |
| 7 Oct 2026 | 2.0 step 3, the 6 Oct fixes (app 1.1.54): lockdown alerts say test, quiz or exam as it is; the marking total and buttons stay in view (a bar on narrow screens); "Return marks" is always there and final, "Return marks and ask to redo N" only when you tick redo, "Save, return later" never releases; Prof no longer ticks redo; feedback with "
" written out gets real line breaks (old feedback fixed too); blank or rubbed-out drawings count as no answer; tutor plans chosen from a list (Free, Starter, Pro, Custom, Complimentary), typed-in names became Complimentary |
| 7 Oct 2026 | Website (app 1.1.53): a Home page with a proper introduction (what StudyBridge is in four ideas, who it's for, how it works) and its own page for students, tutors, parents, schools and centres, and getting the app; the menu marks the current page and each early-access form starts on the right role. A GitHub fault skipped the release step once (1.1.52); rebuilt as 1.1.53 |
| 7 Oct 2026 | 2.0 step 2, website 2.0 (app 1.1.51): students first, where-do-you-fit cards, a free exam countdown, how it works, Prof's rules, subjects for Cambridge, Pearson Edexcel and IB (SL and HL) with a searchable subjects page and "Ask for a subject", accessibility and languages, browser vs desktop, tutor features and pricing, parents, centres and schools, FAQ, and an early-access form whose list is in Admin → Selling (CSV download); terms and privacy updated for students on their own, early access and age |
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
