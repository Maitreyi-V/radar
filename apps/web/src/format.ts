/** Display helpers. Indian number formatting, because the prices are in rupees. */
export const inr = (n: number): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const compact = (n: number | null): string => {
  if (n === null) return '—';
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
};

export const pct = (n: number | null): string => (n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);

/** "12s ago" / "4m ago" — the honest data-age label. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const shortSymbol = (s: string): string => s.replace(/\.(NS|BO)$/, '');

export const istTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
