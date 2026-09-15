// Seeds the database with illustrative sample data (not Egnatia's records).
import 'dotenv/config';
import { db, uid, daysAgo, daysFromNow, logActivity } from '../src/db.js';
import { scoreAll } from '../src/scoring.js';
import { runRules } from '../src/rules.js';

const reset = process.argv.includes('--reset');
if (reset) {
  for (const t of ['followups','memos','inbox','activities','opportunities','contacts','agents','runs']) db.exec(`DELETE FROM ${t}`);
}
if (db.prepare('SELECT COUNT(*) c FROM agents').get().c > 0) { console.log('Database already has data. Use --reset to reseed.'); process.exit(0); }

const A = (o) => { const id = uid(); db.prepare(`INSERT INTO agents(id,name,firm,email,phone,area,tier,channel,notes,last_touch_at) VALUES(@id,@name,@firm,@email,@phone,@area,@tier,@channel,@notes,@last_touch_at)`).run({ channel:'email', notes:null, ...o, id }); return id; };
const C = (o) => { const id = uid(); db.prepare(`INSERT INTO contacts(id,name,email,phone,role,notes) VALUES(@id,@name,@email,@phone,@role,@notes)`).run({ email:null, phone:null, role:'buyer', notes:null, ...o, id }); return id; };
const O = (o) => { const id = uid(); db.prepare(`INSERT INTO opportunities(id,address,neighborhood,property_type,scope,agent_id,contact_id,stage,est_value,timeline,buyer_signals,constraints_json,stage_changed_at,walked_at,estimate_sent_at,memo_sent_at,won_at)
  VALUES(@id,@address,@neighborhood,@property_type,@scope,@agent_id,@contact_id,@stage,@est_value,@timeline,@buyer_signals,@constraints_json,@stage_changed_at,@walked_at,@estimate_sent_at,@memo_sent_at,@won_at)`)
  .run({ buyer_signals:null, constraints_json:'[]', walked_at:null, estimate_sent_at:null, memo_sent_at:null, won_at:null, ...o, id }); return id; };

const marisol = A({ name:'Marisol Vega', firm:'Compass', email:'marisol@example.com', phone:'(718) 555-0142', area:'Park Slope · Prospect Heights', tier:'Core', last_touch_at:daysAgo(4), notes:'Sends buyers before they bid. Wants a 24-hr turnaround on walkthrough memos.' });
const daniel  = A({ name:'Daniel Okafor', firm:'Corcoran', email:'daniel@example.com', phone:'(917) 555-0188', area:'Brooklyn Heights · Cobble Hill', tier:'Core', channel:'text', last_touch_at:daysAgo(31), notes:'Two referrals in spring, quiet since July. Likes short texts, not email.' });
const priya   = A({ name:'Priya Raman', firm:'Brown Harris Stevens', email:'priya@example.com', phone:'(212) 555-0117', area:'Upper West Side', tier:'Core', last_touch_at:daysAgo(9), notes:'Co-op specialist. Board packages are her pain point; wants scope letters she can hand to boards.' });
const tom     = A({ name:'Tom Bracewell', firm:'Douglas Elliman', email:'tom@example.com', phone:'(646) 555-0170', area:'Tribeca · Soho', tier:'Growth', last_touch_at:daysAgo(47), notes:'Met at the Brooklyn agents mixer. One loft walkthrough; buyer passed on the property.' });
const aisha   = A({ name:'Aisha Bello', firm:'SERHANT.', email:'aisha@example.com', phone:'(347) 555-0129', area:'Bed-Stuy · Clinton Hill', tier:'Growth', last_touch_at:daysAgo(12), notes:'Brings townhouse buyers who need full gut. Very responsive.' });
const jon     = A({ name:'Jonathan Reiss', firm:'Sotheby’s Intl', email:'jonathan@example.com', phone:'(212) 555-0193', area:'Chelsea · West Village', tier:'Growth', last_touch_at:daysAgo(22), notes:'One won project (Chelsea). Has not referred since.' });
const grace   = A({ name:'Grace Lindqvist', firm:'Compass', email:'grace@example.com', phone:'(718) 555-0151', area:'Carroll Gardens · Gowanus', tier:'New', last_touch_at:daysAgo(2), notes:'Replied to the pre-purchase walkthrough email. Bringing us on a Carroll Gardens brownstone.' });
const victor  = A({ name:'Victor Hsu', firm:'Corcoran', email:'victor@example.com', phone:'(917) 555-0104', area:'Fort Greene · Boerum Hill', tier:'New', last_touch_at:daysAgo(58), notes:'Coffee in July. Said he had two brownstone buyers this fall. No follow-up since.' });

