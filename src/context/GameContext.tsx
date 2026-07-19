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

// Nature classes, not power tiers — every car targets the same overall pace
// (hp/kg ~0.165-0.18, with less power where AWD traction or high grip
// compensates) and differs in HOW it's fast. Attachments customise from there.
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
}

export type TrackId = 'circuit' | 'highway' | 'drag' | 'rally' | 'city' | 'canyon' | 'oval' | 'seaside' | 'apex';
export type WeatherType = 'sunny' | 'rainy' | 'snowy' | 'foggy' | 'night';
export type RaceMode = 'circuit' | 'touge' | 'sprint' | 'drag' | 'drift' | 'freeroam';

// 7 difficulty tiers — a smooth skill ramp (each is ~1 driver-skill notch) with
// matching payout scaling. Single source of truth for AI, payouts and the menu.
export type Difficulty = 'novice' | 'rookie' | 'amateur' | 'semipro' | 'pro' | 'expert' | 'legend' | 'impossible';
// 8 difficulty tiers. Skills raised ~30-40% vs the old ramp — every tier is
// harder now. 'impossible' (skill >1) drives flawlessly beyond the grip limit.
export const DIFFICULTIES: { id: Difficulty; label: string; skill: number; payout: number; blurb: string }[] = [
  { id: 'novice',     label: 'Novice',     skill: 0.80, payout: 0.85, blurb: 'Quick, occasional slips' },
  { id: 'rookie',     label: 'Rookie',     skill: 0.86, payout: 1.00, blurb: 'Fast and consistent' },
  { id: 'amateur',    label: 'Amateur',    skill: 0.91, payout: 1.15, blurb: 'Seriously challenging' },
  { id: 'semipro',    label: 'Semi-Pro',   skill: 0.95, payout: 1.30, blurb: 'Very fast, defends hard' },
  { id: 'pro',        label: 'Pro',        skill: 0.99, payout: 1.50, blurb: 'On the ragged edge' },
  { id: 'expert',     label: 'Expert',     skill: 1.04, payout: 1.75, blurb: 'Relentless, near-flawless' },
  { id: 'legend',     label: 'Legend',     skill: 1.12, payout: 2.10, blurb: 'Flawless and merciless' },
  { id: 'impossible', label: 'Impossible', skill: 1.32, payout: 2.80, blurb: 'Superhuman — beyond the limit' },
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
}

