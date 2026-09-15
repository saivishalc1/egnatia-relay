// Gmail integration: OAuth, poll the Egnatia inbox, send approved messages.
// Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / APP_URL in .env. Tokens are stored in settings.
import { google } from 'googleapis';
import { db, uid, getSetting, setSetting } from './db.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.events'];

export const gmailConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const gmailConnected = () => gmailConfigured() && !!getSetting('google_tokens');

function oauth() {
  const redirect = `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`;
  const c = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirect);
  const t = getSetting('google_tokens');
  if (t) c.setCredentials(JSON.parse(t));
  c.on('tokens', (tok) => { const cur = JSON.parse(getSetting('google_tokens') || '{}'); setSetting('google_tokens', JSON.stringify({ ...cur, ...tok })); });
  return c;
}
export const authUrl = () => oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
export async function handleCallback(code) {
  const c = oauth(); const { tokens } = await c.getToken(code);
  setSetting('google_tokens', JSON.stringify(tokens));
  const gmail = google.gmail({ version: 'v1', auth: c });
  const prof = await gmail.users.getProfile({ userId: 'me' });
  setSetting('google_email', prof.data.emailAddress);
  return prof.data.emailAddress;
}
export function disconnect() { setSetting('google_tokens', ''); setSetting('google_email', ''); }

// Pull unread messages newer than the last poll into the inbox table (classification happens in routes).
export async function pollInbox({ max = 20 } = {}) {
  if (!gmailConnected()) return { pulled: 0, reason: 'not connected' };
  const gmail = google.gmail({ version: 'v1', auth: oauth() });
  const after = getSetting('gmail_last_poll_epoch') || Math.floor(Date.now() / 1000 - 7 * 86400);
  const list = await gmail.users.messages.list({ userId: 'me', maxResults: max, q: `in:inbox after:${after} -category:promotions` });
  let pulled = 0;
  for (const m of list.data.messages || []) {
    const exists = db.prepare('SELECT 1 FROM inbox WHERE external_id=?').get(m.id);
    if (exists) continue;
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const h = Object.fromEntries((full.data.payload.headers || []).map(x => [x.name.toLowerCase(), x.value]));
    const fromMatch = (h.from || '').match(/^(.*?)\s*<(.+?)>$/);
    db.prepare(`INSERT OR IGNORE INTO inbox(id,source,external_id,from_name,from_email,subject,body,received_at,status) VALUES(?,?,?,?,?,?,?,?,'new')`)
      .run(uid(), 'gmail', m.id, fromMatch ? fromMatch[1].replace(/"/g, '') : (h.from || ''), fromMatch ? fromMatch[2] : (h.from || ''), h.subject || '(no subject)', extractText(full.data.payload).slice(0, 8000), new Date(Number(full.data.internalDate)).toISOString());
    pulled++;
  }
  setSetting('gmail_last_poll_epoch', String(Math.floor(Date.now() / 1000) - 300));
  return { pulled };
}

export async function sendEmail({ to, subject, text, html }) {
  if (!gmailConnected()) throw new Error('Gmail not connected');
  const gmail = google.gmail({ version: 'v1', auth: oauth() });
  const from = getSetting('google_email');
  const boundary = 'b' + uid();
  const lines = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', text || '', '',
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', '', html || `<div style="font-family:sans-serif;white-space:pre-wrap">${(text || '').replace(/</g, '&lt;')}</div>`, '', `--${boundary}--`];
  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return res.data.id;
}

function extractText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  if (payload.parts) { for (const p of payload.parts) { const t = extractText(p); if (t) return t; } }
  if (payload.mimeType === 'text/html' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return '';
}
