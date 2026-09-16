/**
 * Account context. Every request and every background turn runs "as" one
 * account, carried in AsyncLocalStorage so nothing has to thread an account id
 * through 100 call sites: settings, conversation lookups and writes read it
 * from here. Timers and promises started inside runAs() inherit the context.
 *
 * During the single→multi tenant transition, code that reaches settings with
 * no context falls back to the first account (JD's) and logs once, so a leak
 * is visible in the logs instead of crashing a send.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const FIRST_ACCOUNT_ID = 'acc_1';

const als = new AsyncLocalStorage();
let _warned = false;

/** Run fn (sync or async) with accountId as the current account. */
export function runAs(accountId, fn) {
  return als.run({ accountId: String(accountId) }, fn);
}

/** Enter a context for the rest of the current synchronous execution (boot only). */
export function enterAs(accountId) { als.enterWith({ accountId: String(accountId) }); }

/** Run fn with NO account context (used to start the HTTP server so requests inherit nothing). */
export function outside(fn) { return als.exit(fn); }

/** The current account id, or null when nothing set one. */
export function currentAccount() {
  const s = als.getStore();
  return s && s.accountId ? s.accountId : null;
}

/** Current account id, falling back to the first account with a one-time warning. */
export function currentAccountOrFirst(where = '') {
  const id = currentAccount();
  if (id) return id;
  if (!_warned) {
    _warned = true;
    console.warn(`[tenancy] no account context${where ? ' in ' + where : ''} — falling back to ${FIRST_ACCOUNT_ID}. ` + new Error().stack.split('\n').slice(2, 5).join(' | '));
  }
  return FIRST_ACCOUNT_ID;
}
