'use client';

import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// A rail down the left edge showing where you are in the argument.
//
// The page makes a case in order: the problem, then the mechanism, then the
// evidence, then the cost. A reader who has scrolled into the middle of that
// has no way of knowing how much is left, so the rail fills as they go and
// names the section they are in. Clicking a stop jumps to it.

const SECTIONS = [
  { id: 'top', num: '01', label: 'Overview' },
  { id: 'problem', num: '02', label: 'The problem' },
  { id: 'how', num: '03', label: 'How it works' },
  { id: 'live', num: '04', label: 'Live monitoring' },
  { id: 'receipts', num: '05', label: 'Reconciliation' },
  { id: 'dashboard', num: '06', label: 'Dashboard' },
];

export function ScrollTimeline() {
  const [active, setActive] = useState(0);
  const fill = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      // One trigger drives the fill, so it tracks the document rather than
      // jumping between per-section triggers.
      if (fill.current) {
        gsap.fromTo(
          fill.current,
          { scaleY: 0 },
          {
            scaleY: 1,
            ease: 'none',
            scrollTrigger: {
              trigger: document.documentElement,
              start: 'top top',
              end: 'bottom bottom',
              scrub: 0.4,
            },
          }
        );
      }

      SECTIONS.forEach((section, index) => {
        const element =
          section.id === 'top' ? document.body : document.getElementById(section.id);
        if (!element) return;

        ScrollTrigger.create({
          trigger: element,
          start: section.id === 'top' ? 'top top' : 'top 45%',
          end: 'bottom 45%',
          onEnter: () => setActive(index),
          onEnterBack: () => setActive(index),
        });
      });
    });

    return () => ctx.revert();
  }, []);

  return (
    <nav className="fs-rail" aria-label="Page sections">
      <span className="fs-rail__track" aria-hidden>
        <span className="fs-rail__fill" ref={fill} />
      </span>

      <ol className="fs-rail__list">
        {SECTIONS.map((section, index) => (
          <li key={section.id}>
            <a
              href={section.id === 'top' ? '#' : `#${section.id}`}
              className={`fs-rail__stop${index === active ? ' fs-rail__stop--active' : ''}${
                index < active ? ' fs-rail__stop--done' : ''
              }`}
              aria-current={index === active ? 'true' : undefined}
            >
              <span className="fs-rail__dot" aria-hidden />
              <span className="fs-rail__num">{section.num}</span>
              <span className="fs-rail__label">{section.label}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
