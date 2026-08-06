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
  { href: '/pricing', label: 'Pricing' },
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
          <svg className="fs-wordmark__mark" viewBox="0 0 64 64" aria-hidden>
              <g fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="26" y="26" width="12" height="12" rx="2.5" />
                <path d="M26 32H12M12 27v10M38 32h14M52 27v10" />
                <path d="M32 38v8" />
                <path d="M22.5 51.5a13 13 0 0 0 19 0" opacity="0.85" />
                <path d="M16 57a22 22 0 0 0 32 0" opacity="0.5" />
              </g>
            </svg>
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
            <svg className="fs-wordmark__mark" viewBox="0 0 64 64" aria-hidden>
              <g fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="26" y="26" width="12" height="12" rx="2.5" />
                <path d="M26 32H12M12 27v10M38 32h14M52 27v10" />
                <path d="M32 38v8" />
                <path d="M22.5 51.5a13 13 0 0 0 19 0" opacity="0.85" />
                <path d="M16 57a22 22 0 0 0 32 0" opacity="0.5" />
              </g>
            </svg>
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
