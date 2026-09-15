import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, auth } from './routes.js';
import { scoreAll } from './scoring.js';
import { runRules, draftPending } from './rules.js';
import { pollInbox, gmailConnected } from './gmail.js';
import { aiMode } from './ai.js';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Simple single-password auth (v1). Set APP_PASSWORD in .env; leave unset for local dev.
const PASSWORD = process.env.APP_PASSWORD;
app.post('/login', (req, res) => { if (!PASSWORD || req.body.password === PASSWORD) { res.cookie('relay', PASSWORD || 'dev', { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 }); return res.json({ ok: true }); } res.status(401).json({ error: 'Wrong password' }); });
app.post('/logout', (req, res) => { res.clearCookie('relay'); res.json({ ok: true }); });
const guard = (req, res, next) => { if (!PASSWORD || req.cookies.relay === PASSWORD) return next(); res.status(401).json({ error: 'auth' }); };
app.get('/api/auth-required', (req, res) => res.json({ required: !!PASSWORD, ok: !PASSWORD || req.cookies.relay === PASSWORD }));

app.use('/api', guard, api);
app.use('/auth', guard, auth);
app.use(express.static(path.join(__dirname, '../public')));

// Nightly jobs: poll inbox, rescore, run rules, draft. 6:00 America/New_York.
cron.schedule(process.env.RULES_CRON || '0 6 * * *', async () => {
  try {
    if (gmailConnected()) await pollInbox();
    scoreAll(); const r = runRules(); await draftPending(r.pending);
    console.log(`[cron] rules: ${r.created} new follow-ups`);
  } catch (e) { console.error('[cron]', e); }
}, { timezone: process.env.TZ || 'America/New_York' });

// Auto-seed on first run so the app is never empty.
if (db.prepare('SELECT COUNT(*) c FROM agents').get().c === 0 && process.env.AUTO_SEED !== 'false') {
  await import('../scripts/seed.js');
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Egnatia Relay on http://localhost:${port}  (AI: ${aiMode()}, Gmail: ${gmailConnected() ? 'connected' : 'not connected'})`));
