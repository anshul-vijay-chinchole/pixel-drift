import React, { createContext, useContext, useState, useEffect } from 'react';

export interface CarSpecs {
  mass: number; // kg
  power: number; // hp
  peakTorque: number; // Nm
  redline: number; // RPM
  driveType: 'RWD' | 'FWD' | 'AWD';
  dragCoefficient: number;
  downforceMultiplier: number;
  weightDistribution: number; // front axle share of weight
  baseGrip: number;
  brakes: number;
  gearRatios: number[];
  finalDrive: number;
}

// Distinct archetypes with REAL trade-offs — NOT a "same overall pace" fleet and
// NOT a strict better/worse ladder. Every car is quick and pulls hard (the whole
// grid got faster + more powerful), but each one MAXES one or two things and pays
// for it somewhere obvious: the muscle car has monster power + top speed but the
// worst grip/handling; the grip cars corner like nothing else but give away
// power; the AWD cars own the wet/dirt yet lug the most weight; the exotics are
// outright fastest but demanding and heavy. Which car wins depends on the TRACK
// and WEATHER, so the choice is a real decision, not "pick the newest one".
// Attachments then customise from there.
export type CarClass = 'DRIFT' | 'GRIP' | 'SPEED' | 'TURBO' | 'RALLY' | 'MUSCLE' | 'BALANCED';

export interface CarDefinition {
  id: string;
  name: string;
  class: CarClass;
  description: string;
  specs: CarSpecs;
}

/* ============================================================================
 * LOADOUT SYSTEM — Call-of-Duty-style attachment slots.
 * Every part is FREE; each choice trades one property for another.
 * ==========================================================================*/
export type EngineId = 'stock' | 'vtec' | 'rotary' | 'v8' | 'electric';
export type InductionId = 'na' | 'turbo' | 'twinturbo' | 'supercharger';
export type TireId = 'street' | 'sport' | 'slick' | 'rally' | 'drift';
export type SuspId = 'comfort' | 'sport' | 'race' | 'rally' | 'drift';
export type DiffId = 'open' | 'lsd' | 'locked';
export type GearboxId = 'auto' | 'sequential' | 'dct' | 'manual';
export type BrakeId = 'stock' | 'sport' | 'carbon';
export type WeightId = 'stock' | 'stripped' | 'carbon';
export type AeroId = 'none' | 'lip' | 'gt' | 'big';

export interface CarLoadout {
  // Style
  color: string;
  neonColor: string;
  plate: string;
  // Attachments
  engine: EngineId;
  induction: InductionId;
  tires: TireId;
  suspension: SuspId;
  diff: DiffId;
  gearbox: GearboxId;
  brakes: BrakeId;
  weight: WeightId;
  aero: AeroId;
}

export const DEFAULT_LOADOUT: CarLoadout = {
  // color '' means "unpainted" -> getLoadout resolves it to the car's signature
  // colour. Using an empty sentinel (not a real hex) means a player who picks any
  // real colour, including the old legacy red, keeps exactly what they chose.
  color: '', neonColor: 'none', plate: 'PIXEL',
  engine: 'stock', induction: 'na', tires: 'street', suspension: 'sport',
  diff: 'lsd', gearbox: 'sequential', brakes: 'stock', weight: 'stock', aero: 'none'
};

export type LoadoutSlotKey = 'engine' | 'induction' | 'tires' | 'suspension' | 'diff' | 'gearbox' | 'brakes' | 'weight' | 'aero';

export interface PartOption {
  id: string;
  name: string;
  blurb: string;
  pros: string[];
  cons: string[];
}
export interface PartSlotDef {
  key: LoadoutSlotKey;
  label: string;
  options: PartOption[];
}

