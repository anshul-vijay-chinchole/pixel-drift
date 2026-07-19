import * as THREE from 'three';
import { VehicleState } from './Physics';
import { TrackPoint, TrackDefinition, wallMargin, terrainInfo, groundHeight, SKIRT_OFFS } from './World';
import { CarLoadout } from '../context/GameContext';

export type CameraMode = 'chase' | 'hood' | 'drone';

// In-game car bodywork: white-base pixel panel textures (PixelLab) that tint
// with the paint colour. Missing files silently fall back to flat paint.
THREE.Cache.enabled = true; // one HTTP fetch per texture file, not per car
const CAR_TEX_LOADER = new THREE.TextureLoader();
function carPanelMat(base: THREE.MeshStandardMaterial, file: string, rx: number, ry: number): THREE.MeshStandardMaterial {
  const mat = base.clone();
  CAR_TEX_LOADER.load(`textures/${file}`, t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestMipmapNearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    t.repeat.set(rx, ry);
    mat.map = t; mat.needsUpdate = true;
  }, undefined, () => { /* keep flat paint */ });
  return mat;
}

// Per-car SILHOUETTE so each of the 14 cars looks like itself in-race (was one
// shared box). PixelLab makes 2D art, so the 3D bodies are shaped by proportion:
// length/width, ride height, greenhouse shape, wheel size and default wing.
export type CarShape = 'coupe' | 'hatch' | 'sedan' | 'roadster' | 'wedge' | 'muscle';
export interface CarProfile { len: number; wid: number; shape: CarShape; low: boolean; wheelR: number; wing: 'none' | 'lip' | 'gt' | 'big'; }
const CAR_PROFILES: Record<string, CarProfile> = {
  ae86:    { len: 4.25, wid: 1.66, shape: 'coupe',    low: false, wheelR: 0.34, wing: 'none' },
  mx5:     { len: 3.95, wid: 1.66, shape: 'roadster', low: true,  wheelR: 0.32, wing: 'none' },
  ek9:     { len: 4.05, wid: 1.70, shape: 'hatch',    low: false, wheelR: 0.33, wing: 'none' },
  gti:     { len: 4.25, wid: 1.78, shape: 'hatch',    low: false, wheelR: 0.34, wing: 'none' },
  foxbody: { len: 4.75, wid: 1.86, shape: 'muscle',   low: false, wheelR: 0.37, wing: 'none' },
  e30:     { len: 4.35, wid: 1.68, shape: 'sedan',    low: false, wheelR: 0.34, wing: 'none' },
  wrx:     { len: 4.50, wid: 1.78, shape: 'sedan',    low: false, wheelR: 0.35, wing: 'gt' },
  evo:     { len: 4.50, wid: 1.80, shape: 'sedan',    low: false, wheelR: 0.35, wing: 'big' },
  gtr34:   { len: 4.60, wid: 1.86, shape: 'coupe',    low: true,  wheelR: 0.36, wing: 'gt' },
  supra:   { len: 4.50, wid: 1.82, shape: 'coupe',    low: true,  wheelR: 0.36, wing: 'lip' },
  nsx:     { len: 4.40, wid: 1.81, shape: 'wedge',    low: true,  wheelR: 0.35, wing: 'none' },
  f40:     { len: 4.40, wid: 1.98, shape: 'wedge',    low: true,  wheelR: 0.36, wing: 'big' },
  cgt:     { len: 4.60, wid: 1.92, shape: 'wedge',    low: true,  wheelR: 0.36, wing: 'gt' },
  sv12:    { len: 4.78, wid: 2.04, shape: 'wedge',    low: true,  wheelR: 0.37, wing: 'big' },
};
const DEFAULT_PROFILE: CarProfile = { len: 4.4, wid: 1.9, shape: 'coupe', low: false, wheelR: 0.35, wing: 'none' };
export function carProfileFor(id?: string): CarProfile { return (id ? CAR_PROFILES[id] : undefined) || DEFAULT_PROFILE; }

