/**
 * Inline SVG sparkline — no chart library for something this small.
 *
 * Colour is driven by the caller's `direction` (the day change) rather than by the
 * first-vs-last point of the series. Otherwise a row can read "+1.6%" beside a red line,
 * because the two describe different windows. The shape shows the path; the colour
 * agrees with the number next to it.
 */
export function Sparkline({ points, direction, width = 84, height = 26 }: {
  points: number[]; direction?: number | null; width?: number; height?: number;
}) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden>
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} className="stroke-ink-700" strokeWidth="1.5" />
      </svg>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const dx = width / (points.length - 1);
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * dx).toFixed(1)},${y(p).toFixed(1)}`).join(' ');

  const up = (direction ?? points[points.length - 1]! - points[0]!) >= 0;

  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <path d={d} fill="none" className={up ? 'stroke-up' : 'stroke-down'}
            strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
