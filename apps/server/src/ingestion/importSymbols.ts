/**
 * Import the BSE scrip master and attach a BSE scripcode to every symbol we track.
 *
 * One request returns ~5,000 active equities, which is also the honest answer to
 * "how would you load the full NSE universe?" — the mapping is bulk data, not
 * per-symbol lookups.
 */
import { httpGet } from './http.js';
import { db } from '../db/index.js';
import { UNIVERSE } from './universe.js';

const MASTER_URL =
  'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  Referer: 'https://www.bseindia.com/',
};

/**
 * Corporate actions the scrip_id match cannot resolve on its own.
 * Documented rather than silently patched, because each one is a real event:
 *  - Tata Motors demerged; the NSE 'TATAMOTORS' line maps to BSE 'TMCV'.
 *  - Zomato renamed itself Eternal Ltd.
 */
const OVERRIDES: Record<string, string> = {
  'TATAMOTORS.NS': '544569', // TMCV — Tata Motors Ltd (post-demerger)
  'ZOMATO.NS': '543320',     // ETERNAL — Eternal Ltd (formerly Zomato)
};

interface MasterRow { SCRIP_CD: string; Scrip_Name: string; scrip_id: string; Mktcap: string }

export async function importSymbols(): Promise<{ mapped: number; unmapped: string[] }> {
  const res = await httpGet(MASTER_URL, { headers: HEADERS, timeoutMs: 30_000, insecureParser: true });
  if (res.status !== 200) throw new Error(`scrip master HTTP ${res.status}`);
  const rows = JSON.parse(res.body) as MasterRow[];

  const byId = new Map<string, MasterRow>();
  const byCode = new Map<string, MasterRow>();
  for (const r of rows) {
    if (r.scrip_id) byId.set(String(r.scrip_id).toUpperCase(), r);
    if (r.SCRIP_CD) byCode.set(String(r.SCRIP_CD), r);
  }

  const upsert = db.prepare(`
    INSERT INTO symbols (symbol, name, exchange, bse_code, mktcap)
    VALUES (@symbol, @name, 'NSE', @bseCode, @mktcap)
    ON CONFLICT (symbol) DO UPDATE SET
      name = excluded.name, bse_code = excluded.bse_code, mktcap = excluded.mktcap
  `);

  const unmapped: string[] = [];
  let mapped = 0;

  const run = db.transaction(() => {
    for (const s of UNIVERSE) {
      const ticker = s.symbol.replace(/\.(NS|BO)$/, '').toUpperCase();
      const override = OVERRIDES[s.symbol];
      const row = override ? byCode.get(override) : byId.get(ticker);
      if (row) mapped++; else unmapped.push(s.symbol);
      upsert.run({
        symbol: s.symbol,
        name: row?.Scrip_Name ?? s.name,
        bseCode: row?.SCRIP_CD ?? null,
        mktcap: row?.Mktcap ? Number(row.Mktcap) : null,
      });
    }
  });
  run();

  return { mapped, unmapped };
}
