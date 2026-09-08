# Bandanout Dashboard

A standalone web dashboard (not inside Jira) that shows every Bandanout signal in one place: who's been flagged, for which expectation, how often, and where it came from.

It pulls **live data**:
- **Expectations** — parsed from your Confluence handbook page, same as the Jira/Slack picker.
- **Jira signals** — every `bandanout-flagged` ticket's comments, decoded to show who flagged whom.
- **Manual signals** — anything you log directly from this dashboard (optionally posts a real Jira comment too).

This is a separate app from the Forge app. It runs on its own, and you host it yourself.

---

## 1. Run it locally first

```
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `ATLASSIAN_EMAIL` — same email as your Confluence/Jira login
- `ATLASSIAN_API_TOKEN` — generate one at https://id.atlassian.com/manage-profile/security/api-tokens (the same one used for the Forge app's Confluence access will work)

Then:
```
npm start
```

Open http://localhost:3000 — you should see the real dashboard with live data.

**Optional:** copy `data/roster.example.json` to `data/roster.json` and fill in real names/roles so people show up with the right title, instead of just "Team member".

---

## 2. Deploying it publicly

I can't deploy this to your domain directly — that needs your hosting account and DNS access. Here's the fastest path:

### Step A — Host the app (pick one, both have free tiers)

**Render.com** (simplest for this kind of app)
1. Push this folder to a GitHub repo (or use Render's "deploy from folder" if available)
2. On Render: **New → Web Service**, connect the repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add the environment variables from `.env` in Render's dashboard (Settings → Environment)
6. Deploy — Render gives you a URL like `bandanout-dashboard.onrender.com`

**Railway.app** (similar flow)
1. New Project → Deploy from GitHub repo
2. Add the same environment variables
3. Railway gives you a public URL automatically

### Step B — Point handbook.bandanout.com at it

Once deployed, your host gives you a URL to point a custom domain to (usually via a CNAME record).

In whatever DNS provider manages `bandanout.com`:
1. Add a **CNAME** record:
   - Host: `handbook`
   - Value: (the URL your host gave you, e.g. `bandanout-dashboard.onrender.com`)
2. In your hosting platform, add `handbook.bandanout.com` as a **custom domain** for this service (Render and Railway both have this under project settings)
3. Wait for DNS to propagate (usually a few minutes to an hour)
4. Visit `https://handbook.bandanout.com` — it should show the live dashboard

---

## 3. What's tracked right now vs. what isn't

- ✅ **Jira flags** — fully live, pulled from ticket comments automatically.
- ✅ **Manual entries** — logged from this dashboard, persisted, and optionally posted as a real Jira comment if you give a valid ticket key.
- ✅ **Slack flags** — the dashboard now exposes `POST /api/signals/slack` to receive them; the Forge app's Slack bot needs to call it (see section below). Until that bot-side change ships, no Slack signals will actually arrive.

---

## 4. Wiring the Slack bot up

This repo's server now has the intake endpoint. The other half — having the Slack bot (in the separate Forge app repo) actually call it whenever someone flags a teammate — is a change to make **there**, not here.

1. In this dashboard's `.env`, set `SLACK_SIGNAL_TOKEN` to any long random string, and restart the server.
2. In the Forge app's Slack flag handler, add a call like this right after it posts the flag message to Slack:

```js
await fetch(`${DASHBOARD_URL}/api/signals/slack`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Bandanout-Token': process.env.SLACK_SIGNAL_TOKEN // same value as this dashboard's .env
  },
  body: JSON.stringify({
    channel: event.channel,           // Slack channel ID
    ts: event.ts,                     // Slack message timestamp — used for dedup, required
    slackUserId: flaggedUser.id,      // whoever was flagged
    slackUserName: flaggedUser.name,  // display name fallback if not in roster.json
    flaggedByName: flagger.name,      // who raised the flag
    expectationTitle: expectation.title, // must match a Confluence "Expectation:" line's title
    note: userProvidedNote,           // optional
    permalink: messagePermalink       // optional, shown as the signal's reference link
  })
});
```

3. `DASHBOARD_URL` and `SLACK_SIGNAL_TOKEN` need to be set as env vars/secrets in the Forge app, matching where this dashboard is hosted and its `.env` value respectively.
4. Retries are safe — the endpoint dedupes on `channel` + `slackUserId` + `ts`, so if the Forge app retries a failed call, the same signal won't be logged twice.
5. To have a Slack-flagged person show up under the same team member as their Jira signals (instead of a separate "slack-only" entry), add a `slackId` field to their entry in `data/roster.json` — see `data/roster.example.json`.

---

## 5. File overview

```
dashboard/
├── server.js              # Express server + API (fetches Jira/Confluence, serves the dashboard)
├── public/index.html       # The dashboard UI (based on the design you provided)
├── data/store.json         # Auto-created — manual signals + "discussed" status
├── data/roster.json         # Optional — your own names/roles/colors override
├── package.json
├── .env.example
```
