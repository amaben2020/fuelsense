/**
 * Orbit Node — the FuelSense mark used everywhere: rail, favicon, loading
 * screen, marketing header/footer, auth pages. A tracked asset (the solid
 * centre) with a satellite pass around it. The one filled shape against an
 * otherwise all-stroke mark is the "live" accent — everything else here is
 * geometry, this alone is a signal.
 *
 * Single source of truth so the mark can't drift between call sites again —
 * it previously existed as five separate copies of the same path data.
 */
export function BrandMark({
  className = '',
  strokeWidth = 5,
  ariaLabel,
}: {
  className?: string;
  strokeWidth?: number;
  /** Pass when the mark stands alone with no adjacent wordmark text; omit to
   *  mark it decorative (aria-hidden) when a visible "FuelSense" follows it. */
  ariaLabel?: string;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      {...(ariaLabel ? { role: 'img', 'aria-label': ariaLabel } : { 'aria-hidden': true })}
    >
      <ellipse
        cx="32"
        cy="32"
        rx="22"
        ry="10"
        transform="rotate(-24 32 32)"
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
      <circle cx="32" cy="32" r="6" fill="currentColor" stroke="none" />
      <circle cx="49" cy="18" r="4" fill="currentColor" stroke="none" />
    </svg>
  );
}
