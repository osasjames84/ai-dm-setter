/**
 * Voice guards in the engine: stock reactions and repeated openers are caught
 * and regenerated once, and a chat reopened after months reaches the model as
 * a check-in being answered (not a new lead). The AI provider is a local mock.
 * Run: npm test
 */
import http from 'node:http';
import assert from 'node:assert/strict';

const replies = [];
const requests = [];
const mock = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    requests.push(JSON.parse(raw));
    const text = JSON.stringify(replies.shift() || { messages: ['ok what happened?'], stage: 'engaged', needs_human: false, reason: '', flag_reason_code: '' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } }));
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
const { generateMove, repeatedPhrases, opensWithAny, timelineNote, STOCK_REACTIONS } = await import('../lib/engine.js');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const move = (messages, stage = 'engaged') => ({ messages, stage, needs_human: false, reason: '', flag_reason_code: '' });
const reopened = [
  { role: 'setter', text: 'how did the call land for you?', source: 'ai', created_at: '2026-05-12T10:00:00Z' },
  { role: 'lead', text: 'yeah good, will think about it', created_at: '2026-05-12T11:00:00Z' },
  { role: 'setter', text: 'Hey Sam, we had a call during May. Are you still stuck or have you moved on since then?', source: 'human', created_at: '2026-10-20T10:00:00Z' },
  { role: 'lead', text: 'still stuck tbh', created_at: '2026-10-20T12:00:00Z' },
];
const settings = { prompt_persona: 'You are JD.', end_on_question: '1' };

await test('repeated sentences across chats are found, one-offs are not', () => {
  const p = repeatedPhrases(["That's real. Struggling with the last 5kg is usually the hardest.", 'that’s real, how long?', "Thats real. what happened?", "That's real. Struggling with the last 5kg is usually the hardest", 'Struggling with the last 5kg is usually the hardest']);
  assert.ok(p.includes("that's real"));
  assert.ok(p.includes('struggling with the last 5kg is usually the hardest'));
  assert.ok(!p.includes('what happened'));
});
await test('stock openers are detected, real reactions are not', () => {
  assert.equal(opensWithAny("That's real. You're still stuck.", STOCK_REACTIONS), true);
  assert.equal(opensWithAny('I hear you, that sucks', STOCK_REACTIONS), true);
  assert.equal(opensWithAny('Damn, since May? what happened', STOCK_REACTIONS), false);
});
await test('a chat reopened after months is described as a check-in being answered', () => {
  const n = timelineNote(reopened);
  assert.match(n, /went quiet after 12 May 2026/);
  assert.match(n, /we had a call during May/);
  assert.match(n, /no asking permission/);
  assert.match(timelineNote(reopened.slice(0, 2)), /you opened this chat yourself/);
  assert.equal(timelineNote(reopened.slice(1, 2)), '', 'a lead who messaged first gets no timeline note');
});
await test('a "That\'s real" reply is regenerated once and the rewrite is sent', async () => {
  requests.length = 0;
  replies.push(move(["That's real. You're still stuck.", 'Do you mind if I ask you a couple questions to see if you are a good fit?']));
  replies.push(move(['damn, still? what happened after the call', 'like what did you try and where did it fall apart?']));
  const out = await generateMove(settings, { handle: 'sam', stage: 'engaged' }, reopened);
  assert.equal(requests.length, 2, 'one retry');
  assert.deepEqual(out.messages, ['damn, still? what happened after the call', 'like what did you try and where did it fall apart?']);
  const note = requests[0].messages.at(-1).content;
  assert.match(note, /Timeline: this chat went quiet/);
  assert.match(requests[1].messages.at(-1).content, /stock or repeated line/);
});
await test('phrases repeated across the account reach the model and trigger the backstop', async () => {
  requests.length = 0;
  replies.push(move(['Struggling with the last 5kg is usually the hardest. how long has it been?']));
  replies.push(move(['how long have you been sat at that weight?']));
  const out = await generateMove({ ...settings, overused_phrases: ['struggling with the last 5kg is usually the hardest'] }, { handle: 'kay', stage: 'engaged' }, reopened);
  assert.match(requests[0].messages.at(-1).content, /keep repeating across chats.*last 5kg/);
  assert.deepEqual(out.messages, ['how long have you been sat at that weight?']);
});
await test('a normal reply goes out with no extra call', async () => {
  requests.length = 0;
  replies.push(move(['wait since may? what happened']));
  const out = await generateMove(settings, { handle: 'lee', stage: 'engaged' }, reopened);
  assert.equal(requests.length, 1);
  assert.deepEqual(out.messages, ['wait since may? what happened']);
});

mock.close();
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall green');
