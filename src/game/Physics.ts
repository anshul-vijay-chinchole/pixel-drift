import { CarDefinition, CarLoadout } from '../context/GameContext';

/*
 * ============================================================================
 *  PIXEL DRIFT — VEHICLE PHYSICS (loadout-driven)
 * ============================================================================
 *  Coordinate convention (shared by physics, graphics, camera, AI, minimap):
 *    - World is the Three.js X/Z ground plane, +Y up.
 *    - `yaw` is the heading such that the car's FORWARD direction in world
 *      space is  ( sin(yaw), cos(yaw) )  in (x, z).
 *    - Body frame velocity: `vx` = forward, `vz` = lateral (+ = car's right).
 *      Right direction in world = ( cos(yaw), -sin(yaw) ).
 *    - RENDER HANDEDNESS: through the three.js cameras, that "right" vector
 *      appears on the viewer's LEFT (a camera looking along +Z has world -X on
 *      its right). Physics is self-consistent either way; only the player key
 *      mapping (App.tsx) and the minimap projection (HUD.tsx) compensate.
 *
 *  Feel target: 80% Forza Horizon / 20% GT — weighty but forgiving. The
 *  stability assist is clamped to the grip circle so it can never *add* spin.
 * ============================================================================
 */

export interface UserInputs {
  throttle: number;   // 0..1
  brake: number;      // 0..1
  steering: number;   // -1..1; +1 yaws toward world (cos yaw, -sin yaw) — rendered as screen-LEFT, so App.tsx maps A=+1 / D=-1
  handbrake: boolean;
  clutch: boolean;    // held = drivetrain disconnected
  shiftUp: boolean;   // edge-triggered
  shiftDown: boolean; // edge-triggered
  manualGearbox: boolean;
}

export interface WheelState {
  compression: number;
  normalForce: number;
  slipAngle: number;
  slipRatio: number;
  temp: number;
  wear: number;
  isPunctured: boolean;
  spin: number;
}

export interface VehicleState {
  x: number; z: number; y: number;
  vx: number; vz: number; vy: number;
  yaw: number; yawRate: number;
  roll: number; pitch: number;

  engineRpm: number;
  activeGear: number; // -1 reverse, 0 neutral, 1..n
  turboBoost: number;
  clutchTimer: number;

  speed: number;      // km/h
  gForce: number;
  driftScore: number;
  driftMultiplier: number;
  driftAngle: number;
  isDrifting: boolean;
  steerAngle: number;
  steerVisual: number; // assist-capped angle actually applied — drives the wheel meshes
  steerPull: number;
  engineTemp: number;
  damage: number;
  missedShift: boolean; // per-frame event: a clutchless shift baulked
  overRev: number;      // per-frame event: fractional over-rev from a money shift (0 = none)
  onGround: boolean;
  airTime: number;
  axPrev: number;
  ayPrev: number;

  wheels: { fl: WheelState; fr: WheelState; rl: WheelState; rr: WheelState };
}

export function initVehicleState(carDef: CarDefinition): VehicleState {
  const initWheel = (): WheelState => ({
    compression: 0.5,
    normalForce: (carDef.specs.mass * 9.81) / 4,
    slipAngle: 0, slipRatio: 0, temp: 40, wear: 0, isPunctured: false, spin: 0
  });
  return {
    x: 0, z: 0, y: 0, vx: 0, vz: 0, vy: 0,
    yaw: 0, yawRate: 0, roll: 0, pitch: 0,
    engineRpm: 1000, activeGear: 1, turboBoost: 0, clutchTimer: 0,
    speed: 0, gForce: 0,
    driftScore: 0, driftMultiplier: 1, driftAngle: 0, isDrifting: false,
    steerAngle: 0, steerVisual: 0, steerPull: 0, engineTemp: 85, damage: 0, missedShift: false, overRev: 0,
    onGround: true, airTime: 0, axPrev: 0, ayPrev: 0,
    wheels: { fl: initWheel(), fr: initWheel(), rl: initWheel(), rr: initWheel() }
  };
}

// Simplified Pacejka — force as a fraction of normal load for a given slip.
function pacejka(slip: number, peakMu: number, B: number, C: number, E: number): number {
  const Bs = B * slip;
  return peakMu * Math.sin(C * Math.atan(Bs - E * (Bs - Math.atan(Bs))));
}
const pacejkaLateral = (slipAngle: number, mu: number) => pacejka(slipAngle, mu, 8.5, 1.35, 0.96);

export const ROAD_SURFACES: Record<string, { grip: number; drag: number; roughness: number }> = {
  asphalt_dry: { grip: 1.0, drag: 1.0, roughness: 0.02 },
  asphalt_wet: { grip: 0.7, drag: 1.05, roughness: 0.03 },
  gravel: { grip: 0.66, drag: 1.3, roughness: 0.35 },
  grass: { grip: 0.54, drag: 1.55, roughness: 0.5 },
  sand: { grip: 0.5, drag: 1.9, roughness: 0.6 },
  snow: { grip: 0.35, drag: 1.4, roughness: 0.3 },
  ice: { grip: 0.14, drag: 0.95, roughness: 0.05 },
  curb: { grip: 0.95, drag: 1.0, roughness: 0.8 }
};

// Global durability multiplier on every damage-accrual site below (driveline
// grinding/over-rev/lugging/overheat here, plus wall/traffic/car-car collision
// in resolveCollision/resolveCarPair) — cars take meaningfully longer to reach
// a given damage% so they don't get chewed up early in a race. 1.0 = original
// rates; 0.45 means roughly 2.2x the effective "health" at every damage source.
export const DAMAGE_SCALE = 0.45;

/* ============================================================================
 * LOADOUT RESOLUTION — every attachment maps to physics deltas here.
 * ==========================================================================*/
export interface ResolvedLoadout {
  mass: number;
  power: number;      // hp (effective, incl. induction)
  torque: number;     // Nm (effective)
  redline: number;
  isElectric: boolean;
  // Induction
  boostMax: number;   // 0 = none
  boostLag: number;   // seconds to spool
  boostInstant: boolean;
  // Grip per surface class
  muRoad: number;     // multiplier on tarmac
  muWet: number;      // multiplier on wet tarmac
  muLoose: number;    // multiplier on dirt/grass/sand/snow
  rearLatMult: number;
  assistMult: number;
  steerRateMult: number;
  maxSteerMult: number;
  rollMult: number;
  brakeMult: number;
  downforceAdd: number;
  dragMult: number;
  gearbox: CarLoadout['gearbox'];
  diff: CarLoadout['diff'];
}

