// Opportunity scoring: 0–100 likelihood of becoming a $150K–$500K+ Egnatia project.
// Deterministic and explainable. Weights come from settings and can be tuned as projects close.
import { db, getSettingJSON, getSetting, daysSince } from './db.js';

const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));

export function scoreOpportunity(o, agent, agentStats) {
  const W = getSettingJSON('score_weights') || { scope: 30, agent: 25, buyer: 20, timing: 15, constraints: 10 };
  const minVal = Number(getSetting('min_project_value')) || 150000;
  const reasons = [], negs = [];
  const cons = safeJSON(o.constraints_json, []);

  // 1. Scope & property type
  let scope = 0;
  const v = o.est_value || 0;
  if (v >= 400000) { scope = 1; reasons.push(`${fmt(v)} scope; squarely in the $400K+ range`); }
  else if (v >= minVal) { scope = 0.75; reasons.push(`${fmt(v)} scope; above the ${fmt(minVal)} minimum`); }
  else if (v >= minVal * 0.6) { scope = 0.35; negs.push(`${fmt(v)} is below the ${fmt(minVal)} minimum`); }
  else { scope = 0.05; negs.push(`${fmt(v)} scope is well under the minimum; consider referring out`); }
  const typeBoost = { Brownstone: 0.1, Townhouse: 0.1, 'Co-op': 0.02, Loft: 0.02, Condo: 0 }[o.property_type] || 0;
  if (typeBoost >= 0.1) reasons.push(`${o.property_type} ${(o.scope || '').toLowerCase().includes('gut') ? 'gut' : 'renovation'}: Egnatia’s sweet spot`);
  scope = clamp(scope + typeBoost);

  // 2. Agent referral history
  let ag = 0.3;
  if (agentStats) {
    const { referrals, won } = agentStats;
    if (referrals >= 3 && won >= 2) { ag = 1; reasons.push(`${agent.name} has referred ${referrals} buyers, ${won} became projects`); }
    else if (won >= 1) { ag = 0.75; reasons.push(`${agent.name}’s referrals have converted before`); }
    else if (referrals >= 1) { ag = 0.45; }
    else { ag = 0.4; reasons.push(`First referral from ${agent.name}: high strategic value`); }
  }

  // 3. Buyer signals
  let buyer = 0.4;
  const sig = (o.buyer_signals || '').toLowerCase();
  if (/approved|accept|cash|serious|no objection|already own/.test(sig)) { buyer = 0.9; reasons.push(`Buyer signal: ${o.buyer_signals}`); }
  if (/second bid|has not bid|unknown budget|may lose|phasing/.test(sig)) { buyer = Math.min(buyer, 0.4); negs.push(`Buyer signal: ${o.buyer_signals}`); }

  // 4. Transaction stage & timing
  const stageScore = { requested: 0.35, walked: 0.55, estimate_sent: 0.75, negotiating: 0.9, won: 1, lost: 0 }[o.stage] ?? 0.3;
  let timing = stageScore;
  const tl = (o.timeline || '').toLowerCase();
  if (/closing|in contract|closed|started/.test(tl)) { timing = clamp(timing + 0.15); reasons.push(`Timeline: ${o.timeline}`); }
  const stale = daysSince(o.stage_changed_at);
  const stalledDays = Number(getSetting('stalled_days')) || 10;
  if (o.stage !== 'won' && stale >= stalledDays) { timing = clamp(timing - 0.25); negs.push(`No movement for ${Math.floor(stale)} days`); }
  if (agent && daysSince(agent.last_touch_at) > 21 && o.stage !== 'won') negs.push(`${agent.name} hasn’t been in touch for ${Math.floor(daysSince(agent.last_touch_at))} days`);

  // 5. Building constraints (drag on timeline, not on fit)
  let constraints = 1;
  for (const c of cons) {
    if (/co-op|board/i.test(c)) { constraints -= 0.3; negs.push('Co-op board alteration agreement can add 6–12 weeks'); }
    else if (/LPC|landmark/i.test(c)) { constraints -= 0.15; negs.push('Landmarks district: exterior/facade work needs LPC review'); }
    else if (/Alt-1/i.test(c)) { constraints -= 0.15; negs.push('Alt-1 (Alteration-CO) filing likely; longer DOB timeline'); }
    else if (/structural/i.test(c)) { constraints -= 0.05; }
  }
  constraints = clamp(constraints);

  const total = Math.round(scope * W.scope + ag * W.agent + buyer * W.buyer + timing * W.timing + constraints * W.constraints);
  const score = o.stage === 'won' ? 100 : o.stage === 'lost' ? 0 : Math.max(0, Math.min(99, total));
  return { score, reasons, negs };
}

export function agentStats(agentId) {
  const rows = db.prepare('SELECT stage FROM opportunities WHERE agent_id=?').all(agentId);
  return { referrals: rows.length, won: rows.filter(r => r.stage === 'won').length, walked: rows.filter(r => r.stage !== 'requested').length };
}

export function scoreAll() {
  const opps = db.prepare('SELECT * FROM opportunities').all();
  const upd = db.prepare('UPDATE opportunities SET score=?, score_reasons_json=? WHERE id=?');
  for (const o of opps) {
    const agent = o.agent_id ? db.prepare('SELECT * FROM agents WHERE id=?').get(o.agent_id) : null;
    const s = scoreOpportunity(o, agent || { name: 'Unknown' }, agent ? agentStats(agent.id) : null);
    upd.run(s.score, JSON.stringify({ reasons: s.reasons, negs: s.negs }), o.id);
  }
  return opps.length;
}

function safeJSON(s, d) { try { return JSON.parse(s) ?? d; } catch { return d; } }
function fmt(n) { return '$' + Math.round(n / 1000) + 'K'; }
