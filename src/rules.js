// Follow-up rule engine. Runs nightly (and on demand). Each rule creates at most one open follow-up
// per (rule, target) via dedupe_key, so re-running is safe.
import { db, uid, now, daysSince, getSetting, getSettingJSON } from './db.js';
import { draftFollowup } from './ai.js';

const get = (t, id) => id ? db.prepare(`SELECT * FROM ${t} WHERE id=?`).get(id) : null;

export function runRules() {
  const cadence = getSettingJSON('cadence_days') || { Core: 14, Growth: 30, New: 30, Dormant: 90 };
  const estDays = Number(getSetting('estimate_checkin_days')) || 7;
  const memoHours = Number(getSetting('memo_due_hours')) || 24;
  const stalledDays = Number(getSetting('stalled_days')) || 10;
  const proposals = [];

  // R1. Agent going cold (per tier cadence)
  for (const a of db.prepare('SELECT * FROM agents').all()) {
    const limit = cadence[a.tier] ?? 30;
    const since = daysSince(a.last_touch_at);
    if (since >= limit) {
      const over = Math.floor(since - limit);
      proposals.push({ rule: 'agent_cold', agent_id: a.id, channel: a.channel, to_email: a.email,
        severity: over >= 14 ? 'crit' : 'warn',
        why: `${a.name} (${a.tier}) last heard from Egnatia ${Math.floor(since)} days ago. Rule: ${a.tier} agents get a meaningful touch every ${limit} days.${a.notes ? ' Note: ' + a.notes : ''}`,
        due_at: now(), dedupe_key: `agent_cold:${a.id}:${weekKey()}` });
    }
  }

  const opps = db.prepare("SELECT * FROM opportunities WHERE stage NOT IN ('lost')").all();
  for (const o of opps) {
    const agent = get('agents', o.agent_id), contact = get('contacts', o.contact_id);
    const tag = `${o.address}`;
    // R2. Estimate check-in at day N
    if (o.stage === 'estimate_sent' && o.estimate_sent_at && daysSince(o.estimate_sent_at) >= estDays) {
      const d = Math.floor(daysSince(o.estimate_sent_at));
      proposals.push({ rule: 'estimate_checkin', agent_id: o.agent_id, opportunity_id: o.id, contact_id: o.contact_id, channel: agent?.channel || 'email', to_email: agent?.email || contact?.email,
        severity: d >= estDays * 2 ? 'crit' : 'warn',
        why: `Estimate for ${tag} sent ${d} days ago with no stage change. Rule: check in at day ${estDays}.${o.buyer_signals ? ' Buyer signals: ' + o.buyer_signals + '.' : ''}`,
        due_at: now(), dedupe_key: `estimate_checkin:${o.id}:${Math.floor(d / estDays)}` });
    }
    // R3. Walkthrough prep (requested, with a timeline mentioning tomorrow/today or within 2 days)
    if (o.stage === 'requested' && /tomorrow|today|tue|wed|thu|fri|mon|sat|sun/i.test(o.timeline || '') && o.est_value >= 100000) {
      proposals.push({ rule: 'walkthrough_prep', agent_id: o.agent_id, opportunity_id: o.id, contact_id: o.contact_id, channel: agent?.channel || 'email', to_email: agent?.email,
        severity: 'warn', why: `Walkthrough coming up at ${tag} (${o.timeline}). Confirm, ask what the buyer cares most about, and set the 24-hour memo expectation.${agent?.tier === 'New' ? ' First walkthrough with ' + agent.name + ' — a new relationship.' : ''}`,
        due_at: now(), dedupe_key: `walkthrough_prep:${o.id}` });
    }
    // R4. Memo due (walked, no memo within N hours)
    if (o.stage === 'walked' && o.walked_at && !o.memo_sent_at && daysSince(o.walked_at) * 24 >= memoHours * 0.5) {
      const h = Math.floor(daysSince(o.walked_at) * 24);
      proposals.push({ rule: 'memo_due', agent_id: o.agent_id, opportunity_id: o.id, contact_id: o.contact_id, channel: 'email', to_email: agent?.email,
        severity: h >= memoHours ? 'crit' : 'neutral', why: `${tag} was walked ${h} hours ago and no memo has gone out. Rule: memo to agent and buyer within ${memoHours} hours. Generate it from the walkthrough notes, review, send.`,
        due_at: now(), dedupe_key: `memo_due:${o.id}` });
    }
    // R5. Won-project touch (4–10 weeks in: progress photos + ask for next intro)
    if (o.stage === 'won' && o.won_at) {
      const w = daysSince(o.won_at) / 7;
      if (w >= 4 && w <= 10 && agent) {
        proposals.push({ rule: 'won_touch', agent_id: o.agent_id, opportunity_id: o.id, channel: agent.channel, to_email: agent.email,
          severity: 'neutral', why: `${tag} is ${Math.floor(w)} weeks in. Best moment to show ${agent.name} progress and ask for the next introduction.`,
          due_at: now(), dedupe_key: `won_touch:${o.id}` });
      }
    }
    // R6. Stalled (no stage change for N days, not won)
    if (!['won', 'requested'].includes(o.stage) && daysSince(o.stage_changed_at) >= stalledDays && o.stage !== 'estimate_sent') {
      const d = Math.floor(daysSince(o.stage_changed_at));
      proposals.push({ rule: 'stalled', agent_id: o.agent_id, opportunity_id: o.id, contact_id: o.contact_id, channel: agent?.channel || 'email', to_email: agent?.email,
        severity: d >= stalledDays * 2 ? 'crit' : 'warn', why: `${tag} has sat in “${o.stage.replace('_', ' ')}” for ${d} days.${o.buyer_signals ? ' Buyer signals: ' + o.buyer_signals + '.' : ''}`,
        due_at: now(), dedupe_key: `stalled:${o.id}:${Math.floor(d / stalledDays)}` });
    }
  }

  const ins = db.prepare(`INSERT OR IGNORE INTO followups(id,rule,agent_id,opportunity_id,contact_id,severity,why,channel,to_email,subject,draft,status,due_at,dedupe_key)
    VALUES(@id,@rule,@agent_id,@opportunity_id,@contact_id,@severity,@why,@channel,@to_email,@subject,@draft,'open',@due_at,@dedupe_key)`);
  let created = 0;
  const pending = [];
  for (const p of proposals) {
    const id = uid();
    const r = ins.run({ agent_id: null, opportunity_id: null, contact_id: null, to_email: null, subject: null, draft: null, ...p, id });
    if (r.changes) { created++; pending.push(id); }
  }
  db.prepare('INSERT INTO runs(id,kind,summary) VALUES(?,?,?)').run(uid(), 'rules', `${proposals.length} checks, ${created} new follow-ups`);
  // Draft asynchronously (mock is sync-fast; Claude takes a few seconds each)
  draftPending(pending).catch(e => console.error('draft error', e));
  return { checked: proposals.length, created, pending };
}

