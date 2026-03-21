// background.js — Woffle service worker.
// Handles transcript fetching from YouTube, chunking, and direct Claude API
// calls for AI classification. BYOK model — user provides their own
// Anthropic API key, stored in chrome.storage.sync.
//
// Two-pass architecture:
//   Pass 1 (Quick): Haiku scans first 90s for instant intro skip (~1-2s)
//   Pass 2 (Full):  Sonnet streams full analysis via SSE (~10-15s)
// Both fire simultaneously on SCAN. Segments forwarded to content script
// incrementally as they arrive.

// ============================================================
// Models + API config
// ============================================================

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-5-20250929';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// ============================================================
// Prompts — copied verbatim from worker/src/services/claude.ts
// ============================================================

const QUICK_INTRO_PROMPT = `You detect where a YouTube video's actual content begins.
The intro typically contains: greetings, pleasantries, weather chat,
"hope you're doing well", sponsor reads, "before we get into it" padding,
channel branding, subscribe requests.

Given the first 90 seconds of transcript, find where the REAL CONTENT
starts — the first moment the speaker discusses the actual video topic.

Respond with ONLY this JSON (no other text):
{"intro_ends_at": <seconds>, "intro_type": "pleasantries|sponsor|branding|none", "topic_starts": "brief description of what the real content is about"}

If the video jumps straight into content with no intro padding,
respond: {"intro_ends_at": 0, "intro_type": "none", "topic_starts": "..."}`;

const FULL_SYSTEM_PROMPT = `You analyse YouTube video transcripts to detect filler content ("woffle") — anything that wastes the viewer's time.

STEP 1: Read the video title and full transcript. Identify the VIDEO TOPIC in one sentence. This is your anchor — everything is judged against it.

STEP 2: Create natural segments based on content shifts (NOT fixed time intervals). Each segment should be one coherent block: a greeting, an anecdote, a teaching section, a sponsor read, etc. Segments can be 10 seconds to several minutes.

STEP 3: Score each segment's woffle_confidence (0-100):

95-100 DEFINITE WOFFLE:
- Sponsor reads, ad segments, paid promotions
- "Like and subscribe", "hit the bell", "leave a comment below"
- Patreon, merch, social media plugs
- Channel branding intros/outros with zero content

85-94 STRONG WOFFLE:
- Generic pleasantries: "hope you're having a great day", weather chat, "how's everyone doing"
- Personal life updates unrelated to topic: what they ate, their commute, weekend plans
- "Before we get into it..." padding that doesn't get into anything
- Repetition of something already covered (same point rephrased)
- Thanking other creators, shoutouts unrelated to content
- Co-host reactions that add nothing: "wow", "that's crazy", "yeah totally", "right right right"
- Co-host echoing/rephrasing what the main speaker just said without new information
- Co-host tangents and musings that nobody came to hear

70-84 PROBABLE WOFFLE:
- Personal anecdotes entertaining but not advancing the topic
- Extended examples repeating a point already made
- Off-topic digressions that eventually circle back
- Overly long context-setting that could be 80% shorter

50-69 BORDERLINE:
- Background context some viewers want, others don't
- Stories illustrating the point but taking too long
- Slow introductions of people/concepts needed later

25-49 MOSTLY SUBSTANCE:
- On-topic but slightly verbose or meandering
- Good content with minor padding

0-24 PURE SUBSTANCE:
- Core content directly about the video topic
- Key stories that ARE the content
- Essential context, conclusions, actionable takeaways
- Questions from interviewer/co-host that genuinely advance the conversation

PODCAST/INTERVIEW RULES:
- Identify the PRIMARY speaker (guest, expert, storyteller). Their on-topic content is almost always substance.
- Co-hosts/interviewers who merely react, echo, or rephrase = woffle (85-90).
- Co-hosts who ask NEW questions or introduce NEW information = substance.
- Test: if you removed this segment, would the viewer miss any information? If no → woffle.

CRITICAL RULES:
- Be AGGRESSIVE about detecting woffle. Viewers came for the topic, not padding.
- A typical 10-minute video has 2-4 minutes of woffle. If you find zero, you're too lenient.
- Every second of the video must be covered — no gaps between segments.
- Merge adjacent segments with similar scores (within 10 points).
- Create your own segment boundaries based on natural content shifts — do NOT use fixed-length segments. A segment should be one coherent block of content: a complete anecdote, a sponsor read, a greeting sequence, a teaching section, etc. Segments can range from 10 seconds to several minutes depending on content.

Classify each segment's category (exactly one):
- "sponsor" — paid promotion or ad read
- "self_promo" — subscribe, bell, merch, patreon, social plugs
- "pleasantries" — greetings, weather, hope you're well, generic chat
- "tangent" — off-topic story or digression
- "repetition" — restating something already covered
- "cohost_echo" — co-host repeating, reacting, or echoing without substance
- "filler" — ums, dead air, "so yeah", padding words
- "intro_outro" — channel branding, opening/closing sequences with no content
- "context" — background info, setup for the main topic
- "substance" — core content about the video topic

Respond ONLY with valid JSON. No markdown, no explanation, no preamble.

Format:
{"video_topic": "one sentence about what this video covers", "segments": [{"start": 0, "end": 45, "woffle_confidence": 92, "category": "pleasantries", "label": "Host greets viewers and chats about the weather"}, ...]}`;

