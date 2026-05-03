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
};

console.log('[post-install] Running recruit-specific setup...\n');

// 1. Create subdirectories
console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'resumes'), { recursive: true });
console.log('  - logs/');
console.log('  - resumes/');

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

// 3. Ensure bwrap (bubblewrap) is available for AI sandbox isolation
try {
  execSync('which bwrap', { stdio: 'ignore' });
  console.log('\nbwrap detected ✓');
} catch {
  const platform = os.platform();
  if (platform === 'linux') {
    console.warn('\nbwrap not found, attempting install via apt...');
    try {
      execSync('sudo apt install -y bubblewrap', { stdio: 'inherit' });
      console.log('bwrap installed ✓');
    } catch {
      console.error('⚠ apt install failed. Try: sudo apt install bubblewrap');
    }
  } else if (platform === 'darwin') {
    console.warn('\nbwrap not found, attempting install via Homebrew...');
    try {
      execSync('brew install bubblewrap', { stdio: 'inherit' });
      console.log('bwrap installed ✓');
    } catch {
      console.error('⚠ brew install failed. Try: brew install bubblewrap');
    }
  } else {
    console.warn(`\n⚠ bwrap not found (platform: ${platform}).`);
    console.warn('Please install bubblewrap manually, or ask your AI agent to assist.');
    console.warn('Without bwrap, AI sandbox isolation will be limited to tool whitelisting only.');
  }
}

// Note: PM2 service is started by Claude after this hook completes.
console.log('\n[post-install] Complete!');
