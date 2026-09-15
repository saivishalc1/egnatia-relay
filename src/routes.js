import { Router } from 'express';
import { db, uid, now, daysSince, allSettings, setSetting, getSetting, logActivity } from './db.js';
import { scoreAll, scoreOpportunity, agentStats } from './scoring.js';
import { runRules, draftPending } from './rules.js';
import { aiMode, draftFollowup, generateMemo, memoToHtml, classifyInbox, mondayBrief } from './ai.js';
import { gmailConfigured, gmailConnected, authUrl, handleCallback, disconnect, pollInbox, sendEmail } from './gmail.js';

export const api = Router();
const get = (t, id) => id ? db.prepare(`SELECT * FROM ${t} WHERE id=?`).get(id) : null;
const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

/* ---- status ---- */
api.get('/status', (req, res) => res.json({ ai: aiMode(), gmail: { configured: gmailConfigured(), connected: gmailConnected(), email: getSetting('google_email') || null }, last_run: db.prepare("SELECT * FROM runs ORDER BY ran_at DESC LIMIT 1").get() }));

/* ---- dashboard ---- */
api.get('/dashboard', wrap(async (req, res) => {
  const agents = db.prepare('SELECT * FROM agents').all();
  const opps = db.prepare("SELECT * FROM opportunities").all().map(hydrateOpp);
  const open = db.prepare("SELECT * FROM followups WHERE status='open' ORDER BY CASE severity WHEN 'crit' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, due_at").all().map(hydrateFollowup);
  const cadence = parse(getSetting('cadence_days'), {});
  const withHealth = agents.map(a => ({ ...a, ...agentStats(a.id), days_since_touch: Math.floor(daysSince(a.last_touch_at)), health: health(a, cadence), pipeline: opps.filter(o => o.agent_id === a.id && !['won', 'lost'].includes(o.stage)).reduce((s, o) => s + (o.est_value || 0), 0) }));
  const active = opps.filter(o => !['won', 'lost'].includes(o.stage));
  const minVal = Number(getSetting('min_project_value')) || 150000;
  const qualified = active.filter(o => o.est_value >= minVal && o.score >= 50);
  const pipeline = active.reduce((s, o) => s + (o.est_value || 0), 0);
  const weighted = active.reduce((s, o) => s + (o.est_value || 0) * (o.score || 0) / 100, 0);
  const priority = [...active].sort((a, b) => (b.score * b.est_value) - (a.score * a.est_value)).slice(0, 5);
  const inbox = db.prepare('SELECT * FROM inbox ORDER BY received_at DESC LIMIT 6').all().map(i => ({ ...i, actions: parse(i.actions_json, []) }));
  const sent7 = db.prepare("SELECT COUNT(*) c FROM followups WHERE status='sent' AND sent_at >= datetime('now','-7 days')").get().c;
  const filed7 = db.prepare("SELECT COUNT(*) c FROM inbox WHERE status='filed' AND received_at >= datetime('now','-7 days')").get().c;
  const memos7 = db.prepare("SELECT COUNT(*) c FROM memos WHERE created_at >= datetime('now','-7 days')").get().c;
  const snapshot = { followups: open.length, overdue: open.filter(f => f.severity === 'crit').length, pipeline: money(pipeline), weighted: money(weighted), opps: active.length, qualified: qualified.length, cold: withHealth.filter(a => a.health === 'crit').length, top: priority[0] ? `${priority[0].address} (${money(priority[0].est_value)}, via ${priority[0].agent?.name})` : 'none' };
  const brief = await mondayBrief(snapshot);
  res.json({ snapshot, brief, priority, followups: open, agents: withHealth.sort((a, b) => b.pipeline - a.pipeline), inbox, hours_saved: +(sent7 * 0.25 + filed7 * 0.1 + memos7 * 2).toFixed(1), funnel: funnel(opps, withHealth) });
}));

