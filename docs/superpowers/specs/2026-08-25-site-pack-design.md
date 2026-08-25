# Site Pack — Design Spec

**Date:** 2026-08-25
**Status:** Approved (design review in chat, 2026-08-25)
**Scope:** Personal fork only — not intended for upstream PR in this form.

## Overview

Teach God's Eye View about one specific place ("the site" — the operator's own
property) via a config-driven **site pack**, and add three hyper-local data
layers proven in the lot-lens project: an Open-Meteo wind sampling grid, FEMA
NFHL flood zones, and USGS NHD hydrology. The pack is the composition root:
layer modules stay generic; the pack instantiates and configures them. The
pack schema reserves `sensors[]` and `cameras[]` envelopes now (validated,
inert) so slice 2 — own-sensor ingestion — extends the schema rather than
replacing it.

## Goals

- Fly-to-site experience: descend from orbit to the operator's lot and see
  wind, flood, and hydrology context light up at the right altitudes.
- Layers work anywhere on Earth (viewport mode); the site is the flagship
  anchor, not a hard requirement.
- Stock behavior preserved: with no pack file present, the app runs exactly as
  before — no site UI, no fetches, no console noise beyond one debug line.
- Home coordinates never enter the client bundle or git history.

## Non-goals (v1)

- No sensor transport (MQTT/WebSocket) wiring — `sensors[]` is schema-only.
- No voice-tool changes (`GEV_REALTIME_TOOLS` is sha256-pinned; extending the
  `set_layer_visibility` enum is a follow-up).
- No detection-overlay participation for wind samples.
- No first-run-launcher changes.
- No per-frame animation (no render-governor holds needed).
- No upstream PR, no DATA_SOURCES.md upstream ceremony (fork-local docs only).

## 1. Pack file and serving

- **File:** `config/site.local.json`, **gitignored** (add to `.gitignore`).
  A committed `config/site.example.json` carries fake data (Zilker Park area)
  demonstrating every field.
- **Serving:** new GET `/api/site` middleware in `vite.config.js`, following
  the existing CCTV source-pack pattern. Reads the path in env
  `GEV_SITE_FILE` (default `config/site.local.json`). Responses:
  - File present + parseable → `200`, `application/json`, `Cache-Control: no-store`.
  - File absent → `404` (sanitized body, no filesystem paths).
  - File unreadable/unparseable → `500` with a sanitized error; details go to
    the server console only.
- **Schema (version 1):**

```json
{
  "version": 1,
  "name": "Home",
  "home": { "lat": 30.2, "lon": -97.7 },
  "lotPolygon": [[-97.701, 30.199], [-97.699, 30.199], [-97.699, 30.201], [-97.701, 30.201], [-97.701, 30.199]],
  "neighborhoodHalfM": 500,
  "camera": { "headingDeg": 0, "pitchDeg": -35, "rangeM": 400 },
  "layers": {
    "site-wind":  { "enabled": true, "grid": [3, 3] },
    "site-flood": { "enabled": true },
    "site-hydro": { "enabled": true }
  },
  "sensors": [],
  "cameras": []
}
```

- `home` is required. Everything else optional with defaults:
  `name` "SITE", `lotPolygon` null (wind grid then centers on `home`),
  `neighborhoodHalfM` 500 (clamped 100–2000), `camera` defaults
  `{ headingDeg: 0, pitchDeg: -35, rangeM: 400 }`, all three layers enabled,
  `grid` [3, 3] (each axis clamped 2–5).
- `lotPolygon` is a GeoJSON-style `[lon, lat]` ring — copy-pasteable from
  lot-lens `src/lib/geom/propertyConfig.ts`. The loader closes an unclosed
  ring and rejects rings with fewer than 4 points (after closing).
- **Reserved envelopes:** `sensors[]` and `cameras[]` entries are validated
  against `{ id: string, kind: string, label?: string, position?: {lat, lon},
  transport?: object }`. Unknown `kind` values are tolerated. In v1 nothing is
  wired; the site panel reports them as `PLANNED · NOT WIRED` with a count.
  `version` must equal 1; any other value disables the site with a warning.

## 2. Loader — `src/data/sitePack.js`

- Fetches `/api/site` once at boot (through `createRetryableLoader` semantics
  are unnecessary — a single attempt; 404 is the normal "no site" path).
- Validates + normalizes per the schema rules above. **Any invalid pack
  disables the entire site feature** with one console warning — no
  half-loaded state.
- Exports: `getSitePack()` (normalized pack or null), `siteBounds()`
  (bbox from `home` ± `neighborhoodHalfM`), `isOverSite(lat, lon)`
  (inside `siteBounds()`), and an init hook called from `src/main.js`.
- On a valid pack: registers the three layers with `DataLayerManager` using
  per-layer config from the pack, adds a SITE fly-to using the pack's `camera`
  framing (via the existing locations/fly-to machinery), and adds a compact
  site panel row: pack name, per-layer feed state, planned-sensor count.
- With no pack: registers nothing. Stock UI, stock behavior.

## 3. Layers

All three are standard `src/data/<layer>.js` modules implementing
`init/enable/disable/update/destroy/getStats`, registered in the layer
registry (`layerState.js` `LAYER_STATE_REGISTRY` entries) so persistence
(`gev:layer-state:v2`), the DISPLAY rail, and `layerFeedState` rows work
unmodified. Data fetches go through `createRetryableLoader`. Data arrival
calls `governorRequestRender` — no per-frame holds. Fetch adapters are ports
of the corresponding lot-lens source clients (`src/lib/sources/*.ts`),
translated to plain JS.

