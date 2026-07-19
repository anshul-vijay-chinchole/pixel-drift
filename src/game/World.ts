import * as THREE from 'three';

export interface TrackPoint {
  pos: THREE.Vector3;
  width: number;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;   // (-tangent.z, 0, tangent.x): PHYSICS-left of travel = the viewer's RIGHT through the chase cam
  curvature: number;       // tangent turn between adjacent nodes
  dist: number;            // cumulative arc length from start (m)
  biome?: TrackTheme;      // per-section theme for multi-biome tracks (scenery + ground tint)
  dirt?: boolean;          // this section is loose dirt/gravel (physics + look)
}

export type TrackTheme = 'harbour' | 'mountain' | 'coast' | 'airport' | 'forest' | 'city' | 'desert';

// A multi-biome track hands out a per-section theme (and optional dirt surface)
// along its length so one big loop can pass through city, forest, mountain and
// desert. `until` is the arc-length fraction (0..1) where this biome ends.
export interface BiomeBand { until: number; theme: TrackTheme; dirt?: boolean; }

export interface TrackDefinition {
  id: string;
  name: string;
  description: string;
  points: THREE.Vector3[];
  width: number;
  isClosed: boolean;
  theme: TrackTheme;
  groundColor: string;
  roadColor: string;
  idealLine: THREE.Vector2[];
  length: number; // metres (filled at build)
  biomes?: BiomeBand[]; // optional per-section biomes (multi-biome flagship)
}

// How far past the road edge you can go before the invisible wall / drop-off,
// per theme. Shared by the physics boundary (App), the guardrail markers and
// scenery placement (Graphics) so all three agree on where the edge is.
export const WALL_MARGIN: Record<string, number> = {
  city: 2.4, harbour: 7, coast: 8, mountain: 5, airport: 10, forest: 9, desert: 9
};
export function wallMargin(theme: string): number { return WALL_MARGIN[theme] ?? 8; }

// Terrain skirt rings (shared by the Graphics skirt mesh AND car grounding, so
// the car always sits on the surface it can see): lateral distance beyond the
// road edge (m) and the fraction fallen toward the backdrop plane.
export const SKIRT_OFFS = [0, 18, 60, 150];
export const SKIRT_TS = [0, 0.15, 0.6, 0.92];

// Smoothly interpolated road height under a world point near node `idx` — the
// car projects onto the idx→idx+1 segment so its height tracks the road exactly
// instead of stair-stepping between discrete node heights (which, with follow
// lag, made the car sink into climbs and float over descents).
export function roadHeightAt(tp: TrackPoint[], idx: number, x: number, z: number): number {
  const a = tp[idx];
  const b = tp[Math.min(idx + 1, tp.length - 1)];
  const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-4) return a.pos.y;
  const f = Math.max(0, Math.min(1, ((x - a.pos.x) * dx + (z - a.pos.z) * dz) / len2));
  return a.pos.y + (b.pos.y - a.pos.y) * f;
}

export function terrainInfo(tp: TrackPoint[]): { backdropY: number; hasRelief: boolean } {
  let minY = Infinity, maxY = -Infinity;
  for (const p of tp) { if (p.pos.y < minY) minY = p.pos.y; if (p.pos.y > maxY) maxY = p.pos.y; }
  return { backdropY: Math.min(0, minY) - 0.15, hasRelief: maxY - minY > 1.5 };
}

// Ground height `offDist` metres beyond the road edge (<=0 => on the road, i.e.
// node height). FLAT tracks ramp down to the single backdrop plane over the
// first few metres; ELEVATED tracks follow the skirt rings toward the backdrop.
// One source of truth means the car never floats above or sinks below what's
// drawn.
export function groundHeight(nodeY: number, offDist: number, backdropY: number, hasRelief: boolean): number {
  if (offDist <= 0) return nodeY;
  if (!hasRelief) return nodeY + (backdropY - nodeY) * Math.min(1, offDist / 4);
  // base = nodeY (NOT nodeY-0.12) so the relief branch is continuous with the
  // offDist<=0 guard and the skirt inner ring — otherwise the car sank ~12 cm
  // into the drawn terrain right at the road edge.
  const base = nodeY, target = backdropY + 0.03;
  let t = SKIRT_TS[SKIRT_TS.length - 1];
  for (let k = 1; k < SKIRT_OFFS.length; k++) {
    if (offDist <= SKIRT_OFFS[k]) {
      const f = (offDist - SKIRT_OFFS[k - 1]) / (SKIRT_OFFS[k] - SKIRT_OFFS[k - 1]);
      t = SKIRT_TS[k - 1] + (SKIRT_TS[k] - SKIRT_TS[k - 1]) * f;
      break;
    }
  }
  return base + (target - base) * t;
}

