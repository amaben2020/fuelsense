'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

/**
 * What a zone actually is, drawn rather than described.
 *
 * "Geofence" means nothing to somebody who has not used one, and the flat list
 * of zones cannot show the thing that matters: the boundary is not a line on a
 * map the driver can see, it is a test run against every position the tracker
 * reports. So the loop draws the ring, sends a vehicle through it, and marks
 * the two crossings — which is the whole feature in eleven seconds.
 *
 * Vanilla three.js, same constraint as the other 3D views in here.
 */

const LEMON = 0xcde04a;
const GREEN = 0x00e599;
const GRID = 0x262c34;
const GRID_EDGE = 0x323a44;

/** Zone radius in scene units. The vehicle path is sized against this. */
const R = 2.2;
const RING_POINTS = 128;

/** Seconds. The ring draws, then the vehicle runs the path, then it holds. */
const DRAW_END = 2.6;
const RUN_END = 9.6;
const CYCLE = 11;

type Phase = 'draw' | 'outside' | 'inside' | 'left';

const CAPTION: Record<Phase, string> = {
  draw: 'Draw a zone once — around a depot, a customer site, or a no-go area.',
  outside: 'Nothing is fitted to the gate and nothing is fitted to the vehicle.',
  inside: 'Entered. Detected from the position the tracker already reports.',
  left: 'Exited. Both crossings are timestamped, so time on site is known.',
};

