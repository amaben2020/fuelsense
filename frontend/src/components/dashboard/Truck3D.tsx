'use client';

import { Canvas } from '@react-three/fiber';
import { ContactShadows, OrbitControls, RoundedBox, Text } from '@react-three/drei';

const TRAILER = '#232a35';
const TRAILER_DARK = '#1a202a';
const CAB = '#2a323f';
const GLASS = '#0d1218';
const DARK = '#151b24';
const TIRE = '#0b0f15';
const HUB = '#39424f';
const GREEN = '#00e599';
const AMBER = '#ffd66b';

function Box({
  args,
  position,
  rotation,
  color,
  metalness = 0.25,
  roughness = 0.7,
  emissive,
  emissiveIntensity = 1,
}: {
  args: [number, number, number];
  position: [number, number, number];
  rotation?: [number, number, number];
  color: string;
  metalness?: number;
  roughness?: number;
  emissive?: string;
  emissiveIntensity?: number;
}) {
  return (
    <mesh position={position} rotation={rotation}>
      <boxGeometry args={args} />
      <meshStandardMaterial
        color={color}
        metalness={metalness}
        roughness={roughness}
        emissive={emissive ?? '#000000'}
        emissiveIntensity={emissive ? emissiveIntensity : 0}
      />
    </mesh>
  );
}

function Wheel({ position }: { position: [number, number, number] }) {
  return (
    <group position={position} rotation={[Math.PI / 2, 0, 0]}>
      <mesh>
        <cylinderGeometry args={[0.42, 0.42, 0.34, 28]} />
        <meshStandardMaterial color={TIRE} roughness={0.95} metalness={0.05} />
      </mesh>
      <mesh>
        <cylinderGeometry args={[0.17, 0.17, 0.36, 20]} />
        <meshStandardMaterial color={HUB} roughness={0.35} metalness={0.7} />
      </mesh>
    </group>
  );
}

function TruckModel({ plate, model }: { plate: string; model: string | null }) {
  const grooveXs = [-2.7, -2.1, -1.5, -0.9, -0.3, 0.3, 0.9];
  return (
    <group>
      {/* chassis */}
      <Box args={[5.9, 0.26, 0.9]} position={[0.15, 0.5, 0]} color={DARK} roughness={0.85} />

      {/* trailer */}
      <RoundedBox args={[4.35, 2.05, 1.85]} radius={0.06} smoothness={3} position={[-1.0, 1.68, 0]}>
        <meshStandardMaterial color={TRAILER} metalness={0.3} roughness={0.6} />
      </RoundedBox>
      {grooveXs.map((x) =>
        ([0.93, -0.93] as const).map((z) => (
          <Box
            key={`${x}${z}`}
            args={[0.03, 1.86, 0.012]}
            position={[x, 1.68, z]}
            color={TRAILER_DARK}
            roughness={0.8}
          />
        ))
      )}
      {/* rear doors */}
      <Box args={[0.04, 1.9, 1.7]} position={[-3.19, 1.68, 0]} color={TRAILER_DARK} />

      {/* neon accent strips along trailer skirt */}
      {([0.94, -0.94] as const).map((z) => (
        <Box
          key={z}
          args={[4.3, 0.045, 0.02]}
          position={[-1.0, 0.68, z]}
          color={GREEN}
          emissive={GREEN}
          emissiveIntensity={1.6}
        />
      ))}

      {/* cab */}
      <RoundedBox args={[1.6, 1.45, 1.7]} radius={0.09} smoothness={3} position={[2.2, 1.25, 0]}>
        <meshStandardMaterial color={CAB} metalness={0.35} roughness={0.55} />
      </RoundedBox>
      {/* windshield */}
      <Box
        args={[0.06, 0.6, 1.4]}
        position={[3.0, 1.6, 0]}
        rotation={[0, 0, -0.1]}
        color={GLASS}
        metalness={0.85}
        roughness={0.12}
      />
      {/* side windows */}
      {([0.86, -0.86] as const).map((z) => (
        <Box
          key={z}
          args={[0.72, 0.46, 0.02]}
          position={[2.4, 1.62, z]}
          color={GLASS}
          metalness={0.85}
          roughness={0.12}
        />
      ))}
      {/* roof deflector */}
      <Box
        args={[1.0, 0.06, 1.55]}
        position={[1.85, 2.32, 0]}
        rotation={[0, 0, -0.42]}
        color={CAB}
        roughness={0.5}
      />
      {/* bumper + headlights */}
      <Box args={[0.14, 0.34, 1.68]} position={[3.05, 0.48, 0]} color={DARK} />
      {([0.55, -0.55] as const).map((z) => (
        <Box
          key={z}
          args={[0.05, 0.12, 0.26]}
          position={[3.06, 0.72, z]}
          color={AMBER}
          emissive={AMBER}
          emissiveIntensity={1.8}
        />
      ))}
      {/* fuel tank */}
      <mesh position={[1.35, 0.55, 0.72]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.2, 0.2, 0.7, 24]} />
        <meshStandardMaterial color={HUB} metalness={0.8} roughness={0.25} />
      </mesh>

      {/* wheels: steer, drive, trailer tandem */}
      {([0.79, -0.79] as const).map((z) => (
        <group key={z}>
          <Wheel position={[2.4, 0.42, z]} />
          <Wheel position={[1.15, 0.42, z]} />
          <Wheel position={[-1.95, 0.42, z]} />
          <Wheel position={[-2.75, 0.42, z]} />
        </group>
      ))}

      {/* livery — plate + model on both trailer sides */}
      {([0.94, -0.94] as const).map((z) => (
        <group key={z} position={[-1.0, 1.78, z]} rotation={[0, z > 0 ? 0 : Math.PI, 0]}>
          <Text fontSize={0.42} color="#e8ecf4" anchorX="center" anchorY="middle">
            {plate}
          </Text>
          <Text position={[0, -0.42, 0]} fontSize={0.2} color="#7d8697" anchorX="center" anchorY="middle">
            {model ?? 'FLEET UNIT'}
          </Text>
        </group>
      ))}
    </group>
  );
}

export function Truck3D({ plate, model }: { plate: string; model: string | null }) {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [7.5, 3.8, 7.5], fov: 38 }}
      gl={{ alpha: true, antialias: true }}
      style={{ background: 'transparent' }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[6, 9, 5]} intensity={1.7} />
      <directionalLight position={[-7, 4, -6]} intensity={0.5} color="#7df5c8" />
      <group position={[0, -1.15, 0]}>
        <TruckModel plate={plate} model={model} />
        <ContactShadows position={[0, 0.01, 0]} opacity={0.6} scale={16} blur={2.3} far={3.2} resolution={512} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
          <ringGeometry args={[4.35, 4.45, 72]} />
          <meshBasicMaterial color={GREEN} transparent opacity={0.16} />
        </mesh>
      </group>
      <OrbitControls
        autoRotate
        autoRotateSpeed={0.9}
        enablePan={false}
        minDistance={6}
        maxDistance={14}
        maxPolarAngle={Math.PI / 2.15}
        target={[0, 0.35, 0]}
      />
    </Canvas>
  );
}
