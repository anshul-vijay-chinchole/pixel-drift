import { TrackPoint } from './World';

export interface TrafficVehicle {
  id: string;
  x: number;
  z: number;
  y: number;
  yaw: number;
  speed: number;      // m/s
  nodeF: number;      // fractional track index
  lane: number;       // lateral offset direction
  color: string;
  kind: 'car' | 'truck';
  width: number;
  length: number;
}

const CAR_COLORS = ['#c9c9c9', '#8d99ae', '#264653', '#e9c46a', '#6d6875', '#457b9d', '#bc6c25'];

export class TrafficEngine {
  public static spawnTraffic(count: number, trackPoints: TrackPoint[]): TrafficVehicle[] {
    const traffic: TrafficVehicle[] = [];
    const n = trackPoints.length;
    const spacing = n / (count + 1);
    for (let i = 0; i < count; i++) {
      const nodeF = (spacing * (i + 1)) % n;
      const pt = trackPoints[Math.floor(nodeF)];
      const isTruck = Math.random() > 0.7;
      const lane = (Math.random() > 0.5 ? 1 : -1) * (0.28 + Math.random() * 0.12);
      const offset = lane * pt.width;
      traffic.push({
        id: `traffic_${i}`,
        x: pt.pos.x + pt.normal.x * offset,
        z: pt.pos.z + pt.normal.z * offset,
        y: pt.pos.y + 0.1,
        yaw: Math.atan2(pt.tangent.x, pt.tangent.z),
        speed: isTruck ? 11 + Math.random() * 3 : 15 + Math.random() * 6,
        nodeF,
        lane,
        color: CAR_COLORS[i % CAR_COLORS.length],
        kind: isTruck ? 'truck' : 'car',
        width: isTruck ? 2.4 : 1.9,
        length: isTruck ? 8 : 4.4
      });
    }
    return traffic;
  }

  public static updateTraffic(
    traffic: TrafficVehicle[], dt: number, trackPoints: TrackPoint[], playerX: number, playerZ: number
  ) {
    const n = trackPoints.length;
    const totalLen = trackPoints[n - 1].dist || 1;
    const nodeSpacing = totalLen / n;

    traffic.forEach(car => {
      // Yield if the player is close ahead in the same lane.
      const pDist = Math.hypot(car.x - playerX, car.z - playerZ);
      const targetSpeed = pDist < 16 ? 6 : (car.kind === 'truck' ? 13 : 20);
      car.speed += (targetSpeed - car.speed) * Math.min(1, dt * 1.5);

      // Highway is an OPEN track: recycle a car to the start when it reaches the
      // end instead of letting nodeF wrap (which lerped it straight across the
      // map on the closed-loop seam). Never interpolate node n-1 -> node 0.
      car.nodeF += (car.speed * dt) / nodeSpacing;
      if (car.nodeF >= n - 1) {
        car.nodeF -= (n - 1);
        car.lane = (Math.random() > 0.5 ? 1 : -1) * (0.28 + Math.random() * 0.12);
      }
      const i0 = Math.floor(car.nodeF);
      const i1 = Math.min(i0 + 1, n - 1);
      const f = car.nodeF - i0;
      const a = trackPoints[i0], b = trackPoints[i1];

      const offset = car.lane * a.width;
      const px = a.pos.x + (b.pos.x - a.pos.x) * f + a.normal.x * offset;
      const pz = a.pos.z + (b.pos.z - a.pos.z) * f + a.normal.z * offset;
      const py = a.pos.y + (b.pos.y - a.pos.y) * f;
      car.x = px; car.z = pz; car.y = py + 0.1;
      car.yaw = Math.atan2(a.tangent.x, a.tangent.z);
    });
  }
}
