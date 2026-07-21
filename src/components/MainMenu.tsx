import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useGame, TrackId, WeatherType, RaceConfig, DIFFICULTIES, getLoadout } from '../context/GameContext';
import { TRACKS } from '../game/World';
import { Play, Wrench, Trophy, ChevronRight, Sun, CloudRain, Snowflake, CloudFog, Moon, Star, Gauge } from 'lucide-react';

interface MainMenuProps {
  onOpenGarage: () => void;
}

// Small canvas preview of a track layout.
const TrackThumb: React.FC<{ points: THREE.Vector2[]; closed: boolean; active: boolean }> = ({ points, closed, active }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    points.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
    const pad = 8;
    const scale = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY));
    const ox = (W - (maxX - minX) * scale) / 2, oy = (H - (maxY - minY) * scale) / 2;
    ctx.strokeStyle = active ? '#00f5d4' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = ox + (p.x - minX) * scale, y = oy + (p.y - minY) * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (closed) ctx.closePath();
    ctx.stroke();
    // start dot
    const s = points[0];
    ctx.fillStyle = '#ff006e';
    ctx.beginPath(); ctx.arc(ox + (s.x - minX) * scale, oy + (s.y - minY) * scale, 3, 0, Math.PI * 2); ctx.fill();
  }, [points, closed, active]);
  return <canvas ref={ref} width={110} height={70} />;
};

const WEATHER_META: { id: WeatherType; label: string; icon: React.ReactNode }[] = [
  { id: 'sunny', label: 'Sunny', icon: <Sun size={15} /> },
  { id: 'rainy', label: 'Rain', icon: <CloudRain size={15} /> },
  { id: 'snowy', label: 'Snow', icon: <Snowflake size={15} /> },
  { id: 'foggy', label: 'Fog', icon: <CloudFog size={15} /> },
  { id: 'night', label: 'Night', icon: <Moon size={15} /> }
];

