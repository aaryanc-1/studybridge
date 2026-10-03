// @ts-nocheck  (plain JavaScript; no type annotations needed)
// Prof: StudyBridge's AI teaching assistant, running on the server as a
// Supabase Edge Function. Tutors ask it for work (or switch on weekly work
// and auto-marking); it writes DRAFTS only, which the tutor approves in the app.
// The Claude key lives in the database (set in the app's Admin page) and never
// reaches a tutor or learner. Learners never use Prof.
//
// Deploy: supabase functions deploy prof --no-verify-jwt   (CI does this)
//
// Each call does one step (one Claude request) and then wakes itself for the
// next, so long jobs fit Supabase's time limits.

const PRICES = {
  // $ per million tokens: [input, output]
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-4-5-20251001': [1, 5],
  'claude-haiku-4-5': [1, 5],
};
const MAX_STEPS = 30;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-prof-secret',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const TYPES = ['mcq', 'numeric', 'short', 'steps', 'upload', 'drawing'];
const KIND_DEFAULTS = {
  homework: { lockdown: false, camera: false, time_limit_min: null, release_mode: 'manual', allow_notes: true },
  quiz: { lockdown: false, camera: false, time_limit_min: 15, release_mode: 'on_submit', show_answers: true, allow_notes: true },
  test: { lockdown: true, camera: false, time_limit_min: 45, release_mode: 'manual', allow_notes: false },
  exam: { lockdown: true, camera: true, time_limit_min: 90, release_mode: 'manual', allow_notes: false },
};

class Retry extends Error {
  constructor(msg, secs = 30) {
    super(msg);
    this.retry = secs;
  }
}