// ============================================================
// License key config
// ============================================================
// Format: WOFFLE-XXXX-XXXX-XXXX-XXXX (alphanumeric groups)
// Pre-launch: any key matching the format is accepted as valid.
// Post-launch: we'll swap this for a Gumroad/LemonSqueezy API call,
// re-using the same storage key and 7-day re-validation interval.

const LICENSE_KEY_REGEX = /^WOFFLE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const FREE_DAILY_LIMIT = 3;
const LICENSE_REVALIDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ============================================================
// Extension lifecycle
// ============================================================

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Woffle] Extension installed/updated, reason:', details.reason);
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

// ============================================================
// API key helper — read from chrome.storage.sync
// ============================================================

async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('anthropicApiKey', (result) => {
      resolve(result.anthropicApiKey || null);
    });
  });
}

// ============================================================
// License key helpers
// ============================================================

// Read the stored license validation record from chrome.storage.sync.
// Returns { key, valid, validatedAt } or null.
async function getLicenseRecord() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('woffleLicenseRecord', (result) => {
      resolve(result.woffleLicenseRecord || null);
    });
  });
}

// Check if the user has a currently-valid license.
// Re-validates on a 7-day schedule for future server-side checks.
async function hasValidLicense() {
  const record = await getLicenseRecord();
  if (!record || !record.valid || !record.key) return false;

  // Re-validate if the record is older than the revalidation interval.
  // Pre-launch: re-validation just re-checks the format (always passes).
  // Post-launch: swap for a Gumroad/LemonSqueezy API call here.
  const age = Date.now() - (record.validatedAt || 0);
  if (age > LICENSE_REVALIDATE_INTERVAL_MS) {
    const stillValid = LICENSE_KEY_REGEX.test(record.key);
    await chrome.storage.sync.set({
      woffleLicenseRecord: { ...record, valid: stillValid, validatedAt: Date.now() }
    });
    return stillValid;
  }

  return true;
}

// Validate a license key string. Returns { valid, key }.
// Pre-launch: accepts any key matching the WOFFLE-XXXX-XXXX-XXXX-XXXX format.
function validateLicenseFormat(key) {
  if (!key || typeof key !== 'string') return { valid: false, key };
  return { valid: LICENSE_KEY_REGEX.test(key.trim().toUpperCase()), key: key.trim().toUpperCase() };
}

// ============================================================
// Daily usage helpers — stored in chrome.storage.local
// ============================================================
// Resets each calendar day. Cache hits do NOT count toward the limit —
// only fresh API calls do. Format: { count: 2, date: '2026-03-21' }

function todayString() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

async function getDailyUsage() {
  return new Promise((resolve) => {
    chrome.storage.local.get('woffle_daily_usage', (result) => {
      const usage = result.woffle_daily_usage;
      const today = todayString();
      if (!usage || usage.date !== today) {
        resolve({ count: 0, date: today });
      } else {
        resolve(usage);
      }
    });
  });
}

async function incrementDailyUsage() {
  const current = await getDailyUsage();
  const updated = { count: current.count + 1, date: current.date };
  return new Promise((resolve) => {
    chrome.storage.local.set({ woffle_daily_usage: updated }, () => resolve(updated));
  });
}

// ============================================================
// YouTube transcript fetching
// ============================================================
// This code stays client-side because the extension has access to YouTube's
// cookies and page context. We fetch the transcript here, chunk it, then
// send the chunks directly to the Anthropic API for AI classification.

const YT_INNERTUBE_API_KEY_CANDIDATES = [
  'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
];

function buildTimedtextCandidateUrls(baseUrl) {
  if (!baseUrl) return [];
  const urls = [baseUrl];
  const json3Url = baseUrl.includes('fmt=')
    ? baseUrl.replace(/([?&])fmt=[^&]*/i, '$1fmt=json3')
    : `${baseUrl}&fmt=json3`;
  if (json3Url !== baseUrl) urls.push(json3Url);
  return [...new Set(urls)];
}

