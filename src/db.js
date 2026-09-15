import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DB_PATH = process.env.DB_PATH || path.resolve('data/relay.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  firm TEXT,
  email TEXT,
  phone TEXT,
  area TEXT,
  tier TEXT NOT NULL DEFAULT 'New',      -- Core | Growth | New | Dormant
  channel TEXT NOT NULL DEFAULT 'email', -- email | text
  notes TEXT,
  last_touch_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'buyer',    -- buyer | owner | architect | other
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  neighborhood TEXT,
  property_type TEXT,                    -- Brownstone | Townhouse | Co-op | Condo | Loft
  scope TEXT,
  agent_id TEXT REFERENCES agents(id),
  contact_id TEXT REFERENCES contacts(id),
  stage TEXT NOT NULL DEFAULT 'requested', -- requested | walked | estimate_sent | negotiating | won | lost
  est_value INTEGER,
  timeline TEXT,
  buyer_signals TEXT,                    -- free text: budget confirmed, cash, closing date...
  constraints_json TEXT,                 -- JSON array: ["co-op","LPC","Alt-1"]
  score INTEGER,
  score_reasons_json TEXT,
  stage_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  walked_at TEXT,
  estimate_sent_at TEXT,
  memo_sent_at TEXT,
  won_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  contact_id TEXT REFERENCES contacts(id),
  opportunity_id TEXT REFERENCES opportunities(id),
  kind TEXT NOT NULL,                    -- email | text | call | walkthrough | memo | estimate | note | system
  direction TEXT,                        -- in | out | internal
  summary TEXT NOT NULL,
  body TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,                    -- agent_cold | estimate_checkin | walkthrough_prep | memo_due | won_touch | stalled
  agent_id TEXT REFERENCES agents(id),
  opportunity_id TEXT REFERENCES opportunities(id),
  contact_id TEXT REFERENCES contacts(id),
  severity TEXT NOT NULL DEFAULT 'warn', -- crit | warn | neutral
  why TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  to_email TEXT,
  subject TEXT,
  draft TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open | sent | snoozed | dismissed
  due_at TEXT NOT NULL,
  snoozed_until TEXT,
  sent_at TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memos (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT REFERENCES opportunities(id),
  notes_text TEXT,
  photos_json TEXT,
  memo_json TEXT,
  memo_html TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | sent
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'manual', -- gmail | manual
  external_id TEXT UNIQUE,
  from_name TEXT, from_email TEXT,
  subject TEXT, body TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  classification_json TEXT,
  actions_json TEXT,
  agent_id TEXT, opportunity_id TEXT, contact_id TEXT,
  status TEXT NOT NULL DEFAULT 'new'     -- new | filed | needs_review
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  summary TEXT,
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const uid = () => randomUUID().slice(0, 8);
export const now = () => new Date().toISOString();
export const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
export const daysFromNow = (n) => new Date(Date.now() + n * 864e5).toISOString();
export const daysSince = (iso) => iso ? (Date.now() - new Date(iso).getTime()) / 864e5 : Infinity;

const DEFAULT_SETTINGS = {
  cadence_days: JSON.stringify({ Core: 14, Growth: 30, New: 30, Dormant: 90 }),
  estimate_checkin_days: '7',
  memo_due_hours: '24',
  stalled_days: '10',
  min_project_value: '150000',
  score_weights: JSON.stringify({ scope: 30, agent: 25, buyer: 20, timing: 15, constraints: 10 }),
  owner_name: 'Elona',
  company: 'Egnatia Construction',
  company_email: 'info@egnatiaconstruction.com',
  voice_profile: `Elona writes short, direct, warm messages. No fluff, no "hope this finds you well". She leads with the specific thing (the property, the buyer, the number), offers something useful (a walkthrough, a scope letter, a number), and ends with one easy ask. Signature phrases: "reduce uncertainty", "before they inherit the renovation", "no cost, no pressure". She signs "Elona" and, on first contact, "Elona from Egnatia".`,
  memo_disclaimer: `Ranges reflect Egnatia's recent Brooklyn and Manhattan projects and a visual walkthrough only — no invasive inspection. We're not here to influence the transaction; we're here to reduce uncertainty.`,
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}
export function getSettingJSON(key) { try { return JSON.parse(getSetting(key)); } catch { return null; } }
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
export function allSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key,value FROM settings').all()) out[r.key] = r.value;
  return out;
}

export function logActivity(a) {
  const id = uid();
  db.prepare(`INSERT INTO activities(id,agent_id,contact_id,opportunity_id,kind,direction,summary,body,occurred_at)
              VALUES(@id,@agent_id,@contact_id,@opportunity_id,@kind,@direction,@summary,@body,@occurred_at)`)
    .run({ agent_id: null, contact_id: null, opportunity_id: null, direction: 'internal', body: null, occurred_at: now(), ...a, id });
  if (a.agent_id && a.kind !== 'system' && a.direction !== 'in') {
    db.prepare('UPDATE agents SET last_touch_at=? WHERE id=? AND (last_touch_at IS NULL OR last_touch_at<?)').run(a.occurred_at || now(), a.agent_id, a.occurred_at || now());
  }
  return id;
}
