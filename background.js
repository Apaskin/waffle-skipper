// background.js — Woffle service worker.
// Handles transcript fetching from YouTube, chunking, and communication with
// the Woffle backend (Cloudflare Worker) for AI classification.
// No direct Claude API calls — all analysis goes through the backend proxy
// which manages credits, shared cache, and the Anthropic API key.

// ============================================================
// Backend + Supabase configuration
// ============================================================
// These are non-secret values safe to bundle in the extension.
// The actual API keys live in the Cloudflare Worker's environment.

const WOFFLE_CONFIG = {
  // TODO: Replace with real URLs after deployment
  WORKER_URL: 'https://woffle-api.example.workers.dev',
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_ANON_KEY: 'your-supabase-anon-key',
};

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
// Auth helpers — Supabase JWT stored in chrome.storage.local
// ============================================================

// Get the stored auth session (access_token + refresh_token + user).
// Returns null if the user isn't logged in.
async function getAuthSession() {
  return new Promise((resolve) => {
    chrome.storage.local.get('woffle_session', (result) => {
      resolve(result.woffle_session || null);
    });
  });
}

// Store an auth session after login.
async function setAuthSession(session) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ woffle_session: session }, resolve);
  });
}

// Clear the auth session (logout).
async function clearAuthSession() {
  return new Promise((resolve) => {
    chrome.storage.local.remove('woffle_session', resolve);
  });
}

