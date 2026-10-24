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
  `aaryanc-1/studybridge-releases` (desktop auto-updates) and the website + phone app to its `gh-pages` branch.
  Since 7 Oct 2026 the domain is **gostudybridge.com** (bought on Cloudflare): Cloudflare Pages (project `studybridge-releases`)
  serves that branch, so the website is https://gostudybridge.com and the app https://gostudybridge.com/app/.
  Old aaryanc-1.github.io links redirect there (website at once; the app unless someone is signed in, who gets a note).
- **Logo:** `brand/` → `npm run icons` (scripts/make-icons.py) makes every icon.

## Tests (run before every commit)
- `npm test` — PGlite runs the real setup.sql (`test/db.test.mjs`), fake Supabase/Claude/Stripe/Resend, Prof, website (93)
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
1.6 part 4 + fixes: data saver per device (`src/lib/device.js`: smaller photos, PDFs by range requests page by page,
pictures on tap, low/audio-only live video; never for exam cameras), light/dark/auto appearance (`data-theme` on <html>,
dark tokens at the end of styles.css). Lockdown has no Leave button: each try to leave is a strike (`lockdown_strike`,
`assignments.leave_warnings`, default 1 warning), then `_hand_in`; forced exits reopen the exam and count; `_auto_hand_in`
(pg_cron every minute) hands in timed-out attempts; tutor ends early with `end_attempt` (hand in / cancel). Account
switcher (`src/lib/accounts.js`) only on a device where the admin account signed in. The installed shell's fingerprint
includes build/icon.png, so a new logo reinstalls the shell. Syllabus from the tutor's PDF (text, or pictures if scanned)
via `prof_syllabus(..., p_source)`; teaching plans (`teaching_plans`, one per subject; `src/lib/plan.js` spreads evenly,
`prof_plan` asks Prof). Supabase: "Confirm email" is off and Site URL is the phone web app (Aaryan, 6 Oct 2026).
1.6 part 5: drawings are marked from a picture (`strokesPicture` in DrawingPad; old attempts get pictures on the tutor's
side via `ensureDrawingPictures`); Prof's `read_as`/`tutor_note` go to `responses.prof_note`, tutor-only, never in learner
feedback. `src/ui/MathText.jsx` shows feedback/comments/solutions as finished text with a maths keyboard; `plainMaths`
(`src/lib/plain.js`) for WhatsApp/email. Selling basics: forgot password (Supabase email, `NewPassword` in App.jsx),
`export_my_data` → ZIP (`src/lib/zip.js`), `delete_my_account('DELETE')`, plans Free 1 / Starter 5 ($15/mo, $150/yr) /
Pro 25 ($29/mo, $290/yr), limits off until Admin → Selling switches `enforce_plans` on. Ready but off: Google sign-in
(`google_on`, web/phone only), Resend email (`email_from` + key; reports email straight from StudyBridge), Stripe
(checkout/billing in Prof, webhook `prof?stripe=webhook` → `_set_paid_plan`; shown once a secret key and a price exist).
Website: `website/` (one config `site.config.json` for name, prices, currencies; `scripts/build-website.mjs`), published by
CI at the releases repo's Pages root next to `app/`; links `app/#start=tutor|invite|parent|signin` open the right screen.
2.0 step 2 (website 2.0): students first ("Get exam-ready, step by step"), "Where do you fit?" cards, a free exam
countdown (sessions per board in `site.config.json` → `boards[].sessions`), subjects by board (`boards[].levels`, also
`website/subjects.html` with search and "Ask for a subject"), Prof's rules, accessibility, browser vs desktop, tutors +
pricing, FAQ, early-access form → `join_early_access` (anon RPC; table `early_access`, RLS on, no policies; the Owner reads
it in Admin → Selling via `admin_early_access`, with CSV download). Shared header/footer come from build-website.mjs; the
form gets the public Supabase URL/key from env `SB_URL`/`SB_KEY` at build time and hides itself without them.
Website pages (7 Oct 2026): Home (index.html: the introduction, who it's for, how it works, countdown teaser, subjects,
trust), students.html, tutors.html (pricing), parents.html, schools.html, subjects.html, download.html, terms, privacy.
The menu comes from `PAGES` in build-website.mjs; shared pieces live in `website/partials/` and are dropped in with
`{{name:arg}}` (e.g. `{{early:parent}}` presets the form's role, `{{countdown:}}`).
2.0 step 3 (fixes from 6 Oct): lockdown text says the assignment's kind (`log_lockdown_event` swaps "the exam" for
"the test" etc.; `forKind` in format.js for older events); the Marking Total card is sticky (`.mark-side`/`.mark-total`,
plus `.mark-bar` under 900px); `finish_marking(p_attempt, p_release, p_feedback, p_redo)`: "Return marks" is final and
clears redo ticks, "Return marks and ask to redo N" sends them back, "Save, return later" never releases; Prof no longer
sets redo (it can suggest one in tutor_note); `_fix_newlines` (SQL) / `fixNewlines` (Prof) turn a written-out "
" into a
line break; blank or rubbed-out drawings are `answer.blank` (`drawn()` in questions.js) and Prof gets "nothing drawn";
plans come from a list (`profiles_plan_check`: free, starter, pro, custom + `plan_learners`, complimentary + `plan_until`;
`_tutor_limit`; old typed names became complimentary; `PLANS`/`planName` in format.js).
Fixes and polish (8 Oct 2026): tutor Home "Coming up" drops work everyone has handed in ("1 of 2 handed in");
desktop updater keeps the version that was running as a spare and tidies old folders only at start (`tidy` in
updater.cjs), `app:restart` IPC + a "StudyBridge was updated, restart" bar when a lazily loaded part fails (main.jsx,
`vite:preloadError`); an account menu on every screen (`AccountMenu` in Shell.jsx: Settings, switch account, Sign out);
parents get four tabs (This week, Coming up, Marks, Settings; child picker for 2+ children) and a bigger phone menu
(`theme-parent`); text size per device (`applyTextSize`/`setTextSize` in device.js: CSS zoom, parents start on Large);
the welcome screen has the website's look and a link back to gostudybridge.com; the website shows "Open my StudyBridge"
when `sb.auth` is in localStorage (same origin), and the old-address redirect checks `sb.auth` (the app's session key).
Email: hello@ (website) and support@ (inside the app) forward to gostudybridge.hq@gmail.com via Cloudflare Email Routing.
`outgoing_emails` queue + `_email_us(box, …)`: website Contact page (`contact_messages`, anon `send_contact`), early access
and subject requests go to hello@; in-app "Contact StudyBridge" (`send_feedback`) to support@, each with reply-to the
person; Prof's `sendQueued()` sends them through Resend on every kick once Admin → Selling has the Resend key + sender.
Weekly report emails reply to the tutor. Admin → Selling shows website messages and the email queue.
Account menu fix (8 Oct): its classes are `acct-side`/`acct-top` (the old `side` class picked up the sidebar's own
styles and clipped the menu); in the sidebar it floats (fixed) above the button. Drafts (Prof's work, copied papers,
lesson notes) can be discarded from Prof → "Waiting for you" or inside the draft (`useDiscardDraft` in ClaudeInbox.jsx).
test/product.mjs runs on Windows too: `CHROMIUM` = Edge's path (no Playwright browsers installed on Aaryan's PC).
Website 3 (9 Oct 2026): a separate Pricing page (website/pricing.html; a who-are-you picker whose tabs open from the
address, pricing.html#students|tutors|parents|schools; the tutors and students pages link to it instead of showing prices);
Pricing in the menu (`PAGES`); the footer has no email (the Contact link and contact.html carry hello@) and even columns;
livelier pages: drifting colour behind each opening, shimmering italic headline words, rotating "Made for …", a tilting plan
card with floating chips, cards that light up under the pointer (`.spot`), grids that arrive one by one (`.stagger`, set by
site.js), numbers that count up (`data-count`), two rows of subjects drifting past (`marqueeA/B`); all off with reduced
motion. A `.who` class used to leak the section background into the price cards (now `.who-sec` and `.plan .blurb`).
Learner invites are 8-digit codes (`_new_invite_code()`, shown "4829 1375"); the tutor's message has a link
`app/#join=<code>` that fills the code in (Welcome.jsx), or the learner types it; `decodeInvite` accepts the code, the link,
a whole pasted message or the old SB1 token. A wrong code is counted in `invite_tries` and `accept_invite` returns no
profile (an error would undo the count; api.acceptInvite turns it into "That code isn't right"); 10 wrong codes in an hour
and that account waits. Parent invites are unchanged (P + 10 hex, SB1 message). test/walkthrough.mjs also runs on Windows.
One flowing background on every page (9 Oct): `.aurora` (added by build-website.mjs's header) holds four soft colour
fields; site.js sets `--p` (scroll progress) and each field's `--o`, so teal, gold, blue and green fade into one another
as you scroll and back as you scroll up. The old per-section hero glows are off; banded sections fade in and out
(gradient backgrounds) and cards are slightly see-through (`--card` is translucent on the website only).
Later the same day: sections draw no bands at all (one continuous page), and every page asks for `site.css?v=<hash>`,
`site.js?v=<hash>` and `config.js?v=<version>`, because Cloudflare lets browsers keep site.css for 4 hours (Aaryan saw
the old look). App: Ctrl+, (Cmd+,) opens Settings from anywhere; the update banner also shows "Downloading…" and
"couldn't update" (Try again / Download from gostudybridge.com/download), and a desktop-shell install says it closes,
installs and reopens. A shell update after 1.1.56 can look stuck when the app hides in the tray (keep in background):
the installer can't replace a running app, so quit from the tray first.
Launch 1 part 1 (9 Oct 2026), students on their own: they are learners (`self_learner`) whose tutor is the content
account (`profiles.is_studybridge`, a tutor account the Owner picks in Admin → Students with `admin_set_content_account`;
its `_tutor_limit` is unlimited). Every catalogue subject (87, from site.config.json `boards[].levels`, keyed
`board:level:code` in `src/lib/catalogue.js`) is a subject of that account (`subjects.catalogue/board/level/code/live`,
added by `admin_seed_catalogue`); a subject opens to students when the content account ticks "Open to students"
(Structure.jsx, `live`). "I'm a student" shows on the welcome screen (and `#start=student`) only when
`app_config.students_open` (Admin switch, `public_settings().students_open`); `start_self_learner` needs grade 8+ (younger:
a parent's account, part 3) and sets a 7-day `trial_until`. SelfStudy.jsx: `SelfSetup` (board → level, IB skips it →
open subjects → exam session or own date → hours a week; `self_setup` sets learner_subjects, exam_date/label,
study_goal_min, plan_start, setup_done; `/setup` runs it again) and `SelfPlan` on Today (topics spread week by week to the
exams with `spreadEvenly`, last part for papers and a mock). `studentAccess` (src/lib/students.js): paid (`paid_until`,
`paid_plan` monthly|pass) or trial, else `TrialOver` (Progress and Settings stay open). Admin → Students lists them,
"Mark as paid" (Monthly = a month; Exam pass = about 60 days past the first exam), "+7 days free". The trial is enforced
in the app only so far (tighten on the server in part 4). Aranya's maths is 0607, the first subject to fill.
New logo (9 Oct 2026, waiting for the next build): brighter teal figures, a yellow head, a three-page book and a navy
"StudyBridge". Aaryan's files came on a solid black background; brand/logo-mark.png and brand/logo-wordmark.png are
transparent copies (alpha from brightness, the text as solid navy), then `npm run icons` (on Windows:
`python scripts/make-icons.py`). The mark is wider, so `Logo` is 1.62× its height wide. The update that ships it
reinstalls the desktop shell once (build/icon.png is in its fingerprint).
Launch 1 part 2 (9 Oct 2026), StudyBridge's own content: the Owner makes it in Claude Desktop with the connector (1.1.0)
signed in as the content account; content tools refuse any other account (`_content_me()`). Tools → RPCs: content_overview
(`content_status`), set_syllabus (`content_set_syllabus`, topics by name, `details` = subtopics), add_questions
(`content_add_questions` → bank_questions owner = content account, `status 'review'`, `hint_md`, `check_result.state`
'waiting' or 'problems'), add_lesson (`content_add_lesson`, same title replaces, visible when it passes), add_flashcards
(`content_add_cards`), add_practice_paper (`content_add_paper`: a self-marked 'test', draft until every question passes,
says "Not affiliated with or endorsed by"). Plain checks in `_content_problems` (complete, $ and { pair up, answer fits the
type, ©/UCLES flagged). The second check runs in a NEW chat (prompt `check_waiting`): questions_to_check
(`content_to_check`, never answers/hints/solutions) → submit_checks (`content_submit_checks`; `_content_compare`: choices
and numbers (±0.5%) compared, steps by normalised final line, written answers come back as `compare_these`) →
confirm_checks. Passed → approved/live (`_content_mark`, `_content_paper_ready`); failed → Admin → Content
(`admin_content_review`, `admin_content_decide` approve/fix/hide/remove, badge in the admin menu). Students on their own
see practice with "Show a hint" (`questions.hint_md`, `questions.bank_id` copied by start_practice), and "Report a
problem" on questions, lessons and flashcards (`report_content` → `content_reports`, admin notification + email to
support@; the item stays up, Aaryan's choice; `admin_report_done` with an optional reply). Pay by card: two Stripe
Payment Links in Admin → Students (`admin_set_pay_links`, `student_pay_links`); `PayOptions` adds
`client_reference_id=<account id>`; the exam pass link uses quantity = months to the exams. Students can now use Contact
StudyBridge (`send_feedback` allows self-learners); Settings has "Your plan" for them; their wording no longer says "your
tutor". Practice papers and the Study page's practice can be opened from the plan (`/study?subject=&topic=`).
Later on 9 Oct (Aaryan): no Claude Desktop for tutors and no live-video keys for them. The connector (1.2.0) has only the
content tools plus list_library/read_pdf and signs in only as the content account (tutor tools and the mark_latest /
weekly_report prompts are gone); Settings → Claude Desktop shows only on the content account (`me.is_studybridge`);
Marking has no "mark with Claude Desktop". Settings has no Live video section: `live_pass` uses StudyBridge's shared
LiveKit (Admin → StudyBridge settings) first and a tutor's old keys only if that isn't set. Account switching: the
device remembers the admin account used it (`sb.adminDevice` = server URL), so signing out of admin no longer hides
switching; the account menu has "Add another account".
Basic fixes (10 Oct 2026, from an audit Aaryan asked for): tapping an assignment or lesson notes opens options (Edit,
Post now / Hide from learners, Handed in, Duplicate, Delete) and lists split into Not posted yet / Waiting for hand-ins /
Everyone has handed in (`AssignmentOptions`, `quickPost` and `checkReady` in AssignmentEditor.jsx; `LessonOptions` in
Library.jsx); Marking has a "Not handed in" tab; editors ask before you leave with unsaved changes (`useLeaveGuard` in kit.jsx;
`go(path, { force: true })` after a save); saving something already posted stays on the page; My files splits shared and
hidden with Show/Hide and Delete on each row; tutors can delete their own messages and edit flashcards; the question bank
has Write a question, a Reject confirm and a Rejected list; reports can be skipped (`skip_report`, status 'skipped') or
withdrawn (`withdraw_report`); "Let them try again" reopens a hand-in (`reopen_attempt`: answers kept, marks cleared, time
left with at least 5 minutes); mocks have "Post all papers" and a subject picker; confirms on topic removal, invite
cancelling and draft discarding; subject deletion lists everything it deletes; failed deletes say so. Learners: My cards (edit
or delete own and mistake cards), To do sorted by due date, own practice can be cleared (`hide_my_practice`,
`assignments.learner_hidden`), Today's "Marks back" counts this week. Parents: overdue first in Coming up, and Settings →
Your children → Stop following (`parent_unlink`).
Website (10 Oct 2026): an Apple-style layer at the end of website/site.css (from emilkowalski/skills apple-design): system
fonts (no Google Fonts), tight display tracking, a glass header whose links never wrap (menu button under 1180px), pill
buttons that press in on touch, solid quiet cards, no idle loops (bob, float, pulse, shimmer, flow), and rules for reduced
motion, reduced transparency and more contrast. Pages and wording unchanged. Same day, Aaryan found it too spaced out: a "Tighter" block at the very end of site.css halves section padding (64px, 44px on phones), shrinks h1/h2 and the gaps (the home page is about 17% shorter).
Updater bug (10 Oct 2026): after the shell downloads a new bundle (state 'ready', pending), a later check (or "Check now")
finds nothing newer than the pending one and sets 'up-to-date', which hid the restart bar while the old version kept running.
Fixed in the app, not the shell (a shell change forces everyone to reinstall): `restartWaiting(st)` in Shell.jsx (status still
has kind 'restart' and the waiting version, newer than `current`) shows the bar and Settings' "Restart now" (`desktop.restart()`).
Done 21 Oct 2026 with the Google sign-in shell change.
From Aaryan's testing (10 Oct 2026): "Time each day" (Progress.jsx) has a scale with round halves, the time on each bar
(a week), and a hover/tap card with the day's subjects (`learner_summary` by_day now carries `subjects`); the formula sheet sits
under Practice on Study with "Start with my topics"; "Mistake cards" are "Cards from mistakes", explained, and the tutor can
see them (`MistakeCards` in Study.jsx, `api.learnerMistakeCards`). Welcome choices: I'm studying on my own (students), I have a
code from my tutor, I'm a tutor, I'm a parent. Student sign-up opens by itself once a subject is open to students; the Admin
switch only pauses it (`app_config.students_paused`; `students_open` is no longer used). The student setup lists only boards,
levels and subjects that are open. Nothing says "coming soon" (Aaryan: we launch when it's ready), on the website or in the app.
Prices B (10 Oct 2026): Essentials $5/$4/$3 (unchanged), Plus $8/$6/$4, students $11 a month or an exam pass at $9 a month.
Website: features.html (Prof first, as "Meet Prof": StudyBridge's AI teaching assistant for tutors; never says Claude; the
privacy page still names Anthropic as the AI provider, as privacy law needs); the menu is Students, Tutors, Parents, Schools,
Features, Pricing, Subjects (Get the app is in the footer and the phone menu); the "With Prof" badge links to features.html#prof;
student plan buttons start the free week in the app.
Updates by themselves (10 Oct 2026, Aaryan: the bar only showed after Check for updates, because the shell checks 15 s after
opening and then every 3 hours, and the app lives in the tray). No shell change: `src/lib/autoupdate.js` holds the rules and
`useAutoUpdate` in Shell.jsx (inside `UpdateBanner`) runs them. Desktop: asks the shell to check every 15 minutes and on coming
back (5+ minutes since the last check), never while a desktop installer is ready (it would download it again); it restarts into
a downloaded bundle as you come back from the tray or a minimised window (or after 2+ minutes in another app), or after 10
minutes untouched, showing "Updating StudyBridge…". `busyNow` blocks it: attempt/live/watch pages, anything typed or drawn on
the page (`pageChanged` resets on a new page), unsaved changes (`hasUnsaved` in kit.jsx), an open dialog, playing video/audio,
full screen, anything waiting to send. `restartDesktop()` saves the page in `sb.resume` (autoupdate.js is imported first in
main.jsx and reopens it). Web/phone: `webHasUpdate()` compares the main script's name in a fresh index.html (`?fresh=` skips
the service worker), every 15 minutes and on coming back; reloads in the background, as you come back or after 10 minutes
untouched, else "A new version of StudyBridge is ready. Reload". Errors from automatic checks stay quiet. Settings → About
says when it last checked. product.mjs tests both (the desktop shell is played by the page).
Launch 1 finished (19 Oct 2026, Aaryan: "build entirety of launch 1"; his lawyer said the plan is fine). Starting check:
`start_practice('check', subject)` picks a question per topic (up to 12, auto-marked, `assignments.starting_check`, 1 try);
`my_starting_checks`; SelfSetup goes to `/check` (StartingCheck in SelfStudy.jsx; straight to Today if no questions yet),
`CheckNudge` on Today until done or "Not now" (`sb.checkSkip.<subject>`), and SelfPlan shows "Work on first" (weak/developing
topics from `my_topics`, only after the check). Exam conditions: students on their own, in a browser, for tests/exams (practice
papers, mocks) tick "Exam conditions" on WorkDetail: full screen (asked for in the tap), `sb.exam.<attempt>` in sessionStorage,
each exit counted (`note_left_full_screen`, `attempts.left_full_screen`) with a "Back to full screen" bar; phones that can't go
full screen keep just the timer. Young students: below grade 8 (and in India under 18, grade < 13) a parent's code is needed:
`start_parent` ("I'm a parent" → "Set up my child to study on their own"), `parent_child_code` (8 digits, table `child_codes`,
5 waiting at most), the child types it on sign-up (`start_self_learner(..., p_parent_code)`; wrong codes counted in
`invite_tries` and return no profile), which links the parent and records `consent_parent`/`consent_at`. `parent_delete_child`
(only the parent who set it up). Students on their own make parent codes too (`self_parent_invite`, P + 10 hex; Settings → Your
parents), and parents can link with any P code from their app. `parent_view` has `self` (plan, 7-day study time, practice, trial or
plan) and parents can pay for a child (`PayOptions forId`). Server-side free week: `_student_ok()` (self-learners need trial, paid
or test) is in `can_learner_see` (redefined in the launch 1 block: files, lessons, assignments, questions), shared cards, and a
trigger on self practice (`assignments_self_ok`). Test students: Admin → Students → Try it as a student (`admin_set_test_emails`,
`app_config.test_emails`, `profiles.test_student`): sign up via `#start=student-test` even while closed, see subjects not open
yet, never pay. Website: `open_subjects()` (anon) marks "Start now" on subjects.html (keys from `catalogueKey` in
build-website.mjs = the app's catalogue keys); privacy/terms have the children's section. Accessibility basics: a "Skip to the
page" button and one `<main id="main-content">` in Shell, reduced motion everywhere in the app, and product.mjs's `a11y()` scan
(names, labels, alt, one main) on the main screens of each account. Also built: past live lessons open into notes
(`lessons.session_id`), Start now picks learners, weekly lessons always editable; Admin → Content → Browse everything
(`admin_content_browse`, `admin_content_decide` kind 'practice_paper'); announcements edit/delete. Website intro: the home page
plays a 5-second logo animation once per session (layers in website/intro/ cut by `python scripts/make-intro.py`; timeline at the
end of site.css; skip with any key/tap; off with reduced motion). CI keeps build files 1 day (`retention-days: 1`): 90 days had
filled GitHub's 0.5 GB Actions storage.
Ready for students (20 Oct 2026, Aaryan: "go for all"). Student emails go in `outgoing_emails` (Prof sends them via Resend,
reply-to support@; never to test students): `_email_welcome` (from start_self_learner; the parent who made the code too),
`_student_emails_tick` (pg_cron `studybridge-students` hourly: "your free week ends in 2 days" once, `profiles.trial_reminded`, reset
by admin_extend_trial; not if paid) and `_email_all_set` (admin_set_student_paid and card payments); `_email_student` writes one to
the student and one to each linked parent. Card payments record themselves: Prof's stripeWebhook, for checkout.session.completed
with client_reference_id and a payment_link, looks the link up (`payment_links/<id>` url vs app_config pay links) and, for the exam
pass, the quantity (`checkout/sessions/<id>/line_items`), then `_student_paid_by_card` (service only; pass for enough months to
the exams = exam_date + 60 days, else the months bought; monthly = +1 month, `profiles.stripe_student_sub`); invoice.paid with
billing_reason subscription_cycle → `_student_renewed`. The webhook needs invoice.paid too (Admin → Selling says so). The
button sweep (test/sweep.mjs) also presses buttons inside pop-ups (`insidePopup`), fails the walkthrough when anything breaks,
and runs as its own CI job `sweep` (SWEEP=1 node test/product.mjs); the release waits for it. Blocked notifications explain how to
allow them; the PDF viewer's page buttons grey out at the first and last page.
Daily study reminder (same update): learners switch it on in Settings (time, default 17:00; `set_study_reminder`,
`profiles.remind_on/remind_time/reminded_on`); pg_cron `studybridge-reminders` every 10 min runs `_study_reminders()` (their own
clock reached the time, not reminded today, no `activity` today, and not a student whose free week is over unpaid) →
`notify_user(..., 'study_reminder', ...)` (in-app + ntfy) and one web push per device (`push_subscriptions` → `push_outbox`, then
`_prof_kick`). Prof's `sendPushes()` sends payload-free web pushes with VAPID (`vapidKeys()` makes the key pair itself the first
time: `app_config.vapid_public`, `platform_secrets.vapid_private`; action `push_key`; WebCrypto only), drops a device on 404/410,
and only posts to the big browsers' push services. public/sw.js shows "Time for StudyBridge" on a push. In a browser Shell.jsx
doesn't also pop the in-page notification for 'study_reminder'. Website (same update): a page per catalogue subject
(`subject-<board>-<level>-<code>.html` from `website/partials/subject-page.html`, `subjectPages()` in build-website.mjs; its call
to action asks `open_subjects()`: free week if open, else "Ask for this subject"), sitemap.xml, robots.txt (no /app/), canonical +
og/twitter tags added to every page by the build, share.png (1200×630) from `python scripts/make-share.py`. Student buttons on
students.html, index.html and the countdown show "Start your free week" once any subject is open (`data-students="open"`), the
early-access ones until then (`data-students="closed"`). Submit https://gostudybridge.com/sitemap.xml to Google Search Console.
`copyText` (kit.jsx) copies with the old copy command first and only then the newer clipboard, and never throws (the CI sweep
found "Write permission denied" errors); the sweep refuses the newer clipboard on purpose to keep it that way.
Google sign-in works everywhere (21 Oct 2026, Aaryan: "make continue with google work, no hiding"). Web/phone: `signInWithGoogle()`
goes to Google and back (`sessionFromLink` takes the tokens from the address). Desktop: `desktop.google.signIn(url)` (preload →
main.cjs `auth:google`): Google opens in the normal browser (Google refuses sign-in inside apps) and returns to a one-time page on
`http://127.0.0.1:53682/auth/callback`, which hands the tokens to the app (`setSession`). That address and
`https://gostudybridge.com/app/**` must be in Supabase → Authentication → URL Configuration → Redirect URLs. The button is on the
sign-in page and on every sign-up path (`GoogleButton prepare`): what the new account will be (tutor, student with grade/country/
parent code, parent) waits in `sb.pendingSetup` (localStorage, 30 min) and App.jsx's loadProfile finishes it after Google; errors
show on "Almost there" (FinishSetup, which now also offers studying on your own and a parent account). Admin → Selling →
Google sign-in lists the Google Cloud and Supabase steps and checks Supabase live (`api.googleReady()`: /auth/v1/settings).
This changed the desktop shell (main.cjs, preload.cjs): one automatic reinstall. Same shell change: updater.cjs's check() keeps
'ready' when a downloaded version is still waiting (no more "up to date" while one waits). The "Students can sign up" switch is
gone from Admin → Students: sign-up opens only when a subject is opened to students (`students_paused` stays false).
One StudyBridge library (same update): everything StudyBridge makes comes from the content account (Claude Desktop, checked
twice). Admin's "StudyBridge papers" and "Shared question bank" pages are gone (PapersAdmin.jsx deleted; `sb_papers` and
`prof_bank(p_shared)` left in place, unused; tutors can't read old shared questions or sb_papers). Tutors get the content
account's approved questions for the exams set on their subjects (`bank_studybridge_read`, `_sb_library()`: active tutors; the
Plus-plan check goes there later; `content_add_questions` now sets `exam_code`/`exam_board` from `_subject_exam()`), shown as
"StudyBridge" in their bank, and its practice papers in Library → Past papers (`studybridge_papers(p_exam)`,
`copy_studybridge_paper` → a hidden draft test in the tutor's account, keeping the not-affiliated line). Rule kept: with a tutor a
person approves everything, so StudyBridge questions never go into a tutored learner's practice by themselves (`start_practice`
and `practice_topics` use only the tutor's own bank); the tutor uses them by putting them in work they post.

Launch 2 part 1 (22 Oct 2026, app 1.1.76; Aaryan: "start launch 2 with organisations and classes; go"), organisations and classes.
Every tutor is in one organisation (`organisations` kind tutor|centre|school|studybridge, `org_members` role manager|tutor, one each
for now; made by `_ensure_org` from the `profiles_org` trigger: their own is "<name>’s tutoring"; the content account's is StudyBridge's
own, where students on their own are). A learner is in their tutor's (`_org_of`). Settings → Your organisation (`my_org`): rename,
Make it a tuition centre (`org_make_centre`, an 8-digit `join_code`), Join a centre (`org_join`; wrong codes counted in `invite_tries`,
returns null), New code, Make manager/tutor (`org_set_role`, always one manager), Take out of the centre (`org_remove`), Leave the
centre (`org_leave`); `_org_tidy` drops an empty organisation and promotes a manager if none is left. A centre's managers get Centre
(`org_overview`, src/screens/tutor/Centre.jsx: every tutor and learner, read-only: subjects, classes, time this week, hand-ins; never
work, marks or messages). Nothing moves between tutors and each tutor still approves everything for their own learners. Admin → Tutors
shows each tutor's centre and classes. Classes (`classes`, `class_members`; changed only through `save_class`, `archive_class` ("Put
away"), `delete_class`): Learners → Classes tab (`/learners/classes`), a learner's classes on their card and page, invites with
`class_ids` (`_invite_classes` puts them in on accepting). Assignments, lessons, files, sessions and lesson_series have `class_id`:
`_class_audience` (BEFORE trigger) sets `learner_ids` to the class's members (work already started stays; past live lessons keep who
was there; an empty class gives `[class id]`, meaning nobody, never everyone) and `_class_sync` re-runs it when someone joins or leaves.
AudiencePicker has "A class" (`onChange(ids, classId)`); Live's form has "Who"; `create/change_lesson_series(..., p_class)`. Not yet:
a learner with a school and a tutor at once (still one tutor each), one bill for a centre.
Decided 22 Oct 2026 (Aaryan): next the new Home and shorter menu, then "option A": in centres and schools learners belong to the
organisation, a manager makes a class (name, subject, teacher(s), learners) and a teacher sees, marks and approves only the learners
in their classes; independent tutors work as now; this is also what lets a learner have a school and a private tutor at once.
Also agreed 22 Oct: "See it as your learner" (a tutor previews their own work, notes and a learner's Today as the learner sees it)
goes in the next build with the new Home. Screen gallery from the tests: https://claude.ai/artifact/UqRwAq1RiH36xQhjAaRSFt
The demo StudyBridge (22 Oct 2026, app 1.1.79; Aaryan: "go, build the demo"): Admin → Demo (src/screens/admin/Demo.jsx). `api.makeDemo` signs up
eight accounts on a side connection (`sideClient()` in supabase.js: never keeps a sign-in), emails demo-<who>-<tag>@gostudybridge.com
with passwords nobody keeps, then `admin_demo_build(p_accounts)` (admin only; brand-new demo addresses with no role) fills them in:
Riverside Tuition (demo), Grace Mwansa (manager) and Daniel Okafor (tutor), Chipo/Tendai/Amara/Kofi in Year 10 maths and Year 11 physics,
homework marked and back, a quiz to mark, notes, a weekly lesson, a Term 1 mock (grade B), messages, Ruth Banda (parent, approved report)
and Lina Haddad (test student). `profiles.demo`/`demo_label` fence them out of admin_overview, admin_tutors and admin_students. "Open as":
`admin_demo_open` sets a fresh password (demo accounts only), the side connection signs in and `switchToSession` (accounts.js) switches;
`DemoBar` in Shell.jsx says who you are with "Back to my account". `admin_demo_remove` deletes them (and half-made demo sign-ups).
The device's account list keeps 16 and never drops the admin account. The sweep never opens, makes or resets the demo.
Website fix (same day): in dark mode a later rule painted the early-access fields dark while their text stayed dark, and the open
dropdowns took dark colours inside a white box; the fix is a block at the end of website/site.css (`.early-box` fields always light,
`color-scheme: light`, option colours). Only "A student" is asked the age question (`#ea-age`), and the thank-you line fits the role.

Launch 2 builds 1–6 (22 Oct 2026, Aaryan: "build all go"; builds 1–3 = app 1.1.80, 4–6 = the next release).
1. New Home + 8-item menu + See it as your learner. Tutor menu: Home, Learners (tabs Learners/Classes/Reports; `/learners/reports`),
Assignments, Marking, Library (Subjects tab = `<Structure embedded />`; `/structure` goes there), Messages, Live, Prof, plus Centre for
managers. Home.jsx: Needs you, Today and this week (Join, Nudge = `nudge_assignment`, once per 12 h, `assignments.nudged_at`), Your learners
cards from `tutor_home()` (streak, last mark, mock, exam, plan). See it as: `/see/:learner/:tab` (SeeAs.jsx: Today, My work, Library, Study,
Progress); `AsLearnerCtx` in data.js prefixes query keys `as:<id>:` and api.js filters with `seenBy` (mirrors `can_learner_see`);
`AsLearnerApp` overrides `me`; links are rewritten and buttons blocked ("you can’t press things here"); logTime/markCommentsRead do
nothing while previewing. The demo is now 12 accounts: Grace (manager, doesn't teach), Mercy (maths), Daniel (physics), Joseph (biology),
six learners in three classes, Ruth (parent), Lina (test student).
2. Classes with teachers (option A): `class_teachers`; `_teaches(teacher, learner)`, `_my_teachers()`, `_can_view_learner`; a class teacher
sees, marks and posts to the learners in their classes even if another tutor in the centre is their main tutor (`can_learner_see` uses
`_my_teachers()`; profiles/subjects/topics/comments/storage policies follow). `save_class(..., p_teacher_ids)` (managers pick teachers
from `class_pool()`; new teachers are told "You teach X now"); class codes (`class_code`, learners `join_class` in Settings, also on
sign-up via accept_invite). Learners message any of their teachers (Messages picker; `my_teachers()`). `_audience` includes class learners.
3. Essentials and Plus: `profiles.level` (essentials|plus), 7-day Plus trial on approval (`_tutor_trial`), `paid_until`; `_plus(tutor)` is
true while plan limits are off, or for Plus paid/trial/complimentary/custom. Plus-only (`_plus_only` trigger and checks): Prof
(`_prof_ready`), StudyBridge's library (`_sb_library`), mocks, the exam camera. Admin → Tutors sets level/paid-up/free days
(`admin_set_level`); tutors "Ask for" a level (`ask_level`) while online payment is closed. Settings → Your plan shows both levels.
4. Watched mode: `assignments.watched` lets a lockdown/camera test run in any browser (full screen, every leave is a strike via
`lockdown_strike`); `attempts.client` records the device ("Done on a Chromebook (watched)"). Pausing: `pause_learner` sets
`profiles.paused_at`: work kept, no new work starts, not told about new work (`_audience`), not counted on the plan (`my_plan`
learners/paused, `_check_plan_room`). Closing the tab in watched mode isn't counted yet.
5. Change with Prof: "Change with Prof" on a question in the editor → `prof_revise(question, 'question'|'scheme', instruction)` (job kind
'revise', Prof's `stepRevise` + `save_question`), the assignment goes back to draft until the tutor checks it. Cheaper Prof: weekly
reports use `app_config.prof_small_model` (default claude-haiku-5-5, Admin → Prof).
6. Online checkout (ready, off until keys): tutors pay by card for Essentials/Plus monthly or yearly (Prof `checkout`, `body.level`,
Stripe price per unit with graduated tiers, keys `essentials_month|essentials_year|plus_month|plus_year`, quantity = active learners,
`automatic_tax` when Admin → Selling "Add tax" is on); the webhook (events with `metadata.level`) calls `_set_paid_level` (paid up to
the period end + 2 days; ended → `stripe_tutor_sub` null); `syncSeats()` on every kick updates the subscription quantity when
`_seats_due()` says the learner count changed (proration). Mobile money (Flutterwave v3): Prof `mobile_pay` → `_mobile_payment_new`
(tutors 1–12 months, 12 = 11 months' price; students monthly or pass; a parent with `p_for` = their child) → hosted page;
`prof?flutterwave=webhook` checks `verif-hash`, then asks Flutterwave (`/v3/transactions/<id>/verify`) and `_mobile_payment_done` counts it
only if the amount and currency are right, once. Prices live in `app_config.pricing` (same as site.config.json; website.test.mjs checks);
`public_settings` gives `card_prices`, `mobile_on`, `currencies`, `rates`. UI: Settings → Your plan (Pay by card / Mobile money per
level; "Ask for" only while both are closed), `MobileMoney.jsx`, student/parent `PayOptions`, Admin → Selling (Stripe steps, tax switch,
Flutterwave keys). (The old Starter/Pro learner caps went in "Ready to charge tutors", below.)
7. Signed apps: needs Aaryan's Apple Developer and a Windows code-signing account; not done.

Decided 23 Oct 2026 (Aaryan): classroom and running a school move up (they make StudyBridge complete for schools). Order:
1 Ready to charge tutors → 2 a learner with a school and a tutor at once → classroom (stream, classwork, rubrics, gradebook; then
school sign-in, class lists, exam-room view) → running a school (attendance, behaviour, timetable; then report cards, IB criteria,
planners) → IB core (CAS/EE/TOK/PP) → Chromebook extension. A learner in a school and with a tutor has ONE login ("easy, accessible
and simple but safe and private both ways"): one Today labelled by who set what, a wall between school and tutor (each sees only
what it set; the learner's own flashcards, streak and study time are theirs), sharing across the wall off unless the learner (or a
parent for young children) switches it on, and both the school and the tutor pay for that learner.
Ready to charge tutors (23 Oct 2026, build 1 of that order). No Free/Starter/Pro caps: `_bill(tutor)` says who pays (own, or the
centre when its `organisations.billing = 'centre'`, `_billing_org`) and the state: free (content account, Complimentary: any number),
trial (any number), card (Stripe subscription: any number, `syncSeats` keeps the quantity in step), paid (paid_until; places =
`paid_seats`, any number when null; old custom/starter/pro = paid by hand for plan_learners/5/25), unpaid (no new learners).
`_tutor_limit`, `_plus`, `_check_plan_room`, `pause_learner` (unpausing needs a place) and `my_plan` (state, seats, learners = the
payer's, own_learners, centre {id, name, manager}, own_card) use it; limits still apply only with `enforce_plans`. Mobile money:
`_mobile_payment_new(user, what, months, currency, for, seats)`: tutors choose learners to pay for (at least their active ones);
what 'seats' adds places for the whole months left (`age()`, a part month counts) at the next steps' price; kind 'centre' payments
(`mobile_payments.org_id`) go on the organisation. One bill for a centre: a manager's Settings → Your organisation → Who pays
(`org_set_billing(centre, level)`, a 7-day centre trial once; switching back needs the centre's card plan cancelled and gives unpaid
tutors a week, `_bill_grace`, also when a tutor leaves a paying centre via the `org_members_bill_grace` trigger); the centre has its
own level, paid_until, paid_seats, trial_until, stripe_customer/sub/seats; Prof `checkout`/`billing` use `_checkout_target` (only a
manager pays; metadata `org`), the webhook calls `_set_org_paid`, `_seats_due` lists centres too (`_org_seats_synced`). Admin →
Tutors → Plan & Prof: Pays per learner or Complimentary (old plans show only for tutors on them), Learners paid for
(`admin_set_seats`), and when the centre pays the fields change the centre (`admin_bill`, `admin_set_org_plan`). Watched mode: the
page calls `watch_seen` every 30 s (`attempts.seen_at`; tutors see "On the page now / Not on the page since …", `onPage` in Live.jsx);
`_watch_away()` (run by `_auto_hand_in` every minute) logs and tells the tutor once when a watched browser page is quiet for 2 minutes;
the open marker `sb.watched.<attempt>` is in localStorage now, so closing the tab counts as a try to leave when they come back.
Decided 23 Oct 2026 (Aaryan), for build 2: an unpaid tutor after the free week is "over": read-only (as the website's pricing FAQ
already promises: nothing deleted, they can see and download everything, pay to switch it all back); their learners see past work
only, like paused. A learner can have more than one private tutor (and a school), each walled off. Parents see everything about
their child from every side. Sharing across the wall: marks, mock grades, topic strengths and study time only, never answers, work
or messages. Students who joined StudyBridge on their own (self_learner) can't add a tutor or school.
Also decided 23 Oct: schools and centres have one price ($15 per learner a year, everything included, at least 30 learners =
$450 a year, yearly by invoice, a free pilot term); centres match schools, never tutor prices; the organisation always pays
(its tutors don't pay as well); StudyBridge sets each one up. Website and app must always match (memory: website-app-match).
The bigger build 2, "Schools and centres, part 1", ships as three updates: A one login, B school pricing, C classroom (the class
stream waits until it's been discussed).
Update A (23 Oct 2026, app 1.1.83), one login, many places. `learner_links` (learner, tutor, paused_at): a learner with a main tutor
(profiles.tutor_id, who still looks after the account, password, parents) who types another tutor's invite code gets a link
(accept_invite), and class codes from any school or centre add classes as before; self-learners are refused. A "place" is a
centre/school organisation or an independent tutor (`_place_of`, `_place_name`). `_teachers_of(learner)`, `_learners_of(tutor)`,
`_my_teachers()`, `_teaches`, `_is_linked` include links, so RLS (assignments, files, sessions, subjects, comments, cards, storage)
follows. The wall: `_sees_from(owner, learner)` (the learner, the owner, the same place, or a place in `learner_shares`) filters
learner_summary, learner_progress, study_summary, mock_history, org_overview (managers). Sharing: `set_share(place, on, learner)`
by the learner or a linked parent; `my_places(learner)` (also for parents). Pausing is per place (`_paused_for`: links.paused_at,
or the main tutor's place via profiles.paused_at); `pause_learner`/`_audience`/`start_attempt` use it. Each place pays
(`_active_learners`, `_org_learner_ids`); `_room_check` runs on main-tutor changes, new links and class joins. Unpaid after the
free week (enforce on): `_paid_guard` triggers make a tutor read-only; `start_attempt` starts nothing new from that place
(`_place_unpaid`); hourly `_bill_tick` (pg_cron studybridge-bills) tells the tutor/centre and each learner "<name>’s StudyBridge is
paused for now" once (and "back on"). remove_learner: a linked tutor just goes; the main tutor going hands the account to the
oldest link. Parents see every place (`parent_view` with `from` and `places`, `parent_children`, `_parent_link` no longer tied to
one tutor); weekly reports come from the main tutor and every linked tutor (`_refresh_reports`). UI: Settings → Your schools and
tutors (YourPlaces, replaces Join a class: list, Leave, Sharing, Add with a code), parents' Your children → Sharing, `places.jsx`
(usePlaces, FromPlace labels on My work, PausedPlaces on Today), Learners shows added learners as "Your learner" (no Account or
Parents for them), Shell's ReadOnlyBar. Fixed on the way: the storage rules at the end of setup.sql had reset the class-teacher
versions (files and work photos of class teachers who aren't the main tutor). Not yet: practice for a linked tutor's subjects
uses the main tutor's question bank.
Update B (24 Oct 2026, app 1.1.84), school and centre pricing, the same on the website and in the app. site.config.json
`schoolPlan` {perLearnerYear 15, minLearners 30} = `app_config.pricing.school` {year, min} (website.test.mjs checks); website:
pricing.html Schools tab ($15 per learner a year, at least 30 = $450, one bill a year by invoice, a free pilot term) and FAQ "How do
schools and tuition centres pay?", schools.html ("What you get", the price, a link to pricing), tokens schoolYear/schoolMin/
schoolMinYear in build-website.mjs; `earlyAccessPayment` now "For now, we arrange payment with you directly." A centre or school
always pays for everyone in it (`billing = 'centre'`, level plus; `org_make_centre` sets that and a 7-day free week); the "Who pays"
switch (`org_set_billing`) and `admin_set_org_plan` are gone; card checkout (Prof) and mobile money refuse centres ("pays yearly by
invoice"). Managers: Settings → Your plan → CentrePlan (price, status, places meter, "Ask for an invoice" → `org_ask_invoice(learners,
note)`: admin notification with ref org_id → Admin's /schools, and an email to hello@ with reply-to the manager; `invoice_asked_at`);
tutors in it see who pays. Admin → Schools and centres (Schools.jsx): `admin_orgs()` (manager, teachers, learners, state, paid up to,
places, pilot, invoice asked; demo excluded) and Set up → `admin_set_school_plan(org, paid_until, seats, pilot_days, kind)` (centre or
school, notifies managers), with a note when it has fewer than 3 teachers (the school price is for several teachers).
`_school_year_usd(n)`. Plan & Prof for a tutor whose centre pays links to Schools and centres. Also fixed: time studied (`log_time`) now
counts for whoever set the item, not always the main tutor (the wall needs it), and Settings refreshes Your plan after centre changes.
Update C (24 Oct 2026), classroom part 1 (no class stream yet: Aaryan wants to discuss it first). Each class has a page,
Learners → Classes → its name (`/learners/classes/:id/:tab`, src/screens/tutor/ClassPage.jsx), for its teachers only
(`_class_teacher`: the class's tutor or a class teacher; a manager who doesn't teach it sees the Centre page, never marks). Tabs:
Classwork (`class_work(class)`: assignments, lesson notes and files set for the class by any of its teachers, grouped by topic, with
posted/draft/hidden/scheduled and hand-ins; "Set work for <class>" opens the editor with `?class=`), Gradebook (`class_gradebook(class)`: each
learner × each posted assignment, latest try, released or not, late; class average; Download (spreadsheet) = CSV) and People (members,
"Add a class list": one name per line → `class_invites(class, names)`, up to 200, an 8-digit invite code each that puts them in the
class; Copy all and Print). Rubrics: `rubrics` (tutor_id, title, criteria jsonb [{name, levels [{label, points, text}]}], 1–12
criteria, 2–6 levels, checked by `_rubric_ok`; read-only when unpaid via `_paid_guard`), the teacher's own; learners read a rubric
used by a question they can see. `questions.rubric_id` (`_question_rubric`: only your own rubric), `responses.rubric` ({criterion
index: level index}). src/screens/shared/Rubric.jsx: RubricPicker in the question editor ("Mark with a rubric", "New rubric…" opens
RubricEditor; the question becomes worth the rubric's top marks, `_rubric_max`), RubricGrid in Marking (picking levels sets the mark,
`rubricMark`) and on the learner's results once marks are back (`attempt_detail` gives `rubrics` and each response's `rubric` only
when released).

## 2.0 (agreed 7 Oct 2026, not built; full plan in docs/MASTER.md "2.0 plan")
- Aaryan is the Owner and decides everything, including who gets Admin/Reviewer access. He is Owner, Admin and
  Reviewer until he adds a team.
- Self-learners (no tutor): StudyBridge's own content goes out after automatic checks with a report button; reports
  go to the Owner. Learners with a tutor, centre or school keep the strict rule: a person approves everything.
- Practice papers are original (same format as the real paper, never copied or reworded) and say "not affiliated with
  or endorsed by" the board. Aaryan said on 7 Oct that his lawyer OK'd copying IB papers question by question; Claude
  declined (copyright, and it breaks the rule above). Don't copy or reword real exam papers.
- Payment only on the website. The Claude Desktop connector is Owner-only (content on his subscription); removed for
  tutors on 9 Oct 2026 (connector 1.2.0).
- Vision (8 Oct 2026): one whole education platform (what ManageBac + Canvas + Google Classroom give, plus lockdown).
- Order (8 Oct 2026, replaces the 7 Oct order): **launch 1 = self-learners** (web and phone; they sit in StudyBridge's own
  organisation; every subject, IGCSE/A-Level/IB, switching on one by one as its content is ready), then **launch 2 = tutors**
  (organisations and classes, new Home + shorter menu, Essentials/Plus, watched mode, signed apps), then online checkout
  (Stripe + mobile money via Flutterwave/DPO), then classroom, school running, reach. Until checkout, Aaryan takes payment
  himself and sets plans in Admin (Custom/Complimentary); tutors stay in free early access with a 7-day trial.
- Prices (8 Oct 2026) live in website/site.config.json: `tutorLevels` (per learner, graduated: Essentials $5/$4/$3, Plus
  $8/$6/$4 since 10 Oct, with unlimited Prof, mocks with grades, exam camera, StudyBridge content), `yearlyMonthsFree` 1,
  `trialDays` 7, `selfLearner` ($11 a month, or an exam pass at $9 a month paid once until the exams). No discounts; one US price shown
  (and later charged) in local currency. Parents and a tutor's learners are free. test/website.test.mjs checks the app's
  Settings says the same. Prof has no limit on Plus (Admin gets an alert, nothing stops); "change this part" should redo
  only that part.
- Reports on StudyBridge's own content (9 Oct 2026): the item stays up and the Owner gets an alert; nothing hides
  itself (hiding could make a student think it was fixed). Students pay by Stripe or straight to Aaryan for now; he
  records it in Admin → Students.
- Students never chat with AI: self-learners get hints and worked solutions written ahead and checked. The website must
  not promise "Prof as your guide" (a website test checks).
- Plans live in three Claude Docs: launch priorities https://claude.ai/code/artifact/75865270-1c1c-453a-8eda-128170b852bd,
  price sheet https://claude.ai/code/artifact/43264c30-63b7-4a77-93fa-66ef9bfb8cd7, features by user
  https://claude.ai/code/artifact/bbc39170-31c0-49c6-90d8-4aff29d32ced. Nothing is built until Aaryan says "build" or "go".

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
- Website/landing page: built in part 5; on GitHub Pages until Aaryan gives a domain. He plans to rename StudyBridge
  (6 Oct 2026): keep the name in one place where possible (website/site.config.json for the site).
- Prices raised slightly (6 Oct 2026): Starter $15, Pro $29; yearly = 2 months free; parents free; "free now, paid soon".
- The repo `aaryanc-1/studybridge` is publicly readable (it was thought to be private). Raise it with Aaryan
  before selling; private repos get limited Actions minutes and the Mac builds use them fastest.