### 3.1 `src/data/siteWind.js` — layer id `site-wind`

- **Source:** Open-Meteo forecast API, multi-point query (comma-separated
  lat/lon lists, as lot-lens's grid sampler does): current
  `wind_speed_10m`, `wind_direction_10m`, `wind_gusts_10m`. Keyless, CORS.
- **Anchoring:** when the camera target is over the site
  (`isOverSite`), sample the pack's N×N grid across `lotPolygon` (or centered
  on `home` if no polygon). Elsewhere ("viewport mode"), sample a 3×3 grid
  centered on the camera target, spaced to the visible extent.
- **LOD gate:** active only below **6 km** camera altitude (tunable constant).
- **Render:** terrain-clamped arrow sprites; heading via
  `iconOrientation.js` screen-projected rotation so arrows show true bearing
  at any camera angle. Speed/gust cards drawn through the `worldOverlay`
  host. Arrows are static between refreshes.
- **Refresh:** ~10 minutes (Open-Meteo is hourly-resolution data), plus
  refetch on anchor change (site↔viewport transition or large camera move,
  debounced).
- **Honesty:** feed row and cards labeled `MODELED · OPEN-METEO`. This label
  is the seam a future `MEASURED` sensor source replaces.

### 3.2 `src/data/siteFlood.js` — layer id `site-flood`

- **Source:** FEMA NFHL ArcGIS REST, hazard-area layer (layer 28 of the
  public NFHL MapServer, as used by lot-lens `femaNfhl.ts`), envelope query,
  GeoJSON out. Keyless, CORS.
- **Bbox:** `siteBounds()` when over the site; viewport bounds otherwise.
- **LOD gate:** active below **15 km** (tunable).
- **Render:** ground-clamped translucent polygons colored by flood zone
  (port lot-lens `colorForZone`: V/VE red, AE/A orange, X light, etc.),
  stroked outlines.
- **Caching:** flood geometry is near-static — cache responses keyed by
  quantized bbox for the session; serve cache before refetching.
- **Coverage honesty:** an empty result outside the US reads
  `NO DATA · OUTSIDE US COVERAGE` in the feed row, not a failure.

### 3.3 `src/data/siteHydro.js` — layer id `site-hydro`

- **Source:** USGS NHDPlus HR MapServer (as used by lot-lens `usgsNhd.ts`):
  flowlines from **layer 3** (`NetworkNHDFlowline` — the connected network;
  explicitly NOT layer 4, which is non-network fragments) and waterbodies
  from **layer 9** (`NHDWaterbody`), fetched in parallel. Keyless, CORS.
- **Bbox / LOD / caching:** same pattern as `site-flood` (15 km gate).
- **Render:** flowlines as cyan ground-clamped polylines; waterbodies as
  filled cyan polygons. FCODE values decoded to human labels
  ("Stream/River, perennial", …) for pick/cards — port the lot-lens decode
  table.
- **Coverage honesty:** same US-coverage labeling rule as flood.

## 4. Error handling

- Source failures follow the existing layer contract: `createRetryableLoader`
  cooldown/backoff, failure surfaced through `getStats` →
  `layerFeedState` (the same `refreshFailureFromStats` path other layers
  use). No new error UI.
- `/api/site` errors are sanitized; loader treats any non-200 as "no site".
- Partial NHD result (flowlines ok, waterbodies failed): render what arrived,
  report the feed as degraded — never silently pretend completeness.

## 5. Testing

Co-located `node:test` files, matching repo convention:

- `sitePack.test.mjs` — schema validation/normalization: missing `home`
  rejected; version ≠ 1 rejected; unclosed polygon closed; <4-point polygon
  rejected; clamps (`neighborhoodHalfM`, `grid`); unknown sensor kinds
  tolerated and counted; invalid pack disables everything; 404 → null pack.
- `siteWind.test.mjs` — grid-point generation from polygon and from
  viewport; Open-Meteo multi-point response → sample mapping; LOD gating;
  anchor-transition refetch logic (debounce).
- `siteFlood.test.mjs` — envelope/bbox math + quantized cache keys;
  zone → color mapping; empty-outside-US state.
- `siteHydro.test.mjs` — FCODE decode table; parallel fetch with one leg
  failing → degraded state; layer 3/9 request shaping.
- Gates: `npm run build`, `npm test`, `npm run test:track`, and
  `node scripts/qa-perf.mjs` all stay green (no new idle render load).

## 6. Documentation

Fork-local: add a delta note to `docs/CURRENT-STATE.md` and a `CHANGELOG.md`
entry describing the site pack, the three layers, their LOD gates, and the
`sensors[]`/`cameras[]` reservation. Update `.env.example` with
`GEV_SITE_FILE` (commented, optional).

## 7. Future (out of scope, informs the schema only)

Slice 2 candidates, in rough order: MQTT-over-WebSocket sensor bridge filling
`sensors[]` (weather station / anemometer grid → `MEASURED` wind source);
RTL-SDR ADS-B local receiver as an additional flights-layer source; own IP
cameras filling `cameras[]` via the CCTV registered-URL model; drone
photogrammetry 3D Tiles mounted over the site. The `version` field is the
migration point for all of these.