function funnel(opps, agents) {
  const walked = opps.filter(o => o.walked_at).length, memos = opps.filter(o => o.memo_sent_at).length, est = opps.filter(o => o.estimate_sent_at).length, won = opps.filter(o => o.stage === 'won').length;
  return { referrals: opps.length, walked, memos, estimates: est, won, by_agent: agents.map(a => ({ id: a.id, name: a.name, firm: a.firm, tier: a.tier, referrals: a.referrals, walked: a.walked, won: a.won, pipeline: a.pipeline, health: a.health, days_since_touch: a.days_since_touch })) };
}
function health(a, cadence) { const lim = cadence[a.tier] ?? 30; const d = daysSince(a.last_touch_at); return d >= lim + 14 ? 'crit' : d >= lim ? 'warn' : 'good'; }
function money(n) { return n >= 1e6 ? '$' + (n / 1e6).toFixed(2).replace(/0$/, '') + 'M' : '$' + Math.round(n / 1000) + 'K'; }
function hydrateOpp(o) { return { ...o, constraints: parse(o.constraints_json, []), score_reasons: parse(o.score_reasons_json, { reasons: [], negs: [] }), days_in_stage: Math.floor(daysSince(o.stage_changed_at)), agent: get('agents', o.agent_id), contact: get('contacts', o.contact_id) }; }
function hydrateFollowup(f) { return { ...f, agent: get('agents', f.agent_id), opportunity: get('opportunities', f.opportunity_id), contact: get('contacts', f.contact_id) }; }