export function resolveLoadout(carDef: CarDefinition, lo: CarLoadout): ResolvedLoadout {
  const s = carDef.specs;
  let mass = s.mass;
  let power = s.power;
  let torque = s.peakTorque;
  let redline = s.redline;
  let isElectric = false;

  // --- Engine --- (sidegrades, not upgrades: each shifts WHERE the power
  // lives — top-end vs torque vs instant EV shove — with a real cost. The old
  // flat minimums like "V8 = at least 440 hp" were pure upgrades that made
  // every equal car unequal again.)
  switch (lo.engine) {
    case 'vtec': power *= 1.1; torque *= 0.92; redline = 8800; break;
    case 'rotary': power *= 1.12; torque *= 0.88; redline = 9000; mass -= 25; break;
    case 'v8': power *= 1.06; torque *= 1.35; redline = 6400; mass += 45; break;
    case 'electric': power *= 1.04; torque *= 1.5; redline = 12000; mass += 120; isElectric = true; break;
  }

  // --- Induction --- The BOOST is the forced-induction gain (no unconditional
  // base multiplier — that made turbo strictly dominate NA even unspooled).
  // NA gets a real, always-on bonus instead: modest but there in every corner
  // exit, while turbos only pay off once spooled.
  let boostMax = 0, boostLag = 1, boostInstant = false;
  if (!isElectric) {
    switch (lo.induction) {
      case 'na': torque *= 1.05; break;
      case 'turbo': boostMax = 0.9; boostLag = 0.9; break;
      case 'twinturbo': torque *= 1.03; boostMax = 1.25; boostLag = 1.3; break;
      case 'supercharger': torque *= 1.02; boostMax = 0.7; boostInstant = true; mass += 20; break;
    }
  }

  // --- Tires ---
  let muRoad = 1.0, muWet = 1.0, muLoose = 1.0, rearLatMult = 1.0, assistMult = 1.0;
  switch (lo.tires) {
    case 'sport': muRoad = 1.07; muWet = 0.92; muLoose = 0.9; break;
    case 'slick': muRoad = 1.16; muWet = 0.68; muLoose = 0.72; break;
    case 'rally': muRoad = 0.96; muWet = 1.0; muLoose = 1.35; break;
    case 'drift': muRoad = 0.99; muWet = 0.95; muLoose = 0.95; rearLatMult *= 0.9; assistMult *= 0.55; break;
  }

  // --- Suspension ---
  let steerRateMult = 1.0, maxSteerMult = 1.0, rollMult = 1.0;
  switch (lo.suspension) {
    case 'comfort': assistMult *= 1.2; steerRateMult *= 0.88; rollMult = 1.35; break;
    case 'race': muRoad *= 1.04; muLoose *= 0.88; steerRateMult *= 1.12; rollMult = 0.65; break;
    case 'rally': muLoose *= 1.15; muRoad *= 0.97; rollMult = 1.25; break;
    case 'drift': steerRateMult *= 1.15; maxSteerMult = 1.18; rearLatMult *= 0.97; assistMult *= 0.55; rollMult = 0.8; break;
  }

  // --- Diff ---
  switch (lo.diff) {
    case 'open': rearLatMult *= 1.04; assistMult *= 1.15; break;
    case 'locked': assistMult *= 0.72; break;
  }

  // --- Brakes ---
  const brakeMult = lo.brakes === 'carbon' ? 1.45 : lo.brakes === 'sport' ? 1.22 : 1.0;

  // --- Weight ---
  if (lo.weight === 'stripped') { mass *= 0.93; }
  else if (lo.weight === 'carbon') { mass *= 0.86; assistMult *= 0.92; steerRateMult *= 1.05; }

  // --- Gearbox mass --- A DCT's twin clutches + mechatronics are heavy and the
  // auto's torque converter isn't light; a sequential is light and the H-pattern
  // manual is lightest. This gives the sequential a real niche (lighter than the
  // DCT for a small shift-speed cost) instead of being strictly dominated by it.
  if (lo.gearbox === 'dct') mass += 20;
  else if (lo.gearbox === 'auto') mass += 14;
  else if (lo.gearbox === 'manual') mass -= 8;

  // --- Aero ---
  let downforceAdd = 0, dragMult = 1.0;
  switch (lo.aero) {
    case 'lip': downforceAdd = 0.06; dragMult = 1.02; break;
    case 'gt': downforceAdd = 0.18; dragMult = 1.06; break;
    case 'big': downforceAdd = 0.32; dragMult = 1.12; break;
  }

  return {
    mass, power, torque, redline, isElectric,
    boostMax, boostLag, boostInstant,
    muRoad, muWet, muLoose, rearLatMult, assistMult,
    steerRateMult, maxSteerMult, rollMult, brakeMult,
    downforceAdd, dragMult,
    gearbox: lo.gearbox, diff: lo.diff
  };
}

// Rough figures for the garage UI stat bars.
export function previewStats(carDef: CarDefinition, lo: CarLoadout) {
  const r = resolveLoadout(carDef, lo);
  const cd = carDef.specs.dragCoefficient * r.dragMult;
  const topSpeed = Math.pow((r.power * 745.7 * 0.82) / (0.5 * 1.225 * cd * 2.1), 1 / 3) * 3.6;
  const grip = carDef.specs.baseGrip * r.muRoad;
  const accel = (r.torque / r.mass) * (carDef.specs.driveType === 'AWD' ? 1.12 : 1.0);
  const handling = grip * 6 + r.steerRateMult * 2 + (1.5 - r.rollMult) * 1.5 + r.downforceAdd * 3;
  const braking = carDef.specs.brakes * r.brakeMult * (1350 / r.mass);
  return { power: Math.round(r.power), mass: Math.round(r.mass), topSpeed: Math.round(topSpeed), grip, accel, handling, braking };
}

/* ============================================================================
 * MAIN UPDATE
 * ==========================================================================*/
