'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'tmp-sweep.js');
const M = require('../bin/tmp-sweep.js');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-sweep-test-'));
}
function touch(p, { size = 10, ageMs = 0 } = {}) {
  fs.writeFileSync(p, 'x'.repeat(size));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
}

test('parseDuration accepts m/h/d/w and rejects garbage', () => {
  assert.equal(M.parseDuration('30m'), 1800000);
  assert.equal(M.parseDuration('12h'), 43200000);
  assert.equal(M.parseDuration('7d'), 604800000);
  assert.equal(M.parseDuration('2w'), 1209600000);
  assert.equal(M.parseDuration('1.5d'), 129600000);
  assert.throws(() => M.parseDuration('7'), /bad duration/);
  assert.throws(() => M.parseDuration('seven days'), /bad duration/);
  assert.throws(() => M.parseDuration(''), /bad duration/);
});

test('parseSize accepts k/M/G/T and plain numbers', () => {
  assert.equal(M.parseSize('512'), 512);
  assert.equal(M.parseSize('1k'), 1024);
  assert.equal(M.parseSize('5M'), 5 * 1024 ** 2);
  assert.equal(M.parseSize('2G'), 2 * 1024 ** 3);
  assert.equal(M.parseSize('1.5k'), 1536);
  assert.throws(() => M.parseSize('big'), /bad size/);
});

test('matchesGlob handles *, ? and **', () => {
  assert.ok(M.matchesGlob('/a/b/file.log', '*.log'));
  assert.ok(!M.matchesGlob('/a/b/file.txt', '*.log'));
  assert.ok(M.matchesGlob('/a/b/keep.me', 'keep.*'));
  assert.ok(M.matchesGlob('/a/b/ab', 'a?'));
  assert.ok(!M.matchesGlob('/a/b/abc', 'a?'));
  assert.ok(M.matchesGlob('/a/deep/nested/x.log', '**/*.log'));
  assert.ok(M.matchesGlob('plain.txt', '*.txt'));
});

test('humanBytes and humanAge format sensibly', () => {
  assert.equal(M.humanBytes(512), '512B');
  assert.equal(M.humanBytes(1536), '1.5K');
  assert.equal(M.humanBytes(5 * 1024 ** 2), '5.0M');
  assert.equal(M.humanAge(30 * 60000), '30m');
  assert.equal(M.humanAge(36 * 3600000), '1d');
});

test('plan filters by age, include, exclude and min-size, oldest first', () => {
  const now = Date.now();
  const files = [
    { path: '/t/new.log', size: 100, mtimeMs: now - 3600000 },
    { path: '/t/old.log', size: 100, mtimeMs: now - 10 * 86400000 },
    { path: '/t/old.txt', size: 100, mtimeMs: now - 10 * 86400000 },
    { path: '/t/older.log', size: 100, mtimeMs: now - 20 * 86400000 },
    { path: '/t/tiny.log', size: 1, mtimeMs: now - 20 * 86400000 },
  ];
  const { candidates } = M.plan(files, now, {
    olderThanMs: 7 * 86400000,
    include: ['*.log'],
    exclude: ['tiny.*'],
    minSize: 10,
  });
  assert.deepEqual(candidates.map(f => f.path), ['/t/older.log', '/t/old.log']);
});

test('plan --free picks oldest files until the byte target is met', () => {
  const now = Date.now();
  const files = [
    { path: '/t/a', size: 100, mtimeMs: now - 30 * 86400000 },
    { path: '/t/b', size: 100, mtimeMs: now - 20 * 86400000 },
    { path: '/t/c', size: 100, mtimeMs: now - 10 * 86400000 },
  ];
  const { candidates } = M.plan(files, now, { olderThanMs: 86400000, freeBytes: 150 });
  assert.deepEqual(candidates.map(f => f.path), ['/t/a', '/t/b']); // 200 >= 150, c untouched
});

