// soft-fail — GitLab-style allow_failure for GitHub Actions.
//
// Runs your command. If it exits 0, the step passes as normal.
// If it fails, soft-fail creates a separate Check Run with conclusion
// "neutral" (full log included), writes a job summary, and exits 0 —
// so the job and PR stay green, but the failure stays visible in the
// Checks tab instead of being hidden the way `continue-on-error` hides it.
//
// Optional PR comment (`comment-on-pr: true`): the failure is also made
// visible at the top of the pull request, as a comment listing the soft
// failures of the latest run. A neutral check run alone still shows the
// workflow as green ("all checks have passed"), which reviewers can miss;
// the comment is the part they cannot miss. When a later run has no soft
// failures, the stale comment is removed. Only the newest run may touch
// the comment, so an older run finishing late cannot clobber a newer
// run's report.
//
// This exists because GitHub has no native allow-failure:
// https://github.com/actions/runner/issues/2347 (open since 2020,
// 1,590+ reactions, still unshipped).
//
// Required permission in the calling workflow:
//   permissions:
//     checks: write
//     contents: read
//     pull-requests: write   # only needed for comment-on-pr: true
//
// Zero dependencies (Node 20 builtins only) — the GitHub API is called
// with plain fetch, so dist/ stays tiny and the action starts fast.
// GITHUB_API_URL can override the API base (default
// https://api.github.com) — useful for GitHub Enterprise and for tests.

const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

const MAX_LOG_CHARS = 6000; // Checks API text limit is 65535; keep the tail short.

// --- Minimal replacements for @actions/core (file-based, no deps) ---
function getInput(name, { required = false } = {}) {
  const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || '';
  if (required && !value) throw new Error(`Input required and not supplied: ${name}`);
  return value.trim();
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const line = `${name}=${value}\n`;
  if (file) fs.appendFileSync(file, line);
  else process.stdout.write(`::set-output name=${name}::${value}\n`);
}

function setFailed(message) {
  process.exitCode = 1;
  process.stderr.write(`::error::${message}\n`);
}

function warning(message) {
  process.stdout.write(`::warning::${message}\n`);
}

function info(message) {
  process.stdout.write(`${message}\n`);
}

async function addSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  await fs.promises.appendFile(file, markdown + '\n');
}
// --------------------------------------------------------------------

function tail(text, max) {
  if (text.length <= max) return text;
  return '... (output truncated, showing last ' + max + ' characters)\n\n' + text.slice(-max);
}

function shellPath(shell) {
  switch ((shell || 'bash').trim().toLowerCase()) {
    case 'sh': return '/bin/sh';
    case 'pwsh': return 'pwsh';
    case 'bash':
    default: return '/bin/bash';
  }
}

function runCommand(command, shell, cwd) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, [], { shell: shellPath(shell), cwd });
    child.stdout.on('data', (d) => { stdout += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(d); });
    child.on('error', (err) => { stderr += String(err); resolve({ exitCode: 1, stdout, stderr }); });
    child.on('close', (code) => resolve({ exitCode: code === null ? 1 : code, stdout, stderr }));
  });
}

function headSha() {
  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      if (event.pull_request && event.pull_request.head && event.pull_request.head.sha) {
        return event.pull_request.head.sha;
      }
    } catch (err) {
      warning(`soft-fail: could not read pull_request head SHA: ${err.message}`);
    }
  }
  return process.env.GITHUB_SHA;
}

