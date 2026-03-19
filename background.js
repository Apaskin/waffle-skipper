// background.js — Service worker for Waffle Skipper
// Handles all network requests (transcript fetching, Claude API calls)
// and caching. Content scripts can't make cross-origin requests in MV3,
// so everything goes through here via chrome.runtime.sendMessage.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Waffle Skipper] Extension installed');
  // Set default mode to MANUAL
  chrome.storage.sync.get('skipMode', (result) => {
    if (!result.skipMode) {
      chrome.storage.sync.set({ skipMode: 'MANUAL' });
    }
  });
});

// ============================================================
// Transcript Fetching
// ============================================================

// Fetch transcript from YouTube.
// The content script extracts the caption track URL from the loaded page
// (it has access to ytInitialPlayerResponse in the page context) and passes
// it here. This is far more reliable than trying to fetch from the service
// worker, which gets a different (often bot-blocked) response from YouTube.
//
// Approach order:
// 1. Use captionUrl provided by content script (best — comes from the real page)
// 2. Try direct timedtext API as fallback (sometimes works for popular videos)
async function fetchTranscript(videoId, captionUrl) {
  console.log(`[Waffle Skipper] Fetching transcript for ${videoId}`);

  // Primary: use the caption URL extracted by the content script
  if (captionUrl) {
    try {
      // Append fmt=json3 if not already present
      const url = captionUrl.includes('fmt=json3') ? captionUrl : captionUrl + '&fmt=json3';
      console.log('[Waffle Skipper] Fetching caption URL from page context');
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data.events && data.events.length > 0) {
          console.log(`[Waffle Skipper] Got transcript via page caption URL: ${data.events.length} events`);
          return data;
        }
      }
    } catch (err) {
      console.warn('[Waffle Skipper] Caption URL fetch failed:', err.message);
    }
  }

  // Fallback: fetch the YouTube watch page and extract caption tracks from HTML.
  // The service worker can fetch YouTube pages (has host_permissions), though
  // it won't have user cookies. YouTube still embeds ytInitialPlayerResponse
  // in the page HTML for non-authenticated requests.
  try {
    console.log('[Waffle Skipper] Trying fallback: fetching watch page HTML');
    const pageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        // Pretend to be a regular browser to avoid bot detection
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const pageHtml = await pageResponse.text();
    console.log(`[Waffle Skipper] Got page HTML: ${pageHtml.length} chars`);

    // Look for "captionTracks" in the page HTML
    const captionIdx = pageHtml.indexOf('"captionTracks":');
    if (captionIdx === -1) {
      console.warn('[Waffle Skipper] No captionTracks found in page HTML');
      throw new Error('NO_CAPTIONS');
    }

    // Find the JSON array of caption tracks
    const bracketStart = pageHtml.indexOf('[', captionIdx);
    if (bracketStart === -1 || bracketStart - captionIdx > 20) {
      throw new Error('NO_CAPTIONS');
    }

    // Track bracket depth to find the matching closing bracket
    let depth = 0;
    let bracketEnd = bracketStart;
    for (let i = bracketStart; i < pageHtml.length && i < bracketStart + 10000; i++) {
      if (pageHtml[i] === '[') depth++;
      if (pageHtml[i] === ']') {
        depth--;
        if (depth === 0) { bracketEnd = i + 1; break; }
      }
    }

    const tracksJson = pageHtml.substring(bracketStart, bracketEnd);
    const tracks = JSON.parse(tracksJson);
    console.log(`[Waffle Skipper] Found ${tracks.length} caption tracks in page HTML`);

    if (tracks.length === 0) {
      throw new Error('NO_CAPTIONS');
    }

    // Find the best track (prefer English)
    const track = tracks.find(t => t.languageCode === 'en')
      || tracks.find(t => t.languageCode && t.languageCode.startsWith('en'))
      || tracks[0];

    const trackUrl = track.baseUrl + (track.baseUrl.includes('fmt=json3') ? '' : '&fmt=json3');
    console.log(`[Waffle Skipper] Fetching caption track: ${track.languageCode}`);

    const captionResponse = await fetch(trackUrl);
    if (!captionResponse.ok) {
      throw new Error('Caption track fetch failed: ' + captionResponse.status);
    }
    const captionData = await captionResponse.json();

    if (captionData.events && captionData.events.length > 0) {
      console.log(`[Waffle Skipper] Got transcript via page HTML fallback: ${captionData.events.length} events`);
      return captionData;
    }

    throw new Error('NO_CAPTIONS');
  } catch (err) {
    if (err.message === 'NO_CAPTIONS') {
      console.error('[Waffle Skipper] All transcript fetch methods failed — no captions available');
      throw err;
    }
    console.error('[Waffle Skipper] Fallback transcript fetch failed:', err.message);
    throw new Error('NO_CAPTIONS');
  }
}

