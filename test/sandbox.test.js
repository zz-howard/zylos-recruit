import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { homedir } from 'node:os';
import { NetworkConfigSchema } from '@anthropic-ai/sandbox-runtime';
import {
  buildSandboxRuntimeConfig,
  networkConfigForSandbox,
  quoteSandboxCommand,
} from '../src/lib/runtimes/sandbox.js';

const HOME = homedir();
const ZYLOS_DIR = path.join(HOME, 'zylos');

test('chat sandbox denies home and zylos without scenario read paths', () => {
  const cfg = buildSandboxRuntimeConfig('node', {}, {
    scenario: 'chat',
    runtime: 'claude',
    authStatePaths: [],
    readOnlyPaths: [],
  });

  assert.deepEqual(cfg.filesystem.denyRead, [HOME, ZYLOS_DIR]);
  const zylosPaths = cfg.filesystem.allowRead.filter((p) => p.startsWith(ZYLOS_DIR));
  assert.equal(
    zylosPaths.every((p) => p.includes('sandbox-runtime/vendor')),
    true,
    'only SRT vendor paths may appear under zylos in allowRead',
  );
});

test('resume sandbox allows an exact existing resume file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruit-sandbox-test-'));
  const resume = path.join(dir, 'resume with spaces.pdf');
  const sibling = path.join(dir, 'sibling.pdf');
  fs.writeFileSync(resume, 'resume');
  fs.writeFileSync(sibling, 'sibling');

  const cfg = buildSandboxRuntimeConfig('node', {}, {
    scenario: 'resume_eval',
    runtime: 'codex',
    readOnlyPaths: [resume],
  });

  assert.equal(cfg.filesystem.allowRead.includes(resume), true);
  assert.equal(cfg.filesystem.allowRead.includes(sibling), false);
});

test('sandbox network policy remains unrestricted by default for WebFetch scenarios', () => {
  const cfg = buildSandboxRuntimeConfig('node', {}, {
    scenario: 'chat',
    runtime: 'codex',
    authStatePaths: [],
    readOnlyPaths: [],
  });

  assert.deepEqual(cfg.network, {});
});

test('sandbox network policy does not emit unsupported deny-only config', () => {
  const cfg = buildSandboxRuntimeConfig('node', {}, {
    scenario: 'chat',
    runtime: 'codex',
    authStatePaths: [],
    readOnlyPaths: [],
    network: {
      deniedDomains: ['localhost'],
    },
  });

  assert.deepEqual(cfg.network, {});
});

test('sandbox network policy adds priority-deny exclusions to explicit SRT allowlist', () => {
  const cfg = buildSandboxRuntimeConfig('node', {}, {
    scenario: 'chat',
    runtime: 'codex',
    authStatePaths: [],
    readOnlyPaths: [],
    network: {
      allowedDomains: ['example.com', '*.example.org'],
      deniedDomains: ['internal.example.com'],
    },
  });

  assert.deepEqual(cfg.network.allowedDomains, ['example.com', '*.example.org']);
  assert.equal(cfg.network.deniedDomains.includes('localhost'), true);
  assert.equal(cfg.network.deniedDomains.includes('127.0.0.1'), true);
  assert.equal(cfg.network.deniedDomains.includes('169.254.169.254'), true);
  assert.equal(cfg.network.deniedDomains.includes('metadata.google.internal'), true);
  assert.equal(cfg.network.deniedDomains.includes('internal.example.com'), true);
  assert.equal(NetworkConfigSchema.safeParse(cfg.network).success, true);
});

test('sandbox network policy inherits global allowlist when scenario has no override', () => {
  const network = networkConfigForSandbox({ scenario: 'chat' }, {
    sandbox: {
      network: {
        allowedDomains: ['global.example.com'],
        deniedDomains: ['blocked.global.example.com'],
      },
    },
  });

  assert.deepEqual(network.allowedDomains, ['global.example.com']);
  assert.equal(network.deniedDomains.includes('blocked.global.example.com'), true);
  assert.equal(NetworkConfigSchema.safeParse(network).success, true);
});

