'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const BODY = 0x2a323f;
const ROOF = 0x232a35;
const CLAD = 0x161c25;
const GLASS = 0x0d1218;
const DARK = 0x151b24;
const TIRE = 0x0b0f15;
const HUB = 0x39424f;
const GREEN = 0x00e599;
const AMBER = 0xffd66b;
const RED = 0xff6b6b;

interface BoxOpts {
  color: number;
  metalness?: number;
  roughness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  rotZ?: number;
  rotY?: number;
}

function addBox(
  parent: THREE.Group,
  [w, h, d]: [number, number, number],
  [x, y, z]: [number, number, number],
  opts: BoxOpts
) {
  const mat = new THREE.MeshStandardMaterial({
    color: opts.color,
    metalness: opts.metalness ?? 0.3,
    roughness: opts.roughness ?? 0.6,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissive ? (opts.emissiveIntensity ?? 1) : 0,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  if (opts.rotZ) mesh.rotation.z = opts.rotZ;
  if (opts.rotY) mesh.rotation.y = opts.rotY;
  parent.add(mesh);
  return mesh;
}

function addWheel(parent: THREE.Group, x: number, z: number) {
  const wheel = new THREE.Group();
  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(0.44, 0.44, 0.32, 28),
    new THREE.MeshStandardMaterial({ color: TIRE, roughness: 0.95, metalness: 0.05 })
  );
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.2, 0.34, 20),
    new THREE.MeshStandardMaterial({ color: HUB, roughness: 0.3, metalness: 0.75 })
  );
  wheel.add(tire, hub);
  wheel.rotation.x = Math.PI / 2;
  wheel.position.set(x, 0.44, z);
  parent.add(wheel);
}

/** Renders text onto a transparent canvas texture — no font fetching, no suspension. */
function makeTextTexture(lines: { text: string; size: number; color: string }[]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let y = 128 - ((lines.length - 1) * 60) / 2;
  for (const line of lines) {
    ctx.font = `bold ${line.size}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, 256, y);
    y += 60;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

/** Procedural 2013 RAV4-style crossover, nose facing +x. */
function buildSuv(plate: string, model: string | null): THREE.Group {
  const car = new THREE.Group();

  addBox(car, [4.35, 1.0, 1.85], [0, 1.02, 0], { color: BODY, metalness: 0.35, roughness: 0.5 });
  addBox(car, [1.1, 0.24, 1.72], [1.62, 1.4, 0], { color: BODY, metalness: 0.35, roughness: 0.5 });
  addBox(car, [2.55, 0.78, 1.62], [-0.25, 1.9, 0], { color: ROOF, metalness: 0.3, roughness: 0.55 });

  // glass
  addBox(car, [0.06, 0.72, 1.44], [1.08, 1.82, 0], { color: GLASS, metalness: 0.85, roughness: 0.12, rotZ: -0.5 });
  addBox(car, [0.05, 0.66, 1.44], [-1.6, 1.86, 0], { color: GLASS, metalness: 0.85, roughness: 0.12, rotZ: 0.35 });
  for (const z of [0.815, -0.815]) {
    addBox(car, [2.35, 0.44, 0.02], [-0.25, 1.94, z], { color: GLASS, metalness: 0.85, roughness: 0.12 });
    addBox(car, [0.07, 0.46, 0.03], [-0.25, 1.94, z], { color: ROOF });
    addBox(car, [0.07, 0.46, 0.03], [0.45, 1.94, z], { color: ROOF });
  }

  // cladding + bumpers
  addBox(car, [4.39, 0.3, 1.87], [0, 0.62, 0], { color: CLAD, roughness: 0.85 });
  addBox(car, [0.22, 0.5, 1.7], [2.2, 0.78, 0], { color: CLAD, roughness: 0.85 });
  addBox(car, [0.18, 0.5, 1.7], [-2.22, 0.78, 0], { color: CLAD, roughness: 0.85 });

  // lights
  for (const z of [0.62, -0.62]) {
    addBox(car, [0.06, 0.14, 0.4], [2.19, 1.28, z], { color: AMBER, emissive: AMBER, emissiveIntensity: 1.6 });
    addBox(car, [0.05, 0.16, 0.3], [-2.2, 1.3, z], { color: RED, emissive: RED, emissiveIntensity: 1.2 });
  }

  // roof rails, antenna, mirrors, accent skirt
  for (const z of [0.6, -0.6]) addBox(car, [2.2, 0.05, 0.06], [-0.25, 2.33, z], { color: DARK, roughness: 0.4 });
  addBox(car, [0.22, 0.09, 0.06], [-1.15, 2.34, 0], { color: DARK });
  for (const z of [0.98, -0.98]) addBox(car, [0.12, 0.12, 0.18], [0.95, 1.62, z], { color: BODY });
  for (const z of [0.94, -0.94])
    addBox(car, [4.3, 0.04, 0.02], [0, 0.5, z], { color: GREEN, emissive: GREEN, emissiveIntensity: 1.6 });

  for (const z of [0.83, -0.83]) {
    addWheel(car, 1.45, z);
    addWheel(car, -1.45, z);
  }

  // livery — plate on both doors, model on the tailgate
  const plateTexture = makeTextTexture([
    { text: plate, size: 72, color: '#e8ecf4' },
    { text: model ?? 'FLEET UNIT', size: 40, color: '#7d8697' },
  ]);
  for (const z of [0.945, -0.945]) {
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 1.1),
      new THREE.MeshBasicMaterial({ map: plateTexture, transparent: true })
    );
    decal.position.set(0.05, 1.05, z);
    if (z < 0) decal.rotation.y = Math.PI;
    car.add(decal);
  }

  return car;
}

/** Soft blob shadow via radial-gradient texture — cheaper than shadow maps. */
function makeShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 20, 128, 128, 128);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

export function Vehicle3D({ plate, model }: { plate: string; model: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(6.2, 3.2, 6.2);

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(6, 9, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x7df5c8, 0.5);
    rim.position.set(-7, 4, -6);
    scene.add(rim);

    const stage = new THREE.Group();
    stage.position.y = -1.05;
    scene.add(stage);

    stage.add(buildSuv(plate, model));

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    stage.add(shadow);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.5, 3.58, 72),
      new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.16, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.005;
    stage.add(ring);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 2.2;
    controls.minDistance = 5;
    controls.maxDistance = 12;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.target.set(0, 0.3, 0);

    const render = () => renderer.render(scene, camera);

    // ~15fps auto-rotate instead of a 60fps loop — a dashboard tab
    // shouldn't peg the GPU for a slow turntable.
    const spin = setInterval(() => {
      if (!document.hidden) {
        controls.update();
        render();
      }
    }, 66);
    controls.addEventListener('change', render);

    const resize = () => {
      const r = container.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      renderer.setSize(r.width, r.height);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
      render();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      clearInterval(spin);
      observer.disconnect();
      controls.removeEventListener('change', render);
      controls.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if (!m) continue;
          const std = m as THREE.MeshStandardMaterial & { map?: THREE.Texture };
          std.map?.dispose();
          m.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [plate, model]);

  return <div ref={containerRef} className="h-full w-full" />;
}
