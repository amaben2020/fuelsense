'use client';

// A tank that behaves like a tank.
//
// Fuel in a moving vehicle does not sit flat: it rocks against the ends and
// settles slowly. Two sine waves of different wavelength and speed drift
// across the surface, which reads as liquid rather than as a progress bar.
// Kept slow and shallow on purpose, so it registers as texture and never
// competes with the numbers beside it.

export function SloshTank({ fillFraction }: { fillFraction: number }) {
  const clamped = Math.max(0, Math.min(1, fillFraction));
  // Surface height inside the tube, leaving room for the wave crests.
  const surfaceY = 6 + (1 - clamped) * 84;

  return (
    <div className="fs-tank">
      <svg viewBox="0 0 120 100" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="fs-fuel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#35c795" />
            <stop offset="100%" stopColor="#00885d" />
          </linearGradient>
          <clipPath id="fs-tank-clip">
            <rect x="0" y="0" width="120" height="100" rx="10" />
          </clipPath>
        </defs>

        <g clipPath="url(#fs-tank-clip)">
          <g style={{ transform: `translateY(${surfaceY}px)`, transition: 'transform 0.45s ease-out' }}>
            {/* Back wave: longer, slower, slightly transparent for depth */}
            <path
              className="fs-tank__wave fs-tank__wave--back"
              d="M -120 6 Q -90 0, -60 6 T 0 6 T 60 6 T 120 6 T 180 6 T 240 6 V 120 H -120 Z"
              fill="url(#fs-fuel)"
              opacity="0.55"
            />
            {/* Front wave: shorter and quicker, so crests cross rather than march */}
            <path
              className="fs-tank__wave fs-tank__wave--front"
              d="M -120 8 Q -100 2, -80 8 T -40 8 T 0 8 T 40 8 T 80 8 T 120 8 T 160 8 T 200 8 V 120 H -120 Z"
              fill="url(#fs-fuel)"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