const feldmans = C({ name:'The Feldmans', email:'feldman@example.com' });
const ryo = C({ name:'Ryo Nakamura', email:'ryo@example.com' });
const alvarez = C({ name:'M. & K. Alvarez', email:'alvarez@example.com' });
const ojos = C({ name:'The Ojos', email:'ojo@example.com', role:'owner' });
const whitfield = C({ name:'S. Whitfield' });
const lena = C({ name:'Lena Petrossian', email:'lena@example.com' });
const marchetti = C({ name:'D. Marchetti', role:'owner' });
const greenbaums = C({ name:'The Greenbaums', email:'greenbaum@example.com', role:'owner' });
const chidi = C({ name:'Chidi Adeyemi', email:'chidi@example.com' });
const yoon = C({ name:'P. Yoon' });

const o1 = O({ address:'412 3rd St', neighborhood:'Park Slope', property_type:'Brownstone', scope:'Full gut, 3 floors', agent_id:marisol, contact_id:feldmans, stage:'negotiating', est_value:485000, timeline:'Closing Oct 15', buyer_signals:'Budget range approved verbally at walkthrough', constraints_json:'["LPC district"]', stage_changed_at:daysAgo(6), walked_at:daysAgo(39), memo_sent_at:daysAgo(38), estimate_sent_at:daysAgo(12) });
const o2 = O({ address:'155 W 86th St #9C', neighborhood:'Upper West Side', property_type:'Co-op', scope:'Classic six: kitchen, 2 baths, layout', agent_id:priya, contact_id:ryo, stage:'estimate_sent', est_value:310000, timeline:'Board approval pending', buyer_signals:'Accepts scope; no objection to number', constraints_json:'["Co-op alteration agreement","Wet-over-dry"]', stage_changed_at:daysAgo(9), walked_at:daysAgo(20), memo_sent_at:daysAgo(19), estimate_sent_at:daysAgo(9) });
const o3 = O({ address:'89 Hicks St', neighborhood:'Brooklyn Heights', property_type:'Townhouse', scope:'Garden + parlor combine, bearing wall', agent_id:daniel, contact_id:alvarez, stage:'walked', est_value:395000, timeline:'In contract', buyer_signals:'Mentioned getting a second bid', constraints_json:'["Structural","Alt-1 possible"]', stage_changed_at:daysAgo(14), walked_at:daysAgo(16), memo_sent_at:daysAgo(14) });
const o4 = O({ address:'71 Quincy St', neighborhood:'Bed-Stuy', property_type:'Townhouse', scope:'Full gut + rear extension', agent_id:aisha, contact_id:ojos, stage:'estimate_sent', est_value:520000, timeline:'Closed Aug 28', buyer_signals:'Already own the property; asked about phasing', constraints_json:'["Alt-1","Rear extension zoning"]', stage_changed_at:daysAgo(4), walked_at:daysAgo(10), memo_sent_at:daysAgo(9), estimate_sent_at:daysAgo(4) });
const o5 = O({ address:'24 Bond St #3', neighborhood:'Noho', property_type:'Loft', scope:'Kitchen + primary bath', agent_id:jon, contact_id:whitfield, stage:'requested', est_value:165000, timeline:'Viewing Thursday', buyer_signals:'Has not bid yet', constraints_json:'["Condo"]', stage_changed_at:daysAgo(2) });
const o6 = O({ address:'229 Carroll St', neighborhood:'Carroll Gardens', property_type:'Brownstone', scope:'Gut renovation, 2 units', agent_id:grace, contact_id:lena, stage:'requested', est_value:450000, timeline:'Walkthrough tomorrow 10am', buyer_signals:'Unknown budget; not in contract', constraints_json:'["Two-family C of O"]', stage_changed_at:daysAgo(1) });
const o7 = O({ address:'340 W 23rd St #6A', neighborhood:'Chelsea', property_type:'Condo', scope:'2 baths + flooring', agent_id:jon, contact_id:marchetti, stage:'won', est_value:190000, timeline:'Started Aug 11', stage_changed_at:daysAgo(35), walked_at:daysAgo(80), won_at:daysAgo(35) });
const o8 = O({ address:'18 Sidney Pl', neighborhood:'Brooklyn Heights', property_type:'Townhouse', scope:'Parlor floor + kitchen', agent_id:daniel, contact_id:greenbaums, stage:'won', est_value:260000, timeline:'Started Jul 7', stage_changed_at:daysAgo(70), walked_at:daysAgo(120), won_at:daysAgo(70) });
const o9 = O({ address:'57 Prospect Pl', neighborhood:'Prospect Heights', property_type:'Brownstone', scope:'Owner’s duplex gut', agent_id:marisol, contact_id:chidi, stage:'walked', est_value:380000, timeline:'Bidding this week', buyer_signals:'Agent flagged buyer as serious, cash', constraints_json:'["Alt-1 if stair moves"]', stage_changed_at:daysAgo(1), walked_at:daysAgo(1) });
const o10 = O({ address:'145 Nassau St #12', neighborhood:'Financial District', property_type:'Condo', scope:'One bathroom', agent_id:tom, contact_id:yoon, stage:'requested', est_value:45000, timeline:'Unknown', constraints_json:'["Condo"]', stage_changed_at:daysAgo(20) });

