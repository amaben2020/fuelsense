'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// Vanilla three.js, not @react-three/fiber — R3F v9's reconciler silently fails
// to mount scene children under this dev setup. Same constraint as Vehicle3D.

const SHELL = 0x1c222c;
const SHELL_RIM = 0x2f3846;
const TERMINAL = 0x39424f;
const GLASS = 0x0d1218;

export type ChargeTone = 'good' | 'warn' | 'bad' | 'unknown';

const TONE_HEX: Record<ChargeTone, number> = {
  good: 0xcde04a,
  warn: 0xff9436,
  bad: 0xff6b6b,
  unknown: 0x5a6372,
};

/**
 * Cell with a fill that reads as stored charge.
 *
 * `charge` is a 0–1 ratio, or null when the device has never reported the
 * element — an empty cell would be a lie in that case, so the fill is dropped
 * entirely and the shell renders alone.
 */
export function Battery3D({
  charge,
  tone = 'good',
  charging = false,
}: {
  charge: number | null;
  tone?: ChargeTone;
  charging?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(3.1, 2.05, 3.4);
    camera.lookAt(0, 0.1, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(4, 7, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fd0ff, 0.42);
    rim.position.set(-5, 2, -4);
    scene.add(rim);

    const stage = new THREE.Group();
    scene.add(stage);

    const accent = TONE_HEX[tone];
    const BODY_H = 2.1;
    const R = 0.78;

    // Outer shell, left open-topped so the fill inside stays visible.
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, BODY_H, 44, 1, true),
      new THREE.MeshStandardMaterial({
        color: SHELL,
        metalness: 0.55,
        roughness: 0.42,
        side: THREE.DoubleSide,
      })
    );
    stage.add(shell);

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R * 0.94, 0.12, 44),
      new THREE.MeshStandardMaterial({ color: SHELL_RIM, metalness: 0.6, roughness: 0.35 })
    );
    base.position.y = -BODY_H / 2;
    stage.add(base);

    for (const y of [BODY_H / 2, -BODY_H / 2 + 0.12]) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(R, 0.035, 12, 48),
        new THREE.MeshStandardMaterial({ color: SHELL_RIM, metalness: 0.7, roughness: 0.3 })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      stage.add(ring);
    }

    // Positive terminal
    const terminal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.3, 0.22, 28),
      new THREE.MeshStandardMaterial({ color: TERMINAL, metalness: 0.8, roughness: 0.25 })
    );
    terminal.position.y = BODY_H / 2 + 0.11;
    stage.add(terminal);

    // Dark inner void so an empty cell reads as empty rather than hollow.
    const void_ = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.9, R * 0.9, BODY_H - 0.16, 40),
      new THREE.MeshStandardMaterial({ color: GLASS, metalness: 0.3, roughness: 0.8 })
    );
    stage.add(void_);

    let fill: THREE.Mesh | null = null;
    let fillGlow: THREE.Mesh | null = null;

    if (charge != null) {
      const ratio = Math.max(0, Math.min(1, charge));
      const inner = BODY_H - 0.18;
      const h = Math.max(inner * ratio, 0.04);

      fill = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 0.88, R * 0.88, h, 40),
        new THREE.MeshStandardMaterial({
          color: accent,
          emissive: accent,
          emissiveIntensity: 0.85,
          metalness: 0.2,
          roughness: 0.35,
        })
      );
      // Grows from the floor of the cell, not from its centre.
      fill.position.y = -inner / 2 + h / 2;
      stage.add(fill);

      fillGlow = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 0.95, R * 0.95, h, 40),
        new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.12 })
      );
      fillGlow.position.y = fill.position.y;
      stage.add(fillGlow);
    }

    // Charge-level tick marks up the side of the cell
    for (let i = 1; i < 4; i++) {
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.02, 0.1),
        new THREE.MeshBasicMaterial({ color: SHELL_RIM })
      );
      tick.position.set(R, -BODY_H / 2 + (BODY_H * i) / 4, 0);
      stage.add(tick);
    }

    const render = () => renderer.render(scene, camera);

    // Slow turntable at ~15fps. Charging adds a breathing pulse on the fill so
    // "current is flowing in" is visible without reading the mA figure.
    let t = 0;
    const spin = setInterval(() => {
      if (document.hidden) return;
      t += 0.066;
      stage.rotation.y += 0.011;
      if (charging && fill) {
        const mat = fill.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 0.6 + Math.sin(t * 2.2) * 0.35;
      }
      render();
    }, 66);

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
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m?.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [charge, tone, charging]);

  return <div ref={containerRef} className="h-full w-full" />;
}
