// AI layer. Uses Claude when ANTHROPIC_API_KEY is set; otherwise a deterministic mock so the
// product works end to end (demos, tests, local dev) with no key.
import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from './db.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
export const aiMode = () => (process.env.ANTHROPIC_API_KEY ? 'claude' : 'mock');
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

async function ask(system, user, { json = false, maxTokens = 1200 } = {}) {
  const res = await client.messages.create({
    model: MODEL, max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: user + (json ? '\n\nRespond with JSON only. No prose, no code fences.' : '') }],
  });
  const text = res.content.map(c => c.text || '').join('');
  if (!json) return text.trim();
  const m = text.match(/\{[\s\S]*\}/); return JSON.parse(m ? m[0] : text);
}

const voice = () => getSetting('voice_profile');
const owner = () => getSetting('owner_name');
const company = () => getSetting('company');

/* ---------- 1. Follow-up drafting ---------- */
export async function draftFollowup(ctx) {
  // ctx: { rule, why, agent, opportunity, contact, channel }
  if (aiMode() === 'mock') return mockDraft(ctx);
  const sys = `You draft short outbound messages for ${owner()}, co-founder of ${company()}, a Brooklyn & Manhattan renovation contractor specializing in $150K–$500K+ interior and gut renovations. Voice profile:\n${voice()}\nRules: under 110 words for email, under 60 for text. One concrete offer, one easy ask. No subject line unless asked. Never invent prices, dates or facts not in the context. Sign as the voice profile says.`;
  const user = `Channel: ${ctx.channel}\nRule that fired: ${ctx.rule}\nWhy now: ${ctx.why}\nRecipient: ${ctx.agent ? `${ctx.agent.name}, ${ctx.agent.firm} (real estate agent, covers ${ctx.agent.area}). Notes: ${ctx.agent.notes || 'none'}` : ctx.contact?.name}\n${ctx.opportunity ? `Property: ${ctx.opportunity.address}, ${ctx.opportunity.neighborhood}. Scope: ${ctx.opportunity.scope}. Stage: ${ctx.opportunity.stage}. Timeline: ${ctx.opportunity.timeline || 'unknown'}. Buyer signals: ${ctx.opportunity.buyer_signals || 'none'}.` : ''}\n\nWrite the message.`;
  return ask(sys, user, { maxTokens: 400 });
}

function mockDraft({ rule, agent, opportunity, contact, channel }) {
  const first = (agent?.name || contact?.name || 'there').split(' ')[0];
  const addr = opportunity?.address || 'the property';
  const area = agent?.area || 'Brooklyn';
  const sig = channel === 'text' ? '— Elona' : '\n\nElona';
  switch (rule) {
    case 'agent_cold': return `${first} — Elona from Egnatia. ${agent?.notes?.includes('buyers') ? 'You mentioned buyers lining up this fall.' : 'It’s been a while.'} If anyone you’re working with is looking at a property in ${area} that needs real work, I’m happy to walk it with you before they go into contract. No cost, no pressure — it just keeps surprises out of the deal. Free next week?${sig}`;
    case 'estimate_checkin': return `${first} — checking in on ${addr}. If anything in the estimate needs explaining, or the building needs a scope letter and preliminary schedule for the board, I can have that to you this week. What would help?${sig}`;
    case 'walkthrough_prep': return `${first} — confirming ${addr}${opportunity?.timeline ? ' (' + opportunity.timeline.toLowerCase() + ')' : ''}. Two quick things so I make this useful: what does the buyer care most about — budget certainty, timeline, or layout? And is there anything they’re hoping to keep or change that I should look at closely? You’ll both have a written walkthrough memo within 24 hours.${sig}`;
    case 'memo_due': return `${first} — memo for ${addr} attached. Headline and the two questions the buyer should settle before bidding are on page one. Call me if anything needs a second look.${sig}`;
    case 'won_touch': return `${first} — ${addr} is underway and on schedule; two progress photos below. Thank you again for the introduction. If you have anyone touring ${area} who’ll need real work, I’m glad to join a walkthrough before they commit.${sig}`;
    case 'stalled': return `${first} — quick one on ${addr}. Is it still live on your end? If the buyers are weighing options, I can walk them through where our number is conservative and where it isn’t, so they’re comparing like with like. 15 minutes this week?${sig}`;
    default: return `${first} — quick note from Elona at Egnatia about ${addr}. Happy to help however is useful.${sig}`;
  }
}