export const PART_SLOTS: PartSlotDef[] = [
  {
    key: 'engine', label: 'ENGINE',
    options: [
      { id: 'stock', name: 'Factory Engine', blurb: 'The engine the car left the factory with.', pros: ['Balanced & predictable'], cons: ['Nothing special'] },
      { id: 'vtec', name: 'High-Rev i-VTEC', blurb: 'Screams to 8,800 RPM with a wild top-end.', pros: ['+10% power', 'High redline'], cons: ['Less mid-range torque'] },
      { id: 'rotary', name: 'Twin-Rotor 13B', blurb: 'Tiny, light, spins to the moon.', pros: ['9,000 RPM redline', '-25 kg'], cons: ['Peaky, less torque'] },
      { id: 'v8', name: '6.2L V8 Swap', blurb: 'A massive wave of torque everywhere.', pros: ['+35% torque', 'Strong everywhere'], cons: ['+45 kg over the nose', 'Low redline'] },
      { id: 'electric', name: 'EV Dual-Motor', blurb: 'Instant silent thrust, single-speed drive.', pros: ['Instant torque', 'No shifting needed'], cons: ['+120 kg battery', 'No engine drama'] }
    ]
  },
  {
    key: 'induction', label: 'INDUCTION',
    options: [
      { id: 'na', name: 'Naturally Aspirated', blurb: 'Crisp, immediate throttle response.', pros: ['+5% torque, always on', 'Instant response'], cons: ['No boost headroom'] },
      { id: 'turbo', name: 'Single Turbo', blurb: 'Strong mid-range once it spools.', pros: ['Big boost when spooled'], cons: ['Turbo lag', 'Nothing before spool'] },
      { id: 'twinturbo', name: 'Twin Turbo', blurb: 'Violent top-end when both snails wake up.', pros: ['Massive peak boost'], cons: ['Heavy lag', 'Snappy on corner exit'] },
      { id: 'supercharger', name: 'Supercharger', blurb: 'Belt-driven boost from idle.', pros: ['Instant boost from idle'], cons: ['Modest peak', '+20 kg'] }
    ]
  },
  {
    key: 'tires', label: 'TIRES',
    options: [
      { id: 'street', name: 'Street Radials', blurb: 'All-round rubber for any weather.', pros: ['Good in rain', 'Predictable'], cons: ['Modest peak grip'] },
      { id: 'sport', name: 'Sport Compound', blurb: 'Sticky tarmac rubber.', pros: ['+7% tarmac grip'], cons: ['Slightly worse in rain'] },
      { id: 'slick', name: 'Racing Slicks', blurb: 'Max dry grip, zero tread.', pros: ['+16% dry grip'], cons: ['Terrible in rain', 'Poor off-road'] },
      { id: 'rally', name: 'Rally Knobbies', blurb: 'Deep tread bites into dirt.', pros: ['+35% grip on dirt/grass'], cons: ['Less tarmac grip'] },
      { id: 'drift', name: 'Drift Spec', blurb: 'Hard rear compound built to slide.', pros: ['Easy, long slides', 'Smoke machine'], cons: ['Less rear grip', 'Slower lap times'] }
    ]
  },
  {
    key: 'suspension', label: 'SUSPENSION',
    options: [
      { id: 'comfort', name: 'Comfort', blurb: 'Soft springs, forgiving over everything.', pros: ['Very stable', 'Forgiving'], cons: ['Body roll', 'Lazy response'] },
      { id: 'sport', name: 'Sport Coilovers', blurb: 'The balanced setup.', pros: ['Good all-rounder'], cons: ['Master of none'] },
      { id: 'race', name: 'Race Spec', blurb: 'Stiff, low and aggressive.', pros: ['Sharp turn-in', '+4% tarmac grip'], cons: ['Poor on dirt'] },
      { id: 'rally', name: 'Rally Long-Travel', blurb: 'Soaks up jumps and ruts.', pros: ['+15% loose-surface grip', 'Eats bumps'], cons: ['Rolly on tarmac'] },
      { id: 'drift', name: 'Drift Angle Kit', blurb: 'Extra lock and fast rotation.', pros: ['Fast rotation', 'Extra steering angle'], cons: ['Twitchy', 'Less stability assist'] }
    ]
  },
  {
    key: 'diff', label: 'DIFFERENTIAL',
    options: [
      { id: 'open', name: 'Open Diff', blurb: 'Relaxed, safe power delivery.', pros: ['Very stable', 'Beginner friendly'], cons: ['Understeers on power'] },
      { id: 'lsd', name: 'Limited Slip', blurb: 'The do-everything racing diff.', pros: ['Balanced traction'], cons: ['None to speak of'] },
      { id: 'locked', name: 'Locked / Welded', blurb: 'Both wheels always spin together.', pros: ['Power-over rotation', 'Drift ready'], cons: ['Oversteery', 'Snappy at the limit'] }
    ]
  },
  {
    key: 'gearbox', label: 'GEARBOX',
    options: [
      { id: 'auto', name: 'Automatic', blurb: 'The car shifts for you.', pros: ['Zero effort'], cons: ['Slow shifts', 'Heavy converter (+14 kg)'] },
      { id: 'sequential', name: 'Sequential', blurb: 'Bang through gears with E / F — no clutch, and lighter than a DCT.', pros: ['Fast clutchless shifts', 'Lightweight'], cons: ['Not quite DCT-fast'] },
      { id: 'dct', name: 'Dual-Clutch', blurb: 'Lightning-fast paddle shifts.', pros: ['Near-instant shifts'], cons: ['Heaviest gearbox (+20 kg)', 'Numb, clinical feel'] },
      { id: 'manual', name: 'H-Pattern + Clutch', blurb: 'Clutch (Shift) + gear keys, old school.', pros: ['Lightest', 'Clutch launches & kicks'], cons: ['Grinds & baulks without the clutch'] }
    ]
  },
  {
    key: 'brakes', label: 'BRAKES',
    options: [
      { id: 'stock', name: 'Factory Brakes', blurb: 'Standard steel discs.', pros: ['Progressive pedal'], cons: ['Long stops from speed'] },
      { id: 'sport', name: 'Sport Big-Brake Kit', blurb: 'Larger discs, stickier pads.', pros: ['+22% brake force'], cons: ['Slightly grabby'] },
      { id: 'carbon', name: 'Carbon Ceramic', blurb: 'Fade-free monster stoppers.', pros: ['+45% brake force'], cons: ['Easy to lock on low grip'] }
    ]
  },
  {
    key: 'weight', label: 'WEIGHT',
    options: [
      { id: 'stock', name: 'Full Interior', blurb: 'All creature comforts intact.', pros: ['Planted, stable'], cons: ['Heaviest option'] },
      { id: 'stripped', name: 'Stripped Interior', blurb: 'No rear seats, no carpet.', pros: ['-7% mass'], cons: ['Slightly nervous'] },
      { id: 'carbon', name: 'Carbon Panels', blurb: 'Carbon doors, hood and hatch.', pros: ['-14% mass', 'Sharper response'], cons: ['Twitchier at the limit'] }
    ]
  },
  {
    key: 'aero', label: 'AERO',
    options: [
      { id: 'none', name: 'Clean Body', blurb: 'No wings, no drag.', pros: ['Best top speed'], cons: ['No downforce'] },
      { id: 'lip', name: 'Ducktail Lip', blurb: 'Subtle rear lip spoiler.', pros: ['Some high-speed grip'], cons: ['Tiny drag penalty'] },
      { id: 'gt', name: 'GT Wing', blurb: 'Proper circuit downforce.', pros: ['Strong high-speed grip'], cons: ['+6% drag'] },
      { id: 'big', name: 'Big Wing + Splitter', blurb: 'Maximum downforce package.', pros: ['Massive cornering at speed'], cons: ['+12% drag', 'Slower straights'] }
    ]
  }
];