async function createNeutralCheckRun({ apiUrl, token, owner, repo, sha, checkName, command, exitCode, logText }) {
  const res = await fetch(`${apiUrl}/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      name: checkName,
      head_sha: sha,
      status: 'completed',
      conclusion: 'neutral',
      output: {
        title: `Soft failure: \`${command.length > 80 ? command.slice(0, 80) + '…' : command}\` (exit ${exitCode})`,
        summary:
          `The command failed with exit code ${exitCode}, but soft-fail kept the job green.\n\n` +
          `This is the behaviour GitHub Actions still lacks natively ` +
          `([actions/runner#2347](https://github.com/actions/runner/issues/2347)). ` +
          `Unlike \`continue-on-error\`, the failure is not hidden: it is recorded here as a neutral check run.`,
        text: logText
      }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

// --- PR comment -------------------------------------------------------
// The comment carries a hidden marker plus the workflow run id, so the
// action can find its own comment again and tell runs apart:
//   <!-- soft-fail-pr-comment -->
//   <!-- soft-fail-run-id: 123456789 -->
// Run ids grow over time, so only a run whose id is >= the one stored in
// the comment may change or delete it. An older run finishing after a
// newer one therefore cannot clobber the newer run's report.
const PR_COMMENT_MARKER = '<!-- soft-fail-pr-comment -->';
const PR_COMMENT_RUN_RE = /<!-- soft-fail-run-id:\s*(\d+)\s*-->/;
const PR_COMMENT_ENTRY_RE = /^-\s+\*\*(.+?)\*\*\s+—\s+`([^`]*)`\s+\(exit\s+(\d+)\)(?:\s+—\s+\[check run\]\(([^)]+)\))?/;

function prNumber() {
  if (process.env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      if (event.pull_request && typeof event.pull_request.number === 'number') {
        return event.pull_request.number;
      }
    } catch (err) {
      warning(`soft-fail: could not read pull request number: ${err.message}`);
    }
  }
  const refMatch = /^refs\/pull\/(\d+)\/merge$/.exec(process.env.GITHUB_REF || '');
  return refMatch ? Number(refMatch[1]) : null;
}

function runId() {
  const id = Number(process.env.GITHUB_RUN_ID || '');
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function ghApi(apiUrl, token, method, path, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* plain-text error body */ }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

async function listPrComments({ apiUrl, token, owner, repo, number }) {
  // Comments come back oldest first, and our marker comment is recent, so
  // follow pagination to the last page (capped at 5 pages / 500 comments).
  const comments = [];
  let path = `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`;
  for (let page = 0; page < 5 && path; page++) {
    const { ok, status, json, text, headers } = await ghApi(apiUrl, token, 'GET', path);
    if (!ok) throw new Error(`GitHub API ${status}: ${text.slice(0, 300)}`);
    if (!Array.isArray(json)) throw new Error('GitHub API returned an unexpected comments payload.');
    comments.push(...json);
    const linkHeader = headers && typeof headers.get === 'function' ? headers.get('link') || '' : '';
    const nextMatch = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
    path = nextMatch ? nextMatch[1].replace(apiUrl, '') : null;
  }
  return comments;
}

function findSoftFailComment(comments) {
  for (const comment of comments) {
    const body = comment.body || '';
    if (!body.includes(PR_COMMENT_MARKER)) continue;
    const runMatch = PR_COMMENT_RUN_RE.exec(body);
    return {
      id: comment.id,
      runId: runMatch ? Number(runMatch[1]) : null,
      body
    };
  }
  return null;
}

function renderEntry(entry) {
  const link = entry.checkUrl ? ` — [check run](${entry.checkUrl})` : '';
  return `- **${entry.checkName}** — \`${entry.command}\` (exit ${entry.exitCode})${link}`;
}

function parseEntries(body) {
  const entries = [];
  for (const line of body.split('\n')) {
    const match = PR_COMMENT_ENTRY_RE.exec(line.trim());
    if (!match) continue;
    entries.push({
      checkName: match[1],
      command: match[2],
      exitCode: Number(match[3]),
      checkUrl: match[4] || ''
    });
  }
  return entries;
}

function buildCommentBody(currentRunId, entries) {
  const lines = [
    PR_COMMENT_MARKER,
    `<!-- soft-fail-run-id: ${currentRunId} -->`,
    '',
    '## Soft failures in this run',
    '',
    'The following steps failed softly — the job stayed green, but the failures are recorded as neutral check runs:',
    '',
    ...entries.map(renderEntry),
    '',
    '_Posted by [soft-fail](https://github.com/Jitujoshi71/soft-fail) — GitLab-style allow_failure for GitHub Actions._'
  ];
  return lines.join('\n');
}

function mergeEntries(existing, entry) {
  // One line per check name: a retried step replaces its own line instead
  // of duplicating it; different steps accumulate.
  const merged = existing.filter((e) => e.checkName !== entry.checkName);
  merged.push(entry);
  return merged;
}

