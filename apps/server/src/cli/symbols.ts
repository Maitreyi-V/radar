/** CLI: import the BSE scrip master and map our universe to scripcodes. */
import { importSymbols } from '../ingestion/importSymbols.js';
import { db } from '../db/index.js';

importSymbols()
  .then(({ mapped, unmapped }) => {
    console.log(`mapped ${mapped}/${mapped + unmapped.length} symbols to BSE scripcodes`);
    if (unmapped.length) console.log('unmapped:', unmapped.join(', '));
    console.table(
      db.prepare(
        `SELECT symbol, bse_code AS bse, ROUND(mktcap) AS mktcap_cr
         FROM symbols WHERE bse_code IS NOT NULL ORDER BY mktcap DESC LIMIT 6`,
      ).all(),
    );
  })
  .catch((e) => { console.error(e); process.exit(1); });
