import React, { useState } from 'react';
import { useGame, CarLoadout, PART_SLOTS, LoadoutSlotKey, getLoadout, DEFAULT_LOADOUT } from '../context/GameContext';
import { previewStats } from '../game/Physics';
import { ArrowLeft, Save, Palette, Cog, Check, Zap, CircleDot, Waves, GitBranch, Settings2, Disc3, Feather, Wind } from 'lucide-react';

interface GarageProps {
  onClose: () => void;
}

const SLOT_ICONS: Record<LoadoutSlotKey, React.ReactNode> = {
  engine: <Zap size={15} />,
  induction: <Wind size={15} />,
  tires: <CircleDot size={15} />,
  suspension: <Waves size={15} />,
  diff: <GitBranch size={15} />,
  gearbox: <Settings2 size={15} />,
  brakes: <Disc3 size={15} />,
  weight: <Feather size={15} />,
  aero: <Wind size={15} />
};

const PAINTS = ['#f0f0f0', '#1c1a27', '#d62828', '#f77f00', '#fcbf49', '#003049', '#2a9d8f', '#ff006e', '#3a86c8', '#7b2cbf'];
const NEONS = [
  { name: 'None', hex: 'none' },
  { name: 'Red', hex: '#ff003c' },
  { name: 'Green', hex: '#00ff66' },
  { name: 'Cyan', hex: '#00ffff' },
  { name: 'Purple', hex: '#d000ff' },
  { name: 'Orange', hex: '#ff5e00' }
];