export function updateVehicle(
  state: VehicleState,
  dt: number,
  inputs: UserInputs,
  surfaceType: string,
  carDef: CarDefinition,
  loadout: CarLoadout,
  perfBoost = 1, // AI difficulty bonus: >1 scales grip + power (player always 1)
  steerSensitivity = 1 // player-facing Settings slider (0.7-3.0); AI always 1
): void {
  if (dt <= 0) return;
  const sensitivity = Math.max(0.7, Math.min(3.0, steerSensitivity));
  // 2026-07-22, player request: "double steering sensitivity across the entire
  // game" (300% should behave like 600% used to). A literal `sensitivity * 2`
  // was tried and REJECTED after headless testing: it makes the DEFAULT slider
  // position (100%) reproduce the physics of the OLD sensitivity=2.0 (200%)
  // setting — which a sustained-hold sweep (2s hold, MODEST steer=0.25,
  // throttle=0, 100 km/h) showed spins the car to an 83-89 degree near-total
  // slide. That's not a new bug — it's the ALREADY-SHIPPED behavior at 200%+
  // on the current slider (confirmed identical against pre-doubling code at
  // the same input sensitivity value) — but making it the DEFAULT, that every
  // player gets with the slider untouched, would be a severe regression.
  // (This sustained-hold spiral is itself a separate, deeper, pre-existing
  // instability — latLimit's assist-target ceiling scales as 1/speed, and once
  // a hold starts scrubbing speed via the resulting slide, the ceiling RISES
  // in response to the car's own speed loss and chases it further; not fixed
  // here — flagged to the user, needs its own dedicated pass.)
  // So: below 100% is untouched (matches shipped exactly), and only the ramp
  // ABOVE 100% is doubled — `1 + (sensitivity-1)*2` reaches the existing,
  // already-validated ceiling (1.2 / 2.20 / 2.30, unchanged) at 200% instead of
  // 300%, giving a real, faster-building boost to anyone who raises the slider
  // at all, without moving the untouched, most-common (default) case into
  // known-risky territory.
  const steerGain = sensitivity <= 1 ? sensitivity : 1 + (sensitivity - 1) * 2;
  if (dt > 0.05) dt = 0.05;

  const spec = carDef.specs;
  const res = resolveLoadout(carDef, loadout);
  const { mass, torque: peakTorque, redline, isElectric } = res;

  const surface = ROAD_SURFACES[surfaceType] || ROAD_SURFACES.asphalt_dry;
  // Surface-class grip multiplier from the tire/suspension choice.
  let tireMult = res.muRoad;
  if (surfaceType === 'asphalt_wet') tireMult = res.muWet;
  else if (surfaceType === 'gravel' || surfaceType === 'grass' || surfaceType === 'sand' || surfaceType === 'snow') tireMult = res.muLoose;
  else if (surfaceType === 'ice') tireMult = Math.min(res.muWet, 1.0);

  const g = 9.81;
  const wheelbase = 2.6;
  const trackWidth = 1.62;
  const h_cg = 0.48;
  const tireRadius = 0.33;
  // STEERING UNIFORMITY: compress each car's weight distribution toward 50/50 for
  // the yaw moment arms ONLY. Raw (uncompressed) wd made front-heavy FWD cars
  // (gti/ek9, wd ~0.62) understeer so hard they "wouldn't turn", while rear-heavy
  // mid-engine cars (nsx/f40/sv12, wd ~0.42) over-rotated and scrubbed nearly all
  // their speed (spun out) on a moderate input — a 2-3x turn-in spread. Pulling
  // the STEERING balance toward the (well-behaved) 50/50 cars equalizes turn-in
  // for every car without touching grip, power or mass. 0 = fully uniform
  // (every car uses the SAME 50/50 yaw moment arm), 1 = raw physical spread.
  // Set to 0: per explicit request, every car's yaw geometry is now identical;
  // the small residual turn-in spread across the fleet (~1.1-1.3x, headless-
  // measured) comes from baseGrip/mass differences, not steering balance.
  const WD_UNIFORM = 0.0;
  const wdEff = 0.5 + (spec.weightDistribution - 0.5) * WD_UNIFORM;
  const lf = wheelbase * (1 - wdEff);
  const lr = wheelbase * wdEff;

  // ---- 1. GEARBOX -----------------------------------------------------------
  if (state.clutchTimer > 0) state.clutchTimer -= dt;
  const gears = spec.gearRatios;
  const numGears = gears.length;
  const manual = inputs.manualGearbox && !isElectric;
  // Only the H-pattern box has a clutch pedal — Shift free-revs / disconnects
  // drive on that box alone. Sequential/DCT are clutchless (holding Shift does
  // nothing), matching their "no clutch" design.
  const clutched = res.gearbox === 'manual' && inputs.clutch;
  const clutchlessH = res.gearbox === 'manual' && !inputs.clutch;
  state.missedShift = false; state.overRev = 0;

  // Faster shifts across the board (2026-07-21) so gear changes feel snappy and
  // the drive barely interrupts — the relative ordering is preserved so the
  // gearbox choice still matters: DCT fastest, a well-timed clutched manual next,
  // then sequential, then auto, and a fumbled clutchless H-pattern still hangs.
  const shiftLag =
    res.gearbox === 'dct' ? 0.04 :
    res.gearbox === 'sequential' ? 0.09 :
    res.gearbox === 'manual' ? (inputs.clutch ? 0.06 : 0.34) : 0.17;

  if (!isElectric && state.clutchTimer <= 0) {
    let up = false, down = false;
    if (!manual && state.activeGear > 0) {
      if (state.engineRpm > redline * 0.92 && state.activeGear < numGears) up = true;
      else if (state.engineRpm < redline * 0.42 && state.activeGear > 1 && state.vx > 2) down = true;
    }
    // Player edges work in every mode.
    if (inputs.shiftUp && state.activeGear >= 1 && state.activeGear < numGears) up = true;
    if (inputs.shiftDown && state.activeGear > 1) down = true;

    // CONSEQUENCE 1 — clutchless shifting on the H-pattern box grinds the gears:
    // a real chance the shift BAULKS (no gear change, long recovery, driveline
    // wear), rising with engine speed. Hold Shift (clutch) to shift cleanly.
    if ((up || down) && clutchlessH) {
      const grindChance = Math.min(0.8, 0.12 + Math.max(0, state.engineRpm / redline - 0.4) * 1.0);
      if (Math.random() < grindChance) {
        state.missedShift = true;
        state.clutchTimer = 0.55;                          // baulked — driveline hangs, no drive
        state.damage = Math.min(1, state.damage + 0.02 * DAMAGE_SCALE);
        up = down = false;
      } else {
        state.damage = Math.min(1, state.damage + 0.004 * DAMAGE_SCALE);  // synchro wear even on a clean one
      }
    }

    if (up && state.activeGear >= 1 && state.activeGear < numGears) {
      state.activeGear++; state.clutchTimer = shiftLag;
    } else if (down && state.activeGear > 1) {
      // CONSEQUENCE 2 — money shift: forcing a downshift into too low a gear at
      // speed over-revs the engine. The shift happens, but the mechanical
      // over-rev damages the engine in proportion to how far past redline it's
      // forced (a big enough mis-shift can wreck it).
      const targetRatio = gears[state.activeGear - 2];
      const impliedRpm = (Math.abs(state.vx) / (2 * Math.PI * tireRadius)) * 60 * Math.abs(targetRatio) * spec.finalDrive;
      // DCT/auto rev-match and won't let you money-shift; only the driver-worked
      // boxes (manual, sequential) can over-rev on a mistimed downshift.
      const canOverRev = res.gearbox === 'manual' || res.gearbox === 'sequential';
      if (canOverRev && impliedRpm > redline * 1.05) {
        const over = (impliedRpm - redline) / redline;
        state.overRev = over;
        state.damage = Math.min(1, state.damage + Math.min(0.5, over * 0.4) * DAMAGE_SCALE);
      }
      state.activeGear--; state.clutchTimer = shiftLag;
    }
  }

  // ---- 2. ENGINE / RPM / TORQUE --------------------------------------------
  const gearRatio = state.activeGear > 0 ? gears[state.activeGear - 1] : gears[0];
  const finalDrive = spec.finalDrive;

  let targetRpm = 1000;
  if (isElectric) {
    targetRpm = Math.min(redline, Math.abs(state.vx) * 320 + 900);
  } else if (clutched) {
    // Drivetrain open: engine revs freely with throttle.
    targetRpm = 1000 + inputs.throttle * (redline - 1000) * 0.95;
  } else if (state.activeGear !== 0) {
    const wheelRps = Math.abs(state.vx) / (2 * Math.PI * tireRadius);
    targetRpm = wheelRps * 60 * Math.abs(gearRatio) * finalDrive;
    targetRpm = Math.max(targetRpm, 1100 + inputs.throttle * 2600 * (state.clutchTimer > 0 ? 1 : 0.15));
  }
  targetRpm = Math.max(900, Math.min(redline, targetRpm));
  state.engineRpm += (targetRpm - state.engineRpm) * Math.min(1, dt * (clutched ? 8 : 12));

  // Boost (induction part).
  if (res.boostMax > 0 && !isElectric) {
    if (res.boostInstant) {
      state.turboBoost = res.boostMax * (state.engineRpm / redline) * inputs.throttle;
    } else if (inputs.throttle > 0.15 && state.engineRpm > 2600 && !clutched) {
      state.turboBoost = Math.min(res.boostMax, state.turboBoost + (dt / Math.max(0.1, res.boostLag)) * inputs.throttle);
    } else {
      state.turboBoost = Math.max(0, state.turboBoost - dt * 2.2);
    }
  } else {
    state.turboBoost = 0;
  }

  const rr = state.engineRpm / redline;
  let torqueFactor: number;
  if (isElectric) {
    torqueFactor = Math.max(0.25, 1.0 - Math.max(0, rr - 0.35) * 0.9);
  } else if (loadout.engine === 'vtec' || loadout.engine === 'rotary') {
    torqueFactor = rr < 0.55 ? 0.55 + rr * 0.35 : 0.74 + (rr - 0.55) * 0.6;
  } else {
    torqueFactor = Math.min(1.0, 0.55 + 0.9 * Math.sin(Math.min(Math.PI, rr * Math.PI * 0.92)));
  }
  // Rev limiter: hard fuel cut once the WHEEL-implied rpm exceeds redline, so
  // you genuinely cannot out-run a gear (short-shifting matters).
  if (!isElectric && state.activeGear !== 0 && !clutched) {
    const impliedRpm = (Math.abs(state.vx) / (2 * Math.PI * tireRadius)) * 60 * Math.abs(gearRatio) * finalDrive;
    if (impliedRpm > redline) torqueFactor = 0;
    else if (manual && state.engineRpm >= redline * 0.985) torqueFactor *= 0.15; // limiter bounce
  }

  const boostTorqueMult = res.boostMax > 0 ? 1.0 + state.turboBoost * 0.45 : 1.0;
  const throttle = state.activeGear === 0 ? 0 : inputs.throttle;
  let engineTorque = peakTorque * torqueFactor * boostTorqueMult * throttle * perfBoost;
  // Damage consequences (SYMMETRIC — no directional pull): a battered car loses
  // power, and past 50% a wrecked engine MISFIRES (random power cuts) so it
  // stumbles and struggles to pull — you limp home, but it still drives straight.
  engineTorque *= 1.0 - state.damage * 0.5;
  if (state.damage > 0.5 && Math.random() < (state.damage - 0.5) * 0.6) engineTorque *= 0.25;

  // Reverse speed cap.
  if (state.activeGear === -1 && state.vx < -8.5) engineTorque = 0;

  const dirGear = state.activeGear === -1 ? -1 : 1;
  let driveTorque: number;
  if (isElectric) driveTorque = engineTorque * 9.0 * dirGear;
  else driveTorque = engineTorque * Math.abs(gearRatio) * finalDrive * 0.9 * dirGear;
  if (clutched) driveTorque = 0; // clutch in = no drive

  let tractiveForce = driveTorque / tireRadius;
  // Engine POWER cap: drive force at speed is limited by P = F*v, so the hp
  // stat is real in the sim. Before this, only torque reached the wheels —
  // the garage POWER number was cosmetic, and the EV's fixed reduction gave it
  // constant force at any speed (drag-limited ~480 km/h). Boost raises the cap
  // (a spooled turbo genuinely makes more power).
  const powerCapN = (res.power * perfBoost * boostTorqueMult * 745.7 * 1.15) / Math.max(2.5, Math.abs(state.vx));
  tractiveForce = Math.max(-powerCapN, Math.min(powerCapN, tractiveForce));
  if (throttle < 0.05 && state.activeGear !== 0 && Math.abs(state.vx) > 0.5 && !clutched) {
    tractiveForce -= Math.sign(state.vx) * 260 * (isElectric ? 2.2 : 1);
  }

  // ---- 3. LOAD TRANSFER -----------------------------------------------------
  const Fz_static = (mass * g) / 4;
  const dFz_long = (mass * state.axPrev * h_cg) / (2 * wheelbase);
  const dFz_lat = (mass * state.ayPrev * h_cg) / (2 * trackWidth);
  const aero = 0.5 * 1.225 * state.vx * state.vx;
  const downforce = aero * (spec.downforceMultiplier + res.downforceAdd);
  const dfPerWheel = downforce / 4;

  const Fz = {
    fl: Math.max(120, Fz_static - dFz_long - dFz_lat + dfPerWheel),
    fr: Math.max(120, Fz_static - dFz_long + dFz_lat + dfPerWheel),
    rl: Math.max(120, Fz_static + dFz_long - dFz_lat + dfPerWheel),
    rr: Math.max(120, Fz_static + dFz_long + dFz_lat + dfPerWheel)
  };
  state.wheels.fl.normalForce = Fz.fl; state.wheels.fr.normalForce = Fz.fr;
  state.wheels.rl.normalForce = Fz.rl; state.wheels.rr.normalForce = Fz.rr;
  const susK = 42000;
  state.wheels.fl.compression = Math.min(1, Fz.fl / susK);
  state.wheels.fr.compression = Math.min(1, Fz.fr / susK);
  state.wheels.rl.compression = Math.min(1, Fz.rl / susK);
  state.wheels.rr.compression = Math.min(1, Fz.rr / susK);

  // ---- 4. STEERING ----------------------------------------------------------
  const speedMs = Math.abs(state.vx);
  const speedKmh = speedMs * 3.6;
  // UNIFORM steering sensitivity: base lock and steer rate are the same for
  // every car and every attachment (no maxSteerMult / steerRateMult), dialled up
  // (0.82 -> 0.86) for a sharper response. The other half of "uniform" is the
  // WD_UNIFORM weight-distribution compression above (the yaw moment arms).
  //
  // maxSteer is a GEOMETRIC wheel angle (radians): the front tyre force is
  // longFront*cos(delta)/etc, so once delta approaches pi/2 (~1.57 rad) cos()
  // collapses toward 0 and then FLIPS SIGN — the car steers the WRONG WAY. So
  // the sensitivity slider must NOT scale the raw geometric lock without bound:
  // cap maxSteer well below pi/2 (cos(1.2) ~ 0.36, safely positive). At
  // sensitivity 1.0 this is exactly 0.86 (the validated baseline — unchanged).
  // PIECEWISE curve, ceiling re-derived THREE times (2026-07-22, dead-slider-
  // range fix — see the memory file for the full history): below 1.0 this is
  // the original straight `0.86 * sensitivity` (unchanged, already validated).
  // ABOVE 1.0 the old formula was the SAME multiplier, which hit its 1.1
  // ceiling by sensitivity ~1.28 — the slider's whole upper range (130%-300%)
  // changed NOTHING ("the setting isn't working"). Two ceiling choices were
  // tried and rejected before this one: 1.1 (the original "safe" ceiling)
  // measurably worsens a PRE-EXISTING, sensitivity-independent instability
  // (sustained hard cornering under throttle triggers a tyre-heat feedback
  // spiral that spins ANY car out given several unbroken seconds of held
  // input, even at sensitivity 1.0 — a separate bug, out of scope here); then
  // 0.95, chosen to avoid that, turned out to make the slider's whole 130%-
  // 300% range change yaw response by only ~5% relative — mathematically
  // non-flat but not something a player can actually feel, i.e. still "not
  // working" in practice. This value (1.2) is calibrated instead against a
  // clean, isolated turn-in test (throttle=0 so no wheelspin/tyre-heat
  // confound): it gives a ~40% relative yaw-response change across 1.0-3.0,
  // comparable in magnitude to the already-good 0.7-1.0 range below, and at
  // REALISTIC hold durations (1.5-2s, not an unbroken 4+ second corner) it
  // does not measurably worsen the separate tyre-heat instability's onset.
  // (Also tried adding new gain instead — faster steer-rate / stronger assist
  // convergence — but headless testing showed ANY extra gain in this feedback
  // loop, delta -> betaF -> kinYaw -> yawRate -> delta, reopens the old wash-
  // out even toward an already-grip-safe target, so that approach was
  // abandoned in favour of just spreading this ceiling across the slider.)
  const maxSteer = steerGain <= 1
    ? 0.86 * steerGain
    : Math.min(1.2, 0.86 + (steerGain - 1) * 0.17);
  // Retain far more lock at speed (floor 0.74 -> 0.86) so the front bites at
  // every velocity, not just in town.
  const speedFactor = Math.max(0.86, 1 / (1 + speedKmh / 270));
  const steerTarget = inputs.steering * maxSteer * speedFactor + state.steerPull;

  // Near-instant wheel: the commanded angle is reached in ~1 frame, uniform for
  // all cars, so steering feels immediate and direct.
  const err = steerTarget - state.steerAngle;
  let steerRate = 88;
  if (Math.abs(inputs.steering) < 0.05) steerRate = 94;                 // release
  else if (Math.sign(err) !== Math.sign(state.steerAngle || err)) steerRate = 98; // counter-steer
  // (no res.steerRateMult — steering rate is uniform regardless of attachment)
  state.steerAngle += err * Math.min(1, dt * steerRate);

  // Steering-limit assist (the Forza trick): cap the ACTUAL wheel angle so the
  // front tyres stay near their grip peak. Holding full lock at speed then
  // means "corner as hard as possible", not "spin out". The cap widens with
  // drift-oriented parts and opens fully under handbrake, so slides stay in.
  let delta = state.steerAngle;
  if (speedMs > 6) {
    // Zero-slip steering angle: slip = atan2(lat, |v|) - dir*delta = 0 gives
    // delta = dir*betaF, so the cap band flips sense in reverse too.
    const dirCap = state.vx < 0 ? -1 : 1;
    const betaF = dirCap * Math.atan2(state.vz + state.yawRate * lf, Math.max(1.2, speedMs));
    // Cap tightens with speed (like a real steering assist) so full lock stays
    // safe from city speeds to autobahn speeds. Widened base/floor vs. the old
    // curve so the front actually bites when you steer under throttle — the car
    // turns in willingly instead of feeling numb — while still tracking betaF so
    // it can't snap into a spin.
    // Handbrake widening cut 0.42 -> 0.15 (reduce-drift pass, 2026-07-22): this
    // term ONLY applies under handbrake, so it can't touch normal driving feel
    // (headless-verified: identical yaw/speed with handbrake never engaged).
    // Tightening it narrows how far the front can counter-steer INTO a slide
    // during a handbrake pull, trimming the achieved slide angle (~8% less at
    // a sustained 0.8s pull in a 480-case headless sweep) without gutting the
    // ability to catch/hold a drift entirely.
    const slipCap = Math.max(0.58, 1.05 - speedKmh * 0.0009) // much wider band -> the front points harder and turns in sharply
      + (1 - Math.min(1, res.assistMult)) * 0.5
      + (inputs.handbrake ? 0.15 : 0);
    delta = Math.max(betaF - slipCap, Math.min(betaF + slipCap, delta));
  }
  // Hard safety net on the geometric wheel angle: the betaF+slipCap band above
  // can inflate when the car is already rotating (betaF grows with yawRate/vz),
  // and at high sensitivity that feedback used to push delta past pi/2 mid-spin
  // — where cos(delta) goes negative and the front tyre force reverses, feeding
  // the spin. Clamp to 1.5 rad (cos(1.5) ~ 0.07, still POSITIVE so the force can
  // never invert) — this is above the ~1.46 rad a normal sensitivity-1.0 drift
  // counter-steer reaches, so it doesn't touch baseline drift feel; it only
  // catches the runaway high-sensitivity case.
  delta = Math.max(-1.5, Math.min(1.5, delta));
  // What the front wheels ACTUALLY do this frame — the wheel meshes render
  // this, not the raw (pre-cap) steerAngle, so visuals match the physics.
  state.steerVisual = delta;

  // ---- 5. SLIP ANGLES -------------------------------------------------------
  // dirG flips the steered-wheel slip term in REVERSE: the front contact's
  // lateral velocity in the wheel frame is (vLat + r*lf) - vx*delta, so for
  // vx < 0 the delta contribution changes sign. The old forward-only formula
  // made the tyres push the nose TOWARD the steered side while backing up, so
  // the car arced away from where you steered — reverse felt inverted.
  const vLat = state.vz;
  const denom = Math.max(1.2, speedMs);
  const dirG = state.vx < 0 ? -1 : 1;
  const slipFront = Math.atan2(vLat + state.yawRate * lf, denom) - dirG * delta;
  const slipRear = Math.atan2(vLat - state.yawRate * lr, denom);

  state.wheels.fl.slipAngle = slipFront; state.wheels.fr.slipAngle = slipFront;
  state.wheels.rl.slipAngle = slipRear; state.wheels.rr.slipAngle = slipRear;

  const tempGrip = (t: number) => {
    if (t < 70) return 0.85 + (t / 70) * 0.15;
    if (t > 105) return Math.max(0.65, 1 - (t - 105) * 0.005);
    return 1.0;
  };
  const heatWheel = (w: WheelState, slipMag: number) => {
    const heat = slipMag * 80 * dt;
    const cool = (w.temp - 35) * 0.25 * dt;
    w.temp = Math.max(25, Math.min(160, w.temp + heat - cool));
    w.wear = Math.min(1, w.wear + slipMag * 0.0007 * dt + Math.max(0, w.temp - 110) * 0.00004 * dt);
  };

  // Damage also saps grip (bent chassis/suspension) — symmetric, both axles.
  // perfBoost gives AI a grip edge at higher tiers.
  const muBase = spec.baseGrip * surface.grip * tireMult * 1.32 * (1 - state.damage * 0.2) * perfBoost;
  const wheelMu = (w: WheelState) => {
    let mu = muBase * tempGrip(w.temp) * (1 - w.wear * 0.35);
    if (w.isPunctured) mu *= 0.4;
    return mu;
  };

  // ---- 6. TYRE FORCES (friction ellipse) ------------------------------------
  let driveFront = 0, driveRear = 0;
  if (spec.driveType === 'AWD') { driveFront = tractiveForce * 0.4; driveRear = tractiveForce * 0.6; }
  else if (spec.driveType === 'FWD') { driveFront = tractiveForce; }
  else { driveRear = tractiveForce; }

  const FzFront = Fz.fl + Fz.fr;
  const FzRear = Fz.rl + Fz.rr;
  const muFront = (wheelMu(state.wheels.fl) + wheelMu(state.wheels.fr)) * 0.5;
  let muRearEff = (wheelMu(state.wheels.rl) + wheelMu(state.wheels.rr)) * 0.5 * 1.32 * res.rearLatMult;
  // Locked diff loosens the rear under power; open diff plants it.
  if (res.diff === 'locked' && throttle > 0.35) muRearEff *= 0.9;

  const handbrake = inputs.handbrake;
  // TRACTION CONTROL (2026-07-22) — the hypercar power pass (873-1289 hp on ~1-tonne
  // cars) puts MANY times the tyre's grip through the driven axle across almost the
  // whole speed range (measured rear slip ratios of 20-99 = fully lit-up tyres). The
  // friction ellipse's longitudinal priority then always saturated the drive
  // direction and starved the axle's LATERAL grip -> the car power-oversteered
  // ("drifted") constantly at every speed on every surface (worst on low grip). Cap
  // the DRIVE force to a fraction of the axle's grip so lateral grip is left over.
  // STEERING-AWARE: near-full drive when going straight (strong launches, and because
  // we cap the DEMAND not just the delivered force there's still zero wheelspin),
  // clamped down hard the instant you steer so cornering stays planted -> the car
  // tracks under power and only slides when you deliberately stomp it mid-corner (or
  // pull the handbrake). Grip-relative, so it self-scales on gravel/snow/wet too.
  // The drag floor keeps it from ever limiting top speed (at Vmax the drive force is
  // just aero drag, far below grip). Gated off under handbrake and eased for
  // locked-diff/drift-tyre builds (their lower muRearEff lowers the cap). AI drives
  // through this too, which also stops the AI power-spinning.
  const tcCap = Math.max(0.55, 0.88 - Math.abs(inputs.steering) * 1.9);
  if (!handbrake && throttle > 0.05 && dirGear > 0) {
    const dragEst = 0.5 * 1.225 * spec.dragCoefficient * res.dragMult * 2.1 * state.vx * state.vx;
    const rearCap = Math.max(muRearEff * FzRear * tcCap, dragEst * 1.1);
    const frontCap = Math.max(muFront * FzFront * tcCap, dragEst * 1.1);
    if (driveRear > rearCap) driveRear = rearCap;
    if (driveFront > frontCap) driveFront = frontCap;
  }

  // 8200 N baseline sits just UNDER the tyre grip limit for stock brakes, so
  // brake upgrades (and the per-car brakes stat) genuinely shorten stops —
  // 12500 exceeded every car's grip and made all brake choices no-ops.
  const brakeMax = 8200 * spec.brakes * res.brakeMult * (1 - state.damage * 0.25);
  const brakeForceTotal = inputs.brake * brakeMax;
  const dirLong = state.vx >= 0 ? 1 : -1;
  const rollResist = (12 * mass) / 1000 * dirLong * surface.drag;

  let longFront = driveFront - dirLong * (brakeForceTotal * 0.62) - rollResist * 0.5;
  let longRear = driveRear - dirLong * (brakeForceTotal * 0.38) - rollResist * 0.5;
  if (handbrake) longRear -= dirLong * 9000;

  let latFront = -pacejkaLateral(slipFront, muFront) * FzFront;
  let latRear = -pacejkaLateral(slipRear, muRearEff) * FzRear;
  // Retain more rear lateral grip under handbrake (0.35 -> 0.50, reduce-drift
  // pass, 2026-07-22) — the rear digs in a bit sooner once you release the
  // brake, so a pull breaks the tail loose less violently. Handbrake-gated
  // only: zero effect when handbrake is up (headless-verified).
  if (handbrake) latRear *= 0.50;

  // Friction ellipse with LONGITUDINAL PRIORITY (the arcade trade): drive and
  // brake force keep up to 90% of the grip budget and the lateral force takes
  // what's left (always >= 44% of budget, so the car still corners and the rear
  // still stabilises). The old proportional scaling let full-lock keyboard
  // steering saturate the axle laterally and starve the drive force — holding
  // W+A/D produced almost no acceleration. Cost: mild understeer at the limit.
  const clampAxle = (long: number, lat: number, mu: number, Fz2: number) => {
    const maxF = mu * Fz2;
    const mag = Math.hypot(long, lat);
    if (mag > maxF && mag > 1) {
      const longKeep = Math.max(-maxF * 0.9, Math.min(maxF * 0.9, long));
      const latBudget = Math.sqrt(Math.max(0, maxF * maxF - longKeep * longKeep));
      const latKeep = Math.max(-latBudget, Math.min(latBudget, lat));
      return { long: longKeep, lat: latKeep, slip: (mag - maxF) / maxF };
    }
    return { long, lat, slip: 0 };
  };
  const cf = clampAxle(longFront, latFront, muFront, FzFront);
  const crr = clampAxle(longRear, latRear, muRearEff, FzRear);
  longFront = cf.long; latFront = cf.lat;
  longRear = crr.long; latRear = crr.lat;

  const frontSlipR = cf.slip * Math.sign(longFront || 1);
  const rearSlipR = crr.slip * Math.sign(longRear || 1);
  state.wheels.fl.slipRatio = frontSlipR; state.wheels.fr.slipRatio = frontSlipR;
  state.wheels.rl.slipRatio = rearSlipR; state.wheels.rr.slipRatio = rearSlipR;

  heatWheel(state.wheels.fl, Math.abs(slipFront) + Math.abs(frontSlipR) * 0.5);
  heatWheel(state.wheels.fr, Math.abs(slipFront) + Math.abs(frontSlipR) * 0.5);
  heatWheel(state.wheels.rl, Math.abs(slipRear) + Math.abs(rearSlipR) * 0.5);
  heatWheel(state.wheels.rr, Math.abs(slipRear) + Math.abs(rearSlipR) * 0.5);

  // ---- 7. BODY FORCES -------------------------------------------------------
  const cosD = Math.cos(delta), sinD = Math.sin(delta);
  const Fx_front = longFront * cosD - latFront * sinD;
  const Fy_front = longFront * sinD + latFront * cosD;
  const Fx_rear = longRear;
  const Fy_rear = latRear;

  const dragForce = 0.5 * 1.225 * spec.dragCoefficient * res.dragMult * 2.1 * state.vx * Math.abs(state.vx) * surface.drag;

  const Fx = Fx_front + Fx_rear - dragForce;
  const Fy = Fy_front + Fy_rear;
  const yawTorque = Fy_front * lf - Fy_rear * lr;

  // ---- 8. INTEGRATE ---------------------------------------------------------
  const invMass = 1 / mass;
  const Izz = (mass * (wheelbase * wheelbase + trackWidth * trackWidth)) / 12 * 1.15;
  const ax = Fx * invMass + state.vz * state.yawRate;
  const ay = Fy * invMass - state.vx * state.yawRate;
  const yawAcc = yawTorque / Izz;

  state.vx += ax * dt;
  state.vz += ay * dt;
  state.yawRate += yawAcc * dt;
  state.yawRate *= Math.max(0, 1 - dt * 1.1);

  // Stability assist: pull yaw toward the *grip-limited* neutral-steer rate.
  // Clamping to the grip circle means the assist can only calm the car,
  // never whip it around. Fades under handbrake / big rear slip so
  // deliberate drifts stay alive.
  const kinYawRaw = (state.vx * Math.tan(delta)) / wheelbase;
  // latLimit shapes ONLY the assist's yaw target (not the tyre grip that sets
  // real cornering/braking limits), so it is the safe place to tune STEERING
  // FEEL. Raised 1.05 -> 1.18 for markedly more eager, less-numb cornering. The
  // catch: on its own that let balanced RWD cars snap-oversteer, so it is paired
  // with a much higher assist floor below (0.68 -> 0.88) that keeps the tail in
  // check. Swept across 2016 scenarios (14 cars x street/grippy/drift loadouts x
  // dry/wet x 6 speeds x 4 inputs): this pair is +24% more responsive AND spins
  // roughly HALF as often as the old tune (18 vs 38), so it is both sharper and
  // more planted. gripUnif additionally compresses the per-car cornering-rate
  // spread ~40% toward a fleet-reference grip so low- and high-grip cars respond
  // to the wheel more alike (uniform feel) without touching real grip (±~3%).
  const REF_GRIP = 0.89; // ~fleet-average baseGrip
  const gripUnif = Math.pow(REF_GRIP / spec.baseGrip, 0.4);
  // Yaw ceiling raised 1.18 -> 1.70 so the car is allowed to rotate a lot more
  // eagerly (paired with the much stronger assist below, which keeps that extra
  // rotation catchable). This is grip-limited at high speed — the tyres cap how
  // fast a car can physically rotate — so it lifts low/mid-speed cornering most.
  // (A speed-falloff-softening experiment here was reverted: it raised the
  // ceiling at high speed which let yawRate/vz grow further before the
  // steering-limit assist's betaF-based delta cap engaged, and once that cap
  // engages it tracks betaF (the car's OWN slide angle) instead of the driver's
  // input — so at high speed the wheel could go from "weak" to "does nothing"
  // once the car started sliding. High-speed feel is now tuned via the player
  // sensitivity setting below instead of a single global constant.)
  // Sensitivity's effect on the yaw CEILING must be BOUNDED (2026-07-22): the raw
  // `1.70 * sensitivity` let a high slider value push the ceiling to several times
  // the grip-limited yaw, so the assist commanded far more rotation than the tyres
  // could deliver -> the car rotated past grip into a permanent slip (washed out /
  // "drifted"), worst on heavy high-grip cars. The memory-documented wash-out edge
  // is ~1.70; cap the effective factor just past it. Sensitivity still sharpens
  // turn-in via maxSteer + steer-rate + the yaw clamp, but it can no longer
  // over-rotate the car past what the tyres hold. (At the 1.0 default this is a
  // no-op — 1.70*1.0 < 1.85 — it only tames the slider's upper range.)
  // PIECEWISE above 1.0 (dead-slider-range fix — see the maxSteer comment above
  // for the full history of ceiling values tried and why: 1.85 measurably
  // worsens a separate, pre-existing tyre-heat instability; 1.75 was safe but
  // imperceptible (~5% relative response over the WHOLE 130%-300% range); 2.20
  // is calibrated against a clean isolated turn-in test to give a genuinely
  // felt ~40% relative response, comparable to the 0.7-1.0 range below).
  const latFactor = steerGain <= 1
    ? 1.70 * steerGain
    : Math.min(2.20, 1.70 + (steerGain - 1) * 0.25);
  const latLimit = ((muFront + muRearEff) * 0.5 * gripUnif * g) / Math.max(3, speedMs) * latFactor;
  const kinYaw = Math.max(-latLimit, Math.min(latLimit, kinYawRaw));
  // Assist strengthened 4.0 -> 8.0, per-frame cap 0.5 -> 1.0, floor 0.68 -> 0.95:
  // the car snaps to its commanded cornering attitude about twice as fast, which
  // is what makes the raised sensitivity (wider slipCap + 1.70 latLimit) feel
  // immediate — and because the SAME assist pulls the tail back just as fast, the
  // much more eager rotation stays catchable rather than running away into a
  // spin. The high floor keeps it from fading mid-slide. Handbrake factor
  // raised 0.26 -> 0.42 (reduce-drift pass, 2026-07-22): the assist recovers
  // faster while the brake is held, so a pull settles into a tamer, shorter
  // slide instead of the tail running free — still a real cut (drift-oriented
  // parts also lower assistMult), so slides live on, just less wild.
  const assistStrength = 8.0 * res.assistMult * (handbrake ? 0.42 : 1) * Math.max(0.95, 1 - Math.abs(slipRear) * 0.5);
  state.yawRate += (kinYaw - state.yawRate) * Math.min(1.0, assistStrength * dt);

  // Low-speed stabilisation.
  if (speedMs < 2.2) {
    const k = (2.2 - speedMs) / 2.2;
    state.vz *= 1 - k * 0.35;
    state.yawRate *= 1 - k * 0.5;
  }
  // Peak rotation clamp: 2.0 rad/s (~115°/s) at sensitivity 1.0 (the baseline),
  // scaled by the sensitivity slider so its upper half isn't wasted. Now that
  // maxSteer is bounded (no inversion), the assist's yaw target (latLimit *
  // sensitivity) is the real sensitivity lever — but at high slider values it
  // was slamming straight into this fixed 2.0 ceiling, so 1.5x and 3.0x felt
  // identical. Scaling the ceiling with sqrt(sensitivity) below 1.0 (gentler
  // than linear, so the top end stays controllable rather than a pure spin)
  // lets lower settings feel meaningfully calmer: ~1.67 at 0.7x, 2.0 at 1.0x.
  // PIECEWISE above 1.0 (dead-slider-range fix — see the maxSteer comment above
  // for the full history: 2.15 measurably worsens a separate pre-existing
  // instability, 2.05 was safe but imperceptible; 2.30 gives a genuinely felt
  // response, calibrated the same way as latFactor above).
  const yawClamp = steerGain <= 1
    ? 2.0 * Math.sqrt(steerGain)
    : Math.min(2.30, 2.0 + (steerGain - 1) * 0.15);
  state.vz = Math.max(-13.6, Math.min(13.6, state.vz));
  state.yawRate = Math.max(-yawClamp, Math.min(yawClamp, state.yawRate));

  const s = Math.sin(state.yaw), c = Math.cos(state.yaw);
  const worldVX = state.vx * s + state.vz * c;
  const worldVZ = state.vx * c - state.vz * s;
  state.x += worldVX * dt;
  state.z += worldVZ * dt;
  state.yaw += state.yawRate * dt;
  state.yaw = (state.yaw + Math.PI * 4) % (Math.PI * 2);

  const rollTarget = Math.max(-0.1, Math.min(0.1, (-ay / g) * 0.55 * res.rollMult));
  const pitchTarget = Math.max(-0.07, Math.min(0.07, (ax / g) * 0.4));
  state.roll += (rollTarget - state.roll) * Math.min(1, dt * 7);
  state.pitch += (pitchTarget - state.pitch) * Math.min(1, dt * 7);

  // Low-pass the accelerations that drive next frame's weight transfer, so load
  // shifts build and settle smoothly (like real suspension) instead of feeding
  // back raw single-frame spikes — steadier, more realistic grip under braking
  // and turn-in.
  state.axPrev += (ax - state.axPrev) * Math.min(1, dt * 12);
  state.ayPrev += (ay - state.ayPrev) * Math.min(1, dt * 12);
  state.gForce = Math.abs(ay) / g;
  state.speed = Math.round(Math.abs(state.vx) * 3.6);

  const spin = (state.vx / (2 * Math.PI * tireRadius)) * 2 * Math.PI * dt;
  state.wheels.fl.spin += spin; state.wheels.fr.spin += spin;
  state.wheels.rl.spin += spin * (1 + Math.abs(rearSlipR));
  state.wheels.rr.spin += spin * (1 + Math.abs(rearSlipR));

  // ---- 9. DRIFT SCORING (deliberate slides only) ----------------------------
  if (speedMs > 5) {
    state.driftAngle = Math.atan2(state.vz, Math.abs(state.vx));
    const deg = (Math.abs(state.driftAngle) * 180) / Math.PI;
    if (deg > 13 && speedKmh > 30 && Math.abs(state.yawRate) > 0.12) {
      state.isDrifting = true;
      // Points-per-second rate cut 3.0 -> 1.95 (35% reduction, 2026-07-22 per
      // request) — this is THE game's literal "drift" quantity (driftScore),
      // so a straight 35% cut here is exact and unambiguous, on top of the
      // handbrake-specific physics tightening above (retain/assist/slipCap)
      // that makes the underlying slide itself less extreme.
      const pts = speedKmh * Math.sin(Math.min(1.2, Math.abs(state.driftAngle))) * dt * 1.95;
      state.driftScore += pts * state.driftMultiplier;
      state.driftMultiplier = Math.min(12, state.driftMultiplier + dt * 0.28);
    } else {
      state.isDrifting = false;
      state.driftMultiplier = Math.max(1, state.driftMultiplier - dt * 3);
    }
  } else {
    state.isDrifting = false;
    state.driftAngle = 0;
    state.driftMultiplier = Math.max(1, state.driftMultiplier - dt * 3);
  }

  // ---- 10. THERMAL / DAMAGE -------------------------------------------------
  // EVs cruise at "redline" by design — no combustion heat, no overheat damage.
  if (!isElectric && state.engineRpm > redline * 0.9 && throttle > 0.5) {
    state.engineTemp = Math.min(130, state.engineTemp + dt * 2.0);
  } else {
    state.engineTemp = Math.max(85, state.engineTemp - dt * 0.5);
  }
  // CONSEQUENCE 3 — lugging: labouring a too-tall gear at very low rpm under
  // throttle bogs and strains the engine (heat + slow wear) on top of the
  // low-rpm torque hole. Short-shift sensibly or drop a gear.
  if (!isElectric && !clutched && state.activeGear > 1 && throttle > 0.4 && state.engineRpm < redline * 0.2 && Math.abs(state.vx) > 1) {
    state.engineTemp = Math.min(130, state.engineTemp + dt * 1.6);
    state.damage = Math.min(1, state.damage + dt * 0.004 * DAMAGE_SCALE);
  }
  if (state.engineTemp > 118) state.damage = Math.min(1, state.damage + dt * 0.012 * DAMAGE_SCALE);
}