export function createHandler(env) {
  const SB = String(env('SUPABASE_URL') || '').replace(/\/+$/, '');
  const KEY = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY') || '';
  const ANON = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY') || KEY;
  const ANTHROPIC = String(env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, '');
  const SELF = String(env('PROF_URL') || `${SB}/functions/v1/prof`);
  const auth = (k) => ({ apikey: k, ...(String(k).startsWith('eyJ') ? { authorization: `Bearer ${k}` } : {}) });

  // In Supabase the work carries on after we answer; elsewhere (tests) we just wait for it
  function later(p) {
    const rt = globalThis.EdgeRuntime;
    if (rt && typeof rt.waitUntil === 'function') {
      rt.waitUntil(p.catch((e) => console.error('Prof:', e)));
      return null;
    }
    return p;
  }

  // ---------------- database (service role) ----------------
  async function rest(path, { method = 'GET', body, prefer } = {}) {
    const r = await fetch(`${SB}/rest/v1/${path}`, {
      method,
      headers: { ...auth(KEY), 'content-type': 'application/json', ...(prefer ? { prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) throw new Error((data && data.message) || `Database error ${r.status}`);
    return data;
  }
  const rpc = (fn, args = {}) => rest(`rpc/${fn}`, { method: 'POST', body: args });
  const insert = async (table, row) => (await rest(table, { method: 'POST', body: row, prefer: 'return=representation' }))[0];

  async function download(bucket, path) {
    const r = await fetch(`${SB}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: auth(KEY) });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0];
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { bytes, type };
  }
  async function removeFiles(bucket, paths) {
    for (let i = 0; i < paths.length; i += 100) {
      await fetch(`${SB}/storage/v1/object/${bucket}`, {
        method: 'DELETE',
        headers: { ...auth(KEY), 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: paths.slice(i, i + 100) }),
      }).catch(() => {});
    }
  }
  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Who's calling: a signed-in StudyBridge user (from the app), or the database (with the shared secret)
  async function whoIs(req) {
    const h = req.headers.get('authorization') || '';
    const token = h.replace(/^Bearer\s+/i, '');
    if (!token || token === ANON) return null;
    const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: ANON, authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    const p = (await rest(`profiles?id=eq.${u.id}&select=id,role,status`))[0];
    if (!p) return null;
    const admin = (await rest(`platform_admins?user_id=eq.${u.id}&select=user_id`)).length > 0;
    return { id: u.id, role: p.role, status: p.status, admin };
  }

  // ---------------- Claude ----------------
  async function claude(cfg, payload) {
    let r;
    try {
      r = await fetch(`${ANTHROPIC}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, ...payload }),
        signal: AbortSignal.timeout(135000),
      });
    } catch (e) {
      throw new Retry('Couldn’t reach Claude, trying again shortly…', 20);
    }
    const data = await r.json().catch(() => ({}));
    if (r.ok) return data;
    const msg = data?.error?.message || `Claude error ${r.status}`;
    if (r.status === 401 || r.status === 403) throw new Error('The Claude key was refused. The StudyBridge admin needs to check it in Admin → Prof.');
    if (r.status === 429 || r.status === 529 || r.status >= 500) throw new Retry('Claude is busy, trying again shortly…', r.status === 429 ? 60 : 30);
    throw new Error(msg);
  }
  function cost(model, u = {}) {
    const [pi, po] = PRICES[model] || PRICES['claude-sonnet-5-5'];
    const dollars =
      ((u.input_tokens || 0) * pi + (u.cache_creation_input_tokens || 0) * pi * 1.25 + (u.cache_read_input_tokens || 0) * pi * 0.1 + (u.output_tokens || 0) * po) / 1e6;
    return Math.round(dollars * 100 * 10000) / 10000; // cents
  }
  const usageArgs = (cfg, u = {}) => ({
    p_input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) || 1,
    p_output: u.output_tokens || 0,
    p_cost: cost(cfg.model, u),
    p_model: cfg.model,
  });
  const save = (job, status, args = {}) => rpc('prof_save', { p_job: job.id, p_status: status, ...args });

  // ---------------- making work ----------------
  const CREATE_TOOLS = [
    {
      name: 'start_assignment',
      description: 'Start a new draft assignment (homework, quiz, test or exam). Returns its assignment_id. Then add questions with add_questions.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: ['homework', 'quiz', 'test', 'exam'] },
          subject_id: { type: 'string', description: 'From the context subjects list' },
          topic_id: { type: 'string', description: 'From the context topics list' },
          learner_ids: { type: 'array', items: { type: 'string' }, description: 'Only for these learners. Leave out for everyone taking the subject.' },
          due_at: { type: 'string', description: 'ISO 8601 date-time with time zone offset' },
          instructions: { type: 'string', description: 'Short instructions for the learner (Markdown)' },
          time_limit_min: { type: 'integer' },
          lockdown: { type: 'boolean' },
          camera: { type: 'boolean' },
        },
        required: ['title', 'kind'],
      },
    },
    {
      name: 'add_questions',
      description: 'Add up to 4 questions to a draft assignment you started. Call it again for more.',
      input_schema: {
        type: 'object',
        properties: {
          assignment_id: { type: 'string' },
          questions: {
            type: 'array',
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: TYPES },
                prompt: { type: 'string', description: 'Question text, Markdown. Maths in $...$, display maths in $$...$$.' },
                marks: { type: 'number' },
                options: { type: 'array', items: { type: 'string' }, description: 'mcq only' },
                correct: { type: 'array', items: { type: 'integer' }, description: 'mcq only: zero-based index(es) of the correct option(s)' },
                answer: { type: 'string', description: 'numeric: the number; steps: the final line in LaTeX (e.g. "x = 4"); short: a model answer' },
                tolerance: { type: 'number', description: 'numeric only' },
                unit: { type: 'string', description: 'numeric only' },
                mark_scheme: { type: 'string', description: 'For the tutor, e.g. "M1 subtract 3 from both sides; A1 x = 4"' },
                solution: { type: 'string', description: 'Worked solution for the learner after marking (Markdown + LaTeX)' },
                topic_id: { type: 'string' },
              },
              required: ['type', 'prompt'],
            },
          },
        },
        required: ['assignment_id', 'questions'],
      },
    },
    {
      name: 'create_lesson',
      description: 'Write a draft lesson (notes, worked examples, practice) for the tutor’s library.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown; maths in $...$ and $$...$$' },
          subject_id: { type: 'string' },
          topic_id: { type: 'string' },
        },
        required: ['title', 'body'],
      },
    },
    {
      name: 'finish',
      description: 'Finish. Give the tutor one or two sentences about what you made (or what you need from them).',
      input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    },
  ];

  const LOOK_TOOL = {
    name: 'look_at_pages',
    description:
      'See pages of one of the tutor’s books (the tutor’s app sends pictures of them). Use PDF page numbers (1 = first page of the file). Up to 10 pages per call; the result shows each page’s PDF number, so check the printed page numbers and ask again if you landed in the wrong place.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        pages: { type: 'array', items: { type: 'integer' }, maxItems: 10 },
        why: { type: 'string', description: 'A few words for the tutor, e.g. "the chapter on simultaneous equations"' },
      },
      required: ['file_id', 'pages'],
    },
  };
  const MAX_LOOKS = 4;

  function createSystem(ctx, books = []) {
    return `You are Prof, the teaching assistant inside StudyBridge, working for the tutor ${ctx.tutor?.name || ''}.
You make DRAFT assignments and lessons. The tutor reviews and approves everything; nothing you make reaches a learner until they do. You never talk to learners.

How to work:
1. Read the tutor's request. Use the subjects, topics and learners below (use their ids). If the tutor names a learner, set learner_ids.
2. For an assignment: call start_assignment, then add_questions with AT MOST 4 questions per call (call it again for more), then finish.
3. For a lesson: call create_lesson, then finish.
4. If details are missing (topic, how many questions, due date), make sensible choices and go ahead: use the learner's subjects, level and topics_needing_work, about 8 questions, no due date. Say in finish what you assumed so the tutor can ask for changes. Only finish with a question instead if you truly can't make anything useful.
${books.length ? `5. The tutor chose whole books (below). Find the right pages from the outline or the contents pages, then call look_at_pages to read them before writing questions. Base the work on what those pages teach. Use look_at_pages at most ${MAX_LOOKS} times.
` : ''}
Writing questions:
- Pitch them at the learner's level and syllabus. Vary difficulty: start accessible, end with something that stretches.
- Markdown with LaTeX maths in $...$ (inline) or $$...$$ (display). Never use \\( \\).
- Question types: mcq (options + correct indexes), numeric (one number; give answer, and tolerance if rounding is involved, and unit if any), steps (maths working line by line, e.g. solving equations; answer = the final line in LaTeX), short (written answer; answer = model answer), upload (learner photographs working on paper: geometry constructions, long working), drawing (learner draws on screen: sketches, graphs, diagrams).
- Default marks: mcq/numeric 1, steps 3, short 2, upload/drawing 4, unless the request says otherwise.
- Always give a mark scheme (exam-board style M1/A1/B1 where it fits) and a short worked solution.
- If pages from the tutor's books are attached, base the questions on them and match their notation. Don't copy questions word for word unless asked.
- Use topics_needing_work and recent_mistakes when the tutor asks for practice on weak areas.
- Past papers: when the tutor attaches their own copy of a past paper and asks you to turn it into a test, copy its questions faithfully, in order, with the paper's marks, and use the attached mark scheme. When asked for a paper "in the style of" a past paper, write entirely ORIGINAL questions with the same structure, topics, marks and difficulty; never reproduce or lightly reword real exam-board questions from memory.
- Kinds: homework (no time limit), quiz (short, marked instantly, 15 min), test (45 min, locked screen), exam (90 min, locked screen and camera). Only change time limits, lockdown or camera if asked.
- Due dates: ISO 8601 with offset. Read relative dates ("Friday") from today's date in the tutor's time zone; if the work is for one learner, use their time zone. If no time is given, use 20:00. If no date is given, leave it out.

Today: ${ctx.now} (tutor's time zone: ${ctx.tutor?.timezone || 'UTC'}).
${ctx.style ? `\nThe tutor's own instructions for you:\n${ctx.style}\n` : ''}
The tutor's StudyBridge:
${JSON.stringify({ programmes: ctx.programmes, subjects: ctx.subjects, topics: ctx.topics, learners: ctx.learners })}`;
  }

  async function firstMessage(job, ctx) {
    const content = [];
    const names = (job.context?.learner_ids || []).map((id) => ctx.learners.find((l) => l.id === id)).filter(Boolean);
    let t = `${job.kind === 'auto' ? 'Weekly work (the tutor switched this on)' : 'The tutor asks'}: ${job.prompt}`;
    if (names.length) t += `\n\nFor: ${names.map((l) => `${l.name} (${l.id})`).join(', ')}`;
    if (job.context?.reply_to) {
      const prev = (await rest(`prof_jobs?id=eq.${job.context.reply_to}&select=prompt,result`))[0];
      if (prev) {
        const made = [...(prev.result?.assignments || []).map((a) => `assignment “${a.title}” (${a.questions} questions, now a draft)`), ...(prev.result?.lessons || []).map((l) => `lesson “${l.title}” (draft)`)];
        t = `This is a reply to an earlier request.\nEarlier the tutor asked: ${prev.prompt}\nYou replied: ${prev.result?.reply || '(nothing)'}${made.length ? `\nYou made: ${made.join('; ')}. To change it, make a new draft (the tutor deletes the old one).` : ''}\n\nNow ${t.charAt(0).toLowerCase() + t.slice(1)}`;
      }
    }
    for (const b of job.context?.books || []) {
      t += `\n\nBook: “${b.name}” (file_id ${b.file_id}, ${b.pages} PDF pages).${b.outline ? `\nIts outline (title → PDF page):\n${b.outline}` : '\nIt has no outline; its first pages are attached so you can read the contents page.'}`;
    }
    const pages = job.context?.pages || [];
    if (pages.length) t += `\n\n${pages.length} page${pages.length > 1 ? 's' : ''} from the tutor’s library follow${pages.length > 1 ? '' : 's'} as images: ${pages.map((p) => p.label || 'page').join('; ')}.`;
    content.push({ type: 'text', text: t });
    for (const p of pages) content.push({ type: 'sb_image', bucket: 'library', path: p.path });
    return { role: 'user', content };
  }

  async function expandBlocks(blocks) {
    const content = [];
    for (const b of blocks) {
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        content.push({ ...b, content: await expandBlocks(b.content) });
        continue;
      }
      if (b.type !== 'sb_image') {
        content.push(b);
        continue;
      }
      const f = await download(b.bucket, b.path);
      if (!f || f.bytes.length > 4.5 * 1024 * 1024) {
        content.push({ type: 'text', text: '(An image could not be loaded.)' });
        continue;
      }
      const media = /png|gif|webp/.test(f.type) ? f.type : 'image/jpeg';
      content.push({ type: 'image', source: { type: 'base64', media_type: media, data: b64(f.bytes) } });
    }
    return content;
  }

  // Swap stored image references for the image data (kept out of the saved state)
  async function expand(messages) {
    const out = [];
    for (const m of messages) {
      if (!Array.isArray(m.content)) {
        out.push(m);
        continue;
      }
      out.push({ ...m, content: await expandBlocks(m.content) });
    }
    // cache the start of the conversation (system + attached pages) and the latest turn
    const mark = (m) => {
      if (m && Array.isArray(m.content) && m.content.length) m.content[m.content.length - 1] = { ...m.content[m.content.length - 1], cache_control: { type: 'ephemeral' } };
    };
    mark(out[0]);
    if (out.length > 2) mark(out[out.length - 1]);
    return out;
  }

  const pickId = (list, id) => (id && list.some((x) => x.id === id) ? id : null);
  const multiOf = (x) => x.type === 'mcq' && (x.correct || []).length > 1;
  const optionsOf = (x) => (x.type === 'mcq' ? (multiOf(x) ? { items: x.options || [], multi: true } : x.options || []) : []);
  const marksOf = (x) => (typeof x.marks === 'number' && x.marks >= 0 ? x.marks : x.type === 'steps' ? 3 : x.type === 'short' ? 2 : x.type === 'upload' || x.type === 'drawing' ? 4 : 1);
  function keyOf(x) {
    if (x.type === 'mcq') return multiOf(x) ? { choices: (x.correct || []).map(String) } : { choice: String((x.correct || [0])[0] ?? 0) };
    if (x.type === 'numeric') return { value: String(x.answer ?? ''), tolerance: String(x.tolerance ?? 0), ...(x.unit ? { unit: x.unit } : {}) };
    if (x.type === 'steps' && x.answer) return { final: x.answer };
    if (x.type === 'short' && x.answer) return { text: x.answer };
    return {};
  }

  async function runCreateTool(name, input, job, ctx, made) {
    if (name === 'start_assignment') {
      const kind = KIND_DEFAULTS[input.kind] ? input.kind : 'homework';
      const subject = pickId(ctx.subjects, input.subject_id);
      const topic = pickId(ctx.topics, input.topic_id);
      const learners = (input.learner_ids || []).filter((id) => ctx.learners.some((l) => l.id === id));
      let due = null;
      if (input.due_at && !isNaN(Date.parse(input.due_at))) due = new Date(input.due_at).toISOString();
      const row = {
        ...KIND_DEFAULTS[kind],
        tutor_id: job.tutor_id,
        kind,
        title: String(input.title || 'Untitled').slice(0, 200),
        instructions_md: input.instructions || '',
        subject_id: subject,
        topic_id: topic,
        due_at: due,
        learner_ids: learners.length ? learners : null,
        visibility: 'visible',
        draft: true,
        source: 'prof',
        ...(Number.isInteger(input.time_limit_min) && input.time_limit_min > 0 ? { time_limit_min: input.time_limit_min } : {}),
        ...(typeof input.lockdown === 'boolean' ? { lockdown: input.lockdown } : {}),
        ...(typeof input.camera === 'boolean' ? { camera: input.camera } : {}),
      };
      const a = await insert('assignments', row);
      made.assignments.push({ id: a.id, title: a.title, kind: a.kind, questions: 0 });
      return { assignment_id: a.id };
    }
    if (name === 'add_questions') {
      const a = made.assignments.find((x) => x.id === input.assignment_id);
      if (!a) throw new Error('Unknown assignment_id. Use the id start_assignment gave you.');
      const qs = (input.questions || []).slice(0, 6);
      for (const x of qs) {
        if (!TYPES.includes(x.type)) throw new Error(`Unknown question type ${x.type}`);
        const q = await insert('questions', {
          tutor_id: job.tutor_id,
          assignment_id: a.id,
          position: a.questions,
          type: x.type,
          prompt_md: String(x.prompt || ''),
          options: optionsOf(x),
          marks: marksOf(x),
          topic_id: pickId(ctx.topics, x.topic_id),
        });
        await insert('question_keys', { tutor_id: job.tutor_id, question_id: q.id, answer: keyOf(x), mark_scheme_md: x.mark_scheme || null, solution_md: x.solution || null });
        a.questions++;
      }
      return { added: qs.length, total_questions: a.questions };
    }
    if (name === 'create_lesson') {
      const l = await insert('lessons', {
        tutor_id: job.tutor_id,
        title: String(input.title || 'Lesson').slice(0, 200),
        body_md: String(input.body || ''),
        subject_id: pickId(ctx.subjects, input.subject_id),
        topic_id: pickId(ctx.topics, input.topic_id),
        visibility: 'visible',
        draft: true,
        source: 'prof',
      });
      made.lessons.push({ id: l.id, title: l.title });
      return { lesson_id: l.id };
    }
    if (name === 'finish') return { ok: true };
    throw new Error(`Unknown tool ${name}`);
  }

  function progressOf(made) {
    const q = made.assignments.reduce((n, a) => n + a.questions, 0);
    if (made.assignments.length) return `Writing questions (${q} so far)…`;
    if (made.lessons.length) return 'Writing the lesson…';
    return 'Planning…';
  }

  async function stepCreate(job, cfg) {
    let st = job.state && job.state.messages ? job.state : null;
    const books = job.context?.books || [];
    if (!st) {
      const ctx = await rpc('prof_context', { p_tutor: job.tutor_id });
      st = { ctx, messages: [await firstMessage(job, ctx)], made: { assignments: [], lessons: [] }, tries: 0, looks: 0, uploaded: [] };
      await save(job, 'running', { p_state: st, p_progress: job.context?.pages?.length || books.length ? 'Reading your book…' : 'Planning…', p_input: 0 });
    }
    // The tutor's app has sent the pages Prof asked for
    if (st.waiting) {
      const got = job.result?.provided_pages;
      if (!got) return save(job, 'waiting', { p_input: 0 });
      const parts = [{ type: 'text', text: got.length ? `The pages you asked for (${got.length}):` : 'Those pages could not be opened. Try others, or work with what you have.' }];
      for (const p of got) {
        parts.push({ type: 'text', text: p.label || 'Page' });
        parts.push({ type: 'sb_image', bucket: 'library', path: p.path });
      }
      st.messages.push({ role: 'user', content: [...st.waiting.results, { type: 'tool_result', tool_use_id: st.waiting.tool_use_id, content: parts }] });
      st.uploaded = [...(st.uploaded || []), ...got.map((p) => p.path)];
      delete st.waiting;
      await save(job, 'running', { p_state: st, p_result: {}, p_progress: 'Reading the pages…', p_input: 0 });
    }
    if (job.steps >= MAX_STEPS) throw new Error('Prof stopped: this took too many steps. Try asking for less at once.');
    const { ctx, messages, made } = st;
    const res = await claude(cfg, {
      max_tokens: 8000,
      system: [{ type: 'text', text: createSystem(ctx, books), cache_control: { type: 'ephemeral' } }],
      tools: books.length ? [...CREATE_TOOLS, LOOK_TOOL] : CREATE_TOOLS,
      messages: await expand(messages),
    });
    let blocks = res.content || [];
    const cut = res.stop_reason === 'max_tokens' && blocks.length && blocks[blocks.length - 1].type === 'tool_use';
    if (cut) blocks = blocks.slice(0, -1);
    messages.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '…' }] });
    const results = [];
    let finished = null;
    let look = null;
    for (const u of blocks.filter((b) => b.type === 'tool_use')) {
      if (u.name === 'look_at_pages') {
        const book = books.find((x) => x.file_id === u.input?.file_id);
        const pages = book ? [...new Set((u.input?.pages || []).map(Number).filter((n) => n >= 1 && n <= book.pages))].slice(0, 10) : [];
        const why = !book
          ? 'Unknown file_id: use one from the books listed.'
          : look
            ? 'One look_at_pages at a time: ask again after this one.'
            : (st.looks || 0) >= MAX_LOOKS
              ? 'No more page requests: work with what you have.'
              : !pages.length
                ? `Those page numbers aren’t in the book (it has ${book.pages} PDF pages).`
                : null;
        if (why) results.push({ type: 'tool_result', tool_use_id: u.id, content: why, is_error: true });
        else look = { tool_use_id: u.id, file_id: book.file_id, name: book.name, pages, why: String(u.input?.why || '').slice(0, 120) };
        continue;
      }
      try {
        const out = await runCreateTool(u.name, u.input || {}, job, ctx, made);
        if (u.name === 'finish') finished = String(u.input?.message || 'Done.');
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: String(e.message || e), is_error: true });
      }
    }
    const said = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!results.length && !look && !cut) finished = said || 'Done.';
    const use = usageArgs(cfg, res.usage);
    if (finished !== null) {
      const qn = made.assignments.reduce((n, a) => n + a.questions, 0);
      const title =
        made.assignments.length === 1
          ? `Prof made “${made.assignments[0].title}” (${qn} question${qn === 1 ? '' : 's'})`
          : made.assignments.length > 1
            ? `Prof made ${made.assignments.length} assignments`
            : made.lessons.length
              ? `Prof wrote “${made.lessons[0].title}”`
              : 'Prof replied';
      await save(job, 'done', {
        ...use,
        p_state: { done: true },
        p_result: { assignments: made.assignments, lessons: made.lessons, reply: finished },
        p_progress: 'Ready for you to review',
        p_notify: { title, body: finished.slice(0, 220), ref: { assignment_id: made.assignments[0]?.id || null, lesson_id: made.lessons[0]?.id || null } },
      });
      await removeFiles('library', [...(job.context?.pages || []).map((p) => p.path), ...(st.uploaded || [])]);
      return;
    }
    // Prof wants to read pages of a book: the tutor's app renders them and sends them back
    if (look) {
      st.looks = (st.looks || 0) + 1;
      st.waiting = { tool_use_id: look.tool_use_id, results };
      const range = look.pages.length > 1 && look.pages[look.pages.length - 1] - look.pages[0] === look.pages.length - 1 ? `${look.pages[0]}–${look.pages[look.pages.length - 1]}` : look.pages.join(', ');
      await save(job, 'waiting', {
        ...use,
        p_state: { ...st, tries: 0 },
        p_result: { need_pages: { file_id: look.file_id, name: look.name, pages: look.pages, why: look.why } },
        p_progress: `Reading ${look.name}, page${look.pages.length > 1 ? 's' : ''} ${range}${look.why ? ` (${look.why})` : ''}…`,
      });
      return;
    }
    const next = [...results];
    if (cut) next.push({ type: 'text', text: 'Your last reply was cut off. Add fewer questions per call (at most 3).' });
    if (!next.length) next.push({ type: 'text', text: 'Carry on, or call finish if you are done.' });
    messages.push({ role: 'user', content: next });
    await save(job, 'queued', { ...use, p_state: { ...st, tries: 0 }, p_progress: progressOf(made) });
  }

  // ---------------- the question bank ----------------
  const QUESTION_ITEM = CREATE_TOOLS[1].input_schema.properties.questions.items;
  const BANK_TOOL = {
    name: 'save_questions',
    description: 'Save questions to the question bank. They wait for approval before anyone uses them.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          maxItems: 8,
          items: {
            ...QUESTION_ITEM,
            properties: {
              ...QUESTION_ITEM.properties,
              type: { type: 'string', enum: ['mcq', 'numeric', 'steps', 'short'] },
              difficulty: { type: 'integer', enum: [1, 2, 3], description: '1 easy, 2 medium, 3 hard' },
              topic_id: undefined,
            },
            required: ['type', 'prompt', 'difficulty', 'mark_scheme', 'solution'],
          },
        },
      },
      required: ['questions'],
    },
  };
  delete BANK_TOOL.input_schema.properties.questions.items.properties.topic_id;
  const CHECK_TOOL = {
    name: 'submit_checks',
    description: 'Your independent check of each question.',
    input_schema: {
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              number: { type: 'integer' },
              my_answer: { type: 'string', description: 'Your own answer, worked out before looking at the stated one' },
              agrees: { type: 'boolean', description: 'true only if the stated answer AND mark scheme are correct and the question is clear and solvable' },
              note: { type: 'string', description: 'If it doesn’t agree: what is wrong, briefly' },
            },
            required: ['number', 'my_answer', 'agrees'],
          },
        },
      },
      required: ['checks'],
    },
  };
  const DIFF = { 1: 'easy', 2: 'medium', 3: 'hard' };

  async function stepBank(job, cfg) {
    const c = job.context || {};
    const st = job.state && job.state.phase ? job.state : { phase: 'write', made: [], tries: 0 };
    const where = `${c.board === 'ib' ? 'IB Diploma' : c.board === 'cie' ? 'Cambridge IGCSE' : ''} ${c.code || ''}`.trim();
    if (job.steps >= MAX_STEPS) throw new Error('Prof stopped: this took too many steps. Try asking for fewer questions.');
    if (st.phase === 'write') {
      const n = Math.min(8, (c.count || 10) - st.made.length);
      const res = await claude(cfg, {
        max_tokens: 9000,
        system: `You are Prof, writing exam-style practice questions for StudyBridge's question bank${where ? ` for ${where}` : ''}. Everything you write is checked and approved by a person before anyone uses it.
Rules:
- ORIGINAL questions only, in the style and standard of ${where || 'the syllabus'}. Never reproduce or lightly reword real exam-board questions from memory.
- Types: numeric (one number: answer, tolerance if rounding, unit if any), mcq (options + zero-based correct indexes), steps (maths working line by line; answer = the final line in LaTeX, e.g. "x = 4"), short (brief written answer; answer = model answer). Prefer numeric and steps for maths.
- Markdown with LaTeX in $...$ and $$...$$. Never use \\( \\). No diagrams or images: every question must be answerable from its text.
- Each question has marks like the real exam, an exam-board style mark scheme (M1/A1/B1), a short worked solution, and a difficulty (1 easy, 2 medium, 3 hard).
- Double-check every answer before saving it.`,
        tools: [BANK_TOOL],
        tool_choice: { type: 'tool', name: 'save_questions' },
        messages: [
          {
            role: 'user',
            content: `Write ${n} question${n === 1 ? '' : 's'} on: ${c.topic}.${c.difficulty ? ` Difficulty: ${DIFF[c.difficulty]}.` : ' Mix the difficulty: some easy, mostly medium, some hard.'}${
              st.made.length ? `\nAlready written (don’t repeat these):\n${st.made.map((m) => '- ' + m.p).join('\n')}` : ''
            }`,
          },
        ],
      });
      const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_questions');
      const qs = (call?.input?.questions || []).filter((x) => ['mcq', 'numeric', 'steps', 'short'].includes(x.type) && x.prompt).slice(0, n);
      for (const x of qs) {
        const row = await insert('bank_questions', {
          owner_id: c.shared ? null : job.tutor_id,
          status: 'review',
          exam_board: c.board || null,
          exam_code: c.code || null,
          subject_id: c.shared ? null : c.subject_id || null,
          topic: c.topic,
          difficulty: [1, 2, 3].includes(x.difficulty) ? x.difficulty : 2,
          type: x.type,
          prompt_md: String(x.prompt),
          options: optionsOf(x),
          marks: marksOf(x),
          answer: keyOf(x),
          mark_scheme_md: x.mark_scheme || null,
          solution_md: x.solution || null,
          source: c.shared ? 'studybridge' : 'prof',
          job_id: job.id,
        });
        st.made.push({ id: row.id, p: String(x.prompt).slice(0, 90) });
      }
      if (!qs.length) st.empty = (st.empty || 0) + 1;
      if (st.made.length >= (c.count || 10) || (st.empty || 0) >= 2) st.phase = 'check';
      await save(job, 'queued', { ...usageArgs(cfg, res.usage), p_state: { ...st, tries: 0 }, p_progress: `Writing questions (${st.made.length} of ${c.count})…` });
      return;
    }
    // Check: a second, independent pass solves each question and compares
    const ids = st.made.map((m) => m.id);
    if (!ids.length) throw new Error('Prof couldn’t write questions on that topic. Try wording it differently.');
    const rows = await rest(`bank_questions?id=in.(${ids.join(',')})&select=id,type,prompt_md,options,marks,answer,mark_scheme_md`);
    const list = ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
    const res = await claude(cfg, {
      max_tokens: 8000,
      system: `You are a careful exam checker for ${where || 'a school syllabus'}. For each question, first solve it yourself, then compare with the stated answer and mark scheme. Agree only if the stated answer is correct, the mark scheme fits, and the question is clear and solvable from its text.`,
      tools: [CHECK_TOOL],
      tool_choice: { type: 'tool', name: 'submit_checks' },
      messages: [{ role: 'user', content: JSON.stringify(list.map((r, i) => ({ number: i + 1, type: r.type, question: r.prompt_md, options: r.options, marks: r.marks, stated_answer: r.answer, mark_scheme: r.mark_scheme_md }))) }],
    });
    const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_checks');
    let flagged = 0;
    for (const x of call?.input?.checks || []) {
      const r = list[x.number - 1];
      if (!r) continue;
      if (!x.agrees) flagged++;
      await rest(`bank_questions?id=eq.${r.id}`, { method: 'PATCH', body: { check_result: { ok: !!x.agrees, my_answer: String(x.my_answer || '').slice(0, 300), note: String(x.note || '').slice(0, 400) } } });
    }
    const n = list.length;
    const msg = `${n} question${n === 1 ? '' : 's'} on ${c.topic} ${c.shared ? 'for the shared bank' : 'for your bank'}${flagged ? `; the automatic check flagged ${flagged} to look at closely` : '; the automatic check agreed with every answer'}.`;
    await save(job, 'done', {
      ...usageArgs(cfg, res.usage),
      p_state: { done: true },
      p_result: { bank: { count: n, flagged, shared: !!c.shared }, reply: msg },
      p_progress: 'Ready for you to review',
      p_notify: { title: `Prof wrote ${n} bank questions`, body: msg, ref: { bank: true, shared: !!c.shared } },
    });
  }

  // ---------------- marking ----------------
  const MARK_TOOL = {
    name: 'submit_marking',
    description: 'Suggested marks and feedback for this submission. The tutor checks and edits them before the learner sees anything.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two lines for the tutor: how it went, anything to check' },
        overall_feedback: { type: 'string', description: 'Feedback to the learner: encouraging, specific, what to practise next (Markdown + LaTeX)' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              number: { type: 'integer' },
              marks: { type: 'number', description: 'Leave out if you cannot judge it (e.g. you cannot see the drawing)' },
              feedback: { type: 'string', description: 'What was right or wrong and how to fix it, written to the learner' },
              mistake: { type: 'string', description: 'Short label for the main mistake, e.g. "Sign error expanding brackets". Leave out if none.' },
              redo: { type: 'boolean', description: 'Ask the learner to try this question again' },
              correct_steps: { type: 'array', items: { type: 'boolean' }, description: 'steps questions: true/false for each working line, in order' },
            },
            required: ['number'],
          },
        },
      },
      required: ['questions'],
    },
  };

  async function stepMark(job, cfg) {
    const mc = await rpc('prof_mark_context', { p_attempt: job.attempt_id });
    if (!mc || !mc.questions) throw new Error('That submission no longer exists.');
    await save(job, 'running', { p_progress: `Marking ${mc.learner}’s work…`, p_input: 0 });
    const qs = mc.questions.map((q) => {
      const a = q.learner_answer || {};
      const shown =
        q.type === 'steps'
          ? { working_lines_latex: (a.steps || []).filter(Boolean) }
          : q.type === 'drawing'
            ? { drawing: a.strokes?.length ? 'drawn on screen (you cannot see it: leave its marks out unless a photo is attached)' : 'nothing drawn' }
            : a;
      return { ...q, learner_answer: shown };
    });
    const content = [
      {
        type: 'text',
        text: `Mark this submission by ${mc.learner}: “${mc.assignment.title}” (${mc.assignment.kind}).
Questions of type mcq and numeric were marked automatically (auto_marks); include them only if the automatic mark looks wrong.
Include every short, steps, upload and drawing question. Follow the mark scheme. Give partial credit the way an examiner would. Feedback goes to the learner: kind, clear, specific.
${mc.style ? `\nThe tutor's own instructions:\n${mc.style}\n` : ''}
${JSON.stringify({ assignment: mc.assignment, questions: qs, learner_notes: mc.learner_notes })}`,
      },
    ];
    let n = 0;
    for (const q of mc.questions) {
      for (const f of q.learner_answer?.files || []) {
        if (n >= 10 || !f.path) continue;
        content.push({ type: 'text', text: `Photo of the learner’s work for question ${q.number}:` });
        content.push({ type: 'sb_image', bucket: 'work', path: f.path });
        n++;
      }
    }
    const res = await claude(cfg, {
      max_tokens: 6000,
      system: 'You are Prof, the marking assistant inside StudyBridge. You suggest marks; the tutor approves them.',
      tools: [MARK_TOOL],
      tool_choice: { type: 'tool', name: 'submit_marking' },
      messages: await expand([{ role: 'user', content }]),
    });
    const use = usageArgs(cfg, res.usage);
    const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_marking');
    if (!call) throw new Error('Prof didn’t return any marks. Try again.');
    const inp = call.input || {};
    const marks = [];
    for (const x of inp.questions || []) {
      const q = mc.questions.find((y) => y.number === x.number);
      if (!q) continue;
      marks.push({
        question_id: q.question_id,
        marks: x.marks === null || x.marks === undefined ? null : Math.max(0, Math.min(Number(q.max_marks), Number(x.marks))),
        ...(x.feedback ? { feedback_md: x.feedback } : {}),
        ...(x.mistake ? { mistake: x.mistake } : {}),
        ...(x.redo ? { redo: true } : {}),
        ...(Array.isArray(x.correct_steps) ? { step_marks: x.correct_steps.map((ok) => ({ ok: !!ok })) } : {}),
      });
    }
    const d = await insert('claude_drafts', {
      tutor_id: mc.tutor_id,
      kind: 'marking',
      learner_id: mc.learner_id,
      attempt_id: mc.attempt_id,
      summary: inp.summary || null,
      payload: { marks, ...(inp.overall_feedback ? { feedback_md: inp.overall_feedback } : {}) },
      source: 'prof',
    });
    await save(job, 'done', {
      ...use,
      p_result: { draft_id: d.id, attempt_id: mc.attempt_id, reply: inp.summary || '' },
      p_progress: 'Marks ready for you to check',
      p_notify: { title: `Prof marked ${mc.learner}’s ${mc.assignment.title}`, body: inp.summary ? inp.summary.slice(0, 220) : 'Check the suggested marks, then return them.', ref: { attempt_id: mc.attempt_id, draft_id: d.id } },
    });
  }

  // ---------------- the loop ----------------
  async function runOne(cfg) {
    const job = (await rpc('prof_claim', { p_job: null }))?.[0];
    if (!job) return false;
    try {
      if (!cfg.key) throw new Error('Prof isn’t switched on yet. The StudyBridge admin adds the Claude key in Admin → Prof.');
      if (job.kind === 'mark') await stepMark(job, cfg);
      else if (job.kind === 'bank') await stepBank(job, cfg);
      else await stepCreate(job, cfg);
    } catch (e) {
      const tries = (job.state?.tries || 0) + 1;
      if (e.retry && tries <= 6) {
        await save(job, 'queued', { p_state: { ...(job.state || {}), tries }, p_progress: e.message, p_retry_in: e.retry, p_input: 0 });
      } else {
        console.error('Prof job failed', job.id, e);
        await save(job, 'failed', { p_error: String(e.message || e).slice(0, 500), p_input: 0 });
        await removeFiles('library', [...(job.context?.pages || []).map((p) => p.path), ...(job.state?.uploaded || [])]);
      }
    }
    return true;
  }

  async function moreWaiting() {
    const rows = await rest(`prof_jobs?status=eq.queued&select=id,lease_until&order=created_at.asc&limit=20`);
    return rows.some((r) => !r.lease_until || new Date(r.lease_until) <= new Date());
  }

  async function work(cfg) {
    const did = await runOne(cfg);
    if (did && (await moreWaiting())) {
      // the next step (or job) runs in a fresh call, so each one fits the time limit
      const p = fetch(SELF, { method: 'POST', headers: { 'content-type': 'application/json', 'x-prof-secret': cfg.secret }, body: '{"action":"kick"}' })
        .then((r) => r.text())
        .catch(() => {});
      if (!globalThis.EdgeRuntime) await p;
    }
  }

  async function cleanup() {
    const files = (await rpc('prof_orphan_files')) || [];
    const by = {};
    for (const f of files) (by[f.bucket] ||= []).push(f.name);
    for (const [bucket, names] of Object.entries(by)) await removeFiles(bucket, names);
    return files.length;
  }

  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'content-type': 'application/json' } });

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!SB || !KEY) return json({ error: 'Prof is missing its Supabase settings.' }, 500);
    let body = {};
    try {
      body = await req.json();
    } catch {}
    const action = body.action || 'kick';
    let cfg;
    try {
      cfg = await rpc('prof_hello', { p_endpoint: SELF });
    } catch (e) {
      return json({ error: `Prof can’t reach the database: ${e.message}. Run the latest setup.sql.` }, 500);
    }
    const sent = req.headers.get('x-prof-secret');
    const fromDb = !!sent && sent === cfg.secret;
    const user = fromDb ? null : await whoIs(req).catch(() => null);
    if (!fromDb && !user) return json({ error: 'Not signed in.' }, 401);
    if (action === 'hello') return json({ ok: true, key_set: !!cfg.key, model: cfg.model });
    if (action === 'cleanup') {
      if (!fromDb && !user.admin) return json({ error: 'Admins only.' }, 403);
      return json({ removed: await cleanup() });
    }
    if (action === 'kick') {
      if (user && user.role !== 'tutor') return json({ error: 'Tutors only.' }, 403);
      const p = later(work(cfg));
      if (p) await p;
      return json({ ok: true });
    }
    return json({ error: 'Unknown action.' }, 400);
  };
}

if (globalThis.Deno?.serve) {
  const handle = createHandler((k) => globalThis.Deno.env.get(k));
  globalThis.Deno.serve(handle);
}