export const Garage: React.FC<GarageProps> = ({ onClose }) => {
  const { stats, cars, setLoadout } = useGame();
  const [activeTab, setActiveTab] = useState<'loadout' | 'style'>('loadout');
  const [activeSlot, setActiveSlot] = useState<LoadoutSlotKey>('engine');

  const carId = stats.activeCarId;
  const car = cars.find(c => c.id === carId) || cars[0];
  const loadout = getLoadout(stats, carId);
  const [plateText, setPlateText] = useState(loadout.plate);

  const stock = previewStats(car, { ...DEFAULT_LOADOUT });
  const current = previewStats(car, loadout);

  const equip = (slot: LoadoutSlotKey, id: string) => setLoadout(carId, { [slot]: id } as Partial<CarLoadout>);

  const slotDef = PART_SLOTS.find(s => s.key === activeSlot)!;
  const equippedId = loadout[activeSlot];

  // ▲ = this build is BETTER in this stat, ▼ = worse. For lower-is-better stats
  // (mass) the sense is inverted so adding weight reads as a downgrade, not an
  // upgrade.
  const statRow = (label: string, val: number, base: number, max: number, unit = '', lowerBetter = false) => {
    const delta = val - base;
    const improved = lowerBetter ? delta < -0.01 : delta > 0.01;
    const worsened = lowerBetter ? delta > 0.01 : delta < -0.01;
    return (
      <div className="stat-row" key={label}>
        <span>{label}</span>
        <div className="bar-bg">
          <div className="bar-fill" style={{ width: `${Math.min(100, (val / max) * 100)}%` }} />
        </div>
        <span className={improved ? 'delta-up' : worsened ? 'delta-down' : ''}>
          {Math.round(val)}{unit}{improved ? ' ▲' : worsened ? ' ▼' : ''}
        </span>
      </div>
    );
  };

  return (
    <div className="menu-container">
      <header className="menu-header">
        <button className="back-btn" onClick={onClose}>
          <ArrowLeft size={18} /> BACK
        </button>
        <h1 className="title-glow">LOADOUT · {car.name.toUpperCase()}</h1>
        <div className="player-badge">
          <span className="badge-item free-badge">ALL PARTS FREE</span>
        </div>
      </header>

      <div className="menu-tabs">
        <button className={`tab-btn ${activeTab === 'loadout' ? 'active' : ''}`} onClick={() => setActiveTab('loadout')}>
          <Cog size={16} /> ATTACHMENTS
        </button>
        <button className={`tab-btn ${activeTab === 'style' ? 'active' : ''}`} onClick={() => setActiveTab('style')}>
          <Palette size={16} /> STYLE
        </button>
      </div>

      <div className="menu-content">
        {activeTab === 'loadout' && (
          <div className="loadout-grid">
            {/* Slot list */}
            <div className="slot-list card-glow">
              <h3>SLOTS</h3>
              {PART_SLOTS.map(slot => {
                const eq = slot.options.find(o => o.id === loadout[slot.key]);
                return (
                  <button
                    key={slot.key}
                    className={`slot-item ${activeSlot === slot.key ? 'selected' : ''}`}
                    onClick={() => setActiveSlot(slot.key)}
                  >
                    <span className="slot-icon">{SLOT_ICONS[slot.key]}</span>
                    <span className="slot-label">{slot.label}</span>
                    <span className="slot-equipped">{eq?.name || '—'}</span>
                  </button>
                );
              })}
            </div>

            {/* Options for the selected slot */}
            <div className="parts-panel card-glow">
              <h3>{slotDef.label} OPTIONS</h3>
              <div className="parts-list">
                {slotDef.options.map(opt => {
                  const isEq = equippedId === opt.id;
                  const locked = activeSlot === 'induction' && loadout.engine === 'electric';
                  return (
                    <div key={opt.id} className={`part-card ${isEq ? 'equipped' : ''}`}>
                      <div className="part-head">
                        <span className="part-name">{opt.name}</span>
                        {isEq
                          ? <span className="equipped-badge"><Check size={13} /> EQUIPPED</span>
                          : <button className="equip-btn" disabled={locked} onClick={() => equip(activeSlot, opt.id)}>{locked ? 'N/A (EV)' : 'EQUIP'}</button>}
                      </div>
                      <p className="part-blurb">{opt.blurb}</p>
                      <div className="part-effects">
                        {opt.pros.map(p => <span key={p} className="pro">+ {p}</span>)}
                        {opt.cons.map(c => <span key={c} className="con">− {c}</span>)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Live stat preview */}
            <div className="stats-panel card-glow">
              <h3>BUILD STATS</h3>
              <div className="car-stats-bars">
                {statRow('POWER', current.power, stock.power, 340, ' hp')}
                {statRow('TOP SPD', current.topSpeed, stock.topSpeed, 320, ' km/h')}
                {statRow('ACCEL', current.accel * 100, stock.accel * 100, 60)}
                {statRow('GRIP', current.grip * 100, stock.grip * 100, 125)}
                {statRow('HANDLING', current.handling * 10, stock.handling * 10, 122)}
                {statRow('BRAKES', current.braking * 40, stock.braking * 40, 130)}
                {statRow('MASS', current.mass, stock.mass, 1800, ' kg', true)}
              </div>
              <p className="stats-hint">▲ / ▼ vs stock build. Every part is a trade-off — build for the track and surface you're racing.</p>
              <div className="build-summary">
                {PART_SLOTS.map(s => {
                  const eq = s.options.find(o => o.id === loadout[s.key]);
                  return <span key={s.key} className="build-chip">{eq?.name}</span>;
                })}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'style' && (
          <div className="garage-grid">
            <div className="styling-panel card-glow">
              <h3>PAINT & GLOW</h3>
              <img
                className="car-sprite car-sprite-lg"
                src={`cars/${carId}.png`}
                alt=""
                onError={e => { e.currentTarget.style.display = 'none'; }}
              />
              <div className="styling-group">
                <label>PAINT</label>
                <div className="color-palette">
                  {PAINTS.map(hex => (
                    <button
                      key={hex}
                      className={`color-swatch ${loadout.color === hex ? 'selected-swatch' : ''}`}
                      style={{ backgroundColor: hex }}
                      onClick={() => setLoadout(carId, { color: hex })}
                    />
                  ))}
                  <input
                    type="color"
                    value={loadout.color}
                    onChange={e => setLoadout(carId, { color: e.target.value })}
                    className="custom-color-picker"
                  />
                </div>
              </div>
              <div className="styling-group">
                <label>NEON UNDERGLOW</label>
                <div className="option-list-horizontal">
                  {NEONS.map(neon => (
                    <button
                      key={neon.hex}
                      className={`option-btn ${loadout.neonColor === neon.hex ? 'selected' : ''}`}
                      onClick={() => setLoadout(carId, { neonColor: neon.hex })}
                    >
                      {neon.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="plate-panel card-glow">
              <h3>LICENSE PLATE</h3>
              <div className="plate-edit-block">
                <div className="retro-plate">
                  <div className="plate-header">SAN ANDREAS</div>
                  <div className="plate-text">{plateText.toUpperCase() || 'RETRO'}</div>
                </div>
                <div className="plate-input-group">
                  <input
                    type="text"
                    maxLength={8}
                    value={plateText}
                    onChange={e => setPlateText(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
                    className="menu-input"
                    placeholder="PLATE TEXT"
                  />
                  <button onClick={() => setLoadout(carId, { plate: plateText })} className="save-plate-btn">
                    <Save size={16} /> APPLY
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
