# Contributing to StorageSaver

Issues and PRs welcome.

## What we want most: safety-rule contributions

The curated gotcha knowledge base is the moat. If you know that some
folder only *looks* safe to delete (or is safer than it looks), that is
the most valuable thing you can contribute:

- **Safety rules** go in `src/classify.js`. Each rule needs the tier
  (safe / review / never), a one-line plain-English note, and, for safe
  rules, the exact copy-paste reclaim command. Please include how you
  learned it (what happened, what did/didn't work) in the PR description
  or a code comment.
- **"What is this?" notes** go in `src/seed-notes.json`, keyed by
  lowercased basename. One sentence, max ~22 words, written for a
  non-expert, no hedging. Only names that any Mac could plausibly have.
  Never include anything from your own machine that identifies you.

## Ground rules

- StorageSaver is read-only. PRs that make it delete, move, or execute
  anything on the user's disk will be declined.
- Zero runtime dependencies. Keep it that way.
- No personal data in code, notes, or fixtures.

## How to test

```bash
# syntax check everything
npm test

# quick end-to-end: scan your home folder, don't open a browser
node bin/storagesaver.js scan --quick --no-open --out /tmp/ss-test.html

# full scan (45-90s)
node bin/storagesaver.js scan --no-open --out /tmp/ss-full.html

# watcher without sending anything
node skill/watcher.js --dry-run --quick

# annotate against a local Ollama
node bin/storagesaver.js annotate /tmp/ss-test.html --model qwen2.5-coder:32b --dry
```

Open the generated HTML and click around: the sunburst, the tree, the
badges, and the ⚙️ Annotate panel should all work offline.
