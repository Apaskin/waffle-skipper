// background.js — Service worker for Waffle Skipper
// Handles all network requests (transcript fetching, Claude API calls)
// and caching. Content scripts can't make cross-origin requests in MV3,
// so everything goes through here via chrome.runtime.sendMessage.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Waffle Skipper] Extension installed');
});

const YT_INNERTUBE_API_KEY_CANDIDATES = [
  // Public key commonly embedded in watch pages.
  'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
];

function buildTimedtextCandidateUrls(baseUrl) {
  if (!baseUrl) return [];
  const urls = [baseUrl];
  const json3Url = baseUrl.includes('fmt=')
    ? baseUrl.replace(/([?&])fmt=[^&]*/i, '$1fmt=json3')
    : `${baseUrl}&fmt=json3`;
  if (json3Url !== baseUrl) {
    urls.push(json3Url);
  }
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

      events.push({
        tStartMs: startMs,
        dDurationMs: durationMs,
        segs: [{ utf8: cleanText }]
      });
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
    if (json && Array.isArray(json.events) && json.events.length > 0) {
      return json;
    }
  } catch (err) {}

  if (text.startsWith('<')) {
    return parseXmlTimedtext(text);
  }

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
    if (pageHtml[i] === ']') {
      depth--;
      if (depth === 0) {
        bracketEnd = i + 1;
        break;
      }
    }
  }
  if (bracketEnd === -1) return [];

  try {
    const tracks = JSON.parse(pageHtml.substring(bracketStart, bracketEnd));
    return Array.isArray(tracks) ? tracks : [];
  } catch (err) {
    return [];
  }
}

function selectBestTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  return tracks.find(t => t.languageCode === 'en')
    || tracks.find(t => t.languageCode && t.languageCode.startsWith('en'))
    || tracks[0];
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
      if (parsed?.events?.length) {
        return parsed;
      }
    } catch (err) {
      continue;
    }
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
    {
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '3',
        'X-YouTube-Client-Version': '20.10.38'
      },
      body: {
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38'
          }
        },
        videoId
      }
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20260317.01.00'
      },
      body: {
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20260317.01.00',
            hl: 'en'
          }
        },
        videoId
      }
    },
    {
      headers: {
        'Content-Type': 'application/json'
      },
      body: {
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38'
          }
        },
        videoId
      }
    }
  ];

  for (const variant of requestVariants) {
    try {
      const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
        method: 'POST',
        headers: variant.headers,
        body: JSON.stringify(variant.body)
      });

      if (!response.ok) continue;

      const data = await response.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length > 0) {
        return tracks;
      }
    } catch (err) {
      continue;
    }
  }

  return [];
}

async function fetchTimedtextViaInnertubeFallback(videoId, pageHtml) {
  const htmlKey = extractInnertubeApiKeyFromWatchHtml(pageHtml || '');
  const keyCandidates = [...new Set([
    htmlKey,
    ...YT_INNERTUBE_API_KEY_CANDIDATES
  ].filter(Boolean))];

  for (const key of keyCandidates) {
    try {
      const tracks = await fetchCaptionTracksViaInnertubePlayer(videoId, key);
      console.log(`[Waffle Skipper] Innertube player returned ${tracks.length} caption tracks (key=${key.slice(0, 8)}...)`);
      const track = selectBestTrack(tracks);
      if (!track) continue;

      const data = await fetchTimedtextFromTrack(track);
      if (data?.events?.length) {
        console.log(`[Waffle Skipper] Got transcript via Innertube fallback: ${data.events.length} events`);
        return data;
      }
    } catch (err) {
      console.warn('[Waffle Skipper] Innertube fallback failed for one key:', err.message || err);
    }
  }

  return null;
}

// ============================================================
// Transcript Fetching
// ============================================================