// Factory: build a stylised low-poly car group facing +Z, shaped by profile.
function buildCarMesh(bodyColor: string, opts: { player?: boolean; custom?: CarLoadout; profile?: CarProfile } = {}): {
  group: THREE.Group;
  wheels: THREE.Object3D[];
  brakeLights: THREE.MeshBasicMaterial[];
  headlights: THREE.SpotLight[];
} {
  const prof = opts.profile || DEFAULT_PROFILE;
  const { len, wid, shape, wheelR } = prof;
  const hl = len / 2;
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: new THREE.Color(bodyColor), roughness: 0.35, metalness: 0.55, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: '#15151c', roughness: 0.5, metalness: 0.2, flatShading: true });
  const glass = new THREE.MeshStandardMaterial({ color: shape === 'roadster' ? '#181820' : '#101820', roughness: 0.1, metalness: 0.6, flatShading: true });

  const bodyH = 0.42;
  const lowerY = wheelR + (prof.low ? 0.04 : 0.11); // body sits above the wheels; group origin at wheel-contact

  // Lower body — per-face pixel panels (BoxGeometry face order: +x, -x, +y,
  // -y, +z, -z = right side, left side, hood, floor, nose, tail).
  const sideMat = carPanelMat(paint, 'car_side.png', 3, 1);
  const lower = new THREE.Mesh(
    new THREE.BoxGeometry(wid, bodyH, len),
    [sideMat, sideMat, carPanelMat(paint, 'car_hood.png', 1, 2), dark, carPanelMat(paint, 'car_front.png', 1, 1), carPanelMat(paint, 'car_rear.png', 1, 1)]
  );
  lower.position.y = lowerY; lower.castShadow = true; lower.receiveShadow = true;
  group.add(lower);

  // Shape-derived greenhouse (upper body + cabin) + nose, all relative to len.
  let upperH = 0.36, upperLen = len * 0.5, upperZ = -len * 0.05;
  let cabinH = 0.46, cabinLen = len * 0.40, cabinZ = -len * 0.07;
  let noseLen = len * 0.22, noseH = 0.26, deckLen = 0;
  switch (shape) {
    case 'roadster': upperH = 0.18; upperLen = len * 0.40; cabinH = 0.20; cabinLen = len * 0.22; cabinZ = -len * 0.02; break;
    case 'hatch':    upperLen = len * 0.58; upperZ = -len * 0.10; cabinLen = len * 0.48; cabinZ = -len * 0.13; cabinH = 0.50; break;
    case 'sedan':    upperLen = len * 0.50; cabinLen = len * 0.34; cabinH = 0.52; cabinZ = -len * 0.03; break;
    case 'muscle':   noseLen = len * 0.30; upperZ = -len * 0.13; cabinZ = -len * 0.15; upperH = 0.34; break;
    case 'wedge':    upperH = 0.24; upperZ = len * 0.02; cabinH = 0.32; cabinLen = len * 0.34; cabinZ = len * 0.02; noseLen = len * 0.26; noseH = 0.20; deckLen = len * 0.30; break;
  }
  const upperY = lowerY + bodyH / 2 + upperH / 2 - 0.02;
  const upper = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.9, upperH, upperLen), paint);
  upper.position.set(0, upperY, upperZ); upper.castShadow = true;
  group.add(upper);
  const cabinY = upperY + upperH / 2 + cabinH / 2 - 0.04;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.8, cabinH, cabinLen), glass);
  cabin.position.set(0, cabinY, cabinZ); cabin.castShadow = true;
  group.add(cabin);
  // Nose slope.
  const nose = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.9, noseH, noseLen), paint);
  nose.position.set(0, lowerY + 0.06, hl - noseLen * 0.5 - 0.12); nose.rotation.x = -0.12; nose.castShadow = true;
  group.add(nose);
  // Mid-engine deck (wedge cars): a low rear deck behind the cabin.
  if (deckLen > 0) {
    const deck = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.88, 0.22, deckLen), dark);
    deck.position.set(0, upperY - 0.02, -hl + deckLen * 0.5 + 0.1); deck.castShadow = true;
    group.add(deck);
  }

  // Wheels — sized per car, tucked to the corners.
  const wheelGeo = new THREE.CylinderGeometry(wheelR, wheelR, 0.34, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  const rim = new THREE.MeshStandardMaterial({ color: '#3a3a3f', roughness: 0.4, metalness: 0.7 });
  const tyre = new THREE.MeshStandardMaterial({ color: '#0d0d10', roughness: 0.9 });
  const wx = wid * 0.52, wz = hl - wheelR - 0.35;
  const wheelPos: [number, number, number][] = [[-wx, wheelR, wz], [wx, wheelR, wz], [-wx, wheelR, -wz], [wx, wheelR, -wz]];
  const wheels: THREE.Object3D[] = [];
  for (const p of wheelPos) {
    const w = new THREE.Group();
    const t = new THREE.Mesh(wheelGeo, tyre); t.castShadow = true; w.add(t);
    const r = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 0.56, wheelR * 0.56, 0.36, 8), rim); r.rotation.z = Math.PI / 2; w.add(r);
    w.position.set(p[0], p[1], p[2]);
    group.add(w); wheels.push(w);
  }

  // Head + brake lights.
  const brakeLights: THREE.MeshBasicMaterial[] = [];
  const headlights: THREE.SpotLight[] = [];
  const hlMat = new THREE.MeshBasicMaterial({ color: 0xfff2cc });
  const lx = wid * 0.32;
  for (const x of [-lx, lx]) {
    const hlmesh = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.1), hlMat);
    hlmesh.position.set(x, lowerY + 0.14, hl - 0.03); group.add(hlmesh);
    const blMat = new THREE.MeshBasicMaterial({ color: 0x330000 });
    const bl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.08), blMat);
    bl.position.set(x, lowerY + 0.16, -hl + 0.02); group.add(bl); brakeLights.push(blMat);
    if (opts.player) {
      const spot = new THREE.SpotLight(0xfff4d0, 0, 55, Math.PI / 7, 0.4, 1.2);
      spot.position.set(x, lowerY + 0.14, hl - 0.05); spot.target.position.set(x, -0.5, 30);
      group.add(spot); group.add(spot.target); headlights.push(spot);
    }
  }
  // Grille / splitter.
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.96, 0.1, 0.3), dark);
  splitter.position.set(0, lowerY - 0.16, hl - 0.05); group.add(splitter);

  // Aero wing — player uses the loadout AERO slot, AI/others use the profile's
  // default wing, so wings show up on every car that should have one.
  const wing = (opts.player && opts.custom) ? opts.custom.aero : prof.wing;
  if (wing !== 'none') {
    const wingMat = new THREE.MeshStandardMaterial({ color: '#111', flatShading: true, metalness: 0.3 });
    const wg = new THREE.Group(); wg.position.set(0, lowerY + bodyH + 0.12, -hl + 0.12);
    const halfw = wid * 0.5;
    if (wing === 'gt') {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.14), wingMat); l.position.set(-halfw * 0.72, 0.2, 0);
      const r = l.clone(); r.position.x = halfw * 0.72;
      const flap = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.98, 0.06, 0.5), wingMat); flap.position.y = 0.42;
      wg.add(l, r, flap);
    } else if (wing === 'lip') {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.88, 0.06, 0.32), wingMat); lip.position.y = 0.12; wg.add(lip);
    } else { // big wing + front splitter
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.16), wingMat); l.position.set(-halfw * 0.76, 0.25, 0);
      const r = l.clone(); r.position.x = halfw * 0.76;
      const flap = new THREE.Mesh(new THREE.BoxGeometry(wid * 1.05, 0.07, 0.6), wingMat); flap.position.y = 0.52; flap.rotation.x = -0.12;
      wg.add(l, r, flap);
      // (the always-present front splitter below covers the "+ splitter" look;
      // a second one here rendered below the road, so it's removed)
    }
    group.add(wg);
  }

  // Player-only neon underglow.
  if (opts.player && opts.custom && opts.custom.neonColor !== 'none') {
    const neon = new THREE.PointLight(new THREE.Color(opts.custom.neonColor), 4, 9, 2);
    neon.position.set(0, 0.05, 0); group.add(neon);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.98, 0.04, len * 0.95), new THREE.MeshBasicMaterial({ color: new THREE.Color(opts.custom.neonColor) }));
    strip.position.y = 0.12; group.add(strip);
  }

  return { group, wheels, brakeLights, headlights };
}

export class GameGraphics {
  public scene!: THREE.Scene;
  public camera!: THREE.PerspectiveCamera;
  public renderer!: THREE.WebGLRenderer;

  private container: HTMLDivElement;
  private pixelScale: number;

  private dirLight!: THREE.DirectionalLight;
  private ambientLight!: THREE.AmbientLight;
  private hemi!: THREE.HemisphereLight;
  private headlights: THREE.SpotLight[] = [];

  private roadMesh: THREE.Mesh | null = null;
  private groundMesh: THREE.Mesh | null = null;
  private sceneryGroup = new THREE.Group();
  private trackDecoGroup = new THREE.Group();
  private sunMesh!: THREE.Mesh;

  public carGroup = new THREE.Group();
  private wheels: THREE.Object3D[] = [];
  private brakeLights: THREE.MeshBasicMaterial[] = [];

  private aiCars = new Map<string, { group: THREE.Group; wheels: THREE.Object3D[] }>();

  // Weather particles.
  private precip: THREE.Points | null = null;
  private precipGeo!: THREE.BufferGeometry;
  private precipCount = 1500;

  // Skid marks (ring buffer of quads).
  private skidMarks: THREE.Mesh[] = [];
  private skidIndex = 0;
  private skidMax = 260;
  private skidMat!: THREE.MeshBasicMaterial;

  // Tyre smoke / dust particle pool.
  private smoke!: THREE.Points;
  private smokeGeo!: THREE.BufferGeometry;
  private smokePos!: Float32Array;
  private smokeVel: Float32Array;
  private smokeLife: Float32Array;
  private smokeColor!: Float32Array;
  private smokeMax = 140;
  private smokeHead = 0;

  public timeOfDay = 12.0;
  private weather = 'sunny';
  private theme: TrackDefinition | null = null;
  private baseFov = 62;
  private shake = 0;
  private camInit = false;
  private texLoader = new THREE.TextureLoader();
  // Terrain: backdrop plane height + whether this track has real elevation
  // (which switches on the road-following "skirt" terrain).
  private backdropY = -0.15;
  private hasRelief = false;

  // Ground height at `edgeDist` metres beyond the road edge — delegates to the
  // shared World.groundHeight so the mesh, scenery and car all agree.
  private groundY(ny: number, edgeDist: number): number {
    return groundHeight(ny, edgeDist, this.backdropY, this.hasRelief);
  }