export async function draftPending(ids) {
  const rows = ids?.length ? ids.map(id => get('followups', id)) : db.prepare("SELECT * FROM followups WHERE status='open' AND draft IS NULL").all();
  for (const f of rows) {
    if (!f) continue;
    const ctx = { rule: f.rule, why: f.why, channel: f.channel, agent: get('agents', f.agent_id), opportunity: get('opportunities', f.opportunity_id), contact: get('contacts', f.contact_id) };
    const draft = await draftFollowup(ctx);
    const subject = subjectFor(f, ctx);
    db.prepare('UPDATE followups SET draft=?, subject=? WHERE id=?').run(draft, subject, f.id);
  }
}

function subjectFor(f, { opportunity, agent }) {
  const addr = opportunity?.address;
  return { agent_cold: `Walkthroughs this fall`, estimate_checkin: `${addr} — estimate`, walkthrough_prep: `${addr} — ${opportunity?.timeline || 'walkthrough'}`, memo_due: `${addr} — walkthrough memo`, won_touch: `${addr} — progress`, stalled: `${addr}` }[f.rule] || 'Egnatia';
}

function weekKey() { const d = new Date(); const onejan = new Date(d.getFullYear(), 0, 1); return d.getFullYear() + '-w' + Math.ceil(((d - onejan) / 864e5 + onejan.getDay() + 1) / 7); }
