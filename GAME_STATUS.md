# 🏁 PIXEL DRIFT — STATUS REPORT (updated 2026-07-19)

_Snapshot of the game as it currently stands. Nothing below is aspirational — it's all implemented and in the running build._

**Stack:** React 19 + TypeScript + Vite 8 + Three.js 0.185 · pixel-art post-render (0.6×, NearestFilter) · offline-first · saves to `localStorage` (`pixel_drift_v1`).
**Build:** `tsc` clean · production build OK. **Entry:** `src/main.tsx` → `GameProvider` → `App.tsx`.
**Assets:** PixelLab MCP (Tier-2 sub, ~4.1k generations left) — car sprites, world tiles, car bodywork panels, marquee. All in `public/cars/`, `public/textures/`, `public/ui/`.

---

## 1. ARCHITECTURE

| File | Responsibility |
|---|---|
| `src/App.tsx` | Master race loop (rAF, variable dt ≤0.05), phases, input, wall/traffic/car collisions, laps, standings, pause |
| `src/context/GameContext.tsx` | Car DB (14 equal-but-different), loadout system, save/load, race config |
| `src/game/Physics.ts` | Vehicle dynamics, loadout resolution, collisions (see §4) |
| `src/game/Graphics.ts` | Three.js scene, terrain skirt, textures, car meshes w/ pixel panels, effects, cameras |
| `src/game/AI.ts` | Opponents: braking profile, boundary awareness, AI-AI avoidance |
| `src/game/World.ts` | Track splines, surface queries, 10 track definitions |
| `src/game/Traffic.ts` / `Sound.ts` / `Replay.ts` | Freeway traffic · procedural audio · frame recording (no playback UI) |
| `src/components/MainMenu.tsx` / `Garage.tsx` / `HUD.tsx` | Menu (+HOW TO PLAY) · loadout UI · in-race overlay |

**Coordinate convention (critical):** forward = `(sin yaw, cos yaw)` in world (x,z); `mesh.rotation.y = yaw`; body `vx`=forward, `vz`=lateral toward physics-right `(cos yaw, −sin yaw)`. **Render handedness:** through the three.js cameras, physics-right appears on the VIEWER'S LEFT. Only two places compensate (keep them in sync): the key mapping in App.tsx (`A/← → +1`, `D/→ → −1`) and the minimap projection in HUD.tsx (deliberate det −1 reflection). Physics/AI are self-consistent in their own frame. See `memory/coordinate-convention.md`.

---

## 2. CARS — 14, EQUAL BUT DIFFERENT

No power ladder. All cars sit in **hp/kg 0.164–0.182** (computed pace-proxy spread ≈ +7%) with compensation logic: AWD traction and high grip cost power; low grip / drag / mass buy it back. Classes are **natures**, not tiers:

| Car | Class | Drive | Mass | Power | Torque | Grip | Character |
|---|---|---|---|---|---|---|---|
| Trueno AE86 | DRIFT | RWD | 970 | 168 | 190 | 0.86 | throttle-steer, big slip angles |
| Roadster MX-5 | BALANCED | RWD | 1020 | 175 | 205 | 0.88 | tossable |
| Civic Type R EK9 | BALANCED | FWD | 1050 | 182 | 185 | 0.87 | forgiving, revvy |
| GTI Mk7 | TURBO | FWD | 1320 | 232 | 340 | 0.88 | wet weapon |
| Mustang Foxbody | MUSCLE | RWD | 1420 | 258 | 420 | 0.84 | straights vs loose rear |
| M3 E30 | BALANCED | RWD | 1200 | 205 | 235 | 0.90 | delicate balance |
| WRX STI | RALLY | AWD | 1450 | 238 | 350 | 0.92 | any surface |
| Evo IX | RALLY | AWD | 1420 | 235 | 360 | 0.93 | corner-exit traction |
| GT-R R34 | TURBO | AWD | 1560 | 262 | 380 | 0.92 | heavy, boosty, planted |
| Supra MK4 | SPEED | RWD | 1550 | 272 | 420 | 0.87 | top-speed king (~277 km/h) |
| NSX Type-R | GRIP | RWD | 1270 | 212 | 260 | 0.96 | corner-speed scalpel |
| F40 | SPEED | RWD | 1250 | 226 | 320 | 0.89 | light, committed |
| Carrera GT | GRIP | RWD | 1380 | 240 | 330 | 0.94 | precise |
| Aventador SV | GRIP | AWD | 1525 | 258 | 400 | 0.95 | planted bruiser |

