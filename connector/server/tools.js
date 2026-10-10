// StudyBridge for Claude: the Owner's Claude Desktop makes StudyBridge's own content for students studying on their
// own (on the Owner's subscription). It signs in only as StudyBridge's content account; tutors use Prof inside
// StudyBridge. Every question is checked a second time, in a new chat that never sees the answer, before students see
// it; anything that disagrees waits for the Owner in Admin → Content.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const VERSION = '1.2.0';

const text = (s) => ({ type: 'text', text: s });
const json = (o) => text(JSON.stringify(o, null, 2));
const TYPES = ['mcq', 'numeric', 'short', 'steps', 'upload', 'drawing'];

export function createStudyBridgeServer(cfg) {
  let client = null;
  let me = null;

  async function db() {
    if (client && me) return client;
    if (!cfg.url || !cfg.key || !cfg.email || !cfg.password) {
      throw new Error('StudyBridge isn’t set up in Claude yet. Open Claude Desktop → Settings → Extensions → StudyBridge and fill in the server URL, anon key, and the content account’s email and password (shown in StudyBridge → Settings → Claude Desktop on that account).');
    }
    client = createClient(cfg.url.replace(/\/+$/, ''), cfg.key, { auth: { persistSession: false, autoRefreshToken: true } });
    const { data, error } = await client.auth.signInWithPassword({ email: cfg.email, password: cfg.password });
    if (error) {
      client = null;
      throw new Error(`Couldn’t sign in to StudyBridge: ${error.message}. Check the email and password in the connector settings.`);
    }
    const p = await client.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
    if (p.data?.role !== 'tutor' || !p.data?.is_studybridge) {
      client = null;
      throw new Error('This connector is only for StudyBridge’s own content account. Tutors use Prof inside StudyBridge.');
    }
    me = p.data;
    return client;
  }
  async function q(p) {
    const { data, error } = await p;
    if (error) throw new Error(error.message);
    return data;
  }
  // "maths" finds "Mathematics", "0607" finds the subject with that code
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  async function findFile(ref) {
    const c = await db();
    const all = await q(c.from('files').select('*'));
    const hit = all.find((f) => f.id === ref) || all.find((f) => f.name.toLowerCase() === String(ref).toLowerCase()) || all.find((f) => f.name.toLowerCase().includes(String(ref).toLowerCase()));
    if (!hit) throw new Error(`No file matching “${ref}”. Files: ${all.map((f) => f.name).join(', ') || 'none yet'}.`);
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

  // ---------------- the content account's library (for example a syllabus PDF to set the topics from) ----------------
  tool('list_library', 'Files (PDFs, for example a syllabus) and lessons in the content account’s library.', {}, async () => {
    const c = await db();
    const [files, lessons] = await Promise.all([q(c.from('files').select('id,name,mime,size,subject_id,description')), q(c.from('lessons').select('id,title,subject_id,visibility'))]);
    return { files, lessons };
  });

  tool(
    'read_pdf',
    'Read the text of a PDF in the content account’s library (for example a syllabus, to set a subject’s topics). Use it for topic names and what students must know; never copy questions from it.',
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

  // ---------------- StudyBridge's own content ----------------
  async function contentSubject(ref) {
    const c = await db();
    const all = await q(c.from('subjects').select('id,name,code,board,level,live').not('catalogue', 'is', null).order('position'));
    const r = norm(ref);
    if (!r) throw new Error('Which subject? Give its code (for example 0607) or its full name.');
    const hit =
      all.find((x) => x.id === ref) ||
      all.find((x) => x.code && norm(x.code) === r) ||
      all.find((x) => norm(x.name) === r) ||
      (() => {
        const some = all.filter((x) => norm(x.name).includes(r));
        if (some.length > 1) throw new Error(`“${ref}” could be ${some.slice(0, 12).map((x) => x.name).join('; ')}. Say which one (its code is easiest).`);
        return some[0];
      })();
    if (!hit) throw new Error(`No subject matching “${ref}”. Use content_overview with all: true to see every subject.`);
    return hit;
  }
  // The answer key in StudyBridge's shape. Content never guesses a missing answer: the plain checks flag it instead.
  function keyOf(x) {
    const multi = x.type === 'mcq' && (x.correct || []).length > 1;
    let answer = {};
    if (x.type === 'mcq') answer = !x.correct?.length ? {} : multi ? { choices: x.correct.map(String) } : { choice: String(x.correct[0]) };
    else if (x.type === 'numeric') answer = { value: String(x.answer ?? ''), tolerance: String(x.tolerance ?? 0), ...(x.unit ? { unit: x.unit } : {}) };
    else if (x.type === 'steps') answer = x.answer ? { final: x.answer } : {};
    else if (x.answer) answer = { text: x.answer };
    const options = x.type === 'mcq' ? (multi ? { items: x.options || [], multi: true } : x.options || []) : [];
    return { answer, options };
  }
  const RULES =
    'Everything must be ORIGINAL: the same format, style and difficulty as the real exam, but never copied, reworded or adapted from a real past paper or a textbook. Maths in $...$ (LaTeX). Hints nudge without giving the answer away. Worked solutions show every step a student needs.';
  const ContentQ = {
    topic: z.string().describe('A topic from the syllabus, by name or code (e.g. "Algebra" or "C2")'),
    type: z.enum(TYPES).describe('mcq = multiple choice; numeric = one number; steps = maths working line by line; short = written answer; upload = worked on paper; drawing = drawn on screen. Practice uses mcq and numeric.'),
    prompt: z.string().describe('The question in Markdown, maths in $...$'),
    options: z.array(z.string()).optional().describe('mcq only'),
    correct: z.array(z.number().int().min(0)).optional().describe('mcq only: zero-based index(es) of the correct option(s)'),
    answer: z.string().optional().describe('numeric: the number; steps: the final line, e.g. "x = 4"; short: a model answer'),
    tolerance: z.number().optional().describe('numeric: allowed margin'),
    unit: z.string().optional().describe('numeric: unit shown to the student'),
    marks: z.number().min(0).optional(),
    mark_scheme: z.string().optional(),
    solution: z.string().describe('Worked solution, step by step (Markdown + LaTeX)'),
  };
  const toRow = (x, extra = {}) => {
    const { answer, options } = keyOf(x);
    return { topic: x.topic, type: x.type, prompt: x.prompt, options, answer, marks: x.marks ?? (x.type === 'steps' ? 3 : x.type === 'upload' || x.type === 'drawing' ? 4 : 1), mark_scheme: x.mark_scheme || null, solution: x.solution, ...extra };
  };
  const problems = (list, where = 'send them again, corrected') => (list?.length ? `\n\nThese need fixing before they can go up (${where}):\n${list.map((p) => `• ${p.number}: ${p.problems.join(' ')}`).join('\n')}` : '');
  const toCheck = (n) => (n ? `\n\n${n} wait for their check. Start a NEW chat and use the “Check waiting questions” prompt, so the checker never sees these answers.` : '');

  tool(
    'content_overview',
    `Start here when making StudyBridge’s own content (the content account only). Shows each catalogue subject: whether it’s open to students, its topics, questions live / waiting for their check / needing the Owner, lessons, flashcards and practice papers. Work subject by subject: set the syllabus, a lesson per topic, about 10 practice questions per topic (mostly mcq and numeric, each with a hint and a worked solution), flashcards, then original practice papers. ${RULES}`,
    { subject: z.string().optional().describe('One subject (code or name)'), all: z.boolean().optional().describe('Every subject, including ones not started') },
    async ({ subject, all }) => {
      const c = await db();
      const s = subject ? await contentSubject(subject) : null;
      const rows = await q(c.rpc('content_status', { p_subject: s?.id || null }));
      const started = (x) => x.open_to_students || x.topics || x.questions_live || x.questions_waiting_for_check || x.questions_needing_owner || x.lessons || x.flashcards || x.papers_live || x.papers_waiting;
      const shown = s || all ? rows : rows.filter(started);
      return {
        subjects: shown,
        ...(s || all ? {} : { not_started_yet: rows.length - shown.length, tip: 'Pass all: true to list every subject.' }),
        waiting_for_check: rows.reduce((n, x) => n + x.questions_waiting_for_check, 0),
        needing_the_owner: rows.reduce((n, x) => n + x.questions_needing_owner, 0),
      };
    },
  );

  tool(
    'set_syllabus',
    'Set a subject’s syllabus: its topics in order, each with a code and the details students must know. Topics already there are kept (matched by name) and put in this order. Use the exam board’s own topic names.',
    {
      subject: z.string().describe('Code or name'),
      topics: z.array(z.object({ name: z.string(), code: z.string().optional(), subtopics: z.array(z.string()).optional() })).min(1),
    },
    async ({ subject, topics }) => {
      const c = await db();
      const s = await contentSubject(subject);
      const r = await q(c.rpc('content_set_syllabus', { p_subject: s.id, p_topics: topics.map((t) => ({ name: t.name, code: t.code || null, details: t.subtopics || [] })) }));
      return `${s.name}: ${r.topics} topics (${r.added} new).`;
    },
    false,
  );

  tool(
    'add_questions',
    `Add practice questions to a subject (up to 25 at a time). Each needs a topic from the syllabus, a hint and a worked solution. They go to students only after a second, separate check. ${RULES}`,
    { subject: z.string().describe('Code or name'), questions: z.array(z.object({ ...ContentQ, hint: z.string().describe('A nudge that doesn’t give the answer away'), difficulty: z.number().int().min(1).max(3).optional().describe('1 easy, 2 medium, 3 hard') })).min(1).max(25) },
    async ({ subject, questions }) => {
      const c = await db();
      const s = await contentSubject(subject);
      const r = await q(c.rpc('content_add_questions', { p_subject: s.id, p_items: questions.map((x) => toRow(x, { hint: x.hint, difficulty: x.difficulty ?? null })) }));
      return `Saved ${r.added} question${r.added === 1 ? '' : 's'} to ${s.name}.${toCheck(r.waiting_for_check)}${problems(r.with_problems)}`;
    },
    false,
  );

  tool(
    'add_lesson',
    `Write a lesson for one topic: a clear explanation, worked examples, common mistakes and a few quick checks. It goes up for students when it passes the plain checks. Sending the same title again replaces that lesson. ${RULES}`,
    { subject: z.string(), topic: z.string(), title: z.string(), body: z.string().describe('Markdown; maths in $...$ and $$...$$') },
    async ({ subject, topic, title, body }) => {
      const c = await db();
      const s = await contentSubject(subject);
      const r = await q(c.rpc('content_add_lesson', { p_subject: s.id, p_topic: topic, p_title: title, p_body: body }));
      return r.live ? `Lesson “${title}” is up for ${s.name} students${r.replaced ? ' (it replaced the old one)' : ''}.` : `Lesson “${title}” is saved but hidden until it’s fixed: ${r.problems.join(' ')}`;
    },
    false,
  );

  tool(
    'add_flashcards',
    'Add flashcards for a subject (up to 100 at a time): a short question or term on the front, the answer on the back. Repeats are skipped.',
    { subject: z.string(), cards: z.array(z.object({ topic: z.string(), front: z.string(), back: z.string() })).min(1).max(100) },
    async ({ subject, cards }) => {
      const c = await db();
      const s = await contentSubject(subject);
      const r = await q(c.rpc('content_add_cards', { p_subject: s.id, p_items: cards }));
      return `Added ${r.added} flashcard${r.added === 1 ? '' : 's'} to ${s.name}.${problems(r.left_out)}`;
    },
    false,
  );

  tool(
    'add_practice_paper',
    `Add an ORIGINAL practice paper in the format of one of the subject’s real papers (same structure, question styles, marks and time), never copied or reworded from a real paper. Students take it timed and mark it themselves with the mark scheme. It goes live once every question passes its check. ${RULES}`,
    {
      subject: z.string(),
      title: z.string().describe('e.g. "Practice paper 2 (Extended) · Set A"'),
      minutes: z.number().int().min(1).max(300).optional(),
      instructions: z.string().optional().describe('Instructions at the top, like the real paper’s (no board logos or wording copied)'),
      questions: z.array(z.object({ ...ContentQ, topic: z.string().optional() })).min(1).max(60),
    },
    async ({ subject, title, minutes, instructions, questions }) => {
      const c = await db();
      const s = await contentSubject(subject);
      const r = await q(c.rpc('content_add_paper', { p_subject: s.id, p_title: title, p_minutes: minutes ?? null, p_instructions: instructions ?? null, p_items: questions.map((x) => toRow(x)) }));
      return `Saved “${title}” for ${s.name} (${r.questions} question${r.questions === 1 ? '' : 's'}).${toCheck(r.waiting_for_check)}${problems(r.with_problems, 'the Owner fixes these in Admin → Content, then the paper goes live')}`;
    },
    false,
  );

  tool(
    'questions_to_check',
    'The second check, done in a NEW chat so you have never seen the answers. Gives questions waiting for their check (never their answers). Solve each one yourself from scratch, carefully, then send your answers with submit_checks.',
    { limit: z.number().int().min(1).max(30).optional() },
    async ({ limit }) => {
      const c = await db();
      const r = await q(c.rpc('content_to_check', { p_limit: limit ?? 10 }));
      if (!r.questions.length) return 'Nothing is waiting for its check.';
      return {
        waiting: r.waiting,
        questions: r.questions,
        how_to_answer: 'submit_checks with one entry per question: mcq → choice (zero-based) or choices; numeric → value; steps → final (the last line, e.g. "x = 4"); short, upload or drawing → text (your model answer). Add working if it helps.',
      };
    },
  );

  tool(
    'submit_checks',
    'Send your own answers to the questions from questions_to_check. Choices and numbers are compared straight away. For written answers you are shown the answer key next: then say honestly, with confirm_checks, whether the two mean the same.',
    {
      answers: z
        .array(
          z.object({
            id: z.string(),
            kind: z.enum(['question', 'paper']),
            choice: z.number().int().min(0).optional(),
            choices: z.array(z.number().int().min(0)).optional(),
            value: z.union([z.number(), z.string()]).optional(),
            final: z.string().optional(),
            text: z.string().optional(),
            working: z.string().optional(),
          }),
        )
        .min(1),
    },
    async ({ answers }) => {
      const c = await db();
      const items = answers.map((x) => ({
        id: x.id,
        kind: x.kind,
        working: x.working || null,
        answer: x.choices?.length ? { choices: x.choices.map(String) } : x.choice != null ? { choice: String(x.choice) } : x.value != null ? { value: String(x.value) } : x.final ? { final: x.final } : x.text ? { text: x.text } : {},
      }));
      const r = await q(c.rpc('content_submit_checks', { p_items: items }));
      const lead = `${r.passed} passed and went up for students. ${r.failed} got a different answer and wait for the Owner in Admin → Content.`;
      if (!r.compare_these.length) return lead;
      return { result: lead, compare_these: r.compare_these, next: 'For each one, decide honestly whether your answer means the same as the answer key (same result, nothing important missing or wrong). Then call confirm_checks.' };
    },
    false,
  );

  tool(
    'confirm_checks',
    'For written answers from submit_checks: say whether your answer and the answer key mean the same. Be strict: if either is wrong or something important is missing, say they don’t.',
    { results: z.array(z.object({ id: z.string(), kind: z.enum(['question', 'paper']), same: z.boolean(), note: z.string().optional() })).min(1) },
    async ({ results }) => {
      const c = await db();
      const r = await q(c.rpc('content_confirm_checks', { p_items: results }));
      return `${r.passed} passed and went up for students. ${r.failed} wait for the Owner in Admin → Content.`;
    },
    false,
  );

  server.registerPrompt('make_subject', { description: 'Make StudyBridge content for a subject' }, () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Using StudyBridge’s content tools, help me make content for one subject. Start with content_overview and ask me which subject. Then: set its syllabus (the board’s topic names, in order, with codes and subtopics), write a lesson for each topic, about 10 practice questions per topic (mostly multiple choice and numbers, each with a hint and a worked solution), 10 flashcards per topic, and one original practice paper per paper of the real exam. Work topic by topic and tell me how it’s going. ${RULES}`,
        },
      },
    ],
  }));
  server.registerPrompt('check_waiting', { description: 'Check waiting questions (in a new chat)' }, () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Using StudyBridge, check the questions waiting for their check. Call questions_to_check, solve every question yourself from scratch and carefully (don’t guess), and send your answers with submit_checks. If it asks you to compare written answers, say honestly with confirm_checks whether they mean the same. Repeat until nothing is waiting, then tell me how many passed and how many need me.',
        },
      },
    ],
  }));

  return server;
}
