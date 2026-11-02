# Changelog

## 0.2.0

New safety-classification rules, distilled from a real deep-clean that reclaimed ~50 GB:

- **Chrome on-device AI model** (`OptGuideOnDeviceModel`) flagged **safe** — Gemini Nano weights are often 3–5 GB and re-download on demand. (Was invisible before.)
- **Python virtualenv stores** (`~/.local/share/virtualenvs`, `~/.virtualenvs`) flagged **safe** — pipenv/poetry envs each bundle their own PyTorch/numpy and routinely total many GB; the #1 thing a node_modules-only scan misses.
- **iOS Simulator runtime images** (`/Library/Developer/CoreSimulator/Images`) flagged **safe** (sudo) — root-owned, several GB, re-downloaded by Xcode on demand.
- **Staged macOS updates** (`/Library/Updates`) flagged **review** — reclaimed automatically once the pending update installs (which also clears its os-update snapshots).

## 0.1.0

Initial release — read-only macOS disk explorer (sunburst + tree) with plain-English AI explanations and a built-in safety knowledge base.