// Fetch transcript from YouTube.
// Approach order:
// 1. Use captionUrl from content script/page context.
// 2. Parse captionTracks from watch HTML and fetch timedtext directly.
// 3. Fallback to Innertube player API (ANDROID context) and fetch timedtext.
async function fetchTranscript(videoId, captionUrl) {
  console.log(`[Waffle Skipper] Fetching transcript for ${videoId}`);

  if (captionUrl) {
    try {
      const directTrack = { baseUrl: captionUrl, languageCode: 'page' };
      const directData = await fetchTimedtextFromTrack(directTrack);
      if (directData?.events?.length) {
        console.log(`[Waffle Skipper] Got transcript via page caption URL: ${directData.events.length} events`);
        return directData;
      }
    } catch (err) {
      console.warn('[Waffle Skipper] Caption URL fetch failed:', err.message);
    }
  }

  let pageHtml = '';

  try {
    console.log('[Waffle Skipper] Trying fallback: fetching watch page HTML');
    const pageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (pageResponse.ok) {
      pageHtml = await pageResponse.text();
      console.log(`[Waffle Skipper] Got page HTML: ${pageHtml.length} chars`);
    } else {
      console.warn(`[Waffle Skipper] Watch page fetch returned ${pageResponse.status}`);
    }
  } catch (err) {
    console.warn('[Waffle Skipper] Watch page fetch failed:', err.message || err);
  }

  if (pageHtml) {
    try {
      const htmlTracks = extractCaptionTracksFromWatchHtml(pageHtml);
      console.log(`[Waffle Skipper] Found ${htmlTracks.length} caption tracks in page HTML`);

      const htmlTrack = selectBestTrack(htmlTracks);
      if (htmlTrack) {
        const htmlData = await fetchTimedtextFromTrack(htmlTrack);
        if (htmlData?.events?.length) {
          console.log(`[Waffle Skipper] Got transcript via page HTML fallback: ${htmlData.events.length} events`);
          return htmlData;
        }
      }
    } catch (err) {
      console.warn('[Waffle Skipper] Page HTML caption extraction failed:', err.message || err);
    }
  }

  try {
    const innertubeData = await fetchTimedtextViaInnertubeFallback(videoId, pageHtml);
    if (innertubeData?.events?.length) {
      return innertubeData;
    }
  } catch (err) {
    console.warn('[Waffle Skipper] Innertube transcript fallback failed:', err.message || err);
  }

  console.error('[Waffle Skipper] All transcript fetch methods failed - no captions available');
  throw new Error('NO_CAPTIONS');
}

// ============================================================
// Transcript Chunking
// ============================================================

