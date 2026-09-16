import { db } from '../db/index.js';
import { rebuildProjections } from '../ingestion/projections.js';

const started = performance.now();
const quotes = rebuildProjections();
console.log(`Rebuilt shared events and session summaries from ${quotes} quotes in ${Math.round(performance.now() - started)} ms.`);
db.close();
