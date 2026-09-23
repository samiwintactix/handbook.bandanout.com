import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import fssync from 'fs';
import crypto from 'crypto';
import { Redis } from '@upstash/redis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

const JIRA_SITE = process.env.JIRA_SITE || 'https://wintactix-sandbox.atlassian.net';
const CONFLUENCE_SITE = process.env.CONFLUENCE_SITE || 'https://wintactix-com.atlassian.net';
const CONFLUENCE_PAGE_ID = process.env.CONFLUENCE_PAGE_ID || '56524801';
const CONFLUENCE_SPACE_KEY = process.env.CONFLUENCE_SPACE_KEY || 'CHE';

const ATLASSIAN_EMAIL = process.env.ATLASSIAN_EMAIL;
const ATLASSIAN_API_TOKEN = process.env.ATLASSIAN_API_TOKEN;
const SLACK_SIGNAL_TOKEN = process.env.SLACK_SIGNAL_TOKEN;

const FLAG_MARKER = '\u200B\u200C\u200B';

if (!ATLASSIAN_EMAIL || !ATLASSIAN_API_TOKEN) {
  console.warn('Warning: ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN are not set. Set them in your .env file.');
}
if (!SLACK_SIGNAL_TOKEN) {
  console.warn('Warning: SLACK_SIGNAL_TOKEN is not set. POST /api/signals/slack will reject all requests until it is.');
}