export const MainMenu: React.FC<MainMenuProps> = ({ onOpenGarage }) => {
  const { stats, cars, selectCar, startRace } = useGame();
  const [activeTab, setActiveTab] = useState<'race' | 'cars'>('race');

  const [selectedTrack, setSelectedTrack] = useState<TrackId>('metro');
  const [selectedWeather, setSelectedWeather] = useState<WeatherType>('sunny');
  const [laps, setLaps] = useState<number>(3);
  const [gridSize, setGridSize] = useState<number>(5);
  const [difficulty, setDifficulty] = useState<RaceConfig['difficulty']>('semipro');

  const activeCar = cars.find(c => c.id === stats.activeCarId) || cars[0];
  const track = TRACKS[selectedTrack];

  const handleStartRace = () => {
    startRace({
      trackId: selectedTrack,
      weather: selectedWeather,
      mode: selectedTrack === 'drag' ? 'drag' : 'circuit',
      laps: track.isClosed ? laps : 1,
      opponentsCount: selectedTrack === 'drag' ? 0 : gridSize,
      difficulty
    });
  };

  return (
    <div className="menu-container">
      <header className="menu-header">
        <h1 className="title-glow">PIXEL DRIFT</h1>
        <div className="player-badge">
          <div className="badge-item"><Star size={18} className="text-yellow" /><span>{stats.credits.toLocaleString()} REP</span></div>
          <div className="badge-item"><Trophy size={18} className="text-cyan" /><span>LVL {stats.level}</span></div>
        </div>
      </header>

      <div className="menu-tabs">
        <button className={`tab-btn ${activeTab === 'race' ? 'active' : ''}`} onClick={() => setActiveTab('race')}>
          <Play size={16} /> RACE
        </button>
        <button className={`tab-btn ${activeTab === 'cars' ? 'active' : ''}`} onClick={() => setActiveTab('cars')}>
          <Gauge size={16} /> CARS
        </button>
        <button className="tab-btn" onClick={onOpenGarage}>
          <Wrench size={16} /> GARAGE / LOADOUT
        </button>
      </div>

      <div className="menu-content">
        {activeTab === 'race' && (
          <div className="race-tab">
          <div className="race-setup-grid">
            <div className="setup-panel card-glow">
              <h3>SELECT TRACK</h3>
              <div className="track-card-grid">
                {Object.values(TRACKS).map(t => (
                  <button
                    key={t.id}
                    className={`track-card ${selectedTrack === t.id ? 'selected' : ''}`}
                    onClick={() => setSelectedTrack(t.id as TrackId)}
                  >
                    {t.flagship && <span className="flagship-badge">★ FLAGSHIP</span>}
                    <TrackThumb points={t.idealLine} closed={t.isClosed} active={selectedTrack === t.id} />
                    <div className="track-card-info">
                      <span className="track-card-name">{t.name}</span>
                      <span className="track-card-meta">{(t.length / 1000).toFixed(1)} km · {t.isClosed ? 'CIRCUIT' : 'SPRINT'}</span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="option-group">
                <label>WEATHER / TIME</label>
                <div className="option-list">
                  {WEATHER_META.map(w => (
                    <button
                      key={w.id}
                      className={`option-btn weather-btn ${selectedWeather === w.id ? 'selected' : ''}`}
                      onClick={() => setSelectedWeather(w.id)}
                    >
                      {w.icon} {w.label.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid-3col">
                <div className="option-group">
                  <label>LAPS</label>
                  <select value={laps} onChange={e => setLaps(Number(e.target.value))} disabled={!track.isClosed} className="menu-select">
                    {[1, 2, 3, 5, 8].map(l => <option key={l} value={l}>{l} Lap{l > 1 ? 's' : ''}</option>)}
                  </select>
                </div>
                <div className="option-group">
                  <label>OPPONENTS</label>
                  <select value={gridSize} onChange={e => setGridSize(Number(e.target.value))} disabled={selectedTrack === 'drag'} className="menu-select">
                    {[1, 3, 5, 7, 9, 11, 13, 15].map(n => <option key={n} value={n}>{n} Rivals</option>)}
                  </select>
                </div>
                <div className="option-group">
                  <label>AI LEVEL</label>
                  <select value={difficulty} onChange={e => setDifficulty(e.target.value as RaceConfig['difficulty'])} className="menu-select">
                    {DIFFICULTIES.map(d => <option key={d.id} value={d.id}>{d.label} — {d.blurb}</option>)}
                  </select>
                </div>
              </div>

              <button className="start-btn-glow" onClick={handleStartRace}>
                START RACE <ChevronRight size={20} />
              </button>
            </div>

            <div className="preview-panel card-glow">
              <div className="car-preview-header">
                <h3>YOUR MACHINE</h3>
                <span className="class-badge">{activeCar.class} CLASS</span>
              </div>
              <div className="car-showcase">
                <img
                  className="car-sprite car-sprite-lg"
                  src={`cars/${activeCar.id}.png`}
                  alt=""
                  onError={e => { e.currentTarget.style.display = 'none'; }}
                />
                <div className="car-swatch" style={{ background: getLoadout(stats, activeCar.id).color }} />
                <h2 className="car-name-text">{activeCar.name}</h2>
                <p className="car-description">{activeCar.description}</p>

                <div className="car-stats-bars">
                  <div className="stat-row">
                    <span>POWER</span>
                    <div className="bar-bg"><div className="bar-fill" style={{ width: `${Math.min(100, (activeCar.specs.power / 290) * 100)}%` }}></div></div>
                    <span>{activeCar.specs.power} hp</span>
                  </div>
                  <div className="stat-row">
                    <span>TORQUE</span>
                    <div className="bar-bg"><div className="bar-fill" style={{ width: `${Math.min(100, (activeCar.specs.peakTorque / 440) * 100)}%` }}></div></div>
                    <span>{activeCar.specs.peakTorque} Nm</span>
                  </div>
                  <div className="stat-row">
                    <span>MASS</span>
                    <div className="bar-bg"><div className="bar-fill" style={{ width: `${Math.min(100, (activeCar.specs.mass / 1700) * 100)}%` }}></div></div>
                    <span>{activeCar.specs.mass} kg</span>
                  </div>
                  <div className="stat-row">
                    <span>GRIP</span>
                    <div className="bar-bg"><div className="bar-fill" style={{ width: `${Math.min(100, (activeCar.specs.baseGrip / 0.98) * 100)}%` }}></div></div>
                    <span>{activeCar.specs.driveType}</span>
                  </div>
                </div>

                <button className="tab-btn" style={{ marginTop: 14 }} onClick={() => setActiveTab('cars')}>SWITCH CAR</button>
                <button className="tab-btn" style={{ marginTop: 8 }} onClick={onOpenGarage}><Wrench size={14} /> EDIT LOADOUT</button>
              </div>
            </div>
          </div>

          <div className="how-to-play card-glow">
            <h3>HOW TO PLAY</h3>
            <p className="htp-blurb">
              Choose a track, car and loadout, then beat the AI to the flag. Circuits run for the laps you set;
              sprints are one-way dashes. Brake <em>before</em> the corner, feed the throttle back in on the exit,
              and tap <b>Space</b> to flick the tail out for drift points. Drop two wheels onto the gravel and you
              can still gather it up — go too far and you hit the guardrail or respawn. Every part in the garage is
              free, so experiment: slicks for dry tarmac, rally tyres for dirt, a wing for high-speed grip. Running an
              H-pattern gearbox? Hold <b>Shift</b> (clutch) every time you change gear or you'll grind them — and never
              downshift too early or you'll over-rev and cook the engine.
            </p>
            <div className="controls-ref">
              <label>CONTROLS</label>
              <div className="controls-grid">
                <span><b>W</b> Throttle</span><span><b>S</b> Brake / Reverse</span>
                <span><b>A / D</b> Steer</span><span><b>Space</b> Handbrake (drift)</span>
                <span><b>E / F</b> Gear Up / Down</span><span><b>Shift</b> Clutch</span>
                <span><b>R</b> Reverse Gear</span><span><b>C</b> Camera</span>
                <span><b>X</b> Respawn</span><span><b>Esc</b> Pause</span>
              </div>
            </div>
          </div>
          </div>
        )}

        {activeTab === 'cars' && (
          <div className="showroom-grid">
            {cars.map(car => {
              const isActive = stats.activeCarId === car.id;
              return (
                <div key={car.id} className={`showroom-card card-glow ${isActive ? 'active-border' : ''}`}>
                  <div className="showroom-card-header">
                    <h4>{car.name}</h4>
                    <span className="class-badge">{car.class}</span>
                  </div>
                  <img
                    className="car-sprite"
                    src={`cars/${car.id}.png`}
                    alt=""
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                  />
                  <p className="showroom-desc">{car.description}</p>
                  <div className="showroom-details">
                    <span>{car.specs.driveType}</span>
                    <span>{car.specs.power} hp</span>
                    <span>{car.specs.mass} kg</span>
                  </div>
                  <div className="showroom-footer">
                    <button
                      className={`select-btn ${isActive ? 'active-select' : ''}`}
                      onClick={() => selectCar(car.id)}
                      disabled={isActive}
                    >
                      {isActive ? '✓ SELECTED' : 'DRIVE THIS'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