// Group raw timedtext events into fine-grained segments for Claude analysis.
// Segments target a few seconds each, then adjacent results are merged later.
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
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  function inferMsFieldDivisor(rawStarts, rawDurations, eventCount) {
    if (!rawStarts.length) {
      return { divisor: 1000, maxStart: 0, medianDuration: NaN };
    }

    const maxStart = rawStarts.reduce((max, v) => (v > max ? v : max), 0);
    const positiveDurations = rawDurations.filter(v => Number.isFinite(v) && v > 0);
    const medianDuration = median(positiveDurations);
    const assumedMsDurationSec = maxStart / 1000;

    let divisor = 1000;

    if (maxStart > 120000) {
      divisor = 1000; // clearly milliseconds for typical videos
    } else if (Number.isFinite(medianDuration) && medianDuration > 0 && medianDuration < 30) {
      divisor = 1; // looks like seconds despite the "Ms" suffix
    } else if (assumedMsDurationSec < 30 && eventCount > 60) {
      divisor = 1; // too many caption events for a <30s timeline
    } else if (assumedMsDurationSec < 90 && eventCount > 200) {
      divisor = 1; // still implausibly dense if treated as milliseconds
    } else if (maxStart <= 7200 && eventCount > 20) {
      divisor = 1; // <= 2h in seconds is plausible; <= 7.2s in ms usually isn't
    }

    return { divisor, maxStart, medianDuration };
  }

  // First pass: collect raw timing stats so we can infer units reliably.
  for (const event of events) {
    if (!event || !event.segs) continue;
    const eventText = event.segs.map(s => s.utf8 || '').join('').trim();
    if (!eventText) continue;

    const rawStart = Number(event.tStartMs);
    if (Number.isFinite(rawStart) && rawStart >= 0) {
      rawStartMsValues.push(rawStart);
    }

    const rawDuration = Number(event.dDurationMs);
    if (Number.isFinite(rawDuration) && rawDuration >= 0) {
      rawDurationMsValues.push(rawDuration);
    }
  }

  const timingMeta = inferMsFieldDivisor(rawStartMsValues, rawDurationMsValues, rawStartMsValues.length);
  const msFieldDivisor = timingMeta.divisor;
  console.log(`[Waffle Skipper] Caption timing scale: tStartMs/${msFieldDivisor} (max=${timingMeta.maxStart}, medianDur=${timingMeta.medianDuration || 'n/a'})`);

  for (const event of events) {
    if (!event || !event.segs) continue;

    const eventText = event.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!eventText) continue;

    let startSec = Number.NaN;
    const rawStartMs = Number(event.tStartMs);
    if (Number.isFinite(rawStartMs)) {
      startSec = rawStartMs / msFieldDivisor;
    }
    if (!Number.isFinite(startSec)) {
      startSec = Number(event.tStart);
    }
    if (!Number.isFinite(startSec)) {
      startSec = lastEndSec;
    }

    let durationSec = Number.NaN;
    const rawDurationMs = Number(event.dDurationMs);
    if (Number.isFinite(rawDurationMs)) {
      durationSec = rawDurationMs / msFieldDivisor;
    }
    if (!Number.isFinite(durationSec)) {
      durationSec = Number(event.dDuration);
    }
    if (!Number.isFinite(durationSec) || durationSec < 0) {
      durationSec = 0;
    }

    const endSec = Math.max(startSec + durationSec, startSec);
    normalizedEvents.push({ startSec, endSec, text: eventText });
    uniqueStarts.add(Math.round(startSec * 10)); // 100ms buckets
    lastEndSec = Math.max(lastEndSec, endSec);
  }

  if (normalizedEvents.length === 0) {
    return [];
  }

  // Some caption formats have flat/invalid timestamps. Synthesize a timeline
  // from text density so we can still produce multiple chunks.
  if (uniqueStarts.size <= 1 && normalizedEvents.length > 10) {
    let syntheticSec = 0;
    for (const event of normalizedEvents) {
      const wordCount = event.text.split(/\s+/).filter(Boolean).length;
      const estimatedDuration = Math.min(Math.max(wordCount / 2.5, 1.2), 8); // ~150 wpm
      event.startSec = syntheticSec;
      event.endSec = syntheticSec + estimatedDuration;
      syntheticSec = event.endSec;
    }
    console.warn('[Waffle Skipper] Transcript timestamps looked flat; using synthetic timing');
  }

  normalizedEvents.sort((a, b) => a.startSec - b.startSec);

  let currentChunk = null;

  function flushChunk() {
    if (!currentChunk || !currentChunk.text.trim()) {
      currentChunk = null;
      return;
    }

    const safeEnd = Math.max(currentChunk.endSec, currentChunk.startSec + MIN_SEGMENT_SEC);
    chunks.push({
      start: Math.max(0, currentChunk.startSec),
      end: Math.max(currentChunk.startSec + MIN_SEGMENT_SEC, safeEnd),
      text: currentChunk.text.trim()
    });
    currentChunk = null;
  }

  for (const event of normalizedEvents) {
    if (!currentChunk) {
      currentChunk = {
        startSec: event.startSec,
        endSec: Math.max(event.endSec, event.startSec + 0.5),
        text: event.text
      };
      continue;
    }

    const gapSec = Math.max(0, event.startSec - currentChunk.endSec);
    const currentDuration = currentChunk.endSec - currentChunk.startSec;
    if (gapSec > 3.5 || currentDuration >= MAX_SEGMENT_SEC || currentChunk.text.length >= MAX_TEXT_CHARS) {
      flushChunk();
      currentChunk = {
        startSec: event.startSec,
        endSec: Math.max(event.endSec, event.startSec + 0.5),
        text: event.text
      };
      continue;
    }

    currentChunk.endSec = Math.max(currentChunk.endSec, event.endSec, event.startSec + 0.5);
    currentChunk.text += ` ${event.text}`;

    const duration = currentChunk.endSec - currentChunk.startSec;
    const sentenceBreak = /[.!?…]["')\]]?$/.test(event.text);
    if (duration >= MAX_SEGMENT_SEC ||
        currentChunk.text.length >= MAX_TEXT_CHARS ||
        (duration >= TARGET_SEGMENT_SEC && sentenceBreak)) {
      flushChunk();
    }
  }

  flushChunk();

  console.log(`[Waffle Skipper] Built ${chunks.length} fine segments`);
  return chunks;
}

