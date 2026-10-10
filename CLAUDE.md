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
- `npm test` — PGlite runs the real setup.sql (`test/db.test.mjs`), fake Supabase/Claude/Stripe/Resend, Prof, website (78)
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
  $9/$7/$5 with unlimited Prof, mocks with grades, exam camera, StudyBridge content), `yearlyMonthsFree` 1, `trialDays` 7,
  `selfLearner` ($12 a month, or an exam pass at $10 a month paid once until the exams). No discounts; one US price shown
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
