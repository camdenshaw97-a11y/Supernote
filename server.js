'use strict';

/**
 * Nomad Bridge relay.
 *
 * The Supernote plugin sends handwriting here. This service asks Claude to
 * clean it up, files it in the right app, and tells the plugin what it did.
 *
 * No dependencies: Node 20+ only.
 *
 * Environment variables:
 *   RELAY_SECRET       required  shared secret the plugin sends in x-relay-secret
 *   ANTHROPIC_API_KEY  optional  without it, the tablet's own reading is used as-is
 *   CLAUDE_MODEL       optional  default claude-sonnet-5-5
 *   ANTHROPIC_BASE_URL optional  only for testing against a stand-in server
 *   CLICKUP_TOKEN      required for ClickUp captures (personal API token, pk_...)
 *   CLICKUP_LIST_ID    required for ClickUp captures
 *   TIMEZONE           optional  default America/Los_Angeles
 *   DRY_RUN            optional  "1" = do everything except create the task
 *   CALENDAR_ICS_URL   required for the Meeting button: the calendar's
 *                      "Secret address in iCal format" from Google Calendar
 *   MY_EMAIL           optional  hides you from attendee lists and skips
 *                      meetings you declined
 *   FAKE_NOW           optional  only for testing: pretend it is this time
 *   PORT               set by the host
 */

const http = require('http');
const crypto = require('crypto');
const ical = require('node-ical');

const VERSION = '0.2.0';
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CLAUDE_TIMEOUT_MS = 25000;
const CLICKUP_TIMEOUT_MS = 15000;
const CALENDAR_TIMEOUT_MS = 15000;
const CALENDAR_CACHE_MS = 60 * 1000;
const MEETING_LOOKAHEAD_MS = 36 * 60 * 60 * 1000;
const MEETING_GRACE_MS = 10 * 60 * 1000;
const MAX_MEETINGS = 8;
const MAX_ATTENDEES = 8;

function env(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

/** Constant-time comparison so the secret cannot be guessed by timing. */
function secretMatches(given) {
  const expected = env('RELAY_SECRET');
  if (!expected || typeof given !== 'string') {
    return false;
  }
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request too large'), {status: 413}));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(Object.assign(new Error('Body is not valid JSON'), {status: 400}));
      }
    });
    req.on('error', reject);
  });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

/** Today's date and weekday in the user's timezone, for resolving "by Friday". */
function todayInTimezone() {
  const tz = env('TIMEZONE', 'America/Los_Angeles');
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', {timeZone: tz, weekday: 'long'}).format(now);
  return {date, weekday, tz};
}

/** Pulls the first JSON object out of a model reply. */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('No JSON object in the reply');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Asks Claude to turn the handwriting into a clean task.
 * Returns {title, details, dueDate} or throws.
 */
async function cleanUpWithClaude({text, imageBase64}) {
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  const today = todayInTimezone();

  const system = [
    'You turn a handwritten note into one task for a to-do list.',
    'You receive a picture of the handwriting and a rough machine reading of it.',
    'Trust the picture over the machine reading when they disagree.',
    'Keep the writer\'s meaning and wording. Fix obvious misreadings and spelling. Do not add steps, people or details that are not written.',
    `Today is ${today.weekday}, ${today.date} (${today.tz}).`,
    'Reply with a single JSON object and nothing else:',
    '{"title": string, "details": string, "due_date": string|null}',
    '- title: the task in one short line, starting with a verb when the note allows it, at most 80 characters.',
    '- details: anything written that does not fit in the title, otherwise an empty string.',
    '- due_date: YYYY-MM-DD if the note states a date or day (resolve a weekday to its next occurrence, today counts), otherwise null.',
  ].join('\n');

  const content = [];
  if (imageBase64) {
    content.push({
      type: 'image',
      source: {type: 'base64', media_type: 'image/png', data: imageBase64},
    });
  }
  content.push({
    type: 'text',
    text: `Machine reading of the handwriting:\n${text || '(none)'}`,
  });

  const res = await fetchWithTimeout(
    `${env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env('CLAUDE_MODEL', 'claude-sonnet-5-5'),
        max_tokens: 400,
        system,
        messages: [{role: 'user', content}],
      }),
    },
    CLAUDE_TIMEOUT_MS,
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const reply = (data.content || [])
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');
  const parsed = extractJson(reply);
  const title = String(parsed.title || '').trim();
  if (!title) {
    throw new Error('Claude returned an empty title');
  }
  return {
    title: title.slice(0, 200),
    details: String(parsed.details || '').trim(),
    dueDate: isIsoDate(parsed.due_date) ? parsed.due_date : null,
  };
}

/** Uses the tablet's own reading when Claude is unavailable. */
function fallbackTask(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    throw Object.assign(new Error('Nothing readable in the selection'), {status: 422});
  }
  return {title: clean.slice(0, 200), details: '', dueDate: null};
}

function sourceLine({notePath, page}) {
  if (!notePath) {
    return 'Captured from Supernote.';
  }
  const name = String(notePath).split('/').pop().replace(/\.note$/i, '');
  const pageText = Number.isInteger(page) ? `, page ${page}` : '';
  return `Captured from Supernote: ${name}${pageText}.`;
}

async function createClickUpTask({task, rawText, notePath, page}) {
  const descriptionParts = [];
  if (task.details) {
    descriptionParts.push(task.details);
  }
  if (rawText && rawText.trim() && rawText.trim() !== task.title) {
    descriptionParts.push(`Tablet's reading: ${rawText.trim()}`);
  }
  descriptionParts.push(sourceLine({notePath, page}));

  const body = {name: task.title, description: descriptionParts.join('\n\n')};
  if (task.dueDate) {
    // Noon UTC keeps the date on the same calendar day across US timezones.
    const [y, m, d] = task.dueDate.split('-').map(Number);
    body.due_date = Date.UTC(y, m - 1, d, 12, 0, 0);
    body.due_date_time = false;
  }

  if (env('DRY_RUN') === '1') {
    return {id: 'dry-run', url: null, dryRun: true};
  }

  const token = env('CLICKUP_TOKEN');
  const listId = env('CLICKUP_LIST_ID');
  if (!token || !listId) {
    throw Object.assign(new Error('CLICKUP_TOKEN or CLICKUP_LIST_ID is not set'), {status: 500});
  }

  const res = await fetchWithTimeout(
    `https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}/task`,
    {
      method: 'POST',
      headers: {'content-type': 'application/json', Authorization: token},
      body: JSON.stringify(body),
    },
    CLICKUP_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`ClickUp ${res.status}: ${text.slice(0, 300)}`), {status: 502});
  }
  const data = await res.json();
  return {id: data.id, url: data.url || null, dryRun: false};
}

