'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * A slowly rotating render of the vehicle's **body class**.
 *
 * Read the label before changing this: it is a silhouette for the class, not a
 * likeness of the chosen model. A Hilux and a Land Cruiser both come out as
 * "pickup" and "SUV" shapes, and the caption in the UI says so plainly.
 *
 * Making it model-accurate is not a modelling problem, it is an asset problem —
 * a real Toyota RAV4 2013 needs a licensed mesh, and there is no way to derive
 * one from a name. So `glbUrl` is honoured when supplied: drop a purchased
 * `.glb` in and it replaces the primitive with the real thing, no other change
 * required. Until then the honest option is a shape that is obviously
 * schematic rather than a box captioned with a model name it does not
 * resemble.
 *
 * Vanilla three.js on purpose — react-three-fiber does not survive this
 * project's dev tooling.
 */

export type BodyClass =
  | 'sedan'
  | 'suv_pickup'
  | 'van_bus'
  | 'medium_truck'
  | 'heavy_truck'
  | 'motorcycle';

const BODY = 0x39424f;
const ROOF = 0x2b323d;
const GLASS = 0x0f151d;
const TIRE = 0x0b0f15;
const HUB = 0x59636f;
const LEMON = 0xcde04a;

interface Dims {
  /** Cabin/body box: length, height, width. */
  body: [number, number, number];
  /** Greenhouse on top: length, height, width, and x-offset from centre. */
  roof: [number, number, number, number] | null;
  /** Load bed for pickups and trucks: length, height, width, x-offset. */
  bed: [number, number, number, number] | null;
  wheelRadius: number;
  /** Axle x-positions. Two entries for a car, three for a heavy truck. */
  axles: number[];
  trackWidth: number;
  /** Camera distance — a bus needs more room than a motorcycle. */
  view: number;
}

/**
 * Proportions taken from real class averages rather than eyeballed, so a van
 * reads as taller than a saloon and a heavy truck actually looks like one.
 */
const SHAPES: Record<BodyClass, Dims> = {
  sedan: {
    body: [4.2, 0.75, 1.8],
    roof: [2.1, 0.55, 1.66, -0.1],
    bed: null,
    wheelRadius: 0.33,
    axles: [-1.35, 1.4],
    trackWidth: 1.72,
    view: 7.5,
  },
  suv_pickup: {
    body: [4.5, 1.0, 1.9],
    roof: [2.2, 0.72, 1.78, -0.35],
    bed: [1.5, 0.42, 1.8, 1.4],
    wheelRadius: 0.4,
    axles: [-1.45, 1.5],
    trackWidth: 1.82,
    view: 8.2,
  },
  van_bus: {
    body: [5.4, 1.85, 2.0],
    roof: null,
    bed: null,
    wheelRadius: 0.4,
    axles: [-1.8, 1.9],
    trackWidth: 1.9,
    view: 9.5,
  },
  medium_truck: {
    body: [2.3, 1.6, 2.2],
    roof: null,
    bed: [4.2, 1.3, 2.25, 1.9],
    wheelRadius: 0.48,
    axles: [-2.1, 2.2],
    trackWidth: 2.1,
    view: 11.5,
  },
  heavy_truck: {
    body: [2.6, 2.1, 2.45],
    roof: null,
    bed: [6.4, 1.9, 2.5, 2.9],
    wheelRadius: 0.55,
    axles: [-2.7, 2.6, 4.1],
    trackWidth: 2.4,
    view: 15,
  },
  motorcycle: {
    body: [1.7, 0.42, 0.42],
    roof: null,
    bed: null,
    wheelRadius: 0.32,
    axles: [-0.62, 0.62],
    trackWidth: 0.18,
    view: 4,
  },
};

function box(
  parent: THREE.Group,
  [l, h, w]: [number, number, number],
  position: [number, number, number],
  color: number,
  opts: { roughness?: number; metalness?: number } = {}
) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(l, h, w),
    new THREE.MeshStandardMaterial({
      color,
      roughness: opts.roughness ?? 0.55,
      metalness: opts.metalness ?? 0.25,
    })
  );
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

