'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// The FMC150 as an object you can look at, wired into the vehicle it reads.
//
// The point of the piece is placement: the device is not in the fuel tank and
// not spliced into the fuel line — it sits behind the dash on power, ignition
// and GNSS, which is exactly why the fuel figure is computed rather than
// measured. Data pulses rise from it to the elements it reports.
//
// Vanilla three.js on purpose: React Three Fiber breaks under this project's
// Turbopack + Console Ninja setup.

const CASE = 0x1b2129;
const CASE_EDGE = 0x2c3542;
const LABEL = 0x0f141b;
const GREEN = 0x00e599;
const AMBER = 0xffb95f;
const HARNESS = 0x39424f;
const CAR = 0x243040;

export function TrackerDevice3D() {
  const mount = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = mount.current;
    if (!container) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    // Framed on the device rather than the whole vehicle: the car is context,
    // the tracker is the subject.
    camera.position.set(3.4, 2.5, 4.1);
    camera.lookAt(-0.2, 0.85, 0);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(4, 6, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fe6c8, 0.7);
    rim.position.set(-5, 2, -3);
    scene.add(rim);

    const root = new THREE.Group();
    scene.add(root);

    // --- the vehicle it lives in, reduced to a suggestion ------------------
    const car = new THREE.Group();
    const carMat = new THREE.LineBasicMaterial({ color: CAR, transparent: true, opacity: 0.55 });
    const body = new THREE.BoxGeometry(6.4, 1.5, 2.6);
    car.add(new THREE.LineSegments(new THREE.EdgesGeometry(body), carMat));
    const cabin = new THREE.BoxGeometry(3.1, 1.15, 2.35);
    const cabinEdges = new THREE.LineSegments(new THREE.EdgesGeometry(cabin), carMat);
    cabinEdges.position.set(-0.15, 1.3, 0);
    car.add(cabinEdges);
    [
      [-2.1, -0.85, 1.35],
      [-2.1, -0.85, -1.35],
      [2.1, -0.85, 1.35],
      [2.1, -0.85, -1.35],
    ].forEach(([x, y, z]) => {
      const wheel = new THREE.Mesh(
        new THREE.TorusGeometry(0.52, 0.16, 8, 20),
        new THREE.MeshStandardMaterial({ color: CAR, roughness: 0.9 })
      );
      wheel.position.set(x, y, z);
      wheel.rotation.y = Math.PI / 2;
      car.add(wheel);
    });
    car.position.y = 0.15;
    root.add(car);

    // --- the device --------------------------------------------------------
    const device = new THREE.Group();

    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.32, 1.05),
      new THREE.MeshStandardMaterial({ color: CASE, metalness: 0.45, roughness: 0.42 })
    );
    device.add(shell);

    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(1.42, 0.04, 0.97),
      new THREE.MeshStandardMaterial({ color: CASE_EDGE, metalness: 0.6, roughness: 0.3 })
    );
    lid.position.y = 0.17;
    device.add(lid);

    // Printed label — the only place the product name appears in 3D.
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.78, 0.34),
      new THREE.MeshStandardMaterial({ color: LABEL, roughness: 0.95 })
    );
    label.rotation.x = -Math.PI / 2;
    label.position.set(-0.2, 0.2, 0);
    device.add(label);

    // Status LEDs: one for GNSS lock, one for the mobile link.
    const leds: THREE.Mesh[] = [];
    [
      { x: 0.5, color: GREEN },
      { x: 0.66, color: AMBER },
    ].forEach(({ x, color }) => {
      const led = new THREE.Mesh(
        new THREE.CircleGeometry(0.045, 16),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.4 })
      );
      led.rotation.x = -Math.PI / 2;
      led.position.set(x, 0.2, 0.3);
      device.add(led);
      leds.push(led);
    });

    // Wiring harness to the vehicle's power and ignition feed.
    const harnessMat = new THREE.MeshStandardMaterial({ color: HARNESS, roughness: 0.8 });
    const plug = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.66), harnessMat);
    plug.position.set(-0.82, 0, 0);
    device.add(plug);

    const cable = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          new THREE.Vector3(-0.92, 0, 0.2),
          new THREE.Vector3(-1.6, -0.25, 0.5),
          new THREE.Vector3(-2.3, -0.55, 0.15),
          new THREE.Vector3(-2.7, -0.7, -0.4),
        ]),
        24,
        0.055,
        8,
        false
      ),
      harnessMat
    );
    device.add(cable);

    device.position.set(-0.35, 1.25, 0.35);
    device.rotation.y = -0.35;
    root.add(device);

    // --- data rising from the device ---------------------------------------
    // One pulse per element the product actually reads.
    const pulses: THREE.Mesh[] = [];
    const pulseMat = new THREE.MeshBasicMaterial({ color: GREEN, transparent: true });
    for (let i = 0; i < 3; i++) {
      const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), pulseMat.clone());
      pulse.position.set(device.position.x, device.position.y, device.position.z);
      root.add(pulse);
      pulses.push(pulse);
    }

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
        // A slow turn, never a spin — the viewer is inspecting, not watching.
        root.rotation.y = Math.sin(elapsed * 0.22) * 0.42 - 0.12;
        root.position.y = Math.sin(elapsed * 0.7) * 0.045;

        leds.forEach((led, i) => {
          const material = led.material as THREE.MeshStandardMaterial;
          material.emissiveIntensity = 0.7 + Math.abs(Math.sin(elapsed * (1.6 + i * 0.9))) * 1.5;
        });

        pulses.forEach((pulse, i) => {
          const cycle = (elapsed * 0.42 + i / pulses.length) % 1;
          pulse.position.y = device.position.y + cycle * 2.6;
          pulse.position.x = device.position.x + Math.sin(cycle * 3 + i) * 0.22;
          const material = pulse.material as THREE.MeshBasicMaterial;
          material.opacity = Math.sin(cycle * Math.PI) * 0.9;
          const scale = 1 - cycle * 0.35;
          pulse.scale.setScalar(scale);
        });
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
