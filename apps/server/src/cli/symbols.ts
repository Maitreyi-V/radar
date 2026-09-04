/**
 * CLI: import the BSE scrip master.
 *   npm run symbols          full active-equity master (~5,000) — makes search work
 *   npm run symbols -- --min curated universe only
 */
import { importAllSymbols, importSymbols } from '../ingestion/importSymbols.js';
import { db } from '../db/index.js';

const minimal = process.argv.includes('--min');

(minimal
  ? importSymbols().then(({ mapped, unmapped }) => {
      console.log(`mapped ${mapped}/${mapped + unmapped.length} curated symbols`);
      if (unmapped.length) console.log('unmapped:', unmapped.join(', '));
    })
  : importAllSymbols().then(({ total, tracked }) => {
      console.log(`imported ${total} active equities (${tracked} in the curated universe)`);
    })
).then(() => {
  const n = db.prepare(`SELECT COUNT(*) n FROM symbols`).get() as { n: number };
  console.log(`symbols table now holds ${n.n} rows — all searchable`);
}).catch((e) => { console.error(e); process.exit(1); });