// timeline
logActivity({ agent_id:marisol, opportunity_id:o9, kind:'walkthrough', direction:'out', summary:'Walked 57 Prospect Pl with Marisol + Chidi', occurred_at:daysAgo(1) });
logActivity({ agent_id:marisol, opportunity_id:o1, kind:'estimate', direction:'out', summary:'Estimate sent for 412 3rd St, $485K', occurred_at:daysAgo(12) });
logActivity({ agent_id:marisol, opportunity_id:o1, kind:'text', direction:'in', summary:'Marisol: “Feldmans love the number, closing moved to Oct 15”', occurred_at:daysAgo(24) });
logActivity({ agent_id:marisol, kind:'call', direction:'out', summary:'Coffee in Prospect Heights; asked for faster memo turnaround', occurred_at:daysAgo(87) });
logActivity({ agent_id:daniel, opportunity_id:o3, kind:'memo', direction:'out', summary:'89 Hicks St walkthrough memo → Daniel + Alvarez family', occurred_at:daysAgo(14) });
logActivity({ agent_id:daniel, opportunity_id:o3, kind:'walkthrough', direction:'out', summary:'Walked 89 Hicks St', occurred_at:daysAgo(16) });
logActivity({ agent_id:daniel, opportunity_id:o8, kind:'note', summary:'Project start, 18 Sidney Pl', occurred_at:daysAgo(70) });
logActivity({ agent_id:priya, opportunity_id:o2, kind:'estimate', direction:'out', summary:'Estimate sent for 9C, $310K', occurred_at:daysAgo(9) });
logActivity({ agent_id:victor, kind:'call', direction:'out', summary:'Coffee in Fort Greene. Two brownstone buyers “lining up for fall.”', occurred_at:daysAgo(58) });
logActivity({ agent_id:grace, opportunity_id:o6, kind:'email', direction:'in', summary:'Grace replied to the pre-purchase walkthrough email; wants us at 229 Carroll St', occurred_at:daysAgo(2) });
logActivity({ agent_id:jon, opportunity_id:o7, kind:'note', summary:'Chelsea job 4 weeks in, on schedule', occurred_at:daysAgo(7) });

// sample inbox items (manual source)
const I = (o) => db.prepare(`INSERT INTO inbox(id,source,from_name,from_email,subject,body,received_at,status) VALUES(@id,'manual',@from_name,@from_email,@subject,@body,@received_at,'new')`).run({ id:uid(), ...o });
I({ from_name:'Grace Lindqvist', from_email:'grace@example.com', subject:'Re: Pre-purchase walkthrough — 229 Carroll St', body:'Hi Elona, yes please — can you meet us at 229 Carroll St Tuesday at 10am? Lena is the buyer, she’s hoping to keep the garden unit as a rental. Thanks, Grace', received_at:daysAgo(0.3) });
I({ from_name:'Ryo Nakamura', from_email:'ryo@example.com', subject:'Board package question for 9C', body:'Elona — the managing agent wants a scope letter and preliminary schedule before the board meets on the 28th. Do you have something in that format? Thanks, Ryo', received_at:daysAgo(1) });
I({ from_name:'Chidi Adeyemi', from_email:'chidi@example.com', subject:'Thanks for walking Prospect Pl', body:'Really appreciated your time yesterday. We’re bidding by Friday. Any early read on the stair question would help. — Chidi', received_at:daysAgo(1) });
I({ from_name:'DOB NOW', from_email:'no-reply@dob.nyc.gov', subject:'Job filing status: 18 Sidney Pl', body:'Status unchanged: Pending professional certification review.', received_at:daysAgo(2) });
I({ from_name:'Bay Ridge Tile Supply', from_email:'ar@example.com', subject:'Invoice #4471 — 340 W 23rd', body:'Attached invoice for porcelain, 6A. Net 30.', received_at:daysAgo(2) });

scoreAll();
const r = runRules();
console.log('Seeded. Follow-ups generated:', r.created);
