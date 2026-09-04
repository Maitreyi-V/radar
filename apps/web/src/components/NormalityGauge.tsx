/**
 * "How big is this move, for THIS stock?" — as a picture rather than a number.
 *
 * A shaded band shows the stock's ordinary daily range; a marker shows today. If the
 * marker sits inside the band, today was normal. If it crosses the dashed line, it was
 * unusual enough to surface. That reading requires no statistics — which is the point,
 * because "1.31σ" communicates nothing to someone who just wants to know if their stock
 * did something worth looking at.
 */
export function NormalityGauge({ z, sensitivity = 1.5, width = 96, height = 22 }: {
  z: number | null; sensitivity?: number; width?: number; height?: number;
}) {
  if (z === null) {
    return <div className="text-[11px] text-slate-600" style={{ width }}>—</div>;
  }

  // Show +/- 2.5x usual; anything beyond is pinned to the edge.
  const MAX = 2.5;
  const mid = width / 2;
  const clamped = Math.max(-MAX, Math.min(MAX, z));
  const x = mid + (clamped / MAX) * mid;

  const bandHalf = (1 / MAX) * mid;           // +/- 1 usual day
  const lineOffset = (sensitivity / MAX) * mid; // the surfacing threshold
  const crossed = Math.abs(z) >= sensitivity;
  const cy = height / 2;

  return (
    <svg width={width} height={height} aria-label={`${Math.abs(z).toFixed(1)} times its usual daily move`}>
      {/* the stock's ordinary range */}
      <rect x={mid - bandHalf} y={cy - 5} width={bandHalf * 2} height={10} rx={5} className="fill-ink-700" />
      {/* baseline */}
      <line x1={2} y1={cy} x2={width - 2} y2={cy} className="stroke-ink-700" strokeWidth={1} />
      {/* thresholds */}
      {[mid - lineOffset, mid + lineOffset].map((lx, i) => (
        <line key={i} x1={lx} y1={cy - 8} x2={lx} y2={cy + 8}
              className="stroke-slate-600" strokeWidth={1} strokeDasharray="2 2" />
      ))}
      {/* today */}
      <circle cx={x} cy={cy} r={4}
              className={crossed ? 'fill-accent' : z >= 0 ? 'fill-up' : 'fill-down'} />
    </svg>
  );
}