/** Short typed line the plugin writes under the handwriting. */
function receiptLine(destinationLabel, task) {
  let line = `${destinationLabel}: ${task.title}`;
  if (task.dueDate) {
    const [y, m, d] = task.dueDate.split('-').map(Number);
    const label = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(Date.UTC(y, m - 1, d, 12)));
    line += ` (due ${label})`;
  }
  return line;
}

async function handleCapture(body) {
  const destination = String(body.destination || 'clickup').toLowerCase();
  if (destination !== 'clickup') {
    throw Object.assign(new Error(`Destination "${destination}" is not set up yet`), {status: 400});
  }
  const rawText = typeof body.text === 'string' ? body.text : '';
  const imageBase64 = typeof body.imageBase64 === 'string' && body.imageBase64 ? body.imageBase64 : null;
  if (!rawText.trim() && !imageBase64) {
    throw Object.assign(new Error('Send text, a picture, or both'), {status: 400});
  }

  let task;
  let usedAI = true;
  let aiError = null;
  try {
    task = await cleanUpWithClaude({text: rawText, imageBase64});
  } catch (e) {
    usedAI = false;
    aiError = e.message;
    console.warn('Claude cleanup failed, using the tablet reading:', e.message);
    task = fallbackTask(rawText);
  }

  const created = await createClickUpTask({
    task,
    rawText,
    notePath: body.notePath,
    page: body.page,
  });

  return {
    ok: true,
    destination,
    title: task.title,
    dueDate: task.dueDate,
    receipt: receiptLine('ClickUp', task),
    id: created.id,
    url: created.url,
    usedAI,
    aiError,
    dryRun: created.dryRun,
  };
}

// ---------------------------------------------------------------------------
// Meetings (calendar)
// ---------------------------------------------------------------------------

let calendarCache = {at: 0, url: '', data: null};

function currentTime() {
  const fake = env('FAKE_NOW');
  const parsed = fake ? new Date(fake) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}

async function loadCalendar() {
  const url = env('CALENDAR_ICS_URL');
  if (!url) {
    throw Object.assign(new Error('CALENDAR_ICS_URL is not set on the relay'), {status: 500});
  }
  const age = Date.now() - calendarCache.at;
  if (calendarCache.data && calendarCache.url === url && age < CALENDAR_CACHE_MS) {
    return calendarCache.data;
  }
  const res = await fetchWithTimeout(url, {method: 'GET'}, CALENDAR_TIMEOUT_MS);
  if (!res.ok) {
    throw Object.assign(new Error(`Calendar answered with HTTP ${res.status}`), {status: 502});
  }
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw Object.assign(new Error('The calendar address did not return a calendar'), {status: 502});
  }
  const data = ical.sync.parseICS(text);
  calendarCache = {at: Date.now(), url, data};
  return data;
}

function tzParts(date) {
  const tz = env('TIMEZONE', 'America/Los_Angeles');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const get = type => (parts.find(p => p.type === type) || {}).value || '';
  const isoDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return {
    weekday: get('weekday'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    meridiem: get('dayPeriod').toUpperCase(),
    isoDay,
  };
}

/** "10:00-10:30 AM" or "11:30 AM-12:15 PM". Plain hyphen so any font shows it. */
function timeRangeLabel(start, end) {
  const a = tzParts(start);
  const b = tzParts(end);
  const from = `${a.hour}:${a.minute}`;
  const to = `${b.hour}:${b.minute} ${b.meridiem}`;
  return a.meridiem === b.meridiem ? `${from}-${to}` : `${from} ${a.meridiem}-${to}`;
}

function dayLabel(date) {
  const p = tzParts(date);
  return `${p.weekday}, ${p.month} ${p.day}`;
}

function plainText(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'object') {
    return String(value.val == null ? '' : value.val);
  }
  return String(value);
}

