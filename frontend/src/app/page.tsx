'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { gsap } from 'gsap';
import { api, Customer, isAuthenticated } from '@/lib/api';
import { HeroDashboard } from '@/components/marketing/HeroDashboard';
import { LiveMapDemo } from '@/components/marketing/LiveMapDemo';
import { ReconcileFlow } from '@/components/marketing/ReconcileFlow';
import { FuelMath } from '@/components/marketing/FuelMath';
import { MarketingFooter, MarketingNav } from '@/components/marketing/MarketingChrome';
import { ScrollTimeline } from '@/components/marketing/ScrollTimeline';
import { countUp, revealOnScroll, useGsapScope } from '@/components/marketing/useScrollReveal';
import './marketing.css';

function Marker({ num, label }: { num: string; label: string }) {
  return (
    <div className="fs-marker">
      <span className="fs-marker__num">{num}</span>
      <span className="fs-marker__rule" data-rule />
      <span className="fs-marker__label">{label}</span>
    </div>
  );
}

export default function LandingPage() {
  const router = useRouter();

  // Someone already signed in has no use for the pitch, so send them where they
  // were going. Visitors without a token never touch this and see the page.
  // The landing renders while the check runs, so there is no loading screen
  // and no flash of blank page for the far more common signed-out case.
  useEffect(() => {
    if (!isAuthenticated()) return;

    let cancelled = false;
    api<Customer>('/auth/me')
      .then((me) => {
        if (!cancelled) router.replace(me.onboarding_completed ? '/dashboard' : '/onboarding');
      })
      // A stale or rejected token just means "treat them as a visitor".
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [router]);

  const scope = useGsapScope(({ scope }) => {
    // Hero: lines rise out of their masks, then everything else settles in.
    gsap.from('[data-hero-line] > span', {
      yPercent: 115,
      duration: 1.1,
      ease: 'expo.out',
      stagger: 0.09,
    });
    gsap.from('[data-hero-tail]', {
      opacity: 0,
      y: 20,
      duration: 0.9,
      ease: 'power3.out',
      delay: 0.45,
      stagger: 0.1,
    });
    gsap.from('[data-readout]', {
      opacity: 0,
      y: 40,
      scale: 0.97,
      duration: 1.1,
      ease: 'power3.out',
      delay: 0.3,
    });

    // Every section caption draws its own hairline as it arrives.
    gsap.utils.toArray<HTMLElement>('[data-rule]', scope).forEach((rule) => {
      gsap.from(rule, {
        scaleX: 0,
        duration: 1,
        ease: 'power3.inOut',
        scrollTrigger: { trigger: rule, start: 'top 90%', once: true },
      });
    });

    revealOnScroll('[data-reveal]', scope);

    // Headline figures count up rather than simply appearing.
    gsap.utils.toArray<HTMLElement>('[data-count]', scope).forEach((el) => {
      const to = Number(el.dataset.count);
      const prefix = el.dataset.prefix ?? '';
      const suffix = el.dataset.suffix ?? '';
      const decimals = Number(el.dataset.decimals ?? 0);
      countUp(
        el,
        to,
        (value) =>
          `${prefix}${value.toLocaleString('en-NG', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })}${suffix}`
      );
    });

    // Step cards arrive at slightly different rates: depth without moving the
    // whole section, which would fight the reading rhythm.
    gsap.utils.toArray<HTMLElement>('[data-step]', scope).forEach((card, i) => {
      gsap.from(card, {
        opacity: 0,
        y: 60 + i * 14,
        duration: 1,
        ease: 'power3.out',
        scrollTrigger: { trigger: card, start: 'top 88%', once: true },
      });
    });

    // Dashboard panels drift as they pass, so scrolling feels connected to the
    // thing being described.
    gsap.utils.toArray<HTMLElement>('[data-panel]', scope).forEach((panel) => {
      gsap.fromTo(
        panel,
        { y: 40 },
        {
          y: -20,
          ease: 'none',
          scrollTrigger: { trigger: panel, start: 'top bottom', end: 'bottom top', scrub: 0.8 },
        }
      );
    });
  });

  return (
    <div className="fs-landing" ref={scope}>
      <MarketingNav />
      <ScrollTimeline />

      {/* 01. hero ------------------------------------------------------ */}
      <section className="fs-shell fs-hero">
        <div className="fs-hero__grid">
          <div>
            <span className="fs-eyebrow" data-hero-tail>
              Fleet fuel intelligence · Nigeria
            </span>

            <h1 className="fs-display" style={{ marginTop: '1.5rem' }}>
              <span className="fs-reveal" data-hero-line>
                <span>Every litre,</span>
              </span>
              <span className="fs-reveal" data-hero-line>
                <span>
                  <em>accounted</em> for.
                </span>
              </span>
            </h1>

            <p className="fs-lede" style={{ marginTop: '1.75rem' }} data-hero-tail>
              Fuel is the second-largest cost in a Nigerian fleet and the least visible. FuelSense
              reads your vehicles directly, tracking distance, engine hours, idling and fuel burn,
              then turns it into naira you can check.
            </p>

            <div className="fs-hero__actions" data-hero-tail>
              <Link href="/register" className="fs-btn fs-btn--primary">
                Start tracking
              </Link>
              <Link href="/contact" className="fs-btn fs-btn--ghost">
                Talk to us about trackers
              </Link>
            </div>

            <p className="fs-small" style={{ marginTop: '1.25rem' }} data-hero-tail>
              Works with the Teltonika FMC150. No fuel sensor to install.
            </p>
          </div>

          <div data-readout>
            <HeroDashboard />
          </div>
        </div>
      </section>

      {/* 02. the problem ----------------------------------------------- */}
      <section className="fs-shell fs-section" id="problem">
        <Marker num="02" label="The problem" />
        <h2 className="fs-h2" data-reveal>
          Between two fill-ups, a fleet runs <em>blind</em>.
        </h2>
        <p className="fs-body" style={{ marginTop: '1.25rem' }} data-reveal>
          You know what you paid at the pump. You do not know how much of it moved the vehicle, how
          much burned standing still with the engine running, or how much never reached the tank.
          Every argument with a driver becomes one person&rsquo;s word against another&rsquo;s.
        </p>

        <div className="fs-stats" style={{ marginTop: '2.5rem' }} data-reveal>
          <div className="fs-stat">
            <p className="fs-stat__value fs-mono" data-count="1330" data-prefix="₦">
              ₦0
            </p>
            <p className="fs-stat__label">Per litre, and moving</p>
            <p className="fs-stat__note">
              Pump prices change faster than receipts accumulate. You set the price; earlier months
              keep the price that applied when the fuel was actually burned.
            </p>
          </div>
          <div className="fs-stat">
            <p
              className="fs-stat__value fs-mono"
              data-count="2.3"
              data-decimals="1"
              data-suffix=" L/h"
            >
              0 L/h
            </p>
            <p className="fs-stat__label">Burned going nowhere</p>
            <p className="fs-stat__note">
              A 2.5L engine idling in traffic. Twenty minutes at a gate is fuel spent on zero
              kilometres, and invisible without engine data.
            </p>
          </div>
          <div className="fs-stat">
            <p className="fs-stat__value fs-mono" data-count="100" data-suffix="%">
              0%
            </p>
            <p className="fs-stat__label">Of trips, evidenced</p>
            <p className="fs-stat__note">
              Every trip carries its route, stops, idle time and fuel. Disputes get settled with a
              replay, not an accusation.
            </p>
          </div>
        </div>
      </section>

      {/* 03. how it works ---------------------------------------------- */}
      <section className="fs-shell fs-section" id="how">
        <Marker num="03" label="How it works" />
        <h2 className="fs-h2" data-reveal>
          A tracker, satellites, and <em>arithmetic</em> you can audit.
        </h2>
        <p className="fs-body" style={{ marginTop: '1.25rem', marginBottom: '2.5rem' }} data-reveal>
          Nothing is spliced into the fuel line and there is no sensor in the tank. The work is done
          by a Teltonika FMC150 fitted to the vehicle, and by the satellite fixes it already
          collects.
        </p>

        <div className="fs-steps">
          <article className="fs-step" data-step>
            <span className="fs-step__index">Step 01</span>
            <h3 className="fs-h3">The tracker is fitted</h3>
            <p className="fs-small">
              An FMC150 wires into the vehicle&rsquo;s power and ignition. From that moment it
              reports position, speed, ignition and movement over the mobile network: every few
              seconds while driving, hourly at rest.
            </p>
            <div className="fs-step__figure">
              <p className="fs-small fs-mono" style={{ color: 'var(--green-700)' }}>
                AVL 239 · ignition
                <br />
                AVL 240 · movement
                <br />
                AVL 16 · odometer
              </p>
            </div>
          </article>

          <article className="fs-step" data-step>
            <span className="fs-step__index">Step 02</span>
            <h3 className="fs-h3">GNSS becomes litres</h3>
            <p className="fs-small">
              The device computes fuel itself. Using satellite-measured speed and acceleration
              against the vehicle&rsquo;s consumption profile, its firmware reports a running total
              of fuel used and the rate it is burning right now.
            </p>
            <div className="fs-step__figure">
              <p className="fs-small fs-mono" style={{ color: 'var(--green-700)' }}>
                AVL 12 · fuel used (ml)
                <br />
                AVL 13 · fuel rate (L/h)
              </p>
            </div>
          </article>

          <article className="fs-step" data-step>
            <span className="fs-step__index">Step 03</span>
            <h3 className="fs-h3">Litres become naira</h3>
            <p className="fs-small">
              FuelSense keeps a virtual tank per vehicle, drains it against real burn, credits it
              from the receipts you log, and prices the result at the fuel price in force that day
              so last month&rsquo;s spend never changes when today&rsquo;s price does.
            </p>
            <div className="fs-step__figure">
              <p className="fs-small fs-mono" style={{ color: 'var(--green-700)' }}>
                30.4 km ÷ 7.0 km/L
                <br />= 4.3 L × ₦1,330 = ₦5,779
              </p>
            </div>
          </article>
        </div>

        {/* The AVL 12 explanation, stated plainly, beside the device itself */}
        <div
          className="fs-step"
          style={{ marginTop: '1.5rem', background: 'var(--paper-sunk)' }}
          data-reveal
        >
          <div className="fs-avl">
            <div>
              <span className="fs-step__index">Why this beats a number someone typed in</span>
              <h3 className="fs-h3" style={{ maxWidth: '28ch', marginBlock: '0.5rem 0.875rem' }}>
                AVL 12 is measured behaviour, not an assumption.
              </h3>
              <p className="fs-body">
                The easy way to estimate fleet fuel is to multiply distance by a figure from a
                brochure. That figure assumes smooth roads, steady speeds and no air conditioning,
                none of which describe Lagos or Abuja. It cannot tell a crawling hour from a
                flowing one, and it reports nothing at all for a vehicle that sat idling the whole
                afternoon.
              </p>
              <p className="fs-body">
                <strong>AVL 12</strong>{' '}
                is the tracker&rsquo;s own running total of fuel consumed,
                built up continuously from how the vehicle actually moved: every acceleration,
                every crawl, every minute of idling. Paired with <strong>AVL 13</strong>, the live
                burn rate, it separates a hard-driven hour from an easy one on the same route.
              </p>
              <p className="fs-body">
                It is still a model, and we say so. Rather than claim a fuel figure is exact,
                every trip carries a <strong>confidence score</strong>. Three hours crawling
                through Lagos gridlock registers almost no distance while the engine keeps
                burning, so FuelSense reads that state from the tracker, estimates the idle burn,
                and lowers the score with the reason attached. Receipts you log calibrate the
                model further. Managing expectations honestly is what makes the outliers worth
                acting on.
              </p>
            </div>

            <FuelMath />
          </div>
        </div>
      </section>

      {/* 04. live monitoring ------------------------------------------- */}
      <section className="fs-shell fs-section" id="live">
        <Marker num="04" label="Live monitoring" />
        <h2 className="fs-h2" data-reveal>
          Watch a journey <em>account</em> for itself.
        </h2>
        <p className="fs-body" style={{ marginTop: '1.25rem' }} data-reveal>
          Every vehicle sits on a live map with its trail behind it. Trips open and close from the
          ignition, stops are detected and given real addresses, and the tank drains in step with
          the distance. Scroll to drive the route.
        </p>

        <LiveMapDemo />

        <div className="fs-featgrid" style={{ marginTop: '3rem' }}>
          {[
            {
              name: 'Trips, segmented automatically',
              body: 'A trip opens when the ignition turns and closes after 30 minutes at rest. Distance is odometer-validated, with GPS jitter and impossible hops rejected.',
            },
            {
              name: 'Stops that have names',
              body: 'Any halt over three minutes becomes a stop with a real address, so a route reads as a sequence of places rather than coordinates.',
            },
            {
              name: 'Idling, measured in naira',
              body: 'Engine on and stationary is tracked to the minute and priced. It is the most common invisible cost in a fleet, and the easiest to fix.',
            },
            {
              name: 'Alerts that stay honest',
              body: 'Low fuel, tracker unplugged, movement without ignition. Each is a flag for investigation with the evidence attached, never a verdict.',
            },
          ].map((feature) => (
            <div className="fs-feat" key={feature.name} data-reveal>
              <h3 className="fs-feat__name">{feature.name}</h3>
              <p className="fs-small">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 05. receipts and reconciliation -------------------------------- */}
      <section className="fs-shell fs-section" id="receipts">
        <Marker num="05" label="Receipts and reconciliation" />
        <h2 className="fs-h2" data-reveal>
          What was burned, against what was <em>bought</em>.
        </h2>
        <p className="fs-body" style={{ marginTop: '1.25rem' }} data-reveal>
          There is no sensor in your tank, so FuelSense never claims to have watched fuel leave it.
          What it can do is measure the burn from the vehicle&rsquo;s own movement and set it beside
          the receipts your drivers upload. Where the two disagree, you have a specific number and a
          specific day to ask about.
        </p>

        <ReconcileFlow />

        <div className="fs-featgrid" style={{ marginTop: '3rem' }}>
          {[
            {
              name: 'Drivers upload from their phone',
              body: 'A photo of the pump slip at the forecourt. OCR reads the merchant, litres and amount, so nobody types figures into a spreadsheet a week later.',
            },
            {
              name: 'Matched to the tank automatically',
              body: 'A logged purchase is matched against the refuel the tracker saw at that time, then credited to the vehicle’s virtual tank.',
            },
            {
              name: 'The price you actually paid',
              body: 'Receipts set the real naira-per-litre for the day they cover, and every cost figure for that period is valued at it.',
            },
            {
              name: 'Calibration that improves with use',
              body: 'Each verified fill-up sharpens the vehicle’s consumption model, so the estimate stops being a class average and becomes this vehicle.',
            },
          ].map((feature) => (
            <div className="fs-feat" key={feature.name} data-reveal>
              <h3 className="fs-feat__name">{feature.name}</h3>
              <p className="fs-small">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 06. dashboard -------------------------------------------------- */}
      <section className="fs-shell fs-section" id="dashboard">
        <Marker num="06" label="Inside the dashboard" />
        <h2 className="fs-h2" data-reveal>
          The numbers, and <em>how</em> they were reached.
        </h2>
        <p className="fs-body" style={{ marginTop: '1.25rem', marginBottom: '2.5rem' }} data-reveal>
          Every figure shows its working. These are the panels you land on.
        </p>

        <div style={{ display: 'grid', gap: '1.5rem' }}>
          <div className="fs-panel" data-panel>
            <p className="fs-panel__title">Operational snapshot</p>
            <p className="fs-panel__sub">Spend, with the distance that earned it</p>
            <div className="fs-panelgrid">
              <div className="fs-tile">
                <p className="fs-tile__label">Fuel spend · 7d</p>
                <p className="fs-tile__value">₦48,300</p>
                <p className="fs-tile__note">286 km · ₦169/km</p>
              </div>
              <div className="fs-tile">
                <p className="fs-tile__label">Money saved</p>
                <p className="fs-tile__value fs-tile__value--good">₦6,420</p>
                <p className="fs-tile__note">vs benchmark</p>
              </div>
              <div className="fs-tile">
                <p className="fs-tile__label">Idling</p>
                <p className="fs-tile__value fs-tile__value--warn">3h 40m</p>
                <p className="fs-tile__note">7.9 L burned</p>
              </div>
              <div className="fs-tile">
                <p className="fs-tile__label">Economy</p>
                <p className="fs-tile__value">7.4 km/L</p>
                <p className="fs-tile__note">vs 7.0 benchmark</p>
              </div>
            </div>
            <p className="fs-panel__sub" style={{ marginTop: '0.875rem' }}>
              286 km at the 7.0 km/L benchmark = 40.9 L, which at ₦1,330/L is ₦54,720. Actual spend
              was ₦48,300, a saving of ₦6,420.
            </p>
          </div>

          <div className="fs-panel" data-panel>
            <p className="fs-panel__title">Vehicle data</p>
            <p className="fs-panel__sub">
              Every signal the tracker sends, named and explained in plain words
            </p>
            <div style={{ marginTop: '0.875rem' }}>
              {[
                ['Fuel used (GPS)', '7.51 L', '12'],
                ['Fuel rate (GPS)', '2.27 L/h', '13'],
                ['Total odometer', '785.8 km', '16'],
                ['Ignition', 'On', '239'],
                ['Movement', 'Moving', '240'],
                ['GSM signal strength', '4 /5', '21'],
              ].map(([label, value, avl]) => (
                <div className="fs-row" key={avl}>
                  <span>{label}</span>
                  <span>
                    <span className="fs-row__value">{value}</span>{' '}
                    <span className="fs-row__muted fs-mono" style={{ fontSize: '0.6875rem' }}>
                      AVL {avl}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="fs-panel" data-panel>
            <p className="fs-panel__title">Efficiency and driving behaviour</p>
            <p className="fs-panel__sub">Per vehicle and per driver, against a realistic baseline</p>
            <div style={{ marginTop: '0.875rem' }}>
              {[
                { label: 'LIVE-FMC150 · Benneth', mid: '286 km · 38.6 L', right: '7.4 km/L', warn: false },
                { label: 'Harsh braking', mid: 'this week', right: '4 events', warn: true },
                { label: 'Idling', mid: '3h 40m engine-on, stationary', right: '₦10,500', warn: true },
                { label: 'Driver score', mid: 'against fleet baseline', right: '92 / 100', warn: false },
              ].map((row) => (
                <div className="fs-row" key={row.label}>
                  <span>{row.label}</span>
                  <span className="fs-row__muted">{row.mid}</span>
                  <span
                    className="fs-row__value"
                    style={{ color: row.warn ? '#ffb95f' : '#00e599' }}
                  >
                    {row.right}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <p className="fs-small" style={{ marginTop: '1.5rem' }} data-reveal>
          Also inside: trip history with exact date ranges, fuel-level charts with idling shaded,
          event replay, driver receipt uploads read by OCR, and email alerts you choose.
        </p>
      </section>

      {/* 07. cta -------------------------------------------------------- */}
      <section className="fs-shell fs-section" style={{ borderTop: 0 }}>
        <div className="fs-cta" data-reveal>
          <h2 className="fs-h2">
            Find out what your fleet <em>actually</em> costs.
          </h2>
          <p className="fs-lede" style={{ color: 'rgba(255,254,251,0.72)', marginTop: '1.25rem' }}>
            Start with one vehicle. We supply and configure the Teltonika hardware, or work with
            trackers you already run.
          </p>
          <div className="fs-hero__actions">
            <Link
              href="/contact"
              className="fs-btn"
              style={{ background: 'var(--green-electric)', color: '#04231a' }}
            >
              Talk to us
            </Link>
            <Link
              href="/register"
              className="fs-btn fs-btn--ghost"
              style={{ borderColor: 'rgba(255,254,251,0.32)', color: 'var(--paper-raised)' }}
            >
              Create an account
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