async function upsertPrCommentOnFailure({ apiUrl, token, owner, repo, number, currentRunId, entry }) {
  const comments = await listPrComments({ apiUrl, token, owner, repo, number });
  const found = findSoftFailComment(comments);
  if (found && found.runId !== null && found.runId > currentRunId) {
    info('soft-fail: PR comment belongs to a newer run; leaving it alone.');
    return;
  }
  const baseEntries = found && found.runId === currentRunId ? parseEntries(found.body) : [];
  const body = buildCommentBody(currentRunId, mergeEntries(baseEntries, entry));
  if (found) {
    const { ok, status, text } = await ghApi(apiUrl, token, 'PATCH', `/repos/${owner}/${repo}/issues/comments/${found.id}`, { body });
    if (!ok) throw new Error(`GitHub API ${status}: ${text.slice(0, 300)}`);
    info('soft-fail: updated the PR comment with this soft failure.');
  } else {
    const { ok, status, text } = await ghApi(apiUrl, token, 'POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
    if (!ok) throw new Error(`GitHub API ${status}: ${text.slice(0, 300)}`);
    info('soft-fail: posted a PR comment listing this soft failure.');
  }
}

async function cleanupStalePrComment({ apiUrl, token, owner, repo, number, currentRunId }) {
  const comments = await listPrComments({ apiUrl, token, owner, repo, number });
  const found = findSoftFailComment(comments);
  if (!found) return;
  // Same run: an earlier step in this run failed, so the comment stays.
  // Newer run: not ours to touch. Older run: stale — this run has no
  // soft failures so far, so remove it. A later failing step in this run
  // recreates it if needed.
  if (found.runId === null || found.runId >= currentRunId) return;
  const { ok, status, text } = await ghApi(apiUrl, token, 'DELETE', `/repos/${owner}/${repo}/issues/comments/${found.id}`);
  if (!ok) throw new Error(`GitHub API ${status}: ${text.slice(0, 300)}`);
  info('soft-fail: removed the stale PR comment from an older run (no soft failures in this run so far).');
}
// ----------------------------------------------------------------------

async function run() {
  try {
    const command = getInput('run', { required: true });
    const checkName = getInput('check-name') || 'soft-fail';
    const workingDirectory = getInput('working-directory') || undefined;
    const shell = getInput('shell') || 'bash';
    const createSummary = (getInput('create-summary') || 'true').toLowerCase() !== 'false';
    const commentOnPr = (getInput('comment-on-pr') || 'false').toLowerCase() === 'true';

    const token = getInput('token') || process.env.GITHUB_TOKEN;
    if (!token) {
      setFailed('soft-fail: no token. Pass one via the "token" input (it defaults to ${{ github.token }}) or set GITHUB_TOKEN. The action needs a token with checks: write permission.');
      return;
    }

    const repoFull = process.env.GITHUB_REPOSITORY || '';
    const [owner, repo] = repoFull.split('/');
    if (!owner || !repo) {
      setFailed('soft-fail: GITHUB_REPOSITORY is not set (expected "owner/repo").');
      return;
    }

    const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
    const sha = headSha();
    if (!sha) {
      setFailed('soft-fail: could not determine the commit SHA (GITHUB_SHA is not set).');
      return;
    }

    const number = commentOnPr ? prNumber() : null;
    const currentRunId = commentOnPr ? runId() : null;
    if (commentOnPr && (number === null || currentRunId === null)) {
      warning('soft-fail: comment-on-pr is true but this does not look like a pull request run (no PR number or run id) — skipping the PR comment.');
    }

    info(`soft-fail: running \`${command}\` via ${shell}`);
    const { exitCode, stdout, stderr } = await runCommand(command, shell, workingDirectory);
    setOutput('exit-code', String(exitCode));

    if (exitCode === 0) {
      setOutput('outcome', 'success');
      info('soft-fail: command passed.');
      if (commentOnPr && number !== null && currentRunId !== null) {
        try {
          await cleanupStalePrComment({ apiUrl, token, owner, repo, number, currentRunId });
        } catch (err) {
          warning(`soft-fail: could not clean up the stale PR comment: ${err.message}`);
        }
      }
      return;
    }

    // --- Soft failure path: make it visible, then stay green. ---
    const logText = tail(
      `$ ${command}\n(exit code ${exitCode})\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      MAX_LOG_CHARS
    );

    let checkRun = null;
    try {
      checkRun = await createNeutralCheckRun({ apiUrl, token, owner, repo, sha, checkName, command, exitCode, logText });
    } catch (err) {
      // If we cannot record the failure anywhere, failing loudly is safer
      // than hiding it — that is exactly the continue-on-error trap.
      setFailed(
        `soft-fail: command failed (exit ${exitCode}) AND the neutral check run could not be created: ${err.message}. ` +
        `Give the workflow "checks: write" permission (see README).`
      );
      return;
    }

    if (createSummary) {
      try {
        await addSummary(
          `## Soft failure (job stayed green)\n\n` +
          `Command \`${command}\` failed with exit code ${exitCode}. ` +
          `Recorded as neutral check run **${checkName}** — see the Checks tab for the full log.`
        );
      } catch (err) {
        warning(`soft-fail: could not write job summary: ${err.message}`);
      }
    }

    // The PR comment is a bonus on top of the check run: if it cannot be
    // posted (for example the workflow lacks pull-requests: write), warn
    // loudly but keep the step green — the failure is already recorded.
    if (commentOnPr && number !== null && currentRunId !== null) {
      try {
        await upsertPrCommentOnFailure({
          apiUrl, token, owner, repo, number, currentRunId,
          entry: { checkName, command, exitCode, checkUrl: (checkRun && checkRun.html_url) || '' }
        });
      } catch (err) {
        warning(
          `soft-fail: could not post the PR comment: ${err.message}. ` +
          `The failure is still recorded as a neutral check run; give the workflow "pull-requests: write" permission to enable PR comments (see README).`
        );
      }
    }

    setOutput('outcome', 'soft-failed');
    warning(`soft-fail: command failed (exit ${exitCode}); recorded as neutral check run "${checkName}", job stays green.`);
  } catch (err) {
    setFailed(`soft-fail: ${err.message}`);
  }
}

run();
