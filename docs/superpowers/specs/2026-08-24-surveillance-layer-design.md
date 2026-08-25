# Surveillance Infrastructure Layer — Design

**Date:** 2026-08-24
**Status:** Approved design, pending implementation plan
**Sub-project 1 of 4** in the new-layers initiative (build order: surveillance → NWS severe-weather polygons → SondeHub balloons → GPS-jamming hexes; each follow-on gets its own spec).

## Purpose

Render mapped roadside surveillance hardware — ALPR cameras (Flock Safety et al.), fixed CCTV nodes, gunshot detectors, and other `man_made=surveillance` devices — as a toggleable data layer on the globe. The data is crowdsourced into OpenStreetMap (notably by the DeFlock project), which makes the layer a natural extension of the app's thesis: the surveillance network is itself public signal.

This layer shows **where surveillance hardware is installed**. It is distinct from the existing CCTV layer, which projects **live public camera feeds** into the scene. The two cross-link (see Interaction) but never merge.

## Data source

- **Query:** OpenStreetMap via Overpass — nodes and ways tagged `man_made=surveillance`, plus the tags that describe them: `surveillance:type` (`ALPR`, `camera`, `gunshot_detector`, …), `surveillance` (`public`/`outdoor`/`traffic`), `camera:type` (`fixed`/`panning`/`dome`), `camera:direction` / `direction`, `brand`, `operator`, `operator:type`.
- **License:** ODbL — same handling as the existing OSM-derived layers (datacenters, dams, military installations). Credit registered in the Data attribution popover; DeFlock courtesy credit alongside.
- **Honesty labeling:** every card and the layer stats row carry `CROWDSOURCED — COVERAGE INCOMPLETE`. Absence of a marker is never evidence of absence of a camera; presence reflects a contributor's mapping, not verification by this app.

## Architecture

Follows the `militaryInstallations` pattern end to end.

### Server: `surveillanceProxy()` in `vite.config.js` → `/api/surveillance`

- Accepts a viewport (`south,west,north,east`), rejects requests wider than **6°** in either axis or crossing the antimeridian (mirror of the military-installations 10° gate, tightened because surveillance nodes are denser than bases).
- Builds the Overpass query server-side from an **allow-listed template** — the client never sends raw Overpass QL.
- Normalizes the Overpass response into a compact record schema before it reaches the client (see below); raw OSM payloads never ship to the browser.
- Disk cache under `.gev-cache/` keyed by rounded viewport cell, TTL 6 hours, serve-stale on upstream failure (crowdsourced data changes slowly; Overpass deserves gentle citizenship). Response marks `stale: true` when serving stale so the layer can surface freshness state.
- On Overpass timeout/outage with no cache: sanitized error; the layer shows `UNAVAILABLE`, never fabricates.

### Normalized record schema

```js
{
  id: 'node/123456',          // OSM element id — stable, used for entity ids and dedupe
  lat, lon,                    // number (ways use their centroid)
  kind: 'alpr' | 'camera' | 'gunshot_detector' | 'other',  // derived from surveillance:type / camera:type
  brand: 'Flock Safety' | null,
  operator: string | null,
  operatorType: string | null, // government / private / …
  directionDeg: number | null, // camera:direction ?? direction, parsed; null when absent
  mount: string | null,        // pole / wall / …
  osmTimestamp: string | null, // last-edit date when Overpass supplies meta
}
```

Normalizer lives in `src/data/surveillanceData.js` (pure, unit-tested), mirroring `militaryInstallationData.js`.

### Client layer: `src/data/surveillance.js`

Layer module registered in `main.js` with the standard contract (`id: 'surveillance'`, `name: 'Surveillance'`, icon, `init/enable/disable/update`, `updateInterval: 0` — fetches are camera-move-driven, not polled):

- `init` creates a `CustomDataSource`, subscribes `camera.moveEnd` → debounced viewport load (500 ms, same as installations).
- Viewport fetch via `/api/surveillance` with abort-on-supersede.
- **Render cap:** `MAX_RENDERED = 900` per viewport. Over cap, records nearest the viewport center win and the stats row reports `SHOWING 900 OF 2,340 IN VIEW` — no silent truncation (repo convention).
- **Glyph styling by `kind`:** ALPR, fixed camera, gunshot detector, other — one color + point/billboard style each, defined in an exported `STYLE_BY_KIND` map (unit-tested, same shape as `COLOR_BY_CLASS`).
- **Coverage cones:** nodes with `directionDeg` render a ground-level viewshed wedge reusing the geometry helpers in `src/data/cctvViewshed.js` (`viewshedColors`, frustum/wedge primitives). Assumed FOV 60°, range 60 m for cameras / 100 m for ALPR — clearly an **estimate**; cones are labeled `EST COVERAGE` in the card and use the viewshed styling so they read as estimated volume, not measured fact.
- **LOD gates** (cctvLod-style thresholds, local constants): cones and labels only below ~3 km camera altitude; glyphs cluster to density dots above ~20 km; layer auto-suspends fetching above ~200 km (whole-continent views would blow the viewport gate anyway).
- Ground placement via the shared `groundFloor` warm chain (same as installations) so glyphs sit on the photoreal surface.

### Interaction

- Click → entity context card (existing `contextStore`/pick-registry pattern): kind, brand, operator (+ type), direction, mount, OSM id + last-edit date, `CROWDSOURCED` badge.
- **CCTV cross-link:** when an enabled CCTV layer has a registered live camera within 30 m of a surveillance node, the card offers "LIVE FEED NEARBY →" which invokes the CCTV layer's existing selection path. Read-only integration; no coupling of data models — the surveillance layer asks the CCTV registry, never the reverse.

### UI

- Data Layers panel chip: **SURVEILLANCE** (standard toggle, stats row shows count in view / rendered / freshness state).
- No new panels, no new modes.

## Error handling

- Proxy unreachable / Overpass down, no cache → stats row `UNAVAILABLE`, retry with backoff on next camera settle (installations pattern).
- Stale cache served → stats row `STALE <age>`.
- Malformed Overpass rows dropped in the normalizer, never rendered half-formed; normalizer counts drops for the stats line.

## Testing

- `surveillanceData.test.mjs`: normalizer — tag mapping to `kind`, direction parsing (numeric, cardinal `NE`, garbage → null), way-centroid handling, malformed-row drops.
- `surveillance.test.mjs`: `STYLE_BY_KIND` completeness (every `kind` styled), viewport-gate math, over-cap selection (center-nearest wins, dropped count reported), LOD threshold gates.
- Proxy: query-template allow-listing and viewport rejection covered by unit tests if the proxy helpers are extracted; otherwise exercised via the existing proxy test seams in `vite.config.js`'s tested helpers.
- Manual/live proof: keyless boot, enable layer over Austin, verify glyphs + cones on DeFlock-mapped ALPRs, click-through card, CCTV cross-link.

## Non-goals

- No live feeds, no license-plate data, no detection events — locations and attributes of mapped hardware only.
- No editing/reporting back to OSM from the app.
- No global bundled snapshot; the layer is viewport-driven and online-only.
- No claim of completeness anywhere in UI or docs.

## Docs & attribution checklist (implementation must include)

- `DATA_SOURCES.md` live-sources entry (Overpass usage, ODbL, DeFlock credit, honesty caveats).
- `dataCredits.js` static credit registration.
- README "What's on the globe" row (🟢 keyless).
