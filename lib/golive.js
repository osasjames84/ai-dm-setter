/**
 * Go-live rules, kept pure so they can be unit tested. server.js gathers the
 * facts (access status, Instagram, script checks, the stored test-drive pass and
 * the current prompt version) and these functions decide.
 *
 * A test drive only counts when it finished, every run finished and none was
 * graded "fail", and it covered at least TEST_DRIVE_MIN_RUNS personas (a partial
 * run with one or two personas does not unlock go-live). A pass is bound to the
 * prompt version it ran on: any later version (a section save, a template apply
 * or a restore) makes it stale.
 */
export const TEST_DRIVE_MIN_RUNS = 5;

/** Does a finished test-drive job count as a pass for go-live? */
export function testDriveCounts(job, minRuns = TEST_DRIVE_MIN_RUNS) {
  if (!job || job.status !== 'done' || job.passed !== true) return false;
  const runs = Array.isArray(job.runs) ? job.runs : [];
  if (runs.length < minRuns) return false;
  return runs.every((r) => r && r.status === 'done' && r.verdict !== 'fail');
}

/**
 * Where the stored test-drive pass stands against the current script.
 *   passed: a pass exists AND it was on the current prompt version
 *   stale:  a pass exists but on an older version (or with no version recorded)
 */
export function testDriveState({ passedAt, passedVersion, currentVersion }) {
  const at = String(passedAt || '').trim();
  const pv = String(passedVersion || '').trim();
  const cv = currentVersion == null ? '' : String(currentVersion);
  const has = !!at;
  const passed = has && !!pv && !!cv && pv === cv;
  return { passed, stale: has && !passed, passed_at: at || null, passed_version: pv ? Number(pv) : null, prompt_version: cv ? Number(cv) : null };
}

/**
 * Everything that blocks POST /api/onboarding/go-live (and turning the kill
 * switch off through settings). Empty array = ready.
 *   instagram: 'connected' | 'needs_reconnect' | 'disconnected'
 */
export function goLiveBlockers({ accessStatus, instagram, checks = [], testDrive }) {
  const out = [];
  if (accessStatus !== 'active') {
    out.push({ section: 'access', level: 'error', message: accessStatus === 'paused' ? 'This account is paused. Contact support to resume.' : 'This account is waiting for approval.' });
  }
  if (instagram === 'needs_reconnect') out.push({ section: 'instagram', level: 'error', message: 'Instagram needs reconnecting before the AI can go live.' });
  else if (instagram !== 'connected') out.push({ section: 'instagram', level: 'error', message: 'Connect Instagram before going live.' });
  for (const c of checks) if (c && c.level === 'error') out.push(c);
  if (!testDrive || !testDrive.passed) {
    out.push({ section: 'test_drive', level: 'error', message: testDrive && testDrive.stale ? 'The script changed since the last test drive. Run it again before going live.' : 'Run the test drive on the current script before going live.' });
  }
  return out;
}
