/**
 * Knowledge base (RAG-lite). Stores uploaded documents' extracted text on disk
 * under DATA_DIR/knowledge and injects a capped, combined snapshot into the
 * setter's system prompt. No embeddings — for a coach's modest doc set, feeding
 * the (truncated) text directly is simpler and works well within the token budget.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let DIR = null;
let _cache = null; // { text, builtFromCount } — invalidated on add/delete

export function initKnowledge(dataDir) {
  DIR = path.join(dataDir, 'knowledge');
  fs.mkdirSync(DIR, { recursive: true });
}

const SUPPORTED = ['.txt', '.md', '.pdf', '.docx'];
export function isSupported(filename) {
  return SUPPORTED.includes(path.extname(String(filename || '')).toLowerCase());
}

/** Extract plain text from a file buffer by extension. */
async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.txt' || ext === '.md') return buffer.toString('utf8');
  if (ext === '.pdf') {
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    return (await pdfParse(buffer)).text;
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ buffer })).value;
  }
  throw new Error('Unsupported file type — use PDF, .docx, .txt or .md');
}

/** Store a document: extract text, persist text + metadata, return the metadata. */
export async function addDocument(buffer, filename) {
  if (!DIR) throw new Error('knowledge store not initialized');
  const text = String(await extractText(buffer, filename) || '').replace(/\r/g, '').trim();
  const id = crypto.randomBytes(6).toString('hex');
  const meta = { id, name: String(filename).slice(0, 200), chars: text.length, at: new Date().toISOString() };
  fs.writeFileSync(path.join(DIR, id + '.txt'), text);
  fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify(meta));
  _cache = null;
  return meta;
}

/** List stored documents (metadata only), newest first. */
export function listDocuments() {
  if (!DIR) return [];
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Delete a document by id. Returns true if something was removed. */
export function deleteDocument(id) {
  if (!DIR || !/^[a-f0-9]{12}$/.test(String(id))) return false;
  let removed = false;
  for (const ext of ['.txt', '.json']) {
    const p = path.join(DIR, id + ext);
    if (fs.existsSync(p)) { fs.unlinkSync(p); removed = true; }
  }
  if (removed) _cache = null;
  return removed;
}

/**
 * Combined knowledge text for the system prompt, capped at maxChars (each doc
 * prefixed with its filename). '' when empty. Cached until the next add/delete.
 */
export function knowledgeText(maxChars = 8000) {
  if (!DIR) return '';
  if (_cache) return _cache.text;
  const docs = listDocuments();
  let out = '';
  for (const d of docs) {
    const p = path.join(DIR, d.id + '.txt');
    let body = '';
    try { body = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (!body.trim()) continue;
    const chunk = `\n--- ${d.name} ---\n${body.trim()}\n`;
    if (out.length + chunk.length > maxChars) { out += chunk.slice(0, Math.max(0, maxChars - out.length)); break; }
    out += chunk;
  }
  _cache = { text: out.trim(), builtFromCount: docs.length };
  return _cache.text;
}
