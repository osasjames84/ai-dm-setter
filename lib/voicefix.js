/**
 * One-shot rewrite of the seeded script lines that made the setter robotic
 * (owner's call, 2026-10-22): the fixed "couple of questions ... good fit ...
 * sounds good?" permission line, the cap of two pain questions, and the
 * acknowledge-then-next-question rule. Exact matches only, so sections the
 * owner rewrote in his own words are left alone. Pure: returns new sections.
 */

const DIG_FIRST = `DIG FIRST
Before any qualifier, get them talking about the struggle. When they tell you they are stuck, frustrated or still not where they want to be, stay there: ask why, since when, what they have tried, what happened, how it has made them feel and what it is costing them. Two or three follow ups on their story is normal. Never jump from "I'm still stuck" straight to qualifying questions. If they say they already know what to do, ask why they haven't done it: knowing is not their problem, so find out what is.

OPENING THE QUALIFIERS
Only once they have actually told you their story, move on naturally in your own words (something like "ok I want to see if I can actually help, mind if I ask a few quick ones?"). Never use the same wording twice, and never with someone you have already had a call with.`;

export const PAST_CALL_LEADS = `Past call leads (people I have already been on a call with, usually reopened by my own check-in like "we had a call in May, are you still stuck or have you moved on?"): they are not new leads. Never re-introduce myself and never ask permission to ask questions. If they have moved on, be genuinely happy for them and ask what worked. If they are still stuck, dig: what has happened since the call, what they tried, why it has not changed, how that has felt. A call months ago does NOT make them qualified now: once they have opened up, they still answer the qualifiers (skip only what they have already told me in this chat), and the booking link only goes out once they are qualified by WHAT QUALIFIED LOOKS LIKE. If they say they know what to do, ask why they have not done it.`;

export const VOICE_FIX = [
  ['prompt_qualification', `OPENING THE QUALIFICATION
Once they have engaged (replied properly at least once and shown they have a goal), ask permission with this line, in your own words but keeping the meaning: "I just have a couple of questions to see if it's a good fit and then we can move forward, sounds good?" Wait for a yes or for them to just keep talking.`, DIG_FIRST],
  ['prompt_qualification', 'Ask ONE at a time, react to their answer with something specific before moving on,', 'Ask ONE at a time, in your own words and tied to what they just said (never the same stock wording twice), react to their answer with something specific to them before moving on,'],
  ['prompt_qualification', 'Before question 5 (money) you must have: asked the permission line and had them go along with it, heard their answers to 1 to 4, and had them answer at least ONE pain question in their own words.', 'Before question 5 (money) you must have: dug into their story, heard their answers to 1 to 4, and had them answer pain questions in their own words.'],
  ['prompt_qualification', 'when they answer a qualifier, the acknowledgement and the next question go in the SAME reply, never the acknowledgement alone.', 'when they answer a qualifier, never send a reaction on its own: the same reply carries your next question. If what they said opens up something real (a struggle, a feeling), that next question goes into it rather than on to the next qualifier.'],
  ['prompt_qualification', `PAIN QUESTIONS (pick at most TWO, never all of them, the rest are for the call)
These open a wound, not just gather info. Weave in one or two where they fit naturally, usually around qualifier 2, and let them actually answer before moving on.`, `PAIN QUESTIONS (pick the ones that fit their story, never fire them as a list)
These open a wound, not just gather info. Use them in DIG FIRST and again around qualifier 2 when there is more to dig, and let them actually answer before moving on.`],
];

/** Apply the rewrite to a {section: text} map. Returns { sections, changed: [descriptions] }. */
export function applyVoiceFix(sections) {
  const out = { ...sections };
  const changed = [];
  for (const [k, a, b] of VOICE_FIX) {
    const v = String(out[k] || '');
    if (v.includes(a)) { out[k] = v.split(a).join(b); changed.push(k + ': ' + a.split('\n')[0].slice(0, 40)); }
  }
  const custom = String(out.prompt_custom || '');
  if (custom.trim() && !custom.includes('Past call leads')) { out.prompt_custom = custom.trimEnd() + '\n\n' + PAST_CALL_LEADS; changed.push('prompt_custom: past call leads'); }
  return { sections: out, changed };
}

/**
 * Second pass (owner's call, 2026-10-23): v1 told past-call leads to be offered
 * a call as soon as they opened up, so the AI sent the booking link with no
 * qualifiers. Exact matches of the v1 wording only.
 */
export const VOICE_FIX_V2 = [
  ['prompt_qualification', "Never jump from \"I'm still stuck\" straight to qualifying questions.", "Never jump from \"I'm still stuck\" straight to qualifying questions. If they say they already know what to do, ask why they haven't done it: knowing is not their problem, so find out what is."],
  ['prompt_custom', "Only when they have opened up, offer to jump back on a call, mirroring their own words.", "A call months ago does NOT make them qualified now: once they have opened up, they still answer the qualifiers (skip only what they have already told me in this chat), and the booking link only goes out once they are qualified by WHAT QUALIFIED LOOKS LIKE. If they say they know what to do, ask why they have not done it."],
];
export function applyVoiceFixV2(sections) {
  const out = { ...sections };
  const changed = [];
  for (const [k, a, b] of VOICE_FIX_V2) {
    const v = String(out[k] || '');
    if (v.includes(a) && !v.includes(b)) { out[k] = v.split(a).join(b); changed.push(k); }
  }
  return { sections: out, changed };
}