function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseXmlTimedtext(xmlText) {
  const events = [];
  const collectEvents = (regex, startAttr, durAttr, isMs) => {
    let match;
    while ((match = regex.exec(xmlText)) !== null) {
      const attrs = match[1] || '';
      const body = (match[2] || '').replace(/<[^>]+>/g, '');
      const startMatch = attrs.match(new RegExp(`${startAttr}=\"([^\"]+)\"`));
      const durMatch = attrs.match(new RegExp(`${durAttr}=\"([^\"]+)\"`));
      if (!startMatch) continue;
      const startRaw = parseFloat(startMatch[1] || '0');
      const durRaw = parseFloat(durMatch ? durMatch[1] : '0');
      const startMs = isMs ? Math.round(startRaw) : Math.round(startRaw * 1000);
      const durationMs = isMs ? Math.round(durRaw) : Math.round(durRaw * 1000);
      const cleanText = decodeXmlEntities(body).trim();
      if (!cleanText) continue;
      events.push({ tStartMs: startMs, dDurationMs: durationMs, segs: [{ utf8: cleanText }] });
    }
  };
  collectEvents(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi, 'start', 'dur', false);
  collectEvents(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, 't', 'd', true);
  return events.length > 0 ? { events } : null;
}

function parseTimedtextResponse(rawText) {
  const text = (rawText || '').trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    if (json && Array.isArray(json.events) && json.events.length > 0) return json;
  } catch (err) {}
  if (text.startsWith('<')) return parseXmlTimedtext(text);
  return null;
}

function extractCaptionTracksFromWatchHtml(pageHtml) {
  const captionIdx = pageHtml.indexOf('"captionTracks":');
  if (captionIdx === -1) return [];
  const bracketStart = pageHtml.indexOf('[', captionIdx);
  if (bracketStart === -1 || bracketStart - captionIdx > 40) return [];
  let depth = 0;
  let bracketEnd = -1;
  for (let i = bracketStart; i < pageHtml.length && i < bracketStart + 50000; i++) {
    if (pageHtml[i] === '[') depth++;
    if (pageHtml[i] === ']') { depth--; if (depth === 0) { bracketEnd = i + 1; break; } }
  }
  if (bracketEnd === -1) return [];
  try {
    const tracks = JSON.parse(pageHtml.substring(bracketStart, bracketEnd));
    return Array.isArray(tracks) ? tracks : [];
  } catch (err) { return []; }
}

function selectBestTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  return tracks.find(t => t.languageCode === 'en')
    || tracks.find(t => t.languageCode && t.languageCode.startsWith('en'))
    || null;
}

function hasOnlyNonEnglishTracks(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return false;
  return selectBestTrack(tracks) === null;
}

async function fetchTimedtextFromTrack(track) {
  if (!track || !track.baseUrl) return null;
  const candidateUrls = buildTimedtextCandidateUrls(track.baseUrl);
  for (const trackUrl of candidateUrls) {
    try {
      const response = await fetch(trackUrl);
      if (!response.ok) continue;
      const raw = await response.text();
      const parsed = parseTimedtextResponse(raw);
      if (parsed?.events?.length) return parsed;
    } catch (err) { continue; }
  }
  return null;
}

function extractInnertubeApiKeyFromWatchHtml(pageHtml) {
  const match = pageHtml.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

async function fetchCaptionTracksViaInnertubePlayer(videoId, apiKey) {
  if (!videoId || !apiKey) return [];
  const requestVariants = [
    { headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '3', 'X-YouTube-Client-Version': '20.10.38' }, body: { context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId } },
    { headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': '2.20260317.01.00' }, body: { context: { client: { clientName: 'WEB', clientVersion: '2.20260317.01.00', hl: 'en' } }, videoId } },
    { headers: { 'Content-Type': 'application/json' }, body: { context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId } },
  ];
  for (const variant of requestVariants) {
    try {
      const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, { method: 'POST', headers: variant.headers, body: JSON.stringify(variant.body) });
      if (!response.ok) continue;
      const data = await response.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length > 0) return tracks;
    } catch (err) { continue; }
  }
  return [];
}

async function fetchTimedtextViaInnertubeFallback(videoId, pageHtml) {
  const htmlKey = extractInnertubeApiKeyFromWatchHtml(pageHtml || '');
  const keyCandidates = [...new Set([htmlKey, ...YT_INNERTUBE_API_KEY_CANDIDATES].filter(Boolean))];
  let foundNonEnglishOnly = false;
  for (const key of keyCandidates) {
    try {
      const tracks = await fetchCaptionTracksViaInnertubePlayer(videoId, key);
      if (hasOnlyNonEnglishTracks(tracks)) { foundNonEnglishOnly = true; continue; }
      const track = selectBestTrack(tracks);
      if (!track) continue;
      const data = await fetchTimedtextFromTrack(track);
      if (data?.events?.length) return { data, foundNonEnglishOnly: false };
    } catch (err) { console.warn('[Woffle] Innertube fallback error:', err.message || err); }
  }
  return { data: null, foundNonEnglishOnly };
}

