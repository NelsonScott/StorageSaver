/**
 * scan.js — walks the disk and produces the StorageSaver data tree, then
 * injects it into template.html (between STORAGESAVER_DATA_START/END
 * markers) to make a self-contained interactive disk usage explorer.
 *
 * Design contract: window.STORAGESAVER_DATA = { generatedAt, disk, root }
 *   Node = { n, p, s, t: dir|file|unreadable, b: safe|review|never|null,
 *            cmd, note, c }
 *
 * Safety: read-only scan. Classification (badges/cmds) lives in
 * classify.js — cmds are copy-only suggestions, never executed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { classify } = require('./classify');
const notes = require('./notes');

const TEMPLATE = path.join(__dirname, 'template.html');
const DATA_START = '<!-- STORAGESAVER_DATA_START -->';
const DATA_END = '<!-- STORAGESAVER_DATA_END -->';

// On macOS the writable data volume is mounted at /System/Volumes/Data and
// firmlinked over / — scanning it directly sees everything the user can
// reach without crossing into the sealed system volume.
function defaultRoot() {
  if (process.platform === 'darwin') return '/System/Volumes/Data';
  process.stderr.write(
    'warning: StorageSaver is macOS-focused — scanning / on this platform; ' +
    'safety rules and notes are written for macOS paths.\n');
  return '/';
}

// ── Walker ───────────────────────────────────────────────────────────────────

function scan(opts = {}) {
  const ROOT = opts.root || defaultRoot();
  const MIN_MB = Number.isFinite(opts.minMb) ? opts.minMb : 20;
  const MIN_NODE_BYTES = MIN_MB * 1024 * 1024;  // children below this aggregate into "(other)"
  const MAX_CHILDREN = opts.maxChildren || 60;   // per directory, biggest first
  const MAX_DEPTH = opts.maxDepth || 12;         // detail depth; deeper sizes roll up

  // Classify on the logical path so rules like "~/Library/…" read naturally
  // even when the scan root is the /System/Volumes/Data firmlink.
  const rel = p => p.replace(/^\/System\/Volumes\/Data/, '') || '/';

  let fileCount = 0, dirCount = 0, unreadableCount = 0;
  let lastProgress = Date.now();

  function progress(msg) {
    const now = Date.now();
    if (now - lastProgress > 5000) {
      process.stderr.write(`  … ${msg} (${dirCount} dirs, ${fileCount} files so far)\n`);
      lastProgress = now;
    }
  }

  function walk(p, name, depth, rootDev) {
    let st;
    try { st = fs.lstatSync(p); }
    catch (_) { unreadableCount++; return { n: name, p, s: 0, t: 'unreadable', b: null, cmd: null, note: 'permission blocked — size unknown', c: null }; }

    if (st.isSymbolicLink()) return null;                       // don't follow links
    if (!st.isDirectory()) {
      if (!st.isFile()) return null;                            // sockets, pipes, devices
      fileCount++;
      const { b, note, cmd } = classify(rel(p), name, false, p);
      // Allocated blocks, not logical size — sparse files (Docker.raw) and APFS
      // clones otherwise overcount by tens of GB vs what the disk actually holds.
      const bytes = st.blocks != null ? st.blocks * 512 : st.size;
      return { n: name, p, s: bytes, t: 'file', b, cmd: cmd || null, note };
    }
    if (st.dev !== rootDev) return null;                        // stay on one volume

    dirCount++;
    progress(p);

    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); }
    catch (_) {
      unreadableCount++;
      return { n: name, p, s: 0, t: 'unreadable', b: null, cmd: null, note: 'permission blocked — size unknown', c: null };
    }

    let total = 0;
    const kids = [];
    for (const e of entries) {
      const child = walk(path.join(p, e.name), e.name, depth + 1, rootDev);
      if (!child) continue;
      total += child.s;
      kids.push(child);
    }

    const { b, note, cmd } = classify(rel(p), name, true, p);
    const node = { n: name, p, s: total, t: 'dir', b, cmd: cmd || null, note, c: null };

    // Prune: keep big children (and all unreadables, so gaps stay visible),
    // aggregate the rest. Beyond MAX_DEPTH keep sizes but drop detail.
    if (depth < MAX_DEPTH && kids.length) {
      kids.sort((a, x) => x.s - a.s);
      const keep = [], dropped = { count: 0, bytes: 0 };
      for (const k of kids) {
        if ((k.s >= MIN_NODE_BYTES || k.t === 'unreadable') && keep.length < MAX_CHILDREN) keep.push(k);
        else { dropped.count++; dropped.bytes += k.s; }
      }
      if (dropped.count) keep.push({ n: `(other, ${dropped.count} items)`, p, s: dropped.bytes, t: 'dir', b: null, cmd: null, note: null, c: null });
      if (keep.length) node.c = keep;
    }
    return node;
  }

  process.stderr.write(`scanning ${ROOT} (min node ${MIN_MB} MB)…\n`);
  const t0 = Date.now();
  const rootDev = fs.lstatSync(ROOT).dev;
  const root = walk(ROOT, path.basename(ROOT) || ROOT, 0, rootDev);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  process.stderr.write(`scanned ${dirCount} dirs, ${fileCount} files, ${unreadableCount} unreadable in ${secs}s\n`);

  // Fill "what is this?" tooltip notes from the builtin dict + seed + your
  // local cache (populate/refresh the cache with `storagesaver annotate`).
  notes.applyNotes(root, notes.loadCache());

  return { generatedAt: new Date().toISOString(), disk: diskStats(ROOT), root };
}

// ── Disk stats ───────────────────────────────────────────────────────────────

function diskStats(root) {
  const r = spawnSync('df', ['-k', root], { encoding: 'utf8' });
  const cols = (r.stdout || '').trim().split('\n').pop().split(/\s+/);
  const totalBytes = parseInt(cols[1], 10) * 1024;
  const usedBytes  = parseInt(cols[2], 10) * 1024;
  const freeBytes  = parseInt(cols[3], 10) * 1024;
  // Match df's Capacity column: used / (used + available). Raw total includes
  // purgeable/snapshot space and understates how full the disk feels.
  return { totalBytes, usedBytes, freeBytes, percentUsed: +(usedBytes / (usedBytes + freeBytes) * 100).toFixed(1) };
}

// ── HTML injection ───────────────────────────────────────────────────────────

function dataBlock(data) {
  return DATA_START + '\n' +
    '<script id="storagesaver-data">\n' +
    'window.STORAGESAVER_DATA = ' + JSON.stringify(data) + ';\n' +
    '<\/script>\n' +
    DATA_END;
}

function writeHtml(data, outPath, templatePath) {
  const tplFile = templatePath || TEMPLATE;
  if (!fs.existsSync(tplFile)) throw new Error(`template not found: ${tplFile}`);
  const tpl = fs.readFileSync(tplFile, 'utf8');
  const out = tpl.replace(new RegExp(`${DATA_START}[\\s\\S]*?${DATA_END}`), dataBlock(data));
  if (out === tpl) throw new Error('injection markers not found in template');
  fs.writeFileSync(outPath, out);
  return outPath;
}

module.exports = { scan, writeHtml, diskStats, defaultRoot, DATA_START, DATA_END, TEMPLATE };
