// Local tests for soft-fail (including the comment-on-pr feature).
// No dependencies: a tiny in-process mock of the GitHub API, then the real
// src/index.js is run as a subprocess with controlled environment variables.
//
//   node test/test-pr-comment.js
//
// Exit code 0 = all scenarios passed.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soft-fail-test-'));

let requests = [];
let state = { comments: [], failCheckRun: false, failCommentPost: false };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (err) { /* empty or plain body */ }
    requests.push({ method: req.method, path: req.url, body: parsed });

    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'POST' && req.url === '/repos/owner/repo/check-runs') {
      if (state.failCheckRun) return send(403, { message: 'Resource not accessible by integration' });
      return send(201, { id: 1, html_url: 'https://github.com/owner/repo/runs/1' });
    }
    if (req.method === 'GET' && req.url.startsWith('/repos/owner/repo/issues/7/comments')) {
      return send(200, state.comments);
    }
    if (req.method === 'POST' && req.url === '/repos/owner/repo/issues/7/comments') {
      if (state.failCommentPost) return send(403, { message: 'Resource not accessible by integration' });
      return send(201, { id: 99 });
    }
    if (req.method === 'PATCH' && req.url.startsWith('/repos/owner/repo/issues/comments/')) {
      return send(200, {});
    }
    if (req.method === 'DELETE' && req.url.startsWith('/repos/owner/repo/issues/comments/')) {
      res.writeHead(204);
      return res.end();
    }
    return send(404, { message: 'not found in mock' });
  });
});

function markerComment(runId, entries) {
  const lines = [
    '<!-- soft-fail-pr-comment -->',
    `<!-- soft-fail-run-id: ${runId} -->`,
    '',
    '## Soft failures in this run',
    '',
    ...entries.map((e) => `- **${e.checkName}** — \`${e.command}\` (exit ${e.exitCode}) — [check run](${e.checkUrl || 'https://github.com/owner/repo/runs/1'})`),
    ''
  ];
  return { id: 55, body: lines.join('\n') };
}