async function fetchTranscript(videoId, captionUrl) {
  console.log(`[Woffle] Fetching transcript for ${videoId}`);
  let foundNonEnglishOnly = false;
  if (captionUrl) {
    try {
      const directData = await fetchTimedtextFromTrack({ baseUrl: captionUrl, languageCode: 'page' });
      if (directData?.events?.length) return directData;
    } catch (err) { console.warn('[Woffle] Caption URL fetch failed:', err.message); }
  }
  let pageHtml = '';
  try {
    const pageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
    if (pageResponse.ok) pageHtml = await pageResponse.text();
  } catch (err) { console.warn('[Woffle] Watch page fetch failed:', err.message || err); }
  if (pageHtml) {
    try {
      const htmlTracks = extractCaptionTracksFromWatchHtml(pageHtml);
      if (hasOnlyNonEnglishTracks(htmlTracks)) { foundNonEnglishOnly = true; }
      else {
        const htmlTrack = selectBestTrack(htmlTracks);
        if (htmlTrack) {
          const htmlData = await fetchTimedtextFromTrack(htmlTrack);
          if (htmlData?.events?.length) return htmlData;
        }
      }
    } catch (err) { console.warn('[Woffle] HTML caption extraction failed:', err.message || err); }
  }
  try {
    const innertubeResult = await fetchTimedtextViaInnertubeFallback(videoId, pageHtml);
    if (innertubeResult.data?.events?.length) return innertubeResult.data;
    if (innertubeResult.foundNonEnglishOnly) foundNonEnglishOnly = true;
  } catch (err) { console.warn('[Woffle] Innertube fallback failed:', err.message || err); }
  if (foundNonEnglishOnly) throw new Error('NO_ENGLISH_CAPTIONS');
  throw new Error('NO_CAPTIONS');
}

// ============================================================
// Transcript chunking (stays client-side)
// ============================================================
// Chunks the raw timedtext events into segments suitable for AI classification.

