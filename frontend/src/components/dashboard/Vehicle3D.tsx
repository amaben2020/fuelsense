'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Matte near-black, to match the studio render this view is modelled on. The
// old palette was a blue-grey (0x2a323f) lit by a strong green rim, which read
// as a teal toy rather than a vehicle. Form here comes from soft shading
// across large panels, not from colour — so the values sit close together and
// the lighting below does the separating.
const BODY = 0x1b1e23;
const ROOF = 0x16191d;
const CLAD = 0x0e1013;
const GLASS = 0x090c10;
const DARK = 0x121519;
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
    // Matte by default: a near-black body at 0.6 roughness picks up hard
    // specular streaks that fight the soft studio look being aimed for.
    metalness: opts.metalness ?? 0.08,
    roughness: opts.roughness ?? 0.85,
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
  // Sill line. Emissive at 1.6 this was effectively a strip light running the
  // length of the vehicle, bouncing green onto every panel above it and giving
  // the whole body the teal cast the reference render does not have. Kept as a
  // brand cue, dimmed to a trim highlight rather than a lamp.
  for (const z of [0.94, -0.94])
    addBox(car, [4.3, 0.03, 0.02], [0, 0.5, z], { color: GREEN, emissive: GREEN, emissiveIntensity: 0.35 });

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

export type HotspotId = 'engine' | 'tracker' | 'tank';

/** Where each part sits on the model, and what the marker should say. */
const HOTSPOTS: { id: HotspotId; label: string; pos: [number, number, number] }[] = [
  { id: 'engine', label: 'Engine bay', pos: [1.75, 1.55, 0] },
  // Under the dash on the driver side — where an FMC150 is actually fitted.
  { id: 'tracker', label: 'Tracker', pos: [0.75, 1.62, 0.55] },
  { id: 'tank', label: 'Fuel tank', pos: [-1.5, 0.75, 0] },
];

export function Vehicle3D({
  plate,
  model,
  onSelectHotspot,
}: {
  plate: string;
  model: string | null;
  /** Called when a pulsing marker on the vehicle is clicked. */
  onSelectHotspot?: (id: HotspotId) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Held in a ref so changing the handler never tears down and rebuilds the
  // scene. Synced in an effect rather than during render — the scene reads it
  // only from pointer events, which always run after commit.
  const hotspotHandler = useRef(onSelectHotspot);
  useEffect(() => {
    hotspotHandler.current = onSelectHotspot;
  }, [onSelectHotspot]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    // Filmic rolloff rather than linear clipping. On a near-black body the
    // difference is most of the look: highlights bend off instead of blowing
    // to flat white at the panel edges.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(6.2, 3.2, 6.2);

    // Soft three-point studio rig.
    //
    // Previously: flat ambient plus one hard key and a bright green rim, which
    // flattened the panels and tinted the whole body teal. A hemisphere light
    // gives sky-above/ground-below falloff so horizontal surfaces separate
    // from vertical ones on their own, the key is softened and pulled round,
    // and the brand rim is kept but dropped to a glint that defines the roof
    // edge instead of colouring the vehicle.
    scene.add(new THREE.HemisphereLight(0xaebacb, 0x0a0c0f, 1.15));
    scene.add(new THREE.AmbientLight(0xffffff, 0.22));

    const key = new THREE.DirectionalLight(0xfff4e6, 1.05);
    key.position.set(5, 8.5, 6.5);
    scene.add(key);

    // Opposite-side fill at a fraction of the key, so the shadow side keeps
    // its shape rather than going to solid black on a body this dark.
    const fill = new THREE.DirectionalLight(0xc8d4e4, 0.42);
    fill.position.set(-6, 3.5, 4);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xcfe3ff, 0.34);
    rim.position.set(-5, 5.5, -7);
    scene.add(rim);

    const stage = new THREE.Group();
    stage.position.y = -1.05;
    scene.add(stage);

    stage.add(buildSuv(plate, model));

    // Pulsing markers. A halo ring plus a core sphere so they read as
    // "interactive" against a static model rather than as body detail.
    const hotspotMeshes: THREE.Mesh[] = [];
    for (const spot of HOTSPOTS) {
      const group = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 20, 20),
        new THREE.MeshBasicMaterial({ color: GREEN })
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.26, 20, 20),
        new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.25 })
      );
      group.add(core, halo);
      group.position.set(...spot.pos);
      // Only the core is raycast against; the halo is decoration and a larger
      // hit target would make neighbouring markers ambiguous.
      core.userData.hotspot = spot.id;
      halo.userData.halo = true;
      stage.add(group);
      hotspotMeshes.push(core);
      hotspotMeshes.push(halo);
    }

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    stage.add(shadow);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.5, 3.58, 72),
      // Neutral rather than brand green: a coloured floor ring tints the whole
      // stage on a dark body, and the reference floor is plain grey.
      new THREE.MeshBasicMaterial({ color: 0x8b93a1, transparent: true, opacity: 0.13, side: THREE.DoubleSide })
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
    let pulse = 0;
    const spin = setInterval(() => {
      if (!document.hidden) {
        pulse += 0.066;
        // Breathing halo — the "blinking" that marks a part as clickable.
        const scale = 1 + Math.sin(pulse * 3) * 0.28;
        for (const mesh of hotspotMeshes) {
          if (mesh.userData.halo) mesh.scale.setScalar(scale);
        }
        controls.update();
        render();
      }
    }, 66);
    controls.addEventListener('change', render);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const pickHotspot = (event: PointerEvent): HotspotId | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(hotspotMeshes, false);
      for (const hit of hits) {
        const id = hit.object.userData.hotspot as HotspotId | undefined;
        if (id) return id;
      }
      return null;
    };

    // OrbitControls owns pointerdown for dragging, so selection is decided on
    // pointerup and only when the pointer barely moved — otherwise every orbit
    // that happened to start on a marker would open a modal.
    let downAt: { x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 4) return;
      const id = pickHotspot(e);
      if (id) hotspotHandler.current?.(id);
    };
    const onPointerMove = (e: PointerEvent) => {
      renderer.domElement.style.cursor = pickHotspot(e) ? 'pointer' : '';
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointermove', onPointerMove);

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
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
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
