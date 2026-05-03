import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { homedir } from 'node:os';
import { buildSandboxRuntimeConfig, quoteSandboxCommand } from '../src/lib/runtimes/sandbox.js';

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

test('sandbox default network policy denies local and metadata endpoints', () => {
  const cfg = buildSandboxRuntimeConfig('node', {}, {
    scenario: 'chat',
    runtime: 'codex',
    authStatePaths: [],
    readOnlyPaths: [],
  });

  assert.equal(cfg.network.deniedDomains.includes('metadata.google.internal'), true);
  assert.equal(cfg.network.deniedDomains.includes('169.254.169.254'), true);
  assert.equal(cfg.network.deniedDomains.includes('127.0.0.1'), true);
  assert.equal(cfg.network.deniedDomains.includes('localhost'), true);
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
