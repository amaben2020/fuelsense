'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

/**
 * Registers GSAP's ScrollTrigger once and returns a scope ref.
 *
 * Every animation is written inside a gsap.context() bound to that ref, so
 * React's strict-mode double-invoke and route changes clean up after
 * themselves instead of stacking duplicate triggers on the same elements.
 *
 * Motion is opt-out: with prefers-reduced-motion the callback never runs and
 * elements keep their natural, already-visible styles. That means no animated
 * element may start hidden in CSS — the reveal classes set their start state
 * from JS only.
 */
export function useGsapScope(setup: (ctx: { scope: HTMLElement }) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const setupRef = useRef(setup);

  // Effects run in declaration order, so the latest callback is in place
  // before the mount effect below reads it.
  useEffect(() => {
    setupRef.current = setup;
  });

  useEffect(() => {
    const scope = ref.current;
    if (!scope) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => setupRef.current({ scope }), scope);
    return () => ctx.revert();
  }, []);

  return ref;
}

/** Fades and lifts elements into place as they enter the viewport. */
export function revealOnScroll(targets: string, scope: HTMLElement, stagger = 0.08) {
  const elements = gsap.utils.toArray<HTMLElement>(targets, scope);

  elements.forEach((el) => {
    gsap.from(el, {
      opacity: 0,
      y: 28,
      duration: 0.85,
      ease: 'power3.out',
      stagger,
      scrollTrigger: {
        trigger: el,
        start: 'top 88%',
        once: true,
      },
    });
  });
}

/** Counts a number up when it scrolls into view. */
export function countUp(
  el: HTMLElement,
  to: number,
  format: (value: number) => string,
  duration = 1.4
) {
  const state = { value: 0 };

  gsap.to(state, {
    value: to,
    duration,
    ease: 'power2.out',
    scrollTrigger: { trigger: el, start: 'top 85%', once: true },
    onUpdate: () => {
      el.textContent = format(state.value);
    },
  });
}
