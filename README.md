# 🏁 Pixel Drift

An open-world-style **arcade racing simulator** with a pixel-art / low-poly identity, believable
driving physics, and AI that races tactically rather than following scripts. Built with
**React 19 + TypeScript + Vite + Three.js**. Offline-first, runs in any modern browser.

> Design north star: *Forza Horizon meets Art of Rally meets Trackmania* — **easy to play, hard to master.**

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build to dist/
npm run lint     # oxlint
```

## Controls

| Action | Keys |
| --- | --- |
| Throttle | `W` |
| Brake — or reverse throttle when in Reverse gear | `S` |
| Steer | `A` / `D` |
| Handbrake (drift) | `Space` |
| Gear up / down (manual boxes) | `E` / `F` |
| Clutch (hold for fast manual shifts) | `Shift` |
| Toggle Reverse gear | `R` |
| Cycle camera (chase / hood / drone) | `C` |
| Respawn on track | `X` |
| Pause menu | `Esc` |

## What's in the game

- **Driving model** — load-sensitive bicycle model with a simplified Pacejka tyre and a **friction
  ellipse** (accelerating trades away cornering grip), per-wheel load transfer, suspension
  compression, tyre temperature & wear, turbo spool, torque curves, auto/sequential/dual-clutch
  gearboxes, and drivetrain-specific behaviour (FWD/RWD/AWD). An arcade **stability assist** keeps
  it forgiving but fades under handbrake so deliberate drifts still work.
- **14 cars** across classes D → Hyper, each with distinct mass, power, torque curve, grip,
  gearing and drivetrain character.
- **6 tracks** — Harbour GP circuit, Akina mountain touge, Bay Bridge coastal sprint (with live
  traffic), Airport drag strip, Redwood rally stage (dirt), Downtown night circuit.
- **Tactical AI** — 5 personalities (pro / aggressive / defensive / drifter / rookie), curvature-based
  corner speeds, racing-line variation, overtaking/defending lines, and mistakes under player pressure.
  Difficulty scales the grid's skill *and* their car tuning.
- **Weather & time of day** — sunny / rain / snow / fog / night, each affecting grip, visibility and
  lighting, plus a rolling day cycle with sun/moon and automatic headlights.
- **Presentation** — pixelated post-render, skid marks, tyre smoke & dirt, curbs, checkered
  start/finish line, speed-based FOV, cornering camera shake, drift scoring, 3-2-1 countdown.
- **Loadout garage (everything free)** — Call-of-Duty-style attachment slots instead of linear
  upgrades: Engine, Induction, Tires, Suspension, Differential, Gearbox, Brakes, Weight and Aero.
  Every part lists pros AND cons and genuinely changes the physics (slicks melt in rain, a locked
  diff rotates on throttle, a big wing costs top speed…). Live build-stat preview with deltas.
  Style with paint / neon / plates. Reputation + XP earned from racing. Saved to `localStorage`.

## Project layout

```
src/
  game/
    Physics.ts    vehicle dynamics, tyres, drivetrain, collision
    Graphics.ts   Three.js scene, car meshes, effects, camera
    AI.ts         opponent racers (personalities, racing lines, mistakes)
    Traffic.ts    civilian traffic (freeway)
    World.ts      track splines, surface queries, track definitions
    Sound.ts      procedural Web Audio engine (engine/turbo/tyres/backfire/shift)
    Replay.ts     race recording
  components/     MainMenu, Garage, HUD
  context/        GameContext (cars, stats, economy, save/load)
  App.tsx         race loop, countdown, laps, positions, cameras
```
