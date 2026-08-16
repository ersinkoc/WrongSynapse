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
 *   1. Pre-flight: git clean, master synced with origin, version free on the
 *      registry, tag v<version> exists AND points at HEAD, CHANGELOG has a
 *      [version] section. (The tag must pre-exist and match HEAD — publish
 *      packs the working tree, so a stale tag would ship a tarball the tag
 *      cannot reproduce.)
 *   2. npm publish — the prepublishOnly guard (typecheck + tests + build)
 *      runs automatically before the pack; 2FA completes in this terminal.
 *   3. Verify: retry `npm view <name> version` until the registry echoes the
 *      released version, then push the tag (only after verified publish).
 *
 * Flags:
 *   --check    run pre-flight only (no publish, no tag) — read-only
 *   --otp=N    pass the 6-digit code directly (alternative to the prompt)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// Windows: npm is a .cmd shim. Spawning it directly breaks stdio capture
// (stderr comes back empty on failure, defeating E404 detection), so npm
// goes through the shell on win32. SAFETY INVARIANT: with shell enabled,
// execFileSync performs NO per-argument escaping — Node joins file + args
// into one raw cmd.exe command line. It is safe ONLY because every token
// here is a metacharacter-free constant ('view', 'publish', '--otp=<digits>',
// '<name>@<version>'). Never pass untrusted input through this path.
const NPM = 'npm';
const winShell = process.platform === 'win32' ? { shell: true } : {};

/** Run a command, capture stdout; throw with context on failure. */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const tail = String(err.stderr ?? '').trim().split('\n').slice(-3).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${tail}`);
  }
}

/** Registry lookup that returns '' only for a confirmed E404 (not published). */
function npmView(args) {
  try {
    return execFileSync(NPM, ['view', ...args], { cwd: root, encoding: 'utf8', ...winShell, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const stderr = String(err.stderr ?? '');
    if (stderr.includes('E404')) return ''; // version/package not on registry — expected pre-release
    const tail = stderr.trim().split('\n').slice(-3).join('\n');
    throw new Error(`npm view ${args.join(' ')} failed (not E404 — treat as real):\n${tail}`);
  }
}

const checkOnly = process.argv.includes('--check');
const otpArg = process.argv.find((a) => a.startsWith('--otp='));
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);

const tag = `v${pkg.version}`;
console.log(`\nWrongSynapse release — ${pkg.name}@${pkg.version}${checkOnly ? ' (pre-flight check only)' : ''}\n`);

// --- 1. working tree must be clean ------------------------------------------
const status = run('git', ['status', '--porcelain']);
if (status !== '') fail(`working tree not clean:\n${status}`);
ok('working tree clean');

// --- 2. on master, synced with origin ----------------------------------------
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'master') fail(`on branch '${branch}' — releases are cut from master`);
run('git', ['fetch', 'origin', 'master']);
const local = run('git', ['rev-parse', 'HEAD']);
const remote = run('git', ['rev-parse', 'origin/master']);
if (local !== remote) fail(`master is out of sync with origin (local ${local.slice(0, 7)} ≠ origin ${remote.slice(0, 7)}) — push first`);
ok(`master @ ${local.slice(0, 7)} synced with origin`);

// --- 3. version must not already exist on the registry ------------------------
if (npmView([`${pkg.name}@${pkg.version}`, 'version']) === pkg.version)
  fail(`${pkg.name}@${pkg.version} is ALREADY on the registry — bump package.json first`);
ok(`version ${pkg.version} is free on the registry`);

// --- 4. release tag must exist and point at HEAD --------------------------------
// npm publish packs the working tree (= HEAD), so the published artifact is
// always HEAD's content. If the tag sits elsewhere, publishing would ship a
// tarball that `git checkout <tag>` cannot reproduce — hard-fail instead.
// (To move an unpublished tag to HEAD: git tag -f <tag> && git push -f origin <tag>.)
if (run('git', ['tag', '-l', tag]) === '') fail(`tag ${tag} does not exist — create it (git tag -a ${tag} -m ${tag}) after deciding the release is final`);
const tagged = run('git', ['rev-list', '-n', '1', tag]);
if (tagged !== local) fail(`tag ${tag} points at ${tagged.slice(0, 7)}, not HEAD ${local.slice(0, 7)} — move the tag to HEAD (git tag -f ${tag} && git push -f origin ${tag}) or bump the version`);
ok(`tag ${tag} → HEAD`);

// --- 5. CHANGELOG must have a section for THIS version -------------------------
if (!readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes(`## [${pkg.version}]`))
  fail(`CHANGELOG.md has no '## [${pkg.version}]' section — document the release first`);
ok(`CHANGELOG.md has a [${pkg.version}] section`);

if (checkOnly) { console.log('\nPre-flight OK — publish with: npm run release\n'); process.exit(0); }

// --- 6. publish (interactive; 2FA completes here) ------------------------------
console.log(`\nPublishing ${pkg.name}@${pkg.version} — prepublishOnly guard will run typecheck + tests + build first.`);
console.log('Complete the 2FA prompt (browser or OTP) when it appears.\n');
try {
  execFileSync(NPM, ['publish', ...(otpArg ? [otpArg] : [])], { cwd: root, ...winShell, stdio: 'inherit' });
} catch {
  fail('npm publish failed (see output above). If it was EOTP, re-run: npm run release -- --otp=<6-digit code>');
}

// --- 7. verify on the registry, THEN push the tag -------------------------------
let verified = '';
for (let attempt = 1; attempt <= 5 && verified !== pkg.version; attempt++) {
  try {
    verified = npmView([pkg.name, 'version']); // '' only on confirmed E404
  } catch (err) {
    // Transient registry/network error right after a SUCCESSFUL publish:
    // retry instead of crashing (a crash here would skip the tag push).
    console.warn(`! registry check ${attempt}/5 failed (${String(err.message).split('\n')[0]}) — retrying`);
    verified = '';
  }
  if (verified !== pkg.version) await new Promise((r) => setTimeout(r, 3000));
}
if (verified !== pkg.version) fail(`registry still shows '${verified || 'E404'}' after publish — check https://www.npmjs.com/package/${pkg.name} manually; tag ${tag} was NOT pushed`);

run('git', ['push', 'origin', tag]);
ok(`tag ${tag} pushed (publish verified first)`);
console.log(`\n🎉 Released ${pkg.name}@${pkg.version} → https://www.npmjs.com/package/${pkg.name}\n`);
