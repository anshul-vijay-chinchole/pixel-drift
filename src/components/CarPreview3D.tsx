import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { buildCarMesh, carProfileFor } from '../game/Graphics';
import { CarLoadout } from '../context/GameContext';

/**
 * Live, slowly-rotating 3D preview of the player's actual in-game car — same
 * mesh builder the race uses — so paint and neon underglow chosen in the garage
 * are visible immediately (the flat 2D sprite never reflected them). Plate is
 * previewed separately by the license-plate block.
 */
interface Props {
  carId: string;
  loadout: CarLoadout;
}

export const CarPreview3D: React.FC<Props> = ({ carId, loadout }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    car: THREE.Group | null;
    raf: number;
    onResize: () => void;
  } | null>(null);

  // ---- one-time scene / renderer setup ----
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const w = mount.clientWidth || 340;
    const h = mount.clientHeight || 220;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    camera.position.set(4.8, 2.8, 6.0);
    camera.lookAt(0, 0.55, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x223044, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(5, 8, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.55);
    rim.position.set(-6, 3, -5);
    scene.add(rim);

    // Dark ground disc so the neon underglow (a PointLight) has something to
    // catch, making the glow visible even without a track.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(4.5, 48),
      new THREE.MeshStandardMaterial({ color: '#0c0e14', roughness: 0.85, metalness: 0.1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);

    const onResize = () => {
      const ww = mount.clientWidth || w;
      const hh = mount.clientHeight || h;
      camera.aspect = ww / hh;
      camera.updateProjectionMatrix();
      renderer.setSize(ww, hh, false);
    };
    window.addEventListener('resize', onResize);

    ctx.current = { renderer, scene, camera, car: null, raf: 0, onResize };

    const animate = () => {
      const c = ctx.current;
      if (!c) return;
      if (c.car) c.car.rotation.y += 0.006;
      c.renderer.render(c.scene, c.camera);
      c.raf = requestAnimationFrame(animate);
    };
    ctx.current.raf = requestAnimationFrame(animate);

    return () => {
      const c = ctx.current;
      window.removeEventListener('resize', onResize);
      if (c) {
        cancelAnimationFrame(c.raf);
        c.scene.traverse(obj => {
          const o = obj as unknown as { geometry?: { dispose?: () => void }; material?: unknown };
          o.geometry?.dispose?.();
          const mat = o.material as { dispose?: () => void } | { dispose?: () => void }[] | undefined;
          if (Array.isArray(mat)) mat.forEach(m => m?.dispose?.());
          else mat?.dispose?.();
        });
        c.renderer.dispose();
        c.renderer.forceContextLoss?.();
        if (c.renderer.domElement.parentNode) c.renderer.domElement.parentNode.removeChild(c.renderer.domElement);
      }
      ctx.current = null;
    };
  }, []);

  // ---- rebuild the car whenever car / paint / neon changes ----
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    if (c.car) {
      c.scene.remove(c.car);
      c.car.traverse(obj => {
        const o = obj as unknown as { geometry?: { dispose?: () => void }; material?: unknown };
        o.geometry?.dispose?.();
        const mat = o.material as { dispose?: () => void } | { dispose?: () => void }[] | undefined;
        if (Array.isArray(mat)) mat.forEach(m => m?.dispose?.());
        else mat?.dispose?.();
      });
    }
    const built = buildCarMesh(loadout.color, { player: true, custom: loadout, profile: carProfileFor(carId) });
    built.group.rotation.order = 'YXZ';
    c.car = built.group;
    c.scene.add(built.group);
    c.renderer.render(c.scene, c.camera); // immediate paint so changes show at once
  }, [carId, loadout.color, loadout.neonColor]);

  return <div ref={mountRef} className="car-3d-preview" />;
};
