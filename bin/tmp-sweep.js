#!/usr/bin/env node
/**
 * tmp-sweep — find files older than an age threshold and clean them up safely.
 *
 * Single file, zero dependencies, Node >= 18.
 * Dry-run is the default; nothing is deleted unless --apply is given.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const process = require('process');

const VERSION = '1.0.0';

/* ---------------- pure logic ---------------- */

/** Parse a duration like "30m", "12h", "7d", "2w" into milliseconds. */
function parseDuration(s) {
  if (typeof s !== 'string' || !s.length) throw new Error(`bad duration: ${JSON.stringify(s)}`);
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}": use a number followed by m (minutes), h (hours), d (days) or w (weeks), e.g. 7d`);
  const n = Number(m[1]);
  const unit = { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2].toLowerCase()];
  return Math.round(n * unit);
}

/** Parse a size like "512", "1k", "5M", "2G" into bytes. */
function parseSize(s) {
  if (typeof s !== 'string' || !s.length) throw new Error(`bad size: ${JSON.stringify(s)}`);
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/i.exec(s.trim());
  if (!m) throw new Error(`bad size "${s}": use a number optionally followed by k, M, G or T, e.g. 500M`);
  const n = Number(m[1]);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[(m[2] || '').toLowerCase()];
  return Math.round(n * mult);
}

/** Minimal glob matcher supporting *, ** and ?. Matches the full path string
 *  and, as a convenience, the basename. */
function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') { i++; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(re + '$');
}

function matchesGlob(p, glob) {
  const re = globToRegExp(glob);
  return re.test(p) || re.test(path.basename(p));
}