test('plan with empty input returns no candidates', () => {
  const { candidates } = M.plan([], Date.now(), { olderThanMs: 1000 });
  assert.deepEqual(candidates, []);
});

test('isDangerous blocks / and $HOME without --yes', () => {
  assert.ok(M.isDangerous('/', false));
  assert.ok(M.isDangerous(os.homedir(), false));
  assert.ok(!M.isDangerous('/', true));
  const safe = mkTmp();
  assert.ok(!M.isDangerous(safe, false));
});

test('CLI dry-run does not delete and exits 0', () => {
  const dir = mkTmp();
  const old = path.join(dir, 'old.tmp');
  const fresh = path.join(dir, 'fresh.tmp');
  touch(old, { ageMs: 10 * 86400000 });
  touch(fresh, { ageMs: 3600000 });
  const r = spawnSync('node', [BIN, '--older-than', '7d', '--no-color', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would delete/);
  assert.match(r.stdout, /old\.tmp/);
  assert.ok(!r.stdout.includes('fresh.tmp'), 'fresh file must not be listed');
  assert.ok(fs.existsSync(old), 'dry-run must not delete');
});

test('CLI --apply deletes only the old files', () => {
  const dir = mkTmp();
  const old = path.join(dir, 'old.tmp');
  const fresh = path.join(dir, 'fresh.tmp');
  touch(old, { ageMs: 10 * 86400000 });
  touch(fresh, { ageMs: 3600000 });
  const r = spawnSync('node', [BIN, '--older-than', '7d', '--apply', '--no-color', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(old), 'old file deleted');
  assert.ok(fs.existsSync(fresh), 'fresh file kept');
});

test('CLI refuses a dangerous dir without --yes (exit 2)', () => {
  const r = spawnSync('node', [BIN, '--older-than', '7d', os.homedir()], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dangerous/);
});

test('CLI reads candidate paths from stdin', () => {
  const dir = mkTmp();
  const old = path.join(dir, 'old.tmp');
  touch(old, { ageMs: 10 * 86400000 });
  const r = spawnSync('node', [BIN, '--older-than', '7d', '--json'],
    { input: old + '\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, 'dry-run');
  assert.deepEqual(out.matched.map(m => m.path), [old]);
});

test('CLI --json output is parseable and lists sizes', () => {
  const dir = mkTmp();
  const old = path.join(dir, 'old.tmp');
  touch(old, { size: 42, ageMs: 10 * 86400000 });
  const r = spawnSync('node', [BIN, '--older-than', '7d', '--json', '--no-color', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.matched.length, 1);
  assert.equal(out.matched[0].size, 42);
  assert.ok(out.bytesFreed >= 42);
});

test('CLI --version and bad usage exit codes', () => {
  const v = spawnSync('node', [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(v.status, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const noArgs = spawnSync('node', [BIN], { encoding: 'utf8' });
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /--older-than is required/);
  const badDur = spawnSync('node', [BIN, '--older-than', 'soon'], { encoding: 'utf8' });
  assert.equal(badDur.status, 2);
});

test('NO_COLOR disables ANSI codes', () => {
  const dir = mkTmp();
  touch(path.join(dir, 'old.tmp'), { ageMs: 10 * 86400000 });
  const r = spawnSync('node', [BIN, '--older-than', '7d', dir],
    { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('\x1b['), 'no ANSI codes when NO_COLOR=1');
});

test('symlinked files are skipped, never followed', () => {
  const dir = mkTmp();
  const real = path.join(dir, 'real.tmp');
  const link = path.join(dir, 'link.tmp');
  touch(real, { size: 50, ageMs: 10 * 86400000 });
  fs.symlinkSync(real, link);
  const r = spawnSync('node', [BIN, '--older-than', '7d', '--json', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const paths = out.matched.map(m => m.path);
  assert.ok(paths.includes(real));
  assert.ok(!paths.includes(link));
  assert.ok(out.skipped.some(s => s.reason === 'symlink skipped'));
});
