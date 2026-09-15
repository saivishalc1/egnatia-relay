import 'dotenv/config';
import { scoreAll } from '../src/scoring.js';
import { runRules, draftPending } from '../src/rules.js';
scoreAll();
const r = runRules();
await draftPending();
console.log(r);
