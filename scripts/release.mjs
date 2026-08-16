#!/usr/bin/env node
/**
 * WrongSynapse release script — run `npm run release` from your own terminal.
 *
 * Why this exists: the npm account enforces 2FA for writes. In a
 * non-interactive shell `npm publish` fails with EOTP and the browser-auth
 * URL is redacted, so publishing CANNOT be automated here. Run this script
 * interactively instead: npm's browser/OTP prompt works in a real terminal.
 *
 * What it does:
 *   1. Pre-flight: git clean + master synced + working tree == origin,
 *      package.json version not already on the registry, tag matches HEAD.
 *   2. npm publish — the prepublishOnly guard (typecheck + tests + build)
 *      runs automatically before the pack; 2FA prompt completes here.
 *   3. Verify: `npm view <name> version` must echo the released version.
 *
 * Flags:
 *   --check    run pre-flight only (no publish) — CI-safe, network read-only
 *   --otp=N    pass the 6-digit code directly (alternative to the prompt)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], ...opts }).trim();

const checkOnly = process.argv.includes('--check');
const otpArg = process.argv.find((a) => a.startsWith('--otp='));
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);

console.log(`\nWrongSynapse release — ${pkg.name}@${pkg.version}${checkOnly ? ' (pre-flight check only)' : ''}\n`);

// --- 1. working tree must be clean -----------------------------------------
const status = run('git', ['status', '--porcelain']);
if (status !== '') fail(`working tree not clean:\n${status}`);
ok('working tree clean');

// --- 2. on master, synced with origin ---------------------------------------
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'master') fail(`on branch '${branch}' — releases are cut from master`);
run('git', ['fetch', 'origin', 'master']);
const [local, remote] = [run('git', ['rev-parse', 'HEAD']), run('git', ['rev-parse', 'origin/master'])];
if (local !== remote) fail(`master is out of sync with origin (local ${local.slice(0, 7)} ≠ origin ${remote.slice(0, 7)}) — push first`);
ok(`master @ ${local.slice(0, 7)} synced with origin`);

// --- 3. version must not already exist on the registry ----------------------
const published = run('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], { stdio: ['inherit', 'pipe', 'pipe'] }).catch?.(() => '');
let onRegistry = '';
try {
  onRegistry = execFileSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], { cwd: root, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
} catch { /* E404 = not published yet = good */ }
if (onRegistry === pkg.version) fail(`${pkg.name}@${pkg.version} is ALREADY on the registry — bump package.json first`);
ok(`version ${pkg.version} is free on the registry`);

// --- 4. tag should exist for this version and point at HEAD -----------------
const tag = `v${pkg.version}`;
if (run('git', ['tag', '-l', tag]) === '') {
  console.warn(`! tag ${tag} does not exist yet — creating it at HEAD`);
  if (!checkOnly) { run('git', ['tag', '-a', tag, '-m', tag]); run('git', ['push', 'origin', tag]); }
} else {
  const tagged = run('git', ['rev-list', '-n', '1', tag]);
  if (tagged !== local) fail(`tag ${tag} points at ${tagged.slice(0, 7)}, not HEAD ${local.slice(0, 7)}`);
  ok(`tag ${tag} → HEAD`);
}

// --- 5. CHANGELOG should mention this version --------------------------------
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${pkg.version}]`) && !changelog.includes(`## [Unreleased]`))
  fail(`CHANGELOG.md has no [${pkg.version}] or [Unreleased] section`);
ok('CHANGELOG.md covers this release');

if (checkOnly) { console.log('\nPre-flight OK — publish with: npm run release\n'); process.exit(0); }

// --- 6. publish (interactive; 2FA completes here) ----------------------------
console.log(`\nPublishing ${pkg.name}@${pkg.version} — prepublishOnly guard will run typecheck + tests + build first.`);
console.log('Complete the 2FA prompt (browser or OTP) when it appears.\n');
const publishArgs = ['publish', ...(otpArg ? [otpArg] : [])];
try {
  execFileSync('npm', publishArgs, { cwd: root, stdio: 'inherit' });
} catch {
  fail('npm publish failed (see output above). If it was EOTP, re-run: npm run release -- --otp=<6-digit code>');
}

// --- 7. verify on the registry ------------------------------------------------
let verified = '';
for (let attempt = 1; attempt <= 5 && verified !== pkg.version; attempt++) {
  try {
    verified = execFileSync('npm', ['view', pkg.name, 'version'], { cwd: root, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
  } catch { /* registry propagation can lag a few seconds */ }
  if (verified !== pkg.version) await new Promise((r) => setTimeout(r, 3000));
}
if (verified !== pkg.version) fail(`registry still shows '${verified || 'E404'}' after publish — check https://www.npmjs.com/package/${pkg.name} manually`);
ok(`registry verified: ${pkg.name}@verified} → published ${pkg.version}`);
console.log(`\n🎉 Released ${pkg.name}@${pkg.version} → https://www.npmjs.com/package/${pkg.name}\n`);