function attendeeList(event) {
  const raw = event.attendee;
  if (!raw) {
    return [];
  }
  return (Array.isArray(raw) ? raw : [raw]).map(entry => {
    const params = (entry && entry.params) || {};
    const email = plainText(entry).replace(/^mailto:/i, '').trim().toLowerCase();
    let name = String(params.CN || '').trim();
    if (!name || name.includes('@')) {
      name = (name || email).split('@')[0];
    }
    return {
      name,
      email,
      status: String(params.PARTSTAT || '').toUpperCase(),
      isResource: String(params.CUTYPE || '').toUpperCase() === 'RESOURCE',
    };
  });
}

/** A name that is safe to use as a file name on the tablet. */
function safeFileName(text) {
  const clean = String(text)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '');
  return clean.slice(0, 60).trim() || 'Meeting';
}

async function upcomingMeetings() {
  const data = await loadCalendar();
  const now = currentTime();
  const from = new Date(now.getTime() - MEETING_GRACE_MS);
  const to = new Date(now.getTime() + MEETING_LOOKAHEAD_MS);
  const myEmail = env('MY_EMAIL').toLowerCase();
  const found = [];

  for (const event of Object.values(data)) {
    if (!event || event.type !== 'VEVENT') {
      continue;
    }
    let instances;
    try {
      instances = ical.expandRecurringEvent(event, {from, to, expandOngoing: true});
    } catch (e) {
      console.warn('Skipping an event that could not be expanded:', e.message);
      continue;
    }
    for (const instance of instances) {
      const source = instance.event || event;
      if (instance.isFullDay) {
        continue;
      }
      if (String(source.status || '').toUpperCase() === 'CANCELLED') {
        continue;
      }
      const start = new Date(instance.start);
      const end = new Date(instance.end || instance.start);
      if (end.getTime() <= from.getTime() || start.getTime() > to.getTime()) {
        continue;
      }
      const people = attendeeList(source);
      if (myEmail && people.some(p => p.email === myEmail && p.status === 'DECLINED')) {
        continue;
      }
      const names = people
        .filter(p => !p.isResource && p.status !== 'DECLINED' && (!myEmail || p.email !== myEmail))
        .map(p => p.name);
      const shown = names.slice(0, MAX_ATTENDEES);
      if (names.length > shown.length) {
        shown.push(`+${names.length - shown.length} more`);
      }

      const title = plainText(instance.summary || source.summary).trim() || '(No title)';
      const day = dayLabel(start);
      const time = timeRangeLabel(start, end);
      const header = [title, `${day}, ${time}`];
      if (shown.length > 0) {
        header.push(`With: ${shown.join(', ')}`);
      }
      found.push({
        id: `${plainText(source.uid)}|${start.toISOString()}`,
        title,
        start: start.toISOString(),
        end: end.toISOString(),
        day,
        time,
        isNow: start.getTime() <= now.getTime() && now.getTime() < end.getTime(),
        startsInMinutes: Math.round((start.getTime() - now.getTime()) / 60000),
        attendees: shown,
        fileName: safeFileName(`${tzParts(start).isoDay} ${title}`),
        header,
      });
    }
  }

  found.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return {
    ok: true,
    now: now.toISOString(),
    today: dayLabel(now),
    events: found.slice(0, MAX_MEETINGS),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      // Open on purpose: lets the host and the plugin check the service is awake.
      return sendJson(res, 200, {ok: true, service: 'nomad-bridge-relay', version: VERSION});
    }

    if (!secretMatches(req.headers['x-relay-secret'])) {
      return sendJson(res, 401, {ok: false, error: 'Wrong or missing relay secret'});
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        claude: Boolean(env('ANTHROPIC_API_KEY')),
        clickup: Boolean(env('CLICKUP_TOKEN') && env('CLICKUP_LIST_ID')),
        calendar: Boolean(env('CALENDAR_ICS_URL')),
        dryRun: env('DRY_RUN') === '1',
        today: todayInTimezone(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/meeting/upcoming') {
      return sendJson(res, 200, await upcomingMeetings());
    }

    if (req.method === 'POST' && url.pathname === '/capture') {
      const body = await readJsonBody(req);
      const result = await handleCapture(body);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, {ok: false, error: 'Not found'});
  } catch (e) {
    const status = Number.isInteger(e.status) ? e.status : 500;
    console.error(`${req.method} ${url.pathname} failed:`, e.message);
    return sendJson(res, status, {ok: false, error: e.message});
  }
});

if (!env('RELAY_SECRET')) {
  console.warn('RELAY_SECRET is not set: every request except /health will be rejected.');
}

server.listen(PORT, () => {
  console.log(`nomad-bridge-relay ${VERSION} listening on ${PORT}`);
});