export function ZoneExplainer3D() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('draw');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 4.6, 5.9);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(4, 8, 5);
    scene.add(key);

    // Ground. A grid rather than a photographic map: this is explaining the
    // mechanism, and a real map would invite reading the streets instead.
    const grid = new THREE.GridHelper(12, 12, GRID_EDGE, GRID);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.85;
    scene.add(grid);

    // --- the zone ------------------------------------------------------
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(R, 64),
      new THREE.MeshBasicMaterial({ color: LEMON, transparent: true, opacity: 0 })
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.012;
    scene.add(fill);

    // The wall is what makes it read as a volume the vehicle passes through
    // rather than a decal lying on the floor.
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, 0.62, 64, 1, true),
      new THREE.MeshBasicMaterial({
        color: LEMON,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    wall.position.y = 0.31;
    scene.add(wall);

    // Boundary drawn by revealing points, which is the "you drew this" beat.
    const ringPts: THREE.Vector3[] = [];
    for (let i = 0; i <= RING_POINTS; i += 1) {
      const a = (i / RING_POINTS) * Math.PI * 2 - Math.PI / 2;
      ringPts.push(new THREE.Vector3(Math.cos(a) * R, 0.03, Math.sin(a) * R));
    }
    const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
    const ring = new THREE.Line(
      ringGeo,
      new THREE.LineBasicMaterial({ color: LEMON, transparent: true, opacity: 0.95 })
    );
    ringGeo.setDrawRange(0, 0);
    scene.add(ring);

    // Crossing pulse — expands and fades from the boundary on entry and exit.
    const pulse = new THREE.Mesh(
      new THREE.RingGeometry(R * 0.99, R * 1.03, 64),
      new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0 })
    );
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.y = 0.04;
    scene.add(pulse);

    // Depot at the middle, so the ring is obviously *around* something.
    const depot = new THREE.Group();
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 0.04, 24),
      new THREE.MeshStandardMaterial({ color: 0x3a424d, roughness: 0.8 })
    );
    depot.add(pad);
    const shed = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.34, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x9aa832, roughness: 0.7 })
    );
    shed.position.y = 0.19;
    depot.add(shed);
    scene.add(depot);

    // --- the vehicle and its path --------------------------------------
    // Kept inside the grid: the vehicle has to stay in frame on a panel that
    // is much wider than it is tall.
    const path = new THREE.CatmullRomCurve3([
      // Routed to pass in front of the depot rather than straight over it —
      // the two read as one object when they overlap.
      new THREE.Vector3(-5.2, 0, 2.4),
      new THREE.Vector3(-2.2, 0, 1.9),
      new THREE.Vector3(0.3, 0, 1.05),
      new THREE.Vector3(3.0, 0, -0.8),
      new THREE.Vector3(5.2, 0, -2.4),
    ]);

    const van = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.36, 0.48),
      new THREE.MeshStandardMaterial({ color: GREEN, roughness: 0.45, metalness: 0.1 })
    );
    body.position.y = 0.23;
    van.add(body);
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.24, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x0b3c30, roughness: 0.5 })
    );
    cab.position.set(0.32, 0.5, 0);
    van.add(cab);
    scene.add(van);

    // Trail behind the vehicle — the position history the crossing test runs
    // against, made visible.
    const trailPts = path.getPoints(220);
    const trailGeo = new THREE.BufferGeometry().setFromPoints(
      trailPts.map((p) => new THREE.Vector3(p.x, 0.02, p.z))
    );
    const trail = new THREE.Line(
      trailGeo,
      new THREE.LineBasicMaterial({ color: GREEN, transparent: true, opacity: 0.4 })
    );
    trailGeo.setDrawRange(0, 0);
    scene.add(trail);

    const render = () => renderer.render(scene, camera);

    /** Places everything for a given point in the cycle. */
    const apply = (time: number, emit: (p: Phase) => void) => {
      // Ring draws, then the fill and wall settle in behind it.
      const drawn = Math.min(1, time / DRAW_END);
      const eased = 1 - Math.pow(1 - drawn, 3);
      ringGeo.setDrawRange(0, Math.round(eased * (RING_POINTS + 1)));
      (fill.material as THREE.MeshBasicMaterial).opacity = eased * 0.13;
      (wall.material as THREE.MeshBasicMaterial).opacity = eased * 0.26;

      if (time < DRAW_END) {
        van.visible = false;
        trailGeo.setDrawRange(0, 0);
        (pulse.material as THREE.MeshBasicMaterial).opacity = 0;
        emit('draw');
        return;
      }

      van.visible = true;
      const t = Math.min(1, (time - DRAW_END) / (RUN_END - DRAW_END));
      const at = path.getPointAt(t);
      van.position.set(at.x, 0, at.z);

      const tangent = path.getTangentAt(t);
      van.rotation.y = Math.atan2(tangent.x, tangent.z) - Math.PI / 2;

      trailGeo.setDrawRange(0, Math.round(t * trailPts.length));

      // The crossing test itself: inside is a distance comparison, which is
      // exactly what the backend does against each reported position.
      const dist = Math.hypot(at.x, at.z);
      const inside = dist < R;
      emit(inside ? 'inside' : t > 0.5 ? 'left' : 'outside');

      // Pulse strength from how recently the boundary was crossed.
      const edge = Math.abs(dist - R);
      const near = Math.max(0, 1 - edge / 0.9);
      (pulse.material as THREE.MeshBasicMaterial).opacity = near * 0.75;
      pulse.scale.setScalar(1 + (1 - near) * 0.16);
    };

    let phaseNow: Phase | null = null;
    const emit = (p: Phase) => {
      if (p !== phaseNow) {
        phaseNow = p;
        setPhase(p);
      }
    };

    let timer: ReturnType<typeof setInterval> | null = null;

    if (reduced) {
      // Reduced motion still gets the explanation — the finished zone with the
      // vehicle sitting inside it — just without anything moving.
      apply(DRAW_END + (RUN_END - DRAW_END) * 0.5, emit);
    } else {
      let time = 0;
      timer = setInterval(() => {
        if (document.hidden) return;
        time = (time + 0.04) % CYCLE;
        apply(time, emit);
        render();
      }, 40);
    }

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
      if (timer) clearInterval(timer);
      observer.disconnect();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m?.dispose();
      });
      grid.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div className="mx-auto max-w-lg">
      {/* Width is capped deliberately. Left to fill a dashboard panel the
          canvas becomes a 4:1 letterbox, and a vertical field of view that
          wide renders the whole scene as a speck in the middle. */}
      <div ref={containerRef} className="h-[240px] w-full sm:h-[280px]" />
      <p className="mt-1 min-h-[2.5rem] text-center text-xs leading-relaxed text-ink-dim">
        {CAPTION[phase]}
      </p>
    </div>
  );
}
