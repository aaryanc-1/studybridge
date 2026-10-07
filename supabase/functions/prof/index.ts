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
    // Admin = the separate admin account
    const admin = p.role === 'admin' && (await rest(`platform_admins?user_id=eq.${u.id}&select=user_id`)).length > 0;
    return { id: u.id, role: p.role, status: p.status, admin };
  }

  // ---------------- Claude ----------------
  // Some models don't accept a forced tool choice ("you must call this tool"). For those, ask
  // with tool_choice auto plus a clear instruction, and nudge once if no tool was called.
  const noForced = new Set();
  async function claude(cfg, payload) {
    const forced = payload.tool_choice && ['tool', 'any'].includes(payload.tool_choice.type) ? payload.tool_choice : null;
    if (forced && noForced.has(cfg.model)) return claudeAuto(cfg, payload, forced);
    try {
      return await claudeRaw(cfg, payload);
    } catch (e) {
      if (!forced || e instanceof Retry || !/tool_choice/i.test(e.message || '')) throw e;
      noForced.add(cfg.model);
      return claudeAuto(cfg, payload, forced);
    }
  }
  async function claudeAuto(cfg, payload, forced) {
    const name = forced.name || null;
    const must = `Answer only by calling the ${name ? name + ' tool' : 'right tool'}. Don’t reply with plain text.`;
    const system = Array.isArray(payload.system) ? [...payload.system, { type: 'text', text: must }] : payload.system ? `${payload.system}\n\n${must}` : must;
    const p = { ...payload, system, tool_choice: { type: 'auto' } };
    const called = (r) => (r.content || []).some((b) => b.type === 'tool_use' && (!name || b.name === name));
    const first = await claudeRaw(cfg, p);
    if (called(first)) return first;
    const again = await claudeRaw(cfg, {
      ...p,
      messages: [...p.messages, { role: 'assistant', content: first.content?.length ? first.content : [{ type: 'text', text: '…' }] }, { role: 'user', content: `Please call the ${name || 'tool'} now with your answer.` }],
    });
    const u = {};
    for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) u[k] = (first.usage?.[k] || 0) + (again.usage?.[k] || 0);
    return { ...again, usage: u };
  }
  async function claudeRaw(cfg, payload) {
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
      description: 'Add up to 8 questions to a draft assignment you started. Call it again for more.',
      input_schema: {
        type: 'object',
        properties: {
          assignment_id: { type: 'string' },
          questions: {
            type: 'array',
            maxItems: 8,
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
        pictures: { type: 'boolean', description: 'true to see the pictures even if you already have notes on these pages (e.g. you need a diagram)' },
      },
      required: ['file_id', 'pages'],
    },
  };
  const NOTE_TOOL = {
    name: 'note_pages',
    description:
      'After reading pages as pictures, save short notes on each page (what it teaches, key definitions and formulas, worked examples, exercise numbers and what they ask). Next time anyone asks about these pages you get your notes instead of the pictures, which is much cheaper. Under 150 words per page.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        notes: { type: 'array', items: { type: 'object', properties: { page: { type: 'integer' }, text: { type: 'string' } }, required: ['page', 'text'] }, maxItems: 10 },
      },
      required: ['file_id', 'notes'],
    },
  };
  const MAX_LOOKS = 4;

  function createSystem(ctx, books = []) {
    return `You are Prof, the teaching assistant inside StudyBridge, working for the tutor ${ctx.tutor?.name || ''}.
You make DRAFT assignments and lessons. The tutor reviews and approves everything; nothing you make reaches a learner until they do. You never talk to learners.

How to work:
1. Read the tutor's request. Use the subjects, topics and learners below (use their ids). If the tutor names a learner, set learner_ids.
2. For an assignment: call start_assignment, then add_questions with AT MOST 8 questions per call (call it again for more), then finish.
3. For a lesson: call create_lesson, then finish.
4. If details are missing (topic, how many questions, due date), make sensible choices and go ahead: use the learner's subjects, level and topics_needing_work, about 8 questions, no due date. Say in finish what you assumed so the tutor can ask for changes. Only finish with a question instead if you truly can't make anything useful.
${books.length ? `5. The tutor chose whole books (below). Find the right pages from the outline or the contents pages, then call look_at_pages to read them before writing questions. Base the work on what those pages teach. Use look_at_pages at most ${MAX_LOOKS} times.
6. When look_at_pages gives you pictures, also call note_pages (in the same reply as your next step) with short notes on each page. If it gives you your earlier notes instead, work from them; ask again with pictures: true only if you truly need to see a diagram.
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
      const qs = (input.questions || []).slice(0, 8);
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
    if (name === 'note_pages') {
      const book = (job.context?.books || []).find((b) => b.file_id === input.file_id);
      if (!book) throw new Error('Unknown file_id: use one from the books listed.');
      const rows = (input.notes || [])
        .filter((n) => Number.isInteger(n.page) && n.page >= 1 && n.page <= book.pages && n.text)
        .slice(0, 10)
        .map((n) => ({ file_id: book.file_id, page: n.page, tutor_id: job.tutor_id, notes: String(n.text).slice(0, 1500) }));
      if (rows.length) await rest('book_notes?on_conflict=file_id,page', { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' });
      return { saved: rows.length };
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
      max_tokens: 12000,
      system: [{ type: 'text', text: createSystem(ctx, books), cache_control: { type: 'ephemeral' } }],
      tools: books.length ? [...CREATE_TOOLS, LOOK_TOOL, NOTE_TOOL] : CREATE_TOOLS,
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
        if (why) {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: why, is_error: true });
          continue;
        }
        // Pages Prof has read before: its notes, straight away and much cheaper than pictures
        if (!u.input?.pictures) {
          const notes = await rest(`book_notes?file_id=eq.${book.file_id}&page=in.(${pages.join(',')})&select=page,notes`).catch(() => []);
          if (notes.length === pages.length) {
            st.looks = (st.looks || 0) + 1;
            st.notes_used = (st.notes_used || 0) + pages.length;
            results.push({
              type: 'tool_result',
              tool_use_id: u.id,
              content: `Your notes from reading these pages before (ask with pictures: true if you need to see them):\n${notes
                .sort((a, b) => a.page - b.page)
                .map((n) => `PDF page ${n.page}: ${n.notes}`)
                .join('\n')}`,
            });
            continue;
          }
        }
        look = { tool_use_id: u.id, file_id: book.file_id, name: book.name, pages, why: String(u.input?.why || '').slice(0, 120) };
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
    if (cut) next.push({ type: 'text', text: 'Your last reply was cut off. Add fewer questions per call (at most 4).' });
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
      // only questions still waiting (one approved meanwhile is left as the person decided)
      await rest(`bank_questions?id=eq.${r.id}&status=eq.review`, { method: 'PATCH', body: { check_result: { ok: !!x.agrees, my_answer: String(x.my_answer || '').slice(0, 300), note: String(x.note || '').slice(0, 400) } } });
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

  // ---------------- weekly parent reports ----------------
  const REPORT_TOOL = {
    name: 'write_report',
    description: 'The words of the weekly report. The tutor checks and edits them before sending.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One sentence: how the week went, with one concrete fact' },
        comment: { type: 'string', description: '2–4 sentences from the tutor to the parent: what went well, what to work on, specific and kind' },
        next_week: { type: 'string', description: '1–3 short lines: what’s coming next week and what to practise at home' },
      },
      required: ['summary', 'comment', 'next_week'],
    },
  };
  async function stepReport(job, cfg) {
    const rep = (await rest(`parent_reports?id=eq.${job.context?.report_id}&select=*`))[0];
    if (!rep || rep.status !== 'draft') throw new Error('That report has already been sent or deleted.');
    await save(job, 'running', { p_progress: 'Writing the report…', p_input: 0 });
    const style = (await rest(`prof_settings?tutor_id=eq.${job.tutor_id}&select=style_md`))[0]?.style_md || '';
    const d = rep.data || {};
    const res = await claude(cfg, {
      max_tokens: 1500,
      system: `You draft the weekly report a tutor sends to a learner's parent. Write as the tutor (${d.tutor || 'the tutor'}), in the first person, to ${d.parent || 'the parent'}.
Warm, honest and specific; plain words, no jargon; short. Use ONLY facts in the data (never invent marks, lessons or behaviour). If work was missing or late, say so kindly and say what will help. Mention effort where the data shows it (time studied, practice tries). Topics with a low ratio are ones to work on; high ratio are strengths.${style ? `\nThe tutor's own instructions:\n${style}` : ''}`,
      tools: [REPORT_TOOL],
      tool_choice: { type: 'tool', name: 'write_report' },
      messages: [{ role: 'user', content: `This week's data for ${d.learner || 'the learner'}:\n${JSON.stringify(d)}` }],
    });
    const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'write_report');
    if (!call) throw new Error('Prof didn’t write the report. Try again.');
    const x = call.input || {};
    await rest(`parent_reports?id=eq.${rep.id}`, {
      method: 'PATCH',
      body: { summary: String(x.summary || '').slice(0, 600), comment: String(x.comment || '').slice(0, 2000), next_week: String(x.next_week || '').slice(0, 1000), prof: true, updated_at: new Date().toISOString() },
    });
    await save(job, 'done', {
      ...usageArgs(cfg, res.usage),
      p_result: { report_id: rep.id, reply: String(x.summary || '') },
      p_progress: 'Ready for you to check and send',
      p_notify: { title: `Prof drafted ${d.learner || 'a'} weekly report`, body: String(x.summary || '').slice(0, 220), ref: { report_id: rep.id, learner_id: rep.learner_id } },
    });
  }

  // ---------------- syllabus ----------------
  const SYLLABUS_TOOL = {
    name: 'save_syllabus',
    description: 'The syllabus as topics, in the order the syllabus gives them. The tutor checks it before using it.',
    input_schema: {
      type: 'object',
      properties: {
        topics: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'The board’s own number for the topic (e.g. "C2", "1", "SL 1.3"), if the syllabus numbers its topics' },
              name: { type: 'string', description: 'Topic name as the syllabus words it' },
              details: { type: 'array', items: { type: 'string' }, description: 'Its subtopics / what learners must know, as short phrases (3–12)' },
            },
            required: ['name'],
          },
        },
        note: { type: 'string', description: 'One or two sentences for the tutor: which syllabus (and exam years) this follows, and anything to check against the official document' },
      },
      required: ['topics'],
    },
  };
  async function stepSyllabus(job, cfg) {
    const c = job.context || {};
    const src = c.source || null;
    await save(job, 'running', { p_progress: src ? 'Reading the syllabus document…' : 'Setting out the syllabus…', p_input: 0 });
    // the tutor's own syllabus document: its text, or pictures of a scanned one
    let doc = '';
    const pages = src?.pages || [];
    if (src?.text_path) {
      const f = await download('library', src.text_path);
      doc = f ? new TextDecoder().decode(f.bytes).slice(0, 180000) : '';
    }
    const ask = `Subject in StudyBridge: ${c.subject || ''}.${c.label ? ` Exam / syllabus: ${c.label}.` : ''}${c.note ? `\nThe tutor adds: ${c.note}` : ''}`;
    const content = src
      ? [
          { type: 'text', text: `${ask}\n\nThe tutor's own copy of the official syllabus document${src.name ? ` (“${src.name}”)` : ''} follows${doc ? ' as text' : ` as ${pages.length} page picture${pages.length === 1 ? '' : 's'}`}. Set out the subject content from it.${doc ? `\n\n<syllabus>\n${doc}\n</syllabus>` : ''}` },
          ...pages.map((pg) => ({ type: 'sb_image', bucket: 'library', path: pg.path })),
        ]
      : ask;
    const res = await claude(cfg, {
      max_tokens: 12000,
      system: src
        ? `You help tutors on StudyBridge set up a subject from the official syllabus document they uploaded. Set out its subject content as the main topics, in the document's own order and numbering, each with its subtopics or learning objectives as short phrases (keep the document's sub-numbers, e.g. "2.3 Simultaneous equations").
Rules: use only what the document says; leave out assessment details, command words and admin pages; mark higher-tier/HL/Extended-only content in the subtopic text (e.g. "(Extended)"); up to 40 topics. In note, say which syllabus and exam years the document is for, and anything you couldn't read.`
        : `You help tutors on StudyBridge set up a subject. Set out the official syllabus for ${c.label} as its main topics, in the syllabus's own order and numbering where it has them, each with its subtopics or learning objectives as short phrases.
Rules: follow the official syllabus as closely as you know it; don't add content that isn't in it; separate higher-tier/HL/Extended-only content clearly in the subtopic text (e.g. "(Extended)", "(HL)"); 6–25 topics. In note, say which syllabus version/exam years it follows and remind the tutor to check it against the official document.`,
      tools: [SYLLABUS_TOOL],
      tool_choice: { type: 'tool', name: 'save_syllabus' },
      messages: [{ role: 'user', content: src ? await expandBlocks(content) : content }],
    });
    if (src) await removeFiles('library', [...(src.text_path ? [src.text_path] : []), ...pages.map((pg) => pg.path)]);
    const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_syllabus');
    const topics = (call?.input?.topics || [])
      .filter((t) => t && t.name)
      .slice(0, 40)
      .map((t) => ({ code: String(t.code || '').slice(0, 20) || null, name: String(t.name).slice(0, 160), details: (Array.isArray(t.details) ? t.details : []).map((d) => String(d).slice(0, 200)).slice(0, 30) }));
    if (!topics.length) throw new Error(src ? 'Prof couldn’t find the subject content in that document. Check it’s the syllabus PDF, or name the exam instead.' : 'Prof couldn’t set out that syllabus. Try naming the exam and its code, e.g. “Cambridge IGCSE International Mathematics 0607”.');
    await save(job, 'done', {
      ...usageArgs(cfg, res.usage),
      p_result: { syllabus: { subject_id: c.subject_id, topics, note: String(call.input.note || '').slice(0, 600) }, reply: `${topics.length} topics${c.label ? ` for ${c.label}` : src?.name ? ` from ${src.name}` : ''}` },
      p_progress: 'Ready for you to check',
      p_notify: { title: `Prof set out the syllabus for ${c.subject || c.label}`, body: `${topics.length} topics. Check them and choose “Use these”.`, ref: { syllabus: true, subject_id: c.subject_id } },
    });
  }

  // ---------------- grade boundaries ----------------
  // Prof reads the tutor's own grade-threshold document (pictures of its pages) and copies the numbers
  // out. Nothing is saved: the tutor checks every number, then saves the ones they want.
  const BOUNDARIES_TOOL = {
    name: 'save_boundaries',
    description: 'The grade thresholds as printed in the document. Copy the numbers exactly; never guess one that isn’t printed.',
    input_schema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The exam series the document is for, e.g. "June 2025" or "May 2024"' },
        options: {
          type: 'array',
          description: 'One entry per row of overall thresholds (each syllabus option / tier / level)',
          items: {
            type: 'object',
            properties: {
              option: { type: 'string', description: 'The option as the document names it, e.g. "Extended (BX: papers 2, 4, 6)" or "HL"' },
              max_mark: { type: 'number', description: 'The maximum (total) mark the thresholds are out of' },
              grades: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { grade: { type: 'string' }, min: { type: 'number', description: 'Lowest mark for this grade' } },
                  required: ['grade', 'min'],
                },
              },
            },
            required: ['option', 'max_mark', 'grades'],
          },
        },
        note: { type: 'string', description: 'One or two sentences for the tutor: anything unclear, and a reminder to check the numbers against the document' },
      },
      required: ['options'],
    },
  };
  async function stepBoundaries(job, cfg) {
    const c = job.context || {};
    const pages = c.pages || [];
    await save(job, 'running', { p_progress: 'Reading the grade thresholds…', p_input: 0 });
    const content = [
      {
        type: 'text',
        text: `The tutor's own grade-threshold document${c.label ? ` for ${c.label}` : ''} follows as ${pages.length} page picture${pages.length === 1 ? '' : 's'}. Copy out the overall grade thresholds (the total marks for each grade), one entry per option/tier/level.`,
      },
      ...pages.map((p) => ({ type: 'sb_image', bucket: 'library', path: p.path })),
    ];
    const res = await claude(cfg, {
      max_tokens: 4000,
      system: `You help a tutor on StudyBridge read an official grade-threshold document. Copy the overall thresholds exactly as printed: the maximum mark and the lowest mark for each grade, highest grade first. Use the overall (total) thresholds, not the per-component ones, unless only component thresholds are printed. Don't invent or estimate numbers; leave out anything you can't read and say so in note.`,
      tools: [BOUNDARIES_TOOL],
      tool_choice: { type: 'tool', name: 'save_boundaries' },
      messages: [{ role: 'user', content: await expandBlocks(content) }],
    });
    await removeFiles('library', pages.map((p) => p.path));
    const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_boundaries');
    const options = (call?.input?.options || [])
      .map((o) => ({
        option: String(o?.option || '').slice(0, 120),
        max_mark: Number(o?.max_mark),
        grades: (Array.isArray(o?.grades) ? o.grades : [])
          .map((g) => ({ grade: String(g?.grade || '').trim().slice(0, 8), min: Number(g?.min) }))
          .filter((g) => g.grade && Number.isFinite(g.min) && g.min >= 0)
          .slice(0, 12),
      }))
      .filter((o) => Number.isFinite(o.max_mark) && o.max_mark > 0 && o.grades.length && o.grades.every((g) => g.min <= o.max_mark))
      .slice(0, 12);
    if (!options.length) throw new Error('Prof couldn’t read grade thresholds from those pages. Check it’s the grade-threshold document, or type the numbers in yourself.');
    const session = String(call.input.session || '').slice(0, 60);
    await save(job, 'done', {
      ...usageArgs(cfg, res.usage),
      p_result: { boundaries: { exam: c.exam, label: c.label || '', session, options, note: String(call.input.note || '').slice(0, 600) }, reply: `${options.length} set${options.length === 1 ? '' : 's'} of grade thresholds${session ? ` for ${session}` : ''}` },
      p_progress: 'Ready for you to check',
      p_notify: { title: `Prof read the grade thresholds${session ? ` for ${session}` : ''}`, body: 'Check the numbers against the document, then save the ones you want.', ref: { boundaries: true, exam: c.exam } },
    });
  }

  // ---------------- teaching plans ----------------
  const TEACHING_PLAN_TOOL = {
    name: 'save_teaching_plan',
    description: 'The teaching plan: one entry per period (week, month or chapter), in teaching order. The tutor checks and edits it.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'e.g. "Week 3", "October", "Chapter 2: Algebra", "Revision"' },
              starts_on: { type: 'string', description: 'YYYY-MM-DD' },
              ends_on: { type: 'string', description: 'YYYY-MM-DD' },
              topics: { type: 'array', items: { type: 'string' }, description: 'Topic names exactly as in the list given (empty for revision or holiday periods)' },
              focus: { type: 'string', description: 'What to teach in this period, one short sentence (subtopics, skills)' },
              notes: { type: 'string', description: 'Optional: homework, a quiz, a mock, past-paper practice' },
            },
            required: ['label', 'starts_on', 'ends_on', 'topics'],
          },
        },
        note: { type: 'string', description: 'One or two sentences for the tutor about how the time was shared out' },
      },
      required: ['items'],
    },
  };
  async function stepPlan(job, cfg) {
    const c = job.context || {};
    await save(job, 'running', { p_progress: 'Planning…', p_input: 0 });
    const style = (await rest(`prof_settings?tutor_id=eq.${job.tutor_id}&select=style_md`))[0]?.style_md || '';
    const names = (c.topics || []).map((t) => t.name);
    const per = c.kind === 'week' ? 'one entry per week (Monday to Sunday)' : c.kind === 'month' ? 'one entry per calendar month' : 'one entry per topic or chapter, each with its own dates';
    const res = await claude(cfg, {
      max_tokens: 12000,
      system: `You help a tutor on StudyBridge plan a course. Make a teaching plan from ${c.start} to ${c.end}, ${per}, covering every topic in the syllabus list in a sensible teaching order (the syllabus order unless a different order clearly helps). Give bigger topics (more subtopics) more time and lighter ones less. If the end date is an exam, leave the last part for revision and past papers.${c.lessons_per_week ? ` There are ${c.lessons_per_week} lesson(s) a week.` : ''} Use topic names exactly as given. Keep each focus to one short sentence.${style ? `\nThe tutor's own instructions:\n${style}` : ''}`,
      tools: [TEACHING_PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'save_teaching_plan' },
      messages: [{ role: 'user', content: `Subject: ${c.subject}${c.exam ? ` (${c.exam})` : ''}.${c.note ? `\nThe tutor adds: ${c.note}` : ''}\nSyllabus topics in order:\n${(c.topics || []).map((t) => `- ${t.code ? t.code + ' ' : ''}${t.name}${t.details?.length ? `: ${t.details.slice(0, 12).join('; ')}` : ''}`).join('\n')}` }],
    });
    const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_teaching_plan');
    const ymd = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : null);
    const items = (call?.input?.items || [])
      .filter((x) => x && x.label && ymd(x.starts_on) && ymd(x.ends_on))
      .slice(0, 120)
      .map((x) => ({
        label: String(x.label).slice(0, 80),
        starts_on: ymd(x.starts_on),
        ends_on: ymd(x.ends_on),
        topics: (Array.isArray(x.topics) ? x.topics : []).map((t) => String(t)).filter((t) => names.includes(t)).slice(0, 12),
        focus: String(x.focus || '').slice(0, 300),
        notes: String(x.notes || '').slice(0, 300),
      }));
    if (!items.length) throw new Error('Prof couldn’t make a plan. Try different dates, or spread the topics evenly instead.');
    await save(job, 'done', {
      ...usageArgs(cfg, res.usage),
      p_result: { plan: { subject_id: c.subject_id, kind: c.kind, starts_on: c.start, ends_on: c.end, lessons_per_week: c.lessons_per_week || null, items, note: String(call.input.note || '').slice(0, 600) }, reply: `A ${c.kind === 'week' ? 'week-by-week' : c.kind === 'month' ? 'month-by-month' : 'chapter-by-chapter'} plan for ${c.subject}: ${items.length} parts` },
      p_progress: 'Ready for you to check',
      p_notify: { title: `Prof planned ${c.subject}`, body: `${items.length} parts. Check it and choose “Use this plan”.`, ref: { syllabus: true, subject_id: c.subject_id, plan: true } },
    });
  }

  // ---------------- flashcards ----------------
  const CARDS_TOOL = {
    name: 'save_cards',
    description: 'Flashcards for the tutor to pick from. Front: a short prompt; back: the answer.',
    input_schema: {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              front: { type: 'string', description: 'A short question, term or prompt (Markdown, LaTeX in $...$)' },
              back: { type: 'string', description: 'The answer: a definition, formula, method or worked step (Markdown, LaTeX in $...$), short' },
            },
            required: ['front', 'back'],
          },
        },
      },
      required: ['cards'],
    },
  };
  async function stepCards(job, cfg) {
    const c = job.context || {};
    await save(job, 'running', { p_progress: 'Writing flashcards…', p_input: 0 });
    const style = (await rest(`prof_settings?tutor_id=eq.${job.tutor_id}&select=style_md`))[0]?.style_md || '';
    const [board, code] = String(c.exam || '').split(':');
    const where = board === 'cie' ? `Cambridge IGCSE ${code}` : board === 'ib' ? `IB Diploma (${code})` : c.subject;
    const res = await claude(cfg, {
      max_tokens: 6000,
      system: `You write revision flashcards for StudyBridge, for a learner studying ${where}. The tutor picks which ones to use.
Rules: one idea per card; the front is a short prompt (a question, key term, "formula for…", "how do you…"), the back is a short, exact answer in the syllabus's own terms. Cover definitions, formulas, key facts, methods and common mistakes for the topic. Markdown with LaTeX in $...$. No images.${style ? `\nThe tutor's own instructions:\n${style}` : ''}`,
      tools: [CARDS_TOOL],
      tool_choice: { type: 'tool', name: 'save_cards' },
      messages: [{ role: 'user', content: `Write ${c.count || 12} flashcards on: ${c.topic}.${c.note ? `\nThe tutor adds: ${c.note}` : ''}` }],
    });
    const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_cards');
    const cards = (call?.input?.cards || [])
      .filter((x) => x && x.front && x.back)
      .slice(0, 40)
      .map((x) => ({ front: String(x.front).slice(0, 1000), back: String(x.back).slice(0, 3000) }));
    if (!cards.length) throw new Error('Prof didn’t write any cards. Try again.');
    await save(job, 'done', {
      ...usageArgs(cfg, res.usage),
      p_result: { cards: { subject_id: c.subject_id, topic: c.topic, list: cards }, reply: `${cards.length} flashcards on ${c.topic}` },
      p_progress: 'Ready for you to pick',
      p_notify: { title: `Prof wrote ${cards.length} flashcards on ${c.topic}`, body: 'Pick the ones to give your learners.', ref: { cards: true, subject_id: c.subject_id } },
    });
  }

  // ---------------- StudyBridge practice papers ----------------
  const PLAN_TOOL = {
    name: 'save_plan',
    description: 'The written exam papers this syllabus has, as they are assessed now.',
    input_schema: {
      type: 'object',
      properties: {
        components: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              paper: { type: 'string', description: 'Paper number/code as the board uses it, e.g. "1", "2", "4", "3"' },
              level: { type: 'string', description: 'IB only: "SL" or "HL" (one entry per level that sits this paper). Empty for IGCSE.' },
              name: { type: 'string', description: 'e.g. "Paper 4 (Extended)", "Paper 1 (no calculator)"' },
              duration_min: { type: 'integer' },
              marks: { type: 'integer' },
              writable: { type: 'boolean', description: 'false if it can’t be written well as text: listening/audio, practical, coursework/IA, set-text or case-study material we can’t supply, or source papers that need real historical documents' },
              why_not: { type: 'string', description: 'If not writable: why, in a few words' },
              structure: { type: 'string', description: 'Sections, number and style of questions, calculator rules: enough to write a paper in this exact format' },
            },
            required: ['paper', 'name', 'writable'],
          },
        },
        note: { type: 'string', description: 'Which syllabus version/exam years this is for; anything to check' },
      },
      required: ['components'],
    },
  };
  const OUTLINE_TOOL = {
    name: 'save_outline',
    description: 'The plan of the paper before writing it.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        duration_min: { type: 'integer' },
        total_marks: { type: 'integer' },
        instructions: { type: 'string', description: 'Instructions to candidates, as on the front of a real paper (Markdown)' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'e.g. "1", "2(a)", "2(b)(i)", "Section A, Q3"' },
              topic: { type: 'string' },
              marks: { type: 'number' },
              plan: { type: 'string', description: 'What this part asks, in a few words' },
            },
            required: ['label', 'marks', 'plan'],
          },
        },
      },
      required: ['questions', 'total_marks'],
    },
  };
  const ITEMS_TOOL = {
    name: 'save_items',
    description: 'Fully written parts of the paper, in order.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              stem: { type: 'string', description: 'Shared lead-in for a multi-part question; only on its first part' },
              prompt: { type: 'string', description: 'The part’s question (Markdown, LaTeX in $...$)' },
              type: { type: 'string', enum: ['numeric', 'mcq', 'steps', 'short', 'upload'] },
              options: { type: 'array', items: { type: 'string' }, description: 'mcq only' },
              correct: { type: 'array', items: { type: 'integer' }, description: 'mcq only: zero-based correct indexes' },
              answer: { type: 'string', description: 'numeric: the number; steps: final line in LaTeX; short: model answer; upload (long/extended answers): leave empty' },
              tolerance: { type: 'number' },
              unit: { type: 'string' },
              marks: { type: 'number' },
              topic: { type: 'string' },
              mark_scheme: { type: 'string', description: 'Exam-board style (M1/A1/B1 for maths; marking points/levels for essays)' },
              solution: { type: 'string', description: 'A worked solution or model answer' },
            },
            required: ['label', 'prompt', 'type', 'marks', 'mark_scheme'],
          },
        },
      },
      required: ['items'],
    },
  };
  const paperWhere = (c) => `${c.board === 'ib' ? 'IB Diploma' : 'Cambridge IGCSE'} ${c.label || c.code}${c.level ? ' ' + c.level : ''} ${c.name || 'Paper ' + c.paper}`;
  const PAPER_RULES = `Rules:
- ENTIRELY ORIGINAL: new questions, numbers, contexts and texts. Never reproduce, adapt or lightly reword a real past-paper question you remember.
- Same format as the real paper: sections, number of questions and parts, marks per part, total marks, command terms, difficulty curve, calculator rules.
- Text only: no diagrams, graphs or images. Where the real paper would use a diagram, describe it fully in words or choose a question that doesn't need one.
- Never invent quotations from real people, publications or historical documents. Reading passages you write must be clearly fictional or general (no real named authors).
- Markdown with LaTeX in $...$ and $$...$$ (never \\( \\)).`;

  async function stepPaper(job, cfg) {
    const c = job.context || {};
    if (job.steps >= MAX_STEPS) throw new Error('Prof stopped: this paper took too many steps.');
    if (c.mode === 'plan') {
      await save(job, 'running', { p_progress: 'Working out the papers…', p_input: 0 });
      const res = await claude(cfg, {
        max_tokens: 5000,
        system: `You know exam assessment structures. List the written examination papers of ${c.board === 'ib' ? 'the IB Diploma subject' : 'Cambridge IGCSE syllabus'} ${c.label} as currently assessed (latest syllabus), with duration, marks and the structure of each. For the IB, give one entry per level (SL/HL) that sits each paper. Mark as not writable anything that can't be written well as plain text (listening, practical, coursework/IA, papers built on pre-released or set texts/case studies we can't supply, source-based papers that need real historical documents).`,
        tools: [PLAN_TOOL],
        tool_choice: { type: 'tool', name: 'save_plan' },
        messages: [{ role: 'user', content: `Exam: ${c.label} (${c.board === 'ib' ? 'IB Diploma' : 'Cambridge IGCSE ' + c.code})` }],
      });
      const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_plan');
      const comps = (call?.input?.components || []).filter((x) => x && x.paper).slice(0, 20).map((x) => ({
        paper: String(x.paper).slice(0, 10), level: ['SL', 'HL'].includes(x.level) ? x.level : null, name: String(x.name || 'Paper ' + x.paper).slice(0, 100),
        duration_min: Number.isFinite(x.duration_min) ? x.duration_min : null, marks: Number.isFinite(x.marks) ? x.marks : null,
        writable: x.writable !== false, why_not: x.why_not ? String(x.why_not).slice(0, 200) : null, structure: String(x.structure || '').slice(0, 1500),
      }));
      if (!comps.length) throw new Error(`Prof couldn’t work out the papers for ${c.label}.`);
      await rest(`sb_paper_plans?on_conflict=board,code`, {
        method: 'POST', prefer: 'resolution=merge-duplicates',
        body: { board: c.board, code: c.code, components: comps, note: String(call.input.note || '').slice(0, 500), updated_at: new Date().toISOString() },
      });
      await save(job, 'done', { ...usageArgs(cfg, res.usage), p_result: { reply: `${comps.length} papers for ${c.label}` }, p_progress: 'Done' });
      return;
    }
    // writing one paper: outline, then the parts in batches, then an independent check
    const paper = (await rest(`sb_papers?id=eq.${c.paper_id}&select=*`))[0];
    if (!paper) {
      await save(job, 'done', { p_result: { reply: 'Paper was deleted' }, p_progress: 'Deleted', p_input: 0 });
      return;
    }
    const st = job.state && job.state.phase ? job.state : { phase: 'outline', next: 0 };
    const where = paperWhere(c);
    if (st.phase === 'outline') {
      const others = await rest(`sb_papers?board=eq.${c.board}&code=eq.${encodeURIComponent(c.code)}&paper=eq.${encodeURIComponent(c.paper)}&id=neq.${paper.id}&select=items&limit=5`);
      const seen = others.flatMap((p) => (p.items || []).map((i) => String(i.topic || '') + ': ' + String(i.prompt || '').slice(0, 60))).slice(0, 60);
      const res = await claude(cfg, {
        max_tokens: 5000,
        system: `You are writing StudyBridge practice paper ${c.number} for ${where}${c.duration_min ? ` (${c.duration_min} minutes` + (c.marks ? `, ${c.marks} marks)` : ')') : ''}. First plan it.\n${PAPER_RULES}${c.structure ? `\nThe real paper's format: ${c.structure}` : ''}`,
        tools: [OUTLINE_TOOL],
        tool_choice: { type: 'tool', name: 'save_outline' },
        messages: [{ role: 'user', content: `Plan the whole paper: every question and part with its marks, covering the syllabus like a real paper.${seen.length ? `\nOther StudyBridge papers for this already cover (vary from them):\n${seen.join('\n')}` : ''}` }],
      });
      const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_outline');
      const qs = (call?.input?.questions || []).filter((x) => x && x.label).slice(0, 80);
      if (!qs.length) throw new Error('Prof couldn’t plan this paper.');
      await rest(`sb_papers?id=eq.${paper.id}`, {
        method: 'PATCH',
        body: { title: String(call.input.title || paper.title).slice(0, 200), duration_min: call.input.duration_min || c.duration_min || null, total_marks: call.input.total_marks || qs.reduce((a, q) => a + Number(q.marks || 0), 0), instructions_md: String(call.input.instructions || '').slice(0, 3000), items: [] },
      });
      await save(job, 'queued', { ...usageArgs(cfg, res.usage), p_state: { phase: 'write', outline: qs, next: 0, tries: 0 }, p_progress: `Planned ${qs.length} parts; writing…` });
      return;
    }
    if (st.phase === 'write') {
      const batch = st.outline.slice(st.next, st.next + 6);
      const res = await claude(cfg, {
        max_tokens: 12000,
        system: `You are writing StudyBridge practice paper ${c.number} for ${where}.\n${PAPER_RULES}
Question types: numeric (one number: answer, tolerance if rounding, unit), mcq (options + correct indexes), steps (maths working; answer = final line in LaTeX), short (brief answer; answer = model answer), upload (extended/essay answers written on paper; give a full mark scheme and a model answer in solution).
Give each part an exam-board style mark scheme and a worked solution. Double-check every answer.`,
        tools: [ITEMS_TOOL],
        tool_choice: { type: 'tool', name: 'save_items' },
        messages: [{ role: 'user', content: `The paper's plan:\n${st.outline.map((q) => `${q.label} [${q.marks}] ${q.topic ? q.topic + ': ' : ''}${q.plan}`).join('\n')}\n\nWrite these parts in full now: ${batch.map((q) => q.label).join(', ')}.` }],
      });
      const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_items');
      const items = (call?.input?.items || []).filter((x) => x && x.prompt).slice(0, 10).map((x) => ({
        label: String(x.label || '').slice(0, 30), stem: x.stem ? String(x.stem).slice(0, 4000) : null, prompt: String(x.prompt).slice(0, 4000),
        type: ['numeric', 'mcq', 'steps', 'short', 'upload'].includes(x.type) ? x.type : 'upload',
        options: x.type === 'mcq' && Array.isArray(x.options) ? x.options.map((o) => String(o).slice(0, 500)).slice(0, 8) : [],
        answer: x.type === 'mcq' ? { choices: (x.correct || []).filter((n) => Number.isInteger(n)) } : x.type === 'numeric' ? { value: String(x.answer || ''), tolerance: x.tolerance ? String(x.tolerance) : '0', unit: x.unit || '' } : x.type === 'steps' ? { final: String(x.answer || '') } : x.type === 'short' ? { text: String(x.answer || '') } : {},
        marks: Number(x.marks) >= 0 ? Number(x.marks) : 1, topic: x.topic ? String(x.topic).slice(0, 120) : null,
        mark_scheme: String(x.mark_scheme || '').slice(0, 4000), solution: x.solution ? String(x.solution).slice(0, 6000) : null,
      }));
      if (!items.length) {
        // nothing usable came back: try these parts again (a few times), then give up on the paper
        const tries = (st.tries || 0) + 1;
        const labels = batch.map((q) => q.label).join(', ');
        if (tries > 3) {
          await save(job, 'failed', { ...usageArgs(cfg, res.usage), p_error: `Prof couldn’t write parts ${labels}.` });
          return;
        }
        await save(job, 'queued', { ...usageArgs(cfg, res.usage), p_state: { ...st, tries }, p_progress: `Trying parts ${labels} again…`, p_retry_in: 10 });
        return;
      }
      const now = (await rest(`sb_papers?id=eq.${paper.id}&select=items`))[0]?.items || [];
      await rest(`sb_papers?id=eq.${paper.id}`, { method: 'PATCH', body: { items: [...now, ...items] } });
      const next = st.next + batch.length;
      const phase = next >= st.outline.length ? 'check' : 'write';
      await save(job, 'queued', { ...usageArgs(cfg, res.usage), p_state: { ...st, phase, next, tries: 0 }, p_progress: `Writing (${Math.min(next, st.outline.length)} of ${st.outline.length} parts)…` });
      return;
    }
    // independent check of everything with a definite answer
    const items = paper.items || [];
    if (!items.length) throw new Error('Prof couldn’t write this paper.');
    const checkable = items.map((x, i) => ({ ...x, n: i + 1 })).filter((x) => x.type !== 'upload');
    let flagged = 0;
    const notes = [];
    let usage = {};
    if (checkable.length) {
      const res = await claude(cfg, {
        max_tokens: 8000,
        system: `You are a careful exam checker for ${where}. For each part, first solve it yourself, then compare with the stated answer and mark scheme. Agree only if the stated answer is correct, the mark scheme fits, and the part is clear and solvable from its text.`,
        tools: [CHECK_TOOL],
        tool_choice: { type: 'tool', name: 'submit_checks' },
        messages: [{ role: 'user', content: JSON.stringify(checkable.map((x) => ({ number: x.n, label: x.label, stem: x.stem, question: x.prompt, type: x.type, options: x.options, marks: x.marks, stated_answer: x.answer, mark_scheme: x.mark_scheme }))) }],
      });
      usage = res.usage;
      const call = (res.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_checks');
      for (const x of call?.input?.checks || []) {
        const it = items[x.number - 1];
        if (!it) continue;
        it.check = { ok: !!x.agrees, my_answer: String(x.my_answer || '').slice(0, 300), note: String(x.note || '').slice(0, 400) };
        if (!x.agrees) {
          flagged++;
          notes.push(`${it.label}: ${it.check.note || 'answer disagrees'}`);
        }
      }
    }
    await rest(`sb_papers?id=eq.${paper.id}`, { method: 'PATCH', body: { items, status: 'review', flagged, check_note: notes.join('\n').slice(0, 2000) || null } });
    const msg = `${paper.title || 'Practice paper'}: ${items.length} parts${flagged ? `; the check flagged ${flagged}` : '; the check agreed with every answer'}.`;
    await save(job, 'done', {
      ...usageArgs(cfg, usage),
      p_state: { done: true },
      p_result: { paper: { id: paper.id }, reply: msg },
      p_progress: 'Ready to review',
      ...(flagged ? { p_notify: { title: 'A StudyBridge paper needs a look', body: msg, ref: { paper_id: paper.id } } } : {}),
    });
  }

  // ---------------- marking ----------------
  // "\n" written out instead of a real line break (maths like \neq or \nabla is left alone)
  const fixNewlines = (t) => String(t).replace(/\\r\\n/g, '\n').replace(/\\n(?![a-z])/g, '\n');

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
              marks: { type: 'number', description: 'Leave out if you cannot judge it (e.g. the handwriting is unreadable)' },
              feedback: { type: 'string', description: 'What was right or wrong and how to fix it, written to the learner. Never say what you could or could not see or read: that goes in tutor_note.' },
              read_as: { type: 'string', description: 'drawing and photo questions: the learner’s working and final answer as you read them, in plain words (e.g. "-3x(2x + 3)")' },
              tutor_note: { type: 'string', description: 'For the tutor only: anything to check, e.g. a line you could not read, or "worth a redo" if you think they should try it again' },
              mistake: { type: 'string', description: 'Short label for the main mistake, e.g. "Sign error expanding brackets". Leave out if none.' },
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
            ? { drawing: a.image ? 'drawn on screen: the picture of it follows below' : 'nothing drawn (no answer)' }
            : a;
      return { ...q, learner_answer: shown };
    });
    const content = [
      {
        type: 'text',
        text: `Mark this submission by ${mc.learner}: “${mc.assignment.title}” (${mc.assignment.kind}).
Questions of type mcq and numeric were marked automatically (auto_marks); include them only if the automatic mark looks wrong.
Include every short, steps, upload and drawing question. Follow the mark scheme. Give partial credit the way an examiner would. Feedback goes to the learner: kind, clear, specific.
Drawings and photos are handwriting: read them carefully, give read_as for each, and mark what is written. If part is unreadable, mark what you can and say what you couldn't read in tutor_note (never in the learner's feedback).
A question with no answer (nothing drawn, nothing written) gets 0 marks: say nothing about whether it saved or could be seen.
Write line breaks in feedback as real new lines, never as the characters \\n.
${mc.style ? `\nThe tutor's own instructions:\n${mc.style}\n` : ''}
${JSON.stringify({ assignment: mc.assignment, questions: qs, learner_notes: mc.learner_notes })}`,
      },
    ];
    let n = 0;
    for (const q of mc.questions) {
      if (q.type === 'drawing' && q.learner_answer?.image && n < 16) {
        content.push({ type: 'text', text: `The learner’s drawing for question ${q.number}:` });
        content.push({ type: 'sb_image', bucket: 'work', path: q.learner_answer.image });
        n++;
      }
      for (const f of q.learner_answer?.files || []) {
        if (n >= 16 || !f.path) continue;
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
        ...(x.feedback ? { feedback_md: fixNewlines(x.feedback) } : {}),
        ...(x.mistake ? { mistake: x.mistake } : {}),
        ...(Array.isArray(x.correct_steps) ? { step_marks: x.correct_steps.map((ok) => ({ ok: !!ok })) } : {}),
        ...(x.read_as || x.tutor_note ? { prof_note: [x.read_as ? `Read as: ${x.read_as}` : '', x.tutor_note || ''].filter(Boolean).join(' · ').slice(0, 600) } : {}),
      });
    }
    const d = await insert('claude_drafts', {
      tutor_id: mc.tutor_id,
      kind: 'marking',
      learner_id: mc.learner_id,
      attempt_id: mc.attempt_id,
      summary: inp.summary || null,
      payload: { marks, ...(inp.overall_feedback ? { feedback_md: fixNewlines(inp.overall_feedback) } : {}) },
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
      else if (job.kind === 'report') await stepReport(job, cfg);
      else if (job.kind === 'syllabus') await stepSyllabus(job, cfg);
      else if (job.kind === 'cards') await stepCards(job, cfg);
      else if (job.kind === 'paper') await stepPaper(job, cfg);
      else if (job.kind === 'boundaries') await stepBoundaries(job, cfg);
      else if (job.kind === 'plan') await stepPlan(job, cfg);
      else await stepCreate(job, cfg);
    } catch (e) {
      const tries = (job.state?.tries || 0) + 1;
      if (e.retry && tries <= 6) {
        await save(job, 'queued', { p_state: { ...(job.state || {}), tries }, p_progress: e.message, p_retry_in: e.retry, p_input: 0 });
      } else {
        console.error('Prof job failed', job.id, e);
        await save(job, 'failed', { p_error: String(e.message || e).slice(0, 500), p_input: 0 });
        await removeFiles('library', [...(job.context?.pages || []).map((p) => p.path), ...(job.context?.source?.pages || []).map((p) => p.path), ...(job.context?.source?.text_path ? [job.context.source.text_path] : []), ...(job.state?.uploaded || [])]);
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

  // A person's calendar link (live lessons and due dates) for Google / Apple / Outlook calendar
  const icsText = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const icsTime = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // lines are at most 75 bytes (not characters), never splitting a character
  const utf8 = new TextEncoder();
  const fold = (line) => {
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const n = utf8.encode(ch).length;
      if (bytes + n > 75) {
        out.push(cur);
        cur = ' ';
        bytes = 1;
      }
      cur += ch;
      bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  };
  async function calendar(token) {
    let feed = null;
    try {
      feed = await rpc('calendar_feed', { p_token: token });
    } catch {
      feed = null;
    }
    if (!feed) return new Response('Calendar not found. Get a new link in StudyBridge → Settings.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const now = icsTime(new Date());
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//StudyBridge//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(feed.name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
    for (const e of feed.events || []) {
      lines.push('BEGIN:VEVENT', `UID:${e.uid}@studybridge`, `DTSTAMP:${now}`, `DTSTART:${icsTime(e.start)}`, `DTEND:${icsTime(e.end)}`, `SUMMARY:${icsText(e.title)}`, `DESCRIPTION:${icsText(e.description)}`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return new Response(lines.map(fold).join('\r\n') + '\r\n', {
      status: 200,
      headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'max-age=900', 'content-disposition': 'inline; filename="studybridge.ics"' },
    });
  }

  // ---------------- payments (Stripe) and email (Resend), once the admin adds their keys ----------------
  const STRIPE = String(env('STRIPE_BASE_URL') || 'https://api.stripe.com').replace(/\/+$/, '');
  const RESEND = String(env('RESEND_BASE_URL') || 'https://api.resend.com').replace(/\/+$/, '');
  const WEB = String(env('WEB_APP_URL') || 'https://aaryanc-1.github.io/studybridge-releases/app/');
  async function sellingConfig() {
    const s = (await rest('platform_secrets?id=eq.1&select=stripe_secret,stripe_webhook_secret,resend_key'))[0] || {};
    const c = (await rest('app_config?id=eq.1&select=stripe_prices,email_from'))[0] || {};
    return { ...s, prices: c.stripe_prices || {}, from: c.email_from || null };
  }
  // Stripe takes form fields: { a: { b: 1 } } → a[b]=1
  function form(obj, prefix = '', out = new URLSearchParams()) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') form(v, key, out);
      else out.append(key, String(v));
    }
    return out;
  }
  async function stripe(secret, path, fields) {
    const r = await fetch(`${STRIPE}/v1/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form(fields).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error?.message || `Stripe error ${r.status}`);
    return data;
  }
  const safeReturn = (u) => {
    try {
      const x = new URL(String(u || ''));
      return x.protocol === 'https:' || x.hostname === 'localhost' || x.hostname === '127.0.0.1' ? x.toString() : WEB;
    } catch {
      return WEB;
    }
  };
  async function checkout(user, body) {
    const plan = ['starter', 'pro'].includes(body.plan) ? body.plan : null;
    const period = body.period === 'year' ? 'year' : 'month';
    if (!plan) return json({ error: 'Choose Starter or Pro.' }, 400);
    const cfg = await sellingConfig();
    const price = cfg.prices?.[`${plan}_${period}`];
    if (!cfg.stripe_secret || !price) return json({ error: 'Paid plans aren’t open yet.' }, 400);
    const me = (await rest(`profiles?id=eq.${user.id}&select=email,stripe_customer`))[0] || {};
    const back = safeReturn(body.return_url);
    const meta = { tutor: user.id, plan, period };
    const s = await stripe(cfg.stripe_secret, 'checkout/sessions', {
      mode: 'subscription',
      line_items: { 0: { price, quantity: 1 } },
      client_reference_id: user.id,
      ...(me.stripe_customer ? { customer: me.stripe_customer } : { customer_email: me.email }),
      metadata: meta,
      subscription_data: { metadata: meta },
      allow_promotion_codes: 'true',
      success_url: back,
      cancel_url: back,
    });
    return json({ url: s.url });
  }
  async function billing(user, body) {
    const cfg = await sellingConfig();
    const me = (await rest(`profiles?id=eq.${user.id}&select=stripe_customer`))[0] || {};
    if (!cfg.stripe_secret || !me.stripe_customer) return json({ error: 'There’s no paid plan to manage.' }, 400);
    const s = await stripe(cfg.stripe_secret, 'billing_portal/sessions', { customer: me.stripe_customer, return_url: safeReturn(body.return_url) });
    return json({ url: s.url });
  }
  async function hmacHex(secret, text) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Stripe tells us about payments here (signed with the webhook secret)
  async function stripeWebhook(req) {
    const raw = await req.text();
    const cfg = await sellingConfig();
    if (!cfg.stripe_webhook_secret) return json({ error: 'Not set up.' }, 400);
    const parts = Object.fromEntries((req.headers.get('stripe-signature') || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2));
    const sigs = (req.headers.get('stripe-signature') || '').split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
    const t = Number(parts.t || 0);
    if (!t || Math.abs(Date.now() / 1000 - t) > 300) return json({ error: 'Bad signature.' }, 400);
    const want = await hmacHex(cfg.stripe_webhook_secret, `${t}.${raw}`);
    if (!sigs.includes(want)) return json({ error: 'Bad signature.' }, 400);
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return json({ error: 'Bad event.' }, 400);
    }
    const o = ev?.data?.object || {};
    const m = o.metadata || {};
    const when = o.current_period_end ? new Date(o.current_period_end * 1000).toISOString() : null;
    if (ev.type === 'checkout.session.completed' && m.tutor) {
      await rpc('_set_paid_plan', { p_tutor: m.tutor, p_plan: m.plan, p_period: m.period, p_customer: o.customer || null, p_renews: null });
    } else if (ev.type === 'customer.subscription.updated' && m.tutor) {
      const live = ['active', 'trialing', 'past_due'].includes(o.status);
      await rpc('_set_paid_plan', { p_tutor: m.tutor, p_plan: live ? m.plan : 'free', p_period: live ? m.period : null, p_customer: o.customer || null, p_renews: live ? when : null });
    } else if (ev.type === 'customer.subscription.deleted' && m.tutor) {
      await rpc('_set_paid_plan', { p_tutor: m.tutor, p_plan: 'free', p_period: null, p_customer: o.customer || null, p_renews: null });
    }
    return json({ received: true });
  }
  // The weekly report by email, straight from StudyBridge (once there's a domain and a Resend key)
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const plain = (s) => String(s || '').replace(/\$([^$\n]+?)\$/g, (_, m) => m.replace(/\\[a-zA-Z]+/g, '').replace(/[{}]/g, '').replace(/\^2/g, '²').replace(/\^3/g, '³')).replace(/\*\*([^*]+)\*\*/g, '$1');
  async function emailReport(user, body) {
    const cfg = await sellingConfig();
    if (!cfg.resend_key || !cfg.from) return json({ error: 'Email isn’t set up yet.' }, 400);
    const r = (await rest(`parent_reports?id=eq.${encodeURIComponent(body.report_id || '')}&tutor_id=eq.${user.id}&select=*`))[0];
    if (!r || r.status !== 'sent') return json({ error: 'Approve the report first.' }, 400);
    const lr = (await rest(`learner_reports?learner_id=eq.${r.learner_id}&tutor_id=eq.${user.id}&select=enabled,parent_email,parent_name`))[0];
    if (!lr?.enabled || !lr.parent_email) return json({ error: 'There’s no parent email for this learner.' }, 400);
    const d = r.data || {};
    const work = (d.work || [])
      .map((w) => `<li>${esc(w.title)}${w.score != null && w.max ? ` — ${esc(w.score)}/${esc(w.max)}` : ''}</li>`)
      .join('');
    const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#1C1F23">
<div style="background:#0E6B6B;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase">Weekly report</div><div style="font-size:24px;font-weight:bold">${esc(d.learner)}</div><div>${esc(d.tutor || '')}</div></div>
<div style="border:1px solid #E3DED3;border-top:0;padding:18px 22px;border-radius:0 0 12px 12px">
<p><b>Lessons:</b> ${esc(d.lessons || 0)} · <b>Average mark:</b> ${d.avg_pct != null ? esc(d.avg_pct) + '%' : '—'}</p>
${r.comment ? `<p style="background:#E3F0EE;border-left:4px solid #0E6B6B;padding:10px 14px;border-radius:8px"><b>From ${esc(d.tutor || 'the tutor')}:</b><br>${esc(plain(r.comment))}</p>` : ''}
${work ? `<p><b>Work this week</b></p><ul>${work}</ul>` : ''}
${d.mock?.grade ? `<p><b>Latest mock:</b> ${esc(d.mock.title)}: grade ${esc(d.mock.grade)} (${esc(d.mock.pct)}%)</p>` : ''}
${d.exam?.date && d.exam.days >= 0 ? `<p><b>${esc(d.exam.name || 'Exam')}:</b> ${esc(d.exam.days)} days to go</p>` : ''}
${r.next_week ? `<p><b>Next week:</b> ${esc(plain(r.next_week))}</p>` : ''}
<p style="color:#5E6168;font-size:12px">Sent with StudyBridge</p></div></div>`;
    const res = await fetch(`${RESEND}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.resend_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: [lr.parent_email], subject: `Weekly report: ${d.learner || ''}`, html }),
    });
    if (!res.ok) return json({ error: `The email didn’t send (${res.status}).` }, 502);
    return json({ sent: true });
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!SB || !KEY) return json({ error: 'Prof is missing its Supabase settings.' }, 500);
    const reqUrl = new URL(req.url);
    if (req.method === 'GET' && reqUrl.searchParams.get('calendar')) return calendar(reqUrl.searchParams.get('calendar'));
    if (req.method === 'POST' && reqUrl.searchParams.get('stripe') === 'webhook') return stripeWebhook(req);
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
    if (action === 'checkout' || action === 'billing' || action === 'email_report') {
      if (!user || user.role !== 'tutor') return json({ error: 'Tutors only.' }, 403);
      try {
        return action === 'checkout' ? await checkout(user, body) : action === 'billing' ? await billing(user, body) : await emailReport(user, body);
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }
    if (action === 'kick') {
      if (user && user.role !== 'tutor' && !user.admin) return json({ error: 'Tutors only.' }, 403);
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
