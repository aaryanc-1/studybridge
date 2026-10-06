// A stand-in for the Claude API (Messages + tool use) that answers the way Claude
// would for Prof: makes a quiz in a few steps, and marks a submission.
import http from 'node:http';
import assert from 'node:assert/strict';

// ---------------- stand-in Claude ----------------
const seen = [];
let mode = 'ok'; // 'ok' | 'busy-once' | 'bad-key'
export const setMode = (m) => (mode = m);
export { seen };
export async function startFakeClaude() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    seen.push({ headers: req.headers, body });
    const send = (status, o) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (mode === 'bad-key') return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    // a model that refuses forced tool choices, and answers in text the first time without one
    if (mode === 'no-forced' || mode === 'no-forced-lazy') {
      if (body.tool_choice && ['tool', 'any'].includes(body.tool_choice.type))
        return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'tool_choice: type "tool" and "any" are not supported for this model.' } });
      if (mode === 'no-forced-lazy' && body.messages.length === 1) {
        mode = 'no-forced';
        return send(200, { role: 'assistant', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Here is the report…' }] });
      }
    }
    if (mode === 'busy-once') {
      mode = 'ok';
      return send(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    }
    try {
      send(200, reply(body));
    } catch (e) {
      send(500, { type: 'error', error: { type: 'api_error', message: 'stand-in Claude: ' + e.message } });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const usage = { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 3000 };
let n = 0;
const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input });
function reply(body) {
  const tools = body.tools.map((t) => t.name);
  if (tools.includes('submit_marking')) {
    const ctx = JSON.parse(body.messages[0].content[0].text.slice(body.messages[0].content[0].text.indexOf('{')));
    return {
      role: 'assistant',
      stop_reason: 'tool_use',
      usage,
      content: [
        tu(
          'submit_marking',
          {
            summary: 'Good algebra; the explanation needs a reason.',
            overall_feedback: 'Well done on the equation. Next time give a reason for each step.',
            questions: ctx.questions
              .filter((q) => !['mcq', 'numeric'].includes(q.type))
              .map((q) => ({ number: q.number, marks: q.type === 'steps' ? 3 : 1, feedback: 'Check your reasoning.', mistake: q.type === 'short' ? 'No reason given' : undefined, correct_steps: q.type === 'steps' ? [true, true] : undefined })),
          },
        ),
      ],
    };
  }
  if (tools.includes('save_plan')) {
    const ib = /IB Diploma/.test(body.messages[0].content);
    const components = ib
      ? [
          { paper: '1', level: 'SL', name: 'Paper 1 (no calculator)', duration_min: 90, marks: 80, writable: true, structure: 'Section A short; Section B long' },
          { paper: '1', level: 'HL', name: 'Paper 1 (no calculator)', duration_min: 120, marks: 110, writable: true, structure: 'Section A short; Section B long' },
          { paper: '3', level: 'HL', name: 'Paper 3', duration_min: 75, marks: 55, writable: false, why_not: 'Built on extended investigations' },
        ]
      : [
          { paper: '2', name: 'Paper 2 (Core)', duration_min: 75, marks: 60, writable: true, structure: 'Short-answer questions, calculator' },
          { paper: '4', name: 'Paper 4 (Extended)', duration_min: 150, marks: 120, writable: true, structure: 'Structured questions, calculator' },
          { paper: '6', name: 'Paper 6 (Investigation and modelling)', writable: false, why_not: 'Needs extended investigation tasks' },
        ];
    return { role: 'assistant', stop_reason: 'tool_use', usage, content: [tu('save_plan', { components, note: 'Syllabus for 2025–2027.' })] };
  }
  if (tools.includes('save_outline')) {
    const questions = Array.from({ length: 8 }, (_, i) => ({ label: String(i + 1), topic: i < 4 ? 'Number' : 'Algebra', marks: 2, plan: `Part ${i + 1}` }));
    return { role: 'assistant', stop_reason: 'tool_use', usage, content: [tu('save_outline', { title: 'Practice paper', duration_min: 75, total_marks: 16, instructions: 'Answer all questions.', questions })] };
  }
  if (tools.includes('save_items')) {
    const want = (body.messages[0].content.match(/Write these parts in full now: (.*)\./) || [])[1] || '1';
    const items = want.split(',').map((l) => l.trim()).map((label) => {
      const k = Number(label);
      return { label, prompt: `Work out $${k} \\times 7$.`, type: 'numeric', answer: String(k === 3 ? 22 : k * 7), marks: 2, topic: k <= 4 ? 'Number' : 'Algebra', mark_scheme: 'M1 A1', solution: `$${k} \\times 7 = ${k * 7}$` };
    });
    return { role: 'assistant', stop_reason: 'tool_use', usage, content: [tu('save_items', { items })] };
  }
  if (tools.includes('save_cards')) {
    const want = Number((body.messages[0].content.match(/Write (\d+) flashcards/) || [])[1] || 5);
    const list = Array.from({ length: want }, (_, i) => ({ front: `Card ${i + 1}: what is $${i + 2}^2$?`, back: `$${(i + 2) ** 2}$` }));
    return { role: 'assistant', stop_reason: 'tool_use', usage, content: [tu('save_cards', { cards: list })] };
  }
  if (tools.includes('save_boundaries')) {
    const pics = body.messages[0].content.filter((b) => b.type === 'image').length;
    assert.ok(pics >= 1, 'the threshold pages arrive as pictures');
    return {
      role: 'assistant',
      stop_reason: 'tool_use',
      usage,
      content: [
        tu('save_boundaries', {
          session: 'June 2025',
          options: [
            { option: 'Core (AX: papers 1, 3, 5)', max_mark: 160, grades: [{ grade: 'C', min: 106 }, { grade: 'D', min: 86 }, { grade: 'E', min: 66 }] },
            { option: 'Extended (BX: papers 2, 4, 6)', max_mark: 200, grades: [{ grade: 'A*', min: 163 }, { grade: 'A', min: 133 }, { grade: 'B', min: 104 }, { grade: 'C', min: 75 }] },
            { option: 'Unreadable row', max_mark: 50, grades: [{ grade: 'A', min: 80 }] },
          ],
          note: 'Check these against the document.',
        }),
      ],
    };
  }
  if (tools.includes('save_syllabus')) {
    const topics = [
      { code: '1', name: 'Number', details: ['Types of number', 'Fractions, decimals and percentages', 'Standard form'] },
      { code: '2', name: 'Algebra', details: ['Expressions', 'Linear equations', 'Simultaneous equations (Extended)'] },
      { code: '3', name: 'Functions', details: ['Notation', 'Graphs of functions'] },
      { code: '4', name: 'Coordinate geometry', details: ['Gradient', 'Equation of a line'] },
      { code: '5', name: 'Geometry', details: ['Angles', 'Similarity'] },
    ];
    return { role: 'assistant', stop_reason: 'tool_use', usage, content: [tu('save_syllabus', { topics, note: 'Follows the 2025–2027 syllabus. Check it against the official document.' })] };
  }
  if (tools.includes('write_report')) {
    const d = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf('{')));
    return {
      role: 'assistant',
      stop_reason: 'tool_use',
      usage,
      content: [tu('write_report', { summary: `A steady week for ${d.learner}: ${d.work.length} piece(s) of work.`, comment: 'She worked hard on her practice. Next we focus on algebra.', next_week: 'Homework on algebra; 10 minutes of practice a day.' })],
    };
  }
  // question bank: write questions, then check them (one deliberately wrong answer gets flagged)
  if (tools.includes('save_questions')) {
    const want = Number((body.messages[0].content.match(/Write (\d+) question/) || [])[1] || 3);
    const already = (body.messages[0].content.match(/^- /gm) || []).length;
    const qs = [];
    for (let i = 0; i < want; i++) {
      const k = already + i + 1;
      qs.push({ type: 'numeric', prompt: `Work out $${k} \\times 7$.`, answer: String(k === 2 ? 15 : k * 7), marks: 1, difficulty: (k % 3) + 1, mark_scheme: 'B1', solution: `$${k} \\times 7 = ${k * 7}$` });
    }
    return { role: 'assistant', stop_reason: 'tool_use', usage, content: [tu('save_questions', { questions: qs })] };
  }
  if (tools.includes('submit_checks')) {
    const list = JSON.parse(body.messages[0].content);
    return {
      role: 'assistant',
      stop_reason: 'tool_use',
      usage,
      content: [
        tu('submit_checks', {
          checks: list.map((q) => {
            const k = Number(q.question.match(/\$(\d+) /)[1]);
            const ok = String(q.stated_answer.value) === String(k * 7);
            return { number: q.number, my_answer: String(k * 7), agrees: ok, note: ok ? undefined : `The answer should be ${k * 7}.` };
          }),
        }),
      ],
    };
  }
  // making work: (look at book pages →) start → questions → questions → finish
  const last = body.messages[body.messages.length - 1];
  const looks = body.tools.some((t) => t.name === 'look_at_pages');
  const asked = body.messages.filter((m) => m.role === 'assistant').length;
  if (looks && asked === 0) {
    const fid = body.messages[0].content[0].text.match(/file_id ([0-9a-f-]{36})/)[1];
    return { role: 'assistant', stop_reason: 'tool_use', usage, content: [{ type: 'text', text: 'Let me read the chapter.' }, tu('look_at_pages', { file_id: fid, pages: [1, 2], why: 'linear equations' })] };
  }
  const step = asked - (looks ? 1 : 0);
  const lastResult = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  if (step === 0) {
    const sys = body.system[0].text;
    // after seeing page pictures, Prof also saves notes on them
    const sawPictures = lastResult && Array.isArray(lastResult.content) && lastResult.content.some((b) => b.type === 'image');
    const noteCall = sawPictures && looks ? [tu('note_pages', { file_id: body.messages[0].content[0].text.match(/file_id ([0-9a-f-]{36})/)[1], notes: [{ page: 1, text: 'Linear equations: solve ax + b = c by inverse operations.' }, { page: 2, text: 'Exercise 3A: 12 equations to solve.' }] })] : [];
    const subj = JSON.parse(sys.slice(sys.indexOf('{"programmes"'))).subjects[0];
    const learner = JSON.parse(sys.slice(sys.indexOf('{"programmes"'))).learners[0];
    return { role: 'assistant', stop_reason: 'tool_use', usage, content: [{ type: 'text', text: 'I will make the quiz.' }, ...noteCall, tu('start_assignment', { title: 'Linear equations quiz', kind: 'quiz', subject_id: subj?.id, learner_ids: learner ? [learner.id] : undefined, due_at: '2026-10-09T20:00:00+02:00' })] };
  }
  const aid = body.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('assignment_id'))
    .map((b) => JSON.parse(b.content).assignment_id)[0];
  if (step === 1) {
    return {
      role: 'assistant',
      stop_reason: 'tool_use',
      usage,
      content: [
        tu('add_questions', {
          assignment_id: aid,
          questions: [
            { type: 'mcq', prompt: 'Which is a solution of $2x = 6$?', options: ['2', '3', '6'], correct: [1], mark_scheme: 'B1', solution: '$x = 3$' },
            { type: 'numeric', prompt: 'Solve $x + 4 = 10$.', answer: '6', mark_scheme: 'B1' },
            { type: 'steps', prompt: 'Solve $3x - 5 = 10$.', answer: 'x = 5', marks: 3, mark_scheme: 'M1 add 5; M1 divide by 3; A1 x = 5' },
            { type: 'short', prompt: 'Why can you add 5 to both sides?', answer: 'It keeps the equation balanced.' },
          ],
        }),
      ],
    };
  }
  if (step === 2) return { role: 'assistant', stop_reason: 'tool_use', usage, content: [tu('add_questions', { assignment_id: aid, questions: [{ type: 'upload', prompt: 'Show $2(x+1) = 8$ on paper.', marks: 4 }] })] };
  assert.ok(lastResult);
  return { role: 'assistant', stop_reason: 'tool_use', usage, content: [tu('finish', { message: 'A 5-question quiz on linear equations for Sis, due Friday.' })] };
}

