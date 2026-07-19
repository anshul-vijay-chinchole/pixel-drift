import React, { useEffect, useRef } from 'react';
import { VehicleState } from '../game/Physics';
import { OpponentRacer } from '../game/AI';
import { TrackPoint } from '../game/World';
import { CameraMode } from '../game/Graphics';
import { Camera, Volume2, VolumeX, Pause } from 'lucide-react';

export interface StandingEntry {
  name: string;
  you: boolean;
  color: string;
  place: number;
  gap: number; // metres behind leader
}

interface HUDProps {
  playerState: VehicleState;
  standings: StandingEntry[];
  trackPoints: TrackPoint[];
  opponents: OpponentRacer[];
  redline: number;
  boostMax: number;
  lapsCount: number;
  currentLap: number;
  racePosition: number;
  timeElapsed: number;
  bestLapTime: number;
  cameraMode: CameraMode;
  isMuted: boolean;
  gearboxLabel: string;
  clutchHeld: boolean;
  isManual: boolean;
  onToggleCamera: () => void;
  onToggleMute: () => void;
  onPause: () => void;
}

export const HUD: React.FC<HUDProps> = ({
  playerState, standings, trackPoints, opponents, redline, boostMax, lapsCount, currentLap,
  racePosition, timeElapsed, bestLapTime, cameraMode, isMuted,
  gearboxLabel, clutchHeld, isManual,
  onToggleCamera, onToggleMute, onPause
}) => {
  const mapRef = useRef<HTMLCanvasElement | null>(null);

  const fmt = (t: number) => {
    if (isNaN(t) || t === Infinity) return '--:--.--';
    const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 100);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  // Minimap — rotated so the player always heads "up".
  useEffect(() => {
    const canvas = mapRef.current;
    if (!canvas || trackPoints.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    const scale = 0.11;
    const yaw = playerState.yaw;
    // Heading-oriented projection: screen-up = the player's forward
    // (sin yaw, cos yaw); screen-right = the chase CAMERA's right
    // (-cos yaw, sin yaw). The reflection (basis determinant -1) is deliberate:
    // the 3D camera presents the world mirrored vs a naive top-down (x,z) plot,
    // so without it minimap corners bend opposite to what you see on screen.
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const project = (wx: number, wz: number) => {
      const dx = wx - playerState.x, dz = wz - playerState.z;
      const rx = dz * sin - dx * cos;   // component along camera-right
      const rz = dx * sin + dz * cos;   // component along forward
      return { x: cx + rx * scale, y: cy - rz * scale };
    };

    ctx.strokeStyle = 'rgba(0,245,212,0.35)';
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    trackPoints.forEach((pt, i) => {
      const q = project(pt.pos.x, pt.pos.z);
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    });
    ctx.stroke();

    opponents.forEach(o => {
      const q = project(o.state.x, o.state.z);
      ctx.beginPath(); ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = o.color; ctx.fill();
    });

    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#00f5d4';
    ctx.shadowColor = '#00f5d4'; ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(0, -6); ctx.lineTo(4, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-4, 5); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }, [trackPoints, playerState.x, playerState.z, playerState.yaw, opponents]);

  const gear = (g: number) => (g === -1 ? 'R' : g === 0 ? 'N' : g.toString());
  const rpmPct = Math.min(1, playerState.engineRpm / redline);
  const redlineNear = rpmPct > 0.92;
  const showShiftHint = isManual && redlineNear && playerState.activeGear >= 1;
  const tireClass = (w: { temp: number; wear: number; isPunctured: boolean }) =>
    w.isPunctured ? 'tire-punctured' : w.temp > 108 ? 'tire-hot' : w.wear > 0.6 ? 'tire-worn' : 'tire-good';

  const TACH_TICKS = 20;

  return (
    <div className="hud-overlay">
      {/* Top-left: position / lap / timing */}
      <div className="hud-card top-left-panel">
        <div className="pos-lap-block">
          <div className="hud-metric"><label>POS</label><span className="value-large">{racePosition}<small>/{standings.length || 1}</small></span></div>
          <div className="hud-metric"><label>LAP</label><span className="value-large">{currentLap}<small>/{lapsCount}</small></span></div>
        </div>
        <div className="timer-block">
          <div className="time-row"><span>TIME</span><span className="mono-time">{fmt(timeElapsed)}</span></div>
          <div className="time-row text-cyan"><span>BEST</span><span className="mono-time">{fmt(bestLapTime)}</span></div>
        </div>
      </div>

      {/* Top-right: controls + standings */}
      <div className="hud-actions">
        <button className="hud-btn" onClick={onToggleCamera} title="Camera (C)"><Camera size={16} /><span className="cam-label">{cameraMode}</span></button>
        <button className="hud-btn" onClick={onToggleMute} title="Audio">{isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
        <button className="hud-btn" onClick={onPause} title="Pause (Esc)"><Pause size={16} /></button>
      </div>

      {standings.length > 1 && (
        <div className="hud-card standings-panel">
          {standings.slice(0, 10).map(s => (
            <div key={s.name + s.place} className={`standing-row ${s.you ? 'you' : ''}`}>
              <span className="standing-place">P{s.place}</span>
              <span className="standing-dot" style={{ background: s.color }} />
              <span className="standing-name">{s.name}</span>
              <span className="standing-gap">{s.place === 1 ? '' : `+${s.gap}m`}</span>
            </div>
          ))}
        </div>
      )}

      {/* Drift popup */}
      {(playerState.isDrifting || playerState.driftMultiplier > 1.1) && (
        <div className="drift-popup">
          <h2 className="drift-text">DRIFT</h2>
          <div className="drift-score"><span>{Math.floor(playerState.driftScore).toLocaleString()}</span><span className="drift-mult">x{playerState.driftMultiplier.toFixed(1)}</span></div>
        </div>
      )}

      {/* Shift-up hint for manual boxes */}
      {showShiftHint && <div className="shift-hint blink">SHIFT ⬆ (E)</div>}

      {/* Damage warning */}
      {playerState.damage > 0.3 && (
        <div className="damage-alert"><span className="blink text-red">⚠</span><span>DAMAGE {Math.floor(playerState.damage * 100)}%</span></div>
      )}

      {/* Bottom-left: tires */}
      <div className="hud-card tire-panel">
        <label>TYRES  °C / WEAR</label>
        <div className="tires-grid">
          {(['fl', 'fr', 'rl', 'rr'] as const).map(key => {
            const w = playerState.wheels[key];
            return (
              <div key={key} className={`tire-box ${tireClass(w)}`}>
                <span>{key.toUpperCase()}</span>
                <span>{Math.floor(w.temp)}°</span>
                <span>{Math.floor(w.wear * 100)}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom-centre: tachometer + speed + gearbox state */}
      <div className="hud-card tachometer-panel">
        <div className={`tach-bar ${redlineNear ? 'redline' : ''}`}>
          {Array.from({ length: TACH_TICKS }).map((_, i) => (
            <span key={i} className={`tach-tick ${i / TACH_TICKS < rpmPct ? 'on' : ''} ${i / TACH_TICKS > 0.82 ? 'hot' : ''}`} />
          ))}
        </div>
        <div className="speed-info">
          <div className={`gear-display ${redlineNear ? 'blink' : ''}`}>{gear(playerState.activeGear)}</div>
          <div className="speed-display"><span className="speed-value">{playerState.speed}</span><span className="speed-unit">KM/H</span></div>
          <div className="gearbox-state">
            <span className="gear-mode">{gearboxLabel}</span>
            {clutchHeld && <span className="clutch-dot">CLUTCH</span>}
          </div>
        </div>
        {playerState.turboBoost > 0.05 && (
          <div className="turbo-boost-bar"><span>BOOST</span><div className="boost-bg"><div className="boost-fill" style={{ width: `${Math.min(100, (playerState.turboBoost / Math.max(0.1, boostMax)) * 100)}%` }} /></div></div>
        )}
      </div>

      {/* Minimap */}
      <div className="hud-card minimap-panel">
        <canvas ref={mapRef} width={130} height={130} className="minimap-canvas" />
      </div>
    </div>
  );
};