// Collision resolution. `nx,nz` = world-space normal pointing away from the
// wall (toward the car).
export function resolveCollision(state: VehicleState, nx: number, nz: number, impactSpeed: number, restitution = 0.35) {
  const s = Math.sin(state.yaw), c = Math.cos(state.yaw);
  let wvx = state.vx * s + state.vz * c;
  let wvz = state.vx * c - state.vz * s;

  const vn = wvx * nx + wvz * nz;
  if (vn < 0) {
    wvx -= (1 + restitution) * vn * nx;
    wvz -= (1 + restitution) * vn * nz;
    wvx *= 0.7; wvz *= 0.7;
  }
  state.vx = wvx * s + wvz * c;
  state.vz = wvx * c - wvz * s;
  state.yawRate *= 0.6;

  if (impactSpeed > 6) {
    const dmg = (impactSpeed - 6) * 0.02 * DAMAGE_SCALE;
    state.damage = Math.min(1, state.damage + dmg);
    // NOTE: damage no longer pulls the steering to one side or punctures a
    // single tyre — those made the car veer/tilt off in a direction. Damage
    // consequences are now SYMMETRIC (power, grip, brakes, misfire) so a
    // battered car is slower and gutless but still drives straight. See the
    // engine-torque / muBase / brakeMax blocks above.
  }
}