// ============================================================
// Claude API Classification
// ============================================================

const DEFAULT_MODEL_CANDIDATES = [
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-5-latest',
  'claude-3-5-haiku-latest'
];

function parseJsonArrayFromClaudeText(responseText) {
  const cleanText = responseText.trim();
  const withoutFences = cleanText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const arrayMatch = withoutFences.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    throw new Error('INVALID_MODEL_OUTPUT: No JSON array found');
  }

  const parsed = JSON.parse(arrayMatch[0]);
  if (!Array.isArray(parsed)) {
    throw new Error('INVALID_MODEL_OUTPUT: Output was not an array');
  }

  return parsed;
}

function extractAnthropicError(errorText) {
  try {
    const parsed = JSON.parse(errorText);
    const type = parsed?.error?.type || 'api_error';
    const message = parsed?.error?.message || errorText;
    return { type, message };
  } catch (err) {
    return { type: 'api_error', message: errorText };
  }
}

function buildApiError(status, errorInfo, model) {
  const message = (errorInfo?.message || '').toLowerCase();
  const type = errorInfo?.type || 'api_error';

  const err = new Error(`API_ERROR: ${status}`);
  err.code = 'API_ERROR';
  err.detail = errorInfo?.message || `HTTP ${status}`;
  err.retryWithNextModel = false;

  const isModelIssue =
    message.includes('model') && (message.includes('not found') || message.includes('does not exist') || message.includes('unsupported'));

  if (isModelIssue) {
    err.code = 'MODEL_UNAVAILABLE';
    err.detail = `Model "${model}" unavailable (${type})`;
    err.retryWithNextModel = true;
    return err;
  }

  if (status === 401 || status === 403) {
    err.code = 'INVALID_API_KEY';
    err.detail = 'Invalid API key or insufficient permissions';
    return err;
  }

  if (status === 429) {
    err.code = 'RATE_LIMIT';
    err.detail = 'Rate limited by Anthropic API';
    return err;
  }

  if (message.includes('credit') || message.includes('billing') || message.includes('balance')) {
    err.code = 'NO_CREDITS';
    err.detail = 'No API credits or billing issue';
    return err;
  }

  return err;
}

async function getModelCandidates() {
  const { claudeModel } = await chrome.storage.sync.get('claudeModel');
  const configured = typeof claudeModel === 'string' ? claudeModel.trim() : '';
  const merged = configured
    ? [configured, ...DEFAULT_MODEL_CANDIDATES]
    : [...DEFAULT_MODEL_CANDIDATES];
  return [...new Set(merged)];
}