function chunkTranscript(timedTextData) {
  const events = timedTextData.events || [];
  const TARGET_SEGMENT_SEC = 4;
  const MIN_SEGMENT_SEC = 1.2;
  const MAX_SEGMENT_SEC = 8;
  const MAX_TEXT_CHARS = 320;
  const chunks = [];
  const normalizedEvents = [];
  const uniqueStarts = new Set();
  const rawStartMsValues = [];
  const rawDurationMsValues = [];
  let lastEndSec = 0;

  function median(values) {
    if (!values || values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  function inferMsFieldDivisor(rawStarts, rawDurations, eventCount) {
    if (!rawStarts.length) return { divisor: 1000, maxStart: 0, medianDuration: NaN };
    const maxStart = rawStarts.reduce((max, v) => (v > max ? v : max), 0);
    const positiveDurations = rawDurations.filter(v => Number.isFinite(v) && v > 0);
    const medianDuration = median(positiveDurations);
    const assumedMsDurationSec = maxStart / 1000;
    let divisor = 1000;
    if (maxStart > 120000) divisor = 1000;
    else if (Number.isFinite(medianDuration) && medianDuration > 0 && medianDuration < 30) divisor = 1;
    else if (assumedMsDurationSec < 30 && eventCount > 60) divisor = 1;
    else if (assumedMsDurationSec < 90 && eventCount > 200) divisor = 1;
    else if (maxStart <= 7200 && eventCount > 20) divisor = 1;
    return { divisor, maxStart, medianDuration };
  }

  for (const event of events) {
    if (!event || !event.segs) continue;
    const eventText = event.segs.map(s => s.utf8 || '').join('').trim();
    if (!eventText) continue;
    const rawStart = Number(event.tStartMs);
    if (Number.isFinite(rawStart) && rawStart >= 0) rawStartMsValues.push(rawStart);
    const rawDuration = Number(event.dDurationMs);
    if (Number.isFinite(rawDuration) && rawDuration >= 0) rawDurationMsValues.push(rawDuration);
  }

  const timingMeta = inferMsFieldDivisor(rawStartMsValues, rawDurationMsValues, rawStartMsValues.length);
  const msFieldDivisor = timingMeta.divisor;

  for (const event of events) {
    if (!event || !event.segs) continue;
    const eventText = event.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!eventText) continue;
    let startSec = Number.NaN;
    const rawStartMs = Number(event.tStartMs);
    if (Number.isFinite(rawStartMs)) startSec = rawStartMs / msFieldDivisor;
    if (!Number.isFinite(startSec)) startSec = Number(event.tStart);
    if (!Number.isFinite(startSec)) startSec = lastEndSec;
    let durationSec = Number.NaN;
    const rawDurationMs = Number(event.dDurationMs);
    if (Number.isFinite(rawDurationMs)) durationSec = rawDurationMs / msFieldDivisor;
    if (!Number.isFinite(durationSec)) durationSec = Number(event.dDuration);
    if (!Number.isFinite(durationSec) || durationSec < 0) durationSec = 0;
    const endSec = Math.max(startSec + durationSec, startSec);
    normalizedEvents.push({ startSec, endSec, text: eventText });
    uniqueStarts.add(Math.round(startSec * 10));
    lastEndSec = Math.max(lastEndSec, endSec);
  }

  if (normalizedEvents.length === 0) return [];

  if (uniqueStarts.size <= 1 && normalizedEvents.length > 10) {
    let syntheticSec = 0;
    for (const event of normalizedEvents) {
      const wordCount = event.text.split(/\s+/).filter(Boolean).length;
      const estimatedDuration = Math.min(Math.max(wordCount / 2.5, 1.2), 8);
      event.startSec = syntheticSec;
      event.endSec = syntheticSec + estimatedDuration;
      syntheticSec = event.endSec;
    }
  }

  normalizedEvents.sort((a, b) => a.startSec - b.startSec);
  let currentChunk = null;

  function flushChunk() {
    if (!currentChunk || !currentChunk.text.trim()) { currentChunk = null; return; }
    const safeEnd = Math.max(currentChunk.endSec, currentChunk.startSec + MIN_SEGMENT_SEC);
    chunks.push({ start: Math.max(0, currentChunk.startSec), end: Math.max(currentChunk.startSec + MIN_SEGMENT_SEC, safeEnd), text: currentChunk.text.trim() });
    currentChunk = null;
  }

  for (const event of normalizedEvents) {
    if (!currentChunk) {
      currentChunk = { startSec: event.startSec, endSec: Math.max(event.endSec, event.startSec + 0.5), text: event.text };
      continue;
    }
    const gapSec = Math.max(0, event.startSec - currentChunk.endSec);
    const currentDuration = currentChunk.endSec - currentChunk.startSec;
    if (gapSec > 3.5 || currentDuration >= MAX_SEGMENT_SEC || currentChunk.text.length >= MAX_TEXT_CHARS) {
      flushChunk();
      currentChunk = { startSec: event.startSec, endSec: Math.max(event.endSec, event.startSec + 0.5), text: event.text };
      continue;
    }
    currentChunk.endSec = Math.max(currentChunk.endSec, event.endSec, event.startSec + 0.5);
    currentChunk.text += ` ${event.text}`;
    const duration = currentChunk.endSec - currentChunk.startSec;
    const sentenceBreak = /[.!?…]["')\]]?$/.test(event.text);
    if (duration >= MAX_SEGMENT_SEC || currentChunk.text.length >= MAX_TEXT_CHARS || (duration >= TARGET_SEGMENT_SEC && sentenceBreak)) {
      flushChunk();
    }
  }
  flushChunk();

  console.log(`[Woffle] Built ${chunks.length} transcript chunks`);
  return chunks;
}

// ============================================================
// Local cache (chrome.storage.local) — TTL + LRU eviction
// ============================================================

const LOCAL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOCAL_CACHE_MAX_ENTRIES = 200;
const LOCAL_CACHE_PREFIX = 'analysis_';

async function getLocalCache(videoId) {
  return new Promise((resolve) => {
    chrome.storage.local.get(`${LOCAL_CACHE_PREFIX}${videoId}`, (result) => {
      const cached = result[`${LOCAL_CACHE_PREFIX}${videoId}`];
      if (cached && cached.segments) {
        const age = Date.now() - (cached.timestamp || 0);
        if (age < LOCAL_CACHE_TTL_MS) {
          resolve(cached.segments);
          return;
        }
        chrome.storage.local.remove(`${LOCAL_CACHE_PREFIX}${videoId}`);
      }
      resolve(null);
    });
  });
}

async function setLocalCache(videoId, segments) {
  await evictLocalCache();
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [`${LOCAL_CACHE_PREFIX}${videoId}`]: { segments, timestamp: Date.now() }
    }, resolve);
  });
}

async function evictLocalCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (allData) => {
      const cacheKeys = Object.keys(allData).filter(k => k.startsWith(LOCAL_CACHE_PREFIX));
      const now = Date.now();
      const toRemove = [];
      for (const key of cacheKeys) {
        if (now - (allData[key]?.timestamp || 0) >= LOCAL_CACHE_TTL_MS) toRemove.push(key);
      }
      const remaining = cacheKeys.filter(k => !toRemove.includes(k));
      if (remaining.length >= LOCAL_CACHE_MAX_ENTRIES) {
        const sorted = remaining.map(k => ({ key: k, ts: allData[k]?.timestamp || 0 })).sort((a, b) => a.ts - b.ts);
        const excess = sorted.length - (LOCAL_CACHE_MAX_ENTRIES - 20);
        for (let i = 0; i < excess && i < sorted.length; i++) toRemove.push(sorted[i].key);
      }
      if (toRemove.length > 0) chrome.storage.local.remove(toRemove, resolve);
      else resolve();
    });
  });
}

// ============================================================
// Time formatting utility
// ============================================================

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ============================================================
// Direct Claude API calls — BYOK
// ============================================================