// ============================================================
// Transcript Chunking
// ============================================================

// Group raw timedtext events into ~30-second chunks for Claude analysis.
// Each chunk has start/end times (in seconds) and combined text.
function chunkTranscript(timedTextData) {
  const events = timedTextData.events || [];
  const CHUNK_DURATION = 30; // seconds
  const chunks = [];
  let currentChunk = { start: 0, end: CHUNK_DURATION, text: '' };

  for (const event of events) {
    // Skip events without text segments (e.g. newline-only events)
    if (!event.segs) continue;

    const eventStartSec = (event.tStartMs || 0) / 1000;
    const eventText = event.segs.map(s => s.utf8 || '').join('');

    // If this event falls beyond the current chunk window, start a new chunk
    if (eventStartSec >= currentChunk.end && currentChunk.text.trim()) {
      chunks.push({ ...currentChunk, text: currentChunk.text.trim() });
      const newStart = Math.floor(eventStartSec / CHUNK_DURATION) * CHUNK_DURATION;
      currentChunk = { start: newStart, end: newStart + CHUNK_DURATION, text: '' };
    }

    currentChunk.text += eventText + ' ';

    // Update end time to at least cover this event
    const eventEndSec = eventStartSec + ((event.dDurationMs || 0) / 1000);
    if (eventEndSec > currentChunk.end) {
      currentChunk.end = Math.ceil(eventEndSec / CHUNK_DURATION) * CHUNK_DURATION;
    }
  }

  // Push the last chunk if it has text
  if (currentChunk.text.trim()) {
    chunks.push({ ...currentChunk, text: currentChunk.text.trim() });
  }

  console.log(`[Waffle Skipper] Chunked transcript into ${chunks.length} segments`);
  return chunks;
}

// ============================================================
// Claude API Classification
// ============================================================

// Send transcript chunks to Claude Haiku for SUBSTANCE/WAFFLE classification.
// Returns an array of { start, end, type, text } objects.
async function classifyChunks(chunks, apiKey) {
  console.log(`[Waffle Skipper] Classifying ${chunks.length} chunks via Claude API`);

  // Build the user message with numbered chunks
  const chunkDescriptions = chunks.map((chunk, i) =>
    `Segment ${i + 1} [${formatTime(chunk.start)} - ${formatTime(chunk.end)}]:\n${chunk.text}`
  ).join('\n\n');

  const requestBody = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You classify YouTube video transcript segments. For each segment, respond with SUBSTANCE or WAFFLE.

WAFFLE means: sponsor reads, "like and subscribe" pleas, off-topic tangents, filler anecdotes that don't support the main point, repetitive recaps, excessive greetings/outros, self-promotion, patreon plugs, padding, rambling.

SUBSTANCE means: the actual content, teaching, argument, demonstration, or information the viewer came for.

Respond ONLY with a JSON array, no other text: [{"segment": 1, "type": "substance"}, {"segment": 2, "type": "waffle"}, ...]`,
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
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Waffle Skipper] Claude API error:', response.status, errorText);
    throw new Error(`API_ERROR: ${response.status}`);
  }

  const data = await response.json();
  const responseText = data.content?.[0]?.text || '';
  console.log('[Waffle Skipper] Raw Claude response:', responseText);

  // Parse the JSON array from Claude's response
  // Claude might wrap it in markdown code blocks, so strip those
  const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const classifications = JSON.parse(cleanJson);

  // Map classifications back onto the original chunks
  const segments = chunks.map((chunk, i) => {
    const classification = classifications.find(c => c.segment === i + 1);
    return {
      start: chunk.start,
      end: chunk.end,
      type: classification ? classification.type.toLowerCase() : 'substance',
      text: chunk.text
    };
  });

  console.log('[Waffle Skipper] Classification complete:', segments.length, 'segments');
  return segments;
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

// Check if we already have analysis cached for this video
async function getCachedAnalysis(videoId) {
  return new Promise((resolve) => {
    chrome.storage.local.get(`analysis_${videoId}`, (result) => {
      const cached = result[`analysis_${videoId}`];
      if (cached && cached.segments) {
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
    console.error('[Waffle Skipper] Classification failed:', err);
    return { error: 'CLASSIFICATION_FAILED' };
  }

  // Cache the results
  await cacheAnalysis(videoId, segments);

  return { segments };
}