Stock top speeds (power-capped, drag-limited): ~227 (AE86) → ~277 km/h (Supra/R34).

---

## 3. LOADOUT (9 slots, all free — sidegrades by design)

- **Engine** — multipliers only, no flat minimums: vtec 1.10p/0.92t/8800rpm · rotary 1.12p/0.88t/9000/−25kg · v8 1.06p/1.35t/6400/+45kg · EV 1.04p/1.5t/12000/+120kg/single-speed (no overheat).
- **Induction** — the BOOST is the gain: NA +5% torque always-on (instant) · turbo boost 0.9, lag 0.9s, nothing before spool · twin 1.03t + boost 1.25, lag 1.3s · super 1.02t + instant 0.7 boost, +20kg. Boost also raises the power cap.
- **Tires** (surface-pick): street 1/1/1 · sport 1.07/0.92/0.90 · slick 1.16/0.68/0.72 · rally 0.96/1.0/1.35 · drift (rear −10%, assist ×0.55).
- **Suspension / Diff / Gearbox / Brakes / Weight / Aero** — unchanged trade-off structure; brakes now REAL (see §4).
- Garage BUILD STATS bars recalibrated (POWER 340, TOP SPD 320, HANDLING 122); MASS marked lower-is-better; aero counts in HANDLING.

---

## 4. PHYSICS — key systems (Physics.ts)

1. **Power is real**: drive force capped by `P·boost·0.9 / v` — hp governs top-end, torque governs grunt; garage stats match the sim.
2. **Longitudinal-priority friction ellipse**: drive/brake keeps ≤90% of grip budget, lateral gets the rest (≥44%) — you can always accelerate while steering (W+A works); limit behavior is mild understeer.
3. **Reverse is physically correct**: front slip = `atan2(lat, |v|) − sign(vx)·δ` (wheel-frame derivation); assist cap re-centered via same sign. Reversing steers toward the pressed key's side on screen.
4. **Steering**: maxSteer 0.56, speed-lock floor 0.38, rates 15/18/20 (input smoothing dt·24 in App); steering-limit assist caps δ near the front grip peak (base 0.40, floor 0.17; widens with drift parts/handbrake). `steerVisual` = capped δ, drives wheel meshes.
5. **Stability assist**: pulls yawRate toward grip-clamped neutral (3.5 × assistMult, floor 0.4 mid-slide, ×0.2 handbrake); yawRate clamp 2.6 rad/s, vz clamp 22 m/s, damping 1.1. Drift lives via handbrake + drift parts.
6. **Brakes real**: base 8200 N (just under grip for stock) — upgrades and per-car brake stat genuinely shorten stops.
7. **Collision damage uses NORMAL closing speed** (wall grinding is harmless); `resolveCarPair` = mass-weighted two-body car-to-car (player↔AI, AI↔AI); traffic is solid for the player.
8. Grip: `baseGrip × surface × tires × 1.2`; rear ×1.13. Surfaces: dry 1.0 / wet 0.70 / gravel 0.66 / grass 0.54 / sand 0.50 / snow 0.35 / ice 0.14.
9. Hard rev-limiter (wheel-implied rpm), turbo spool, load transfer, tyre temp/wear, thermal damage (ICE only).

---

## 5. TRACKS — 10 (all spline-validated: no self-intersection, straight spawns, grid rows aligned)

| Track | Theme | Type | Notes |
|---|---|---|---|
| Harbour GP | harbour | circuit 2.0km | chicane, hairpin, esses |
| Akina Pass | mountain | sprint 1.7km | −126m descent, drop-off respawn |
| Bay Bridge | coast | sprint 3.7km | over the SEA, live solid traffic |
| Airport ¼-mile | airport | drag 0.7km | no AI |
| Redwood Rally | forest | circuit 1.5km | dirt, leaf-litter ground |
| Downtown Night | city | circuit 1.8km | walls flush with physics margin |
| **Desert Canyon Run** | desert | circuit 2.3km | climbing ess, canyon run, cacti |
| **Sunset Speedway** | airport | oval 1.4km | flat-out, seam validated (84m min radius) |
| **Riviera Seaside** | coast | circuit 1.6km | clifftop over water |
| Alpine Ring | mountain | circuit 1.3km | meadow + rock-cliff skirts |

