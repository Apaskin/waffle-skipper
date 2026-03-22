#!/usr/bin/env node

// run-eval.js — Woffle classification eval harness.
//
// Sends test transcripts through the same Sonnet classification prompt
// used in the extension, then compares the AI's output against
// human-labelled segments to measure accuracy.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node run-eval.js
//   ANTHROPIC_API_KEY=sk-ant-... node run-eval.js frank-gioia-brooklyn
//   ANTHROPIC_API_KEY=sk-ant-... PROMPT_FILE=prompts/v3.1.txt node run-eval.js
//
// Environment variables:
//   ANTHROPIC_API_KEY  — required, your Anthropic API key
//   PROMPT_FILE        — optional, path to a custom prompt file (relative to tests/)
//   SONNET_MODEL       — optional, override the model (default: claude-sonnet-4-5-20250929)

const fs = require('fs');
const path = require('path');

// ============================================================
// Config
// ============================================================

const API_KEY = process.env.ANTHROPIC_API_KEY;
// User-Agent that closely resembles a real Chrome browser — needed so YouTube
// doesn't reject the watch page fetch with a 429 or bot-detection redirect.
const YT_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
const MODEL = process.env.SONNET_MODEL || 'claude-sonnet-4-5-20250929';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Intensity thresholds — must match the extension's CLAUDE.md spec
const INTENSITY_THRESHOLDS = {
  light:  80,  // woffle_confidence >= 80
  medium: 50,  // woffle_confidence >= 50
  heavy:  25,  // woffle_confidence >= 25
};

// Acceptable accuracy thresholds for a passing eval
const PASS_THRESHOLDS = {
  categoryMatch: 0.75,  // 75% of human-labelled segments must have matching category
  confidenceMatch: 0.65, // 65% must have confidence within expected range
  overall: 0.70,         // 70% combined score to pass
};

// ============================================================
// Helpers
// ============================================================

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Calculate the overlap in seconds between two time ranges.
function overlapSeconds(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

// For a given human-labelled segment, find the AI segment with
// the most time overlap. Returns null if no overlap at all.
function findBestOverlap(humanSeg, aiSegments) {
  let best = null;
  let bestOverlap = 0;

  for (const ai of aiSegments) {
    const overlap = overlapSeconds(humanSeg.start, humanSeg.end, ai.start, ai.end);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = ai;
    }
  }

  // Require at least 30% overlap with the human segment's duration
  // to count as a match (prevents spurious tiny overlaps)
  const humanDuration = humanSeg.end - humanSeg.start;
  if (humanDuration > 0 && bestOverlap / humanDuration < 0.3) {
    return null;
  }

  return best;
}

// ============================================================
// YouTube transcript fetching
// ============================================================
// Mirrors the logic in background.js — same multi-strategy approach:
//   1. Parse captionTracks from ytInitialPlayerResponse in watch page HTML
//   2. Innertube API fallback with known key candidates
// Converts raw timedtext events → [{start, end, text}] chunks for the AI.

const YT_INNERTUBE_API_KEY_CANDIDATES = [
  'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
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
      const startMatch = attrs.match(new RegExp(`${startAttr}="([^"]+)"`));
      const durMatch = attrs.match(new RegExp(`${durAttr}="([^"]+)"`));
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
      const response = await fetch(trackUrl, { headers: YT_FETCH_HEADERS });
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
    {
      headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '3', 'X-YouTube-Client-Version': '20.10.38', ...YT_FETCH_HEADERS },
      body: { context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId },
    },
    {
      headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': '2.20260317.01.00', ...YT_FETCH_HEADERS },
      body: { context: { client: { clientName: 'WEB', clientVersion: '2.20260317.01.00', hl: 'en' } }, videoId },
    },
  ];
  for (const variant of requestVariants) {
    try {
      const response = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
        { method: 'POST', headers: variant.headers, body: JSON.stringify(variant.body) }
      );
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
    } catch (err) { /* try next */ }
  }
  return { data: null, foundNonEnglishOnly };
}

