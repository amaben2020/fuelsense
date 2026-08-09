import * as THREE from 'three';

// Pre-rendered 3D vehicle sprites for the live map.
//
// A WebGLOverlayView per vehicle would be the "proper" 3D route, but it costs a
// GL context per marker and fights the map's own camera. Rendering the model
// once per heading step into data URLs gives the same read — a lit, shaded
// vehicle that turns with its bearing — at the cost of a plain Marker icon.
//
// Vanilla three.js for the same reason Vehicle3D is: R3F's reconciler does not
// mount reliably in this dev setup.

/** Heading resolution. 10° steps are below what the eye resolves at marker size. */
const HEADING_STEP_DEG = 10;
const FRAMES = 360 / HEADING_STEP_DEG;
const SPRITE_PX = 128;

const BODY = 0xe8ecf4;
const BODY_DARK = 0xb9c0cd;
const GLASS = 0x1b2430;
const TIRE = 0x0b0f15;

type SpriteSet = string[];

const cache = new Map<string, SpriteSet>();

function buildVehicle(accent: number): THREE.Group {
  const car = new THREE.Group();

  const paint = (color: number, metalness = 0.35, roughness = 0.45) =>
    new THREE.MeshStandardMaterial({ color, metalness, roughness });

  const box = (
    [w, h, d]: [number, number, number],
    [x, y, z]: [number, number, number],
    mat: THREE.Material
  ) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    car.add(m);
    return m;
  };

  // Nose faces +x, matching the heading convention below.
  box([4.3, 1.0, 1.85], [0, 1.0, 0], paint(BODY));
  box([2.5, 0.8, 1.6], [-0.3, 1.85, 0], paint(BODY_DARK, 0.3, 0.5));
  box([1.05, 0.22, 1.7], [1.6, 1.38, 0], paint(BODY));

  // Glass
  box([0.06, 0.66, 1.42], [1.02, 1.8, 0], paint(GLASS, 0.85, 0.12));
  box([0.05, 0.6, 1.42], [-1.58, 1.84, 0], paint(GLASS, 0.85, 0.12));
  for (const z of [0.805, -0.805]) {
    box([2.3, 0.42, 0.02], [-0.3, 1.88, z], paint(GLASS, 0.85, 0.12));
  }

  // Accent stripe so the marker still carries the brand colour
  for (const z of [0.93, -0.93]) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(4.2, 0.06, 0.02),
      new THREE.MeshBasicMaterial({ color: accent })
    );
    stripe.position.set(0, 0.62, z);
    car.add(stripe);
  }

  // Lights — warm at the nose, red at the tail, so direction reads even static
  for (const z of [0.6, -0.6]) {
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.15, 0.36),
      new THREE.MeshBasicMaterial({ color: 0xfff3c4 })
    );
    head.position.set(2.16, 1.24, z);
    car.add(head);
    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.16, 0.3),
      new THREE.MeshBasicMaterial({ color: 0xff5f5f })
    );
    tail.position.set(-2.17, 1.28, z);
    car.add(tail);
  }

  const tireMat = new THREE.MeshStandardMaterial({ color: TIRE, roughness: 0.95 });
  for (const x of [1.42, -1.42]) {
    for (const z of [0.82, -0.82]) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.42, 0.3, 20),
        tireMat
      );
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, 0.42, z);
      car.add(wheel);
    }
  }

  return car;
}

/**
 * Renders one sprite per heading step and returns them as data URLs.
 *
 * Synchronous and one-shot: a single renderer is created, used for every frame
 * and disposed, so no GL context outlives the call.
 */
function renderSprites(accent: number): SpriteSet {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SPRITE_PX, SPRITE_PX);

  const scene = new THREE.Scene();
  // Orthographic: a perspective camera would make the vehicle's apparent size
  // depend on where in the frame it sits, so sprites would not match each other.
  const camera = new THREE.OrthographicCamera(-2.5, 2.5, 2.5, -2.5, 0.1, 100);
  // High three-quarter view, matching how the map reads at street zoom.
  camera.position.set(0, 5.4, 6.2);
  camera.lookAt(0, 0.6, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.65);
  key.position.set(3, 8, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.4);
  fill.position.set(-4, 3, -3);
  scene.add(fill);

  const pivot = new THREE.Group();
  const car = buildVehicle(accent);
  pivot.add(car);
  scene.add(pivot);

  const frames: SpriteSet = [];
  for (let i = 0; i < FRAMES; i++) {
    // Google headings run clockwise from north; three.js yaw runs
    // counter-clockwise, and the model's nose is +x (east) at yaw 0.
    const heading = i * HEADING_STEP_DEG;
    pivot.rotation.y = THREE.MathUtils.degToRad(90 - heading);
    renderer.render(scene, camera);
    frames.push(renderer.domElement.toDataURL('image/png'));
  }

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m?.dispose();
  });
  renderer.dispose();

  return frames;
}

/**
 * Sprite for a heading, rendering the set on first use.
 *
 * Returns null when there is no document to render into (SSR) so callers can
 * fall back rather than crash.
 */
export function vehicleSprite(heading: number, accent: string): string | null {
  if (typeof document === 'undefined') return null;

  const key = accent;
  let set = cache.get(key);
  if (!set) {
    try {
      set = renderSprites(new THREE.Color(accent).getHex());
    } catch {
      // WebGL unavailable (headless, blocked, context limit). Caller falls back.
      return null;
    }
    cache.set(key, set);
  }

  const normalised = ((heading % 360) + 360) % 360;
  return set[Math.round(normalised / HEADING_STEP_DEG) % FRAMES];
}

export const VEHICLE_SPRITE_PX = SPRITE_PX;