Surface query: 1.1m curb band, 6m gravel/sand apron, grass beyond. WALL_MARGIN by theme (city 2.4 … airport 10); mountain = drop-off respawn.

---

## 6. AI

Braking-aware speed profile (pace capped AT grip limit — skill ⇒ line quality, not superhuman corners); capped lookahead; boundary-awareness steer-back near edges; off-road slow-to-15 recovery; strengthened soft rail; TC on both rears; **AI-AI + player avoidance** (nearest-ahead swerve + lift <6.5m); avoidance swerve sign verified (was aiming AT the player); **full car pool at every difficulty** (equal cars — skill is the difficulty); lineOffset × (1.6−skill); per-personality loadouts; elevation-follow (was: underground cars); stuck/wrong-way recovery.

---

## 7. GRAPHICS

- **Terrain**: backdrop plane at track minimum + elevation-following **skirt** (SKIRT_OFFS/TS rings) on tracks with >1.5m relief — roads no longer float/bury. Scenery sits on skirt heights.
- **Per-theme PixelLab grounds**: meadow+rock cliffs (mountain), leaf litter (forest), pavement (city), concrete (airport), sand (desert), grass (harbour/coast), **sea** under coastal elevated tracks, **snow** everywhere in snowy weather. Road: brightened asphalt (dirt on forest), UV-mapped 8m/repeat.
- **Road markings**: white edge lines (DoubleSide!) + centre dashes pitched along the 3D tangent.
- **Cars in-race**: box model + **PixelLab bodywork panels** (door/window sides ×3 repeat, vented hood, headlight grille, taillight rear) — white-base, tinted by paint, on every car. Front wheels render the assist-capped angle.
- Menu: 14 **pixel car sprites** (front-view, 128px, `public/cars/<id>.png`) in showroom/preview/garage; synthwave **marquee** header.
- Effects: skids, smoke/dust, backfire, precip, day/night + weather, sun/moon, headlights; 3 cameras, speed-FOV, shake. `dispose()` frees geometry/materials/textures + forces context loss (no WebGL leak).

## 8. UI / CONTROLS

Menu: RACE (track cards + thumbnails, weather, laps/rivals/AI level) · CARS (sprite grid) · GARAGE (3-panel loadout + STYLE) · **HOW TO PLAY** panel with full controls. HUD: standings tower, LED tacho (loadout-resolved redline), boost bar (normalized), tyre grid, damage, drift popup, minimap (matches 3D chirality). Pause: resume/restart/respawn/quit + controls.

Keys: `W` throttle · `S` brake / reverse-throttle · `A/D` steer (visually correct; reverse arcs toward pressed side) · `Space` handbrake · `E/F` gears · `Shift` clutch · `R` reverse (≤15 km/h) · `C` camera · `X` respawn · `Esc` pause.

---

## 9. KNOWN LIMITATIONS / NEXT

- Replay records, no playback UI. Variable timestep (no fixed accumulator). No career/multiplayer.
- AI take no wall damage; AI-AI contact has no sound/FX for distant pairs.
- Minor (verifier-flagged, non-blocking): AI dead-ahead swerve sign can flicker briefly; reverse slide can technically score drift; explicit-Euler jitter possible on 50ms hitch frames.
- Feel constants pending on-wheel confirmation: ellipse priority split (0.9), steer rates, drift assist floor, brake base 8200.
- PixelLab budget ~4.1k generations — candidates for: billboards/banners, alternate car panels (12 spares reviewed), snow/rain road variants.

## 10. DEV / VERIFY

`npm run dev` (port 5173, `.claude/launch.json`), `npx tsc -b --noEmit`, `npx oxlint`, `npm run build`. Dev globals (`__dbg/__track/__finish`) behind `import.meta.env.DEV`. **Sandbox note:** the in-app preview tab is backgrounded → rAF paused → can't drive/screenshot there; verify via build + DOM + network + `__dbg` (see `memory/sandbox-preview-raf-paused.md`). Track-geometry validator: `scratchpad/validate_tracks.mjs` pattern (spline mirror + clearance/radius/grid checks).

---

## ADDENDUM (2026-07-19, later session)

