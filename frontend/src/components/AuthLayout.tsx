'use client';

import Link from 'next/link';
import { BrandMark } from '@/components/BrandMark';
import '@/app/marketing.css';

// Signing in should not feel like leaving the product you were just reading
// about. This carries the marketing surface through: paper ground, the same
// serif for the heading, the same monospace on field labels.
//
// The left column restates what the account is for, so a signup interrupted
// and resumed a day later still has its context on screen.

export const inputClass = 'fs-input';

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="fs-field" style={{ display: 'block', marginBottom: '1rem' }}>
      <span className="fs-field__label">{label}</span>
      {children}
    </label>
  );
}

const REASSURANCE: Array<[string, string]> = [
  ['One vehicle is enough to start', 'No minimum fleet size, and no licence to buy up front.'],
  [
    'Bring your own trackers',
    'Already running FMC150s? We configure them and charge for the software only.',
  ],
  ['Your data stays yours', 'Telemetry belongs to your account, and you can export it whenever.'],
];

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="fs-landing fs-auth">
      <div className="fs-shell fs-auth__grid">
        <div>
          <Link href="/" className="fs-wordmark">
            <BrandMark className="fs-wordmark__mark" strokeWidth={4.5} />
            FuelSense
          </Link>

          <h1
            className="fs-h2"
            style={{ marginTop: '2rem', fontSize: 'clamp(1.875rem, 3.4vw, 2.75rem)' }}
          >
            {title}
          </h1>
          <p className="fs-lede" style={{ marginTop: '1rem' }}>
            {subtitle}
          </p>

          <div className="fs-auth__facts">
            {REASSURANCE.map(([heading, body]) => (
              <div className="fs-feat" key={heading}>
                <h2 className="fs-feat__name" style={{ fontSize: '1.0625rem' }}>
                  {heading}
                </h2>
                <p className="fs-small">{body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="fs-form fs-auth__form">{children}</div>
      </div>
    </div>
  );
}
