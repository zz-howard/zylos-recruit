#!/usr/bin/env node
/**
 * Post-install hook for zylos-recruit
 *
 * Called by Claude after CLI installation.
 * Creates data directories, generates a random login password,
 * and writes config.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execSync } from 'node:child_process';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/recruit');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Generate random password + scrypt hash
const generatedPassword = crypto.randomBytes(16).toString('base64url');
const salt = crypto.randomBytes(32);
const hash = crypto.scryptSync(generatedPassword, salt, 64);
const hashedPassword = `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;

const INITIAL_CONFIG = {
  enabled: true,
  port: 3465,
  auth: {
    enabled: true,
    password: hashedPassword,
  },
  upload: {
    maxFileSizeBytes: 10 * 1024 * 1024,
    allowedMimeTypes: ['application/pdf'],
  },
  rateLimit: {
    windowMs: 60_000,
    max: 120,
  },
  ai: {
    sandbox: {
      allowUnsandboxed: false,
    },
  },
};

console.log('[post-install] Running recruit-specific setup...\n');

// 1. Create subdirectories
console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'resumes'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'knowledge'), { recursive: true });
console.log('  - logs/');
console.log('  - resumes/');
console.log('  - knowledge/');

// 2. Create default config if not exists
if (!fs.existsSync(CONFIG_PATH)) {
  console.log('\nCreating default config.json...');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(INITIAL_CONFIG, null, 2), { mode: 0o600 });
  console.log('  - config.json created');
  console.log('\n  ╭────────────────────────────────────────╮');
  console.log('  │  🔑  Save this password — shown once:   │');
  console.log('  │                                        │');
  console.log('  │  ' + generatedPassword.padEnd(36) + '  │');
  console.log('  │                                        │');
  console.log('  │  To reset: delete auth.password in     │');
  console.log('  │  config.json and re-run post-install.  │');
  console.log('  ╰────────────────────────────────────────╯');
} else {
  // If config exists but has no auth, add it
  try {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (!existing.auth || !existing.auth.password) {
      existing.auth = { enabled: true, password: hashedPassword };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2), { mode: 0o600 });
      console.log('\nAdded auth to existing config.');
      console.log(`  Generated password: ${generatedPassword}`);
    } else {
      console.log('\nConfig already exists with auth, skipping.');
    }
  } catch {
    console.log('\nConfig already exists (unreadable), skipping.');
  }
}

function hasCommand(command) {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 3. Check SRT sandbox dependencies. Interview AI fails closed when missing.
const platform = os.platform();
console.log('\nChecking AI sandbox dependencies...');
if (platform === 'linux') {
  if (hasCommand('bwrap')) {
    console.log('  - bwrap detected ✓');
  } else {
    console.warn('  - bwrap not found, attempting install via apt...');
    try {
      execSync('sudo apt install -y bubblewrap', { stdio: 'inherit' });
      console.log('    bwrap installed ✓');
    } catch {
      console.error('    ⚠ apt install failed. Try: sudo apt install bubblewrap');
    }
  }

  if (hasCommand('socat')) console.log('  - socat detected ✓');
  else console.warn('  - ⚠ socat not found. Install it before using interview AI sandboxing.');

  if (hasCommand('rg')) console.log('  - rg detected ✓');
  else console.warn('  - ⚠ ripgrep (rg) not found. SRT v0.0.49 requires it for dangerous-path scanning.');
} else if (platform === 'darwin') {
  if (hasCommand('sandbox-exec')) console.log('  - sandbox-exec detected ✓');
  else console.warn('  - ⚠ sandbox-exec not found. macOS Seatbelt sandboxing will be unavailable.');

  if (hasCommand('rg')) console.log('  - rg detected ✓');
  else console.warn('  - ⚠ ripgrep (rg) not found. SRT v0.0.49 requires it during initialization.');
} else {
  console.warn(`  - ⚠ unsupported sandbox platform: ${platform}`);
}
console.log('  Missing sandbox dependencies cause interview AI subprocesses to fail closed.');

// Note: PM2 service is started by Claude after this hook completes.
console.log('\n[post-install] Complete!');
