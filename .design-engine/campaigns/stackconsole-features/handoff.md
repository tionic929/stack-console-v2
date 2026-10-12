---
campaign: stackconsole-features
project: stackconsolev2
status: active
updated: 2026-10-07
---
# Handoff: StackConsole features (2026-10-07)

User asked (2026-10-07): "restore it [macOS window controls], also lets proceed with the other plans of implementing new features".

## Steps
| # | Step | Status |
|---|---|---|
| 0 | Security baseline (sandbox, CSP + inline scripts to files, single-instance) + silent shell failure | done: engine test + live app (CSP/sandbox active, shell falls back to home folder) |
| 1 | Restore macOS-style window controls (fixed colours, labels, hit areas, hover glyphs, real minimize) | built; colours confirmed in live app |
| 2 | S-001 auto-restart on crash + Windows notification | built; engine-tested; live check pending |
| 3 | S-002 env vars per command + .env file (secrets via safeStorage) | built; engine-tested; live check pending |
| 4 | S-003 import commands from project folder | **done 2026-10-07**: hardened (realpath/size/skipped report, heuristics); importer 14/14, suites 20/20 + 33/33; live in an isolated QA Electron instance (empty state → Import window → import → sidebar; re-import; no-folder); S-003 marked done |
| 5 | S-004 start order (start after X is ready) + "waiting" status | **done 2026-10-07**: + port as ready signal, cycle log; suite 2 33/33, harness (waiting/blocked/form); S-004 marked done. Running app needs a restart for the port signal + text tweaks |
| 6 | S-005 port-in-use check before Start | **done 2026-10-07**: live app dialog + port-free verified; S-005 marked done |
| 7 | Log view: Log 1 find bar (filter, levels, timestamps, copy, crash banner) | built; renders in live app (chips/timestamps in use); interaction check pending |
| 9 | W2 project tree + git branches (+ S-006 folder actions, S-007 relink, S-010 Browse/branch) | **done 2026-10-07**: suite 3 27/27, suites 1–2 + importer green, real-Electron QA with fixtures; KI-007/008 closed |
| 8 | Regression + rendered verification (engine test, harness, live app mirror) + vault | in progress: suites 20/20 + 33/33; vault updated (Architecture, Service Status flow, decisions, screen note, Known Issues, History) |

## Decisions taken without an answer (tier 2, overturnable)
- S-001 default "When it crashes" = **Leave it stopped** (today's behaviour); notifications on by default.
- S-002 secrets encrypted with Electron safeStorage; plaintext fallback with a visible warning if encryption is unavailable.
- Window controls stay on the **right**, order minimize · maximize · close, macOS colours.
- Log view: user said "proceed with the other plans" → building the recommended Log 1.

## Verification assets (session scratchpad, recreate if gone)
sc-qa/ (isolated copy: own package name → own userData lock + own data/projects.json; launch with node_modules/.bin/electron <sc-qa> --remote-debugging-port=9223) + sc-qa-fixture/ (Laravel 11 + Vite) + cdp.mjs (list | eval | shot | wait). importer-test.cjs, engine-test2.cjs.
engine-test.cjs (mock electron, real python), sc-serve.mjs + sc-stub.js (renderer harness), sc-mirror.mjs (live CDP mirror of the running app on :4795; launch app with `--remote-debugging-port=9222`).