  // Load a repeating pixel-art surface texture. Nearest filtering keeps it crisp
  // through the 0.6x pixel post-render. On a missing/failed file it does nothing,
  // so the material keeps its flat theme colour — textures are purely additive.
  private loadTile(url: string, repeat: number, onReady: (t: THREE.Texture) => void) {
    this.texLoader.load(url, tex => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.NearestFilter;                 // crisp pixels up close
      // Trilinear + anisotropy at DISTANCE kills the grazing-angle shimmer/moiré
      // that made the tiled ground (worst on bright snow) look glitchy.
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.repeat.set(repeat, repeat);
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      onReady(tex);
    }, undefined, () => { /* missing/failed: keep the flat colour */ });
  }

  constructor(container: HTMLDivElement, pixelScale = 0.55) {
    this.container = container;
    this.pixelScale = pixelScale;
    this.smokeVel = new Float32Array(this.smokeMax * 3);
    this.smokeLife = new Float32Array(this.smokeMax);
    this.initThree();
    this.setupLighting();
    this.setupPrecip();
    this.setupSkid();
    this.setupSmoke();
    window.addEventListener('resize', this.onResize);
  }

  private dims() {
    const w = this.container.clientWidth || window.innerWidth || 1280;
    const h = this.container.clientHeight || window.innerHeight || 720;
    return { w, h };
  }

  private onResize = () => {
    const { w, h } = this.dims();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(Math.max(480, Math.floor(w * this.pixelScale)), Math.max(320, Math.floor(h * this.pixelScale)), false);
  };

  private initThree() {
    const { w, h } = this.dims();
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#8ec9e6');
    this.scene.fog = new THREE.FogExp2('#8ec9e6', 0.0016);

    this.camera = new THREE.PerspectiveCamera(this.baseFov, w / h, 0.4, 3000);
    this.camera.position.set(0, 4, -10);

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.setSize(Math.max(480, Math.floor(w * this.pixelScale)), Math.max(320, Math.floor(h * this.pixelScale)), false);

    const canvas = this.renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.imageRendering = 'pixelated';
    canvas.style.display = 'block';
    // Survive a GPU context loss (driver reset, tab throttling, OOM). Without
    // preventDefault() the browser refuses to restore the context and the game
    // freezes on a black canvas permanently; with it, Three.js re-uploads GPU
    // resources on the next render and play continues.
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); }, false);
    this.container.appendChild(canvas);
  }

  private setupLighting() {
    this.hemi = new THREE.HemisphereLight('#bfe3ff', '#3a4a30', 0.6);
    this.scene.add(this.hemi);
    this.ambientLight = new THREE.AmbientLight('#ffffff', 0.35);
    this.scene.add(this.ambientLight);

    this.dirLight = new THREE.DirectionalLight('#fff3d1', 1.25);
    this.dirLight.position.set(120, 220, 80);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(2048, 2048);
    this.dirLight.shadow.camera.near = 1;
    this.dirLight.shadow.camera.far = 700;
    const d = 140;
    this.dirLight.shadow.camera.left = -d; this.dirLight.shadow.camera.right = d;
    this.dirLight.shadow.camera.top = d; this.dirLight.shadow.camera.bottom = -d;
    this.dirLight.shadow.bias = -0.0006;
    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target);

    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(30, 16, 16), new THREE.MeshBasicMaterial({ color: '#fff2b0', fog: false }));
    this.scene.add(this.sunMesh);
  }

  private setupPrecip() {
    this.precipGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(this.precipCount * 3);
    for (let i = 0; i < this.precipCount * 3; i += 3) {
      pos[i] = (Math.random() - 0.5) * 120; pos[i + 1] = Math.random() * 60; pos[i + 2] = (Math.random() - 0.5) * 120;
    }
    this.precipGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.precip = new THREE.Points(this.precipGeo, new THREE.PointsMaterial({ color: 0xbcd4ff, size: 0.28, transparent: true, opacity: 0.55 }));
    this.precip.visible = false;
    this.precip.frustumCulled = false;
    this.scene.add(this.precip);
  }

  private setupSkid() {
    this.skidMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.5, depthWrite: false });
    const geo = new THREE.PlaneGeometry(0.32, 0.7);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < this.skidMax; i++) {
      const m = new THREE.Mesh(geo, this.skidMat);
      m.visible = false; m.renderOrder = 1;
      this.scene.add(m); this.skidMarks.push(m);
    }
  }

  private setupSmoke() {
    this.smokeGeo = new THREE.BufferGeometry();
    this.smokePos = new Float32Array(this.smokeMax * 3);
    this.smokeColor = new Float32Array(this.smokeMax * 3);
    for (let i = 0; i < this.smokeMax; i++) { this.smokePos[i * 3 + 1] = -999; }
    this.smokeGeo.setAttribute('position', new THREE.BufferAttribute(this.smokePos, 3));
    this.smokeGeo.setAttribute('color', new THREE.BufferAttribute(this.smokeColor, 3));
    this.smoke = new THREE.Points(this.smokeGeo, new THREE.PointsMaterial({ size: 1.2, transparent: true, opacity: 0.35, vertexColors: true, depthWrite: false }));
    this.smoke.frustumCulled = false;
    this.scene.add(this.smoke);
  }

  private emitSmoke(x: number, y: number, z: number, r: number, g: number, b: number) {
    const i = this.smokeHead;
    this.smokePos[i * 3] = x; this.smokePos[i * 3 + 1] = y; this.smokePos[i * 3 + 2] = z;
    this.smokeColor[i * 3] = r; this.smokeColor[i * 3 + 1] = g; this.smokeColor[i * 3 + 2] = b;
    this.smokeVel[i * 3] = (Math.random() - 0.5) * 1.5;
    this.smokeVel[i * 3 + 1] = 1.2 + Math.random() * 1.5;
    this.smokeVel[i * 3 + 2] = (Math.random() - 0.5) * 1.5;
    this.smokeLife[i] = 1.0;
    this.smokeHead = (this.smokeHead + 1) % this.smokeMax;
  }

  private dropSkid(x: number, y: number, z: number, yaw: number) {
    const m = this.skidMarks[this.skidIndex];
    m.position.set(x, y + 0.03, z);
    m.rotation.y = yaw;
    m.visible = true;
    (m as any)._born = this.timeOfDay;
    this.skidIndex = (this.skidIndex + 1) % this.skidMax;
  }

  public buildTrackGraphics(trackDef: TrackDefinition, tp: TrackPoint[], weather = 'sunny') {
    this.theme = trackDef;
    if (this.roadMesh) { this.scene.remove(this.roadMesh); this.roadMesh.geometry.dispose(); }
    if (this.groundMesh) { this.scene.remove(this.groundMesh); }
    this.scene.remove(this.sceneryGroup); this.sceneryGroup = new THREE.Group();
    this.scene.remove(this.trackDecoGroup); this.trackDecoGroup = new THREE.Group();

    // Ground = backdrop plane at the track's LOWEST level + (for tracks with
    // real elevation) a "skirt" that follows the road height and falls away to
    // the backdrop. Before this, one flat plane at -0.15 buried downhill roads
    // (Akina descends 126 m below it) and left climbing roads floating in air
    // with visible gaps at corners.
    const terr = terrainInfo(tp);
    this.hasRelief = terr.hasRelief;
    this.backdropY = terr.backdropY;

    const groundMat = new THREE.MeshStandardMaterial({ color: trackDef.groundColor, roughness: 1, metalness: 0, flatShading: true, side: THREE.DoubleSide });
    this.groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), groundMat);
    this.groundMesh.rotation.x = -Math.PI / 2; this.groundMesh.position.y = this.backdropY;
    this.groundMesh.receiveShadow = true;
    this.scene.add(this.groundMesh);

    let skirtMat: THREE.MeshStandardMaterial | null = null;
    if (this.hasRelief) {
      skirtMat = groundMat.clone();
      const sg = new THREE.BufferGeometry();
      const sv: number[] = []; const suv: number[] = []; const six: number[] = [];
      const n = tp.length;
      for (let i = 0; i < n; i++) {
        const p = tp[i]; const hw = p.width / 2;
        for (const side of [-1, 1]) {
          for (let k = 0; k < SKIRT_OFFS.length; k++) {
            const d = hw + SKIRT_OFFS[k];
            const x = p.pos.x + p.normal.x * side * d;
            const z = p.pos.z + p.normal.z * side * d;
            sv.push(x, this.groundY(p.pos.y, SKIRT_OFFS[k]), z);
            suv.push(x / 6, z / 6); // planar world-space UVs, 6 m per tile
          }
        }
      }
      const per = SKIRT_OFFS.length * 2; // verts per node (both sides)
      const end = trackDef.isClosed ? n : n - 1;
      for (let i = 0; i < end; i++) {
        const a = i * per, b = ((i + 1) % n) * per;
        for (const s0 of [0, SKIRT_OFFS.length]) {
          for (let k = 0; k < SKIRT_OFFS.length - 1; k++) {
            const i0 = a + s0 + k, i1 = a + s0 + k + 1, j0 = b + s0 + k, j1 = b + s0 + k + 1;
            six.push(i0, j0, i1, i1, j0, j1);
          }
        }
      }
      sg.setAttribute('position', new THREE.Float32BufferAttribute(sv, 3));
      sg.setAttribute('uv', new THREE.Float32BufferAttribute(suv, 2));
      sg.setIndex(six); sg.computeVertexNormals();
      const skirt = new THREE.Mesh(sg, skirtMat);
      skirt.receiveShadow = true;
      this.trackDecoGroup.add(skirt);
    }

    // Road ribbon (with vertex-coloured curbs handled separately). UVs run u
    // across the width and v along the arc length so a tarmac/dirt texture tiles
    // down the road at a fixed real-world scale.
    const roadGeo = new THREE.BufferGeometry();
    const verts: number[] = []; const uvs: number[] = []; const idx: number[] = [];
    const tileM = 8; // metres of road per texture repeat
    for (let i = 0; i < tp.length; i++) {
      const p = tp[i]; const hw = p.width / 2;
      verts.push(p.pos.x + p.normal.x * hw, p.pos.y + 0.04, p.pos.z + p.normal.z * hw);
      verts.push(p.pos.x - p.normal.x * hw, p.pos.y + 0.04, p.pos.z - p.normal.z * hw);
      const v = p.dist / tileM, uR = p.width / tileM;
      uvs.push(0, v, uR, v);
      const next = i + 1;
      if (next < tp.length) {
        const r = i * 2;
        idx.push(r, r + 2, r + 1, r + 1, r + 2, r + 3);
      }
    }
    if (trackDef.isClosed) {
      const r = (tp.length - 1) * 2;
      idx.push(r, 0, r + 1, r + 1, 0, 1);
    }
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    roadGeo.setIndex(idx); roadGeo.computeVertexNormals();
    const roadMat = new THREE.MeshStandardMaterial({ color: trackDef.roadColor, roughness: trackDef.theme === 'forest' ? 1 : 0.85, metalness: 0.02, side: THREE.DoubleSide, flatShading: true });
    this.roadMesh = new THREE.Mesh(roadGeo, roadMat);
    this.roadMesh.receiveShadow = true;
    this.scene.add(this.roadMesh);

    // Pixel-art surface textures (additive: silently keep flat colour if absent).
    // Plane is 6000 m with 0..1 UVs -> repeat 1000 = 6 m per tile (300 gave 20 m
    // tiles whose dark pixels read as huge ugly blobs). The skirt has world-space
    // /6 UVs, so it loads its own texture at repeat 1 for the same density.
    // Theme/weather variety: snowy races blanket the ground, coastal tracks with
    // elevation sit above the SEA, and mountain hillsides read as rock cliffs.
    const snowy = weather === 'snowy';
    const groundKey = snowy ? 'snow' : (GROUND_TEX[trackDef.theme] || 'grass');
    const planeKey = !snowy && trackDef.theme === 'coast' && this.hasRelief ? 'water' : groundKey;
    const skirtKey = snowy ? 'snow' : trackDef.theme === 'mountain' ? 'rock' : groundKey;
    this.loadTile(`textures/${planeKey}.png`, 1000, t => { groundMat.map = t; groundMat.color.set('#ffffff'); groundMat.needsUpdate = true; });
    if (skirtMat) {
      const sm = skirtMat;
      this.loadTile(`textures/${skirtKey}.png`, 1, t => { sm.map = t; sm.color.set('#ffffff'); sm.needsUpdate = true; });
    }
    const roadKey = trackDef.theme === 'forest' ? 'dirt' : 'asphalt';
    this.loadTile(`textures/${roadKey}.png`, 1, t => { roadMat.map = t; roadMat.color.set('#ffffff'); roadMat.needsUpdate = true; });

    this.buildCurbsAndLines(trackDef, tp);
    this.generateScenery(trackDef, tp);
    this.scene.add(this.sceneryGroup);
    this.scene.add(this.trackDecoGroup);
  }

  private buildCurbsAndLines(trackDef: TrackDefinition, tp: TrackPoint[]) {
    const isTarmac = trackDef.theme !== 'forest';
    const redMat = new THREE.MeshStandardMaterial({ color: '#d63b3b', flatShading: true });
    const whiteMat = new THREE.MeshStandardMaterial({ color: '#e8e8e8', flatShading: true });
    const curbGeo = new THREE.BoxGeometry(0.7, 0.12, 2.2);

    // Road markings — unlit so they stay bright in any weather/night. These are
    // what make the road read clearly against the ground.
    if (isTarmac) {
      const n = tp.length;
      // White edge lines: two continuous ribbons just inside each road edge.
      // DoubleSide: the +normal side's triangles wind clockwise from above, so
      // FrontSide would backface-cull one of the two lines entirely.
      const lineMat = new THREE.MeshBasicMaterial({ color: '#dfe3e6', side: THREE.DoubleSide });
      const lg = new THREE.BufferGeometry();
      const lv: number[] = []; const lix: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = tp[i];
        for (const side of [-1, 1]) {
          for (const off of [p.width / 2 - 0.55, p.width / 2 - 0.25]) {
            lv.push(p.pos.x + p.normal.x * side * off, p.pos.y + 0.07, p.pos.z + p.normal.z * side * off);
          }
        }
      }
      const end = trackDef.isClosed ? n : n - 1;
      for (let i = 0; i < end; i++) {
        const a = i * 4, b = ((i + 1) % n) * 4;
        for (const s0 of [0, 2]) {
          lix.push(a + s0, b + s0, a + s0 + 1, a + s0 + 1, b + s0, b + s0 + 1);
        }
      }
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lv, 3));
      lg.setIndex(lix);
      const lines = new THREE.Mesh(lg, lineMat);
      this.trackDecoGroup.add(lines);

      // Dashed centre line.
      const dashMat = new THREE.MeshBasicMaterial({ color: '#d9d9c2' });
      const dashGeo = new THREE.PlaneGeometry(0.26, 2.4);
      dashGeo.rotateX(-Math.PI / 2);
      for (let i = 0; i < n; i += 3) {
        const p = tp[i];
        const dash = new THREE.Mesh(dashGeo, dashMat);
        dash.position.set(p.pos.x, p.pos.y + 0.08, p.pos.z);
        // lookAt along the full 3D tangent (incl. y) so dashes pitch with the
        // road grade — yaw-only rotation buried one end on any slope > ~2.5%.
        dash.lookAt(p.pos.x + p.tangent.x, p.pos.y + 0.08 + p.tangent.y, p.pos.z + p.tangent.z);
        this.trackDecoGroup.add(dash);
      }
    }

    for (let i = 0; i < tp.length; i += 2) {
      const p = tp[i];
      // Curbs only on corners of tarmac tracks.
      if (isTarmac && p.curvature > 0.02) {
        for (const side of [-1, 1]) {
          const hw = p.width / 2 + 0.35;
          const cx = p.pos.x + p.normal.x * side * hw;
          const cz = p.pos.z + p.normal.z * side * hw;
          const curb = new THREE.Mesh(curbGeo, (i % 4 === 0) ? redMat : whiteMat);
          curb.position.set(cx, p.pos.y + 0.06, cz);
          curb.rotation.y = Math.atan2(p.tangent.x, p.tangent.z);
          curb.receiveShadow = true;
          this.trackDecoGroup.add(curb);
        }
      }
    }

    // City street circuit: continuous concrete walls hugging the road.
    if (trackDef.theme === 'city') {
      const wallMat = new THREE.MeshStandardMaterial({ color: '#8e8e96', roughness: 0.9, flatShading: true });
      const stripeMat = new THREE.MeshBasicMaterial({ color: '#d43c3c' });
      for (let i = 0; i < tp.length; i += 2) {
        const p = tp[i];
        const next = tp[(i + 2) % tp.length];
        const segLen = p.pos.distanceTo(next.pos) * 1.1;
        for (const side of [-1, 1]) {
          // Just past the physics limit (width/2 + WALL_MARGIN.city 2.4) so you
          // collide right at the visible wall face, not 0.8 m before it.
          const hw = p.width / 2 + 2.55;
          const wx = p.pos.x + p.normal.x * side * hw;
          const wz = p.pos.z + p.normal.z * side * hw;
          const wall = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, segLen), wallMat);
          wall.position.set(wx, p.pos.y + 0.5, wz);
          wall.rotation.y = Math.atan2(p.tangent.x, p.tangent.z);
          wall.castShadow = true; wall.receiveShadow = true;
          this.trackDecoGroup.add(wall);
          if (i % 8 === 0) {
            const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.18, 1.6), stripeMat);
            stripe.position.set(wx, p.pos.y + 0.95, wz);
            stripe.rotation.y = Math.atan2(p.tangent.x, p.tangent.z);
            this.trackDecoGroup.add(stripe);
          }
        }
      }
    }

    // Boundary guardrail — a visible red/white Armco marking the invisible wall
    // on every non-city track (city already has its concrete walls). Sits at
    // width/2 + WALL_MARGIN, exactly where the physics stops you, so you can
    // read the edge instead of hitting nothing.
    if (trackDef.theme !== 'city') {
      const margin = wallMargin(trackDef.theme);
      const postMat = new THREE.MeshStandardMaterial({ color: '#8a8f96', roughness: 0.7, metalness: 0.3, flatShading: true });
      const railW = new THREE.MeshStandardMaterial({ color: '#ececee', roughness: 0.6, flatShading: true });
      const railR = new THREE.MeshStandardMaterial({ color: '#d43c3c', roughness: 0.6, flatShading: true });
      const postGeo = new THREE.BoxGeometry(0.12, 0.66, 0.12);
      for (let i = 0; i < tp.length; i += 2) {
        const p = tp[i];
        const hasNext = trackDef.isClosed || i + 2 < tp.length;
        const next = tp[(i + 2) % tp.length];
        const segLen = hasNext ? p.pos.distanceTo(next.pos) * 1.15 : 0;
        const rot = Math.atan2(p.tangent.x, p.tangent.z);
        for (const side of [-1, 1]) {
          const d = p.width / 2 + margin;
          const bx = p.pos.x + p.normal.x * side * d, bz = p.pos.z + p.normal.z * side * d;
          if (hasNext) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.22, segLen), (i % 8 === 0) ? railR : railW);
            rail.position.set(bx, p.pos.y + 0.62, bz); rail.rotation.y = rot; rail.castShadow = true; rail.receiveShadow = true;
            this.trackDecoGroup.add(rail);
          }
          if (i % 4 === 0) {
            const post = new THREE.Mesh(postGeo, postMat);
            post.position.set(bx, p.pos.y + 0.33, bz); this.trackDecoGroup.add(post);
          }
        }
      }
    }

    // Start / finish line (checkered strip across the road at node 0).
    const start = tp[0];
    const lineGroup = new THREE.Group();
    const cols = 8;
    const cellW = start.width / cols;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < 2; r++) {
        const col = (c + r) % 2 === 0 ? '#f5f5f5' : '#1a1a1a';
        const cell = new THREE.Mesh(new THREE.PlaneGeometry(cellW, 1.4), new THREE.MeshBasicMaterial({ color: col }));
        cell.rotation.x = -Math.PI / 2;
        const along = (r - 0.5) * 1.5;
        const lateral = (c - (cols - 1) / 2) * cellW;
        cell.position.set(
          start.pos.x + start.normal.x * lateral + start.tangent.x * along,
          start.pos.y + 0.06,
          start.pos.z + start.normal.z * lateral + start.tangent.z * along
        );
        lineGroup.add(cell);
      }
    }
    this.trackDecoGroup.add(lineGroup);

    // Grandstands at start/finish — atmosphere/realism. Long ALONG the track
    // (depth = local +Z = tangent after yaw), shallow laterally, and pushed out
    // by the block's own half-depth so it never clips the racing surface. City
    // is excluded (its concrete walls leave no room).
    if (trackDef.isClosed && trackDef.theme !== 'forest' && trackDef.theme !== 'city') {
      const margin = wallMargin(trackDef.theme);
      const frameMat = new THREE.MeshStandardMaterial({ color: '#7f858f', roughness: 0.9, flatShading: true });
      const seatCols = ['#3a6ea5', '#d24d4d', '#e0b23c'];
      const p0 = tp[0];
      const rot = Math.atan2(p0.tangent.x, p0.tangent.z);
      const standW = 9;                              // lateral extent (half = 4.5)
      const d = p0.width / 2 + margin + standW / 2 + 2; // inner face ~2 m past the wall
      for (const side of [-1, 1]) {
        for (let s = 0; s < 3; s++) {
          const along = -26 + s * 26;
          const bx = p0.pos.x + p0.normal.x * side * d + p0.tangent.x * along;
          const bz = p0.pos.z + p0.normal.z * side * d + p0.tangent.z * along;
          const g = new THREE.Group();
          const base = new THREE.Mesh(new THREE.BoxGeometry(standW, 6, 24), frameMat); base.position.y = 3; g.add(base);
          const tier = new THREE.Mesh(new THREE.BoxGeometry(standW - 1, 1.4, 22), new THREE.MeshStandardMaterial({ color: seatCols[s % 3], roughness: 0.95, flatShading: true }));
          tier.position.y = 6.4; g.add(tier);
          g.position.set(bx, p0.pos.y, bz); g.rotation.y = rot;
          g.traverse(o => { o.castShadow = true; o.receiveShadow = true; });
          this.trackDecoGroup.add(g);
        }
      }
    }
  }

  private generateScenery(trackDef: TrackDefinition, tp: TrackPoint[]) {
    const theme = trackDef.theme;
    const step = 3;
    const treeLeaf = new THREE.MeshStandardMaterial({ color: theme === 'forest' ? '#1f5e2a' : '#2a7d3a', roughness: 0.9, flatShading: true });
    const trunkMat = new THREE.MeshStandardMaterial({ color: '#4a3524', roughness: 0.9 });
    const treeGeo = new THREE.ConeGeometry(2.6, theme === 'forest' ? 12 : 7, 6);
    const trunkGeo = new THREE.CylinderGeometry(0.4, 0.55, 3, 5);
    const rockGeo = new THREE.DodecahedronGeometry(1.4, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: '#6f6f74', roughness: 0.95, flatShading: true });
    const houseColors = ['#c9ada7', '#8d99ae', '#a8c0c4', '#d8d8d2', '#b0846a'];
    const roofColors = ['#9a031e', '#2b2d42', '#5a4b6d', '#e76f51', '#3a5a40'];
    const isCity = theme === 'city' || theme === 'harbour' || theme === 'coast';
    // Desert / airfield: pines look absurd — sparse cacti and lots of rocks.
    const desertish = theme === 'desert' || theme === 'airport';
    const cactusMat = new THREE.MeshStandardMaterial({ color: '#3f7d44', roughness: 0.85, flatShading: true });
    const cactusGeo = new THREE.CylinderGeometry(0.3, 0.36, 2.8, 6);
    const cactusArmGeo = new THREE.CylinderGeometry(0.15, 0.18, 1.1, 5);
    const roofGeo = new THREE.ConeGeometry(8, 5, 4);

    // Everything spawns BEYOND the invisible wall so a car can never drive
    // through a tree/rock (they had no collision). +3 m clear of the boundary.
    const margin = wallMargin(theme);
    for (let i = 0; i < tp.length; i += step) {
      const p = tp[i]; const hw = p.width / 2;
      for (const side of [-1, 1]) {
        const dist = hw + margin + 3 + Math.random() * 14;
        const px = p.pos.x + p.normal.x * side * dist;
        const pz = p.pos.z + p.normal.z * side * dist;
        // Sit on the terrain skirt, not the (possibly far-away) node height.
        const py = this.groundY(p.pos.y, dist - hw);
        if (Math.random() > (desertish ? 0.75 : 0.4)) {
          if (isCity && Math.random() > 0.45) {
            const ci = Math.floor(Math.random() * houseColors.length);
            const height = 9 + Math.random() * (theme === 'city' ? 34 : 16);
            const bw = 8 + Math.random() * 7, bd = 8 + Math.random() * 7;
            const bGeo = new THREE.BoxGeometry(bw, height, bd);
            // Push the building out by its own half-footprint so its FACE (not
            // just its centre) clears the wall — otherwise big buildings' bodies
            // reached inside the boundary and the car drove through them.
            const bdist = hw + margin + Math.max(bw, bd) * 0.5 + 2 + Math.random() * 8;
            const bx = p.pos.x + p.normal.x * side * bdist, bz = p.pos.z + p.normal.z * side * bdist;
            const by = this.groundY(p.pos.y, bdist - hw);
            const house = new THREE.Mesh(bGeo, new THREE.MeshStandardMaterial({ color: houseColors[ci], flatShading: true, roughness: 0.8 }));
            house.position.set(bx, by + height / 2, bz); house.castShadow = true; house.receiveShadow = true;
            this.sceneryGroup.add(house);
            if (theme !== 'city') {
              const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: roofColors[ci], flatShading: true }));
              roof.position.set(bx, by + height + 2, bz); roof.rotation.y = Math.PI / 4; roof.castShadow = true;
              this.sceneryGroup.add(roof);
            } else {
              // Lit windows for night city.
              const win = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.9, height * 0.9, bd * 0.9),
                new THREE.MeshBasicMaterial({ color: Math.random() > 0.5 ? '#ffd98a' : '#7aa7ff' }));
              win.position.copy(house.position);
              this.sceneryGroup.add(win);
              house.scale.setScalar(1.02);
            }
          } else if (desertish) {
            const body = new THREE.Mesh(cactusGeo, cactusMat); body.position.set(px, py + 1.4, pz); body.castShadow = true;
            const arm = new THREE.Mesh(cactusArmGeo, cactusMat); arm.position.set(px + 0.5, py + 1.9, pz); arm.castShadow = true;
            this.sceneryGroup.add(body, arm);
          } else {
            const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.position.set(px, py + 1.5, pz); trunk.castShadow = true;
            const leaves = new THREE.Mesh(treeGeo, treeLeaf); leaves.position.set(px, py + (theme === 'forest' ? 8 : 5.5), pz); leaves.castShadow = true;
            leaves.scale.setScalar(0.8 + Math.random() * 0.6);
            this.sceneryGroup.add(trunk, leaves);
          }
        }
        if (Math.random() > (desertish ? 0.55 : 0.85)) {
          const rockScale = 0.4 + Math.random();
          // Rock radius ~ rockScale * 1.4 (DodecahedronGeometry(1.4)); clear the
          // wall by the radius so even the biggest rocks don't intrude.
          const rockEdge = margin + rockScale * 1.4 + 1 + Math.random() * 3;
          const rock = new THREE.Mesh(rockGeo, rockMat);
          rock.position.set(p.pos.x + p.normal.x * side * (hw + rockEdge), this.groundY(p.pos.y, rockEdge) + 0.4, p.pos.z + p.normal.z * side * (hw + rockEdge));
          rock.scale.setScalar(rockScale); rock.rotation.set(Math.random(), Math.random(), Math.random());
          rock.castShadow = true; this.sceneryGroup.add(rock);
        }
      }
      // Street lights, just outside the boundary.
      if (i % (step * 6) === 0) {
        const lo = margin + 1.2;
        const lp = new THREE.Vector3(p.pos.x + p.normal.x * (hw + lo), this.groundY(p.pos.y, lo), p.pos.z + p.normal.z * (hw + lo));
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 8, 4), new THREE.MeshStandardMaterial({ color: '#4a4a4a' }));
        pole.position.copy(lp); pole.position.y += 4; this.sceneryGroup.add(pole);
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 5, 5), new THREE.MeshBasicMaterial({ color: 0xfff1a8 }));
        bulb.position.copy(lp); bulb.position.y += 8; this.sceneryGroup.add(bulb);
      }
    }
  }

  public buildCarGraphics(custom: CarLoadout, carId?: string) {
    this.scene.remove(this.carGroup);
    const built = buildCarMesh(custom.color, { player: true, custom, profile: carProfileFor(carId) });
    this.carGroup = built.group;
    // YXZ: yaw (Y) outermost, so pitch (accel/brake) and roll (cornering) stay
    // in the car's LOCAL frame. Default XYZ applied pitch about a yaw-rotated
    // axis, making acceleration visibly LEAN the car left/right by heading.
    this.carGroup.rotation.order = 'YXZ';
    this.wheels = built.wheels;
    this.brakeLights = built.brakeLights;
    this.headlights = built.headlights;
    this.scene.add(this.carGroup);
  }

  public updateAICar(id: string, x: number, y: number, z: number, yaw: number, color: string, carId?: string) {
    let ai = this.aiCars.get(id);
    if (!ai) {
      const built = buildCarMesh(color, { profile: carProfileFor(carId) });
      this.scene.add(built.group);
      ai = { group: built.group, wheels: built.wheels };
      this.aiCars.set(id, ai);
    }
    ai.group.position.set(x, y, z);
    ai.group.rotation.y = yaw;
  }

  public removeExtraActors(activeIds: Set<string>) {
    for (const [id, ai] of this.aiCars) {
      if (!activeIds.has(id)) { this.scene.remove(ai.group); this.aiCars.delete(id); }
    }
  }

  public triggerBackfirePop() {
    const n = 14;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const wp = new THREE.Vector3(0, 0.4, -2.3).applyMatrix4(this.carGroup.matrixWorld);
    for (let i = 0; i < n * 3; i += 3) {
      pos[i] = wp.x + (Math.random() - 0.5) * 0.4; pos[i + 1] = wp.y + (Math.random() - 0.5) * 0.4; pos[i + 2] = wp.z + (Math.random() - 0.5) * 0.4;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffaa22, size: 0.5, transparent: true, blending: THREE.AdditiveBlending });
    const sparks = new THREE.Points(geo, mat); this.scene.add(sparks);
    let life = 1;
    const fade = () => { life -= 0.09; mat.size = 0.5 * life; mat.opacity = life; if (life > 0) requestAnimationFrame(fade); else { this.scene.remove(sparks); geo.dispose(); mat.dispose(); } };
    fade();
  }

  public update(state: VehicleState, dt: number, cameraMode: CameraMode, weather: string, isBraking: boolean, surfaceType = 'asphalt_dry') {
    this.weather = weather;
    const tod = ((this.timeOfDay % 24) + 24) % 24;

    // Lighting by time of day.
    let sky = new THREE.Color('#8ec9e6');
    let sun = new THREE.Color('#fff3d1');
    let sunI = 1.25; let isNight = false;
    if (tod < 5 || tod > 20.5) { sky.set('#050914'); sun.set('#20304a'); sunI = 0.08; isNight = true; }
    else if (tod < 7.5) { const t = (tod - 5) / 2.5; sky = new THREE.Color('#e8825f').lerp(new THREE.Color('#8ec9e6'), t); sun.set('#ffbe6b'); sunI = 0.4 + t * 0.8; }
    else if (tod > 17.5) { const t = (tod - 17.5) / 3; sky = new THREE.Color('#8ec9e6').lerp(new THREE.Color('#20243a'), t); sun = new THREE.Color('#ff9a52').lerp(new THREE.Color('#48507a'), t); sunI = 1.1 - t * 0.9; }

    if (weather === 'night') { sky.set('#060912'); sunI = 0.08; isNight = true; }
    if (weather === 'rainy' || weather === 'foggy') { sky.lerp(new THREE.Color('#59636b'), 0.65); sunI *= 0.5; }
    if (weather === 'snowy') { sky.lerp(new THREE.Color('#c6ccd4'), 0.5); sunI *= 0.7; }

    const fog = this.scene.fog as THREE.FogExp2;
    fog.density = weather === 'foggy' ? 0.028 : weather === 'rainy' ? 0.01 : weather === 'snowy' ? 0.009 : isNight ? 0.004 : 0.0016;
    fog.color.copy(sky);
    (this.scene.background as THREE.Color).copy(sky);
    this.hemi.intensity = isNight ? 0.3 : 0.9;
    this.hemi.color.copy(sky);
    this.ambientLight.intensity = isNight ? 0.22 : 0.5;
    this.dirLight.color.copy(sun);
    this.dirLight.intensity = sunI;

    const sunAng = ((tod - 6) / 12) * Math.PI;
    const sx = Math.cos(sunAng) * 400, sy = Math.max(-50, Math.sin(sunAng) * 400), sz = 180;
    this.dirLight.position.set(state.x + sx * 0.4, 150 + Math.max(0, sy) * 0.3, state.z + sz);
    this.dirLight.target.position.set(state.x, 0, state.z);
    this.sunMesh.position.set(state.x + sx, sy + 60, state.z + sz + 400);
    (this.sunMesh.material as THREE.MeshBasicMaterial).color.copy(isNight ? new THREE.Color('#dfe6ff') : sun);
    this.sunMesh.visible = sy > -20;

    // Headlights.
    const lightsOn = isNight || weather === 'rainy' || weather === 'foggy';
    this.headlights.forEach(h => { h.intensity = lightsOn ? 5 : 0; });

    // Car transform — YAW ONLY. No visual pitch/roll: the car never tilts in any
    // direction (per request), it just points where it's heading.
    this.carGroup.position.set(state.x, state.y, state.z);
    this.carGroup.rotation.set(0, state.yaw, 0);
    // Front wheels steer, all wheels spin.
    const spin = state.wheels.rl.spin;
    this.wheels.forEach((w, i) => {
      (w as THREE.Group).children.forEach(c => { c.rotation.x = spin; });
      if (i < 2) w.rotation.y = state.steerVisual;
    });
    this.brakeLights.forEach(m => m.color.setHex(isBraking ? 0xff2222 : 0x330000));

    // Weather particles.
    if (this.precip && (weather === 'rainy' || weather === 'snowy')) {
      const attr = this.precipGeo.getAttribute('position') as THREE.BufferAttribute;
      const fall = weather === 'snowy' ? 7 : 32;
      // Precip is anchored to the CAR'S elevation, not absolute world y. On the
      // elevated tracks (Alpine at y~30, Titan) the old fixed 55..-3 range put
      // all the snow far below the car, so it looked buried in it. Now it falls
      // from ~45 m above the car down to ~5 m below, following altitude.
      const top = state.y + 45, bottom = state.y - 5;
      if (!this.precip.visible) {
        // First frame of precip (or after a weather change): the buffer was
        // seeded around world origin, so on tracks that start far from origin
        // (or high up) the snow/rain would sit in the wrong place for a few
        // seconds until it recycled. Re-seed the whole field around the car now.
        for (let i = 0; i < this.precipCount; i++) {
          attr.setX(i, state.x + (Math.random() - 0.5) * 120);
          attr.setY(i, bottom + Math.random() * (top - bottom));
          attr.setZ(i, state.z + (Math.random() - 0.5) * 120);
        }
      }
      this.precip.visible = true;
      for (let i = 0; i < this.precipCount; i++) {
        let py = attr.getY(i) - fall * dt;
        if (py < bottom) { py = top + Math.random() * 12; attr.setX(i, state.x + (Math.random() - 0.5) * 120); attr.setZ(i, state.z + (Math.random() - 0.5) * 120); }
        attr.setY(i, py);
      }
      attr.needsUpdate = true;
    } else if (this.precip) this.precip.visible = false;

    // Skid marks + smoke — only for genuine slides / lockups, not every corner.
    const rearSlip = Math.abs(state.wheels.rl.slipRatio);
    const lat = Math.abs(state.wheels.rl.slipAngle);
    const driftAngleAbs = Math.abs(state.driftAngle);
    const hardSlide = (state.isDrifting && driftAngleAbs > 0.26) || rearSlip > 0.6;
    const brakeLock = isBraking && Math.abs(state.wheels.fl.slipRatio) > 0.7;
    const onLoose = surfaceType === 'gravel' || surfaceType === 'sand' || surfaceType === 'grass';
    // Wheelspin under power also smokes (launches / corner exits) — juicier.
    const powerSpin = rearSlip > 0.35 && state.speed > 8;
    if ((hardSlide || brakeLock || powerSpin) && state.speed > 16) {
      for (const wl of [this.wheels[2], this.wheels[3]]) {
        const wp = new THREE.Vector3(); wl.getWorldPosition(wp);
        if (hardSlide || brakeLock) this.dropSkid(wp.x, state.y, wp.z, state.yaw);
        if (Math.random() > 0.3) {
          if (onLoose) this.emitSmoke(wp.x, wp.y + 0.2, wp.z, 0.55, 0.45, 0.32);
          else this.emitSmoke(wp.x, wp.y + 0.2, wp.z, 0.92, 0.92, 0.95);
        }
      }
    }
    // Damage consequence: a wrecked engine belches dark smoke from under the hood.
    if (state.damage > 0.5 && Math.random() > 0.55) {
      const hp = new THREE.Vector3(0, 0.9, 1.4).applyMatrix4(this.carGroup.matrixWorld);
      const k = 0.28 - (state.damage - 0.5) * 0.3; // darker the worse it is
      this.emitSmoke(hp.x, hp.y, hp.z, k, k, k * 1.05);
    }
    this.updateSmoke(dt);

    // Camera.
    this.updateCamera(state, dt, cameraMode, lat, surfaceType);

    this.renderer.render(this.scene, this.camera);
  }

  private updateSmoke(dt: number) {
    for (let i = 0; i < this.smokeMax; i++) {
      if (this.smokeLife[i] > 0) {
        this.smokeLife[i] -= dt * 0.8;
        this.smokePos[i * 3] += this.smokeVel[i * 3] * dt;
        this.smokePos[i * 3 + 1] += this.smokeVel[i * 3 + 1] * dt;
        this.smokePos[i * 3 + 2] += this.smokeVel[i * 3 + 2] * dt;
        this.smokeVel[i * 3 + 1] *= 0.98;
        if (this.smokeLife[i] <= 0) this.smokePos[i * 3 + 1] = -999;
      }
    }
    (this.smokeGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateCamera(state: VehicleState, dt: number, mode: CameraMode, latSlip: number, surfaceType: string) {
    const yaw = state.yaw;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    const speedMs = Math.abs(state.vx);

    // Speed-based FOV — punchier for a stronger sense of speed (juice).
    const targetFov = this.baseFov + Math.min(34, speedMs * 0.62) + (mode === 'hood' ? 8 : 0);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 5);
    this.camera.updateProjectionMatrix();

    // Shake from cornering + rough surfaces + a constant high-speed rumble.
    const rough = (ROUGH as any)[surfaceType] || 0;
    const targetShake = Math.min(0.5, latSlip * 0.28 + Math.min(state.gForce, 2.5) * 0.05 + rough * Math.min(1, speedMs / 30) * 0.35 + Math.max(0, speedMs - 45) * 0.006);
    this.shake += (targetShake - this.shake) * Math.min(1, dt * 9);
    const sh = this.shake;
    const jitter = () => (Math.random() - 0.5) * sh;

    if (mode === 'drone') {
      const target = new THREE.Vector3(state.x, state.y + 34, state.z - 2);
      this.camera.position.lerp(target, Math.min(1, dt * 3));
      this.camera.lookAt(state.x, state.y, state.z);
      return;
    }

    let offY: number, offBack: number, lookAhead: number, lookUp: number, lag: number;
    if (mode === 'hood') { offY = 1.15; offBack = -0.2; lookAhead = 12; lookUp = 1.0; lag = 22; }
    else { offY = 3.1 + Math.min(1.5, speedMs * 0.03); offBack = -8.5; lookAhead = 8; lookUp = 1.2; lag = 7; }

    // Behind the car along forward = (s,c).
    const camX = state.x + s * offBack + jitter();
    const camY = state.y + offY + jitter() * 0.4;
    const camZ = state.z + c * offBack + jitter();
    if (!this.camInit) { this.camera.position.set(camX, camY, camZ); this.camInit = true; }
    this.camera.position.lerp(new THREE.Vector3(camX, camY, camZ), Math.min(1, dt * lag));

    const lookTarget = new THREE.Vector3(state.x + s * lookAhead, state.y + lookUp, state.z + c * lookAhead);
    this.camera.lookAt(lookTarget);
  }

  public resetCamera() { this.camInit = false; }

  public dispose() {
    window.removeEventListener('resize', this.onResize);
    // Keep AI car groups in the scene graph so the disposal traverse below frees
    // their geometries/materials/textures too; scene.clear() removes them after.
    this.aiCars.clear();
    // Free every geometry/material in the graph (dispose is idempotent, so
    // shared geo/materials being hit more than once is fine), then drop the
    // WebGL context and detach the canvas. Without this, each race/restart
    // built a fresh renderer and leaked the old context until the browser
    // killed the oldest ("Too many active WebGL contexts").
    const disposeMat = (m: { map?: { dispose?: () => void }; dispose?: () => void } | undefined) => {
      m?.map?.dispose?.();
      m?.dispose?.();
    };
    this.scene.traverse(obj => {
      const o = obj as unknown as { geometry?: { dispose?: () => void }; material?: unknown };
      o.geometry?.dispose?.();
      const mat = o.material;
      if (Array.isArray(mat)) mat.forEach(disposeMat);
      else disposeMat(mat as { map?: { dispose?: () => void }; dispose?: () => void } | undefined);
    });
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    const canvas = this.renderer.domElement;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }
}

const ROUGH: Record<string, number> = {
  asphalt_dry: 0.02, asphalt_wet: 0.03, gravel: 0.5, grass: 0.6, sand: 0.7, snow: 0.35, ice: 0.05, curb: 0.9
};

// SKIRT_OFFS / groundHeight now live in World.ts (shared with car grounding).

// Which pixel-art ground texture each theme uses (files in /public/textures/).
// Every theme now has a distinct PixelLab ground: alpine meadows in the
// mountains (with rock-cliff skirts), leaf litter in the redwoods, worn
// pavement downtown, concrete apron at the airport, sand in the desert.
const GROUND_TEX: Record<string, string> = {
  harbour: 'grass', mountain: 'meadow', coast: 'grass', forest: 'forestfloor',
  airport: 'concrete', city: 'citypav', desert: 'sand'
};
