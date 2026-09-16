/**
 * Inbound image understanding (E.10): a lead sends a screenshot (a booking
 * confirmation, a payment receipt, a progress photo) and the setter used to see
 * only "[photo]". Haiku describes it in one line so the AI can react. Images
 * over 4MB or of unknown type are left as "[photo]". Best-effort, never throws.
 */
import fs from 'node:fs';
import { reportUsage } from './usage.js';

const MODEL = 'claude-haiku-4-5-20251001';
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

export async function describeImage(anthropic, filePath, mime) {
  if (!anthropic || !filePath) return null;
  try {
    const type = TYPES[String(filePath).split('.').pop().toLowerCase()] || (Object.values(TYPES).includes(mime) ? mime : null);
    if (!type) return null;
    const buf = fs.readFileSync(filePath);
    if (buf.length > 4 * 1024 * 1024) return null;
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 120,
      system: 'Describe what a prospect sent in an Instagram DM in one plain sentence under 25 words, so a sales assistant can react. Name the kind of image (booking confirmation, payment receipt, progress photo, meme, screenshot of a chat, food, other) and the key facts visible (dates, amounts, names of apps). No preamble.',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } }, { type: 'text', text: 'What is this?' }] }],
    });
    reportUsage(MODEL, res);
    const text = (res.content.find((b) => b.type === 'text')?.text || '').trim().replace(/\s+/g, ' ');
    return text ? `[photo: ${text.slice(0, 200)}]` : null;
  } catch { return null; }
}
