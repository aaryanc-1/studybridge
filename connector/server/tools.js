// StudyBridge for Claude: the tutor's Claude Desktop connects to their StudyBridge.
// Claude can read learners, progress, submissions and library PDFs, and it can
// DRAFT assignments, marking, lessons and messages. Drafts wait in StudyBridge
// ("From Claude") until the tutor approves them; nothing reaches a learner directly.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const VERSION = '1.0.0';

const text = (s) => ({ type: 'text', text: s });
const json = (o) => text(JSON.stringify(o, null, 2));
const TYPES = ['mcq', 'numeric', 'short', 'steps', 'upload', 'drawing'];

export function createStudyBridgeServer(cfg) {
  let client = null;
  let me = null;

  async function db() {
    if (client && me) return client;
    if (!cfg.url || !cfg.key || !cfg.email || !cfg.password) {
      throw new Error('StudyBridge isn’t set up in Claude yet. Open Claude Desktop → Settings → Extensions → StudyBridge and fill in the server URL, anon key, email and password (all shown in StudyBridge → Settings → Claude).');
    }
    client = createClient(cfg.url.replace(/\/+$/, ''), cfg.key, { auth: { persistSession: false, autoRefreshToken: true } });
    const { data, error } = await client.auth.signInWithPassword({ email: cfg.email, password: cfg.password });
    if (error) {
      client = null;
      throw new Error(`Couldn’t sign in to StudyBridge: ${error.message}. Check the email and password in the connector settings.`);
    }
    const p = await client.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
    if (p.data?.role !== 'tutor') {
      client = null;
      throw new Error('This StudyBridge account isn’t a tutor account. The connector is for the tutor only.');
    }
    me = p.data;
    return client;
  }
  async function q(p) {
    const { data, error } = await p;
    if (error) throw new Error(error.message);
    return data;
  }

  // ---------- lookups by name or id ----------
  // "maths" finds "Mathematics (Extended)", "phys" finds "Physics"
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function pick(list, ref, key) {
    const r = norm(ref);
    return (
      list.find((x) => x.id === ref) ||
      list.find((x) => norm(x[key]) === r) ||
      list.find((x) => norm(x[key]).includes(r)) ||
      list.find((x) => r.includes(norm(x[key])) && norm(x[key]).length > 2) ||
      (r.length >= 4 ? list.find((x) => norm(x[key]).startsWith(r.slice(0, 4))) : null)
    );
  }
  const isId = (s) => /^[0-9a-f-]{36}$/i.test(String(s || ''));
  async function learners() {
    const c = await db();
    return q(c.from('profiles').select('id,display_name,email,programme_id,timezone').eq('role', 'learner').order('display_name'));
  }
  async function findLearner(ref) {
    const all = await learners();
    if (!ref) {
      if (all.length === 1) return all[0];
      throw new Error(`Which learner? You have: ${all.map((l) => l.display_name).join(', ') || 'no learners yet'}.`);
    }
    const hit = pick(all, ref, 'display_name');
    if (!hit) throw new Error(`No learner called “${ref}”. Learners: ${all.map((l) => l.display_name).join(', ')}.`);
    return hit;
  }
  async function structure() {
    const c = await db();
    const [programmes, subjects, topics] = await Promise.all([q(c.from('programmes').select('id,name')), q(c.from('subjects').select('id,name,programme_id')), q(c.from('topics').select('id,name,subject_id'))]);
    return { programmes, subjects, topics };
  }
  async function findSubject(ref) {
    if (!ref) return null;
    const { subjects } = await structure();
    const hit = pick(subjects, ref, 'name');
    if (!hit) throw new Error(`No subject called “${ref}”. Subjects: ${subjects.map((s) => s.name).join(', ')}.`);
    return hit;
  }
  async function findTopic(ref, subjectId) {
    if (!ref) return null;
    const { topics } = await structure();
    const pool = subjectId ? topics.filter((t) => t.subject_id === subjectId) : topics;
    const hit = pick(pool, ref, 'name');
    return hit || null;
  }
  async function findAssignment(ref) {
    const c = await db();
    const all = await q(c.from('assignments').select('*').order('created_at', { ascending: false }));
    const hit = all.find((a) => a.id === ref) || all.find((a) => a.title.toLowerCase() === String(ref).toLowerCase()) || all.find((a) => a.title.toLowerCase().includes(String(ref).toLowerCase()));
    if (!hit) throw new Error(`No assignment matching “${ref}”.`);
    return hit;
  }
  async function findFile(ref) {
    const c = await db();
    const all = await q(c.from('files').select('*'));
    const hit = all.find((f) => f.id === ref) || all.find((f) => f.name.toLowerCase() === String(ref).toLowerCase()) || all.find((f) => f.name.toLowerCase().includes(String(ref).toLowerCase()));
    if (!hit) throw new Error(`No file matching “${ref}”. Files: ${all.map((f) => f.name).join(', ')}.`);
    return hit;
  }

  const server = new McpServer({ name: 'studybridge', version: VERSION });
  const tool = (name, description, shape, fn, readOnly = true) =>
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } }, async (args) => {
      try {
        const out = await fn(args || {});
        return { content: out?.__content ? out.__content : [typeof out === 'string' ? text(out) : json(out)] };
      } catch (e) {
        return { isError: true, content: [text(e.message || String(e))] };
      }
    });

  // ---------------- reading ----------------
  tool('overview', 'Start here. The tutor’s StudyBridge at a glance: learners, work waiting to be marked, unread notes from learners, and what’s due soon.', {}, async () => {
    const c = await db();
    const [ls, attempts, assignments, comments, drafts] = await Promise.all([
      learners(),
      q(c.from('attempts').select('id,assignment_id,learner_id,status,submitted_at,score,max_score,released').order('started_at', { ascending: false }).limit(200)),
      q(c.from('assignments').select('id,title,kind,due_at,draft,visibility')),
      q(c.from('comments').select('id,learner_id,author_id,body,assignment_id,created_at,read_at').order('created_at', { ascending: false }).limit(100)),
      q(c.from('claude_drafts').select('id,kind').eq('status', 'pending')),
    ]);
    const name = (id) => ls.find((l) => l.id === id)?.display_name || 'former learner';
    const title = (id) => assignments.find((a) => a.id === id)?.title;
    return {
      tutor: me.display_name,
      learners: ls.map((l) => ({ id: l.id, name: l.display_name, timezone: l.timezone })),
      waiting_to_mark: attempts.filter((t) => t.status === 'submitted').map((t) => ({ attempt_id: t.id, learner: name(t.learner_id), assignment: title(t.assignment_id), submitted_at: t.submitted_at })),
      unread_notes_from_learners: comments.filter((x) => x.author_id !== me.id && !x.read_at).map((x) => ({ learner: name(x.learner_id), about: title(x.assignment_id) || null, note: x.body, at: x.created_at })),
      due_soon: assignments.filter((a) => !a.draft && a.due_at && new Date(a.due_at) > new Date() && new Date(a.due_at) < new Date(Date.now() + 8 * 86400000)).map((a) => ({ title: a.title, kind: a.kind, due_at: a.due_at })),
      drafts_waiting_for_tutor_approval: drafts.length + assignments.filter((a) => a.draft).length,
    };
  });

  tool('list_subjects', 'Programmes, subjects and topics the tutor has set up (use these names when creating work).', {}, structure);

  tool(
    'learner_progress',
    'A learner’s progress: strength per topic (strong / developing / weak), time studied, recent mistakes, and a summary for this week and this month.',
    { learner: z.string().optional().describe('Learner name or id (optional if there is only one learner)') },
    async ({ learner }) => {
      const c = await db();
      const l = await findLearner(learner);
      const now = new Date();
      const day = (now.getDay() + 6) % 7;
      const wk = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
      const mo = new Date(now.getFullYear(), now.getMonth(), 1);
      const [progress, week, month] = await Promise.all([
        q(c.rpc('learner_progress', { p_learner: l.id })),
        q(c.rpc('learner_summary', { p_learner: l.id, p_from: wk.toISOString(), p_to: new Date(wk.getTime() + 7 * 86400000).toISOString() })),
        q(c.rpc('learner_summary', { p_learner: l.id, p_from: mo.toISOString(), p_to: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString() })),
      ]);
      return { learner: l.display_name, progress, this_week: week, this_month: month };
    },
  );

  tool(
    'list_assignments',
    'List assignments (homework, quizzes, tests, exams) with how many learners have submitted.',
    { include_drafts: z.boolean().optional() },
    async ({ include_drafts }) => {
      const c = await db();
      const [as, attempts] = await Promise.all([q(c.from('assignments').select('*').order('created_at', { ascending: false })), q(c.from('attempts').select('assignment_id,status,learner_id'))]);
      return as
        .filter((a) => include_drafts || !a.draft)
        .map((a) => ({
          id: a.id,
          title: a.title,
          kind: a.kind,
          draft: a.draft,
          visibility: a.visibility,
          due_at: a.due_at,
          lockdown: a.lockdown,
          camera: a.camera,
          submitted: attempts.filter((t) => t.assignment_id === a.id && t.status !== 'in_progress').length,
          to_mark: attempts.filter((t) => t.assignment_id === a.id && t.status === 'submitted').length,
        }));
    },
  );

  tool('get_assignment', 'Read one assignment with its questions, answers and mark schemes.', { assignment: z.string().describe('Title or id') }, async ({ assignment }) => {
    const c = await db();
    const a = await findAssignment(assignment);
    const qs = await q(c.from('questions').select('*').eq('assignment_id', a.id).order('position'));
    const keys = qs.length ? await q(c.from('question_keys').select('*').in('question_id', qs.map((x) => x.id))) : [];
    return {
      ...a,
      questions: qs.map((x, i) => ({ number: i + 1, id: x.id, type: x.type, prompt: x.prompt_md, options: x.options, marks: Number(x.marks), key: keys.find((k) => k.question_id === x.id) || null })),
    };
  });

  tool(
    'list_submissions',
    'Submitted work. By default only work waiting to be marked.',
    { status: z.enum(['submitted', 'marked', 'returned', 'in_progress', 'all']).optional(), learner: z.string().optional() },
    async ({ status = 'submitted', learner }) => {
      const c = await db();
      const ls = await learners();
      const l = learner ? await findLearner(learner) : null;
      let query = c.from('attempts').select('*').order('submitted_at', { ascending: false }).limit(100);
      if (status !== 'all') query = query.eq('status', status);
      if (l) query = query.eq('learner_id', l.id);
      const [ts, as] = await Promise.all([q(query), q(c.from('assignments').select('id,title,kind,due_at'))]);
      return ts.map((t) => {
        const a = as.find((x) => x.id === t.assignment_id);
        return { attempt_id: t.id, learner: ls.find((x) => x.id === t.learner_id)?.display_name, assignment: a?.title, kind: a?.kind, status: t.status, submitted_at: t.submitted_at, late: !!(a?.due_at && t.submitted_at && t.submitted_at > a.due_at), score: t.score, max_score: t.max_score, time_spent_min: Math.round(t.time_spent_sec / 60), lockdown_alerts: (t.lockdown_events || []).length };
      });
    },
  );

  tool(
    'get_submission',
    'Everything needed to mark one submission: each question, the mark scheme, the learner’s answer (maths working as LaTeX lines, text, choices) and photos/drawings of their work as images, plus any notes they left.',
    { attempt_id: z.string().describe('From list_submissions') },
    async ({ attempt_id }) => {
      const c = await db();
      const d = await q(c.rpc('attempt_detail', { p_attempt: attempt_id }));
      const a = (await q(c.from('assignments').select('*').eq('id', d.attempt.assignment_id)))[0];
      const qs = await q(c.from('questions').select('*').eq('assignment_id', a.id).order('position'));
      const l = (await learners()).find((x) => x.id === d.attempt.learner_id);
      const notes = await q(c.from('comments').select('body,author_id,question_id,created_at').eq('learner_id', d.attempt.learner_id).eq('assignment_id', a.id));
      const out = [];
      const summary = {
        attempt_id,
        learner: l?.display_name,
        assignment: a.title,
        kind: a.kind,
        status: d.attempt.status,
        submitted_at: d.attempt.submitted_at,
        time_spent_min: Math.round(d.attempt.time_spent_sec / 60),
        lockdown_alerts: d.attempt.lockdown_events,
        questions: [],
      };
      const images = [];
      for (const [i, x] of qs.entries()) {
        const r = d.responses.find((y) => y.question_id === x.id) || {};
        const k = (d.keys || []).find((y) => y.question_id === x.id);
        const ans = r.answer || {};
        summary.questions.push({
          number: i + 1,
          question_id: x.id,
          type: x.type,
          prompt: x.prompt_md,
          options: x.type === 'mcq' ? x.options : undefined,
          max_marks: Number(x.marks),
          answer_key: k?.answer,
          mark_scheme: k?.mark_scheme_md,
          model_solution: k?.solution_md,
          learner_answer:
            x.type === 'steps' ? { working_lines_latex: (ans.steps || []).filter(Boolean) } : x.type === 'drawing' ? { drawing: ans.strokes?.length ? `${ans.strokes.length} pen strokes (shown in StudyBridge)` : 'nothing drawn' } : ans,
          auto_marks: r.auto_marks,
          current_marks: r.marks,
          learner_notes: notes.filter((n) => n.question_id === x.id && n.author_id === d.attempt.learner_id).map((n) => n.body),
        });
        for (const f of ans.files || []) images.push({ n: i + 1, path: f.path });
      }
      out.push(json(summary));
      for (const im of images.slice(0, 8)) {
        const { data, error } = await c.storage.from('work').download(im.path);
        if (error || !data) continue;
        const buf = Buffer.from(await data.arrayBuffer());
        if (buf.length > 4.5 * 1024 * 1024) continue;
        out.push(text(`Photo of the learner’s work for question ${im.n}:`));
        out.push({ type: 'image', data: buf.toString('base64'), mimeType: data.type || 'image/jpeg' });
      }
      return { __content: out };
    },
  );

  tool('list_library', 'Files (PDFs, textbooks, worksheets) and lessons in the tutor’s library.', {}, async () => {
    const c = await db();
    const [files, lessons] = await Promise.all([q(c.from('files').select('id,name,mime,size,subject_id,visibility,description')), q(c.from('lessons').select('id,title,subject_id,visibility'))]);
    return { files, lessons };
  });

  tool(
    'read_pdf',
    'Read the text of a PDF in the library (for example a textbook chapter) so you can base questions on it.',
    { file: z.string().describe('File name or id'), from_page: z.number().int().min(1).optional(), to_page: z.number().int().min(1).optional() },
    async ({ file, from_page = 1, to_page }) => {
      const c = await db();
      const f = await findFile(file);
      const { data, error } = await c.storage.from('library').download(f.storage_path);
      if (error) throw new Error('Couldn’t download that file.');
      const { getDocumentProxy, extractText } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(await data.arrayBuffer()));
      const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });
      const end = Math.min(totalPages, to_page || from_page + 19);
      const parts = [];
      for (let p = from_page; p <= end; p++) parts.push(`--- page ${p} ---\n${pages[p - 1] || ''}`);
      return `${f.name}: ${totalPages} pages. Showing ${from_page}–${end}.\n\n${parts.join('\n\n')}`.slice(0, 200000);
    },
  );

  tool('list_notes', 'Notes and messages between the tutor and a learner.', { learner: z.string().optional(), unread_only: z.boolean().optional() }, async ({ learner, unread_only }) => {
    const c = await db();
    const ls = await learners();
    let query = c.from('comments').select('*').order('created_at', { ascending: false }).limit(100);
    if (learner) query = query.eq('learner_id', (await findLearner(learner)).id);
    const rows = await q(query);
    return rows
      .filter((x) => !unread_only || (!x.read_at && x.author_id !== me.id))
      .map((x) => ({ from: x.author_id === me.id ? 'tutor' : ls.find((l) => l.id === x.learner_id)?.display_name, to_learner: ls.find((l) => l.id === x.learner_id)?.display_name, body: x.body, assignment_id: x.assignment_id, at: x.created_at, read: !!x.read_at }));
  });

  // ---------------- drafting (tutor approves in StudyBridge) ----------------
  const QuestionIn = z.object({
    type: z.enum(TYPES).describe('mcq = multiple choice; numeric = one number; steps = maths working line by line; short = written answer; upload = photo of work on paper; drawing = drawn on screen'),
    prompt: z.string().describe('Question text in Markdown. Put maths in $...$ (LaTeX), display maths in $$...$$.'),
    marks: z.number().min(0).optional(),
    options: z.array(z.string()).optional().describe('mcq only: the options'),
    correct: z.array(z.number().int().min(0)).optional().describe('mcq only: zero-based index(es) of the correct option(s)'),
    answer: z.string().optional().describe('numeric: the correct number; short: a model answer; steps: the final line in LaTeX, e.g. "x = 4"'),
    tolerance: z.number().optional().describe('numeric only: allowed margin'),
    unit: z.string().optional().describe('numeric only: unit shown to the learner'),
    solution: z.string().optional().describe('Worked solution (Markdown + LaTeX), shown to the learner after marking if the tutor allows'),
    mark_scheme: z.string().optional().describe('Mark scheme for the tutor, e.g. "M1 subtract 3, A1 x = 4"'),
    topic: z.string().optional().describe('Topic name, if different from the assignment’s'),
  });

  tool(
    'create_assignment_draft',
    'Draft a homework, quiz, test or exam with questions and answers. It is saved as a DRAFT in StudyBridge: the tutor reviews it under “From Claude” and approves it before learners can see it.',
    {
      title: z.string(),
      kind: z.enum(['homework', 'quiz', 'test', 'exam']).optional(),
      subject: z.string().optional().describe('Subject name (see list_subjects)'),
      topic: z.string().optional(),
      instructions: z.string().optional(),
      due_at: z.string().optional().describe('ISO date-time'),
      learners: z.array(z.string()).optional().describe('Only for these learners (names). Default: everyone taking the subject.'),
      time_limit_min: z.number().int().positive().optional(),
      lockdown: z.boolean().optional(),
      camera: z.boolean().optional(),
      questions: z.array(QuestionIn).min(1),
    },
    async (a) => {
      const c = await db();
      const kind = a.kind || 'homework';
      const subject = await findSubject(a.subject);
      const topic = await findTopic(a.topic, subject?.id);
      const learnerIds = a.learners?.length ? await Promise.all(a.learners.map(async (n) => (await findLearner(n)).id)) : null;
      const defaults = {
        homework: { lockdown: false, camera: false, time_limit_min: null, release_mode: 'manual', allow_notes: true },
        quiz: { lockdown: false, camera: false, time_limit_min: 15, release_mode: 'on_submit', show_answers: true, allow_notes: true },
        test: { lockdown: true, camera: false, time_limit_min: 45, release_mode: 'manual', allow_notes: false },
        exam: { lockdown: true, camera: true, time_limit_min: 90, release_mode: 'manual', allow_notes: false },
      }[kind];
      const row = {
        ...defaults,
        kind,
        title: a.title,
        instructions_md: a.instructions || '',
        subject_id: subject?.id || null,
        topic_id: topic?.id || null,
        due_at: a.due_at || null,
        learner_ids: learnerIds,
        visibility: 'visible',
        draft: true,
        source: 'claude',
        ...(a.time_limit_min !== undefined ? { time_limit_min: a.time_limit_min } : {}),
        ...(a.lockdown !== undefined ? { lockdown: a.lockdown } : {}),
        ...(a.camera !== undefined ? { camera: a.camera } : {}),
      };
      const saved = (await q(c.from('assignments').insert(row).select()))[0];
      for (const [i, x] of a.questions.entries()) {
        const t = x.topic ? await findTopic(x.topic, subject?.id) : null;
        const multi = x.type === 'mcq' && (x.correct || []).length > 1;
        const qrow = (
          await q(
            c
              .from('questions')
              .insert({
                assignment_id: saved.id,
                position: i,
                type: x.type,
                prompt_md: x.prompt,
                options: x.type === 'mcq' ? (multi ? { items: x.options || [], multi: true } : x.options || []) : [],
                marks: x.marks ?? (x.type === 'steps' ? 3 : x.type === 'upload' || x.type === 'drawing' ? 4 : 1),
                topic_id: t?.id || null,
              })
              .select(),
          )
        )[0];
        let answer = {};
        if (x.type === 'mcq') answer = multi ? { choices: (x.correct || []).map(String) } : { choice: String((x.correct || [0])[0]) };
        else if (x.type === 'numeric') answer = { value: String(x.answer ?? ''), tolerance: String(x.tolerance ?? 0), ...(x.unit ? { unit: x.unit } : {}) };
        else if (x.type === 'steps' && x.answer) answer = { final: x.answer };
        else if (x.type === 'short' && x.answer) answer = { text: x.answer };
        await q(c.from('question_keys').insert({ question_id: qrow.id, answer, solution_md: x.solution || null, mark_scheme_md: x.mark_scheme || null }));
      }
      return `Draft saved: “${a.title}” (${kind}, ${a.questions.length} questions). It’s waiting in StudyBridge → From Claude for the tutor to review and approve. Learners can’t see it yet.`;
    },
    false,
  );

  tool(
    'draft_marking',
    'Suggest marks and feedback for a submission. Saved as a draft: the tutor checks it under “From Claude”, can edit it, and then returns the marks. Explain what was wrong clearly (maths in $...$).',
    {
      attempt_id: z.string(),
      summary: z.string().optional().describe('One or two lines for the tutor'),
      overall_feedback: z.string().optional().describe('Feedback to the learner (Markdown + LaTeX)'),
      questions: z.array(
        z.object({
          number: z.number().int().min(1).describe('Question number from get_submission'),
          marks: z.number().min(0),
          feedback: z.string().optional().describe('What was right or wrong, and how to fix it'),
          mistake: z.string().optional().describe('Short label for the mistake, e.g. "Sign error expanding brackets"'),
          redo: z.boolean().optional().describe('Ask the learner to redo this question'),
          correct_steps: z.array(z.boolean()).optional().describe('steps questions: true/false for each working line'),
        }),
      ),
    },
    async ({ attempt_id, summary, overall_feedback, questions }) => {
      const c = await db();
      const t = (await q(c.from('attempts').select('*').eq('id', attempt_id)))[0];
      if (!t) throw new Error('No submission with that id.');
      const qs = await q(c.from('questions').select('id,marks').eq('assignment_id', t.assignment_id).order('position'));
      const marks = questions.map((x) => {
        const qq = qs[x.number - 1];
        if (!qq) throw new Error(`There is no question ${x.number}.`);
        return {
          question_id: qq.id,
          marks: Math.min(Number(qq.marks), x.marks),
          ...(x.feedback ? { feedback_md: x.feedback } : {}),
          ...(x.mistake ? { mistake: x.mistake } : {}),
          ...(x.redo ? { redo: true } : {}),
          ...(x.correct_steps ? { step_marks: x.correct_steps.map((ok) => ({ ok })) } : {}),
        };
      });
      await q(c.from('claude_drafts').insert({ kind: 'marking', learner_id: t.learner_id, attempt_id, summary: summary || null, payload: { marks, ...(overall_feedback ? { feedback_md: overall_feedback } : {}) } }));
      return 'Suggested marking saved. The tutor reviews it in StudyBridge → From Claude, then returns the marks to the learner.';
    },
    false,
  );

  tool(
    'draft_message',
    'Draft a message to a learner (for example encouragement or what to revise). The tutor approves and sends it from StudyBridge.',
    { learner: z.string().optional(), message: z.string() },
    async ({ learner, message }) => {
      const c = await db();
      const l = await findLearner(learner);
      await q(c.from('claude_drafts').insert({ kind: 'message', learner_id: l.id, payload: { body: message } }));
      return `Message to ${l.display_name} drafted. The tutor sends it from StudyBridge → From Claude.`;
    },
    false,
  );

  tool(
    'create_lesson',
    'Write a lesson (notes, worked examples, practice) into the tutor’s library. It is created HIDDEN; the tutor makes it visible when happy.',
    { title: z.string(), body: z.string().describe('Markdown; maths in $...$ and $$...$$'), subject: z.string().optional(), topic: z.string().optional() },
    async ({ title, body, subject, topic }) => {
      const c = await db();
      const s = await findSubject(subject);
      const t = await findTopic(topic, s?.id);
      await q(c.from('lessons').insert({ title, body_md: body, subject_id: s?.id || null, topic_id: t?.id || null, visibility: 'hidden' }));
      return `Lesson “${title}” saved (hidden). The tutor can check it in StudyBridge → Library → Lessons and make it visible.`;
    },
    false,
  );

  server.registerPrompt('mark_latest', { description: 'Mark everything waiting in StudyBridge' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Using StudyBridge, look at the submissions waiting to be marked. For each one, read it carefully, then draft marks with clear explanations of any mistakes, and flag questions worth a redo.' } }],
  }));
  server.registerPrompt('weekly_report', { description: 'Weekly report on a learner' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Using StudyBridge, write me a short weekly report on each learner: time studied, work handed in, scores, strengths, topics that need work, and what to set next.' } }],
  }));

  return server;
}