// Refresh the Supabase session if the access token has expired.
// Supabase access tokens are short-lived JWTs; the refresh token gets a new one.
async function getValidAccessToken() {
  const session = await getAuthSession();
  if (!session || !session.access_token) return null;

  // Check if token is expired (Supabase JWTs have exp claim)
  try {
    const payload = JSON.parse(atob(session.access_token.split('.')[1]));
    const expiresAt = payload.exp * 1000; // Convert to ms
    const now = Date.now();

    // If token expires in more than 60 seconds, it's still valid
    if (expiresAt - now > 60000) {
      return session.access_token;
    }

    // Token expired or expiring soon — try to refresh
    if (!session.refresh_token) return null;

    const res = await fetch(`${WOFFLE_CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: WOFFLE_CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });

    if (!res.ok) {
      console.error('[Woffle] Token refresh failed:', res.status);
      await clearAuthSession();
      return null;
    }

    const newSession = await res.json();
    await setAuthSession({
      access_token: newSession.access_token,
      refresh_token: newSession.refresh_token,
      user: newSession.user || session.user,
    });
    return newSession.access_token;
  } catch (err) {
    console.error('[Woffle] Token validation error:', err);
    return null;
  }
}

// Make an authenticated fetch to the Woffle backend.
async function workerFetch(path, options = {}) {
  const token = await getValidAccessToken();
  if (!token) {
    return { ok: false, error: 'NOT_LOGGED_IN' };
  }

  const url = `${WOFFLE_CONFIG.WORKER_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// ============================================================
// YouTube transcript fetching
// ============================================================
// This code stays client-side because the extension has access to YouTube's
// cookies and page context. We fetch the transcript here, chunk it, then
// send the chunks to the backend for AI classification.

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
// The chunks are sent to the backend which forwards them to Claude.

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
// Local cache is checked BEFORE hitting the backend shared cache.
// This avoids a network request for videos the user has already seen.

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
// Message handler — main entry point from content script + popup
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_VIDEO') {
    handleAnalyzeVideo(message.videoId, message.captionUrl, message.transcriptData)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (message.type === 'GET_USER_STATE') {
    // Fetch the user's tier, credits, and channels from the backend
    handleGetUserState()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'LOGIN') {
    handleLogin(message.email, message.password)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'SIGNUP') {
    handleSignup(message.email, message.password)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'LOGOUT') {
    clearAuthSession().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'GET_CHECKOUT_URL') {
    handleGetCheckoutUrl(message.tier, message.topup)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'GET_PORTAL_URL') {
    workerFetch('/api/stripe/portal')
      .then(result => sendResponse(result.ok ? result.data : { error: result.error || 'PORTAL_FAILED' }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});

// ============================================================
// Auth: login + signup via Supabase
// ============================================================

async function handleLogin(email, password) {
  const res = await fetch(`${WOFFLE_CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: WOFFLE_CONFIG.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err.error_description || err.msg || 'LOGIN_FAILED' };
  }

  const data = await res.json();
  await setAuthSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user: data.user,
  });
  return { ok: true, user: data.user };
}

async function handleSignup(email, password) {
  const res = await fetch(`${WOFFLE_CONFIG.SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: WOFFLE_CONFIG.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err.error_description || err.msg || 'SIGNUP_FAILED' };
  }

  const data = await res.json();
  // If email confirmation is required, user won't have a session yet
  if (data.access_token) {
    await setAuthSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user: data.user,
    });
    return { ok: true, user: data.user, confirmed: true };
  }
  return { ok: true, user: data.user, confirmed: false };
}

// ============================================================
// GET /api/me — user state (tier, credits, channels)
// ============================================================

async function handleGetUserState() {
  const result = await workerFetch('/api/me');
  if (!result.ok) {
    return { error: result.error || result.data?.error || 'FETCH_FAILED' };
  }
  return result.data;
}

// ============================================================
// GET /api/stripe/checkout — get checkout URL
// ============================================================

async function handleGetCheckoutUrl(tier, topup) {
  const params = topup ? '?topup=true' : `?tier=${tier}`;
  const result = await workerFetch(`/api/stripe/checkout${params}`);
  if (!result.ok) {
    return { error: result.data?.error || 'CHECKOUT_FAILED' };
  }
  return result.data;
}

// ============================================================
// Main analysis pipeline
// ============================================================
// Flow:
// 1. Check local cache (chrome.storage.local)
// 2. Check backend shared cache (GET /api/analyse/:video_id)
// 3. Cache miss → fetch transcript, chunk, send to backend (POST /api/analyse)
// 4. Backend calls Claude, stores in shared cache, deducts credit
// 5. Store result in local cache too

async function handleAnalyzeVideo(videoId, captionUrl, transcriptData) {
  if (!videoId) return { error: 'NO_VIDEO_ID' };

  // 1. Local cache
  const localCached = await getLocalCache(videoId);
  if (localCached) {
    console.log(`[Woffle] Local cache hit for ${videoId}`);
    return { segments: localCached, fromCache: true };
  }

  // Check auth — need to be logged in for backend calls
  const token = await getValidAccessToken();
  if (!token) {
    return { error: 'NOT_LOGGED_IN' };
  }

  // 2. Backend shared cache check (no credit cost, no transcript needed)
  try {
    const cacheResult = await workerFetch(`/api/analyse/${encodeURIComponent(videoId)}`);
    if (cacheResult.ok && cacheResult.data.segments) {
      console.log(`[Woffle] Backend cache hit for ${videoId}`);
      // Store locally too for faster future access
      await setLocalCache(videoId, cacheResult.data.segments);
      return { segments: cacheResult.data.segments, fromCache: true };
    }
  } catch (err) {
    console.warn('[Woffle] Backend cache check failed:', err.message);
    // Continue to full analysis — backend might be down but we can try
  }

  // 3. Cache miss — need to fetch transcript and send to backend
  let timedTextData;
  if (transcriptData && transcriptData.events && transcriptData.events.length > 0) {
    console.log(`[Woffle] Using pre-fetched transcript: ${transcriptData.events.length} events`);
    timedTextData = transcriptData;
  } else {
    try {
      timedTextData = await fetchTranscript(videoId, captionUrl);
    } catch (err) {
      return { error: err.message };
    }
  }

  // Chunk the transcript
  const chunks = chunkTranscript(timedTextData);
  if (chunks.length === 0) return { error: 'NO_CAPTIONS' };

  // 4. Send chunks to backend for classification
  const analyseResult = await workerFetch('/api/analyse', {
    method: 'POST',
    body: JSON.stringify({
      video_id: videoId,
      transcript_chunks: chunks,
    }),
  });

  if (!analyseResult.ok) {
    const errCode = analyseResult.data?.error || 'CLASSIFICATION_FAILED';
    console.error('[Woffle] Backend analysis failed:', errCode, analyseResult.data?.detail || '');
    return { error: errCode, detail: analyseResult.data?.detail };
  }

  const segments = analyseResult.data.segments;

  // 5. Store in local cache
  await setLocalCache(videoId, segments);

  return { segments, fromCache: false };
}
