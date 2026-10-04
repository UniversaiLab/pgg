/**
 * A ring that drains over `ms` milliseconds, drawn entirely by a CSS animation (no JavaScript per
 * frame). Change `cycle` to restart it.
 */
export function TimerRing({ size = 64, ms, cycle }) {
  const stroke = 3.5;
  const r = size / 2 - stroke;
  const length = 2 * Math.PI * r;
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        className="ring-track"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
      />
      <circle
        key={cycle}
        className="ring-fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeDasharray={length}
        style={{ '--ring-ms': `${Math.max(ms, 50)}ms`, '--ring-len': length }}
      />
    </svg>
  );
}