export class TrackBuilder {
  public static buildSplineTrack(points: THREE.Vector3[], width: number, isClosed: boolean): TrackPoint[] {
    const curve = new THREE.CatmullRomCurve3(points, isClosed, 'catmullrom', 0.5);
    const divisions = Math.max(140, points.length * 16);
    const raw: { pos: THREE.Vector3; tangent: THREE.Vector3 }[] = [];

    const count = isClosed ? divisions : divisions + 1;
    for (let i = 0; i < count; i++) {
      const t = i / divisions;
      raw.push({
        pos: curve.getPointAt(Math.min(1, t)),
        tangent: curve.getTangentAt(Math.min(1, t)).normalize()
      });
    }

    const trackPoints: TrackPoint[] = [];
    let cumDist = 0;
    for (let i = 0; i < raw.length; i++) {
      const { pos, tangent } = raw[i];
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      const prev = raw[(i - 1 + raw.length) % raw.length];
      if (i > 0) cumDist += pos.distanceTo(raw[i - 1].pos);
      const curvature = 1 - Math.min(1, Math.max(-1, tangent.dot(prev.tangent)));
      trackPoints.push({ pos, width, tangent, normal, curvature, dist: cumDist });
    }
    return trackPoints;
  }

  // Tag each built point with its biome + dirt flag from the track's biome
  // bands (by arc-length fraction), so scenery, ground tint and the physics
  // surface all switch together as the loop passes through each region.
  public static assignBiomes(tp: TrackPoint[], biomes?: BiomeBand[]): void {
    if (!biomes || !biomes.length) return;
    const total = tp[tp.length - 1].dist || 1;
    for (const p of tp) {
      const frac = p.dist / total;
      const band = biomes.find(b => frac <= b.until) || biomes[biomes.length - 1];
      p.biome = band.theme;
      p.dirt = !!band.dirt;
    }
  }

  // Signed curvature direction at a node: >0 = turning toward PHYSICS-right
  // (cos yaw, -sin yaw), i.e. the -normal side (the viewer sees that as a LEFT
  // turn through the chase cam). Consumers (AI apex bias) pair it with -normal,
  // so the two signs cancel frame-independently.
  public static turnDirection(tp: TrackPoint[], i: number): number {
    const n = tp.length;
    const a = tp[i].tangent, b = tp[(i + 1) % n].tangent;
    const crossY = a.z * b.x - a.x * b.z;
    return Math.sign(crossY);
  }

