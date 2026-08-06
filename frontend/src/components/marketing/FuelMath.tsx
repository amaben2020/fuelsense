'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// The arithmetic, shown rather than described.
//
// Every claim FuelSense makes reduces to one of these six lines. Publishing
// them is the point: a fleet manager who can see the formula can argue with
// it, and a formula that survives being argued with is worth trusting. Each
// row shows the symbolic form, then substitutes the real numbers from a
// single day on the live vehicle.

interface Equation {
  id: string;
  label: string;
  formula: string;
  substituted: string;
  result: string;
  note: string;
}

const EQUATIONS: Equation[] = [
  {
    id: 'burn',
    label: 'Fuel burned between two pings',
    formula: 'ΔAVL12 × k ÷ 1000',
    substituted: '(7514 − 7461) × 2.396 ÷ 1000',
    result: '0.127 L',
    note: 'The tracker reports millilitres burned. k corrects it.',
  },
  {
    id: 'k',
    label: 'The correction, k',
    formula: 'rate̅ AVL13 ÷ rate̅ AVL12',
    substituted: '2.221 ÷ 0.927',
    result: '2.396',
    note: 'The device’s own two fuel elements, measured against each other while idling. Receipts override this once they exist.',
  },
  {
    id: 'gap',
    label: 'Unaccounted fuel at a fill',
    formula: 'added − (capacity − level)',
    substituted: '45 − (60 − 30)',
    result: '15 L',
    note: 'No tank accepts more than its empty space. The excess is what the model wrongly believed was aboard.',
  },
];

export function FuelMath() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scope = root.current;
    if (!scope) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>('[data-eq]', scope).forEach((row, i) => {
        // The symbolic form arrives first, then the numbers slot into it, so
        // the eye reads the shape before the values.
        const tl = gsap.timeline({
          scrollTrigger: { trigger: row, start: 'top 90%', once: true },
        });

        tl.from(row, { opacity: 0, x: -14, duration: 0.5, ease: 'power2.out', delay: i * 0.04 })
          .from(
            row.querySelector('[data-eq-sub]'),
            { opacity: 0, y: 6, duration: 0.4, ease: 'power2.out' },
            '-=0.15'
          )
          .from(
            row.querySelector('[data-eq-result]'),
            { opacity: 0, scale: 0.9, duration: 0.45, ease: 'back.out(2)' },
            '-=0.2'
          );
      });
    }, scope);

    return () => ctx.revert();
  }, []);

  return (
    <div className="fs-math" ref={root}>
      <p className="fs-math__head">The three lines that matter</p>

      <ol className="fs-math__list">
        {EQUATIONS.map((eq) => (
          <li className="fs-math__row" key={eq.id} data-eq>
            <p className="fs-math__label">{eq.label}</p>

            <p className="fs-math__formula">{eq.formula}</p>

            <p className="fs-math__sub" data-eq-sub>
              <span className="fs-math__subvalue">{eq.substituted}</span>
              <span className="fs-math__eq">=</span>
              <span className="fs-math__result" data-eq-result>
                {eq.result}
              </span>
            </p>

            <p className="fs-math__note">{eq.note}</p>
          </li>
        ))}
      </ol>

      <p className="fs-math__foot">
        Figures from one day on the live RAV4. Nothing is hidden behind a
        &ldquo;proprietary algorithm&rdquo;, because a number you cannot check is a number you
        cannot act on.{' '}
        <a className="fs-math__link" href="/documentation">
          See all seven, with worked numbers
        </a>
      </p>
    </div>
  );
}
