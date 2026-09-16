/**
 * Structured logs. Every console line gets the current account id in front of
 * it, so a multi-tenant log can be filtered by account. With LOG_FORMAT=json
 * each line becomes one JSON object (Railway's log explorer indexes the
 * fields); otherwise it stays human readable: "12:00:01 [acc_1] message".
 * Message CONTENT is never logged by the callers; this only adds context.
 */
import { currentAccount } from './tenancy.js';

const json = () => process.env.LOG_FORMAT === 'json';
const raw = { log: console.log, warn: console.warn, error: console.error, info: console.info };

function fmt(level, args) {
  const account = currentAccount() || '-';
  const msg = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : safe(a))).join(' ');
  if (json()) return JSON.stringify({ ts: new Date().toISOString(), level, account, msg: msg.slice(0, 4000) });
  const t = new Date().toISOString().slice(11, 19);
  return `${t} [${account}] ${msg}`;
}
function safe(v) { try { return JSON.stringify(v); } catch { return String(v); } }

export function installLogging() {
  console.log = (...a) => raw.log(fmt('info', a));
  console.info = (...a) => raw.info(fmt('info', a));
  console.warn = (...a) => raw.warn(fmt('warn', a));
  console.error = (...a) => raw.error(fmt('error', a));
}