  public static nearestIndex(x: number, z: number, tp: TrackPoint[], hint: number, window = 40): number {
    let best = hint, bestD = Infinity;
    const n = tp.length;
    for (let k = -window; k <= window; k++) {
      const i = ((hint + k) % n + n) % n;
      const dx = tp[i].pos.x - x, dz = tp[i].pos.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  public static querySurface(
    x: number, z: number, tp: TrackPoint[], isWet: boolean, trackId: string, hint = 0
  ): { surface: string; distToCenter: number; signedLateral: number; segmentIndex: number; onCurb: boolean } {
    const idx = this.nearestIndex(x, z, tp, hint, tp.length < 90 ? tp.length : 45);
    const closest = tp[idx];
    const toX = x - closest.pos.x, toZ = z - closest.pos.z;
    const signedLateral = toX * closest.normal.x + toZ * closest.normal.z;
    const lateral = Math.abs(signedLateral);
    const halfWidth = closest.width / 2;

    const dirt = trackId === 'rally' || !!closest.dirt; // whole-track rally OR a per-section dirt biome
    let surface = 'grass';
    let onCurb = false;
    if (lateral <= halfWidth) {
      if (dirt) {
        surface = 'gravel';
      } else {
        surface = isWet ? 'asphalt_wet' : 'asphalt_dry';
      }
      if (!dirt && lateral > halfWidth - 1.1) onCurb = true;
    } else if (lateral <= halfWidth + 6) {
      // Wider run-off apron (was 3.5 m) — a gravel/sand shoulder you can drop a
      // wheel onto and recover, before it turns into slow grass further out.
      surface = dirt ? 'grass' : trackId === 'drag' || trackId === 'highway' || trackId === 'canyon' ? 'sand' : 'gravel';
    }
    return { surface, distToCenter: lateral, signedLateral, segmentIndex: idx, onCurb };
  }
}

/* ============================================================================
 * TRACKS — hand-laid technical layouts: straights, sweepers, chicanes,
 * hairpins and esses (no more featureless ovals).
 * ==========================================================================*/
export const TRACKS: Record<string, TrackDefinition> = {
  highland: {
    id: 'highland', name: 'Highland Run', theme: 'mountain',
    description: 'THE flagship. An 8 km mega circuit that leaves downtown, climbs sweepers through Forest Valley to a 90 m mountain summit, threads a ridge esses complex, rifles down a long coastal Highway Straight, kicks loose through a Dirt Rally chicane and a tight Canyon Run, sweeps the sea-level Industrial Port and climbs one last time to the Hilltop Viewpoint before plunging back to the line. Eight regions, 18 corners, every corner type — one lap.',
    width: 15, isClosed: true, groundColor: '#38432f', roadColor: '#33333b',
    // Biome bands by arc-length fraction — the eight regions of Highland Run.
    // Scenery, per-node ground tint and (on the rally band) the physics surface
    // all switch together as the loop passes through each region.
    biomes: [
      { until: 0.10, theme: 'city' },              // Downtown  (start/finish + tight 90 left)
      { until: 0.19, theme: 'forest' },            // Forest Valley (climbing sweepers)
      { until: 0.40, theme: 'mountain' },          // Mountain Pass + ridge (summit ~90 m)
      { until: 0.56, theme: 'coast' },             // Highway Straight (long, descending, top speed)
      { until: 0.66, theme: 'desert', dirt: true },// Dirt Rally (loose surface + chicane)
      { until: 0.74, theme: 'desert' },            // Canyon Run (tight red-rock technical)
      { until: 0.82, theme: 'harbour' },           // Industrial Port (sea level, wide, cranes)
      { until: 0.93, theme: 'mountain' },          // Hilltop Viewpoint (climb + tight final)
      { until: 1.01, theme: 'city' },              // Downtown return to the line
    ],
    points: [
      // DOWNTOWN (city): long start straight + a tight ~90 left (flat)
      new THREE.Vector3(560, 0, -10),   // 0  START/FINISH
      new THREE.Vector3(830, 0, -8),    // 1  straight through the line
      new THREE.Vector3(1010, 1, 2),    // 2  approach / brake
      new THREE.Vector3(1086, 3, 46),   // 3  turn-in
      new THREE.Vector3(1104, 6, 96),   // 4  apex-in
      new THREE.Vector3(1064, 9, 132),  // 5  apex (V)
      new THREE.Vector3(1006, 12, 150), // 6  exit
      // FOREST VALLEY (forest): climbing sweepers + a medium left
      new THREE.Vector3(1000, 20, 340), // 7
      new THREE.Vector3(1060, 32, 520), // 8  sweeper right
      new THREE.Vector3(986, 44, 650),  // 9  medium left
      new THREE.Vector3(1016, 54, 748), // 10
      new THREE.Vector3(1084, 62, 838), // 11 climbing right
      // MOUNTAIN PASS (mountain): tight climbing left + summit
      new THREE.Vector3(1240, 68, 904), // 12 climb east
      new THREE.Vector3(1402, 72, 940), // 13 approach
      new THREE.Vector3(1482, 75, 978), // 14 turn-in
      new THREE.Vector3(1508, 80, 1030),// 15 apex-in
      new THREE.Vector3(1470, 85, 1074),// 16 apex (V)
      new THREE.Vector3(1398, 89, 1092),// 17
      new THREE.Vector3(1310, 90, 1104),// 18 SUMMIT (top ~90 m)
      // RIDGE + descent (fast esses)
      new THREE.Vector3(1196, 88, 1150),// 19
      new THREE.Vector3(1104, 85, 1258),// 20 ridge ess
      new THREE.Vector3(1180, 80, 1360),// 21 ess-back
      new THREE.Vector3(1092, 73, 1462),// 22 ridge
      new THREE.Vector3(900, 67, 1502), // 23
      new THREE.Vector3(724, 59, 1440), // 24 descending sweep
      // HIGHWAY STRAIGHT (coast): long, descending, top speed
      new THREE.Vector3(560, 54, 1430), // 25 highway begins
      new THREE.Vector3(200, 48, 1446), // 26 long straight
      new THREE.Vector3(-160, 44, 1416),// 27
      new THREE.Vector3(-430, 40, 1360),// 28 highway ends
      // DIRT RALLY (desert dirt): bumpy + sharp chicane
      new THREE.Vector3(-606, 35, 1236),// 29
      new THREE.Vector3(-700, 31, 1092),// 30
      new THREE.Vector3(-666, 28, 940), // 31 chicane R
      new THREE.Vector3(-576, 29, 850), // 32
      new THREE.Vector3(-648, 25, 742), // 33 chicane L
      new THREE.Vector3(-724, 21, 636), // 34
      // CANYON RUN (desert): tight technical, descending
      new THREE.Vector3(-812, 17, 502), // 35
      new THREE.Vector3(-848, 13, 408), // 36 tight left
      new THREE.Vector3(-812, 11, 336), // 37 apex
      new THREE.Vector3(-706, 10, 300), // 38 tight right
      new THREE.Vector3(-712, 8, 176),  // 39 exit
      // INDUSTRIAL PORT (harbour): sea level, wide sweepers
      new THREE.Vector3(-560, 5, 44),   // 40
      new THREE.Vector3(-360, 2, -40),  // 41
      new THREE.Vector3(-150, 0, -62),  // 42
      // HILLTOP VIEWPOINT (mountain): climb + tight final + plunge
      new THREE.Vector3(70, 6, -40),    // 43 approach
      new THREE.Vector3(214, 18, 6),    // 44 climb
      new THREE.Vector3(300, 30, 92),   // 45
      new THREE.Vector3(336, 38, 186),  // 46
      new THREE.Vector3(340, 40, 214),  // 47 HILLTOP overlook (peak ~40 m)
      new THREE.Vector3(316, 38, 258),  // 48 tight final in
      new THREE.Vector3(258, 33, 286),  // 49
      new THREE.Vector3(188, 26, 286),  // 50 apex
      new THREE.Vector3(150, 21, 250),  // 51 V-tighten
      new THREE.Vector3(96, 11, 180),   // 52 plunge
      new THREE.Vector3(92, 3, 80),     // 53 descend toward downtown
      new THREE.Vector3(200, 0, -10),   // 54 merge onto start straight
      new THREE.Vector3(410, 0, -10),   // 55 into start/finish
    ],
    idealLine: [], length: 0
  },
  circuit: {
    id: 'circuit', name: 'Harbour GP Circuit', theme: 'harbour',
    description: 'Seaside GP track: long pit straight, fast T1 sweeper, dock chicane, a proper hairpin and a rhythm section of esses.',
    width: 15, isClosed: true, groundColor: '#25402b', roadColor: '#37373d',
    points: [
      // Start/finish sits mid-straight so the spawn tangent is dead straight.
      new THREE.Vector3(-120, 0, 0), new THREE.Vector3(30, 0, 0),                                       // pit straight
      new THREE.Vector3(140, 0, 20), new THREE.Vector3(205, 0, 90),                                     // T1 fast sweeper
      new THREE.Vector3(215, 0, 180),                                                                    // short chute
      new THREE.Vector3(150, 0, 225), new THREE.Vector3(140, 0, 300),                                   // dock chicane
      new THREE.Vector3(200, 0, 370), new THREE.Vector3(185, 0, 455),                                   // approach
      new THREE.Vector3(105, 0, 485), new THREE.Vector3(55, 0, 420),                                    // hairpin
      new THREE.Vector3(75, 0, 330), new THREE.Vector3(0, 0, 285),                                      // esses 1
      new THREE.Vector3(-85, 0, 330), new THREE.Vector3(-150, 0, 405),                                  // esses 2
      new THREE.Vector3(-245, 0, 415), new THREE.Vector3(-290, 0, 330),                                 // lighthouse curve
      new THREE.Vector3(-275, 0, 205), new THREE.Vector3(-255, 0, 90),                                  // final bend
      new THREE.Vector3(-240, 0, 0)                                                                      // onto the straight
    ],
    idealLine: [], length: 0
  },
  highway: {
    id: 'highway', name: 'Bay Bridge Sprint', theme: 'coast',
    description: 'A 3.6km coastal freeway with flowing sweepers, elevation over the great sea bridge, and live traffic.',
    width: 22, isClosed: false, groundColor: '#1d3a4a', roadColor: '#33343a',
    points: [
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(250, 2, 40), new THREE.Vector3(550, 8, 140),
      new THREE.Vector3(900, 16, 120), new THREE.Vector3(1250, 18, 40), new THREE.Vector3(1600, 12, 90),
      new THREE.Vector3(1950, 6, 220), new THREE.Vector3(2300, 0, 260), new THREE.Vector3(2650, 0, 160),
      new THREE.Vector3(3000, 2, 80), new THREE.Vector3(3350, 0, 140), new THREE.Vector3(3600, 0, 220)
    ],
    idealLine: [], length: 0
  },
  drag: {
    id: 'drag', name: 'Airport Quarter Mile', theme: 'airport',
    description: 'Dead straight, dead flat. Nail the launch, bang the shifts, chase the trap speed.',
    width: 20, isClosed: false, groundColor: '#3a3a32', roadColor: '#2f2f34',
    points: [
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 120), new THREE.Vector3(0, 0, 240),
      new THREE.Vector3(0, 0, 360), new THREE.Vector3(0, 0, 480), new THREE.Vector3(0, 0, 600),
      new THREE.Vector3(0, 0, 720)
    ],
    idealLine: [], length: 0
  },
  rally: {
    id: 'rally', name: 'Redwood Rally Stage', theme: 'forest',
    description: 'A pulsing dirt loop through towering redwoods — crests, cambered wiggles and slippery mud everywhere.',
    width: 11, isClosed: true, groundColor: '#33461f', roadColor: '#7a5c3a',
    points: [
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(120, 5, 30), new THREE.Vector3(200, 9, 120),
      new THREE.Vector3(160, 3, 230), new THREE.Vector3(240, -2, 320), new THREE.Vector3(180, 7, 420),
      new THREE.Vector3(60, 2, 480), new THREE.Vector3(-70, 9, 430), new THREE.Vector3(-140, 4, 320),
      new THREE.Vector3(-90, -2, 230), new THREE.Vector3(-160, 6, 140), new THREE.Vector3(-90, 3, 40)
    ],
    idealLine: [], length: 0
  },
  city: {
    id: 'city', name: 'Downtown Night Circuit', theme: 'city',
    description: 'Neon street blocks with two inner-city notches: 90° corners, concrete walls, zero run-off.',
    width: 13, isClosed: true, groundColor: '#141422', roadColor: '#2a2a33',
    points: [
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(170, 0, 0),                                          // main straight
      new THREE.Vector3(205, 0, 40), new THREE.Vector3(205, 0, 150),                                     // 90 right, north
      new THREE.Vector3(170, 0, 190), new THREE.Vector3(90, 0, 190),                                     // inner notch 1
      new THREE.Vector3(55, 0, 230), new THREE.Vector3(55, 0, 330),                                      // uptown
      new THREE.Vector3(90, 0, 370), new THREE.Vector3(200, 0, 370),                                     // east jog
      new THREE.Vector3(235, 0, 410), new THREE.Vector3(200, 0, 445),                                    // top-right corner
      new THREE.Vector3(60, 0, 445), new THREE.Vector3(-60, 0, 445),                                     // top straight
      new THREE.Vector3(-105, 0, 410), new THREE.Vector3(-105, 0, 300),                                  // down west side
      new THREE.Vector3(-70, 0, 260), new THREE.Vector3(-70, 0, 170),                                    // inner notch 2
      new THREE.Vector3(-105, 0, 130), new THREE.Vector3(-105, 0, 40),
      new THREE.Vector3(-60, 0, -5)                                                                       // final corner home
    ],
    idealLine: [], length: 0
  },
  apex: {
    id: 'apex', name: 'Apex Grand Prix', theme: 'harbour',
    description: 'A polished 2.5 km grand-prix circuit: a long pit straight into a fast rising right-hander, a downhill esses complex, a stadium hairpin and a flat-out sweep back to the line. Elevation everywhere.',
    width: 14, isClosed: true, groundColor: '#25402b', roadColor: '#34343c',
    points: [
      new THREE.Vector3(-180, 0, 0), new THREE.Vector3(50, 0, 0), new THREE.Vector3(270, 0, 0),      // pit straight (start line mid-straight)
      new THREE.Vector3(400, 5, 75), new THREE.Vector3(445, 12, 200),                                 // T1 rising right-hander
      new THREE.Vector3(400, 18, 320), new THREE.Vector3(285, 22, 375),                               // crest into T2
      new THREE.Vector3(150, 20, 350), new THREE.Vector3(45, 17, 300),                                // fast left kink
      new THREE.Vector3(95, 15, 210), new THREE.Vector3(10, 13, 165),                                 // downhill esses
      new THREE.Vector3(-35, 13, 250), new THREE.Vector3(-150, 12, 335),                              // sweep to the top-left
      new THREE.Vector3(-300, 10, 320), new THREE.Vector3(-420, 6, 245),                              // far-left downhill
      new THREE.Vector3(-475, 3, 135), new THREE.Vector3(-435, 1, 45),                                // stadium hairpin
      new THREE.Vector3(-315, 0, 12), new THREE.Vector3(-235, 0, 0)                                   // exit onto the straight
    ],
    idealLine: [], length: 0
  },
  canyon: {
    id: 'canyon', name: 'Desert Canyon Run', theme: 'desert',
    description: 'Sun-baked sweepers through red-rock country: a climbing ess, a long canyon run and a wide loop back through the wash.',
    width: 13, isClosed: true, groundColor: '#b48a5a', roadColor: '#4a4448',
    points: [
      // Node 0 at -50 leaves a 210 m straight behind it — the whole grid
      // (4 rows) spawns aligned instead of wrapping into the final corner.
      new THREE.Vector3(-50, 0, 0), new THREE.Vector3(40, 0, 0),                                        // start straight
      new THREE.Vector3(140, 3, 40), new THREE.Vector3(190, 6, 130),                                    // T1 sweeper
      new THREE.Vector3(150, 10, 220), new THREE.Vector3(60, 12, 250),                                  // climbing arc
      new THREE.Vector3(-10, 12, 330), new THREE.Vector3(60, 10, 410),                                  // canyon ess
      new THREE.Vector3(170, 8, 450), new THREE.Vector3(240, 6, 540),                                   // canyon run
      new THREE.Vector3(200, 4, 640), new THREE.Vector3(80, 2, 660),                                    // far turn
      new THREE.Vector3(-60, 2, 620), new THREE.Vector3(-150, 4, 520),                                  // the wash
      new THREE.Vector3(-190, 6, 400), new THREE.Vector3(-160, 4, 280),                                 // return sweep
      new THREE.Vector3(-240, 2, 150), new THREE.Vector3(-260, 0, 0)                                    // last corner home
    ],
    idealLine: [], length: 0
  },
  oval: {
    id: 'oval', name: 'Sunset Speedway', theme: 'airport',
    description: 'A flat-out concrete speedway oval. Slipstream the pack, hold your line, and never lift.',
    width: 17, isClosed: true, groundColor: '#3a3a32', roadColor: '#38383e',
    points: [
      // Long collinear run behind node 0 so the grid spawns straight, and a
      // wide turn-4 exit that blends into the straight (a tight last point
      // used to kink the spline right at start/finish).
      new THREE.Vector3(-40, 0, 0), new THREE.Vector3(70, 0, 0), new THREE.Vector3(180, 0, 0),          // front straight
      new THREE.Vector3(245, 0, 80), new THREE.Vector3(245, 0, 220),                                    // turns 1-2
      new THREE.Vector3(170, 0, 300), new THREE.Vector3(0, 0, 300), new THREE.Vector3(-170, 0, 300),    // back straight
      new THREE.Vector3(-245, 0, 220), new THREE.Vector3(-245, 0, 80),                                  // turns 3-4
      new THREE.Vector3(-180, 0, 0)                                                                      // onto the straight
    ],
    idealLine: [], length: 0
  },
  seaside: {
    id: 'seaside', name: 'Riviera Seaside Circuit', theme: 'coast',
    description: 'A flowing clifftop ribbon above the marina: quick direction changes, one long drop toward the sea, then hard back onto the front straight.',
    width: 14, isClosed: true, groundColor: '#2e4a3a', roadColor: '#3a3a40',
    points: [
      // Node 0 sits 150 m into the straight so the whole AI grid spawns on it.
      new THREE.Vector3(-90, 0, 0), new THREE.Vector3(60, 0, 0),                                        // pit straight
      new THREE.Vector3(150, 2, 35), new THREE.Vector3(220, 4, 120),                                    // rising sweeper
      new THREE.Vector3(240, 6, 240), new THREE.Vector3(180, 4, 340),                                   // clifftop crest
      new THREE.Vector3(60, 2, 380), new THREE.Vector3(-40, 4, 440),                                    // marina esses
      new THREE.Vector3(-160, 6, 420), new THREE.Vector3(-230, 4, 320),                                 // headland curve
      new THREE.Vector3(-210, 2, 200), new THREE.Vector3(-260, 0, 90),                                  // drop to the sea
      new THREE.Vector3(-240, 0, 0)                                                                      // final corner home
    ],
    idealLine: [], length: 0
  },
  grandtour: {
    id: 'grandtour', name: 'Grand Tour Megacircuit', theme: 'mountain',
    description: 'A colossal 6.5 km grand tour that leaves downtown, climbs through pine forest to a 55 m alpine summit, threads a ridge-top esses complex, plunges into a loose desert dirt descent, sweeps a grassy hillside and rifles back down a long straight to the line. City, forest, mountain and dirt — every kind of corner, one lap.',
    width: 14, isClosed: true, groundColor: '#3a4436', roadColor: '#34343c',
    // Biomes by arc-length fraction: downtown start -> pine forest climb ->
    // alpine mountain ridge -> forest descent -> desert DIRT section -> grassy
    // hill -> back onto the city start straight. Scenery, ground tint and the
    // physics surface all switch with these bands.
    biomes: [
      { until: 0.05, theme: 'city' },
      { until: 0.19, theme: 'forest' },
      { until: 0.49, theme: 'mountain' },
      { until: 0.61, theme: 'forest' },
      { until: 0.81, theme: 'desert', dirt: true },
      { until: 0.90, theme: 'coast' },   // open grassy hillside (grass ground)
      { until: 1.01, theme: 'city' },
    ],
    points: [
      new THREE.Vector3(459, 0, -14),                                                  // 0: START/FINISH (end of the city straight)
      new THREE.Vector3(702, 5, 81), new THREE.Vector3(864, 14, 230),                  // rising T1 out of downtown
      new THREE.Vector3(972, 29, 432), new THREE.Vector3(1067, 41, 662),               // into the pine forest, climbing hard
      new THREE.Vector3(1175, 50, 891), new THREE.Vector3(1323, 55, 1107),             // summit approach (top ~55 m)
      new THREE.Vector3(1499, 53, 1283), new THREE.Vector3(1620, 48, 1445),            // the alpine summit sweep
      new THREE.Vector3(1539, 41, 1580), new THREE.Vector3(1310, 36, 1593),            // ridge esses (top of the world)
      new THREE.Vector3(1067, 31, 1539), new THREE.Vector3(824, 29, 1607),             // ridge esses cont.
      new THREE.Vector3(581, 26, 1539), new THREE.Vector3(338, 22, 1593),              // fast forest descent begins
      new THREE.Vector3(149, 17, 1472), new THREE.Vector3(54, 12, 1269),               // plunge down the north face
      new THREE.Vector3(-41, 10, 1067), new THREE.Vector3(-149, 7, 878),               // into the desert wash (DIRT)
      new THREE.Vector3(-243, 7, 675), new THREE.Vector3(-189, 7, 486),                // dirt switchback
      new THREE.Vector3(-324, 5, 338), new THREE.Vector3(-432, 2, 176),                // dirt run to the far corner
      new THREE.Vector3(-486, 0, 27), new THREE.Vector3(-432, 0, -108),                // grassy hillside U-turn
      new THREE.Vector3(-351, 0, -83), new THREE.Vector3(-270, 0, -58),                // onto the long city back straight (both on the P24->P27 line: no switchback)
      new THREE.Vector3(-81, 0, 0), new THREE.Vector3(189, 0, 14),                     // the ~800 m start straight (grid forms up here)
    ],
    idealLine: [], length: 0
  }
};

// Populate ideal line + length for AI + minimap + thumbnails.
Object.values(TRACKS).forEach(t => {
  const built = TrackBuilder.buildSplineTrack(t.points, t.width, t.isClosed);
  t.idealLine = built.map(p => new THREE.Vector2(p.pos.x, p.pos.z));
  t.length = built[built.length - 1].dist;
});