function runAction({ command, checkName = 'external-api (soft)', commentOnPr = true, runId = '100', prEvent = true }) {
  const eventPath = path.join(TMP, 'event.json');
  if (prEvent) {
    fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abc123' } } }));
  } else {
    fs.writeFileSync(eventPath, JSON.stringify({}));
  }
  const outPath = path.join(TMP, 'out.txt');
  const summaryPath = path.join(TMP, 'summary.md');
  fs.writeFileSync(outPath, '');
  fs.writeFileSync(summaryPath, '');

  const env = {
    ...process.env,
    INPUT_RUN: command,
    'INPUT_CHECK-NAME': checkName,
    'INPUT_COMMENT-ON-PR': commentOnPr ? 'true' : 'false',
    'INPUT_CREATE-SUMMARY': 'true',
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    GITHUB_SHA: 'abc123',
    GITHUB_RUN_ID: runId,
    GITHUB_EVENT_NAME: prEvent ? 'pull_request' : 'push',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outPath,
    GITHUB_STEP_SUMMARY: summaryPath
  };

  return new Promise((resolve) => {
    execFile('node', [path.join(ROOT, 'src', 'index.js')], { env, cwd: ROOT }, (err, stdout, stderr) => {
      const outcome = fs.readFileSync(outPath, 'utf8');
      resolve({
        exitCode: err ? (err.code || 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        outcome: /outcome=(\S+)/.exec(outcome)?.[1] || ''
      });
    });
  });
}

const calls = (method, pathPart) => requests.filter((r) => r.method === method && r.path.includes(pathPart));
const commentBody = (r) => (r && r.body && r.body.body) || '';

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.log(`  FAIL - ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // S1: failing command, no existing comment -> check run + new PR comment.
  console.log('S1 failing command, no existing comment');
  requests = []; state = { comments: [], failCheckRun: false, failCommentPost: false };
  let r = await runAction({ command: 'false' });
  check('exit 0 (stays green)', r.exitCode === 0, `got ${r.exitCode}`);
  check('outcome soft-failed', r.outcome === 'soft-failed', r.outcome);
  check('check run created', calls('POST', 'check-runs').length === 1);
  const created = calls('POST', 'issues/7/comments');
  check('PR comment created', created.length === 1);
  check('comment has marker', commentBody(created[0]).includes('<!-- soft-fail-pr-comment -->'));
  check('comment has run id 100', commentBody(created[0]).includes('<!-- soft-fail-run-id: 100 -->'));
  check('comment lists the failure', commentBody(created[0]).includes('external-api (soft)') && commentBody(created[0]).includes('(exit 1)'));
  check('comment links the check run', commentBody(created[0]).includes('https://github.com/owner/repo/runs/1'));

  // S2: failing command, same-run comment with another entry -> merge via PATCH.
  console.log('S2 failing command, same-run comment exists');
  requests = [];
  state = { comments: [markerComment(100, [{ checkName: 'other-check', command: 'npm run lint', exitCode: 2 }])], failCheckRun: false, failCommentPost: false };
  r = await runAction({ command: 'false' });
  check('exit 0', r.exitCode === 0);
  const patched = calls('PATCH', 'issues/comments/55');
  check('comment updated, not recreated', patched.length === 1 && calls('POST', 'issues/7/comments').length === 0);
  check('merged: old entry kept', commentBody(patched[0]).includes('other-check'));
  check('merged: new entry added', commentBody(patched[0]).includes('external-api (soft)'));

  // S2b: same check retried in the same run replaces its own line (no duplicate).
  console.log('S2b same check retried in the same run');
  requests = [];
  state = { comments: [markerComment(100, [{ checkName: 'external-api (soft)', command: 'false', exitCode: 1 }])], failCheckRun: false, failCommentPost: false };
  r = await runAction({ command: 'false' });
  const patched2 = calls('PATCH', 'issues/comments/55');
  const count = (commentBody(patched2[0]).match(/external-api \(soft\)/g) || []).length;
  check('entry appears exactly once', count === 1, `got ${count}`);

  // S3: failing command, older-run comment -> replaced with fresh list.
  console.log('S3 failing command, older-run comment exists');
  requests = [];
  state = { comments: [markerComment(42, [{ checkName: 'old-check', command: 'npm run old', exitCode: 3 }])], failCheckRun: false, failCommentPost: false };
  r = await runAction({ command: 'false' });
  const patched3 = calls('PATCH', 'issues/comments/55');
  check('comment replaced via PATCH', patched3.length === 1);
  check('old entry gone', !commentBody(patched3[0]).includes('old-check'));
  check('new run id stored', commentBody(patched3[0]).includes('<!-- soft-fail-run-id: 100 -->'));

  // S4: failing command, newer-run comment -> untouched (concurrency guard).
  console.log('S4 failing command, newer-run comment exists');
  requests = [];
  state = { comments: [markerComment(200, [{ checkName: 'newer-check', command: 'npm run newer', exitCode: 1 }])], failCheckRun: false, failCommentPost: false };
  r = await runAction({ command: 'false' });
  check('exit 0', r.exitCode === 0);
  check('no comment write', calls('POST', 'issues/7/comments').length === 0 && calls('PATCH', 'issues/comments/').length === 0);

  // S5: passing command, stale comment -> deleted.
  console.log('S5 passing command, stale comment exists');
  requests = [];
  state = { comments: [markerComment(42, [{ checkName: 'old-check', command: 'npm run old', exitCode: 3 }])], failCheckRun: false, failCommentPost: false };
  r = await runAction({ command: 'true' });
  check('exit 0', r.exitCode === 0);
  check('outcome success', r.outcome === 'success');
  check('stale comment deleted', calls('DELETE', 'issues/comments/55').length === 1);

  // S6: passing command, same-run comment -> kept.
  console.log('S6 passing command, same-run comment exists');
  requests = [];
  state = { comments: [markerComment(100, [{ checkName: 'external-api (soft)', command: 'false', exitCode: 1 }])], failCheckRun: false, failCommentPost: false };
  r = await runAction({ command: 'true' });
  check('comment kept (no delete)', calls('DELETE', 'issues/comments/').length === 0);

  // S7: failing command, comment-on-pr on, but no PR context -> no comment calls.
  console.log('S7 failing command, no PR context');
  requests = []; state = { comments: [], failCheckRun: false, failCommentPost: false };
  r = await runAction({ command: 'false', prEvent: false });
  check('exit 0', r.exitCode === 0);
  check('no comment API calls', requests.filter((x) => x.path.includes('issues/')).length === 0);

  // S8: failing command, comment POST fails 403 -> still green, warning shown.
  console.log('S8 failing command, comment POST fails');
  requests = []; state = { comments: [], failCheckRun: false, failCommentPost: true };
  r = await runAction({ command: 'false' });
  check('exit 0 despite comment failure', r.exitCode === 0, `got ${r.exitCode}`);
  check('warning mentions pull-requests: write', r.stdout.includes('pull-requests: write'));

  // S9: failing command, comment-on-pr off -> no comment calls.
  console.log('S9 failing command, comment-on-pr off');
  requests = []; state = { comments: [], failCheckRun: false, failCommentPost: false };
  r = await runAction({ command: 'false', commentOnPr: false });
  check('exit 0', r.exitCode === 0);
  check('no comment API calls', requests.filter((x) => x.path.includes('issues/')).length === 0);

  // S10: failing command, check-run creation fails -> step fails loudly.
  console.log('S10 failing command, check-run creation fails');
  requests = []; state = { comments: [], failCheckRun: true, failCommentPost: false };
  r = await runAction({ command: 'false' });
  check('exit 1 (fails loudly)', r.exitCode === 1, `got ${r.exitCode}`);
  check('no comment posted', requests.filter((x) => x.path.includes('issues/')).length === 0);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
