/**
 * annotate.js — fills StorageSaver tooltips with plain-English "what is
 * this?" notes using any OpenAI-compatible chat endpoint you point it at
 * (Ollama, LM Studio, OpenAI, Anthropic's compatibility endpoint, …).
 *
 * Flow: read storagesaver.html → collect unexplained nodes ≥ min bytes →
 * dedupe by basename → skip builtins/cached → batch-ask the model → update
 * ~/.config/storagesaver/notes-cache.json → re-apply all notes into the HTML.
 *
 * Unknown items come back as UNSURE and land in the cache's `unsure` list
 * for a human (or a smarter model) to fill — never guessed.
 *
 * Endpoint/model/key resolution (first hit wins):
 *   1. flags:  --endpoint --model --key
 *   2. env:    STORAGESAVER_ENDPOINT / STORAGESAVER_MODEL / STORAGESAVER_KEY
 *   3. config: ~/.config/storagesaver/config.json { endpoint, model, key }
 *   4. endpoint falls back to a local Ollama (http://localhost:11434/…);
 *      model has no fallback — you must pick one.
 *
 * Privacy note: this sends file/folder NAMES, paths, and sizes to the
 * configured endpoint. With the default local endpoint nothing leaves your
 * machine; only configure a cloud endpoint if you're OK with that.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { BUILTIN, loadCache, saveCache, applyNotes, isOpaque, configDir } = require('./notes');

const DEFAULT_ENDPOINT = 'http://localhost:11434/v1/chat/completions';
const BATCH = 12;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(configDir(), 'config.json'), 'utf8')); }
  catch (_) { return {}; }
}

function resolveSettings(opts = {}) {
  const cfg = loadConfig();
  return {
    endpoint: opts.endpoint || process.env.STORAGESAVER_ENDPOINT || cfg.endpoint || DEFAULT_ENDPOINT,
    model:    opts.model    || process.env.STORAGESAVER_MODEL    || cfg.model    || null,
    key:      opts.key      || process.env.STORAGESAVER_KEY      || cfg.key      || null,
  };
}

function gb(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB'; }

const SYSTEM = `You label files and folders found on a personal Mac owned by a software developer.
For each numbered item, write ONE plain-English sentence (max 22 words) explaining what it is or what app/tool it belongs to.
Write for a non-expert. No hedging, no "likely/probably". If you genuinely do not recognize it, output exactly UNSURE.
Output format: one line per item, "<id>\\t<sentence>". No other text.`;

async function askBatch(items, { endpoint, model, key }) {
  const lines = items.map((w, i) =>
    `${i}. name: "${w.name}" | inside: "${w.parent}" | path: ${w.path} | size: ${gb(w.size)} | ${w.type}`);
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model, temperature: 0.2,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: lines.join('\n') }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()).choices[0].message.content;
  const answers = new Map();
  for (const line of out.split('\n')) {
    const mm = line.match(/^\s*(\d+)[.\t:]?\s*[\t]?\s*(.+)$/);
    if (mm) answers.set(parseInt(mm[1], 10), mm[2].trim());
  }
  return answers;
}

/**
 * Annotate an existing StorageSaver HTML report in place.
 * opts: { html, minMb, endpoint, model, key, dry }
 */
async function annotate(opts = {}) {
  const HTML = opts.html || path.join(process.cwd(), 'storagesaver.html');
  const MIN_BYTES = (Number.isFinite(opts.minMb) ? opts.minMb : 100) * 1024 * 1024;
  const settings = resolveSettings(opts);

  if (!fs.existsSync(HTML)) {
    throw new Error(`${HTML} not found — run \`storagesaver scan\` first (or pass the report path)`);
  }

  // ── Collect work ──────────────────────────────────────────────────────────
  const html = fs.readFileSync(HTML, 'utf8');
  const m = html.match(/window\.STORAGESAVER_DATA = (.*);\n/);
  if (!m) throw new Error('no data block found in ' + HTML);
  const data = JSON.parse(m[1]);

  const cache = loadCache();
  const seen = new Map();   // lowercased basename → sample entry
  (function walk(x, parent) {
    const key = x.n.toLowerCase();
    if (!x.note && !x.n.startsWith('(other') && x.s >= MIN_BYTES &&
        !BUILTIN[key] && !cache.notes[key] && !isOpaque(x.n) && !seen.has(key)) {
      seen.set(key, { name: x.n, path: x.p, size: x.s, parent: parent ? parent.n : '', type: x.t });
    }
    (x.c || []).forEach(c => walk(c, x));
  })(data.root, null);

  const work = [...seen.values()];
  console.error(`${work.length} unique names need notes (min ${gb(MIN_BYTES)}, model ${settings.model || '(none)'}, endpoint ${settings.endpoint})`);
  if (opts.dry) {
    work.forEach(w => console.log(`${gb(w.size)}\t${w.name}\t${w.path}`));
    return { needed: work.length, noted: 0, unsure: 0 };
  }
  if (!work.length) return { needed: 0, noted: 0, unsure: 0 };

  if (!settings.model) {
    throw new Error(
      'no model configured — pass --model, set STORAGESAVER_MODEL, or put ' +
      `{"model": "…"} in ${path.join(configDir(), 'config.json')}`);
  }

  // ── Ask the model in batches ──────────────────────────────────────────────
  let done = 0, unsure = 0;
  for (let i = 0; i < work.length; i += BATCH) {
    const batch = work.slice(i, i + BATCH);
    let answers;
    try { answers = await askBatch(batch, settings); }
    catch (e) { console.error(`batch ${i / BATCH} failed: ${e.message}`); continue; }
    batch.forEach((w, j) => {
      const a = answers.get(j);
      const key = w.name.toLowerCase();
      if (!a || /^UNSURE\b/i.test(a)) {
        if (!cache.unsure.includes(key)) cache.unsure.push(key);
        unsure++;
      } else {
        cache.notes[key] = a.replace(/\s+/g, ' ').slice(0, 160);
        done++;
      }
    });
    saveCache(cache);   // checkpoint every batch — a crash loses nothing
    console.error(`  ${Math.min(i + BATCH, work.length)}/${work.length} (${done} noted, ${unsure} unsure)`);
  }

  // ── Re-apply everything into the HTML ─────────────────────────────────────
  applyNotes(data.root, cache);
  const block = 'window.STORAGESAVER_DATA = ' + JSON.stringify(data) + ';\n';
  fs.writeFileSync(HTML, html.replace(/window\.STORAGESAVER_DATA = .*;\n/, block));
  console.error(`done: ${done} new notes, ${unsure} unsure → notes-cache.json; ${path.basename(HTML)} updated`);
  return { needed: work.length, noted: done, unsure };
}

module.exports = { annotate, resolveSettings, DEFAULT_ENDPOINT };