export interface PlayerStats {
  credits: number;   // reputation score — nothing costs anything
  xp: number;
  level: number;
  streetRating: number;
  driftRating: number;
  rallyRating: number;
  garage: Record<string, CarLoadout>;
  activeCarId: string;
  steerSensitivity: number; // Settings slider (0.5-5.0, default 1.0) — scales steering lock + the assist's yaw ceiling, uniformly for every car
}

export type TrackId = 'metro' | 'circuit' | 'highway' | 'drag' | 'rally' | 'city' | 'canyon' | 'oval' | 'seaside' | 'apex';
export type WeatherType = 'sunny' | 'rainy' | 'snowy' | 'foggy' | 'night';
export type RaceMode = 'circuit' | 'touge' | 'sprint' | 'drag' | 'drift' | 'freeroam';

// 8 difficulty tiers. Single source of truth for AI, payouts and the menu.
export type Difficulty = 'novice' | 'rookie' | 'amateur' | 'semipro' | 'pro' | 'expert' | 'legend' | 'impossible';
// WIDENED SPREAD (2026-07-21): the old 0.84..1.45 range made Novice and
// Impossible feel too alike — Novice barely erred and Impossible wasn't much
// faster. The band is now 0.60..1.72: the BOTTOM drops hard (the mistake term is
// quadratic in (1-skill), so Novice 0.60 fumbles constantly and drives slow while
// staying beatable) and the TOP climbs (Impossible 1.72 is flawless AND, via the
// steepened perfBoost ramp in AI.ts, runs markedly faster machinery). Payouts
// widen to match, so the hard tiers are worth chasing. NOTE: the AI.ts perfBoost
// formula + skill clamp were retuned in lockstep — a table bump alone would clip
// against the old caps and silently no-op at the extremes.
export const DIFFICULTIES: { id: Difficulty; label: string; skill: number; payout: number; blurb: string }[] = [
  { id: 'novice',     label: 'Novice',     skill: 0.60, payout: 0.70, blurb: 'Slow, fumbles constantly' },
  { id: 'rookie',     label: 'Rookie',     skill: 0.74, payout: 0.90, blurb: 'Makes real mistakes' },
  { id: 'amateur',    label: 'Amateur',    skill: 0.86, payout: 1.10, blurb: 'Holds a decent pace' },
  { id: 'semipro',    label: 'Semi-Pro',   skill: 0.98, payout: 1.35, blurb: 'Fast and defends hard' },
  { id: 'pro',        label: 'Pro',        skill: 1.10, payout: 1.65, blurb: 'On the ragged edge' },
  { id: 'expert',     label: 'Expert',     skill: 1.26, payout: 2.05, blurb: 'Relentless, near-flawless' },
  { id: 'legend',     label: 'Legend',     skill: 1.44, payout: 2.55, blurb: 'Flawless — a wall to pass' },
  { id: 'impossible', label: 'Impossible', skill: 1.72, payout: 3.40, blurb: 'Superhuman — faster car, no mercy' },
];
export const difficultySkill = (d: string): number => (DIFFICULTIES.find(x => x.id === d)?.skill ?? 0.7);
export const difficultyPayout = (d: string): number => (DIFFICULTIES.find(x => x.id === d)?.payout ?? 1.0);