/* ---------- 2. Walkthrough memo ---------- */
export async function generateMemo({ opportunity, agent, contact, notes, photos = [] }) {
  if (aiMode() === 'mock') return mockMemo({ opportunity, agent, contact, notes, photos });
  const sys = `You turn a contractor's walkthrough voice notes into a client-ready "Pre-purchase renovation walkthrough" memo for ${company()} (Brooklyn & Manhattan, $150K–$500K+ interior and gut renovations). Audience: the buyer and their real estate agent. Tone: plain, confident, specific, no hype. NYC-literate: DOB Alt-1 (Alteration-CO) vs Alt-2, LPC, co-op alteration agreements, ACP-5 asbestos survey for pre-1987 buildings, Con Ed service upgrades, wet-over-dry. Only use numbers that appear in the notes; if the notes give a range, keep it. Never invent findings.`;
  const user = `Property: ${opportunity.address}, ${opportunity.neighborhood} (${opportunity.property_type}). Stated scope: ${opportunity.scope}. Buyer: ${contact?.name || 'buyer'}. Agent: ${agent?.name || ''} (${agent?.firm || ''}).\nPhotos on file: ${photos.map(p => p.label || p).join(', ') || 'none'}\n\nWalkthrough notes:\n${notes}\n\nReturn JSON: {"bottom_line": string, "questions_before_bid": string[], "observations": [{"area": string, "finding": string}], "budget_bands": [{"item": string, "range": string}], "approvals_timeline": string, "risks": string[]}`;
  return ask(sys, user, { json: true, maxTokens: 1500 });
}

function mockMemo({ opportunity, notes }) {
  const n = notes.toLowerCase();
  const band = n.match(/(\d{3})\s*(?:to|-|–)\s*(\d{3})/);
  const lo = band ? `$${band[1]}K` : '$300K', hi = band ? `$${band[2]}K` : '$360K';
  return {
    bottom_line: `The ${(opportunity.scope || 'renovation').toLowerCase()} described is realistic for this property. Based on the walkthrough, expect ${lo}–${hi} over 7–9 months${n.includes('stair') ? '. Relocating the stair adds roughly $40K plus a DOB Alt-1 (Alteration-CO) filing and 2–3 months' : ''}.`,
    questions_before_bid: [
      n.includes('stair') ? 'Do you want the stair moved, or is the parlor opened up enough by removing the non-bearing partitions?' : 'Which rooms are must-change versus nice-to-change? It sets the budget band.',
      n.includes('garden') ? 'Will the garden level stay a separate rental unit? It changes the kitchen location, the gas work and the Certificate of Occupancy.' : 'What is the move-in date you are planning around? It determines whether approvals need to start before closing.',
    ],
    observations: [
      n.includes('plaster') ? { area: 'Walls & finishes', finding: 'Plaster failed on the parlor east wall; full skim or new board. Original pocket doors salvageable.' } : { area: 'Walls & finishes', finding: 'Finishes are dated but sound; budget for skim and paint throughout.' },
      n.includes('kitchen') ? { area: 'Kitchen', finding: 'Kitchen relocation requires a new gas line and a relocated waste stack. Standard for this layout but not trivial.' } : { area: 'Kitchen', finding: 'Kitchen stays in place; plumbing and gas serviceable.' },
      n.match(/bath/) ? { area: 'Bathrooms', finding: 'All bathrooms new. Wet-over-dry alignment works with the existing stack.' } : { area: 'Bathrooms', finding: 'Existing bathrooms refreshed; no relocation.' },
      n.includes('amp') ? { area: 'Electrical', finding: 'Mixed BX and cloth wiring; 100A panel. Full rewire and 200A service upgrade required; Con Ed coordination adds lead time, confirm early.' } : { area: 'Electrical', finding: 'Service appears adequate; confirm panel capacity with the electrician before appliance selection.' },
      n.includes('roof') ? { area: 'Envelope', finding: 'Roof approximately 5–7 years old, no action. Rear facade shows spalling; budget for patching, not full recasting.' } : { area: 'Envelope', finding: 'No exterior work identified during a visual walkthrough.' },
    ],
    budget_bands: [
      { item: `${opportunity.scope || 'Renovation'}${n.includes('stair') ? ', stair stays' : ''}`, range: `${lo} – ${hi}` },
      ...(n.includes('stair') ? [{ item: 'Stair relocation (add)', range: '+ $38K – $45K, plus Alt-1' }] : []),
      ...(n.includes('facade') ? [{ item: 'Rear facade repair (add)', range: '+ $12K – $20K' }] : []),
      { item: 'Contingency we recommend', range: '10%' },
    ],
    approvals_timeline: `${opportunity.property_type === 'Co-op' ? 'Co-op alteration agreement first (2–12 weeks depending on scope), then ' : ''}DOB Alt-2 (Alteration) filing for MEP and layout${n.includes('stair') ? '; Alt-1 (Alteration-CO) only if the stair moves' : ''}. ACP-5 asbestos survey required for pre-1987 buildings. Typical sequence: 4–6 weeks design and filing, 7–9 months construction.`,
    risks: ['Ranges are from a visual walkthrough only; invasive inspection may change them.', ...(n.includes('amp') ? ['Con Ed service upgrade lead time is a schedule driver; start the load letter early.'] : [])],
  };
}