// Equal-but-different: every car sits in a tight hp/kg band (~0.165-0.18) with
// compensation logic — AWD traction and high base grip cost power; low grip,
// high drag or ponderous mass buy it back. Character comes from drivetrain,
// torque shape, redline, gearing and grip, not from a power ladder.
const CAR_DATABASE: CarDefinition[] = [
  {
    id: 'ae86', name: 'Trueno AE86', class: 'DRIFT',
    description: 'Lightweight RWD icon. Lives at big slip angles — the easiest car here to steer with the throttle.',
    specs: { mass: 970, power: 168, peakTorque: 190, redline: 7800, driveType: 'RWD', dragCoefficient: 0.35, downforceMultiplier: 0.05, weightDistribution: 0.5, baseGrip: 0.86, brakes: 1.0, gearRatios: [3.12, 1.9, 1.3, 0.97, 0.77], finalDrive: 4.3 }
  },
  {
    id: 'mx5', name: 'Roadster MX-5', class: 'BALANCED',
    description: 'Featherweight RWD convertible. The sweetest, most tossable chassis here.',
    specs: { mass: 1020, power: 175, peakTorque: 205, redline: 7000, driveType: 'RWD', dragCoefficient: 0.34, downforceMultiplier: 0.06, weightDistribution: 0.5, baseGrip: 0.88, brakes: 1.1, gearRatios: [3.14, 1.89, 1.33, 1.0, 0.81, 0.72], finalDrive: 4.1 }
  },
  {
    id: 'ek9', name: 'Civic Type R EK9', class: 'BALANCED',
    description: 'High-revving FWD legend. Point it, plant it — the most forgiving fast car in the game.',
    specs: { mass: 1050, power: 182, peakTorque: 185, redline: 8400, driveType: 'FWD', dragCoefficient: 0.32, downforceMultiplier: 0.08, weightDistribution: 0.61, baseGrip: 0.87, brakes: 1.1, gearRatios: [3.23, 2.11, 1.46, 1.03, 0.85], finalDrive: 4.4 }
  },
  {
    id: 'gti', name: 'GTI Mk7 Hot Hatch', class: 'TURBO',
    description: 'Turbo FWD all-rounder. Planted, punchy and a superb wet-weather weapon.',
    specs: { mass: 1320, power: 232, peakTorque: 340, redline: 6500, driveType: 'FWD', dragCoefficient: 0.33, downforceMultiplier: 0.05, weightDistribution: 0.62, baseGrip: 0.88, brakes: 1.2, gearRatios: [3.5, 2.09, 1.47, 1.1, 0.87, 0.73], finalDrive: 3.9 }
  },
  {
    id: 'foxbody', name: 'Mustang GT Foxbody', class: 'MUSCLE',
    description: 'Big V8 torque, loose rear, long gears. Wins the straights, dances the corners.',
    specs: { mass: 1420, power: 258, peakTorque: 420, redline: 5800, driveType: 'RWD', dragCoefficient: 0.38, downforceMultiplier: 0.02, weightDistribution: 0.56, baseGrip: 0.84, brakes: 1.2, gearRatios: [3.35, 1.93, 1.29, 1.0, 0.68], finalDrive: 3.27 }
  },
  {
    id: 'e30', name: 'M3 E30 Sport Evo', class: 'BALANCED',
    description: 'The homologation legend. Revvy NA four and delicate RWD balance.',
    specs: { mass: 1200, power: 205, peakTorque: 235, redline: 7600, driveType: 'RWD', dragCoefficient: 0.33, downforceMultiplier: 0.12, weightDistribution: 0.5, baseGrip: 0.9, brakes: 1.3, gearRatios: [3.68, 2.24, 1.56, 1.18, 1.0], finalDrive: 4.1 }
  },
  {
    id: 'wrx', name: 'Impreza WRX STI', class: 'RALLY',
    description: 'Turbo AWD rally machine. Trades outright power for traction on any surface, any weather.',
    specs: { mass: 1450, power: 238, peakTorque: 350, redline: 7200, driveType: 'AWD', dragCoefficient: 0.33, downforceMultiplier: 0.15, weightDistribution: 0.58, baseGrip: 0.92, brakes: 1.3, gearRatios: [3.64, 2.37, 1.76, 1.35, 1.06, 0.84], finalDrive: 3.9 }
  },
  {
    id: 'evo', name: 'Lancer Evo IX', class: 'RALLY',
    description: 'Turbo AWD with computer diffs. Brutal corner-exit traction anywhere.',
    specs: { mass: 1420, power: 235, peakTorque: 360, redline: 7000, driveType: 'AWD', dragCoefficient: 0.34, downforceMultiplier: 0.18, weightDistribution: 0.57, baseGrip: 0.93, brakes: 1.4, gearRatios: [2.9, 1.95, 1.41, 1.06, 0.84, 0.69], finalDrive: 4.53 }
  },
  {
    id: 'gtr34', name: 'Skyline GT-R R34', class: 'TURBO',
    description: 'High-tech AWD twin-turbo straight-6. Heavy, boosty, unshakeable.',
    specs: { mass: 1560, power: 262, peakTorque: 380, redline: 8000, driveType: 'AWD', dragCoefficient: 0.3, downforceMultiplier: 0.22, weightDistribution: 0.55, baseGrip: 0.92, brakes: 1.5, gearRatios: [3.83, 2.36, 1.69, 1.31, 1.0, 0.79], finalDrive: 3.55 }
  },
  {
    id: 'supra', name: 'Supra MK4', class: 'SPEED',
    description: 'RWD highway missile. Slippery shape and long legs — the top-speed king.',
    specs: { mass: 1550, power: 272, peakTorque: 420, redline: 7500, driveType: 'RWD', dragCoefficient: 0.31, downforceMultiplier: 0.12, weightDistribution: 0.53, baseGrip: 0.87, brakes: 1.4, gearRatios: [3.83, 2.36, 1.69, 1.31, 1.0, 0.79], finalDrive: 3.27 }
  },
  {
    id: 'nsx', name: 'NSX Type-R', class: 'GRIP',
    description: 'Mid-engine RWD scalpel. Less muscle, most grip — carries speed nothing else can.',
    specs: { mass: 1270, power: 212, peakTorque: 260, redline: 8300, driveType: 'RWD', dragCoefficient: 0.3, downforceMultiplier: 0.3, weightDistribution: 0.42, baseGrip: 0.96, brakes: 1.6, gearRatios: [3.07, 1.96, 1.46, 1.12, 0.92, 0.75], finalDrive: 4.06 }
  },
  {
    id: 'f40', name: 'F40 Twin-Turbo', class: 'SPEED',
    description: 'Raw, savage, analog. Light, low-drag wedge that rewards commitment.',
    specs: { mass: 1250, power: 226, peakTorque: 320, redline: 7750, driveType: 'RWD', dragCoefficient: 0.34, downforceMultiplier: 0.45, weightDistribution: 0.43, baseGrip: 0.89, brakes: 1.7, gearRatios: [3.1, 2.1, 1.6, 1.25, 1.03], finalDrive: 3.9 }
  },
  {
    id: 'cgt', name: 'Carrera GT', class: 'GRIP',
    description: 'Screaming NA V10, carbon tub, RWD, uncompromising precision.',
    specs: { mass: 1380, power: 240, peakTorque: 330, redline: 8400, driveType: 'RWD', dragCoefficient: 0.39, downforceMultiplier: 0.4, weightDistribution: 0.48, baseGrip: 0.94, brakes: 1.8, gearRatios: [3.2, 1.87, 1.41, 1.13, 0.93, 0.79], finalDrive: 4.44 }
  },
  {
    id: 'sv12', name: 'Aventador SV', class: 'GRIP',
    description: 'V12 AWD bruiser. Planted like nothing else — grip and stability over raw shove.',
    specs: { mass: 1525, power: 258, peakTorque: 400, redline: 8500, driveType: 'AWD', dragCoefficient: 0.36, downforceMultiplier: 0.55, weightDistribution: 0.43, baseGrip: 0.95, brakes: 2.0, gearRatios: [2.9, 2.0, 1.5, 1.18, 0.97, 0.82, 0.7], finalDrive: 3.9 }
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

const freshStats = (): PlayerStats => ({
  credits: 0,
  xp: 0,
  level: 1,
  streetRating: 100,
  driftRating: 0,
  rallyRating: 0,
  garage: { ae86: { ...DEFAULT_LOADOUT, color: '#f0f0f0', plate: 'INITIAL' } },
  activeCarId: 'ae86'
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
    <GameContext.Provider value={{ stats, cars: CAR_DATABASE, activeRace, setLoadout, selectCar, startRace, exitRace }}>
      {children}
    </GameContext.Provider>
  );
};

export const useGame = () => {
  const context = useContext(GameContext);
  if (!context) throw new Error('useGame must be used within a GameProvider');
  return context;
};
