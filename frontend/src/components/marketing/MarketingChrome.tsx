'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { isAuthenticated } from '@/lib/api';

// The token lives in browser storage, so the server has nothing to render from.
// useSyncExternalStore gives the server a definite "signed out" snapshot and
// lets the client correct it on hydration, without a state-setting effect.
const noopSubscribe = () => () => {};

const LINKS = [
  { href: '/#how', label: 'How it works' },
  { href: '/#live', label: 'Live monitoring' },
  { href: '/#dashboard', label: 'Dashboard' },
  { href: '/contact', label: 'Contact' },
];

export function MarketingNav() {
  const signedIn = useSyncExternalStore(
    noopSubscribe,
    () => isAuthenticated(),
    () => false
  );

  return (
    <header className="fs-nav">
      <div className="fs-shell fs-nav__inner">
        <Link href="/" className="fs-wordmark">
          <span className="fs-wordmark__dot" aria-hidden />
          FuelSense
        </Link>

        <nav className="fs-navlinks" aria-label="Primary">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="fs-navlink">
              {link.label}
            </Link>
          ))}
        </nav>

        <div style={{ display: 'flex', gap: '0.625rem', alignItems: 'center' }}>
          {signedIn ? (
            <Link href="/dashboard" className="fs-btn fs-btn--primary">
              Open dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="fs-navlink" style={{ whiteSpace: 'nowrap' }}>
                Sign in
              </Link>
              <Link href="/register" className="fs-btn fs-btn--primary">
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="fs-footer">
      <div className="fs-shell fs-footer__inner">
        <div>
          <Link href="/" className="fs-wordmark">
            <span className="fs-wordmark__dot" aria-hidden />
            FuelSense
          </Link>
          <p className="fs-small" style={{ marginTop: '0.5rem', maxWidth: '32ch' }}>
            Fuel intelligence for Nigerian fleets. Built on Teltonika telemetry.
          </p>
        </div>

        <nav
          aria-label="Footer"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '1.25rem', alignItems: 'center' }}
        >
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="fs-navlink">
              {link.label}
            </Link>
          ))}
          <Link href="/login" className="fs-navlink">
            Sign in
          </Link>
        </nav>
      </div>
    </footer>
  );
}