export function memoToHtml(memo, { opportunity, agent, contact, disclaimer }) {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<div style="font-family:Georgia,serif;max-width:680px;color:#1B2431">
<div style="border-bottom:2px solid #1B2431;padding-bottom:8px;margin-bottom:14px"><div style="font-size:18px;font-weight:700">${esc(company())}</div><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7B8290">Pre-purchase renovation walkthrough</div></div>
<p style="font-size:13px;color:#4A5260"><b>${esc(opportunity.address)}, ${esc(opportunity.neighborhood || '')}</b> · Prepared for ${esc(contact?.name || 'the buyer')}${agent ? ' and ' + esc(agent.name) + ' (' + esc(agent.firm || '') + ')' : ''}</p>
<h3 style="font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:#7B8290;margin:16px 0 6px">Bottom line</h3><p>${esc(memo.bottom_line)}</p>
<h3 style="font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:#7B8290;margin:16px 0 6px">Questions to settle before you bid</h3><ul>${(memo.questions_before_bid || []).map(q => `<li>${esc(q)}</li>`).join('')}</ul>
<h3 style="font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:#7B8290;margin:16px 0 6px">What we saw</h3><table style="border-collapse:collapse;width:100%;font-size:14px">${(memo.observations || []).map(o => `<tr><td style="padding:6px 8px;border-bottom:1px solid #E9E7E0;width:32%;vertical-align:top">${esc(o.area)}</td><td style="padding:6px 8px;border-bottom:1px solid #E9E7E0">${esc(o.finding)}</td></tr>`).join('')}</table>
<h3 style="font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:#7B8290;margin:16px 0 6px">Budget bands</h3><table style="border-collapse:collapse;width:100%;font-size:14px">${(memo.budget_bands || []).map(b => `<tr><td style="padding:6px 8px;border-bottom:1px solid #E9E7E0;width:50%">${esc(b.item)}</td><td style="padding:6px 8px;border-bottom:1px solid #E9E7E0;font-family:Menlo,monospace">${esc(b.range)}</td></tr>`).join('')}</table>
<h3 style="font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:#7B8290;margin:16px 0 6px">Approvals &amp; timeline</h3><p>${esc(memo.approvals_timeline)}</p>
${(memo.risks || []).length ? `<h3 style="font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:#7B8290;margin:16px 0 6px">Worth knowing</h3><ul>${memo.risks.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
<p style="font-size:12px;color:#7B8290;margin-top:18px">${esc(disclaimer)}</p></div>`;
}

/* ---------- 3. Inbox classification ---------- */
export async function classifyInbox(msg, { agents, opportunities, contacts }) {
  // Returns { agent_id, opportunity_id, contact_id, category, extracted:{dates,budget,decision}, needs_reply, reply_draft, summary }
  if (aiMode() === 'mock') return mockClassify(msg, { agents, opportunities, contacts });
  const sys = `You file incoming email for ${owner()} at ${company()} (NYC renovation contractor). Match the message to a known agent, opportunity (by address) and contact if possible. Categorize: agent | buyer | vendor_invoice | dob_notice | building_management | other. Extract dates, budget figures and decisions. Decide if a reply is needed and, if so, draft one in this voice:\n${voice()}\nNever invent facts.`;
  const user = `Known agents: ${agents.map(a => `${a.id}:${a.name} <${a.email}>`).join('; ')}\nKnown opportunities: ${opportunities.map(o => `${o.id}:${o.address}`).join('; ')}\nKnown contacts: ${contacts.map(c => `${c.id}:${c.name} <${c.email || ''}>`).join('; ')}\n\nFrom: ${msg.from_name} <${msg.from_email}>\nSubject: ${msg.subject}\n\n${msg.body}\n\nReturn JSON: {"agent_id":string|null,"opportunity_id":string|null,"contact_id":string|null,"category":string,"summary":string,"extracted":{"dates":string[],"budget":string[],"decisions":string[]},"needs_reply":boolean,"reply_draft":string|null}`;
  return ask(sys, user, { json: true, maxTokens: 800 });
}

function mockClassify(msg, { agents, opportunities, contacts }) {
  const t = `${msg.subject} ${msg.body}`.toLowerCase();
  const agent = agents.find(a => a.email && a.email === msg.from_email) || agents.find(a => t.includes(a.name.split(' ')[0].toLowerCase()));
  const contact = contacts.find(c => c.email && c.email === msg.from_email);
  let opp = opportunities.find(o => {
    const base = o.address.toLowerCase().split('#')[0].trim();          // "340 w 23rd st"
    const [num, ...rest] = base.split(' ');
    const street = rest.join(' ');                                       // "w 23rd st"
    const streetNoSuffix = street.replace(/\s(st|ave|pl|rd|blvd|street|avenue|place)$/, ''); // "w 23rd"
    return t.includes(base) || t.includes(`${num} ${streetNoSuffix}`) || (street.length >= 8 && t.includes(street)) || (streetNoSuffix.length >= 8 && t.includes(streetNoSuffix));
  });
  if (!opp && contact) opp = opportunities.find(o => o.contact_id === contact.id);
  let category = 'other';
  if (/invoice|net 30|\bar@/.test(t)) category = 'vendor_invoice';
  else if (/dob|filing status|permit/.test(t)) category = 'dob_notice';
  else if (/managing agent|board|package/.test(t) && contact) category = 'buyer';
  else if (agent) category = 'agent';
  else if (contact) category = 'buyer';
  const dates = [...new Set((msg.body.match(/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b[^.,]*|\bthe \d{1,2}(?:st|nd|rd|th)\b|\b(?:at|by) \d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\bby friday\b/gi) || []))];
  const decisions = [];
  if (/keep the garden unit/.test(t)) decisions.push('Buyer wants to keep the garden unit as a rental');
  if (/bidding by/.test(t)) decisions.push('Buyer bidding by Friday');
  if (/scope letter/.test(t)) decisions.push('Board wants a scope letter and preliminary schedule');
  const needs_reply = ['agent', 'buyer'].includes(category) && !/no reply needed|thanks for walking/.test(t) || /scope letter|can you meet/.test(t);
  const first = (msg.from_name || '').split(' ')[0];
  const reply_draft = needs_reply ? (/scope letter/.test(t) ? `${first} — yes. I'll put together a scope letter and preliminary schedule in the format managing agents usually want; I've done it for two other buildings on the West Side. I'll send it to you by Thursday so it's in before the 28th.\n\nElona` : /can you meet/.test(t) ? `${first} — confirmed, Tuesday at 10am. Since Lena is thinking about keeping the garden unit as a rental, I'll look closely at the kitchen location, the gas work and the C of O. You'll both have a written memo within 24 hours.\n\nElona` : `${first} — thanks for this. I'll come back to you shortly.\n\nElona`) : null;
  const summary = category === 'vendor_invoice' ? 'Supplier invoice; route to bookkeeping and tag to the job' : category === 'dob_notice' ? 'DOB status notice; filed to the project, no action' : `${category === 'agent' ? 'Agent' : 'Buyer'} message${opp ? ' about ' + opp.address : ''}${decisions.length ? ': ' + decisions.join('; ') : ''}`;
  return { agent_id: agent?.id || null, opportunity_id: opp?.id || null, contact_id: contact?.id || null, category, summary, extracted: { dates, budget: [], decisions }, needs_reply, reply_draft };
}

/* ---------- 4. Monday brief ---------- */
export async function mondayBrief(snapshot) {
  if (aiMode() === 'mock') return `Good morning, ${owner()}. ${snapshot.followups} follow-ups are waiting (${snapshot.overdue} overdue). Active pipeline is ${snapshot.pipeline} across ${snapshot.opps} opportunities. ${snapshot.cold} agent${snapshot.cold === 1 ? '' : 's'} have gone cold. Top priority this week: ${snapshot.top}.`;
  return ask(`You write a five-sentence Monday brief for ${owner()} at ${company()}. Plain, specific, no bullet points.`, JSON.stringify(snapshot), { maxTokens: 300 });
}
