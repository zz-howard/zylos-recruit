/**
 * Shared bubblewrap (bwrap) sandbox for CLI runtimes.
 *
 * Two modes:
 *
 *   minimalFS=false (legacy, broad):
 *     - / read-only, then tmpfs-mask sensitive dirs (.ssh/.gnupg/...)
 *       and /dev/null-mask sensitive files (.env, .netrc, ...)
 *     - Large blast radius: all of $HOME and the filesystem is visible.
 *
 *   minimalFS=true (recommended, least-privilege):
 *     - Start empty. Bind only system paths (/usr, /lib*, /bin, /etc, ...),
 *       CLI runtime paths (node via nvm, CLI binary), plus caller-provided
 *       rwBinds (auth/state) and roBinds (scenario data, e.g. resumes/).
 *     - $HOME is a tmpfs — nothing under it is visible unless explicitly bound.
 *
 * Every mode:
 *   - /tmp tmpfs, --proc, --dev
 *   - Network shared (CLIs call remote APIs)
 *   - PID/IPC/UTS/cgroup namespaces isolated, --die-with-parent, --new-session
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

function buildLegacyArgs({ rwBinds }) {
  const home = homedir();
  const args = [
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp',
    '--proc', '/proc',
    '--dev', '/dev',
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
  return args;
}

// System paths typically needed for dynamically-linked binaries + CLI behavior.
const MINIMAL_SYSTEM_RO = [
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32',
  '/etc', '/opt',
];

function buildMinimalArgs({ rwBinds, roBinds, extraSystemRo }) {
  const home = homedir();
  const args = [
    '--tmpfs', '/',
    '--tmpfs', '/tmp',
    '--tmpfs', '/var',
    '--tmpfs', home,
    '--proc', '/proc',
    '--dev', '/dev',
    '--chdir', '/tmp',
  ];

  for (const p of [...MINIMAL_SYSTEM_RO, ...extraSystemRo]) {
    if (statKind(p) === 'dir') args.push('--ro-bind', p, p);
  }

  // Runtime paths: best-effort (bound only if present).
  const runtimeRo = [
    `${home}/.nvm`,
    `${home}/.local/bin`,
    `${home}/.local/share/claude`,
    `${home}/.local/share/pnpm`,
    `${home}/.npm`,
  ];
  for (const p of runtimeRo) {
    if (statKind(p) === 'dir') args.push('--ro-bind', p, p);
  }

  for (const p of roBinds) {
    if (statKind(p) === 'dir') args.push('--ro-bind', p, p);
  }

  for (const p of rwBinds) {
    if (statKind(p) === 'dir') args.push('--bind', p, p);
  }

  return args;
}

function buildBwrapArgs(cmd, cmdArgs, {
  rwBinds = [],
  roBinds = [],
  extraSystemRo = [],
  minimalFS = false,
} = {}) {
  const base = minimalFS
    ? buildMinimalArgs({ rwBinds, roBinds, extraSystemRo })
    : buildLegacyArgs({ rwBinds });

  base.push(
    '--share-net',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
    '--die-with-parent',
    '--new-session',
    '--', cmd, ...cmdArgs,
  );
  return base;
}

/**
 * Spawn a command inside bwrap if available, otherwise spawn directly.
 * @param {string} cmd - executable name
 * @param {string[]} args - command arguments
 * @param {object} opts - spawn options (stdio, env, ...)
 * @param {object} [sandbox]
 * @param {string[]} [sandbox.rwBinds]       - read-write bind mounts (CLI auth/state dirs)
 * @param {string[]} [sandbox.roBinds]       - read-only bind mounts (scenario data dirs)
 * @param {string[]} [sandbox.extraSystemRo] - extra system paths to ro-bind (minimalFS only)
 * @param {boolean}  [sandbox.minimalFS]     - if true, start from empty FS and bind only
 *                                             system/runtime/caller-specified paths
 */
export function spawnSandboxed(cmd, args, opts, sandbox = {}) {
  if (hasBwrap()) {
    return spawn(BWRAP_PATH, buildBwrapArgs(cmd, args, sandbox), opts);
  }
  return spawn(cmd, args, opts);
}