async function callClaude(chunks, apiKey, model) {
  // Build the user message with numbered chunks
  const chunkDescriptions = chunks.map((chunk, i) =>
    `Segment ${i + 1} [${formatTime(chunk.start)} - ${formatTime(chunk.end)}]:\n${chunk.text}`
  ).join('\n\n');

  const requestBody = {
    model: model,
    max_tokens: 4096,
    system: `You classify short YouTube transcript segments for auto-skipping.

WAFFLE means boring/irrelevant filler: sponsor reads, housekeeping ("like/subscribe"), off-topic tangents, repetitive recap, intros/outros, self-promo, dead air talk, rambling.

SUBSTANCE means the core value the viewer came for: explanation, tutorial steps, evidence, demo, argument, key details.

Return strict JSON array only.
- Include every segment exactly once
- Preserve segment numbering
- Output format: [{"segment": 1, "type": "substance"}, {"segment": 2, "type": "waffle"}]`,
    messages: [
      {
        role: 'user',
        content: `Classify each segment as SUBSTANCE or WAFFLE:\n\n${chunkDescriptions}`
      }
    ]
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Waffle Skipper] Claude API error:', response.status, errorText);
    const errorInfo = extractAnthropicError(errorText);
    throw buildApiError(response.status, errorInfo, model);
  }

  const data = await response.json();
  const responseText = (data.content || [])
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();

  if (!responseText) {
    throw new Error('INVALID_MODEL_OUTPUT: Empty Claude response');
  }

  console.log(`[Waffle Skipper] Raw Claude response (${model}):`, responseText);
  return parseJsonArrayFromClaudeText(responseText);
}

function mergeAdjacentSegments(segments) {
  if (!segments || segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const previous = merged[merged.length - 1];
    const gap = current.start - previous.end;

    if (current.type === previous.type && gap <= 1.5) {
      previous.end = Math.max(previous.end, current.end);
      if (previous.text.length < 2000) {
        previous.text = `${previous.text} ${current.text}`.trim();
      }
      continue;
    }

    merged.push({ ...current });
  }

  return merged.map(segment => ({
    start: Math.max(0, segment.start),
    end: Math.max(segment.end, segment.start + 0.8),
    type: segment.type,
    text: (segment.text || '').trim()
  }));
}

function normalizeClassificationType(value) {
  if (typeof value !== 'string') return 'substance';
  const type = value.toLowerCase().trim();
  if (type === 'waffle') return 'waffle';
  if (type === 'substance') return 'substance';
  return 'substance';
}

// Send transcript chunks to Claude Haiku for SUBSTANCE/WAFFLE classification.
// Returns an array of { start, end, type, text } objects.
async function classifyChunks(chunks, apiKey) {
  console.log(`[Waffle Skipper] Classifying ${chunks.length} chunks via Claude API`);
  const CLASSIFY_BATCH_SIZE = 40;

  const modelCandidates = await getModelCandidates();
  const classificationMap = new Map();
  let usedModel = null;

  for (let startIndex = 0; startIndex < chunks.length; startIndex += CLASSIFY_BATCH_SIZE) {
    const batch = chunks.slice(startIndex, startIndex + CLASSIFY_BATCH_SIZE);
    let batchClassifications = null;
    let lastError = null;

    for (const model of modelCandidates) {
      try {
        batchClassifications = await callClaude(batch, apiKey, model);
        usedModel = model;
        break;
      } catch (err) {
        lastError = err;
        if (err && err.retryWithNextModel) {
          console.warn(`[Waffle Skipper] Model "${model}" unavailable, trying fallback...`);
          continue;
        }
        throw err;
      }
    }

    if (!batchClassifications) {
      throw lastError || new Error('CLASSIFICATION_FAILED: no model succeeded');
    }

    const localMap = new Map();
    for (const item of batchClassifications) {
      const localSegment = Number(item?.segment);
      if (Number.isInteger(localSegment) && localSegment >= 1 && localSegment <= batch.length) {
        localMap.set(localSegment, normalizeClassificationType(item?.type));
      }
    }

    for (let i = 0; i < batch.length; i++) {
      const globalIndex = startIndex + i + 1;
      const type = localMap.get(i + 1) || 'substance';
      classificationMap.set(globalIndex, type);
    }
  }

  const segments = chunks.map((chunk, i) => ({
    start: chunk.start,
    end: chunk.end,
    type: classificationMap.get(i + 1) || 'substance',
    text: chunk.text
  }));

  const merged = mergeAdjacentSegments(segments);
  console.log('[Waffle Skipper] Classification complete:', merged.length, 'segments after merge', `via ${usedModel}`);
  return merged;
}