// Quick intro scan — Haiku analyses first 90s of transcript.
// Returns { intro_ends_at, intro_type, topic_starts }.
async function quickIntroScan(chunks, apiKey, videoTitle) {
  const first90s = chunks.filter(c => c.start < 90);
  if (first90s.length === 0) {
    return { intro_ends_at: 0, intro_type: 'none', topic_starts: '' };
  }

  const chunkText = first90s
    .map(c => `[${fmtTime(c.start)}] ${c.text}`)
    .join('\n');

  const titleLine = videoTitle ? `Video title: "${videoTitle}"\n\n` : '';
  const userMessage = `${titleLine}First 90 seconds of transcript:\n${chunkText}`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 256,
      system: QUICK_INTRO_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Quick scan failed: ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim();

  if (!text) {
    return { intro_ends_at: 0, intro_type: 'none', topic_starts: '' };
  }

  try {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    return {
      intro_ends_at: Number(parsed.intro_ends_at) || 0,
      intro_type: String(parsed.intro_type || 'none'),
      topic_starts: String(parsed.topic_starts || ''),
    };
  } catch {
    return { intro_ends_at: 0, intro_type: 'none', topic_starts: '' };
  }
}

// Full analysis — Sonnet analyses full transcript with streaming.
// Streams SSE-style events to the content script via sendToTab as segments
// are parsed from the streaming response.
async function fullAnalysis(chunks, apiKey, videoTitle, tabId, videoId) {
  const chunkText = chunks
    .map(c => `[${fmtTime(c.start)}] ${c.text}`)
    .join('\n');

  const titleLine = videoTitle ? `Video title: "${videoTitle}"\n` : '';
  const userMessage = `${titleLine}\nFull transcript:\n${chunkText}`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 4096,
      stream: true,
      system: FULL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Full analysis failed: ${response.status}: ${errText}`);
  }

  // Read the Anthropic SSE stream and extract text deltas.
  // Claude's streaming format sends content_block_delta events
  // with delta.text containing the next chunk of generated text.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let fullText = '';
  const allSegments = [];
  let emittedSegments = 0;
  let topicEmitted = false;
  let streamError = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines from the Anthropic stream
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;

        try {
          const event = JSON.parse(jsonStr);
          if (event.type === 'content_block_delta' && event.delta?.text) {
            fullText += event.delta.text;

            // Try to parse segments incrementally from accumulated text
            const parseResult = parseIncremental(fullText, emittedSegments, topicEmitted);

            // Emit topic as soon as we find it
            if (parseResult.topic && !topicEmitted) {
              topicEmitted = true;
              console.log(`[Woffle] Topic: ${parseResult.topic}`);
            }

            // Emit any newly parsed segments to content script
            for (let i = emittedSegments; i < parseResult.segments.length; i++) {
              const seg = parseResult.segments[i];
              allSegments.push(seg);
              sendToTab(tabId, { type: 'WOFFLE_SEGMENT', segment: seg });
              emittedSegments++;
            }
          }
        } catch {
          // Skip malformed JSON lines — normal during streaming
        }
      }
    }
  } catch (err) {
    console.error('[Woffle] Stream reading failed:', err);
    streamError = err.message;
  }

  // Final parse to catch any remaining segments the incremental parser missed
  const finalResult = parseFinal(fullText);
  for (let i = emittedSegments; i < finalResult.segments.length; i++) {
    const seg = finalResult.segments[i];
    allSegments.push(seg);
    sendToTab(tabId, { type: 'WOFFLE_SEGMENT', segment: seg });
  }

  // Merge adjacent segments before caching
  const toMerge = finalResult.segments.length > allSegments.length
    ? finalResult.segments
    : allSegments;
  const merged = mergeAdjacentSegments(toMerge);

  if (streamError && merged.length === 0) {
    sendToTab(tabId, { type: 'WOFFLE_ERROR', error: 'CLASSIFICATION_FAILED', detail: streamError });
    return;
  }

  if (merged.length > 0) {
    await setLocalCache(videoId, merged);
    sendToTab(tabId, {
      type: 'WOFFLE_COMPLETE',
      fromCache: false,
      totalSegments: merged.length,
      partial: !!streamError,
    });
  } else {
    sendToTab(tabId, { type: 'WOFFLE_ERROR', error: 'NO_SEGMENTS' });
  }
}

// ============================================================
// Incremental JSON Parser
// ============================================================
// Extracts segments from partially complete Claude output.
// Tracks brace depth to detect complete {...} objects within
// the segments array as they stream in.

function parseIncremental(text, alreadyParsed, topicParsed) {
  let topic = null;
  const segments = [];

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  // Extract video_topic
  if (!topicParsed) {
    const topicMatch = cleaned.match(/"video_topic"\s*:\s*"([^"]+)"/);
    if (topicMatch) topic = topicMatch[1];
  }

  // Find the segments array
  const segArrayMatch = cleaned.match(/"segments"\s*:\s*\[/);
  if (!segArrayMatch) return { topic, segments };

  const arrayStart = cleaned.indexOf('[', segArrayMatch.index);
  if (arrayStart === -1) return { topic, segments };

  // Extract complete segment objects by tracking brace depth
  let depth = 0;
  let objStart = -1;

  for (let i = arrayStart + 1; i < cleaned.length; i++) {
    const ch = cleaned[i];

    // Skip string contents to avoid counting braces inside strings
    if (ch === '"') {
      i++;
      while (i < cleaned.length && cleaned[i] !== '"') {
        if (cleaned[i] === '\\') i++;
        i++;
      }
      continue;
    }

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const objStr = cleaned.substring(objStart, i + 1);
        try {
          const obj = JSON.parse(objStr);
          segments.push({
            start: Number(obj.start) || 0,
            end: Number(obj.end) || 0,
            woffle_confidence: Math.min(100, Math.max(0, Number(obj.woffle_confidence) || 0)),
            category: String(obj.category || 'substance'),
            label: String(obj.label || ''),
          });
        } catch {
          // Incomplete or malformed — skip
        }
        objStart = -1;
      }
    }
  }

  return { topic, segments };
}

// ============================================================
// Final JSON Parser
// ============================================================
// Extracts all segments from the complete response.

function parseFinal(text) {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let topic = '';

  // Try to parse as a single JSON object first (ideal case)
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.video_topic) topic = parsed.video_topic;
    if (Array.isArray(parsed.segments)) {
      return {
        topic,
        segments: parsed.segments.map(item => ({
          start: Number(item.start) || 0,
          end: Number(item.end) || 0,
          woffle_confidence: Math.min(100, Math.max(0, Number(item.woffle_confidence) || 0)),
          category: String(item.category || 'substance'),
          label: String(item.label || ''),
        })),
      };
    }
  } catch {
    // Fall through to regex extraction
  }

  // Extract topic via regex
  const topicMatch = cleaned.match(/"video_topic"\s*:\s*"([^"]+)"/);
  if (topicMatch) topic = topicMatch[1];

  // Extract segments array via regex
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return { topic, segments: [] };

  try {
    const parsed = JSON.parse(arrayMatch[0]);
    return {
      topic,
      segments: parsed
        .filter(item => typeof item === 'object' && item !== null)
        .map(item => ({
          start: Number(item.start) || 0,
          end: Number(item.end) || 0,
          woffle_confidence: Math.min(100, Math.max(0, Number(item.woffle_confidence) || 0)),
          category: String(item.category || 'substance'),
          label: String(item.label || ''),
        })),
    };
  } catch {
    return { topic, segments: [] };
  }
}

// ============================================================
// Segment Merging
// ============================================================
// Merge adjacent segments with the same category and close confidence
// scores. Keeps the segment list compact without losing resolution.

function mergeAdjacentSegments(segments) {
  if (segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const prev = merged[merged.length - 1];
    const gap = curr.start - prev.end;
    const sameCat = curr.category === prev.category;
    const closeConf = Math.abs(curr.woffle_confidence - prev.woffle_confidence) <= 15;

    if (sameCat && closeConf && gap <= 2) {
      // Merge: extend end, average confidence, keep longer label
      prev.end = Math.max(prev.end, curr.end);
      prev.woffle_confidence = Math.round(
        (prev.woffle_confidence + curr.woffle_confidence) / 2
      );
      if (curr.label.length > prev.label.length) {
        prev.label = curr.label;
      }
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

// ============================================================
// Message handler — main entry point from content script + popup
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_VIDEO') {
    // Two-pass architecture: return immediately, send results via tabs.sendMessage
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'NO_TAB_ID' });
      return true;
    }
    // Start the analysis pipeline in the background
    handleAnalyzeVideoStreaming(message.videoId, message.captionUrl, message.transcriptData, message.videoTitle, tabId);
    sendResponse({ status: 'scanning' });
    return true;
  }

  // API key check — popup uses this to show "API KEY NEEDED" warning
  if (message.type === 'CHECK_API_KEY') {
    getApiKey().then(key => sendResponse({ hasKey: !!key }));
    return true;
  }

  // Usage state — popup uses this to show the daily counter or licensed badge
  if (message.type === 'GET_USAGE_STATE') {
    Promise.all([getDailyUsage(), hasValidLicense()])
      .then(([usage, licensed]) => sendResponse({
        licensed,
        dailyCount: usage.count,
        dailyLimit: FREE_DAILY_LIMIT,
        atLimit: !licensed && usage.count >= FREE_DAILY_LIMIT,
      }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // License key activation — options page validates and stores a key
  if (message.type === 'VALIDATE_LICENSE_KEY') {
    const { valid, key } = validateLicenseFormat(message.key);
    if (valid) {
      chrome.storage.sync.set({
        woffleLicenseRecord: { key, valid: true, validatedAt: Date.now() }
      }, () => sendResponse({ valid: true, key }));
    } else {
      sendResponse({ valid: false });
    }
    return true;
  }

  // License key removal
  if (message.type === 'REMOVE_LICENSE_KEY') {
    chrome.storage.sync.remove('woffleLicenseRecord', () => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

// ============================================================
// Two-Pass Streaming Analysis Pipeline
// ============================================================
// Fires quick scan (Haiku) and full scan (Sonnet streaming) simultaneously.
// Quick scan result arrives in 1-2s → instant intro skip.
// Full scan streams segments as they're classified → progressive timeline.
//
// Results sent to content script via chrome.tabs.sendMessage:
//   WOFFLE_QUICK_RESULT  — intro skip point from Haiku
//   WOFFLE_SEGMENT       — individual classified segment from Sonnet
//   WOFFLE_COMPLETE      — all segments done, final stats
//   WOFFLE_ERROR         — something went wrong

async function handleAnalyzeVideoStreaming(videoId, captionUrl, transcriptData, videoTitle, tabId) {
  if (!videoId) {
    sendToTab(tabId, { type: 'WOFFLE_ERROR', error: 'NO_VIDEO_ID' });
    return;
  }

  // 1. Local cache check
  const localCached = await getLocalCache(videoId);
  if (localCached) {
    console.log(`[Woffle] Local cache hit for ${videoId}`);
    for (const seg of localCached) {
      sendToTab(tabId, { type: 'WOFFLE_SEGMENT', segment: seg });
    }
    sendToTab(tabId, { type: 'WOFFLE_COMPLETE', fromCache: true, totalSegments: localCached.length });
    return;
  }

  // 2. Daily limit check — cache hits (above) are free, fresh API calls are gated
  const licensed = await hasValidLicense();
  if (!licensed) {
    const usage = await getDailyUsage();
    if (usage.count >= FREE_DAILY_LIMIT) {
      console.log(`[Woffle] Daily limit reached (${usage.count}/${FREE_DAILY_LIMIT})`);
      sendToTab(tabId, { type: 'WOFFLE_ERROR', error: 'DAILY_LIMIT_REACHED' });
      return;
    }
  }

  // 3. Check API key
  const apiKey = await getApiKey();
  if (!apiKey) {
    sendToTab(tabId, { type: 'WOFFLE_ERROR', error: 'NO_API_KEY' });
    return;
  }

  // 4. Fetch transcript if not provided
  let timedTextData;
  if (transcriptData && transcriptData.events && transcriptData.events.length > 0) {
    console.log(`[Woffle] Using pre-fetched transcript: ${transcriptData.events.length} events`);
    timedTextData = transcriptData;
  } else {
    try {
      timedTextData = await fetchTranscript(videoId, captionUrl);
    } catch (err) {
      sendToTab(tabId, { type: 'WOFFLE_ERROR', error: err.message });
      return;
    }
  }

  // 5. Chunk the transcript
  const chunks = chunkTranscript(timedTextData);
  if (chunks.length === 0) {
    sendToTab(tabId, { type: 'WOFFLE_ERROR', error: 'NO_CAPTIONS' });
    return;
  }

  // 6. Increment daily usage counter now that we're committed to making an API call.
  //    Counted before the call so that failed calls still use up a daily slot
  //    (prevents abuse via rapid retry of deliberately bad transcripts).
  //    Licensed users skip the increment — no limit applies to them.
  if (!licensed) {
    await incrementDailyUsage();
  }

  // 7. Fire BOTH requests simultaneously
  //    - Quick scan (Haiku): first 90s → instant intro skip
  //    - Full scan (Sonnet): entire transcript → streaming segments
  console.log(`[Woffle] Starting two-pass analysis for ${videoId}`);

  // Quick scan — fire and forget, forward result as soon as it arrives
  const quickPromise = quickIntroScan(chunks, apiKey, videoTitle)
    .then(result => {
      if (result.intro_ends_at > 0) {
        console.log(`[Woffle] Quick scan: intro ends at ${result.intro_ends_at}s`);
        sendToTab(tabId, {
          type: 'WOFFLE_QUICK_RESULT',
          introEndsAt: result.intro_ends_at,
          introType: result.intro_type,
          topicStarts: result.topic_starts,
        });
      }
    })
    .catch(err => {
      // Quick scan failure is non-critical — full scan will handle everything
      console.warn('[Woffle] Quick scan failed (non-critical):', err.message);
    });

  // Full scan — stream response and forward each segment to content script
  const fullPromise = fullAnalysis(chunks, apiKey, videoTitle, tabId, videoId)
    .catch(err => {
      console.error('[Woffle] Full scan failed:', err);
      sendToTab(tabId, { type: 'WOFFLE_ERROR', error: 'CLASSIFICATION_FAILED', detail: err.message });
    });

  // Wait for both (quick result doesn't block full scan)
  await Promise.allSettled([quickPromise, fullPromise]);
}

// ============================================================
// Helper: send message to content script tab
// ============================================================

function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch((err) => {
    // Tab may have navigated away — non-critical
    console.warn('[Woffle] Could not send to tab:', err.message);
  });
}
