# Egnatia Relay

Agent relationships → follow-up → walkthrough memos → qualified $150K–$500K+ opportunities.
Built by Keres AI for Egnatia Construction. One record, AI does the carrying, the owner keeps the judgment.

## What it does

| Job | How |
|---|---|
| **Keeps agent relationships warm** | Every agent has a tier (Core / Growth / New) and a cadence. When the clock runs out, a follow-up appears with a draft in the owner's voice. |
| **Follow-up engine** | Six rules run nightly: agent going cold, estimate check-in at day 7, walkthrough prep, memo due within 24h, won-project touch, stalled opportunity. Nothing sends without approval. |
| **Walkthrough → memo** | Paste dictated notes; get a client-ready pre-purchase renovation memo (bottom line, questions before bid, observations, budget bands, DOB/LPC/co-op approvals). Send to agent + buyer. |
| **Opportunity scoring** | 0–100 likelihood of becoming an Egnatia project, from five weighted factors, with plain-English reasons. Weights are editable. |
| **Inbox agent** | Pulls Gmail, files each message to the right agent / buyer / project, extracts dates and decisions, drafts replies for approval. |
| **Monday brief** | Dashboard summary of what needs attention. |

Runs in **mock mode** with no API keys (templated drafts, deterministic memo and filing) so it can be demoed and tested anywhere. Add `ANTHROPIC_API_KEY` and every AI job switches to Claude.

## Run it locally (2 minutes)

```bash
npm install
cp .env.example .env        # leave keys blank for mock mode
npm start                   # http://localhost:3000  — auto-seeds sample data on first boot
```

Sample data is illustrative, not Egnatia's records. To start clean for the real instance: set `AUTO_SEED=false` in `.env` and delete `data/relay.db`.

## Demo it (about 20 minutes)

The sample data is built so a live demo tells one story. Eight agents across three tiers, ten opportunities from "walkthrough requested" to "won", five unread emails, and nine follow-ups the rules generated on first boot. None of it is Egnatia's real records.

**The thread to pull:** 57 Prospect Pl, a brownstone Marisol Vega brought. It was walked yesterday with the buyer, the 24-hour memo clock has run out, and the buyer has emailed asking about "the stair question" before he bids Friday. By the end of the demo the memo is written and sent, the overdue item has cleared itself, and his email has filed itself to the property.

| Screen (left rail) | Show | Say |
|---|---|---|
| **Agents → Opportunities** | The chain 10 → 7 → 4 → 3 → 2 and the "What happens next" column | One in five referrals becomes a project. The system already knows the next action for every agent. |
| **Today** | The written brief, the priority list, Hours saved at 0 | Five-second Monday read. Priority is likelihood × value, not recency. |
| **Follow-ups** | Victor Hsu's card: the "Why now" line, the draft, Approve | Six rules ran. The draft knows his notes. Nothing sends without approval. |
| **Agents** | Victor is now On cadence; Priya's drawer and notes | Tier is the only decision; the cadence follows. |
| **Pipeline** | 412 3rd St at 83 and its reasons; 145 Nassau St at 32 | Five weighted factors, every score explains itself. |
| **Walkthrough memo** | Paste the notes below for 57 Prospect Pl, Generate, Approve | Dictation to a client-ready memo. Only numbers from the notes. The overdue item disappears. |
| **Inbox agent** | Process new: five messages filed, two replies drafted | Files, extracts dates and decisions, drafts replies for approval. |
| **Settings** | Cadence, weights, the voice profile | Everything the AI did started from this page. |
| **Today** again | Hours saved is now about 2.8 | Same screen as the start; the system did the carrying. |

Notes to paste on the memo screen (they exercise every section of the memo):

```
Parlor floor: plaster shot on the east wall, pocket doors salvageable. Kitchen moves to the garden level, new gas line and waste stack. Three new baths, stack works. Panel is 100 amp with mixed BX and cloth, needs a full rewire and 200 amp service. Roof about 5 years old. Rear facade has some spalling. Ballpark 360 to 400 keeping the stair. Moving the stair is another 40 plus an Alt-1.
```

Two things to know in mock mode: **Redraft** returns the same template (with `ANTHROPIC_API_KEY` set it rewrites to your instruction), and approvals **log as sent** rather than emailing until Gmail is connected.

The sample dates age one day per day. To put the data back exactly as described, reset and reload the browser:

```bash
npm run seed -- --reset
```

The full talk track, with every on-screen number, what to click, and answers to likely questions, is in [`docs/demo-run-of-show.html`](docs/demo-run-of-show.html). Open it in a browser on a second screen.

## Deploy (Railway / Render / Fly / any Docker host)

1. Push this folder to a private GitHub repo.
2. Create a service from the repo. The `Dockerfile` is picked up automatically. Attach a persistent volume at `/data` (that is where SQLite lives).
3. Set environment variables from `.env.example`. Minimum for production: `APP_URL`, `APP_PASSWORD`, `AUTO_SEED=false`.
4. Add `ANTHROPIC_API_KEY` (console.anthropic.com → API keys). Cost at Egnatia's volume is a few dollars a month.
5. **Gmail:** in Google Cloud Console create a project → OAuth consent screen (Internal if Egnatia is on Google Workspace, else External + add Elona as a test user) → Credentials → OAuth client ID, type *Web application*, redirect URI `{APP_URL}/auth/google/callback`. Enable the **Gmail API** and **Google Calendar API**. Put the client ID/secret in env, restart, then Settings → Connect Gmail while signed in as info@egnatiaconstruction.com.

Rules run every night at 6:00 America/New_York (`RULES_CRON`) and can be triggered any time from the UI ("Run the rules now").

## Structure

```
src/server.js     Express app, auth, cron
src/db.js         SQLite schema, settings, activity log
src/rules.js      Follow-up rule engine (dedupe-safe, re-runnable)
src/scoring.js    Explainable opportunity score
src/ai.js         Claude or mock: drafting, memo, inbox classification, brief
src/gmail.js      OAuth, inbox polling, sending
src/routes.js     REST API (/api/*) and Google auth (/auth/*)
public/           Single-page UI
scripts/seed.js   Sample data
docs/             Demo run of show (talk track for a live walkthrough)
```

## API sketch

`GET /api/dashboard` · `GET/POST/PATCH /api/agents` · `POST /api/agents/:id/touch` · `GET/POST/PATCH /api/opportunities` ·
`GET /api/followups` · `POST /api/followups/run` · `POST /api/followups/:id/approve|redraft|snooze|dismiss` ·
`POST /api/memos/generate` · `POST /api/memos/:id/send` · `GET/POST /api/inbox` · `POST /api/inbox/poll|process` · `GET/PATCH /api/settings`

## Roadmap (what the pilot adds)

- Text messages (Twilio) for agents who prefer texts.
- Audio upload → transcription for walkthrough voice notes (Whisper or similar) instead of phone dictation.
- Calendar events for walkthroughs; DOB NOW status lookups by BIN.
- Postgres instead of SQLite when there is more than one company on the platform.
- Per-client instances so Keres AI can run this for other contractors with the same codebase.
