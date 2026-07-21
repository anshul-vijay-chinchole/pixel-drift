import { VehicleState, UserInputs, updateVehicle, initVehicleState } from './Physics';
import { TrackPoint, TrackBuilder, groundHeight, roadHeightAt } from './World';
import { CarDefinition, CarLoadout, DEFAULT_LOADOUT, Difficulty, difficultySkill, WeatherType } from '../context/GameContext';

// Physically-motivated corner/braking grip multiplier per weather, used to
// scale the AI's PRECOMPUTED speed profile (see computeSpeedProfile) so wet
// races give the AI a profile that assumes the grip it actually has, not dry
// grip. Fog/night don't reduce a bot's PHYSICAL grip (no visibility penalty
// applies to code reading track data directly), so they stay at 1.
const weatherGripMult = (weather: string): number => (weather === 'rainy' || weather === 'snowy' ? 0.75 : 1);

export type AIProfile = 'aggressive' | 'defensive' | 'pro' | 'rookie' | 'drifter';

export interface OpponentRacer {
  id: string;
  name: string;
  color: string;
  profile: AIProfile;
  carDef: CarDefinition;
  loadout: CarLoadout;
  state: VehicleState;
  inputs: UserInputs;
  targetSpeed: number;
  currentTrackIndex: number;
  lap: number;
  progress: number;
  lineOffset: number;
  mistakeTimer: number;
  mistakeType: 'none' | 'lockup' | 'wide';
  pressureRating: number;
  skill: number;
  perfBoost: number;        // car performance edge (grip+power) at higher tiers — the "bonus"
  speedProfile: number[];   // shared per-race target-speed map (m/s)
  stuckTimer: number;
  finished: boolean;
  finishTime: number;
}

const NAMES = ['Hiroshi', 'Jack', 'Mia', 'Klaus', 'Sven', 'Takahiro', 'Clara', 'Viktor', 'Rin', 'Diego', 'Noa'];
const COLORS = ['#ff4d4d', '#4d79ff', '#ffd24d', '#4dff88', '#c14dff', '#ff944d', '#4dd2ff', '#ff4da6'];

const baseSkill = (difficulty: string): number => difficultySkill(difficulty);

// Per-profile attachment loadouts — different parts, different physics.
function aiLoadout(profile: AIProfile): CarLoadout {
  const base: CarLoadout = { ...DEFAULT_LOADOUT, color: '#222', plate: 'AI' };
  switch (profile) {
    // AI keep NA induction — boost spikes overwhelm their traction management.
    case 'pro': return { ...base, tires: 'slick', suspension: 'race', diff: 'lsd', gearbox: 'dct', aero: 'gt' };
    case 'aggressive': return { ...base, tires: 'sport', suspension: 'sport', diff: 'lsd', gearbox: 'sequential', aero: 'lip' };
    case 'defensive': return { ...base, tires: 'sport', suspension: 'comfort', diff: 'lsd', gearbox: 'auto' };
    case 'drifter': return { ...base, tires: 'drift', suspension: 'drift', diff: 'locked', gearbox: 'sequential' };
    case 'rookie': return { ...base, tires: 'street', suspension: 'comfort', diff: 'open', gearbox: 'auto' };
  }
}

// Precompute a braking-aware corner-speed profile for the whole track:
// forward pass caps by curvature; backward passes propagate braking distances
// so the AI slows BEFORE corners instead of sailing past the apex.
// `gripMult` (see weatherGripMult) scales BOTH the cornering and braking
// budget so a wet-race profile bakes in reduced grip at its source, instead of
// a flat pace multiplier applied on top of a profile computed as if it were
// always dry — the old approach let the AI arrive at corners assuming dry
// braking distances even in the rain, so it overshot and ran wide.
export function computeSpeedProfile(tp: TrackPoint[], isClosed: boolean, gripMult = 1): number[] {
  const n = tp.length;
  const totalLen = tp[n - 1].dist || 1;
  const ds = Math.max(1.5, totalLen / n);
  // Real grip (muBase ~1.32) supports far more than this, so raising the AI's
  // usable lateral/braking makes them corner & brake harder without overshooting.
  const aLat = 11.2 * gripMult;  // m/s² usable lateral accel — near the real grip limit
  const aBrake = 10.0 * gripMult; // m/s² braking decel — brakes very late

  const v: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const theta = Math.acos(Math.max(-1, 1 - Math.min(1, tp[i].curvature)));
    const kappa = theta / ds;
    v[i] = kappa > 0.0004 ? Math.sqrt(aLat / kappa) : 78;
    v[i] = Math.min(78, Math.max(8, v[i]));
  }
  // Backward pass (twice around for closed tracks so the seam propagates).
  const passes = isClosed ? 2 * n : n;
  for (let k = passes - 1; k >= 0; k--) {
    const i = ((k % n) + n) % n;
    const next = (i + 1) % n;
    if (!isClosed && next === 0) continue;
    v[i] = Math.min(v[i], Math.sqrt(v[next] * v[next] + 2 * aBrake * ds));
  }
  return v;
}

