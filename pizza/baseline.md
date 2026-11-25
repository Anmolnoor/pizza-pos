# Baseline

Upstream's own install, build and test results at commit `b5928ec`, taken on our machines before any change, so that a later failure can be told apart from one that was already there.

Reproduce with `scripts/pizza/baseline.sh <checkout> <report folder> scripts/pizza`.

## MacBook Pro

macOS (Darwin 27.2.0, arm64), Node 22.23.1, npm 10.9.8. Run on 2026-11-25.

| Step | Command | Result | Time |
| :--- | :--- | :--- | :--- |
| Install | `npm ci` | pass | 12 s |
| Native rebuild | `npx @electron/rebuild -f -w better-sqlite3` | pass | 1 s |
| Frontend install | `npm --prefix frontend ci` | pass | 3 s |
| Typecheck | `npx tsc --noEmit` | pass | 1 s |
| Lint | `npm run lint` | pass (warnings only) | 1 s |
| Lint budget | `npm run lint:budget` | pass | 2 s |
| Build | `npm run build` | pass | under 1 s |
| Frontend build | `npm run build:frontend` | pass | 17 s |
| Full suite | every `test:*` suite named in `pretest` and `test`, one after another, with a throwaway `HOME` | **257 suites, 0 failed** | 463 s |

Slowest suites: `test:dev-tooling` 44 s, `test:sequence` 24 s, `test:orders-search` 20 s, `test:diagnostics` 18 s, `test:phase7-setup-i18n` 14 s.

Install times are with a warm npm cache. The Playwright suites were not part of this run.

## Fedora

Fedora 45 (Linux 7.3.4, x86_64), Node 22.23.5 (nvm), npm 10.9.9. Attempted on 2026-11-25.

| Step | Command | Result |
| :--- | :--- | :--- |
| Install | `npm ci` | **fail**: `gyp ERR! stack Error: not found: make`, while installing `better-sqlite3` |

`gcc`, `gcc-c++`, `make` and Xvfb are not installed, and installing them needs the owner's sudo password. Nothing after the install step has run on Fedora.