test('scenario network policy can narrow a global allowlist', () => {
  const network = networkConfigForSandbox({ scenario: 'chat' }, {
    sandbox: {
      network: {
        allowedDomains: ['global.example.com', 'wide.example.com'],
        deniedDomains: ['blocked.global.example.com'],
      },
    },
    chat: {
      sandbox: {
        network: {
          allowedDomains: ['chat.example.com'],
          deniedDomains: ['blocked.chat.example.com'],
        },
      },
    },
  });

  assert.deepEqual(network.allowedDomains, ['chat.example.com']);
  assert.equal(network.deniedDomains.includes('blocked.chat.example.com'), true);
  assert.equal(network.deniedDomains.includes('blocked.global.example.com'), false);
  assert.equal(NetworkConfigSchema.safeParse(network).success, true);
});

test('scenario network policy can opt out of global allowlist', () => {
  const network = networkConfigForSandbox({ scenario: 'chat' }, {
    sandbox: {
      network: {
        allowedDomains: ['global.example.com'],
      },
    },
    chat: {
      sandbox: {
        network: {},
      },
    },
  });

  assert.deepEqual(network, {});
});

test('home-installed command support exposes directories, not executable files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruit-sandbox-home-'));
  const homeBin = path.join(dir, '.local/bin');
  const command = path.join(homeBin, 'claude');
  fs.mkdirSync(homeBin, { recursive: true });
  fs.writeFileSync(command, '#!/bin/sh\n');
  fs.chmodSync(command, 0o755);

  const cfg = buildSandboxRuntimeConfig('claude', {
    env: {
      ...process.env,
      PATH: `${homeBin}:${process.env.PATH}`,
    },
  }, {
    scenario: 'resume_eval',
    runtime: 'claude',
    authStatePaths: [],
    readOnlyPaths: [],
  });

  assert.equal(cfg.filesystem.allowRead.includes(command), false);
  assert.equal(cfg.filesystem.allowRead.includes(homeBin), true);
});

test('support paths overlapping zylos directory are excluded from allowRead', () => {
  const cfg = buildSandboxRuntimeConfig('node', {}, {
    scenario: 'chat',
    runtime: 'claude',
    authStatePaths: [],
    readOnlyPaths: [],
    supportReadPaths: [ZYLOS_DIR, path.join(ZYLOS_DIR, 'memory')],
  });

  const zylosPaths = cfg.filesystem.allowRead.filter(
    (p) => p === ZYLOS_DIR || p.startsWith(ZYLOS_DIR + path.sep),
  );
  const srtVendor = zylosPaths.filter((p) => p.includes('sandbox-runtime/vendor'));
  assert.equal(zylosPaths.length, srtVendor.length,
    'only SRT vendor paths may appear under zylos in allowRead');
  assert.equal(cfg.filesystem.allowRead.includes(ZYLOS_DIR), false,
    'ZYLOS_DIR itself must not be in allowRead');
  assert.equal(cfg.filesystem.allowRead.includes(path.join(ZYLOS_DIR, 'memory')), false,
    'zylos/memory must not be in allowRead');
});

test('SRT vendor directory is in allowRead for apply-seccomp access', () => {
  const cfg = buildSandboxRuntimeConfig('node', {}, {
    scenario: 'chat',
    runtime: 'claude',
    authStatePaths: [],
    readOnlyPaths: [],
  });

  const vendorPaths = cfg.filesystem.allowRead.filter(
    (p) => p.includes('sandbox-runtime/vendor'),
  );
  assert.equal(vendorPaths.length > 0, true,
    'SRT vendor dir must be in allowRead so apply-seccomp is accessible inside sandbox');
});

test('.claude.json is in allowRead but not allowWrite for claude runtime', () => {
  const claudeJson = path.join(HOME, '.claude.json');
  if (!fs.existsSync(claudeJson)) {
    return; // skip if file doesn't exist on this machine
  }

  const cfg = buildSandboxRuntimeConfig('claude', {}, {
    scenario: 'chat',
    runtime: 'claude',
  });

  assert.equal(cfg.filesystem.allowRead.includes(claudeJson), true,
    '.claude.json must be in allowRead');
  assert.equal(cfg.filesystem.allowWrite.includes(claudeJson), false,
    '.claude.json must NOT be in allowWrite');
});

test('quoted command preserves argv boundaries for shell-sensitive input', () => {
  const expected = [
    'space value',
    'quote " value',
    "single ' quote",
    'line\nbreak',
    'dollar $HOME',
    'semi;colon',
    '`backtick`',
  ];
  const quoted = quoteSandboxCommand('node', [
    '-e',
    'console.log(JSON.stringify(process.argv.slice(1)))',
    ...expected,
  ]);

  const output = execFileSync('/bin/sh', ['-c', quoted], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), expected);
});
