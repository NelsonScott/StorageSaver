#!/usr/bin/env node
/**
 * storagesaver — read-only Mac disk usage explorer with safety knowledge.
 *
 *   storagesaver [scan]            scan the disk → write storagesaver.html
 *                                  to the current directory → open it
 *   storagesaver annotate [file]   fill "what is this?" tooltips in an
 *                                  existing report via your LLM endpoint
 *
 * Common flags:
 *   --root <path>     scan root (default: /System/Volumes/Data on macOS)
 *   --min-mb <n>      hide tree nodes smaller than this (default 20)
 *   --quick           quick mode: scan your home folder only (unless --root
 *                     is given), min-mb 50 — the user-actionable bulk
 *   --out <file>      output path (default ./storagesaver.html)
 *   --json            write the raw data tree as JSON instead of HTML
 *   --no-open         don't open the report in a browser
 *
 * Annotate flags:
 *   --endpoint <url>  OpenAI-compatible chat endpoint (default: local Ollama)
 *   --model <name>    model to use (required, or set via config/env)
 *   --key <key>       API key, if the endpoint needs one
 *   --dry             list what would be asked, don't call the model
 *
 * Safety: everything is read-only. The report's commands are copy-paste
 * suggestions — nothing is ever deleted, moved, or executed for you.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);

function argVal(flag, dflt) {
  const i = argv.indexOf(flag);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
}
function has(flag) { return argv.includes(flag); }

function openInBrowser(file) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [file], { detached: true, stdio: 'ignore' }).unref(); }
  catch (_) { /* non-fatal — the file is on disk either way */ }
}

const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'scan';

if (has('--help') || has('-h') || !['scan', 'annotate'].includes(command)) {
  const header = fs.readFileSync(__filename, 'utf8').split('*/')[0]
    .split('\n').slice(2).map(l => l.replace(/^ \* ?/, '')).join('\n');
  console.log(header.trim());
  process.exit(['scan', 'annotate'].includes(command) || !argv[0] || has('--help') || has('-h') ? 0 : 1);
}

if (command === 'scan') {
  const { scan, writeHtml, defaultRoot } = require('../src/scan');

  const quick = has('--quick');
  let root = argVal('--root', null);
  if (!root && quick) {
    // Quick mode: the home folder is where the user-actionable storage
    // lives — skip /Applications, /private, /opt for a much faster pass.
    root = os.homedir();
    process.stderr.write(`quick mode: scanning ${root} only (pass --root to override)\n`);
  }
  if (!root) root = defaultRoot();

  const minMb = parseInt(argVal('--min-mb', quick ? '50' : '20'), 10);
  const json = has('--json');
  const out = path.resolve(argVal('--out', json ? 'storagesaver.json' : 'storagesaver.html'));

  const data = scan({ root, minMb });

  if (json) {
    fs.writeFileSync(out, JSON.stringify(data, null, 2));
    process.stderr.write(`wrote ${out}\n`);
  } else {
    writeHtml(data, out);
    process.stderr.write(`wrote ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)\n`);
    if (!has('--no-open')) openInBrowser(out);
  }
} else if (command === 'annotate') {
  const { annotate } = require('../src/annotate');
  // First bare argument after the command that isn't a flag's value.
  const VALUE_FLAGS = new Set(['--min-mb', '--endpoint', '--model', '--key', '--out', '--root']);
  let positional = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('-')) { if (VALUE_FLAGS.has(argv[i])) i++; continue; }
    positional = argv[i]; break;
  }

  annotate({
    html: positional ? path.resolve(positional) : undefined,
    minMb: parseInt(argVal('--min-mb', '100'), 10),
    endpoint: argVal('--endpoint', null) || undefined,
    model: argVal('--model', null) || undefined,
    key: argVal('--key', null) || undefined,
    dry: has('--dry'),
  }).catch(e => { console.error(`error: ${e.message}`); process.exit(1); });
}
