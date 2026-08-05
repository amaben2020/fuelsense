'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// The FMC150 as a product shot.
//
// An earlier version floated a black box inside a wireframe car with dots
// drifting off it, which read as neither a device nor a vehicle. This is the
// opposite approach: one object, properly lit, on a soft stage, turning slowly
// enough to be inspected. The context that matters (where it sits, what it is
// wired to) is carried by labels in the DOM rather than by weak geometry.
//
// Vanilla three.js on purpose: React Three Fiber breaks under this project's
// Turbopack and Console Ninja setup.

const CASE_TOP = 0x2b333d;
const CASE_BODY = 0x161b22;
const CASE_EDGE = 0x3b4552;
const PORT = 0x0d1117;
const GREEN = 0x00e599;
const AMBER = 0xffb95f;
const CABLE = 0x2a313b;

/** Rounded slab, which is the whole silhouette of this device. */
function roundedBox(width: number, height: number, depth: number, radius: number) {
  const shape = new THREE.Shape();
  const w = width / 2 - radius;
  const d = depth / 2 - radius;
  shape.moveTo(-w - radius, -d);
  shape.lineTo(-w - radius, d);
  shape.quadraticCurveTo(-w - radius, d + radius, -w, d + radius);
  shape.lineTo(w, d + radius);
  shape.quadraticCurveTo(w + radius, d + radius, w + radius, d);
  shape.lineTo(w + radius, -d);
  shape.quadraticCurveTo(w + radius, -d - radius, w, -d - radius);
  shape.lineTo(-w, -d - radius);
  shape.quadraticCurveTo(-w - radius, -d - radius, -w - radius, -d);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 3,
    curveSegments: 12,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height / 2, 0);
  return geometry;
}

export function TrackerDevice3D() {
  const mount = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = mount.current;
    if (!container) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(2.4, 2.0, 3.2);
    camera.lookAt(0, -0.05, 0);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    // Studio lighting: a key to shape the slab, a cool rim to lift its edge off
    // the background, and a soft fill so the shadow side keeps its detail.
    scene.add(new THREE.HemisphereLight(0xcfe9dd, 0x0a0f14, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(2.6, 4, 2.4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fffcb, 1.15);
    rim.position.set(-3, 1.6, -2.4);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-1.5, 0.6, 3);
    scene.add(fill);

    const root = new THREE.Group();
    scene.add(root);

    // Stage: a dark disc catching a pool of light, so the device sits on
    // something instead of hovering in a void.
    const stage = new THREE.Mesh(
      new THREE.CircleGeometry(2.6, 64),
      new THREE.MeshStandardMaterial({ color: 0x0c1116, roughness: 0.95, metalness: 0 })
    );
    stage.rotation.x = -Math.PI / 2;
    stage.position.y = -0.42;
    root.add(stage);

    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(1.15, 48),
      new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.05 })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.41;
    root.add(glow);

    const device = new THREE.Group();

    const body = new THREE.Mesh(
      roundedBox(1.85, 0.42, 1.25, 0.14),
      new THREE.MeshStandardMaterial({ color: CASE_BODY, roughness: 0.55, metalness: 0.25 })
    );
    device.add(body);

    // The lid is a separate, lighter slab: the seam is what makes it read as a
    // moulded enclosure rather than a solid block.
    const lid = new THREE.Mesh(
      roundedBox(1.78, 0.1, 1.18, 0.12),
      new THREE.MeshStandardMaterial({ color: CASE_TOP, roughness: 0.38, metalness: 0.45 })
    );
    lid.position.y = 0.2;
    device.add(lid);

    // Recessed label panel on the lid.
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.82, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x11161d, roughness: 0.9 })
    );
    label.rotation.x = -Math.PI / 2;
    label.position.set(-0.32, 0.251, 0);
    device.add(label);

    const brandBar = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.045),
      new THREE.MeshStandardMaterial({ color: CASE_EDGE, roughness: 0.6 })
    );
    brandBar.rotation.x = -Math.PI / 2;
    brandBar.position.set(-0.32, 0.253, -0.08);
    device.add(brandBar);

    // Status LEDs, slightly proud of the lid so they catch the key light.
    const leds: THREE.Mesh[] = [];
    [
      { x: 0.42, color: GREEN },
      { x: 0.58, color: AMBER },
    ].forEach(({ x, color }) => {
      const led = new THREE.Mesh(
        new THREE.CylinderGeometry(0.038, 0.038, 0.02, 20),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 1.2,
          roughness: 0.3,
        })
      );
      led.position.set(x, 0.256, 0.3);
      device.add(led);
      leds.push(led);
    });

    // Connector face and harness, the part that ties it to the vehicle.
    const port = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.26, 0.72),
      new THREE.MeshStandardMaterial({ color: PORT, roughness: 0.75, metalness: 0.3 })
    );
    port.position.set(-0.95, 0, 0);
    device.add(port);

    const harness = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          new THREE.Vector3(-1.02, 0, 0.16),
          new THREE.Vector3(-1.5, -0.14, 0.42),
          new THREE.Vector3(-2.05, -0.34, 0.16),
          new THREE.Vector3(-2.35, -0.42, -0.3),
        ]),
        32,
        0.05,
        10,
        false
      ),
      new THREE.MeshStandardMaterial({ color: CABLE, roughness: 0.85 })
    );
    device.add(harness);

    // SIM slot suggestion on the near edge.
    const slot = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.03, 0.02),
      new THREE.MeshStandardMaterial({ color: PORT, roughness: 0.9 })
    );
    slot.position.set(0.35, 0.04, 0.63);
    device.add(slot);

    device.position.y = 0.06;
    root.add(device);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(rect.width, 1);
      const height = Math.max(rect.height, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let frame = 0;
    const clock = new THREE.Clock();

    const tick = () => {
      const elapsed = clock.getElapsedTime();

      if (!reduceMotion) {
        // A slow oscillation rather than a spin: the viewer is meant to be
        // reading the object, not watching it turn.
        root.rotation.y = -0.5 + Math.sin(elapsed * 0.2) * 0.5;
        device.position.y = 0.06 + Math.sin(elapsed * 0.6) * 0.018;

        // GNSS lock settles to a steady glow; the mobile link blinks as it
        // talks. Two different rhythms, both quiet.
        const gnss = leds[0].material as THREE.MeshStandardMaterial;
        gnss.emissiveIntensity = 1.1 + Math.sin(elapsed * 1.3) * 0.35;
        const link = leds[1].material as THREE.MeshStandardMaterial;
        const blink = Math.sin(elapsed * 3.1);
        link.emissiveIntensity = blink > 0.75 ? 1.9 : 0.35;
      }

      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div className="fs-device">
      <div className="fs-device__stage" ref={mount} aria-hidden />
      <p className="fs-device__caption">Teltonika FMC150</p>
      <ul className="fs-device__legend">
        <li>
          <span className="fs-device__pip" style={{ background: '#00e599' }} />
          Fitted behind the dash, wired to power and ignition
        </li>
        <li>
          <span className="fs-device__pip" style={{ background: '#ffb95f' }} />
          GNSS fix and mobile link. Nothing touches the fuel tank
        </li>
        <li>
          <span className="fs-device__pip" style={{ background: '#7d8697' }} />
          Reports AVL 12, 13, 16, 239 and 240 continuously
        </li>
      </ul>
    </div>
  );
}