export interface RaceConfig {
  trackId: TrackId;
  weather: WeatherType;
  mode: RaceMode;
  laps: number;
  opponentsCount: number;
  difficulty: Difficulty;
}

interface GameContextType {
  stats: PlayerStats;
  cars: CarDefinition[];
  activeRace: RaceConfig | null;
  setLoadout: (carId: string, patch: Partial<CarLoadout>) => void;
  selectCar: (carId: string) => void;
  startRace: (config: RaceConfig) => void;
  exitRace: (payout?: { credits: number; xp: number; driftScore?: number }) => void;
  setSteerSensitivity: (v: number) => void;
}

// Distinct-with-trade-offs (see CarClass note above). HYPERCAR-TIER PASS
// (2026-07-22, per request): every car re-tuned to a genuine 400-500 km/h top
// speed — the ENTIRE grid is drastically more powerful (873-1289 hp, up from
// 200-430) with matching torque, first gear and gear COUNT preserved (still
// 9-11 speeds), only the top gear lengthened + intermediate ratios re-spaced.
// This went through TWO correctness passes, both adversarial-review-caught:
// (1) reaching 400+ km/h is GRIP-limited, not power-limited, for several cars
// (verified via headless bisection sim against the real friction-ellipse/
// power-cap physics) — pushing power far past what an axle can put down just
// wastes it to wheelspin and, worse, cooks the tyres (heat+wear) into a DEATH
// SPIRAL that makes a long run slower, not faster. ek9 and gti (both FWD,
// physically unable to push huge power through the front axle alone) got real
// grip/downforce bumps (ek9 baseGrip 0.89->0.95, downforce 0.08->0.38; gti
// baseGrip 0.90->0.91, downforce 0.06->0.11) to actually clear 400 km/h rather
// than plateau in the 330s. (2) An EARLIER version of this tuning pass only
// checked PEAK speed over a 150s run and missed that the pre-existing engine-
// overheat mechanic (Physics.ts: engineRpm > redline*0.9 && throttle>0.5 heats
// the engine; sustained heat becomes permanent, non-recovering `damage`) was
// newly triggered by gearing re-spaced to sit RPM near redline at top speed —
// 11/14 cars would peak in-band then permanently decay to a crippled,
// sub-400-km/h cruise after 60-170s of continued WOT. Every car here is
// re-verified via a 500-SECOND continuous full-throttle run to settle at 0
// engine damage AND land in [400,500] km/h — a genuinely stable, indefinitely
// sustainable top speed, not a transient peak. The SPREAD is still
// deliberate: grip 0.82 (muscle) .. 0.97 (mid-engine scalpel). A car with big
// power gives away grip or agility; a grip monster gives away power; the AWD
// cars trade top speed and weight for all-weather traction. No car is best
// everywhere.
const CAR_DATABASE: CarDefinition[] = [
  {
    id: 'ae86', name: 'Trueno AE86', class: 'DRIFT',
    description: 'Featherweight RWD trainer. Lives at big slip angles — the easiest car to steer on the throttle. The trade: least power and the lowest top speed on the grid, so it can only win where corners outnumber straights.',
    specs: { mass: 960, power: 873, peakTorque: 895, redline: 8200, driveType: 'RWD', dragCoefficient: 0.35, downforceMultiplier: 0.05, weightDistribution: 0.5, baseGrip: 0.85, brakes: 1.05, gearRatios: [3.30, 2.62, 2.08, 1.65, 1.31, 1.04, 0.83, 0.66, 0.52], finalDrive: 4.30 }
  },
  {
    id: 'mx5', name: 'Roadster MX-5', class: 'BALANCED',
    description: 'The sweetest, most tossable chassis here — flick-it-anywhere agility and light, honest steering. Modest power and a low top speed mean you win by carrying corner speed, not out-dragging anyone.',
    specs: { mass: 1010, power: 1014, peakTorque: 1038, redline: 7400, driveType: 'RWD', dragCoefficient: 0.34, downforceMultiplier: 0.07, weightDistribution: 0.5, baseGrip: 0.90, brakes: 1.15, gearRatios: [3.14, 2.48, 1.96, 1.54, 1.22, 0.96, 0.76, 0.60, 0.47], finalDrive: 4.10 }
  },
  {
    id: 'ek9', name: 'Civic Type R EK9', class: 'GRIP',
    description: 'High-revving FWD point-and-squirt weapon. Superb traction out of slow corners and a brilliant wet-weather car, but it understeers into tight turns and runs out of top-end legs on long straights.',
    specs: { mass: 1040, power: 900, peakTorque: 800, redline: 8600, driveType: 'FWD', dragCoefficient: 0.32, downforceMultiplier: 0.38, weightDistribution: 0.61, baseGrip: 0.95, brakes: 1.15, gearRatios: [3.23, 2.63, 2.14, 1.75, 1.42, 1.16, 0.95, 0.77, 0.63, 0.51], finalDrive: 4.40 }
  },
  {
    id: 'gti', name: 'GTI Mk7 Hot Hatch', class: 'TURBO',
    description: 'Torque-rich turbo FWD all-rounder — planted, brilliant in the wet and strong once it is rolling. The catch is front drive: it cannot put its torque down cleanly from a standstill, so it launches soft, and the nose-led push blunts it in quick dry direction-changes where the RWD cars dance.',
    specs: { mass: 1300, power: 882, peakTorque: 1114, redline: 6600, driveType: 'FWD', dragCoefficient: 0.33, downforceMultiplier: 0.11, weightDistribution: 0.62, baseGrip: 0.91, brakes: 1.25, gearRatios: [3.50, 2.78, 2.21, 1.76, 1.40, 1.11, 0.89, 0.71, 0.56, 0.45], finalDrive: 3.90 }
  },
  {
    id: 'foxbody', name: 'Mustang GT Foxbody', class: 'MUSCLE',
    description: 'A V8 sledgehammer — monster torque and savage straight-line thrust. But it has the least grip on the grid, a loose rear and a lot of mass, so it wins the drag to the corner and then has to survive it.',
    specs: { mass: 1440, power: 966, peakTorque: 1534, redline: 6000, driveType: 'RWD', dragCoefficient: 0.38, downforceMultiplier: 0.02, weightDistribution: 0.56, baseGrip: 0.82, brakes: 1.20, gearRatios: [3.35, 2.62, 2.04, 1.60, 1.25, 0.98, 0.76, 0.60, 0.47], finalDrive: 3.31 }
  },
  {
    id: 'e30', name: 'M3 E30 Sport Evo', class: 'BALANCED',
    description: 'The homologation legend: revvy NA power and the most delicate, adjustable RWD balance in the game. No single headline stat — it just does everything well and rewards a precise driver on any dry circuit.',
    specs: { mass: 1180, power: 950, peakTorque: 950, redline: 7800, driveType: 'RWD', dragCoefficient: 0.33, downforceMultiplier: 0.12, weightDistribution: 0.5, baseGrip: 0.91, brakes: 1.30, gearRatios: [3.68, 2.86, 2.23, 1.73, 1.35, 1.05, 0.81, 0.63, 0.49], finalDrive: 4.10 }
  },
  {
    id: 'wrx', name: 'Impreza WRX STI', class: 'RALLY',
    description: 'The AWD brawler — the most grunt and the highest top speed of the rally pair, and monster traction that hooks up and fires off the line on any surface. It gives away outright grip and agility to the lighter Evo, so it wants power-down corners and open straights, not a tight technical squiggle.',
    specs: { mass: 1440, power: 959, peakTorque: 1328, redline: 7000, driveType: 'AWD', dragCoefficient: 0.32, downforceMultiplier: 0.15, weightDistribution: 0.58, baseGrip: 0.92, brakes: 1.30, gearRatios: [3.64, 2.88, 2.27, 1.80, 1.42, 1.12, 0.89, 0.70, 0.55, 0.44], finalDrive: 3.90 }
  },
  {
    id: 'evo', name: 'Lancer Evo IX', class: 'RALLY',
    description: 'The scalpel of the AWD pair — lighter, grippier and sharper thanks to its computer diffs, and the best wet/technical weapon in the game. The trade is muscle: it makes less power and tops out lower than the brawnier WRX, so it wins by out-cornering, not out-dragging.',
    specs: { mass: 1380, power: 917, peakTorque: 1253, redline: 7400, driveType: 'AWD', dragCoefficient: 0.34, downforceMultiplier: 0.20, weightDistribution: 0.57, baseGrip: 0.96, brakes: 1.45, gearRatios: [3.42, 2.72, 2.16, 1.71, 1.36, 1.08, 0.86, 0.68, 0.54, 0.43], finalDrive: 4.10 }
  },
  {
    id: 'gtr34', name: 'Skyline GT-R R34', class: 'TURBO',
    description: 'Heavy AWD twin-turbo with huge grip and huge power — planted and unshakeable at speed, a superb all-rounder. The catch is its mass: it is the least nimble car in quick tight stuff despite all that traction.',
    specs: { mass: 1540, power: 1058, peakTorque: 1494, redline: 8000, driveType: 'AWD', dragCoefficient: 0.30, downforceMultiplier: 0.22, weightDistribution: 0.55, baseGrip: 0.93, brakes: 1.50, gearRatios: [3.55, 2.93, 2.42, 2.00, 1.65, 1.36, 1.12, 0.93, 0.76, 0.63, 0.52], finalDrive: 3.55 }
  },
  {
    id: 'supra', name: 'Supra MK4', class: 'SPEED',
    description: 'RWD highway missile — the outright top-speed king thanks to a slippery shape and long legs. But it is heavy and modest on grip, so it dominates fast open tracks and struggles through a tight, technical one.',
    specs: { mass: 1520, power: 1022, peakTorque: 1420, redline: 7600, driveType: 'RWD', dragCoefficient: 0.29, downforceMultiplier: 0.10, weightDistribution: 0.53, baseGrip: 0.87, brakes: 1.40, gearRatios: [3.30, 2.68, 2.17, 1.76, 1.43, 1.16, 0.94, 0.76, 0.62, 0.50], finalDrive: 3.27 }
  },
  {
    id: 'nsx', name: 'NSX Type-R', class: 'GRIP',
    description: 'Mid-engine RWD scalpel with the highest grip on the grid — it carries corner speed nothing else can and brakes impossibly late. It gives away power and top speed, so it lives to devour a twisty circuit.',
    specs: { mass: 1260, power: 1058, peakTorque: 1058, redline: 8400, driveType: 'RWD', dragCoefficient: 0.30, downforceMultiplier: 0.30, weightDistribution: 0.44, baseGrip: 0.97, brakes: 1.60, gearRatios: [3.07, 2.50, 2.04, 1.67, 1.36, 1.11, 0.90, 0.74, 0.60, 0.49], finalDrive: 4.06 }
  },
  {
    id: 'f40', name: 'F40 Twin-Turbo', class: 'SPEED',
    description: 'Savage power-to-weight in a light, low-drag wedge — brutally fast when you commit. The price is a razor edge: a rear-biased, boost-happy chassis that will snap on you the instant you get greedy.',
    specs: { mass: 1230, power: 1190, peakTorque: 1487, redline: 7800, driveType: 'RWD', dragCoefficient: 0.34, downforceMultiplier: 0.45, weightDistribution: 0.43, baseGrip: 0.90, brakes: 1.70, gearRatios: [3.10, 2.43, 1.90, 1.49, 1.17, 0.91, 0.72, 0.56, 0.44], finalDrive: 3.90 }
  },
  {
    id: 'cgt', name: 'Carrera GT', class: 'GRIP',
    description: 'A screaming NA V10 with a carbon tub — huge grip AND huge power, a 10-speed surgical instrument. But its peaky, high-rev delivery gives nothing down low: bog it below the powerband and it simply will not pull.',
    specs: { mass: 1360, power: 1264, peakTorque: 1264, redline: 8500, driveType: 'RWD', dragCoefficient: 0.39, downforceMultiplier: 0.40, weightDistribution: 0.48, baseGrip: 0.96, brakes: 1.80, gearRatios: [3.20, 2.61, 2.12, 1.73, 1.41, 1.15, 0.93, 0.76, 0.62, 0.50], finalDrive: 4.10 }
  },
  {
    id: 'sv12', name: 'Aventador SV', class: 'GRIP',
    description: 'The apex predator: the most power, the most downforce and monster AWD grip, glued to fast sweepers. Its 11-speed gearbox keeps it pinned in the power band everywhere. It is also the heaviest car here, so a tight, low-speed corner is the one place its bulk finally counts against it.',
    specs: { mass: 1560, power: 1289, peakTorque: 1679, redline: 8500, driveType: 'AWD', dragCoefficient: 0.36, downforceMultiplier: 0.55, weightDistribution: 0.43, baseGrip: 0.96, brakes: 2.0, gearRatios: [2.95, 2.47, 2.07, 1.74, 1.46, 1.22, 1.02, 0.86, 0.72, 0.60, 0.50], finalDrive: 3.90 }
  }
];

