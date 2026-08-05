'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// The reconciliation chain, drawn as the three quantities it actually joins.
//
// Left: what the vehicle did, measured by the tracker. Right: what the driver
// says was bought, from a photographed receipt. Middle: the difference, which
// is the only number worth a conversation.
//
// Deliberately not framed as theft detection. Without a fuel-level sensor the
// honest claim is a gap between measured burn and declared purchase, which a
// manager investigates rather than a system that accuses.

const STEPS = [
  {
    key: 'measured',
    tag: 'Measured by the tracker',
    rows: [
      ['Distance', '286 km'],
      ['Engine hours', '11h 20m'],
      ['Idling', '3h 40m'],
      ['Fuel burned', '38.6 L'],
    ],
    foot: 'GNSS distance and burn, accumulated ping by ping',
  },
  {
    key: 'declared',
    tag: 'Declared by the driver',
    rows: [
      ['Receipt photo', 'uploaded'],
      ['Read by OCR', 'NNPC, Kubwa'],
      ['Litres', '42.0 L'],
      ['Amount', '₦55,860'],
    ],
    foot: 'Driver uploads from their phone, OCR reads the slip',
  },
  {
    key: 'gap',
    tag: 'The difference',
    rows: [
      ['Burned', '38.6 L'],
      ['Bought', '42.0 L'],
      ['Unaccounted', '3.4 L'],
      ['At ₦1,330/L', '₦4,522'],
    ],
    foot: 'A question to ask, not a verdict to deliver',
  },
];

export function ReconcileFlow() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scope = root.current;
    if (!scope) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      // The three cards arrive left to right, so the chain is read in order.
      gsap.from('[data-recon-card]', {
        opacity: 0,
        y: 36,
        duration: 0.8,
        ease: 'power3.out',
        stagger: 0.16,
        scrollTrigger: { trigger: scope, start: 'top 82%', once: true },
      });

      // Connectors draw between them once the cards have landed.
      gsap.from('[data-recon-link]', {
        scaleX: 0,
        transformOrigin: 'left center',
        duration: 0.5,
        ease: 'power2.inOut',
        stagger: 0.16,
        delay: 0.4,
        scrollTrigger: { trigger: scope, start: 'top 82%', once: true },
      });

      // The gap figure counts up last, because it is the point of the section.
      const gapValue = scope.querySelector<HTMLElement>('[data-recon-gap]');
      if (gapValue) {
        const state = { value: 0 };
        gsap.to(state, {
          value: 4522,
          duration: 1.2,
          ease: 'power2.out',
          delay: 0.7,
          scrollTrigger: { trigger: scope, start: 'top 82%', once: true },
          onUpdate: () => {
            gapValue.textContent = `₦${Math.round(state.value).toLocaleString('en-NG')}`;
          },
        });
      }
    }, scope);

    return () => ctx.revert();
  }, []);

  return (
    <div className="fs-recon" ref={root}>
      {STEPS.map((step, i) => (
        <div key={step.key} className="fs-recon__slot">
          <article
            className={`fs-recon__card${step.key === 'gap' ? ' fs-recon__card--gap' : ''}`}
            data-recon-card
          >
            <p className="fs-recon__tag">{step.tag}</p>
            <dl className="fs-recon__rows">
              {step.rows.map(([label, value]) => (
                <div className="fs-recon__row" key={label}>
                  <dt>{label}</dt>
                  <dd
                    className="fs-mono"
                    data-recon-gap={step.key === 'gap' && label === 'At ₦1,330/L' ? '' : undefined}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="fs-recon__foot">{step.foot}</p>
          </article>
          {i < STEPS.length - 1 && <span className="fs-recon__link" data-recon-link aria-hidden />}
        </div>
      ))}
    </div>
  );
}