function buildVehicle(shape: Dims): THREE.Group {
  const group = new THREE.Group();
  const [bl, bh, bw] = shape.body;
  const wheelY = shape.wheelRadius;
  const bodyY = wheelY + bh / 2 + 0.06;

  box(group, shape.body, [0, bodyY, 0], BODY);

  if (shape.roof) {
    const [rl, rh, rw, rx] = shape.roof;
    box(group, [rl, rh, rw], [rx, bodyY + bh / 2 + rh / 2, 0], ROOF);
    // A glazed band, so the shape reads as a cabin rather than a stack.
    box(group, [rl * 0.94, rh * 0.5, rw * 1.01], [rx, bodyY + bh / 2 + rh * 0.58, 0], GLASS, {
      roughness: 0.15,
      metalness: 0.1,
    });
  }

  if (shape.bed) {
    const [dl, dh, dw, dx] = shape.bed;
    box(group, [dl, dh, dw], [dx, wheelY + dh / 2 + 0.06, 0], ROOF, { roughness: 0.7 });
  }

  const wheelGeo = new THREE.CylinderGeometry(
    shape.wheelRadius,
    shape.wheelRadius,
    0.26,
    24
  );
  const tyreMat = new THREE.MeshStandardMaterial({ color: TIRE, roughness: 0.9 });
  const hubGeo = new THREE.CylinderGeometry(
    shape.wheelRadius * 0.45,
    shape.wheelRadius * 0.45,
    0.28,
    16
  );
  const hubMat = new THREE.MeshStandardMaterial({ color: HUB, roughness: 0.4, metalness: 0.6 });

  for (const x of shape.axles) {
    for (const side of [-1, 1]) {
      const z = (shape.trackWidth / 2) * side;
      const tyre = new THREE.Mesh(wheelGeo, tyreMat);
      tyre.rotation.x = Math.PI / 2;
      tyre.position.set(x, wheelY, z);
      group.add(tyre);

      const hub = new THREE.Mesh(hubGeo, hubMat);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(x, wheelY, z);
      group.add(hub);
    }
  }

  // Headlight bar — gives the silhouette a front, so the rotation reads as a
  // vehicle turning rather than a block spinning.
  box(group, [0.08, 0.12, bw * 0.55], [bl / 2, bodyY + bh * 0.1, 0], LEMON, {
    roughness: 0.3,
    metalness: 0.1,
  });

  return group;
}

export function VehicleBodyPreview({
  bodyClass,
  glbUrl,
  className = '',
}: {
  bodyClass: BodyClass;
  /**
   * A licensed mesh for this exact make/model/year. When present it replaces
   * the schematic entirely and the caption should change with it.
   */
  glbUrl?: string | null;
  className?: string;
}) {
  const mount = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mount.current;
    if (!el) return;

    const scene = new THREE.Scene();
    const shape = SHAPES[bodyClass] ?? SHAPES.suv_pickup;

    const width = el.clientWidth || 320;
    const height = el.clientHeight || 220;
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 200);
    camera.position.set(shape.view * 0.62, shape.view * 0.42, shape.view * 0.72);
    camera.lookAt(0, 0.7, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    el.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(5, 8, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(LEMON, 0.5);
    rim.position.set(-6, 3, -5);
    scene.add(rim);

    const pivot = new THREE.Group();
    scene.add(pivot);

    let disposed = false;
    let vehicle: THREE.Object3D = buildVehicle(shape);
    pivot.add(vehicle);

    // A real asset, when the fleet has bought one for this model.
    if (glbUrl) {
      import('three/addons/loaders/GLTFLoader.js')
        .then(({ GLTFLoader }) => {
          if (disposed) return;
          new GLTFLoader().load(
            glbUrl,
            (gltf) => {
              if (disposed) return;
              pivot.remove(vehicle);
              // Normalise to roughly the schematic's footprint so the camera
              // framing holds whatever scale the asset was authored at.
              const bounds = new THREE.Box3().setFromObject(gltf.scene);
              const size = bounds.getSize(new THREE.Vector3());
              const scale = size.x > 0 ? shape.body[0] / size.x : 1;
              gltf.scene.scale.setScalar(scale);
              gltf.scene.position.y = -bounds.min.y * scale;
              vehicle = gltf.scene;
              pivot.add(vehicle);
            },
            undefined,
            // A missing or broken asset keeps the schematic rather than
            // leaving an empty frame.
            () => {}
          );
        })
        .catch(() => {});
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    const start = performance.now();

    const render = () => {
      if (disposed) return;
      // Slow, continuous, and never a full spin per second — this sits beside a
      // form someone is typing in.
      pivot.rotation.y = reduced ? 0.6 : ((performance.now() - start) / 1000) * 0.35;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();

    const onResize = () => {
      const w = el.clientWidth || width;
      const h = el.clientHeight || height;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      el.removeChild(renderer.domElement);
    };
  }, [bodyClass, glbUrl]);

  return <div ref={mount} className={className} aria-hidden="true" />;
}
