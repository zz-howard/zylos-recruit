#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { quoteSandboxCommand } from './sandbox.js';

const payloadPath = process.argv[2];

function readPayload() {
  if (!payloadPath) throw new Error('missing sandbox payload path');
  const raw = fs.readFileSync(payloadPath, 'utf8');
  try {
    fs.rmSync(payloadPath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
  return JSON.parse(raw);
}

function emitSandboxStatus(sandboxed, reason) {
  const status = JSON.stringify({ sandboxed, reason: reason || null });
  process.stderr.write(`[recruit:sandbox-status] ${status}\n`);
}

function logUnsandboxed(metadata, reason) {
  const scenario = metadata?.scenario || 'unknown';
  const runtime = metadata?.runtime || 'unknown';
  const platform = metadata?.platform || process.platform;
  console.error(
    `[recruit] WARNING: running AI command without sandbox ` +
    `(scenario=${scenario}, runtime=${runtime}, platform=${platform}): ${reason}`,
  );
}

function spawnShellCommand(command, env, stdinFile) {
  // stdinFile carries oversized prompts: argv is shell-quoted into a single
  // `sh -c` string, so a prompt in argv can exceed MAX_ARG_STRLEN (E2BIG).
  // The fd is opened before sandbox wrapping; the child inherits it as fd 0.
  let stdin = 'inherit';
  if (stdinFile) {
    stdin = fs.openSync(stdinFile, 'r');
  }
  const child = spawn(command, {
    shell: true,
    stdio: [stdin, 'inherit', 'inherit'],
    env,
  });
  if (typeof stdin === 'number') {
    child.once('spawn', () => { try { fs.closeSync(stdin); } catch { /* already closed */ } });
    child.once('error', () => { try { fs.closeSync(stdin); } catch { /* already closed */ } });
  }
  return child;
}

function cleanupStdinFile(stdinFile) {
  if (!stdinFile) return;
  try { fs.rmSync(stdinFile, { force: true }); } catch { /* best-effort */ }
}

function exitLikeChild(code, signal) {
  if (signal) {
    process.exit(128 + (os.constants.signals[signal] || 1));
    return;
  }
  process.exit(code ?? 0);
}

async function main() {
  const payload = readPayload();
  const { cmd, args, runtimeConfig, metadata, allowUnsandboxed, shell, stdinFile } = payload;
  const command = quoteSandboxCommand(cmd, args || []);

  let wrappedCommand;
  try {
    await SandboxManager.initialize(runtimeConfig);
    wrappedCommand = await SandboxManager.wrapWithSandbox(command, shell);
    emitSandboxStatus(true, null);
  } catch (err) {
    if (!allowUnsandboxed) {
      cleanupStdinFile(stdinFile);
      console.error(`[recruit] sandbox initialization failed closed: ${err.message}`);
      process.exit(126);
    }
    logUnsandboxed(metadata, err.message);
    emitSandboxStatus(false, err.message);
    wrappedCommand = command;
  }

  let child;
  try {
    child = spawnShellCommand(wrappedCommand, process.env, stdinFile);
  } catch (err) {
    cleanupStdinFile(stdinFile);
    throw err;
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupStdinFile(stdinFile);
    try {
      SandboxManager.cleanupAfterCommand();
    } catch {
      // Cleanup must not mask the child process result.
    }
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      if (child.exitCode === null && !child.killed) child.kill(sig);
    });
  }

  child.on('error', (err) => {
    cleanup();
    console.error(`[recruit] sandboxed command failed to start: ${err.message}`);
    process.exit(127);
  });

  child.on('close', (code, signal) => {
    cleanup();
    exitLikeChild(code, signal);
  });
}

main().catch((err) => {
  console.error(`[recruit] sandbox runner failed: ${err.message}`);
  process.exit(1);
});
