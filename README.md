# tmp-sweep

> Sweep files older than an age threshold, with a dry-run-first safety model. Daily Tools #11.

## Why

`/tmp`, CI workspaces and app cache folders silently fill up, and the classic
answer (`tmpwatch`) is Linux-only, has to be installed, and gives you no
machine-readable plan of what it will remove. On the Node side,
[jemishavasoya/dev-cleaner](https://github.com/jemishavasoya/dev-cleaner)
targets specific dev caches (npm, gradle) rather than a general age rule with
dry-run planning. tmp-sweep is a single dependency-free Node file that works
anywhere Node runs, shows you exactly what would be deleted (human table or
JSON for CI), and refuses dangerous locations unless you pass `--yes`. Nothing
is ever deleted without `--apply`.

## Install

```bash
git clone https://github.com/Kayzenn123/tmp-sweep.git
cd tmp-sweep
# no dependencies
```

Requires: Node >= 18

Use directly: `node bin/tmp-sweep.js --help`, or add `bin/` to your PATH.

## Usage

```bash
tmp-sweep --older-than 7d [options] [dir ...]
cat paths.txt | tmp-sweep --older-than 7d     # paths from stdin
tmp-sweep --older-than 7d                     # defaults to the OS temp dir
```

| Flag | What it does | Default |
| --- | --- | --- |
| `--older-than <dur>` | required; match files older than this: `30m`, `12h`, `7d`, `2w` | — |
| `--include <glob>` | only consider matching paths (repeatable) | all |
| `--exclude <glob>` | never touch matching paths (repeatable) | none |
| `--min-size <size>` | only files at least this big: `1k`, `5M` | `0` |
| `--free <size>` | delete oldest-first until at least this many bytes are freed | all matches |
| `--apply` | actually delete (default is dry-run) | dry-run |
| `--yes` | allow dangerous locations (`/`, `$HOME`, …) | refused |
| `--json` | machine-readable output instead of the table | table |
| `--no-color` | disable colors (also `NO_COLOR=1`) | auto |

Exit codes: `0` ok · `1` runtime error · `2` bad usage.

## Example output

Command:

```bash
node bin/tmp-sweep.js --older-than 7d --no-color /tmp/tmp-sweep-demo/stale-downloads
```

Output (real, copied from an actual run):

```text
would delete 15d   1.9M  /tmp/tmp-sweep-demo/stale-downloads/report-final.pdf
would delete 12d  23.8M  /tmp/tmp-sweep-demo/stale-downloads/installer-v2.1.exe
would delete  9d   7.6M  /tmp/tmp-sweep-demo/stale-downloads/photo-batch.zip
---
3 file(s) would delete, 33.4M total
dry-run: nothing deleted. Re-run with --apply to delete.
```

Free exactly 5M from the oldest files first (budget mode):

```bash
node bin/tmp-sweep.js --older-than 7d --free 5M --apply --no-color /tmp/tmp-sweep-demo/big-cache
```

```text
DEL 30d  2.9M  /tmp/tmp-sweep-demo/big-cache/seg-0.dat
DEL 21d  2.9M  /tmp/tmp-sweep-demo/big-cache/seg-1.dat
---
2 file(s) deleted, 5.7M total
```

Machine-readable output for CI (`--json`):

```bash
find /tmp/tmp-sweep-demo/stale-downloads -type f | node bin/tmp-sweep.js --older-than 10d --json
```

```text
{
  "mode": "dry-run",
  "olderThan": "10d",
  "targets": [
    "/tmp/tmp-sweep-demo/stale-downloads/keep-me.txt",
    "/tmp/tmp-sweep-demo/stale-downloads/report-final.pdf",
    "/tmp/tmp-sweep-demo/stale-downloads/notes.txt",
    "/tmp/tmp-sweep-demo/stale-downloads/photo-batch.zip",
    "/tmp/tmp-sweep-demo/stale-downloads/installer-v2.1.exe"
  ],
  "matched": [
    {
      "path": "/tmp/tmp-sweep-demo/stale-downloads/report-final.pdf",
      "size": 2000000,
      "ageMs": 1296010842.7231445
    },
    {
      "path": "/tmp/tmp-sweep-demo/stale-downloads/installer-v2.1.exe",
      "size": 25000000,
      "ageMs": 1036810842.7231445
    }
  ],
  "bytesFreed": 27000000,
  "skipped": []
}
```

## How it works

1. Resolve targets: explicit dirs, paths from stdin when piped, or the OS temp
   dir by default. Dangerous locations (`/`, `$HOME`, `/etc`, …) are refused
   unless `--yes` is passed.
2. Walk each target recursively without following symlinks (symlinks are
   reported under `skipped`); collect size and mtime of regular files only.
3. Plan: keep files older than `--older-than` matching `--include`/`--min-size`
   and not matching `--exclude`, sorted oldest-first; `--free` truncates the
   list once the byte target is reached.
4. Dry-run prints a table; `--apply` unlinks the planned files one by one.
   `--json` prints the plan/machine result for scripts.

All logic lives in `bin/tmp-sweep.js`; pure functions (`parseDuration`,
`matchesGlob`, `plan`, `isDangerous`) are exported for tests.

## Limitations

- Matches on mtime only; no atime/ctime option yet.
- Directories themselves are never deleted; empty folders are left behind.
- No Windows `C:\`-specific dangerous-dir coverage beyond the drive root and
  `%USERPROFILE%`; on Windows, treat paths accordingly.
- Glob matching is a small built-in subset (`*`, `**`, `?`), not full minimatch.
- Deletion is permanent (no trash); double-check dry-run output first.

## Development

```bash
npm test
```

## License

MIT

---
Ringkasan (Bahasa Indonesia): tmp-sweep memindai folder dan menghapus file
yang lebih tua dari umur yang ditentukan (mis. `--older-than 7d`), dengan
dry-run sebagai default sehingga aman: kamu lihat dulu daftarnya, baru jalankan
`--apply`. Mendukung filter glob include/exclude, batas ukuran minimum, mode
budget `--free` (hapus yang tertua sampai target byte tercapai), dan output
JSON untuk CI. Lokasi berbahaya seperti `/` atau `$HOME` ditolak kecuali pakai
`--yes`; symlink tidak pernah diikuti. Batasan utama: hanya pakai mtime,
folder kosong tidak ikut dihapus, dan penghapusan bersifat permanen.