// Signature paint per car, sampled to match each car's selection sprite so the
// 3D car you drive is the SAME colour as the one you picked (previously every
// un-painted car fell back to DEFAULT_LOADOUT's red, so e.g. the blue GT-R
// sprite drove as a red car). Used as the loadout colour default; a paint the
// player picks in the garage still overrides it.
export const CAR_COLORS: Record<string, string> = {
  ae86: '#e8e8ea', mx5: '#d42030', ek9: '#eef0f0', gti: '#3a3d42',
  foxbody: '#2c3e54', e30: '#eef0f0', evo: '#cc2b28', wrx: '#1a53a8',
  gtr34: '#2456a8', nsx: '#e6e6e6', supra: '#e8641a', f40: '#d4241d',
  cgt: '#c8ccce', sv12: '#7ac82e',
};

// The generic fallback red that un-painted cars used before per-car colours
// existed. It is NOT in the garage palette, so any garage entry still holding
// this exact hex was auto-created (never a deliberate paint choice) and is
// safely treated as "unpainted" so old saves adopt the car's signature colour.
const LEGACY_DEFAULT_COLOR = '#e63946';

export const carColor = (carId: string): string => CAR_COLORS[carId] ?? LEGACY_DEFAULT_COLOR;

const SAVE_KEY = 'pixel_drift_v1';
// Marker for the one-time steering-sensitivity reset (see GameProvider load).
const SENS_MIGRATION_KEY = 'pixel_drift_sens_migrated_v1';