// A staggered starting-grid slot (0 = front row). Two cars per row, spaced back
// from the start line on closed tracks, tight up the road on sprints. Returns
// the spawn node index + world transform so the player can be mixed into it.
export function gridSpawn(tp: TrackPoint[], isClosed: boolean, slot: number): { nodeIdx: number; x: number; y: number; z: number; yaw: number } {
  const N = tp.length;
  const row = Math.floor(slot / 2);
  const col = (slot % 2 === 0 ? -1 : 1) * 0.32;
  const nodeIdx = isClosed
    ? ((-(6 + row * 7)) % N + N) % N
    : Math.min(N - 5, slot * 2);
  const sp = tp[nodeIdx];
  const lateral = col * sp.width;
  return {
    nodeIdx,
    x: sp.pos.x + sp.normal.x * lateral,
    y: sp.pos.y + 0.05,
    z: sp.pos.z + sp.normal.z * lateral,
    yaw: Math.atan2(sp.tangent.x, sp.tangent.z),
  };
}

export class AIEngine {
  public static spawnOpponents(
    count: number,
    trackPoints: TrackPoint[],
    carDb: CarDefinition[],
    difficulty: Difficulty,
    isClosed = true,
    slots: number[] = [],
    playerPower = 250,
    weather: WeatherType = 'sunny'
  ): OpponentRacer[] {
    const profiles: AIProfile[] = ['pro', 'aggressive', 'defensive', 'drifter', 'rookie'];
    const opponents: OpponentRacer[] = [];
    const skill0 = baseSkill(difficulty);
    // Power-matched pool: opponents drive cars of a SIMILAR power level to the
    // player's — take the closest cars by power, then shuffle; opponents cycle
    // through the pool (pool[i % pool.length]) so a big grid just repeats the
    // matched cars in different liveries. The pool size is FIXED at the 6 closest
    // by power and is NOT scaled by `count` — the old `Math.max(count, 6)` meant a
    // large grid (11/13/15 rivals) pulled in almost the whole roster, which would
    // let a low-power player face a much higher-power rival. Capping the pool
    // keeps every rival power-matched at any grid size (worst case ~1.26x, the
    // closest-6 span, against the current 873-1289 hp roster).
    const byPower = [...carDb].sort((a, b) => Math.abs(a.specs.power - playerPower) - Math.abs(b.specs.power - playerPower));
    const pool = byPower.slice(0, Math.min(carDb.length, 6)).sort(() => Math.random() - 0.5);

    const profile = computeSpeedProfile(trackPoints, isClosed, weatherGripMult(weather));

    for (let i = 0; i < count; i++) {
      const persona = profiles[i % profiles.length];
      const carDef = pool[i % pool.length];
      // Clamp ceiling 1.9 (2026-07-21, widened-spread pass): the worst-case roll
      // is now Impossible 1.72 + pro persona 0.04 + max jitter 0.025 = 1.785, so
      // 1.9 keeps ~6% real headroom over it — enough that a future top-tier bump
      // won't silently clip. Floor unchanged (Novice 0.60 + rookie persona -0.05
      // - jitter = ~0.525, well above 0.4).
      const skill = Math.min(1.9, Math.max(0.4,
        skill0 + (Math.random() - 0.5) * 0.05 + (persona === 'pro' ? 0.04 : persona === 'rookie' ? -0.05 : 0)));
      // Performance "bonus": higher tiers get faster machinery (more grip+power),
      // so they genuinely pull away — the way you make racing AI hard once their
      // driving is already near-optimal. sqrt(perfBoost) feeds BOTH corner speed
      // (speed profile) and the top-speed cap, so it's a real across-the-board
      // pace gain. STEEPENED RAMP (was 1.06 + (skill-0.78)*0.58, ×1.2, cap 2.1):
      // a linear 1.08 + (skill-0.60)*1.02 gives a much wider tier-to-tier spread —
      // Novice ~1.08 (near player parity: a fair fight you can win outright) up to
      // Impossible ~2.22 (a ~+120% machinery edge — genuinely superhuman). This,
      // plus the far higher Novice mistake rate (skill 0.60), is what finally
      // makes the tiers feel distinct. Cap 2.6 keeps ~14% headroom over the
      // worst-case roll (~2.29) so it can't silently re-saturate.
      const perfBoost = Math.min(2.6, 1.08 + Math.max(0, skill - 0.60) * 1.02);

      const g = gridSpawn(trackPoints, isClosed, slots[i] ?? (i + 1));
      const state = initVehicleState(carDef);
      state.x = g.x; state.z = g.z; state.y = g.y; state.yaw = g.yaw;

      opponents.push({
        id: `ai_${i}`,
        name: NAMES[i % NAMES.length],
        color: COLORS[i % COLORS.length],
        profile: persona,
        carDef,
        loadout: aiLoadout(persona),
        state,
        inputs: { throttle: 0, brake: 0, steering: 0, handbrake: false, clutch: false, shiftUp: false, shiftDown: false, manualGearbox: false },
        targetSpeed: 0,
        currentTrackIndex: g.nodeIdx,
        lap: 0, // unified with the player: 0 on the grid, +1 on each line crossing
        progress: g.nodeIdx, // seed so grid standings are correct during the countdown

        lineOffset: (Math.random() - 0.5) * 1.76 * (1.6 - Math.min(1, skill)), // sharper drivers hug the ideal line (scatter -20%: rivals drive tighter lines)
        mistakeTimer: 0,
        mistakeType: 'none',
        pressureRating: 0,
        skill,
        perfBoost,
        speedProfile: profile,
        stuckTimer: 0,
        finished: false,
        finishTime: 0
      });
    }
    return opponents;
  }