function authHeader() {
  const auth = Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${auth}`, Accept: 'application/json' };
}

// Constant-time so a mistyped/probing token doesn't leak timing info
function safeTokenMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- Persistence (manual signals + Slack signals + discussed overrides) ----------
//
// Vercel's filesystem is read-only/ephemeral in production, so a plain JSON
// file can't survive there — when a Redis integration is connected (its env
// vars are present), that's used instead. Local dev with no Redis set up
// keeps using the local JSON file, so `npm start` still works unchanged.
// Supports both the legacy Vercel KV env var names and native Upstash ones,
// since either may be what a "Connect Store" integration injects.

const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const STORE_KV_KEY = 'bandanout:store';
const EMPTY_STORE = { manualSignals: [], slackSignals: [], discussedIds: [] };

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useKv = !!(REDIS_URL && REDIS_TOKEN);
const redis = useKv ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

async function loadStore() {
  if (useKv) {
    const data = await redis.get(STORE_KV_KEY);
    return data || { ...EMPTY_STORE };
  }
  if (!fssync.existsSync(STORE_PATH)) {
    return { ...EMPTY_STORE };
  }
  try {
    return JSON.parse(fssync.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return { ...EMPTY_STORE };
  }
}

async function saveStore(store) {
  if (useKv) {
    await redis.set(STORE_KV_KEY, store);
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

// ---------- Confluence: expectations ----------

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

// Parses one page's HTML, scoped to the single element containing
// "Expectation:" (paragraph, list item, table cell, or heading) — never
// reads past that element's own closing tag, so text can't merge with
// the next item.
function parseExpectationsFromPage(html, pageTitle, pageLink, seen) {
  const expectations = [];
  const blockRegex = /<(p|li|td|h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;

  while ((match = blockRegex.exec(html)) !== null) {
    const innerHtml = match[2];
    const text = innerHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    if (text.startsWith('Expectation:')) {
      let title = text.replace('Expectation:', '').trim();
      const periodIndex = title.indexOf('.');
      if (periodIndex > -1 && periodIndex < 90) {
        title = title.slice(0, periodIndex).trim();
      } else if (title.length > 110) {
        title = `${title.slice(0, 110).trim()}…`;
      }
      if (!title) continue;

      let id = slugify(title);
      let suffix = 1;
      while (seen.has(id)) {
        id = `${slugify(title)}-${suffix++}`;
      }
      seen.add(id);
      expectations.push({
        id,
        title,
        short: title.length > 42 ? `${title.slice(0, 39)}...` : title,
        category: pageTitle,
        url: pageLink
      });
    }
  }

  return expectations;
}

// Fetches every page in the space in one call and parses each for expectations
async function fetchExpectations() {
  const res = await fetch(
    `${CONFLUENCE_SITE}/wiki/rest/api/content?spaceKey=${CONFLUENCE_SPACE_KEY}&type=page&limit=100&expand=body.storage`,
    { headers: authHeader() }
  );
  if (!res.ok) throw new Error(`Confluence fetch failed: ${res.status}`);
  const data = await res.json();
  const pages = data.results || [];

  const seen = new Set();
  let expectations = [];

  for (const page of pages) {
    const html = page.body?.storage?.value || '';
    const pageLink = `${CONFLUENCE_SITE}/wiki/spaces/${CONFLUENCE_SPACE_KEY}/pages/${page.id}`;
    expectations = expectations.concat(parseExpectationsFromPage(html, page.title, pageLink, seen));
  }

  return expectations;
}

// ---------- Jira: flagged signals ----------

const displayNameCache = {};

async function getDisplayName(accountId) {
  if (!accountId) return null;
  if (displayNameCache[accountId]) return displayNameCache[accountId];
  try {
    const res = await fetch(`${JIRA_SITE}/rest/api/3/user?accountId=${accountId}`, { headers: authHeader() });
    const data = await res.json();
    displayNameCache[accountId] = data.displayName || accountId;
  } catch {
    displayNameCache[accountId] = accountId;
  }
  return displayNameCache[accountId];
}

function personIdFor(accountId, name) {
  return accountId || slugify(name || 'unknown');
}

function readParagraphMentionsAndText(paragraph) {
  const mentionIds = [];
  let text = '';
  let boldText = '';
  (paragraph?.content || []).forEach((node) => {
    if (node.type === 'mention' && node.attrs?.id) mentionIds.push(node.attrs.id);
    if (node.type === 'text') {
      text += node.text;
      if (node.marks?.some((m) => m.type === 'strong')) boldText = node.text;
    }
  });
  return { mentionIds, text, boldText };
}

async function fetchJiraSignals(expectations) {
  const searchRes = await fetch(
    `${JIRA_SITE}/rest/api/3/search/jql?jql=${encodeURIComponent('labels="bandanout-flagged" ORDER BY updated DESC')}&fields=summary,key&maxResults=100`,
    { headers: authHeader() }
  );
  if (!searchRes.ok) throw new Error(`Jira search failed: ${searchRes.status}`);
  const searchData = await searchRes.json();
  const issues = searchData.issues || [];

  const signals = [];
  const peopleMap = new Map();

  for (const issue of issues) {
    const commentsRes = await fetch(
      `${JIRA_SITE}/rest/api/3/issue/${issue.id}/comment?orderBy=-created&maxResults=50`,
      { headers: authHeader() }
    );
    if (!commentsRes.ok) continue;
    const commentsData = await commentsRes.json();
    const comments = commentsData.comments || [];

    for (const comment of comments) {
      const paragraphs = comment.body?.content || [];
      const first = readParagraphMentionsAndText(paragraphs[0]);
      if (!first.text.includes(FLAG_MARKER)) continue;

      // Two known comment shapes, both starting with the flag marker:
      //  - single paragraph: "Hey @assignee! ... **title** ... Flagged by @flagger"
      //    (mentions in order [assignee, flagger], bold title in the same paragraph)
      //  - two paragraphs: para 1 "Flagged by @flagger for @assignee" (mentions
      //    REVERSED: [flagger, assignee]), para 2 "...may not have followed: **title**"
      let assigneeId, flaggerId, expectationTitle;
      if (first.boldText) {
        assigneeId = first.mentionIds[0] || null;
        flaggerId = first.mentionIds[1] || null;
        expectationTitle = first.boldText;
      } else {
        flaggerId = first.mentionIds[0] || null;
        assigneeId = first.mentionIds[1] || null;
        expectationTitle = readParagraphMentionsAndText(paragraphs[1]).boldText;
      }

      const [assigneeName, flaggerName] = await Promise.all([
        getDisplayName(assigneeId),
        getDisplayName(flaggerId)
      ]);

      if (!assigneeId) continue; // no assignee to attribute the signal to

      if (!peopleMap.has(assigneeId)) {
        peopleMap.set(assigneeId, { id: assigneeId, name: assigneeName || 'Unknown' });
      }

      const expectationId = resolveExpectationByTitle(expectations, expectationTitle);

      signals.push({
        id: `jira-${issue.key}-${comment.id}`,
        personId: assigneeId,
        expectationId,
        source: 'jira',
        reference: issue.key,
        note: '',
        date: comment.created,
        by: flaggerName || 'Unknown',
        status: 'open'
      });
    }
  }

  return { signals, people: [...peopleMap.values()] };
}

// ---------- Team roster (optional local overrides for role/capacity/color) ----------

const ROSTER_PATH = path.join(DATA_DIR, 'roster.json');
const COLORS = ['', 'c2', 'c3', 'c4', 'c5'];

function loadRosterOverrides() {
  if (!fssync.existsSync(ROSTER_PATH)) return {};
  try {
    return JSON.parse(fssync.readFileSync(ROSTER_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

// Unifies a Slack user with their Jira identity: if a roster entry declares
// `slackId` matching this user, its key (the same personId used for that
// person's Jira signals) is reused so signals aggregate on one team member.
// Otherwise falls back to a slack-scoped id derived from their display name.
function personIdForSlackUser(slackUserId, slackUserName, roster) {
  for (const [key, override] of Object.entries(roster)) {
    if (override.slackId && override.slackId === slackUserId) return key;
  }
  return `slack-${slugify(slackUserName || slackUserId || 'unknown')}`;
}

// Matches a free-text expectation title (from Jira comments or Slack) against
// the live Confluence-parsed list, creating an ad-hoc entry if none matches.
function resolveExpectationByTitle(expectations, title) {
  const expectation = expectations.find((e) => e.title === title);
  if (expectation) return expectation.id;

  const id = slugify(title || 'unknown');
  if (title && !expectations.some((e) => e.id === id)) {
    expectations.push({
      id,
      title,
      short: title.length > 42 ? `${title.slice(0, 39)}...` : title,
      category: 'Other',
      url: `${CONFLUENCE_SITE}/wiki/spaces/${CONFLUENCE_SPACE_KEY}/overview`
    });
  }
  return id;
}

function buildTeam(peopleFromJira, roster) {
  return peopleFromJira.map((person, idx) => {
    const override = roster[person.id] || roster[person.name] || {};
    return {
      id: person.id,
      name: override.name || person.name,
      initials: override.initials || initials(override.name || person.name),
      role: override.role || 'Team member',
      capacity: override.capacity || 'Team member',
      color: override.color || COLORS[idx % COLORS.length]
    };
  });
}

// Jira hides email addresses for most accounts on this site, so an actual
// email-domain filter isn't possible via the API. Instead, data/roster.json
// entries can set `hidden: true` to exclude a specific person (e.g. a test
// account) from the dashboard — everyone else shows by default.
function isHidden(personId, personName, roster) {
  const override = roster[personId] || roster[personName];
  return !!override?.hidden;
}

// ---------- API ----------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const store = await loadStore();
    const roster = loadRosterOverrides();

    const expectations = await fetchExpectations();
    const { signals: jiraSignals, people } = await fetchJiraSignals(expectations);

    const visiblePeople = people.filter((p) => !isHidden(p.id, p.name, roster));
    const team = buildTeam(visiblePeople, roster);

    const discussedSet = new Set(store.discussedIds || []);
    const jiraSignalsWithStatus = jiraSignals
      .filter((s) => team.some((t) => t.id === s.personId))
      .map((s) => ({
        ...s,
        status: discussedSet.has(s.id) ? 'discussed' : 'open'
      }));

    const manualSignals = (store.manualSignals || [])
      .filter((s) => !isHidden(s.personId, s.personName, roster))
      .map((s) => ({
        ...s,
        status: discussedSet.has(s.id) ? 'discussed' : s.status
      }));

    const slackSignals = (store.slackSignals || [])
      .filter((s) => !isHidden(s.personId, s.personName, roster))
      .map((s) => ({
        ...s,
        expectationId: resolveExpectationByTitle(expectations, s.expectationTitle),
        status: discussedSet.has(s.id) ? 'discussed' : s.status
      }));

    // Make sure every manual/slack signal's person exists in team (fallback entry)
    [...manualSignals, ...slackSignals].forEach((s) => {
      if (!team.find((t) => t.id === s.personId)) {
        const name = s.personName || s.personId;
        team.push({
          id: s.personId,
          name,
          initials: initials(name),
          role: 'Team member',
          capacity: 'Team member',
          color: COLORS[team.length % COLORS.length]
        });
      }
    });

    const signals = [...jiraSignalsWithStatus, ...manualSignals, ...slackSignals];

    res.json({ team, expectations, signals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/signals', async (req, res) => {
  try {
    const { personId, expectationId, source, reference, note, notify } = req.body;
    const store = await loadStore();

    const id = `manual-${Date.now()}`;
    const signal = {
      id,
      personId,
      expectationId,
      source,
      reference,
      note,
      date: new Date().toISOString(),
      by: 'Dashboard',
      status: 'open'
    };

    store.manualSignals = store.manualSignals || [];
    store.manualSignals.unshift(signal);
    await saveStore(store);

    // Optional: if notify + source is jira + reference looks like an issue key, post a real comment
    if (notify && source === 'jira' && /^[A-Z][A-Z0-9]+-\d+$/.test(reference || '')) {
      try {
        const expectations = await fetchExpectations();
        const expectation = expectations.find((e) => e.id === expectationId);
        const link = expectation
          ? expectation.url
          : `${CONFLUENCE_SITE}/wiki/spaces/${CONFLUENCE_SPACE_KEY}/overview`;
        const title = expectation ? expectation.title : expectationId;

        const commentBody = {
          body: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: `${FLAG_MARKER}Hey! It looks like there's a chance to improve: ` },
                  { type: 'text', text: title, marks: [{ type: 'strong' }] },
                  { type: 'text', text: '. ' },
                  { type: 'text', text: 'Have a read of it again over here', marks: [{ type: 'link', attrs: { href: link } }] },
                  { type: 'text', text: '. Flagged via the Bandanout dashboard.' }
                ]
              }
            ]
          }
        };

        await fetch(`${JIRA_SITE}/rest/api/3/issue/${reference}/comment`, {
          method: 'POST',
          headers: { ...authHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify(commentBody)
        });

        await fetch(`${JIRA_SITE}/rest/api/3/issue/${reference}`, {
          method: 'PUT',
          headers: { ...authHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ update: { labels: [{ add: 'bandanout-flagged' }] } })
        });
      } catch (err) {
        console.error('Failed to post Jira comment from dashboard:', err);
      }
    }

    res.json({ signal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/signals/discuss', async (req, res) => {
  try {
    const { ids } = req.body;
    const store = await loadStore();
    store.discussedIds = [...new Set([...(store.discussedIds || []), ...(ids || [])])];
    await saveStore(store);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Intake for the Slack bot: it posts here whenever someone flags a teammate
// in Slack, so that signal shows up alongside Jira/manual ones.
app.post('/api/signals/slack', async (req, res) => {
  try {
    if (!SLACK_SIGNAL_TOKEN) {
      return res.status(503).json({ error: 'Slack signal intake not configured (SLACK_SIGNAL_TOKEN not set)' });
    }
    if (!safeTokenMatch(req.get('X-Bandanout-Token'), SLACK_SIGNAL_TOKEN)) {
      return res.status(401).json({ error: 'Invalid or missing X-Bandanout-Token' });
    }

    const { channel, ts, slackUserId, slackUserName, flaggedByName, expectationTitle, note, permalink } = req.body || {};
    if (!channel || !ts || !slackUserId || !expectationTitle) {
      return res.status(400).json({ error: 'channel, ts, slackUserId, and expectationTitle are required' });
    }

    const store = await loadStore();
    store.slackSignals = store.slackSignals || [];

    // Deterministic id so Slack's at-least-once delivery (retries) can't double-log
    const id = `slack-${channel}-${slackUserId}-${ts}`;
    const existing = store.slackSignals.find((s) => s.id === id);
    if (existing) {
      return res.json({ signal: existing, deduped: true });
    }

    const roster = loadRosterOverrides();
    const signal = {
      id,
      personId: personIdForSlackUser(slackUserId, slackUserName, roster),
      personName: slackUserName || null,
      expectationTitle,
      source: 'slack',
      reference: permalink || channel,
      note: note || '',
      date: new Date().toISOString(),
      by: flaggedByName || 'Slack',
      status: 'open'
    };

    store.slackSignals.unshift(signal);
    await saveStore(store);

    res.json({ signal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/healthz', (req, res) => res.send('ok'));

// Vercel imports `app` directly as a request handler (see api/index.js) instead
// of running this file, so only listen when started directly (`npm start`).
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Bandanout dashboard running on http://localhost:${PORT}`);
  });
}

export default app;