const freshStats = (): PlayerStats => ({
  credits: 0,
  xp: 0,
  level: 1,
  streetRating: 100,
  driftRating: 0,
  rallyRating: 0,
  garage: { ae86: { ...DEFAULT_LOADOUT, color: '#f0f0f0', plate: 'INITIAL' } },
  activeCarId: 'ae86',
  // Default back to 100% (2026-07-22): with the hypercar power roster, a 200%
  // default over-rotated every car past its grip into a constant slide ("cars
  // only drifting constantly"). At 100% the steering is still direct (maxSteer
  // 0.86, the tuned baseline) and the cars TRACK. The slider goes up to 500%
  // in the Esc menu for anyone who wants the loose, tail-happy feel.
  steerSensitivity: 1.0
});

// Always merge onto DEFAULT_LOADOUT so a partial or older-schema saved loadout
// (missing a slot added later, e.g. aero/neonColor) can never leave undefined
// fields — those would build white cars, phantom wings, or wrong gearbox modes.
export const getLoadout = (stats: PlayerStats, carId: string): CarLoadout => {
  const merged = { ...DEFAULT_LOADOUT, ...(stats.garage[carId] || {}) };
  // Only a falsy (unpainted) colour falls back to the car's signature colour, so
  // the driven car matches its selection sprite. Legacy generic-red saves are
  // normalised to '' once at load (see GameProvider), so a deliberately-picked
  // colour — even #e63946 — is always preserved here.
  if (!merged.color) merged.color = carColor(carId);
  return merged;
};

