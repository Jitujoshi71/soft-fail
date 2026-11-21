// soft-fail — GitLab-style allow_failure for GitHub Actions.
//
// Runs your command. If it exits 0, the step passes as normal.
// If it fails, soft-fail creates a separate Check Run with conclusion
// "neutral" (full log included), writes a job summary, and exits 0 —
// so the job and PR stay green, but the failure stays visible in the
// Checks tab instead of being hidden the way `continue-on-error` hides it.
//
// This exists because GitHub has no native allow-failure:
// https://github.com/actions/runner/issues/2347 (open since 2020,
// 1,590+ reactions, still unshipped).
//
// Required permission in the calling workflow:
//   permissions:
//     checks: write
//     contents: read
//
// Zero dependencies (Node 20 builtins only) — the Checks API is called
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
}

async function run() {
  try {
    const command = getInput('run', { required: true });
    const checkName = getInput('check-name') || 'soft-fail';
    const workingDirectory = getInput('working-directory') || undefined;
    const shell = getInput('shell') || 'bash';
    const createSummary = (getInput('create-summary') || 'true').toLowerCase() !== 'false';

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      setFailed('soft-fail: GITHUB_TOKEN is not set. This action needs the default workflow token with checks: write permission.');
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

    info(`soft-fail: running \`${command}\` via ${shell}`);
    const { exitCode, stdout, stderr } = await runCommand(command, shell, workingDirectory);
    setOutput('exit-code', String(exitCode));

    if (exitCode === 0) {
      setOutput('outcome', 'success');
      info('soft-fail: command passed.');
      return;
    }

    // --- Soft failure path: make it visible, then stay green. ---
    const logText = tail(
      `$ ${command}\n(exit code ${exitCode})\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      MAX_LOG_CHARS
    );

    try {
      await createNeutralCheckRun({ apiUrl, token, owner, repo, sha, checkName, command, exitCode, logText });
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

    setOutput('outcome', 'soft-failed');
    warning(`soft-fail: command failed (exit ${exitCode}); recorded as neutral check run "${checkName}", job stays green.`);
  } catch (err) {
    setFailed(`soft-fail: ${err.message}`);
  }
}

run();
