/**
 * Shared bubblewrap (bwrap) sandbox for CLI runtimes.
 *
 * Wraps a subprocess in an unprivileged Linux namespace sandbox:
 *   - / read-only
 *   - /tmp tmpfs (isolated, dropped on exit)
 *   - Sensitive dirs masked with tmpfs (.ssh, .gnupg, .aws, .kube)
 *   - Sensitive files masked with ro-bind /dev/null (.env, .netrc, gh/hosts.yml, etc.)
 *   - Network shared (CLIs call remote APIs)
 *   - PID/IPC/UTS/cgroup namespaces isolated, --die-with-parent
 *
 * Each CLI passes its own rwBinds for auth/state dirs (~/.codex, ~/.claude, ~/.gemini).
 *
 * Interview prompts contain user-controlled content (prompt injection risk).
 * This layer is defense-in-depth on top of each CLI's own sandbox/tool restrictions.
 * Falls through transparently to plain spawn if bwrap is not installed.
 */

import { execFileSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';

const BWRAP_PATH = '/usr/bin/bwrap';

let bwrapAvailable;
export function hasBwrap() {
  if (bwrapAvailable !== undefined) return bwrapAvailable;
  try {
    execFileSync(BWRAP_PATH, ['--version'], { stdio: 'ignore', timeout: 2000 });
    bwrapAvailable = true;
  } catch { bwrapAvailable = false; }
  return bwrapAvailable;
}

function statKind(path) {
  try {
    const s = statSync(path);
    if (s.isDirectory()) return 'dir';
    if (s.isFile()) return 'file';
    return 'other';
  } catch { return null; }
}

function buildBwrapArgs(cmd, cmdArgs, { rwBinds = [] } = {}) {
  const home = homedir();
  const args = [
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp',
    '--proc', '/proc',
    '--dev', '/dev',
    '--share-net',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
    '--die-with-parent',
    '--new-session',
  ];

  for (const p of rwBinds) {
    if (statKind(p) === 'dir') args.push('--bind', p, p);
  }

  const secretDirs = [`${home}/.ssh`, `${home}/.gnupg`, `${home}/.aws`, `${home}/.kube`];
  for (const p of secretDirs) {
    if (rwBinds.includes(p)) continue;
    if (statKind(p) === 'dir') args.push('--tmpfs', p);
  }

  const secretFiles = [
    `${home}/zylos/.env`,
    `${home}/.netrc`,
    `${home}/.pgpass`,
    `${home}/.config/gh/hosts.yml`,
    `${home}/.anthropic/api-key`,
  ];
  for (const p of secretFiles) {
    if (statKind(p) === 'file') args.push('--ro-bind', '/dev/null', p);
  }

  args.push('--', cmd, ...cmdArgs);
  return args;
}

/**
 * Spawn a command inside bwrap if available, otherwise spawn directly.
 * @param {string} cmd - executable name
 * @param {string[]} args - command arguments
 * @param {object} opts - spawn options (stdio, env, ...)
 * @param {{ rwBinds?: string[] }} [sandbox] - extra rw bind mounts (e.g. CLI config dirs)
 */
export function spawnSandboxed(cmd, args, opts, sandbox = {}) {
  if (hasBwrap()) {
    return spawn(BWRAP_PATH, buildBwrapArgs(cmd, args, sandbox), opts);
  }
  return spawn(cmd, args, opts);
}
