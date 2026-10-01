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
    const subj = JSON.parse(sys.slice(sys.indexOf('{"programmes"'))).subjects[0];
    const learner = JSON.parse(sys.slice(sys.indexOf('{"programmes"'))).learners[0];
    return { role: 'assistant', stop_reason: 'tool_use', usage, content: [{ type: 'text', text: 'I will make the quiz.' }, tu('start_assignment', { title: 'Linear equations quiz', kind: 'quiz', subject_id: subj?.id, learner_ids: learner ? [learner.id] : undefined, due_at: '2026-10-09T20:00:00+02:00' })] };
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

