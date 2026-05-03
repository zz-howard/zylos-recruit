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
  assert.equal(cfg.filesystem.allowRead.some((p) => p.startsWith(ZYLOS_DIR)), false);
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