// Converts raw timedtext events (from YouTube) into [{start, end, text}] chunks
// using the same grouping logic as background.js chunkTranscript().
function timedtextToChunks(timedTextData) {
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
    if (!rawStarts.length) return { divisor: 1000 };
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
    return { divisor };
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

  const { divisor: msFieldDivisor } = inferMsFieldDivisor(rawStartMsValues, rawDurationMsValues, rawStartMsValues.length);

  for (const event of events) {
    if (!event || !event.segs) continue;
    const eventText = event.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!eventText) continue;
    let startSec = NaN;
    const rawStartMs = Number(event.tStartMs);
    if (Number.isFinite(rawStartMs)) startSec = rawStartMs / msFieldDivisor;
    if (!Number.isFinite(startSec)) startSec = lastEndSec;
    let durationSec = NaN;
    const rawDurationMs = Number(event.dDurationMs);
    if (Number.isFinite(rawDurationMs)) durationSec = rawDurationMs / msFieldDivisor;
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
    chunks.push({
      start: Math.max(0, currentChunk.startSec),
      end: Math.max(currentChunk.startSec + MIN_SEGMENT_SEC, safeEnd),
      text: currentChunk.text.trim(),
    });
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
    }
    if (!currentChunk) {
      currentChunk = { startSec: event.startSec, endSec: Math.max(event.endSec, event.startSec + 0.5), text: event.text };
    } else {
      currentChunk.endSec = Math.max(currentChunk.endSec, event.endSec);
      currentChunk.text += ' ' + event.text;
    }
  }
  flushChunk();

  return chunks;
}

// Top-level function called by runTestCase().
// Returns [{start, end, text}] or throws on failure.
async function fetchYouTubeTranscript(videoId) {
  if (!videoId || videoId === 'REPLACE_WITH_REAL_VIDEO_ID') {
    throw new Error('No valid video_id in test data');
  }

  process.stdout.write(`  Fetching transcript for ${videoId}...`);

  // Step 1: fetch the YouTube watch page
  let pageHtml = '';
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: YT_FETCH_HEADERS,
    });
    if (pageRes.ok) pageHtml = await pageRes.text();
  } catch (err) { /* will try innertube fallback */ }

  // Step 2: extract captionTracks from page HTML
  if (pageHtml) {
    const htmlTracks = extractCaptionTracksFromWatchHtml(pageHtml);
    if (!hasOnlyNonEnglishTracks(htmlTracks)) {
      const track = selectBestTrack(htmlTracks);
      if (track) {
        const data = await fetchTimedtextFromTrack(track);
        if (data?.events?.length) {
          const chunks = timedtextToChunks(data);
          process.stdout.write(` OK (${chunks.length} chunks via HTML)\n`);
          return chunks;
        }
      }
    }
  }

  // Step 3: Innertube fallback
  const fallback = await fetchTimedtextViaInnertubeFallback(videoId, pageHtml);
  if (fallback.data?.events?.length) {
    const chunks = timedtextToChunks(fallback.data);
    process.stdout.write(` OK (${chunks.length} chunks via Innertube)\n`);
    return chunks;
  }

  process.stdout.write(' FAILED\n');
  if (fallback.foundNonEnglishOnly) throw new Error('No English captions available');
  throw new Error('No captions found for this video');
}

// ============================================================
// Prompt loading
// ============================================================
// If PROMPT_FILE is set, read that file. Otherwise use the hardcoded
// production prompt (v3.0 — same as background.js).

function loadSystemPrompt() {
  const promptFile = process.env.PROMPT_FILE;
  if (promptFile) {
    const fullPath = path.resolve(__dirname, promptFile);
    if (!fs.existsSync(fullPath)) {
      console.error(`ERROR: Prompt file not found: ${fullPath}`);
      process.exit(1);
    }
    console.log(`Using custom prompt: ${promptFile}`);
    return fs.readFileSync(fullPath, 'utf-8').trim();
  }

  // Default: load v3.0.txt (the production prompt)
  const defaultPath = path.join(__dirname, 'prompts', 'v3.0.txt');
  if (fs.existsSync(defaultPath)) {
    return fs.readFileSync(defaultPath, 'utf-8').trim();
  }

  console.error('ERROR: No prompt file found. Create tests/prompts/v3.0.txt');
  process.exit(1);
}

// ============================================================
// API call — same format as background.js fullAnalysis()
// ============================================================