  public static updateAI(
    ai: OpponentRacer,
    dt: number,
    trackPoints: TrackPoint[],
    playerState: VehicleState,
    others: OpponentRacer[],
    difficulty: string,
    isWet: boolean,
    trackId: string,
    isClosed: boolean,
    terr: { backdropY: number; hasRelief: boolean }
  ) {
    if (ai.finished) return;
    const st = ai.state;
    const n = trackPoints.length;

    // 1. Localise + read the surface under us (reused for speed, line and rail).
    const idx = TrackBuilder.nearestIndex(st.x, st.z, trackPoints, ai.currentTrackIndex, 30);
    ai.currentTrackIndex = idx;
    const seg = trackPoints[idx];
    const halfW = seg.width / 2;
    const surf = TrackBuilder.querySurface(st.x, st.z, trackPoints, isWet, trackId, idx);
    const offRoad = surf.distToCenter > halfW;

    // 2. Target speed from the precomputed braking profile. Pace is capped AT the
    //    grip limit (never above it) so skilled AI hold the apex instead of
    //    overcooking corners and sailing off — skill shows through line quality,
    //    consistency and fewer mistakes rather than superhuman corner speed.
    // sqrt(perfBoost): their boosted grip lets them corner this much faster at
    // the SAME safety margin (grip x boost, speed^2 x boost -> ratio unchanged).
    const boostSp = Math.sqrt(ai.perfBoost);
    // NOTE: weather grip is now baked into ai.speedProfile itself (see
    // weatherGripMult / computeSpeedProfile) — both the cornering AND the
    // BRAKING distances the profile assumes are already reduced for wet
    // races, so the AI actually starts slowing down earlier instead of
    // arriving at a corner too fast and only THEN targeting a lower apex
    // speed. A flat pace multiplier here on top of that would double-count
    // the same grip reduction without fixing the late-braking root cause.
    // Cap raised 1.04 -> 1.15 + slope 0.24 -> 0.19, base 0.84 -> 0.88 (found by
    // adversarial review, 2026-07-21): the old formula was ALREADY saturated at
    // 1.04 for rookie and up even before today's DIFFICULTIES bump (rookie's old
    // skill 0.86 alone gave 1.0464, over the old cap) — so amateur through
    // impossible were all getting the exact SAME base pace fraction, providing
    // zero tier-to-tier differentiation from this term (differentiation had to
    // come entirely from perfBoost/capMs downstream). The new formula keeps
    // every tier >= its old value (novice ~unchanged, everyone else strictly
    // higher) while giving genuine per-tier separation up to the 1.15 ceiling.
    // After the widened-spread DIFFICULTIES retune the top TWO tiers now saturate
    // here (Legend skill 1.44 -> 1.154 and Impossible 1.72 -> 1.207 both clamp to
    // 1.15); Expert (1.26 -> 1.119) is the last tier this term still separates.
    // That is fine — Legend vs Impossible differentiation is carried downstream by
    // perfBoost (1.94 vs 2.22), boostSp and capMs, so overall pace stays monotonic
    // (headless-verified). Anyone re-tuning this cap should know the top two tiers
    // are pinned here, not just Impossible.
    const paceMult = Math.min(1.15, 0.88 + ai.skill * 0.19)
      // Loose grip: whole-track rally OR a per-node dirt/gravel biome band (e.g.
      // Highland's Dirt Rally section) — target a gravel-appropriate corner speed
      // so the AI doesn't run wide on the asphalt profile and grind the rail.
      * (trackId === 'rally' || surf.surface === 'gravel' ? 0.75 : 1)
      // Grip-aware: street/drift-shod AI corner a touch slower so low-grip cars
      // never exceed their tyres and run wide — they hold the apex cleanly.
      * ((ai.loadout.tires === 'street' || ai.loadout.tires === 'drift') ? 0.93 : 1)
      * boostSp;
    const capMs = (40 + ai.skill * 44) * boostSp; // absolute cap (boosted top speed)
    // On sprint (open) tracks node 0 is the START, so wrapping the lookahead
    // past the finish would aim the leading AI back toward the start; clamp to
    // the last node instead. Closed tracks wrap as before (node 0 is ahead).
    const look = isClosed ? (idx + 3) % n : Math.min(n - 1, idx + 3);
    ai.targetSpeed = Math.min(capMs, ai.speedProfile[look] * paceMult);
    // Off the tarmac? Back right off and gather it up so they rejoin the ribbon
    // instead of ploughing on across the grass at racing speed.
    if (offRoad) ai.targetSpeed = Math.min(ai.targetSpeed, 15);

    // 3. Steering toward a lookahead point with apex bias.
    const speedMs = Math.abs(st.vx);
    // Capped lookahead — the old uncapped 5 + v*0.45 aimed ~27 nodes ahead at
    // speed, which cut apexes and carried the car wide. Aim closer so the line
    // actually follows the road.
    const laOff = Math.min(13, Math.floor(4 + speedMs * 0.35));
    const targetIdx = isClosed ? (idx + laOff) % n : Math.min(n - 1, idx + laOff);
    const tnode = trackPoints[targetIdx];

    // Apex-seeking: bias toward the inside of the upcoming corner. Apex
    // commitment raised 0.28 -> 0.336 (+20%, "more logical" line): the AI hugs
    // the inside of a corner more decisively, taking a tighter, faster racing
    // line instead of drifting mid-track. Still bounded by the `half` clamp
    // below and the boundary-awareness correction, so it can't clip the edge.
    const turnDir = TrackBuilder.turnDirection(trackPoints, targetIdx);
    const cornerTightness = Math.min(1, tnode.curvature * 60);
    let offset = ai.lineOffset * (1 - cornerTightness) - turnDir * cornerTightness * (seg.width * 0.336) * ai.skill;

    // Player interaction.
    const pdx = playerState.x - st.x, pdz = playerState.z - st.z;
    const playerDist = Math.hypot(pdx, pdz);
    const sy = Math.sin(st.yaw), cy = Math.cos(st.yaw);
    const playerAhead = pdx * sy + pdz * cy;   // >0 => player ahead of AI

    // Nearest car ahead of us — the PLAYER or any other racer (they used to be
    // blind to each other and pile up). Right-component is along body-frame
    // physics-right; +offset displaces along the track normal = physics-LEFT,
    // so an obstacle on the right needs +offset to swing away.
    // Awareness range 10 -> 12 m (+20%, "more logical" traffic handling): the
    // AI notices a car ahead ~20% sooner and begins its line adjustment earlier
    // and more smoothly, instead of a last-second jink at 10 m.
    let obDist = Infinity, obRight = 0;
    const consider = (x: number, z: number) => {
      const dx = x - st.x, dz = z - st.z;
      const d = Math.hypot(dx, dz);
      if (d > 12 || d >= obDist) return;
      if (dx * sy + dz * cy <= 0) return; // behind us — not our problem
      obDist = d; obRight = dx * cy - dz * sy;
    };
    consider(playerState.x, playerState.z);
    for (const o of others) if (o !== ai && !o.finished) consider(o.state.x, o.state.z);

    if (obDist < 12) {
      offset += (obRight > 0 ? 1 : -1) * 2.2;
    } else if (ai.profile === 'defensive' && playerDist < 22 && playerAhead < 0) {
      offset *= 0.25; // park it on the racing line
    } else if (ai.profile === 'aggressive' && playerDist < 16) {
      offset *= 1.35;
    }
    const half = seg.width / 2 - 1.2;
    offset = Math.max(-half, Math.min(half, offset));

    const tx = tnode.pos.x + tnode.normal.x * offset;
    const tz = tnode.pos.z + tnode.normal.z * offset;
    const toX = tx - st.x, toZ = tz - st.z;
    const fwd = toX * sy + toZ * cy;
    const right = toX * cy - toZ * sy;
    let steer = Math.max(-1, Math.min(1, Math.atan2(right, Math.max(0.5, fwd)) * 2.0));

    // Boundary awareness: as we run toward/over the edge, add a steer term back
    // toward the centreline so the AI stops wandering off on corner exits. Only
    // engages past 82% of the half-width, so it never fights the normal line.
    const edgeFrac = surf.distToCenter / halfW;
    if (edgeFrac > 0.82) {
      const back = Math.sign(surf.signedLateral) * Math.min(1, (edgeFrac - 0.82) * 2.2);
      steer = Math.max(-1, Math.min(1, steer + back));
    }

    // 4. Mistakes under pressure (skill-dependent).
    if (ai.mistakeTimer > 0) {
      ai.mistakeTimer -= dt;
      if (ai.mistakeTimer <= 0) ai.mistakeType = 'none';
    } else if (playerDist < 14 && Math.abs(playerState.vx) > speedMs && playerAhead < 0) {
      ai.pressureRating = Math.min(1, ai.pressureRating + dt * 0.12);
      if (Math.random() < Math.max(0, 1 - ai.skill) * 0.051 * ai.pressureRating * dt) { // 0.064 -> 0.051 (-20%): rivals hold their nerve under attack, defending more logically
        ai.mistakeTimer = 0.8 + Math.random() * 1.4;
        ai.mistakeType = Math.random() > 0.5 ? 'lockup' : 'wide';
      }
    } else {
      ai.pressureRating = Math.max(0, ai.pressureRating - dt * 0.15);
    }
    // Baseline sloppiness, independent of the player, scaled hard by (1-skill)^2
    // so LOW tiers genuinely make errors (and are beatable) while high tiers are
    // near-flawless. NOTE: because this term is QUADRATIC in (1-skill), a small
    // skill bump at the bottom shrinks the mistake RATE disproportionately more
    // than the same bump would at the top — i.e. it makes that tier harder
    // faster than the skill number alone suggests. The 2026-07-21 DIFFICULTIES
    // bump (found by adversarial review) took Novice's baseline mistake interval
    // from ~19s to ~30s and Rookie's from ~40s to ~78s (both tiers' skill only
    // moved +0.04) — fewer unforced AI errors is squarely "harder", just a
    // bigger jump than the skill delta implies. Tune future changes at the
    // BOTTOM of the skill ramp with this quadratic sensitivity in mind, not
    // linear intuition, or Novice/Rookie can accidentally stop feeling beatable.
    if (ai.mistakeTimer <= 0 && ai.mistakeType === 'none') {
      const sloppy = Math.max(0, 1 - ai.skill); // >=0 so impossible (skill>1) never errs
      // Wet weather multiplier (1.35x): even a skilled driver slips up more on a
      // slick surface — modest since the (1-skill)^2 term already keeps Pro+ near
      // zero regardless, so this mainly shows up for the lower/mid tiers.
      const wetMistakeMult = isWet ? 1.35 : 1;
      if (Math.random() < sloppy * sloppy * 1.28 * wetMistakeMult * dt) {
        ai.mistakeTimer = 0.5 + Math.random() * 1.0;
        ai.mistakeType = Math.random() > 0.6 ? 'lockup' : 'wide';
      }
    }

    // 5. Throttle / brake.
    let throttle = 0, brake = 0, handbrake = false;
    const errV = ai.targetSpeed - speedMs;
    if (errV > 0.5) throttle = Math.min(1, 0.35 + errV * 0.28);
    else if (errV < -1.2) brake = Math.min(1, -errV * 0.24);
    else throttle = 0.35;

    // Ease throttle while turning hard (traction management) — skilled drivers
    // modulate better and lift LESS, carrying more speed through corners.
    throttle *= 1 - Math.min(0.55, Math.abs(steer) * 0.5) * (1.15 - ai.skill * 0.45);
    // Traction control: cut power when EITHER rear wheel starts spinning up.
    // Tighter threshold in the wet (0.25 -> 0.18) — on reduced grip, wheelspin
    // builds into a power-oversteer slide faster, so the AI needs to back off
    // sooner to avoid spinning out of corners it could hold on a dry surface.
    const tcThreshold = isWet ? 0.18 : 0.25;
    if (Math.max(Math.abs(st.wheels.rl.slipRatio), Math.abs(st.wheels.rr.slipRatio)) > tcThreshold) throttle *= 0.35;
    // Don't accelerate into the player's bumper.
    if (playerDist < 8 && playerAhead > 0 && speedMs > Math.abs(playerState.vx)) { brake = Math.max(brake, 0.5); throttle = 0; }
    // Lift when right on ANY car's bumper (incl. other AI) while swerving out.
    if (obDist < 6.5) throttle = Math.min(throttle, 0.25);

    if (ai.mistakeType === 'lockup') { brake = 1; throttle = 0; steer *= 0.3; }
    else if (ai.mistakeType === 'wide') { steer *= 0.45; }

    if (ai.profile === 'drifter' && tnode.curvature > 0.05 && speedMs > 12) {
      handbrake = true; steer *= 1.25; throttle = Math.max(throttle, 0.6); brake = 0;
    }

    // Line-tracking responsiveness 10 -> 12 (+20%): the AI's steering converges
    // on its intended line ~20% faster, so it holds a cleaner, more precise line
    // through transitions and reacts quicker to corrections — "better and more
    // logical" without simply removing mistakes.
    ai.inputs.steering += (steer - ai.inputs.steering) * Math.min(1, dt * 12);
    ai.inputs.throttle = throttle;
    ai.inputs.brake = brake;
    ai.inputs.handbrake = handbrake;

    // 6. Physics on the surface queried pre-step above (with the tier perf boost).
    updateVehicle(st, dt, ai.inputs, surf.surface, ai.carDef, ai.loadout, ai.perfBoost);
    // Follow the road's elevation like the player does (App.tsx) — without this
    // the AI kept their spawn height and rendered underground / floating on any
    // track with elevation change.
    const roadY = roadHeightAt(trackPoints, idx, st.x, st.z);
    const gh = groundHeight(roadY, surf.distToCenter - seg.width / 2, terr.backdropY, terr.hasRelief);
    st.y += (gh + 0.05 - st.y) * Math.min(1, dt * 22);

    // Soft rail so AI never wanders off into the wilderness. Re-query the
    // post-step position, engage a touch earlier and pull harder than before so
    // corner-exit run-wide is reeled back in.
    const rail = TrackBuilder.querySurface(st.x, st.z, trackPoints, isWet, trackId, idx);
    const railLimit = halfW + 3.5;
    if (rail.distToCenter > railLimit) {
      const nx = -Math.sign(rail.signedLateral) * seg.normal.x;
      const nz = -Math.sign(rail.signedLateral) * seg.normal.z;
      st.x += nx * (rail.distToCenter - railLimit) * 0.7;
      st.z += nz * (rail.distToCenter - railLimit) * 0.7;
    }

    // Stuck recovery: crawling, or spun to face the wrong way — reset onto
    // the racing line after a couple of seconds.
    const trackYaw = Math.atan2(seg.tangent.x, seg.tangent.z);
    const headingDot = Math.cos(st.yaw - trackYaw);
    const isCrawling = speedMs < 2.5;
    const isWrongWay = headingDot < -0.1 && speedMs < 12;
    if (isCrawling || isWrongWay) {
      ai.stuckTimer += dt * (isWrongWay ? 1.6 : 1);
      if (ai.stuckTimer > 2.2) {
        ai.stuckTimer = 0;
        const node = trackPoints[idx];
        st.x = node.pos.x; st.z = node.pos.z; st.y = node.pos.y + 0.05;
        st.yaw = trackYaw;
        st.vx = 9; st.vz = 0; st.yawRate = 0;
      }
    } else {
      ai.stuckTimer = Math.max(0, ai.stuckTimer - dt * 2);
    }

    ai.progress = isClosed ? ai.lap * n + idx : idx;
  }
}