/* ============================================================================
 * CAR-TO-CAR COLLISION — two-body, mass-weighted.
 * ----------------------------------------------------------------------------
 * Each car is approximated by a ~1.5 m radius circle. On overlap we push the
 * pair apart (split by inverse mass so the lighter car gives way) and apply a
 * normal impulse in WORLD-velocity space — using the same body<->world
 * transform involution the wall resolver relies on — then convert back to the
 * body frame. Returns the closing impact speed (m/s) so the caller can fire
 * effects/sound. Bodywork only: no rigid rotation solve, just a yaw scrub +
 * damage, which keeps it stable and arcade-friendly.
 * ==========================================================================*/
export function resolveCarPair(a: VehicleState, b: VehicleState, massA: number, massB: number): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const distSq = dx * dx + dz * dz;
  const R = 3.0; // sum of the two ~1.5 m body radii
  if (distSq > R * R || distSq < 1e-6) return 0;
  const dist = Math.sqrt(distSq);
  const nx = dx / dist, nz = dz / dist; // contact normal, a -> b
  const invA = 1 / massA, invB = 1 / massB, invSum = invA + invB;

  // Positional de-overlap, split by inverse mass.
  const overlap = R - dist;
  a.x -= nx * overlap * (invA / invSum); a.z -= nz * overlap * (invA / invSum);
  b.x += nx * overlap * (invB / invSum); b.z += nz * overlap * (invB / invSum);

  // World-space velocities (transform is its own inverse).
  const sa = Math.sin(a.yaw), ca = Math.cos(a.yaw);
  const sb = Math.sin(b.yaw), cb = Math.cos(b.yaw);
  const awx = a.vx * sa + a.vz * ca, awz = a.vx * ca - a.vz * sa;
  const bwx = b.vx * sb + b.vz * cb, bwz = b.vx * cb - b.vz * sb;

  const relN = (bwx - awx) * nx + (bwz - awz) * nz; // < 0 while closing
  if (relN >= 0) return 0;                          // already separating
  const e = 0.25;                                   // restitution
  const j = (-(1 + e) * relN) / invSum;             // scalar impulse
  const jx = j * nx, jz = j * nz;

  const nawx = awx - jx * invA, nawz = awz - jz * invA;
  const nbwx = bwx + jx * invB, nbwz = bwz + jz * invB;
  a.vx = nawx * sa + nawz * ca; a.vz = nawx * ca - nawz * sa;
  b.vx = nbwx * sb + nbwz * cb; b.vz = nbwx * cb - nbwz * sb;

  // A shove scrubs a little rotation; a big one dents both (lighter car more).
  a.yawRate *= 0.8; b.yawRate *= 0.8;
  const impact = -relN;
  if (impact > 6) {
    a.damage = Math.min(1, a.damage + (impact - 6) * 0.02 * DAMAGE_SCALE * (massB / (massA + massB)));
    b.damage = Math.min(1, b.damage + (impact - 6) * 0.02 * DAMAGE_SCALE * (massA / (massA + massB)));
  }
  return impact;
}
