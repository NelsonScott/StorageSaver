/**
 * classify.js — StorageSaver's safety knowledge base.
 *
 * Given a path, decides whether it is:
 *   safe   — regenerable; comes with a copy-paste reclaim command
 *   review — app-managed or needs a human decision; guidance only
 *   never  — deleting causes real, sometimes cloud-propagating, data loss
 *   null   — no opinion
 *
 * Every rule here is a hard-won lesson. The commands are COPY-ONLY
 * suggestions rendered into the report — StorageSaver never executes them.
 *
 * User overlay: ~/.config/storagesaver/rules.json lets you add your own
 * rules without forking. Format:
 *   {
 *     "safe":   [{ "match": "~/my-render-cache", "note": "...", "cmd": "..." }],
 *     "review": [{ "match": "Steam",             "note": "..." }],
 *     "never":  [{ "match": "~/Documents/vault", "note": "..." }]
 *   }
 * match semantics: a string containing "/" is an exact logical path
 * ("~" expands to your home; a trailing "/*" matches the dir and everything
 * under it). A string without "/" matches any file/dir with that basename.
 * User rules win over the builtins.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

// Shell-quote a path for the copy-paste commands.
const esc = p => "'" + p.replace(/'/g, "'\\''") + "'";

// ── User overlay ─────────────────────────────────────────────────────────────

function configDir() {
  return process.env.STORAGESAVER_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'storagesaver');
}

let _userRules = null;
function loadUserRules() {
  if (_userRules) return _userRules;
  _userRules = { safe: [], review: [], never: [] };
  const file = path.join(configDir(), 'rules.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const tier of ['safe', 'review', 'never']) {
      if (Array.isArray(raw[tier])) {
        _userRules[tier] = raw[tier].filter(r => r && typeof r.match === 'string');
      }
    }
  } catch (_) { /* no overlay, or malformed — builtins only */ }
  return _userRules;
}

function expandMatch(m) {
  return m.startsWith('~') ? path.join(HOME, m.slice(1)) : m;
}

function matchUserRule(rule, lp, base) {
  const m = expandMatch(rule.match);
  if (!m.includes('/')) return base === rule.match;              // basename rule
  if (m.endsWith('/*')) {
    const prefix = m.slice(0, -2);
    return lp === prefix || lp.startsWith(prefix + '/');
  }
  return lp === m;
}

function classifyUser(lp, base) {
  const rules = loadUserRules();
  // never wins over review wins over safe — err toward caution on overlap.
  for (const tier of ['never', 'review', 'safe']) {
    for (const r of rules[tier]) {
      if (matchUserRule(r, lp, base)) {
        return { b: tier, note: r.note || null, cmd: tier === 'safe' ? (r.cmd || null) : null };
      }
    }
  }
  return null;
}

// ── Builtin rules ────────────────────────────────────────────────────────────
// classify() takes the LOGICAL path (e.g. /Users/you/… even when scanning
// /System/Volumes/Data) so rules read naturally. First match wins.

