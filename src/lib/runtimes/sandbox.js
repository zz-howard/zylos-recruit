/**
 * Shared SRT sandbox wrapper for CLI runtimes.
 *
 * Public API stays synchronous for existing adapters:
 *   spawnSandboxed(cmd, args, opts, sandbox) -> ChildProcess
 *
 * The actual SRT initialization is async, so the child process is a small Node
 * runner that initializes @anthropic-ai/sandbox-runtime, wraps the command, and
 * forwards stdio/signals. Sandbox failures fail closed by default.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os, { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import shellquote from 'shell-quote';
import { getConfig } from '../config.js';

const HOME = homedir();
const ZYLOS_DIR = path.join(HOME, 'zylos');

function srtVendorPaths() {
  try {
    const srtEntry = fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'));
    const vendorDir = path.resolve(path.dirname(srtEntry), '..', 'vendor');
    return fs.existsSync(vendorDir) ? [vendorDir] : [];
  } catch {
    return [];
  }
}
const RUNNER_PATH = fileURLToPath(new URL('./sandbox-runner.js', import.meta.url));
const PAYLOAD_DIR = path.join(tmpdir(), 'zylos-recruit-sandbox');
const SANDBOX_CWD = path.join(tmpdir(), 'zylos-recruit-sandbox-cwd');

const DEFAULT_ALLOWED_DOMAINS = [
  'api.anthropic.com',
  'console.anthropic.com',
  'api.openai.com',
  'chatgpt.com',
  'auth.openai.com',
  'generativelanguage.googleapis.com',
  '*.googleapis.com',
];

const DEFAULT_DENIED_DOMAINS = [
  'metadata.google.internal',
  '169.254.169.254',
  '127.0.0.1',
  '::1',
  'localhost',
];

const RUNTIME_SUPPORT_PATHS = [
  path.join(HOME, '.nvm'),
  path.join(HOME, '.local/bin'),
  path.join(HOME, '.local/share/claude'),
  path.join(HOME, '.local/share/pnpm'),
  path.join(HOME, '.npm'),
  '/opt/homebrew/bin',
  '/opt/homebrew/lib/node_modules',
  '/usr/local/bin',
  '/usr/local/lib/node_modules',
];

function existingPaths(paths) {
  return [...new Set((paths || []).filter(Boolean).map((p) => path.resolve(p)))]
    .filter((p) => fs.existsSync(p));
}

export function quoteSandboxCommand(cmd, args = []) {
  return shellquote.quote([cmd, ...args]);
}

function sandboxConfigFromGlobalConfig() {
  return getConfig().ai?.sandbox || {};
}

function runtimeAuthStatePaths(runtime, legacyRwBinds = []) {
  const defaults = {
    claude: [path.join(HOME, '.claude')],
    codex: [path.join(HOME, '.codex')],
    gemini: [path.join(HOME, '.gemini')],
  };
  return existingPaths([...legacyRwBinds, ...(defaults[runtime] || [])]);
}

function resolveCommandPath(cmd, env) {
  if (!cmd || cmd.includes('/')) return cmd;
  try {
    return execFileSync('which', [cmd], {
      encoding: 'utf8',
      timeout: 3000,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function commandSupportPaths(cmd, env) {
  const resolved = resolveCommandPath(cmd, env);
  if (!resolved) return [];
  const paths = [path.dirname(resolved)];
  if (resolved.startsWith(HOME + path.sep)) {
    const segments = resolved.slice(HOME.length + 1).split(path.sep);
    if (segments[0]) paths.push(path.join(HOME, segments[0]));
    if (segments[0] === '.nvm') paths.push(path.join(HOME, '.nvm'));
    if (segments[0] === '.local') paths.push(path.join(HOME, '.local'));
  }
  return paths;
}

function networkConfig(sandboxNetwork = {}) {
  const configured = sandboxConfigFromGlobalConfig().network || {};
  return {
    allowedDomains: [
      ...DEFAULT_ALLOWED_DOMAINS,
      ...(configured.allowedDomains || []),
      ...(sandboxNetwork.allowedDomains || []),
    ],
    deniedDomains: [
      ...DEFAULT_DENIED_DOMAINS,
      ...(configured.deniedDomains || []),
      ...(sandboxNetwork.deniedDomains || []),
    ],
    ...(configured.allowUnixSockets ? { allowUnixSockets: configured.allowUnixSockets } : {}),
    ...(configured.allowAllUnixSockets ? { allowAllUnixSockets: true } : {}),
    ...(configured.allowLocalBinding ? { allowLocalBinding: true } : {}),
    ...(configured.allowMachLookup ? { allowMachLookup: configured.allowMachLookup } : {}),
    ...(configured.parentProxy ? { parentProxy: configured.parentProxy } : {}),
  };
}

export function buildSandboxRuntimeConfig(cmd, opts = {}, sandbox = {}) {
  const runtime = sandbox.runtime || 'unknown';
  const legacyRwBinds = sandbox.rwBinds || [];
  const legacyRoBinds = sandbox.roBinds || [];
  const authStatePaths = existingPaths([
    ...runtimeAuthStatePaths(runtime, legacyRwBinds),
    ...(sandbox.authStatePaths || []),
  ]);
  const readOnlyPaths = existingPaths([
    ...legacyRoBinds,
    ...(sandbox.readOnlyPaths || []),
  ]);
  const supportPaths = existingPaths([
    ...RUNTIME_SUPPORT_PATHS,
    ...commandSupportPaths(cmd, opts.env),
    ...(sandbox.supportReadPaths || []),
  ]).filter((p) => p !== ZYLOS_DIR && !p.startsWith(ZYLOS_DIR + path.sep));
  const tempWritePaths = existingPaths([
    tmpdir(),
    path.join(tmpdir(), 'claude'),
    path.join(tmpdir(), 'zylos-recruit-sandbox'),
    path.join(tmpdir(), 'zylos-recruit-sandbox-cwd'),
    ...(sandbox.writePaths || []),
  ]);

  return {
    network: {},
    filesystem: {
      denyRead: [HOME, ZYLOS_DIR],
      allowRead: [
        ...supportPaths,
        ...srtVendorPaths(),
        ...authStatePaths,
        ...readOnlyPaths,
      ],
      allowWrite: [
        ...authStatePaths,
        ...tempWritePaths,
      ],
      denyWrite: [],
      allowGitConfig: false,
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    ripgrep: { command: 'rg' },
    mandatoryDenySearchDepth: 3,
  };
}

function sandboxMetadata(sandbox = {}) {
  return {
    scenario: sandbox.scenario || 'unknown',
    runtime: sandbox.runtime || 'unknown',
    platform: os.platform(),
    seatbelt: os.platform() === 'darwin',
  };
}

function allowUnsandboxed(sandbox = {}) {
  return Boolean(sandbox.allowUnsandboxed || sandboxConfigFromGlobalConfig().allowUnsandboxed);
}

function writePayload(cmd, args, opts, sandbox) {
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SANDBOX_CWD, { recursive: true, mode: 0o700 });
  const payloadPath = path.join(
    PAYLOAD_DIR,
    `sandbox-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const payload = {
    cmd,
    args,
    runtimeConfig: buildSandboxRuntimeConfig(cmd, opts, sandbox),
    metadata: sandboxMetadata(sandbox),
    allowUnsandboxed: allowUnsandboxed(sandbox),
    shell: sandbox.shell || 'bash',
  };
  fs.writeFileSync(payloadPath, JSON.stringify(payload), { mode: 0o600 });
  return payloadPath;
}

/**
 * Spawn a command inside SRT. Fails closed unless sandbox.allowUnsandboxed or
 * ai.sandbox.allowUnsandboxed is explicitly true.
 */
export function spawnSandboxed(cmd, args = [], opts = {}, sandbox = {}) {
  const payloadPath = writePayload(cmd, args, opts, sandbox);
  const runnerArgs = [RUNNER_PATH, payloadPath];
  const runnerOpts = {
    ...opts,
    cwd: sandbox.cwd || SANDBOX_CWD,
  };
  return spawn(process.execPath, runnerArgs, runnerOpts);
}
