/**
 * Voice-note transcription via a Whisper-compatible API. Claude can't process
 * audio, so this uses a dedicated speech-to-text endpoint. Prefers GROQ_API_KEY
 * (Groq's whisper-large-v3 — has a generous free tier), falls back to
 * OPENAI_API_KEY (whisper-1). Dormant (returns null) when neither is set, so
 * voice notes still show as a playable clip labeled "[voice note]".
 */
import fs from 'node:fs';
import path from 'node:path';

export function transcriptionConfigured() {
  return !!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY);
}

/** Transcribe an audio file to text. Returns the transcript, or null if not configured. */
export async function transcribeAudio(filePath) {
  const groq = process.env.GROQ_API_KEY;
  const openai = process.env.OPENAI_API_KEY;
  if ((!groq && !openai) || !filePath) return null;
  const base = groq ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
  const key = groq || openai;
  const model = groq ? 'whisper-large-v3' : 'whisper-1';

  const buf = await fs.promises.readFile(filePath); // async — never block the event loop
  const fd = new FormData();
  // Whisper detects the format from the filename extension — pass a real one.
  fd.append('file', new Blob([buf]), path.basename(filePath));
  fd.append('model', model);
  fd.append('response_format', 'json');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000); // usually a few seconds; hard cap at 60s
  let res;
  try {
    res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: ac.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`transcribe ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return String(j.text || '').trim();
}