- **Steering ~2×** (rates 26/30/32, smoothing dt·42, wider grip-cap, more lock at speed); drift further reduced; more grip/power for arcade pace.
- **Per-car 3D models** — `CAR_PROFILES` in `Graphics.ts` gives each of the 14 cars a distinct silhouette (coupe/hatch/sedan/roadster/wedge/muscle: length/width/ride/wheels/wing), tinted by paint. Player + AI. PixelLab remains 2D (sprites/panels/textures).
- **Grounding** — shared `World.groundHeight()` used by mesh + car + AI + scenery: car sits ON the surface (no float on hills, no sink into flat-track ground plane). y-follow at `groundHeight + 0.05`.
- **Scenery** placed beyond `wallMargin(theme)` + object half-footprint (no driving through trees/rocks/buildings). **Guardrails** (red/white Armco) mark the invisible wall on every non-city track.
- **11 tracks** — added flagship **Apex Grand Prix** (`apex`, harbour theme, 2.49 km, validated), ★ FLAGSHIP badge in menu.
- **7 difficulty tiers** — `DIFFICULTIES` in GameContext (novice 0.48 … legend 1.0; payout 0.70…1.75); `difficultySkill`/`difficultyPayout` helpers; AI gained baseline sloppiness `(1-skill)^2·0.55·dt` so low tiers are beatable.
- **Driveline consequences** — clutchless H-pattern shifts grind/baulk + wear; money-shift (early downshift) over-revs & damages; lugging strains the engine. Events `state.missedShift`/`overRev` → toast+crunch in App.
- **Balance** (adversarially audited): 14 cars balanced (hp/kg 0.164–0.182, each owns a niche); attachments all have a usecase after giving gearboxes mass (DCT +20 kg, auto +14, manual −8) so the sequential isn't dominated by the DCT.

## ADDENDUM 2 (2026-07-19, launch build)

- **Car never tilts** — mesh is yaw-only (`rotation.set(0,yaw,0)`); no visual pitch/roll.
- **Grounding solid** — shared `groundHeight` continuous at the road edge (relief base=nodeY), smooth interpolated `roadHeightAt`, fast follow. No sink/float in any weather or elevation.
- **Steering +60% again** (rates 40/46/50, maxSteer 0.76, slipCap base 0.68) — verified stable/catchable by review. **Arcade juice**: powerCap 1.15, muBase 1.32, speed-FOV to +34°, high-speed shake, denser + wheelspin smoke.
- **8 difficulty tiers** incl. **Impossible** (skill 1.12, flawless); all tiers ~30-40% harder (aLat 9.6 / aBrake 8.6, paceMult→1.08 cap, capMs 32+36·skill, tighter apex, fewer/zero mistakes). **9 rivals** option (10-car field, standings show all).
- **13 tracks** — added **Titan Ridge** (mountain, 2.3 km, summit esses, plunging descent, 19 m hairpin, validated). Grandstands at start/finish on closed non-city circuits.
- **Physics realism** — weight-transfer accels low-passed; clutch gated to the H-pattern box; money-shift over-rev only on manual/sequential (DCT/auto rev-match); respawn/blow-off state reset.
- Adversarially verified: every map works with every car in every weather; difficulty monotonic & grip-safe; no launch-blocking defects. `tsc`/lint/build clean.

## ADDENDUM 3 (2026-07-20)

- **LAP COUNTER + WINNER FIXED** — the old 6-sector gate never counted laps (the sector-advance stole the sector-0 event before the lap-complete check), so closed races never finished. Replaced with a forward line-crossing detector (prevIdx>N·0.75 && idx<N·0.25), unified for player+AI; lap baseline 0, finish at lap>config.laps; progress = lap·N+idx. Proven headlessly + adversarially verified.
- **Randomized grid** — `gridSpawn()` staggered slots; the player takes a random slot mixed among the rivals (no longer always pole).
- **AI 2× harder** — aLat 11.2 / aBrake 10.0 (near real grip), pace/cap up, mistakes halved, skills 0.80(novice)…1.32(impossible). Grip-safe (verified), still winnable at lower tiers.
- **Power-matched opponents** — rivals drawn from the cars closest in power to the player's (AE86 168hp → 168–226hp field; Supra 272 → 238–272), no more 168-vs-272.
- **Damage consequences symmetric** — removed the steer-pull/puncture (car veered); damage now cuts power (−50%), grip (−20%), brakes (−25%), misfires >50%, and smokes — all both-sides-equal, car stays straight.
- **Drift** reduced a further 15% (vz clamp 13.6, yawRate 1.75).
- **Snow shimmer** fixed via 16× anisotropic + trilinear ground filtering.
