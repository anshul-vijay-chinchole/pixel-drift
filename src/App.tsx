import React, { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import { useGame, CarDefinition, RaceConfig, CarLoadout, getLoadout, DEFAULT_LOADOUT, difficultyPayout } from './context/GameContext';
import { MainMenu } from './components/MainMenu';
import { Garage } from './components/Garage';
import { HUD, StandingEntry } from './components/HUD';
import { initVehicleState, updateVehicle, resolveCollision, resolveCarPair, resolveLoadout, VehicleState } from './game/Physics';
import { TrackBuilder, TrackPoint, TRACKS, wallMargin, terrainInfo, groundHeight, roadHeightAt } from './game/World';
import { GameGraphics, CameraMode } from './game/Graphics';
import { AIEngine, OpponentRacer, gridSpawn } from './game/AI';
import { TrafficEngine, TrafficVehicle } from './game/Traffic';
import { ReplaySystem } from './game/Replay';
import { sound } from './game/Sound';
import confetti from 'canvas-confetti';
import { Trophy, CheckCircle, Play, RotateCcw, MapPin, LogOut, Gauge } from 'lucide-react';

type Screen = 'menu' | 'garage' | 'race' | 'summary';
type Phase = 'countdown' | 'racing' | 'paused' | 'finished';

const CAM_MODES: CameraMode[] = ['chase', 'hood', 'drone'];

export const App: React.FC = () => {
  const { stats, cars, activeRace, exitRace, setSteerSensitivity } = useGame();

  const [screen, setScreen] = useState<Screen>('menu');
  const [summary, setSummary] = useState<{ credits: number; xp: number; place: number; total: number; time: number; best: number; drift: number } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const gfxRef = useRef<GameGraphics | null>(null);
  const rafRef = useRef<number>(0);
  const restartTimeoutRef = useRef<number | null>(null); // doRestart's pending launchRace(), so doExit can cancel it

  const playerRef = useRef<VehicleState | null>(null);
  const oppsRef = useRef<OpponentRacer[]>([]);
  const trafficRef = useRef<TrafficVehicle[]>([]);
  const tpRef = useRef<TrackPoint[]>([]);
  const terrRef = useRef<{ backdropY: number; hasRelief: boolean }>({ backdropY: -0.15, hasRelief: false });
  const cfgRef = useRef<RaceConfig | null>(null);
  const carDefRef = useRef<CarDefinition | null>(null);
  const loadoutRef = useRef<CarLoadout>(DEFAULT_LOADOUT);
  const keys = useRef<Record<string, boolean>>({});
  const steerRef = useRef(0);
  const pendingShiftRef = useRef({ up: false, down: false });

  // race phase
  const phaseRef = useRef<Phase>('countdown');
  const [phase, setPhase] = useState<Phase>('countdown');
  const resumePhaseRef = useRef<Phase>('countdown');
  const countdownRef = useRef(3.0);
  const raceTimeRef = useRef(0);
  const lapTimeRef = useRef(0);
  const bestLapRef = useRef(Infinity);
  const lapRef = useRef(1);
  const passedHalfRef = useRef(true); // must reach mid-track between line crossings (blocks on-line jitter)
  const idxRef = useRef(0);
  const needSectorRef = useRef(1);
  const lastAiIdx = useRef<Record<string, number>>({});
  const aiPassedHalf = useRef<Record<string, boolean>>({}); // per-AI half-lap guard (mirrors passedHalfRef)
  const posRef = useRef(1);
  const camModeRef = useRef<CameraMode>('chase');
  const hudTick = useRef(0);
  const loopIdRef = useRef(0);
  const lastGearRef = useRef(1);
  const lastBoostRef = useRef(0);
  const mutedRef = useRef(false);
  const redlineRef = useRef(8000);   // loadout-resolved redline (engine swaps change it)
  const boostMaxRef = useRef(0);     // loadout-resolved boost ceiling (for the HUD bar)
  const sensRef = useRef(stats.steerSensitivity); // mirrored for the tick loop (refs, not state)
  useEffect(() => { sensRef.current = stats.steerSensitivity; }, [stats.steerSensitivity]);

  // HUD state
  const [playerHUD, setPlayerHUD] = useState<VehicleState | null>(null);
  const [standings, setStandings] = useState<StandingEntry[]>([]);
  const [pos, setPos] = useState(1);
  const [lap, setLap] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [best, setBest] = useState(Infinity);
  const [muted, setMuted] = useState(false);
  const [camMode, setCamMode] = useState<CameraMode>('chase');
  const [countdown, setCountdown] = useState(3);
  const [toast, setToast] = useState<string | null>(null);

  const replayRef = useRef(new ReplaySystem());

  const setPhaseBoth = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(t => (t === msg ? null : t)), 1600);
  };

  /* ------------------------------- INPUT ---------------------------------- */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      keys.current[k] = true;
      if (screen !== 'race') return;

      if (k === 'escape') { togglePause(); return; }
      if (e.repeat) return;
      if (k === 'e') pendingShiftRef.current.up = true;
      if (k === 'f') pendingShiftRef.current.down = true;
      if (k === 'r') toggleReverse();
      if (k === 'c') cycleCam();
      if (k === 'x') respawn();
    };
    const up = (e: KeyboardEvent) => { keys.current[e.key.toLowerCase()] = false; };
    const blur = () => { keys.current = {}; }; // fix: keys stuck when window loses focus
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  useEffect(() => {
    if (activeRace) {
      setScreen('race');
      setPlayerHUD(null); // clear any prior race's HUD during the 60ms pre-launch gap
      sound.init();
      // Defer until the canvas container is laid out & visible. setTimeout is
      // used (not rAF) so the race still initialises in a background tab.
      const t = window.setTimeout(() => launchRace(activeRace), 60);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRace]);

  /* ------------------------------- LAUNCH --------------------------------- */
  const launchRace = useCallback((config: RaceConfig) => {
    if (!containerRef.current) return;
    cancelAnimationFrame(rafRef.current);
    if (gfxRef.current) { gfxRef.current.dispose(); gfxRef.current = null; }
    const myLoopId = ++loopIdRef.current;

    const carDef = cars.find(c => c.id === stats.activeCarId) || cars[0];
    const loadout = getLoadout(stats, carDef.id);
    cfgRef.current = config; carDefRef.current = carDef; loadoutRef.current = loadout;
    const resolved = resolveLoadout(carDef, loadout);
    redlineRef.current = resolved.redline;   // e.g. EV 12000, V8 6400 — not the base spec
    boostMaxRef.current = resolved.boostMax;
    keys.current = {};
    pendingShiftRef.current = { up: false, down: false };

    const trackDef = TRACKS[config.trackId];
    const tp = TrackBuilder.buildSplineTrack(trackDef.points, trackDef.width, trackDef.isClosed);
    TrackBuilder.assignBiomes(tp, trackDef.biomes); // tag per-section biome/dirt for scenery + surface
    tpRef.current = tp;
    terrRef.current = terrainInfo(tp);
    if (import.meta.env.DEV) (window as any).__track = tp.map(pt => ({ x: pt.pos.x, z: pt.pos.z, tx: pt.tangent.x, tz: pt.tangent.z, w: pt.width }));

    // Randomised starting grid — the player is mixed into the pack at a random
    // slot alongside the rivals (not always on pole).
    const oppCount = (config.opponentsCount > 0 && config.trackId !== 'drag') ? config.opponentsCount : 0;
    const slots = Array.from({ length: oppCount + 1 }, (_, i) => i).sort(() => Math.random() - 0.5);
    const pg = gridSpawn(tp, trackDef.isClosed, slots[0]);

    const pState = initVehicleState(carDef);
    pState.x = pg.x; pState.z = pg.z; pState.y = pg.y;
    pState.yaw = pg.yaw;
    pState.activeGear = 1;
    playerRef.current = pState;
    lastGearRef.current = 1;
    lastBoostRef.current = 0; // avoid a spurious blow-off "pshhh" on the next race's countdown

    sound.clearOpponents(); // drop any pooled voices from a previous race before spawning this one's
    oppsRef.current = oppCount > 0
      ? AIEngine.spawnOpponents(oppCount, tp, cars, config.difficulty, trackDef.isClosed, slots.slice(1), carDef.specs.power, config.weather) : [];
    lastAiIdx.current = {};
    aiPassedHalf.current = {};
    oppsRef.current.forEach(o => { lastAiIdx.current[o.id] = o.currentTrackIndex; aiPassedHalf.current[o.id] = true; });

    trafficRef.current = config.trackId === 'highway' ? TrafficEngine.spawnTraffic(12, tp) : [];

    const container = containerRef.current;
    container.innerHTML = '';
    const gfx = new GameGraphics(container, 0.6);
    gfxRef.current = gfx;
    if (import.meta.env.DEV) (window as any).__gfx = gfx;
    gfx.buildTrackGraphics(trackDef, tp, config.weather);
    gfx.buildCarGraphics(loadout, carDef.id);
    gfx.resetCamera();
    gfx.timeOfDay = config.weather === 'night' ? 22 : config.trackId === 'city' ? 21 : config.weather === 'foggy' ? 8 : 13;

    setPhaseBoth('countdown');
    countdownRef.current = 3.0;
    raceTimeRef.current = 0; lapTimeRef.current = 0; bestLapRef.current = Infinity;
    lapRef.current = 0; passedHalfRef.current = true; idxRef.current = pg.nodeIdx; needSectorRef.current = 1; posRef.current = 1;
    steerRef.current = 0;
    camModeRef.current = 'chase'; setCamMode('chase');
    setLap(1); setElapsed(0); setBest(Infinity); setPos(1); setCountdown(3);
    setSummary(null);
    setStandings([]);
    setPlayerHUD(null); // hide last race's HUD until the first fresh tick populates it
    replayRef.current.startRecording();
    sound.setMute(mutedRef.current); // fix: audio stayed muted after quitting a race

    let lastT = performance.now();
    let errCount = 0;
    const loop = (now: number) => {
      if (loopIdRef.current !== myLoopId || phaseRef.current === 'finished') return;
      const dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;
      // A thrown error inside tick() must NOT break the rAF chain, or the game
      // freezes ("randomly stops"). Swallow per-frame errors and keep looping.
      try {
        if (phaseRef.current !== 'paused') tick(dt);
      } catch (err) {
        if (errCount++ < 5) console.error('[race loop] frame error (continuing):', err);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    if (import.meta.env.DEV) (window as any).__finish = () => finishRace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cars, stats]);

  /* -------------------------------- TICK ---------------------------------- */
  const tick = (dt: number) => {
    const p = playerRef.current, gfx = gfxRef.current, config = cfgRef.current, carDef = carDefRef.current, tp = tpRef.current;
    const loadout = loadoutRef.current;
    if (!p || !gfx || !config || !carDef || tp.length === 0) return;
    const trackDef = TRACKS[config.trackId];
    const isWet = config.weather === 'rainy' || config.weather === 'snowy';

    if (phaseRef.current === 'countdown') {
      countdownRef.current -= dt;
      setCountdown(Math.max(1, Math.ceil(countdownRef.current)));
      if (countdownRef.current <= 0) { setPhaseBoth('racing'); showToast('GO!'); }
    }
    const racing = phaseRef.current === 'racing';

    // ---- input (new scheme) ----
    const k = keys.current;
    const inReverse = p.activeGear === -1;
    let throttle = 0, brake = 0;
    if (racing) {
      const wHeld = !!(k['w'] || k['arrowup']);
      const sHeld = !!(k['s'] || k['arrowdown']);
      if (inReverse) { throttle = sHeld ? 1 : 0; brake = wHeld ? 1 : 0; } // S drives backward in reverse
      else { throttle = wHeld ? 1 : 0; brake = sHeld ? 1 : 0; }
    }
    // Steering sign: physics +steering yaws the car toward world (cos yaw, -sin yaw),
    // which the three.js chase/hood cameras render on the viewer's LEFT (a camera
    // looking along +Z has world -X on its right). So A/Left maps to +1 and D/Right
    // to -1 — the naive mapping steered visually inverted.
    const steerTarget = !racing ? 0 : (k['a'] || k['arrowleft'] ? 1 : 0) + (k['d'] || k['arrowright'] ? -1 : 0);
    steerRef.current += (steerTarget - steerRef.current) * Math.min(1, dt * 64);
    const handbrake = racing && !!k[' '];
    const clutch = racing && !!k['shift'];
    const su = pendingShiftRef.current.up, sd = pendingShiftRef.current.down;
    pendingShiftRef.current.up = false; pendingShiftRef.current.down = false;

    const manualBox = loadout.gearbox !== 'auto' && loadout.engine !== 'electric';
    const inputs = {
      throttle, brake, steering: steerRef.current, handbrake, clutch,
      shiftUp: racing && su, shiftDown: racing && sd,
      manualGearbox: manualBox
    };

    // ---- surface + boundary ----
    const sq = TrackBuilder.querySurface(p.x, p.z, tp, isWet, config.trackId, idxRef.current);
    const seg = tp[sq.segmentIndex];
    const margin = wallMargin(trackDef.theme);
    const limit = seg.width / 2 + margin;
    if (sq.distToCenter > limit) {
      const nx = -Math.sign(sq.signedLateral) * seg.normal.x;
      const nz = -Math.sign(sq.signedLateral) * seg.normal.z;
      if (trackDef.theme === 'mountain' && sq.distToCenter > limit + 6) {
        respawn();
      } else {
        const over = sq.distToCenter - limit;
        p.x += nx * over; p.z += nz * over;
        // Impact = closing speed ALONG the wall normal, not total speed —
        // using total speed dealt (v-6)*0.02 damage EVERY FRAME while grinding
        // a wall at speed, melting the car to 100% in seconds.
        const ws = Math.sin(p.yaw), wc = Math.cos(p.yaw);
        const wvx = p.vx * ws + p.vz * wc, wvz = p.vx * wc - p.vz * ws;
        const impact = Math.max(0, -(wvx * nx + wvz * nz));
        resolveCollision(p, nx, nz, impact, trackDef.theme === 'city' ? 0.25 : 0.4);
        if (impact > 9) { gfx.triggerBackfirePop(); sound.triggerBackfire(); }
      }
    }

    // ---- physics ----
    updateVehicle(p, dt, inputs, sq.surface, carDef, loadout, 1, sensRef.current);
    // Follow the exact terrain the mesh draws, using the SMOOTH interpolated road
    // height (not the nearest node) + a fast follow rate, so the car sits ON the
    // surface with no float on descents and no sink into climbs ("under the snow").
    const roadY = roadHeightAt(tp, sq.segmentIndex, p.x, p.z);
    const gh = groundHeight(roadY, sq.distToCenter - seg.width / 2, terrRef.current.backdropY, terrRef.current.hasRelief);
    p.y += (gh + 0.05 - p.y) * Math.min(1, dt * 22);

    // ---- AI (frozen until the green) ----
    oppsRef.current.forEach(o => {
      if (racing) {
        AIEngine.updateAI(o, dt, tp, p, oppsRef.current, config.difficulty, isWet, config.trackId, trackDef.isClosed, terrRef.current);
        const li = lastAiIdx.current[o.id] ?? o.currentTrackIndex;
        const aN = tp.length;
        // Same forward-crossing + half-lap guard as the player, so a wrong-way or
        // stuck-recovery jitter across the start line can't double-count an AI lap.
        if (trackDef.isClosed) {
          if (o.currentTrackIndex > aN * 0.45 && o.currentTrackIndex < aN * 0.55) aiPassedHalf.current[o.id] = true;
          if (aiPassedHalf.current[o.id] && li > aN * 0.75 && o.currentTrackIndex < aN * 0.25) {
            aiPassedHalf.current[o.id] = false;
            o.lap++;
          }
        }
        lastAiIdx.current[o.id] = o.currentTrackIndex;
        o.progress = trackDef.isClosed ? o.lap * aN + o.currentTrackIndex : o.currentTrackIndex;
      }
    });

    // ---- car-to-car collisions (player + all opponents, every pair) ----
    if (racing && oppsRef.current.length) {
      const bodies: { s: VehicleState; m: number }[] = [
        { s: p, m: carDef.specs.mass },
        ...oppsRef.current.map(o => ({ s: o.state, m: o.carDef.specs.mass }))
      ];
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const impact = resolveCarPair(bodies[i].s, bodies[j].s, bodies[i].m, bodies[j].m);
          if (impact > 7 && (i === 0 || j === 0)) { gfx.triggerBackfirePop(); sound.triggerBackfire(); }
        }
      }
    }

    // Position AI meshes after collisions so contact shows the same frame.
    oppsRef.current.forEach(o => gfx.updateAICar(o.id, o.state.x, o.state.y, o.state.z, o.state.yaw, o.color, o.carDef.id));

    // ---- traffic ----
    if (trafficRef.current.length) {
      if (racing) {
        TrafficEngine.updateTraffic(trafficRef.current, dt, tp, p.x, p.z);
        // Solid contact against traffic — applied to the player AND every
        // opponent. Previously only the player collided, so AI drove straight
        // through highway traffic with no slowdown, a physically-inconsistent
        // free advantage on the one track that has traffic.
        const collideWithTraffic = (v: VehicleState, isPlayer: boolean) => {
          for (const tcar of trafficRef.current) {
            const dx = v.x - tcar.x, dz = v.z - tcar.z;
            const d = Math.hypot(dx, dz);
            const R = tcar.kind === 'truck' ? 3.2 : 2.6;
            if (d < R && d > 1e-3) {
              const nx = dx / d, nz = dz / d;
              v.x += nx * (R - d); v.z += nz * (R - d);
              // Normal closing speed only (same reasoning as the wall fix above).
              const ws = Math.sin(v.yaw), wc = Math.cos(v.yaw);
              const wvx = v.vx * ws + v.vz * wc, wvz = v.vx * wc - v.vz * ws;
              const impact = Math.max(0, -(wvx * nx + wvz * nz));
              resolveCollision(v, nx, nz, impact, 0.3);
              if (isPlayer && impact > 8) { gfx.triggerBackfirePop(); sound.triggerBackfire(); }
            }
          }
        };
        collideWithTraffic(p, true);
        oppsRef.current.forEach(o => collideWithTraffic(o.state, false));
      }
      trafficRef.current.forEach(t => gfx.updateAICar(t.id, t.x, t.y, t.z, t.yaw, t.color));
    }

    // ---- sound ----
    const slip = Math.abs(p.wheels.rl.slipAngle) + Math.abs(p.wheels.rl.slipRatio);
    sound.update(p.engineRpm, redlineRef.current, Math.max(throttle, clutch ? throttle : 0), p.turboBoost, slip, loadout.engine === 'electric');
    if (p.activeGear !== lastGearRef.current) {
      if (p.activeGear >= 1 || p.activeGear === -1) sound.triggerShift();
      lastGearRef.current = p.activeGear;
    }
    if (lastBoostRef.current > 0.35 && p.turboBoost < 0.1 && throttle < 0.1) sound.triggerBlowOffValve();
    lastBoostRef.current = p.turboBoost;
    // Driveline misuse feedback (per-frame events set by the physics gearbox).
    if (p.missedShift) { sound.triggerBackfire(); showToast('⚙ GEARS GROUND — HOLD SHIFT (CLUTCH)'); }
    if (p.overRev > 0.08) { sound.triggerBackfire(); gfx.triggerBackfirePop(); showToast('💥 OVER-REV! ENGINE DAMAGED'); }
    // Opponent engine sounds — distance-attenuated background traffic noise.
    if (racing) {
      oppsRef.current.forEach(o => {
        const dist = Math.hypot(o.state.x - p.x, o.state.z - p.z);
        sound.updateOpponent(o.id, o.state.engineRpm, o.carDef.specs.redline, o.inputs.throttle, dist);
      });
    }

    // ---- timing / laps ----
    if (racing) { raceTimeRef.current += dt; lapTimeRef.current += dt; }
    const N = tp.length;
    const idx = sq.segmentIndex;
    const prevIdx = idxRef.current;
    idxRef.current = idx;

    if (racing) {
      if (trackDef.isClosed) {
        // Robust start/finish detection: a FORWARD line crossing is the node
        // index wrapping from the last quarter of the lap to the first quarter
        // (impossible to trigger going backwards, so it can't be cheesed).
        // lapRef starts at 0 on the grid; the first crossing (grid → line)
        // makes it 1 (= you're on lap 1). Completing lap `config.laps` finishes.
        // Guard: a crossing only counts once the car has reached mid-track since
        // the previous crossing. A car idling on the start line (idx oscillating
        // N-1 ↔ 0) never reaches the middle, so it can't inflate the lap count
        // and finish the race early.
        if (idx > N * 0.45 && idx < N * 0.55) passedHalfRef.current = true;
        if (passedHalfRef.current && prevIdx > N * 0.75 && idx < N * 0.25) {
          passedHalfRef.current = false;
          lapRef.current++;
          if (lapRef.current > 1 && lapTimeRef.current < bestLapRef.current) { bestLapRef.current = lapTimeRef.current; setBest(lapTimeRef.current); }
          lapTimeRef.current = 0;
          if (lapRef.current > config.laps) {
            // Recompute standings with the freshly-incremented lap so the final
            // finishing place is this frame's, not last frame's (stale-by-one).
            const fp = lapRef.current * N + idx;
            let pl = 1; oppsRef.current.forEach(o => { if (o.progress > fp) pl++; });
            posRef.current = pl;
            finishRace(); return;
          }
          setLap(lapRef.current);
          if (lapRef.current > 1) showToast(`LAP ${lapRef.current}/${config.laps}`);
        }
      } else if (idx >= N - 3) {
        // Recompute this frame's place before finishing (mirrors the closed-track
        // branch) so a photo-finish on a sprint reports the correct place/payout,
        // not last frame's stale standings.
        let pl = 1; oppsRef.current.forEach(o => { if (o.progress > idx) pl++; });
        posRef.current = pl;
        finishRace(); return;
      }
    }

    // ---- position + standings ---- (player and AI share the lap*N+idx baseline)
    const myProg = trackDef.isClosed ? lapRef.current * N + idx : idx;
    let place = 1;
    oppsRef.current.forEach(o => { if (o.progress > myProg) place++; });
    posRef.current = place;

    // ---- replay + render ----
    replayRef.current.recordFrame(dt, p, oppsRef.current);
    gfx.update(p, dt, camModeRef.current, config.weather, brake > 0.1, sq.surface);
    if (racing) gfx.timeOfDay += dt / 90;

    if (import.meta.env.DEV) (window as any).__dbg = { x: +p.x.toFixed(1), z: +p.z.toFixed(1), yaw: +p.yaw.toFixed(2), speed: p.speed, gear: p.activeGear, rpm: Math.round(p.engineRpm), pos: place, lap: lapRef.current, idx, drift: Math.floor(p.driftScore), state: phaseRef.current, opps: oppsRef.current.map(o => ({ id: o.id, spd: o.state.speed, prog: Math.round(o.progress), tgt: Math.round(o.targetSpeed * 3.6), thr: +o.inputs.throttle.toFixed(2), brk: +o.inputs.brake.toFixed(2), str: +o.inputs.steering.toFixed(2), gear: o.state.activeGear, rpm: Math.round(o.state.engineRpm), aidx: o.currentTrackIndex })) };

    // ---- HUD throttle ----
    hudTick.current += dt;
    if (hudTick.current > 0.08) {
      hudTick.current = 0;
      setPlayerHUD({ ...p });
      setElapsed(raceTimeRef.current);
      setPos(place);
      const nodeSpacing = (trackDef.length || 1) / tp.length;
      const rows = [
        { name: 'YOU', you: true, prog: myProg, color: '#00f5d4' },
        ...oppsRef.current.map(o => ({ name: o.name, you: false, prog: o.progress, color: o.color }))
      ].sort((a, b) => b.prog - a.prog);
      setStandings(rows.map((r, i) => ({
        name: r.name, you: r.you, color: r.color, place: i + 1,
        gap: i === 0 ? 0 : Math.max(0, Math.round((rows[0].prog - r.prog) * nodeSpacing))
      })));
    }
  };

  /* ------------------------------ ACTIONS --------------------------------- */
  const toggleReverse = () => {
    const p = playerRef.current;
    if (!p || phaseRef.current !== 'racing') return;
    if (p.speed > 15) { showToast('TOO FAST FOR REVERSE'); return; }
    if (p.activeGear === -1) { p.activeGear = 1; showToast('DRIVE'); }
    else { p.activeGear = -1; showToast('REVERSE'); }
    p.clutchTimer = 0.15;
  };

  const togglePause = () => {
    if (phaseRef.current === 'paused') {
      setPhaseBoth(resumePhaseRef.current);
      sound.setMute(mutedRef.current);
    } else if (phaseRef.current === 'racing' || phaseRef.current === 'countdown') {
      resumePhaseRef.current = phaseRef.current;
      setPhaseBoth('paused');
      sound.setMute(true);
    }
  };

  const respawn = () => {
    const p = playerRef.current, tp = tpRef.current;
    if (!p || tp.length === 0) return;
    if (phaseRef.current !== 'racing') return; // no respawn while paused / in countdown
    const idx = TrackBuilder.nearestIndex(p.x, p.z, tp, idxRef.current, tp.length);
    const node = tp[idx];
    p.x = node.pos.x; p.z = node.pos.z; p.y = node.pos.y + 0.05;
    p.yaw = Math.atan2(node.tangent.x, node.tangent.z);
    p.vx = Math.min(Math.abs(p.vx), 8); p.vz = 0; p.yawRate = 0; p.roll = 0; p.pitch = 0; p.axPrev = 0; p.ayPrev = 0;
    p.activeGear = Math.max(1, p.activeGear);
    p.wheels.fl.isPunctured = p.wheels.fr.isPunctured = p.wheels.rl.isPunctured = p.wheels.rr.isPunctured = false;
    p.steerPull = 0;
    showToast('RESPAWNED');
  };

  const finishRace = () => {
    const config = cfgRef.current!; const p = playerRef.current!;
    setPhaseBoth('finished');
    cancelAnimationFrame(rafRef.current);
    // The tick loop (and with it, every sound.update()/updateOpponent() call)
    // stops dead here — without muting, the engine/turbo/tire/opponent gain
    // nodes are frozen at their last-commanded (non-zero) volume and drone on
    // under the summary screen until the player clicks CONTINUE. doExit and
    // claimPayout already do this; finishRace (the normal, every-race end
    // path) was missing it — found by adversarial review.
    sound.setMute(true);
    sound.clearOpponents();
    replayRef.current.stopRecording();

    const place = posRef.current;
    const total = oppsRef.current.length + 1;
    const placeBonus = place === 1 ? 2.0 : place === 2 ? 1.5 : place === 3 ? 1.2 : place <= total / 2 ? 0.9 : 0.6;
    const base = config.trackId === 'metro' ? 4200 : config.trackId === 'drag' ? 1600 : 3000; // flagship pays more
    const drift = Math.floor(p.driftScore);
    const diffMult = difficultyPayout(config.difficulty);
    const credits = Math.floor((base * placeBonus + drift * 0.2) * diffMult);
    const xp = Math.floor(700 * placeBonus * diffMult);

    if (place === 1) confetti({ particleCount: 180, spread: 80, origin: { y: 0.6 } });
    setSummary({ credits, xp, place, total, time: raceTimeRef.current, best: bestLapRef.current, drift });
    setScreen('summary');
  };

  const claimPayout = () => {
    if (summary) exitRace({ credits: summary.credits, xp: summary.xp, driftScore: playerRef.current?.driftScore || 0 });
    else exitRace();
    gfxRef.current?.dispose(); gfxRef.current = null;
    sound.setMute(true);
    sound.clearOpponents();
    setScreen('menu');
  };

  const doExit = () => {
    // Cancel a pending doRestart() launch, if any — see the comment there for
    // the phantom-race scenario this prevents (Restart then Quit within the
    // 60ms gap).
    if (restartTimeoutRef.current !== null) { window.clearTimeout(restartTimeoutRef.current); restartTimeoutRef.current = null; }
    setPhaseBoth('finished');
    cancelAnimationFrame(rafRef.current);
    sound.setMute(true);
    sound.clearOpponents();
    exitRace();
    gfxRef.current?.dispose(); gfxRef.current = null;
    setScreen('menu');
  };

  const doRestart = () => {
    const cfg = cfgRef.current;
    if (!cfg) return;
    setPhaseBoth('finished'); // stops old loop
    setPlayerHUD(null); // hide the old race's HUD during the 60ms restart gap
    // Untracked before (found by adversarial review): Restart then Quit within
    // this 60ms window left the timeout firing AFTER doExit had already torn
    // down the race — since containerRef's div is only CSS-hidden, never
    // unmounted, launchRace's guard didn't stop it, so a full phantom race
    // (physics ticking, opponents spawned, audio unmuted) started running
    // invisibly behind the main menu. Tracking + cancelling it in doExit fixes
    // that race condition.
    if (restartTimeoutRef.current !== null) window.clearTimeout(restartTimeoutRef.current);
    restartTimeoutRef.current = window.setTimeout(() => { restartTimeoutRef.current = null; launchRace(cfg); }, 60);
  };

  const toggleMute = () => {
    const m = sound.toggleMute();
    mutedRef.current = m;
    setMuted(m);
  };
  const cycleCam = () => {
    const next = CAM_MODES[(CAM_MODES.indexOf(camModeRef.current) + 1) % CAM_MODES.length];
    camModeRef.current = next; setCamMode(next); gfxRef.current?.resetCamera(idxRef.current);
  };

  const fmt = (t: number) => {
    if (!isFinite(t)) return '--:--.--';
    const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 100);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const gearboxLabel = loadoutRef.current.engine === 'electric' ? 'EV'
    : loadoutRef.current.gearbox === 'auto' ? 'AUTO'
    : loadoutRef.current.gearbox === 'dct' ? 'DCT'
    : loadoutRef.current.gearbox === 'manual' ? 'MT' : 'SEQ';

  return (
    <div className="crt-effect" style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {screen === 'menu' && <MainMenu onOpenGarage={() => setScreen('garage')} />}
      {screen === 'garage' && <Garage onClose={() => setScreen('menu')} />}

      {screen === 'summary' && summary && (
        <div className="menu-container summary-overlay">
          <div className="card-glow summary-card" style={{ maxWidth: 520, margin: 'auto', textAlign: 'center', marginTop: '12vh' }}>
            <Trophy size={48} className="text-yellow" style={{ margin: '0 auto 12px', display: 'block' }} />
            <h2 className="title-glow">RACE FINISHED</h2>
            <h3 className={summary.place === 1 ? 'text-yellow' : 'text-cyan'} style={{ margin: '8px 0' }}>
              {summary.place === 1 ? '🏆 VICTORY' : `FINISHED P${summary.place}`} / {summary.total}
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '18px 0' }}>
              <div className="badge-item" style={{ justifyContent: 'center' }}>+{summary.credits.toLocaleString()} REP</div>
              <div className="badge-item" style={{ justifyContent: 'center' }}>+{summary.xp.toLocaleString()} XP</div>
            </div>
            <div style={{ fontFamily: 'Share Tech Mono', fontSize: '1rem', marginBottom: 6 }}>TOTAL TIME: <span className="text-cyan">{fmt(summary.time)}</span></div>
            <div style={{ fontFamily: 'Share Tech Mono', fontSize: '1rem', marginBottom: 6 }}>BEST LAP: <span className="text-cyan">{summary.best === Infinity ? 'N/A' : fmt(summary.best)}</span></div>
            {summary.drift > 0 && <div style={{ fontFamily: 'Share Tech Mono', marginBottom: 16 }}>DRIFT: <span className="text-yellow">{summary.drift.toLocaleString()} pts</span></div>}
            <button className="start-btn-glow" style={{ margin: 0, width: '100%' }} onClick={claimPayout}>CONTINUE <CheckCircle size={18} /></button>
          </div>
        </div>
      )}

      <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 10, display: screen === 'race' ? 'block' : 'none' }} />

      {screen === 'race' && phase === 'countdown' && (
        <div className="countdown-overlay"><span className="countdown-num">{countdown}</span></div>
      )}
      {screen === 'race' && toast && <div className="race-toast">{toast}</div>}

      {/* PAUSE MENU */}
      {screen === 'race' && phase === 'paused' && (
        <div className="pause-overlay">
          <div className="pause-card card-glow">
            <h2 className="title-glow">PAUSED</h2>
            <div className="pause-actions">
              <button className="pause-btn" onClick={togglePause}><Play size={18} /> RESUME</button>
              <button className="pause-btn" onClick={doRestart}><RotateCcw size={18} /> RESTART RACE</button>
              <button className="pause-btn" onClick={() => { togglePause(); respawn(); }}><MapPin size={18} /> RESPAWN ON TRACK</button>
              <button className="pause-btn danger" onClick={doExit}><LogOut size={18} /> QUIT TO MENU</button>
            </div>
            <div className="settings-block">
              <label><Gauge size={14} /> STEERING SENSITIVITY</label>
              <div className="sens-row">
                <input
                  type="range"
                  min={0.7}
                  max={3.0}
                  step={0.05}
                  value={stats.steerSensitivity}
                  onChange={e => setSteerSensitivity(Number(e.target.value))}
                  className="sens-slider"
                />
                <span className="sens-value">{Math.round(stats.steerSensitivity * 100)}%</span>
              </div>
              <div className="sens-hint">
                <span>Numb / Safe</span><span>Default</span><span>Sharp</span><span>Extreme / Twitchy</span>
              </div>
            </div>
            <div className="controls-ref">
              <label>CONTROLS</label>
              <div className="controls-grid">
                <span><b>W</b> Throttle</span><span><b>S</b> Brake / Reverse</span>
                <span><b>A / D</b> Steer</span><span><b>Space</b> Handbrake</span>
                <span><b>E</b> Gear Up</span><span><b>F</b> Gear Down</span>
                <span><b>Shift</b> Clutch</span><span><b>R</b> Reverse Gear</span>
                <span><b>C</b> Camera</span><span><b>X</b> Respawn</span>
                <span><b>Esc</b> Pause</span><span />
              </div>
            </div>
          </div>
        </div>
      )}

      {screen === 'race' && playerHUD && phase !== 'paused' && (
        <HUD
          playerState={playerHUD}
          standings={standings}
          trackPoints={tpRef.current}
          opponents={oppsRef.current}
          redline={redlineRef.current}
          boostMax={boostMaxRef.current}
          lapsCount={activeRace?.laps || 3}
          currentLap={lap}
          racePosition={pos}
          timeElapsed={elapsed}
          bestLapTime={best}
          cameraMode={camMode}
          isMuted={muted}
          gearboxLabel={gearboxLabel}
          clutchHeld={!!keys.current['shift']}
          isManual={loadoutRef.current.gearbox !== 'auto' && loadoutRef.current.engine !== 'electric'}
          maxGear={carDefRef.current?.specs.gearRatios.length ?? 6}
          onToggleCamera={cycleCam}
          onToggleMute={toggleMute}
          onPause={togglePause}
        />
      )}
    </div>
  );
};
export default App;