// Format seconds as MM:SS for the Claude prompt
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ============================================================
// Caching
// ============================================================

const ANALYSIS_CACHE_VERSION = 2;

// Check if we already have analysis cached for this video
async function getCachedAnalysis(videoId) {
  return new Promise((resolve) => {
    chrome.storage.local.get(`analysis_${videoId}`, (result) => {
      const cached = result[`analysis_${videoId}`];
      if (cached && cached.segments && cached.version === ANALYSIS_CACHE_VERSION) {
        console.log(`[Waffle Skipper] Cache hit for ${videoId}`);
        resolve(cached.segments);
      } else {
        resolve(null);
      }
    });
  });
}

// Save analysis results to cache
async function cacheAnalysis(videoId, segments) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [`analysis_${videoId}`]: {
        segments,
        version: ANALYSIS_CACHE_VERSION,
        timestamp: Date.now()
      }
    }, resolve);
  });
}

// ============================================================
// Message Handler
// ============================================================

// Main message listener — handles all requests from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_VIDEO') {
    // Handle async — return true to keep the message channel open
    handleAnalyzeVideo(message.videoId, message.captionUrl, message.transcriptData)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Required for async sendResponse
  }

  if (message.type === 'GET_API_KEY_STATUS') {
    chrome.storage.sync.get('claudeApiKey', (result) => {
      sendResponse({ hasKey: !!result.claudeApiKey });
    });
    return true;
  }

  return false;
});

// Full analysis pipeline: cache check → transcript → chunk → classify → cache
// transcriptData: if the page extractor (MAIN world) already fetched the transcript,
//   it's passed here directly so we skip YouTube fetching entirely.
// captionUrl: fallback URL if transcriptData is not available.
async function handleAnalyzeVideo(videoId, captionUrl, transcriptData) {
  if (!videoId) {
    return { error: 'NO_VIDEO_ID' };
  }

  // Check cache first
  const cached = await getCachedAnalysis(videoId);
  if (cached) {
    return { segments: cached, fromCache: true };
  }

  // Check for API key
  const { claudeApiKey } = await chrome.storage.sync.get('claudeApiKey');
  if (!claudeApiKey) {
    return { error: 'NO_API_KEY' };
  }

  // Get transcript data — prefer the pre-fetched data from the page extractor
  let timedTextData;
  if (transcriptData && transcriptData.events && transcriptData.events.length > 0) {
    // Transcript was already fetched by the MAIN world script (has YouTube cookies)
    console.log(`[Waffle Skipper] Using pre-fetched transcript: ${transcriptData.events.length} events`);
    timedTextData = transcriptData;
  } else {
    // Fallback: try fetching from the service worker
    try {
      timedTextData = await fetchTranscript(videoId, captionUrl);
    } catch (err) {
      return { error: err.message };
    }
  }

  // Chunk the transcript
  const chunks = chunkTranscript(timedTextData);
  if (chunks.length === 0) {
    return { error: 'NO_CAPTIONS' };
  }

  // Classify via Claude
  let segments;
  try {
    segments = await classifyChunks(chunks, claudeApiKey);
  } catch (err) {
    console.error('[Waffle Skipper] Classification failed:', err.message || err);
    const code = err.code || 'CLASSIFICATION_FAILED';
    const detail = err.detail || err.message || String(err);
    return { error: code, detail };
  }

  // Cache the results
  await cacheAnalysis(videoId, segments);

  return { segments };
}
