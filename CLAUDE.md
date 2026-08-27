# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

God's Eye View — a real-time OSINT globe in the browser: photorealistic 3D Earth (Google 3D Tiles via CesiumJS) with live aircraft, ships, satellites, earthquakes, fires, traffic, public CCTV, radio, and hands-free voice control (OpenAI Realtime). **No framework** — vanilla JS ES modules + CesiumJS + Vite. MIT licensed, public data only.

## Commands

Requires Node 24.14.x or 26.x (enforced by `package.json`; allocation test budgets are calibrated on Node 24 only).

```bash
npm run dev -- --host localhost --port 4173   # dev server (needs GOOGLE_MAPS_API_KEY in .env)
npm run build                                  # production build
npm test                                       # unit tests (node:test over src/**/*.test.mjs)
npm run test:track                             # tracking regression — dev server must be running
node --test src/data/flights.test.mjs          # run a single test file
node scripts/qa-perf.mjs                       # render-governor gate (headless Puppeteer, server up)
```

- Before a PR, all three must be green: `npm run build`, `npm test`, `npm run test:track`.
- `npm test` runs everything in parallel except two GC-bracketed allocation microbenchmarks (`src/data/focusAllocations.test.mjs`, `src/overlays/worldOverlayAllocation.test.mjs`), which run serialized with `--expose-gc`. On non-Node-24 runtimes they're skipped with a warning (`GEV_REQUIRE_ALLOCATION_GATE=1` makes that a failure).
- `scripts/qa-*.mjs` are headless Puppeteer QA harnesses against a running server on port 4173 (per-feature gates: firstrun, perf, traffic, labels, cctv, voice-routing, …).
- `scripts/dev-fresh.sh` / `dev-secure.sh` are macOS/bash (Keychain-based). On Windows, use `.env` (copy `.env.example`) and `npm run dev`.

## Architecture

- **`vite.config.js` is also the backend.** All secret-bearing providers (OpenAI, AISStream, OpenSky OAuth, TomTom, FIRMS, CCTV frame fetching, radio) are brokered through Vite middleware proxies defined here — with budget governors, caches, allowlists, and rate limits. Secret env vars must NOT be prefixed `VITE_` (that would expose them to the browser). Only Google Maps and Cesium ion keys are client-exposed, by design. Voice tool schemas (`GEV_REALTIME_TOOLS`) are declared here too.
- **One module per data layer**: `src/data/<layer>.js` (flights, aisLiveVessels, satellites, earthquakes, firmsHeatmap, cctv, radio, traffic, rocketLaunches, militaryFlights, …), each implementing the layer interface `init/enable/disable/update/destroy/getStats` (optional `getDetectableObjects`). `src/data/manager.js` (`DataLayerManager`) coordinates them; `src/data/layerState.js` (`LayerStateCoordinator`) persists layer enablement (`gev:layer-state:v2`, only for origin `user`/`voice`/`tool`).
- **UI lives in `src/ui.js`** (panels, HUD, styles, control facade) — keep it separate from layer logic in `src/data/`.
- **`src/renderGovernor.js`** — the app idles via an explicit render-on-demand governor (28 files import it). Invariant: any new per-frame visual animation MUST register a hold/release; any new discrete scene mutation MUST call `governorRequestRender`. `scripts/qa-perf.mjs` is the gate.
- **`src/overlays/worldOverlay.js`** — shared screen-space canvas overlay all layers draw cards/labels into; `src/data/labelArbiter.js` allocates label quotas across layers; `src/data/pickRegistry.js` arbitrates click ownership between layers.
- **Voice**: tools declared server-side in `vite.config.js`, executed client-side in `src/voice/gevActions.js`; session management in `src/voice/gevRealtime.js`. Keep the tool surface tight and responses honest (confirm only what actually happened).
- **Vertical datum**: entity heights go through `src/data/geoid.js` (EGM96) + `src/data/terrainHeights.js` / `groundFloor.js` sampled against the rendered mesh — don't bypass with raw ellipsoidal heights.
- **Other key pieces**: `src/main.js` bootstrap; `src/styles/` GLSL post-process shaders (one file per look); `src/scenes/director.js` cinematic tours; `src/sharelink.js` URL-serialized state; `src/data/local_data/` bundled datasets with per-folder provenance READMEs.
- **Tests are co-located**: `foo.js` → `foo.test.mjs` in the same directory, using `node:test`.

## Conventions and contracts

- 2-space indent, single quotes, semicolons, JSDoc on exported functions. Match surrounding idiom.
- **`docs/CURRENT-STATE.md` is the authoritative runtime reference — read it before changing runtime behavior, and update it (plus `CHANGELOG.md`) in the same PR as any behavior change.** It also records deliberate decisions marked "do not simplify"/"accepted" — respect these.
- Adding/changing a data source requires a `DATA_SOURCES.md` entry (license + attribution). Don't commit data you can't redistribute — fetch at runtime.
- Honesty is a product rule: modeled/simulated/estimated data must be labeled as such (e.g. `RECONSTRUCTED ESTIMATE`, keyless traffic simulation). Missing-key states are explicit UI states, not failures.
- Hard line from the maintainers: no features for named-person search, face recognition, or tracking individuals. The CCTV proxy fetches only server-registered URLs, never client-supplied ones.
- Provider model IDs and prices go in env vars (`.env.example`), not hardcoded in source.
