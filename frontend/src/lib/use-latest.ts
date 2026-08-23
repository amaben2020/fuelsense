'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * A ref that always holds the most recent render's value.
 *
 * The point is long-lived callbacks: a polling interval or a fetch handler
 * registered once needs the *current* period, view or filter without being
 * torn down and re-subscribed every time one of them changes.
 *
 * The value is written after commit rather than during render. Assigning
 * `ref.current` while rendering is what `react-hooks/refs` flags, and the
 * reason is real — under concurrent rendering React may render a component
 * whose result it then throws away, so a render-time write can publish a value
 * that was never committed. Writing in an effect means the ref only ever
 * carries state the user actually saw.
 *
 * Only safe for values read asynchronously. Anything needed *during* render
 * should be read from state or props directly, where React can track it.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