/** Human-readable byte count, e.g. 1536 -> "1.5K". */
function humanBytes(n) {
  if (n < 1024) return `${n}B`;
  const units = ['K', 'M', 'G', 'T'];
  let v = n, u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${units[u]}`;
}

function humanAge(ms) {
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return `${h}h`;
  return `${Math.floor(ms / 60000)}m`;
}

/**
 * Directories that are never swept without an explicit --yes, because a typo
 * there is catastrophic. Returned as absolute paths.
 */
function dangerousDirs() {
  const home = os.homedir();
  const roots = process.platform === 'win32'
    ? ['C:\\', 'C:\\Windows', home]
    : ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/sbin', '/sys', '/usr', '/var', home, '/Users'];
  return roots.map(r => path.resolve(r));
}

function isDangerous(dir, force) {
  if (force) return false;
  const abs = path.resolve(dir);
  return dangerousDirs().some(d => abs === d || abs.startsWith(d + path.sep));
}

/**
 * Build the deletion plan from scanned files.
 * files: [{path, size, mtimeMs}], now: epoch ms, opts: {olderThanMs, include, exclude, minSize, freeBytes}
 * Returns {candidates} sorted oldest-first; if freeBytes is set, only the
 * oldest files needed to free at least freeBytes are kept.
 */
function plan(files, now, opts) {
  const inc = (opts.include || []).map(globToRegExp);
  const exc = (opts.exclude || []).map(globToRegExp);
  const hit = (p, list) => list.some(re => re.test(p) || re.test(path.basename(p)));
  let cands = files.filter(f =>
    (now - f.mtimeMs) >= opts.olderThanMs &&
    f.size >= (opts.minSize || 0) &&
    (inc.length === 0 || hit(f.path, inc)) &&
    !hit(f.path, exc)
  );
  cands.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  if (opts.freeBytes && opts.freeBytes > 0) {
    const picked = [];
    let freed = 0;
    for (const f of cands) {
      picked.push(f);
      freed += f.size;
      if (freed >= opts.freeBytes) break;
    }
    cands = picked;
  }
  return { candidates: cands };
}

/* ---------------- I/O ---------------- */

/** Recursively list regular files under dir. Never follows symlinks;
 *  symlinks themselves are skipped and reported. */
function collectFiles(root, skipped) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      skipped.push({ path: dir, reason: `cannot read: ${e.message}` });
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { skipped.push({ path: p, reason: 'symlink skipped' }); continue; }
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) { skipped.push({ path: p, reason: 'not a regular file' }); continue; }
      try {
        const st = fs.statSync(p);
        out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch (err) {
        skipped.push({ path: p, reason: `cannot stat: ${err.message}` });
      }
    }
  }
  return out;
}

/* ---------------- CLI ---------------- */

function printHelp() {
  console.log(`tmp-sweep ${VERSION} — safely sweep files older than an age threshold.

Usage:
  tmp-sweep [options] [dir ...]
  cat paths.txt | tmp-sweep --older-than 7d        (paths from stdin)

Options:
  --older-than <dur>   delete files older than this (required): 30m, 12h, 7d, 2w
  --include <glob>     only consider paths matching glob (repeatable)
  --exclude <glob>     never touch paths matching glob (repeatable)
  --min-size <size>    only files at least this big, e.g. 1k, 5M (default: 0)
  --free <size>        delete oldest-first until at least this many bytes are
                       freed, e.g. 500M
  --apply              actually delete (default is dry-run: only report)
  --yes                allow sweeping dangerous locations (/tmp outside, /,
                       $HOME, ...); tmp-sweep refuses them otherwise
  --json               machine-readable output instead of the table
  --no-color           disable colored output (also via NO_COLOR=1)
  --version            print version
  --help               this help

Exit codes: 0 ok · 1 runtime error · 2 bad usage. Nothing is deleted without
--apply. Symlinks are never followed; directories themselves are never deleted.
Dry-run shows a table with path, age and size plus a summary line.`);
}

function err(msg) {
  process.stderr.write(`tmp-sweep: error: ${msg}\n`);
}

function parseArgs(argv) {
  const opts = { include: [], exclude: [], apply: false, yes: false, json: false, color: true };
  const dirs = [];
  const args = argv.slice();
  while (args.length) {
    const a = args.shift();
    const need = (flag) => {
      const v = args.shift();
      if (v === undefined) { err(`${flag} needs a value`); process.exit(2); }
      return v;
    };
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--version' || a === '-V') { console.log(VERSION); process.exit(0); }
    else if (a === '--older-than') opts.olderThan = need(a);
    else if (a === '--include') opts.include.push(need(a));
    else if (a === '--exclude') opts.exclude.push(need(a));
    else if (a === '--min-size') opts.minSize = need(a);
    else if (a === '--free') opts.free = need(a);
    else if (a === '--apply') opts.apply = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-color') opts.color = false;
    else if (a.startsWith('-')) { err(`unknown option: ${a} (see --help)`); process.exit(2); }
    else dirs.push(a);
  }
  if (!opts.olderThan) { err('--older-than is required (e.g. --older-than 7d)'); process.exit(2); }
  try {
    opts.olderThanMs = parseDuration(opts.olderThan);
    if (opts.minSize !== undefined) opts.minSizeBytes = parseSize(opts.minSize);
    if (opts.free !== undefined) opts.freeBytes = parseSize(opts.free);
  } catch (e) {
    err(e.message); process.exit(2);
  }
  return { opts, dirs };
}

function readStdinPaths() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => {
      const lines = data.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      resolve(lines.length ? lines : null);
    });
  });
}

function colorize(opts, s, code) {
  if (!opts.color || process.env.NO_COLOR || !process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

function renderTable(cands, now, opts, applying) {
  const red = (s) => colorize(opts, s, 31);
  const dim = (s) => colorize(opts, s, 2);
  const rows = cands.map(f => [humanAge(now - f.mtimeMs), humanBytes(f.size), f.path]);
  const wAge = Math.max(3, ...rows.map(r => r[0].length));
  const wSize = Math.max(4, ...rows.map(r => r[1].length));
  for (const [age, size, p] of rows) {
    const mark = applying ? red('DEL ') : dim('would delete ');
    console.log(`${mark}${age.padStart(wAge)}  ${size.padStart(wSize)}  ${p}`);
  }
  const total = cands.reduce((s, f) => s + f.size, 0);
  const verb = applying ? 'deleted' : 'would delete';
  console.log(`${dim('---')}`);
  console.log(`${cands.length} file(s) ${verb}, ${humanBytes(total)} total`);
}

async function main() {
  const { opts, dirs } = parseArgs(process.argv.slice(2));

  let targets = dirs;
  if (targets.length === 0) {
    const fromStdin = await readStdinPaths();
    if (fromStdin) targets = fromStdin;
    else targets = [os.tmpdir()];
  }

  const bad = targets.filter(t => isDangerous(t, opts.yes));
  if (bad.length) {
    err(`refusing to sweep dangerous location(s) without --yes: ${bad.join(', ')}`);
    process.exit(2);
  }

  const skipped = [];
  const files = [];
  for (const t of targets) {
    let st;
    try { st = fs.lstatSync(t); }
    catch { err(`path not found: ${t}`); process.exit(1); }
    if (st.isSymbolicLink()) { skipped.push({ path: t, reason: 'symlink skipped' }); continue; }
    if (st.isDirectory()) { files.push(...collectFiles(t, skipped)); continue; }
    if (st.isFile()) { files.push({ path: path.resolve(t), size: st.size, mtimeMs: st.mtimeMs }); continue; }
    skipped.push({ path: t, reason: 'not a file or directory' });
  }

  const now = Date.now();
  const { candidates } = plan(files, now, {
    olderThanMs: opts.olderThanMs,
    include: opts.include,
    exclude: opts.exclude,
    minSize: opts.minSizeBytes || 0,
    freeBytes: opts.freeBytes,
  });

  const deleted = [];
  if (opts.apply) {
    for (const f of candidates) {
      try { fs.unlinkSync(f.path); deleted.push(f); }
      catch (e) { skipped.push({ path: f.path, reason: `delete failed: ${e.message}` }); }
    }
  }

  if (opts.json) {
    const shown = opts.apply ? deleted : candidates;
    console.log(JSON.stringify({
      mode: opts.apply ? 'apply' : 'dry-run',
      olderThan: opts.olderThan,
      targets,
      matched: shown.map(f => ({
        path: f.path, size: f.size,
        ageMs: now - f.mtimeMs,
      })),
      bytesFreed: shown.reduce((s, f) => s + f.size, 0),
      skipped,
    }, null, 2));
  } else {
    renderTable(opts.apply ? deleted : candidates, now, opts, opts.apply);
    if (skipped.length) {
      const dim = (s) => colorize(opts, s, 2);
      console.log(dim(`skipped ${skipped.length} item(s):`));
      for (const s of skipped.slice(0, 10)) console.log(dim(`  ${s.path} (${s.reason})`));
      if (skipped.length > 10) console.log(dim(`  ... and ${skipped.length - 10} more`));
    }
    if (!opts.apply && candidates.length) {
      console.log(colorize(opts, 'dry-run: nothing deleted. Re-run with --apply to delete.', 33));
    }
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => { err(e.message); process.exit(1); });
}

module.exports = { parseDuration, parseSize, globToRegExp, matchesGlob, humanBytes, humanAge, isDangerous, plan };
