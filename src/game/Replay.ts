import { VehicleState } from './Physics';
import { OpponentRacer } from './AI';

export interface ReplayFrame {
  timestamp: number;
  player: {
    x: number;
    z: number;
    y: number;
    yaw: number;
    roll: number;
    pitch: number;
    speed: number;
    isDrifting: boolean;
    activeGear: number;
    engineRpm: number;
    wheels: {
      fl: { compression: number; slipAngle: number };
      fr: { compression: number; slipAngle: number };
    };
  };
  opponents: {
    id: string;
    x: number;
    z: number;
    y: number;
    yaw: number;
    speed: number;
  }[];
}

export class ReplaySystem {
  private frames: ReplayFrame[] = [];
  private isRecording: boolean = false;
  private isPlaying: boolean = false;
  private playbackFrameIndex: number = 0;
  private recordInterval: number = 0.05; // Record 20 frames per second
  private timer: number = 0;

  public startRecording() {
    this.frames = [];
    this.isRecording = true;
    this.isPlaying = false;
    this.playbackFrameIndex = 0;
    this.timer = 0;
  }

  public stopRecording() {
    this.isRecording = false;
  }

  public recordFrame(dt: number, playerState: VehicleState, opponents: OpponentRacer[]) {
    if (!this.isRecording) return;

    this.timer += dt;
    if (this.timer >= this.recordInterval) {
      this.timer = 0;

      const frame: ReplayFrame = {
        timestamp: Date.now(),
        player: {
          x: playerState.x,
          z: playerState.z,
          y: playerState.y,
          yaw: playerState.yaw,
          roll: playerState.roll,
          pitch: playerState.pitch,
          speed: playerState.speed,
          isDrifting: playerState.isDrifting,
          activeGear: playerState.activeGear,
          engineRpm: playerState.engineRpm,
          wheels: {
            fl: { compression: playerState.wheels.fl.compression, slipAngle: playerState.wheels.fl.slipAngle },
            fr: { compression: playerState.wheels.fr.compression, slipAngle: playerState.wheels.fr.slipAngle }
          }
        },
        opponents: opponents.map(o => ({
          id: o.id,
          x: o.state.x,
          z: o.state.z,
          y: o.state.y,
          yaw: o.state.yaw,
          speed: o.state.speed
        }))
      };

      this.frames.push(frame);

      // Keep maximum of 5 minutes of replay (6000 frames)
      if (this.frames.length > 6000) {
        this.frames.shift();
      }
    }
  }

  public startPlayback() {
    this.isRecording = false;
    this.isPlaying = true;
    this.playbackFrameIndex = 0;
  }

  public stopPlayback() {
    this.isPlaying = false;
  }

  public getPlaybackFrame(dt: number): ReplayFrame | null {
    if (!this.isPlaying || this.frames.length === 0) return null;

    // Advance frame index
    const framesToAdvance = Math.max(1, Math.floor(dt / this.recordInterval));
    this.playbackFrameIndex += framesToAdvance;

    if (this.playbackFrameIndex >= this.frames.length) {
      // Loop replay
      this.playbackFrameIndex = 0;
    }

    return this.frames[this.playbackFrameIndex];
  }

  public getFramesCount(): number {
    return this.frames.length;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }
}