function classify(lp, name, isDir, absPath) {
  const base = name;
  const p = absPath || lp;   // the real on-disk path, used in suggested cmds
  const H = HOME;

  // User overlay first — your rules beat ours.
  const user = classifyUser(lp, base);
  if (user) return user;

  // ── never ──
  if (lp === `${H}/Library/Messages`) return { b: 'never', note: 'iMessage history + attachments — with Messages in iCloud ON, deletions propagate to ALL devices' };
  if (lp === `${H}/Library/CloudStorage` || lp.startsWith(`${H}/Library/CloudStorage/`)) return { b: 'never', note: 'cloud drive placeholders — a local delete here is a CLOUD delete (Drive/Dropbox treat it as intentional)' };
  if (lp === `${H}/Library/Mobile Documents` || lp.startsWith(`${H}/Library/Mobile Documents/`)) return { b: 'never', note: 'iCloud Drive — deleting removes files from iCloud on all devices' };
  if (base === 'Photos Library.photoslibrary') return { b: 'never', note: 'managed by Photos — free space inside the Photos app, never in Finder' };
  if (lp === '/private/var/vm') return { b: 'never', note: 'swap files — managed by macOS, do not touch' };
  if (lp === `${H}/Library/Keychains`) return { b: 'never', note: 'your keychains — never touch' };

  // ── safe (regenerable; cmd = copy-only suggestion) ──
  if (lp === `${H}/.Trash`) return { b: 'safe', note: 'your Trash — empty via Finder or the command', cmd: `rm -rf ${esc(p)}/*` };
  if (isDir && base === 'node_modules') return { b: 'safe', note: 'npm dependencies — `npm install` restores them', cmd: `rm -rf ${esc(p)}` };
  if (isDir && (base === '.venv' || base === 'venv')) return { b: 'safe', note: 'Python virtualenv — recreate with pip/uv', cmd: `rm -rf ${esc(p)}` };
  if (lp === `${H}/Library/Developer/Xcode/DerivedData`) return { b: 'safe', note: 'Xcode build artifacts — regenerate on next build', cmd: `rm -rf ${esc(p)}/*` };
  if (lp === `${H}/Library/Developer/Xcode/iOS DeviceSupport`) return { b: 'safe', note: 'device debug symbols — re-download on connect', cmd: `rm -rf ${esc(p)}/*` };
  if (lp === `${H}/.npm`) return { b: 'safe', note: 'npm cache — regenerates', cmd: `rm -rf ${esc(p)}/_cacache` };
  if (lp === `${H}/.cache/huggingface`) return { b: 'safe', note: 'ML models — re-download on next use', cmd: `rm -rf ${esc(p)}` };
  if (lp === `${H}/.cache`) return { b: 'safe', note: 'tool caches (huggingface, torch, pre-commit…) — regenerate', cmd: `rm -rf ${esc(p)}` };
  if (lp === `${H}/.docker/scout`) return { b: 'safe', note: 'vuln-scan SBOM cache — Docker rebuilds it (`docker scout cache prune` does NOT clear it)', cmd: `rm -rf ${esc(p)}` };
  if (lp === `${H}/Library/Application Support/Claude/vm_bundles`) return { b: 'safe', note: 'Claude sandbox VM image — re-downloads on next use (quit Claude first)', cmd: `rm -rf ${esc(p)}` };
  if (lp === `${H}/Library/Application Support/Google/GoogleUpdater/crx_cache`) return { b: 'safe', note: 'update payloads — re-download', cmd: `rm -rf ${esc(p)}` };
  if (lp === `${H}/Library/Application Support/com.docker.install`) return { b: 'safe', note: 'Docker installer payloads — safe to clear even if you keep using Docker', cmd: `rm -rf ${esc(p)}` };
  if (lp === `${H}/Library/Messages/Caches`) return { b: 'safe', note: 'render cache — regenerates; history/attachments untouched (quit Messages first)', cmd: `rm -rf ${esc(p)}` };
  if (lp === '/private/tmp') return { b: 'safe', note: 'temp files — cleared on reboot anyway', cmd: `sudo rm -rf ${esc(p)}/*` };
  // Chrome update clones: the updater leaves a full ~1.4 GB clone of
  // Chrome.app under the per-user temp container on EVERY update and never
  // cleans them up (2026-07 lesson: 14 GB of these on one machine).
  if (base === 'com.google.Chrome.code_sign_clone' && lp.startsWith('/private/var/folders/')) {
    return { b: 'safe', note: 'leftover temp clones of Chrome.app made during updates — they pile up forever; stale ones are safe to delete',
             cmd: `find ${esc(p)} -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf {} +` };
  }
  if (lp.startsWith(`${H}/Library/Caches/`)) {
    // com.apple.* caches are system-managed — call those review, the rest safe.
    const top = lp.slice(`${H}/Library/Caches/`.length).split('/')[0];
    if (top.startsWith('com.apple.')) return { b: 'review', note: 'Apple system cache — usually regenerates, but let macOS manage it' };
    return { b: 'safe', note: 'app cache — regenerates; quit the app first', cmd: `rm -rf ${esc(p)}` };
  }
  if (lp === `${H}/Library/Caches`) return { b: null, note: 'user caches — most children are safe to clear individually' };

  // ── review (app-managed / needs a decision) ──
  // Docker's VM disk (Docker.raw) is sparse and GROW-ONLY: `docker system
  // prune` frees space INSIDE the VM but never shrinks the host file, so it
  // often reclaims ~0 bytes. Purge via Docker Desktop instead.
  if (lp === `${H}/Library/Containers/com.docker.docker` || lp === `${H}/Library/Group Containers/group.com.docker`)
    return { b: 'review', note: 'Docker VM disk (grow-only) — `docker system prune` will NOT shrink it; use Docker Desktop → Troubleshoot → Purge data' };
  if (lp === `${H}/Library/Application Support/MobileSync` || lp.startsWith(`${H}/Library/Application Support/MobileSync/`))
    return { b: 'review', note: 'iPhone/iPad backups — delete old devices via Finder device manager' };
  if (lp === `${H}/Library/Application Support/Google`) return { b: 'review', note: 'mostly Chrome PROFILE data (Service Workers, Extensions) — shrink by removing unused Chrome profiles, not rm' };
  if (lp === `${H}/Library/Application Support/Steam`) return { b: 'review', note: 'game installs — uninstall via Steam' };
  if (lp === `${H}/Library/Developer/CoreSimulator`) return { b: 'review', note: 'simulator devices — prune with `xcrun simctl delete unavailable`' };
  if (lp === `${H}/Library/Application Support`) return { b: 'review', note: 'app data — check per app; orphans from uninstalled apps are common' };
  if (lp === `${H}/Library/Containers` || lp === `${H}/Library/Group Containers`) return { b: 'review', note: 'sandboxed app data — deleting resets those apps' };
  if (lp === `${H}/Downloads`) return { b: 'review', note: 'review manually — often full of old installers' };
  if (lp === '/private/var/folders') return { b: 'review', note: 'per-user temp/caches — macOS cleans these; reboot clears most' };
  if (lp === '/private/var/log') return { b: 'review', note: 'system logs — mostly rotated automatically' };
  if (lp === '/Library/Caches') return { b: 'review', note: 'system-wide caches — regenerate, but clearing needs sudo' };
  if (lp === '/opt/homebrew' || lp === '/usr/local/Homebrew') return { b: 'review', note: 'Homebrew — reclaim with `brew cleanup -s && brew autoremove`' };
  if (lp === `${H}/Applications` || lp === '/Applications') return { b: 'review', note: 'apps — check last-used before deleting; background utilities can look stale while running' };
  if (/\.(log)$/.test(base) && !isDir) return { b: 'review', note: 'log file — likely truncatable after a glance' };

  return { b: null, note: null };
}

module.exports = { classify, loadUserRules, configDir, esc };
