'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// FMC150 as it actually looks: a small white plastic brick with a ribbed
// connector on one end and a status LED. Vanilla three.js, same constraint as
// the other 3D views.

const SHELL = 0xe6e9ef;
const SHELL_EDGE = 0xb6bcc8;
const PORT = 0x2a3038;
const LED = 0x00e599;

export function Tracker3D({ online = false }: { online?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(3.4, 2.4, 3.6);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(4, 7, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fd0ff, 0.45);
    rim.position.set(-5, 2, -4);
    scene.add(rim);

    const stage = new THREE.Group();
    scene.add(stage);

    const W = 2.3;
    const H = 0.52;
    const D = 1.55;

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(W, H, D),
      new THREE.MeshStandardMaterial({ color: SHELL, metalness: 0.15, roughness: 0.55 })
    );
    stage.add(body);

    // Seam around the case where the two shell halves meet.
    const seam = new THREE.Mesh(
      new THREE.BoxGeometry(W * 1.005, 0.03, D * 1.005),
      new THREE.MeshStandardMaterial({ color: SHELL_EDGE, roughness: 0.6 })
    );
    stage.add(seam);

    // Ribbed connector block on one end — the part an installer recognises.
    const port = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, H * 0.7, D * 0.62),
      new THREE.MeshStandardMaterial({ color: PORT, metalness: 0.4, roughness: 0.5 })
    );
    port.position.set(W / 2 + 0.09, 0, 0);
    stage.add(port);
    for (let i = -2; i <= 2; i++) {
      const pin = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.06, 0.06),
        new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.9, roughness: 0.3 })
      );
      pin.position.set(W / 2 + 0.19, 0.06, i * 0.13);
      stage.add(pin);
    }

    // Status LED, lit only when the tracker is actually reporting.
    const led = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 0.03, 16),
      new THREE.MeshBasicMaterial({ color: online ? LED : 0x555b64 })
    );
    led.rotation.x = Math.PI / 2;
    led.position.set(-W / 2 + 0.35, H / 2 + 0.005, D / 2 - 0.3);
    led.rotation.x = Math.PI / 2;
    stage.add(led);

    const render = () => renderer.render(scene, camera);

    let t = 0;
    const spin = setInterval(() => {
      if (document.hidden) return;
      t += 0.066;
      stage.rotation.y += 0.012;
      if (online) {
        (led.material as THREE.MeshBasicMaterial).color.setHex(
          Math.sin(t * 3) > 0 ? LED : 0x1d6b52
        );
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
  }, [online]);

  return <div ref={containerRef} className="h-full w-full" />;
}