/* ---- agents ---- */
api.get('/agents', (req, res) => { const cadence = parse(getSetting('cadence_days'), {}); res.json(db.prepare('SELECT * FROM agents ORDER BY name').all().map(a => ({ ...a, ...agentStats(a.id), days_since_touch: Math.floor(daysSince(a.last_touch_at)), health: health(a, cadence), cadence_days: cadence[a.tier] ?? 30 }))); });
api.get('/agents/:id', (req, res) => { const a = get('agents', req.params.id); if (!a) return res.status(404).end(); res.json({ ...a, ...agentStats(a.id), opportunities: db.prepare('SELECT * FROM opportunities WHERE agent_id=? ORDER BY created_at DESC').all(a.id).map(hydrateOpp), activities: db.prepare('SELECT * FROM activities WHERE agent_id=? ORDER BY occurred_at DESC LIMIT 30').all(a.id), followups: db.prepare("SELECT * FROM followups WHERE agent_id=? AND status='open'").all(a.id) }); });
api.post('/agents', (req, res) => { const id = uid(); const b = req.body; db.prepare('INSERT INTO agents(id,name,firm,email,phone,area,tier,channel,notes,last_touch_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, b.name, b.firm || null, b.email || null, b.phone || null, b.area || null, b.tier || 'New', b.channel || 'email', b.notes || null, b.last_touch_at || now()); res.json(get('agents', id)); });
api.patch('/agents/:id', (req, res) => { const a = get('agents', req.params.id); if (!a) return res.status(404).end(); const b = { ...a, ...req.body }; db.prepare('UPDATE agents SET name=?,firm=?,email=?,phone=?,area=?,tier=?,channel=?,notes=? WHERE id=?').run(b.name, b.firm, b.email, b.phone, b.area, b.tier, b.channel, b.notes, a.id); res.json(get('agents', a.id)); });
api.post('/agents/:id/touch', (req, res) => { const a = get('agents', req.params.id); if (!a) return res.status(404).end(); logActivity({ agent_id: a.id, kind: req.body.kind || 'note', direction: 'out', summary: req.body.summary || 'Touch logged', body: req.body.body || null }); res.json(get('agents', a.id)); });

/* ---- contacts ---- */
api.get('/contacts', (req, res) => res.json(db.prepare('SELECT * FROM contacts ORDER BY name').all()));
api.post('/contacts', (req, res) => { const id = uid(); const b = req.body; db.prepare('INSERT INTO contacts(id,name,email,phone,role,notes) VALUES(?,?,?,?,?,?)').run(id, b.name, b.email || null, b.phone || null, b.role || 'buyer', b.notes || null); res.json(get('contacts', id)); });

/* ---- opportunities ---- */
api.get('/opportunities', (req, res) => res.json(db.prepare('SELECT * FROM opportunities ORDER BY created_at DESC').all().map(hydrateOpp)));
api.get('/opportunities/:id', (req, res) => { const o = get('opportunities', req.params.id); if (!o) return res.status(404).end(); res.json({ ...hydrateOpp(o), activities: db.prepare('SELECT * FROM activities WHERE opportunity_id=? ORDER BY occurred_at DESC').all(o.id), memos: db.prepare('SELECT id,status,created_at,sent_at FROM memos WHERE opportunity_id=? ORDER BY created_at DESC').all(o.id), followups: db.prepare("SELECT * FROM followups WHERE opportunity_id=? AND status='open'").all(o.id) }); });
api.post('/opportunities', (req, res) => { const id = uid(); const b = req.body; db.prepare('INSERT INTO opportunities(id,address,neighborhood,property_type,scope,agent_id,contact_id,stage,est_value,timeline,buyer_signals,constraints_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, b.address, b.neighborhood || null, b.property_type || null, b.scope || null, b.agent_id || null, b.contact_id || null, b.stage || 'requested', b.est_value || null, b.timeline || null, b.buyer_signals || null, JSON.stringify(b.constraints || [])); if (b.agent_id) logActivity({ agent_id: b.agent_id, opportunity_id: id, kind: 'system', summary: `Opportunity created: ${b.address}` }); scoreAll(); res.json(hydrateOpp(get('opportunities', id))); });
api.patch('/opportunities/:id', (req, res) => {
  const o = get('opportunities', req.params.id); if (!o) return res.status(404).end();
  const b = { ...o, ...req.body }; if (req.body.constraints) b.constraints_json = JSON.stringify(req.body.constraints);
  if (req.body.stage && req.body.stage !== o.stage) { b.stage_changed_at = now(); if (req.body.stage === 'walked' && !o.walked_at) b.walked_at = now(); if (req.body.stage === 'estimate_sent' && !o.estimate_sent_at) b.estimate_sent_at = now(); if (req.body.stage === 'won') b.won_at = now(); logActivity({ agent_id: o.agent_id, opportunity_id: o.id, kind: 'system', summary: `Stage → ${req.body.stage.replace('_', ' ')}` }); }
  db.prepare('UPDATE opportunities SET address=?,neighborhood=?,property_type=?,scope=?,agent_id=?,contact_id=?,stage=?,est_value=?,timeline=?,buyer_signals=?,constraints_json=?,stage_changed_at=?,walked_at=?,estimate_sent_at=?,memo_sent_at=?,won_at=? WHERE id=?')
    .run(b.address, b.neighborhood, b.property_type, b.scope, b.agent_id, b.contact_id, b.stage, b.est_value, b.timeline, b.buyer_signals, b.constraints_json, b.stage_changed_at, b.walked_at, b.estimate_sent_at, b.memo_sent_at, b.won_at, o.id);
  scoreAll(); res.json(hydrateOpp(get('opportunities', o.id)));
});
api.post('/opportunities/:id/log', (req, res) => { const o = get('opportunities', req.params.id); if (!o) return res.status(404).end(); logActivity({ agent_id: o.agent_id, opportunity_id: o.id, contact_id: o.contact_id, kind: req.body.kind || 'note', direction: req.body.direction || 'internal', summary: req.body.summary, body: req.body.body || null }); res.json({ ok: true }); });

/* ---- follow-ups ---- */
api.get('/followups', (req, res) => res.json(db.prepare("SELECT * FROM followups WHERE status IN ('open','snoozed') ORDER BY CASE severity WHEN 'crit' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, due_at").all().map(hydrateFollowup)));
api.post('/followups/run', wrap(async (req, res) => { scoreAll(); const r = runRules(); await draftPending(r.pending); res.json(r); }));
api.post('/followups/:id/redraft', wrap(async (req, res) => { const f = get('followups', req.params.id); if (!f) return res.status(404).end(); const draft = await draftFollowup({ rule: f.rule, why: f.why + (req.body.instruction ? ' Instruction: ' + req.body.instruction : ''), channel: f.channel, agent: get('agents', f.agent_id), opportunity: get('opportunities', f.opportunity_id), contact: get('contacts', f.contact_id) }); db.prepare('UPDATE followups SET draft=? WHERE id=?').run(draft, f.id); res.json(hydrateFollowup(get('followups', f.id))); }));
api.patch('/followups/:id', (req, res) => { const f = get('followups', req.params.id); if (!f) return res.status(404).end(); db.prepare('UPDATE followups SET draft=COALESCE(?,draft), subject=COALESCE(?,subject), to_email=COALESCE(?,to_email) WHERE id=?').run(req.body.draft ?? null, req.body.subject ?? null, req.body.to_email ?? null, f.id); res.json(hydrateFollowup(get('followups', f.id))); });
api.post('/followups/:id/approve', wrap(async (req, res) => {
  const f = get('followups', req.params.id); if (!f) return res.status(404).end();
  const draft = req.body.draft ?? f.draft; let sentVia = 'logged';
  if (f.channel === 'email' && f.to_email && gmailConnected() && !req.body.log_only) { await sendEmail({ to: f.to_email, subject: f.subject || 'Egnatia', text: draft }); sentVia = 'gmail'; }
  db.prepare("UPDATE followups SET status='sent', sent_at=?, draft=? WHERE id=?").run(now(), draft, f.id);
  logActivity({ agent_id: f.agent_id, opportunity_id: f.opportunity_id, contact_id: f.contact_id, kind: f.channel, direction: 'out', summary: `${f.rule.replace('_', ' ')} sent (${sentVia})`, body: draft });
  res.json({ ok: true, sent_via: sentVia });
}));
api.post('/followups/:id/snooze', (req, res) => { const d = Number(req.body.days || 3); db.prepare("UPDATE followups SET status='snoozed', snoozed_until=datetime('now', ?) WHERE id=?").run(`+${d} days`, req.params.id); res.json({ ok: true }); });
api.post('/followups/:id/dismiss', (req, res) => { db.prepare("UPDATE followups SET status='dismissed' WHERE id=?").run(req.params.id); res.json({ ok: true }); });

/* ---- memos ---- */
api.post('/memos/generate', wrap(async (req, res) => {
  const o = get('opportunities', req.body.opportunity_id); if (!o) return res.status(404).json({ error: 'opportunity not found' });
  const agent = get('agents', o.agent_id), contact = get('contacts', o.contact_id);
  const memo = await generateMemo({ opportunity: o, agent, contact, notes: req.body.notes || '', photos: req.body.photos || [] });
  const html = memoToHtml(memo, { opportunity: o, agent, contact, disclaimer: getSetting('memo_disclaimer') });
  const id = uid();
  db.prepare('INSERT INTO memos(id,opportunity_id,notes_text,photos_json,memo_json,memo_html) VALUES(?,?,?,?,?,?)').run(id, o.id, req.body.notes || '', JSON.stringify(req.body.photos || []), JSON.stringify(memo), html);
  if (o.stage === 'requested') { db.prepare("UPDATE opportunities SET stage='walked', stage_changed_at=?, walked_at=COALESCE(walked_at,?) WHERE id=?").run(now(), now(), o.id); }
  logActivity({ agent_id: o.agent_id, opportunity_id: o.id, kind: 'memo', direction: 'internal', summary: 'Walkthrough memo drafted from notes' });
  scoreAll();
  res.json({ id, memo, html });
}));
api.get('/memos/:id', (req, res) => { const m = get('memos', req.params.id); if (!m) return res.status(404).end(); res.json({ ...m, memo: parse(m.memo_json, {}) }); });
api.post('/memos/:id/send', wrap(async (req, res) => {
  const m = get('memos', req.params.id); if (!m) return res.status(404).end();
  const o = get('opportunities', m.opportunity_id), agent = get('agents', o.agent_id), contact = get('contacts', o.contact_id);
  const to = [agent?.email, contact?.email].filter(Boolean).join(', '); let via = 'logged';
  if (to && gmailConnected() && !req.body.log_only) { await sendEmail({ to, subject: `${o.address} — pre-purchase renovation walkthrough`, text: 'Walkthrough memo attached below.', html: m.memo_html }); via = 'gmail'; }
  db.prepare("UPDATE memos SET status='sent', sent_at=? WHERE id=?").run(now(), m.id);
  db.prepare("UPDATE opportunities SET memo_sent_at=? WHERE id=?").run(now(), o.id);
  db.prepare("UPDATE followups SET status='dismissed' WHERE opportunity_id=? AND rule='memo_due' AND status='open'").run(o.id);
  logActivity({ agent_id: o.agent_id, opportunity_id: o.id, contact_id: o.contact_id, kind: 'memo', direction: 'out', summary: `Walkthrough memo sent to ${[agent?.name, contact?.name].filter(Boolean).join(' + ')} (${via})` });
  res.json({ ok: true, sent_via: via });
}));

/* ---- inbox ---- */
api.get('/inbox', (req, res) => res.json(db.prepare('SELECT * FROM inbox ORDER BY received_at DESC LIMIT 100').all().map(i => ({ ...i, classification: parse(i.classification_json, null), actions: parse(i.actions_json, []), agent: get('agents', i.agent_id), opportunity: get('opportunities', i.opportunity_id) }))));
api.post('/inbox', (req, res) => { const id = uid(); const b = req.body; db.prepare(`INSERT INTO inbox(id,source,from_name,from_email,subject,body,received_at,status) VALUES(?,?,?,?,?,?,?,'new')`).run(id, 'manual', b.from_name || '', b.from_email || '', b.subject || '(no subject)', b.body || '', now()); res.json(get('inbox', id)); });
api.post('/inbox/poll', wrap(async (req, res) => res.json(await pollInbox())));
api.post('/inbox/process', wrap(async (req, res) => {
  const ctx = { agents: db.prepare('SELECT id,name,email FROM agents').all(), opportunities: db.prepare("SELECT id,address,agent_id,contact_id FROM opportunities WHERE stage!='lost'").all(), contacts: db.prepare('SELECT id,name,email FROM contacts').all() };
  const rows = req.body.id ? [get('inbox', req.body.id)] : db.prepare("SELECT * FROM inbox WHERE status='new' ORDER BY received_at").all();
  const out = [];
  for (const m of rows) {
    if (!m) continue;
    const c = await classifyInbox(m, ctx);
    const actions = [];
    if (c.opportunity_id) { const o = get('opportunities', c.opportunity_id); actions.push(`Filed to ${o.address}`); logActivity({ agent_id: c.agent_id || o.agent_id, opportunity_id: o.id, contact_id: c.contact_id, kind: 'email', direction: 'in', summary: `${m.from_name}: ${m.subject}`, body: m.body, occurred_at: m.received_at }); }
    else if (c.agent_id) { const a = get('agents', c.agent_id); actions.push(`Filed to agent ${a.name}`); logActivity({ agent_id: a.id, kind: 'email', direction: 'in', summary: `${m.from_name}: ${m.subject}`, body: m.body, occurred_at: m.received_at }); }
    else if (c.category === 'vendor_invoice') actions.push('Tagged: vendor invoice → bookkeeping');
    else if (c.category === 'dob_notice') actions.push('Tagged: DOB notice');
    for (const d of c.extracted?.decisions || []) actions.push(`Extracted: ${d}`);
    for (const d of c.extracted?.dates || []) actions.push(`Date mentioned: ${d}`);
    if (c.needs_reply && c.reply_draft) {
      const fid = uid();
      db.prepare(`INSERT OR IGNORE INTO followups(id,rule,agent_id,opportunity_id,contact_id,severity,why,channel,to_email,subject,draft,status,due_at,dedupe_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`)
        .run(fid, 'reply', c.agent_id, c.opportunity_id, c.contact_id, 'warn', `Reply needed: ${c.summary}`, 'email', m.from_email, `Re: ${m.subject}`, c.reply_draft, now(), `reply:${m.id}`);
      actions.push('Reply drafted for your approval');
    }
    const status = (c.agent_id || c.opportunity_id || c.contact_id || ['vendor_invoice', 'dob_notice'].includes(c.category)) ? 'filed' : 'needs_review';
    db.prepare('UPDATE inbox SET classification_json=?, actions_json=?, agent_id=?, opportunity_id=?, contact_id=?, status=? WHERE id=?').run(JSON.stringify(c), JSON.stringify(actions), c.agent_id, c.opportunity_id, c.contact_id, status, m.id);
    out.push({ id: m.id, status, actions });
  }
  res.json({ processed: out.length, items: out });
}));

/* ---- settings ---- */
api.get('/settings', (req, res) => { const s = allSettings(); delete s.google_tokens; res.json(s); });
api.patch('/settings', (req, res) => { for (const [k, v] of Object.entries(req.body)) if (k !== 'google_tokens') setSetting(k, typeof v === 'string' ? v : JSON.stringify(v)); scoreAll(); res.json({ ok: true }); });

/* ---- google auth (mounted outside /api) ---- */
export const auth = Router();
auth.get('/google', (req, res) => gmailConfigured() ? res.redirect(authUrl()) : res.status(400).send('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.'));
auth.get('/google/callback', wrap(async (req, res) => { const email = await handleCallback(req.query.code); res.redirect('/?connected=' + encodeURIComponent(email)); }));
auth.post('/google/disconnect', (req, res) => { disconnect(); res.json({ ok: true }); });