async function classifyTranscript(transcript, videoTitle, systemPrompt) {
  const chunkText = transcript
    .map(c => `[${fmtTime(c.start)}] ${c.text}`)
    .join('\n');

  const titleLine = videoTitle ? `Video title: "${videoTitle}"\n` : '';
  const userMessage = `${titleLine}\nFull transcript:\n${chunkText}`;

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim();

  if (!text) throw new Error('Empty API response');

  // Debug: show what the AI actually returned before we try to parse
  console.log(`  RAW RESPONSE (first 500 chars):\n  ${text.substring(0, 500)}`);
  if (text.length > 500) console.log(`  ... (${text.length} total chars)`);

  // Helper to build the result object from a parsed JSON structure
  function buildResult(parsed) {
    return {
      video_topic: parsed.video_topic || '',
      segments: (parsed.segments || []).map(item => ({
        start: Number(item.start) || 0,
        end: Number(item.end) || 0,
        woffle_confidence: Math.min(100, Math.max(0, Number(item.woffle_confidence) || 0)),
        category: String(item.category || 'substance'),
        label: String(item.label || ''),
      })),
    };
  }

  // Strip markdown code fences and any preamble text
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/gm, '')
    .trim();

  // Attempt 1: direct parse
  try {
    return buildResult(JSON.parse(cleaned));
  } catch (err1) {
    console.log(`  JSON.parse failed: ${err1.message}`);
  }

  // Attempt 2: find first { or [ and parse from there (skips any preamble text)
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  const candidates = [firstBrace, firstBracket].filter(i => i >= 0);
  if (candidates.length > 0) {
    const startIdx = Math.min(...candidates);
    const jsonCandidate = cleaned.substring(startIdx).replace(/\s*```$/gm, '').trim();
    try {
      const parsed = JSON.parse(jsonCandidate);
      // If we got an object with segments, use it directly
      if (parsed && parsed.segments) return buildResult(parsed);
      // If we got a bare array, wrap it
      if (Array.isArray(parsed)) return buildResult({ segments: parsed });
    } catch (err2) {
      console.log(`  Fallback parse from index ${startIdx} failed: ${err2.message}`);
    }
  }

  // Attempt 3: regex extract the segments array
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const segments = JSON.parse(arrayMatch[0]);
      if (Array.isArray(segments)) return buildResult({ segments });
    } catch (err3) {
      console.log(`  Array regex parse failed: ${err3.message}`);
    }
  }

  // Attempt 4: truncation recovery — if the response was cut off mid-JSON,
  // find the last complete object in the segments array and close it out.
  // Strip trailing incomplete object (anything after the last '}') then close.
  const jsonStart = cleaned.indexOf('{');
  if (jsonStart >= 0) {
    let truncated = cleaned.substring(jsonStart);
    // Remove any trailing partial object/value after the last complete '}'
    const lastBrace = truncated.lastIndexOf('}');
    if (lastBrace >= 0) {
      truncated = truncated.substring(0, lastBrace + 1);
      // Try closing with ]} to seal segments array + outer object
      for (const suffix of [']}', ']}', ']}\n']) {
        try {
          const patched = truncated + suffix;
          const parsed = JSON.parse(patched);
          if (parsed && parsed.segments) {
            console.log(`  Truncation recovery succeeded (${parsed.segments.length} segments salvaged)`);
            return buildResult(parsed);
          }
        } catch { /* try next suffix */ }
      }
      // Also try just closing the array if we're inside the segments array
      for (const suffix of [']', ']}']) {
        try {
          const patched = truncated + suffix;
          const parsed = JSON.parse(patched);
          if (Array.isArray(parsed)) {
            console.log(`  Truncation recovery succeeded (${parsed.length} segments salvaged from array)`);
            return buildResult({ segments: parsed });
          }
        } catch { /* try next */ }
      }
    }
    console.log(`  Truncation recovery failed`);
  }

  throw new Error('Could not parse API response as JSON');
}

// ============================================================
// Segment accuracy evaluation
// ============================================================
// For each human-labelled segment, find the best-overlapping AI segment
// and check category match + confidence range.

function evaluateSegmentAccuracy(humanLabels, aiSegments) {
  const results = [];

  for (const human of humanLabels) {
    const aiMatch = findBestOverlap(human, aiSegments);

    if (!aiMatch) {
      results.push({
        human,
        aiMatch: null,
        categoryMatch: false,
        confidenceInRange: false,
        score: 0,
        note: 'NO OVERLAP — AI has no segment covering this time range',
      });
      continue;
    }

    const categoryMatch = aiMatch.category === human.expected_category;

    // Check if the AI's confidence falls within the human's expected range
    const [minConf, maxConf] = human.expected_confidence_range;
    const confidenceInRange = aiMatch.woffle_confidence >= minConf && aiMatch.woffle_confidence <= maxConf;

    // Scoring:
    //   Category match + confidence in range = 1.0
    //   Category match only = 0.75
    //   Confidence in range only (close category) = 0.5
    //   Neither = 0.0
    let score = 0;
    if (categoryMatch && confidenceInRange) score = 1.0;
    else if (categoryMatch) score = 0.75;
    else if (confidenceInRange) score = 0.5;

    // Build a note about what went wrong (if anything)
    let note = '';
    if (!categoryMatch) {
      note += `category: expected ${human.expected_category}, got ${aiMatch.category}`;
    }
    if (!confidenceInRange) {
      if (note) note += '; ';
      note += `confidence: expected ${minConf}-${maxConf}, got ${aiMatch.woffle_confidence}`;
    }

    results.push({
      human,
      aiMatch,
      categoryMatch,
      confidenceInRange,
      score,
      note: note || 'OK',
    });
  }

  return results;
}

// ============================================================
// Intensity accuracy evaluation
// ============================================================
// At each intensity threshold, count how many AI segments are "woffle"
// and sum their durations. Compare against the expected ranges.

function evaluateIntensityAccuracy(aiSegments, expectedIntensity) {
  const results = {};

  for (const [level, threshold] of Object.entries(INTENSITY_THRESHOLDS)) {
    const woffleSegs = aiSegments.filter(s => s.woffle_confidence >= threshold);
    const woffleCount = woffleSegs.length;
    const timeSaved = woffleSegs.reduce((sum, s) => sum + (s.end - s.start), 0);

    const expected = expectedIntensity[level];
    if (!expected) {
      results[level] = { woffleCount, timeSaved, pass: true, note: 'No expected values defined' };
      continue;
    }

    const countPass = woffleCount >= expected.min_woffle_segments
                   && woffleCount <= expected.max_woffle_segments;
    const timePass = timeSaved >= expected.min_time_saved_seconds
                  && timeSaved <= expected.max_time_saved_seconds;

    results[level] = {
      woffleCount,
      timeSaved: Math.round(timeSaved),
      countPass,
      timePass,
      pass: countPass && timePass,
      expected,
    };
  }

  // Key metric: each intensity level must produce meaningfully different results.
  // Medium should have more woffle than Light, Heavy more than Medium.
  const lightCount = results.light?.woffleCount || 0;
  const mediumCount = results.medium?.woffleCount || 0;
  const heavyCount = results.heavy?.woffleCount || 0;

  results._differentiation = {
    mediumVsLight: mediumCount - lightCount,
    mediumVsLightPass: (mediumCount - lightCount) > 2,
    heavyVsMedium: heavyCount - mediumCount,
    heavyVsMediumPass: (heavyCount - mediumCount) > 1,
  };

  return results;
}

// ============================================================
// Report formatting
// ============================================================

function printEvalReport(testName, segResults, intensityResults, aiResult, opts = {}) {
  const totalLabels = segResults.length;
  const catMatches = segResults.filter(r => r.categoryMatch).length;
  const confMatches = segResults.filter(r => r.confidenceInRange).length;
  const avgScore = totalLabels > 0
    ? segResults.reduce((sum, r) => sum + r.score, 0) / totalLabels
    : 0;

  const catPct = totalLabels > 0 ? Math.round((catMatches / totalLabels) * 100) : 0;
  const confPct = totalLabels > 0 ? Math.round((confMatches / totalLabels) * 100) : 0;
  const overallPct = Math.round(avgScore * 100);

  console.log('');
  console.log(`=== EVAL REPORT: ${testName} ===`);
  if (aiResult.video_topic) {
    console.log(`AI detected topic: "${aiResult.video_topic}"`);
  }
  console.log(`AI returned ${aiResult.segments.length} segments`);

  // Score distribution — critical for verifying the AI uses the full 0-100 range
  const bucket0  = aiResult.segments.filter(s => s.woffle_confidence <= 24).length;
  const bucket25 = aiResult.segments.filter(s => s.woffle_confidence >= 25 && s.woffle_confidence <= 49).length;
  const bucket50 = aiResult.segments.filter(s => s.woffle_confidence >= 50 && s.woffle_confidence <= 74).length;
  const bucket75 = aiResult.segments.filter(s => s.woffle_confidence >= 75).length;
  console.log(`SCORE DISTRIBUTION: 0-24: ${bucket0} | 25-49: ${bucket25} | 50-74: ${bucket50} | 75-100: ${bucket75}`);

  // --verbose: dump all AI segments
  if (opts.verbose) {
    console.log('');
    console.log('ALL AI SEGMENTS:');
    for (const seg of aiResult.segments) {
      const time = `[${fmtTime(seg.start)}-${fmtTime(seg.end)}]`;
      const conf = String(seg.woffle_confidence).padStart(3);
      const cat = seg.category.padEnd(13);
      console.log(`  ${time} conf=${conf} ${cat} ${seg.label}`);
    }
  }

  console.log('');

  // Segment accuracy
  console.log('SEGMENT ACCURACY:');
  console.log(`  Labelled: ${totalLabels} segments`);
  console.log(`  Category match: ${catMatches}/${totalLabels} (${catPct}%)`);
  console.log(`  Confidence in range: ${confMatches}/${totalLabels} (${confPct}%)`);

  // Show mismatches
  const mismatches = segResults.filter(r => r.score < 1.0);
  if (mismatches.length > 0) {
    console.log('');
    console.log('  MISMATCHES:');
    for (const m of mismatches) {
      const timeRange = `[${fmtTime(m.human.start)}-${fmtTime(m.human.end)}]`;
      const humanDesc = `Expected: ${m.human.expected_category} (${m.human.expected_confidence_range.join('-')})`;

      if (!m.aiMatch) {
        console.log(`  ${timeRange} ${humanDesc} — NO AI SEGMENT FOUND`);
      } else {
        const aiDesc = `Got: ${m.aiMatch.category} (${m.aiMatch.woffle_confidence})`;
        const severity = m.score >= 0.5 ? 'BORDERLINE' : 'MISS';
        console.log(`  ${timeRange} ${humanDesc}, ${aiDesc} — ${severity}`);
      }
    }
  }

  // Intensity accuracy
  console.log('');
  console.log('INTENSITY ACCURACY:');
  for (const level of ['light', 'medium', 'heavy']) {
    const r = intensityResults[level];
    if (!r) continue;
    const passLabel = r.pass ? 'PASS' : 'FAIL';
    const expectedStr = r.expected
      ? `(expected ${r.expected.min_woffle_segments}-${r.expected.max_woffle_segments}, ${r.expected.min_time_saved_seconds}-${r.expected.max_time_saved_seconds}s)`
      : '';
    const levelLabel = level.toUpperCase().padEnd(7);
    console.log(`  ${levelLabel} ${r.woffleCount} woffle, ${r.timeSaved}s saved — ${passLabel} ${expectedStr}`);
  }

  // Differentiation metrics
  const diff = intensityResults._differentiation;
  if (diff) {
    console.log('');
    console.log(`KEY METRIC: Medium differs from Light by ${diff.mediumVsLight} segments — ${diff.mediumVsLightPass ? 'PASS' : 'FAIL'} (>2 required)`);
    console.log(`KEY METRIC: Heavy differs from Medium by ${diff.heavyVsMedium} segments — ${diff.heavyVsMediumPass ? 'PASS' : 'FAIL'} (>1 required)`);
  }

  // Overall
  const catPass = catPct / 100 >= PASS_THRESHOLDS.categoryMatch;
  const confPass = confPct / 100 >= PASS_THRESHOLDS.confidenceMatch;
  const overallPass = overallPct / 100 >= PASS_THRESHOLDS.overall;
  const allIntensityPass = ['light', 'medium', 'heavy'].every(l => intensityResults[l]?.pass !== false);
  const diffPass = diff ? diff.mediumVsLightPass && diff.heavyVsMediumPass : true;

  const finalPass = catPass && overallPass && diffPass;

  console.log('');
  console.log(`OVERALL: ${overallPct}% accuracy — ${finalPass ? 'PASS' : 'NEEDS WORK'}`);

  return {
    testName,
    catPct,
    confPct,
    overallPct,
    pass: finalPass,
    aiSegmentCount: aiResult.segments.length,
  };
}

// ============================================================
// Run a single test case
// ============================================================

async function runTestCase(filePath, systemPrompt, opts = {}) {
  const testName = path.basename(filePath, '.json');
  console.log(`\nRunning eval: ${testName}...`);

  const testData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  if (!testData.human_labels || !Array.isArray(testData.human_labels)) {
    console.error(`  ERROR: ${testName} has no human_labels array`);
    return null;
  }

  // Fetch transcript live from YouTube (ignore any transcript array in the JSON)
  let transcript;
  try {
    transcript = await fetchYouTubeTranscript(testData.video_id);
  } catch (err) {
    console.error(`  TRANSCRIPT FETCH FAILED: ${err.message} — skipping`);
    return null;
  }

  // Show transcript preview so we can verify speaker markers etc.
  if (opts.verbose) {
    const preview = transcript
      .map(c => `[${fmtTime(c.start)}] ${c.text}`)
      .join('\n');
    console.log('');
    console.log('TRANSCRIPT PREVIEW (first 500 chars):');
    console.log(preview.substring(0, 500));
    console.log('...');
  }

  // Call the API
  let aiResult;
  try {
    aiResult = await classifyTranscript(transcript, testData.video_title, systemPrompt);
  } catch (err) {
    console.error(`  API ERROR: ${err.message}`);
    return null;
  }

  // Evaluate
  const segResults = evaluateSegmentAccuracy(testData.human_labels, aiResult.segments);
  const intensityResults = evaluateIntensityAccuracy(
    aiResult.segments,
    testData.expected_intensity_results || {}
  );

  // Print report
  return printEvalReport(testName, segResults, intensityResults, aiResult, opts);
}

// ============================================================
// Main
// ============================================================

async function main() {
  // Parse CLI args: positional test name + --verbose flag
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const positionalArgs = args.filter(a => !a.startsWith('--'));
  const specificTest = positionalArgs[0] || null;
  const opts = { verbose };

  // Validate API key
  if (!API_KEY) {
    console.error('ERROR: Set ANTHROPIC_API_KEY environment variable');
    console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... node run-eval.js [test-name] [--verbose]');
    process.exit(1);
  }

  // Load prompt
  const systemPrompt = loadSystemPrompt();

  // Find test files
  const evalDir = path.join(__dirname, 'eval-data');

  let testFiles;
  if (specificTest) {
    // Run a single named test
    const filePath = path.join(evalDir, `${specificTest}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`ERROR: Test file not found: ${filePath}`);
      console.error(`Available tests:`);
      const available = fs.readdirSync(evalDir).filter(f => f.endsWith('.json'));
      available.forEach(f => console.error(`  ${path.basename(f, '.json')}`));
      process.exit(1);
    }
    testFiles = [filePath];
  } else {
    // Run all tests
    testFiles = fs.readdirSync(evalDir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(evalDir, f));
  }

  if (testFiles.length === 0) {
    console.error('ERROR: No test files found in tests/eval-data/');
    process.exit(1);
  }

  console.log(`Woffle Classification Eval`);
  console.log(`Model: ${MODEL}`);
  console.log(`Prompt: ${process.env.PROMPT_FILE || 'v3.0 (production)'}`);
  console.log(`Tests: ${testFiles.length}`);

  // Run each test sequentially (to avoid rate limits)
  const summaries = [];
  for (const file of testFiles) {
    const result = await runTestCase(file, systemPrompt, opts);
    if (result) summaries.push(result);

    // Small delay between API calls to be respectful of rate limits
    if (testFiles.indexOf(file) < testFiles.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Print summary if multiple tests ran
  if (summaries.length > 1) {
    console.log('\n');
    console.log('=== SUMMARY ===');
    const maxName = Math.max(...summaries.map(s => s.testName.length));
    for (const s of summaries) {
      const name = s.testName.padEnd(maxName + 2);
      const status = s.pass ? 'PASS' : 'NEEDS WORK';
      console.log(`${name} ${s.overallPct}% — ${status}`);
    }
    const passing = summaries.filter(s => s.pass).length;
    console.log(`OVERALL: ${Math.round(summaries.reduce((sum, s) => sum + s.overallPct, 0) / summaries.length)}% — ${passing}/${summaries.length} passing`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