const GameContext = createContext<GameContextType | undefined>(undefined);

export const GameProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [stats, setStats] = useState<PlayerStats>(() => {
    try {
      const saved = localStorage.getItem(SAVE_KEY);
      if (saved) {
        const loaded: PlayerStats = { ...freshStats(), ...JSON.parse(saved) };
        // One-time migration: the legacy generic red was an auto-default, never a
        // deliberate paint choice, so clear it to '' (unpainted). getLoadout then
        // resolves it to the car's signature colour. Idempotent on later loads,
        // and a colour the player picks from now on — even #e63946 — is kept.
        for (const lo of Object.values(loaded.garage || {})) {
          if (lo && lo.color === LEGACY_DEFAULT_COLOR) lo.color = '';
        }
        // One-time migration (2026-07-22): the short-lived 200% default steering
        // over-rotated the hypercar roster into a constant slide. Anyone who
        // played that version has 2.0 (or near it) persisted here, so lowering
        // the freshStats default alone would NOT reach them. Reset a saved
        // sensitivity that is still at/above the old default (>=1.6, all of which
        // wash these cars out) down to the new 100% default — ONCE. The marker
        // means a player who deliberately re-raises the slider afterwards keeps
        // their choice.
        if (!localStorage.getItem(SENS_MIGRATION_KEY)) {
          if ((loaded.steerSensitivity ?? 1) >= 1.6) loaded.steerSensitivity = 1.0;
          localStorage.setItem(SENS_MIGRATION_KEY, '1');
        }
        return loaded;
      }
    } catch (e) { console.error('Save load failed:', e); }
    return freshStats();
  });

  const [activeRace, setActiveRace] = useState<RaceConfig | null>(null);

  useEffect(() => {
    localStorage.setItem(SAVE_KEY, JSON.stringify(stats));
  }, [stats]);

  const setLoadout = (carId: string, patch: Partial<CarLoadout>) => {
    setStats(prev => ({
      ...prev,
      garage: { ...prev.garage, [carId]: { ...getLoadout(prev, carId), ...patch } }
    }));
  };

  const selectCar = (carId: string) => {
    if (!CAR_DATABASE.some(c => c.id === carId)) return;
    setStats(prev => ({
      ...prev,
      activeCarId: carId,
      garage: prev.garage[carId] ? prev.garage : { ...prev.garage, [carId]: { ...DEFAULT_LOADOUT, color: carColor(carId) } }
    }));
  };

  const setSteerSensitivity = (v: number) => {
    const clamped = Math.max(0.5, Math.min(5.0, v));
    setStats(prev => ({ ...prev, steerSensitivity: clamped }));
  };

  const startRace = (config: RaceConfig) => setActiveRace(config);

  const exitRace = (payout?: { credits: number; xp: number; driftScore?: number }) => {
    if (payout) {
      setStats(prev => {
        const addDrift = payout.driftScore ? Math.floor(payout.driftScore / 10) : 0;
        const addRally = activeRace?.trackId === 'rally' ? 60 : 0;
        const nextXp = prev.xp + payout.xp;
        return {
          ...prev,
          credits: prev.credits + payout.credits,
          xp: nextXp,
          level: Math.max(prev.level, Math.floor(Math.sqrt(nextXp / 1000)) + 1),
          streetRating: prev.streetRating + 50,
          driftRating: prev.driftRating + addDrift,
          rallyRating: prev.rallyRating + addRally
        };
      });
    }
    setActiveRace(null);
  };

  return (
    <GameContext.Provider value={{ stats, cars: CAR_DATABASE, activeRace, setLoadout, selectCar, startRace, exitRace, setSteerSensitivity }}>
      {children}
    </GameContext.Provider>
  );
};

export const useGame = () => {
  const context = useContext(GameContext);
  if (!context) throw new Error('useGame must be used within a GameProvider');
  return context;
};
