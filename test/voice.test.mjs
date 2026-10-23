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
const { applyVoiceFix, VOICE_FIX, applyVoiceFixV2 } = await import('../lib/voicefix.js');

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

await test('a permission ask in a chat we reopened is regenerated', async () => {
  requests.length = 0;
  const outbound = [
    { role: 'setter', text: "Hey Jaala, it's Osas from Lean is Law. We spoke on a call back in May about your goals. Just checking in, are you still stuck with it, or have things moved on since then?", source: 'human', created_at: '2026-10-22T09:31:00Z' },
    { role: 'lead', text: 'very stuck', created_at: '2026-10-22T10:10:00Z' },
  ];
  replies.push(move(["damn, that's exactly the kind of stuck that doesn't fix itself", "i just have a couple questions to see if it's a good fit and then we can go from there, sound good?"]));
  replies.push(move(['very stuck how? what happened after the call']));
  const out = await generateMove(settings, { handle: 'jaala', stage: 'lead' }, outbound);
  assert.match(requests[0].messages.at(-1).content, /do not ask permission to ask questions/);
  assert.match(requests[1].messages.at(-1).content, /asks permission to ask qualifying questions/);
  assert.deepEqual(out.messages, ['very stuck how? what happened after the call']);
});
await test('the live-script rewrite replaces the robotic lines once and keeps owner wording', () => {
  const qual = VOICE_FIX.filter(([k]) => k === 'prompt_qualification').map(([, a]) => a).join('\n\nOwner line that stays.\n\n');
  const { sections, changed } = applyVoiceFix({ prompt_qualification: qual, prompt_custom: 'Reading the thread: my own rules.' });
  assert.equal(changed.length, VOICE_FIX.length + 1);
  assert.doesNotMatch(sections.prompt_qualification, /couple of questions to see if it's a good fit/);
  assert.doesNotMatch(sections.prompt_qualification, /at most TWO/);
  assert.match(sections.prompt_qualification, /DIG FIRST/);
  assert.match(sections.prompt_qualification, /Owner line that stays\./);
  assert.match(sections.prompt_custom, /^Reading the thread: my own rules\.\n\nPast call leads/);
  assert.equal(applyVoiceFix(sections).changed.length, 0, 'second run changes nothing');
  assert.equal(applyVoiceFix({ prompt_qualification: 'My own words.', prompt_custom: '' }).changed.length, 0, 'rewritten scripts are left alone');
});

const jaala = [
  { role: 'setter', text: "Hey Jaala, it's Osas from Lean is Law. We spoke on a call back in May about your goals. Just checking in, are you still stuck with it, or have things moved on since then?", source: 'human', created_at: '2026-10-22T09:31:00Z' },
  { role: 'lead', text: 'very stuck off', created_at: '2026-10-22T10:10:00Z' },
  { role: 'setter', text: 'Since we spoke in May, what have you actually tried to get moving again', source: 'ai', created_at: '2026-10-23T17:50:00Z' },
  { role: 'lead', text: 'i know what to do i just lost that consistency bc i went travelling for 2 months', created_at: '2026-10-23T17:52:00Z' },
  { role: 'lead', text: 'i just need a plan to build that momentum again', created_at: '2026-10-23T17:52:30Z' },
];
const linkSettings = { ...settings, calendar_link: 'https://calendly.com/osasjames84' };
await test('the booking link is held back from a lead who has not been qualified (Jaala replay)', async () => {
  requests.length = 0;
  replies.push(move(["two months off the back of travel will do that, especially once the routine's broken", "sounds exactly like what i sort out on a call. want to jump on one? here's the link https://calendly.com/osasjames84/30min"], 'booking_sent'));
  replies.push(move(['if you know what to do, what has actually stopped you doing it since you got back?']));
  const out = await generateMove(linkSettings, { handle: 'jaala', stage: 'lead' }, jaala);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /has not been qualified yet/);
  assert.deepEqual(out.messages, ['if you know what to do, what has actually stopped you doing it since you got back?']);
});
await test('the link goes out once the thread is qualifying, or when the lead asks for it', async () => {
  requests.length = 0;
  replies.push(move(['grab whichever time suits here https://calendly.com/osasjames84/30min'], 'booking_sent'));
  let out = await generateMove(linkSettings, { handle: 'q', stage: 'qualifying' }, jaala);
  assert.equal(requests.length, 1); assert.match(out.messages[0], /calendly/);
  requests.length = 0;
  replies.push(move(['course, here https://calendly.com/osasjames84/30min'], 'booking_sent'));
  out = await generateMove(linkSettings, { handle: 'asker', stage: 'engaged' }, [...jaala, { role: 'lead', text: 'can you send the link?', created_at: '2026-10-23T17:53:00Z' }]);
  assert.equal(requests.length, 1); assert.match(out.messages[0], /calendly/);
});
await test('v2 script fix: past-call leads still answer the qualifiers; "I know what to do" gets "why haven\'t you?"', () => {
  const v1 = applyVoiceFix({ prompt_qualification: VOICE_FIX[0][1], prompt_custom: 'My rules.' }).sections;
  // simulate a script that got the ORIGINAL v1 wording
  const old = { prompt_qualification: v1.prompt_qualification.replace(/ If they say they already know what to do,[^.]*\./, ''), prompt_custom: v1.prompt_custom.replace(/A call months ago[\s\S]*$/, 'Only when they have opened up, offer to jump back on a call, mirroring their own words.') };
  const { sections, changed } = applyVoiceFixV2(old);
  assert.deepEqual(changed, ['prompt_qualification', 'prompt_custom']);
  assert.match(sections.prompt_qualification, /ask why they haven't done it/);
  assert.match(sections.prompt_custom, /does NOT make them qualified now/);
  assert.doesNotMatch(sections.prompt_custom, /offer to jump back on a call, mirroring/);
  assert.equal(applyVoiceFixV2(sections).changed.length, 0, 'second run changes nothing');
});

mock.close();
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall green');
