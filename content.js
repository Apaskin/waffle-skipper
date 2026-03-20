// content.js — Waffle Skipper content script (ISOLATED world)
// Injected on YouTube pages. Handles:
// - Video ID detection and YouTube SPA navigation
// - Receiving caption track URLs from page-extractor.js (MAIN world)
// - Timeline overlay rendering (green=substance, orange=waffle)
// - Auto-skip logic (toggleable via popup)
// - Floating scoreboard with live counters
// - Communication with background service worker for Claude API calls

(function () {
  'use strict';

  // ============================================================
  // State
  // ============================================================

  let currentVideoId = null;       // Currently tracked video ID
  let segments = [];                // Classified segments from Claude
  let isAnalyzing = false;         // Whether analysis is in progress
  let analysisError = null;        // Error message if analysis failed

  // P1-5: Auto-skip toggle — loaded from chrome.storage.sync, defaults to true.
  // Updated live when the user toggles in the popup via storage change listener.
  let autoSkipEnabled = true;

  // Skip stats for this session
  let wafflesZapped = 0;
  let timeSavedSec = 0;

  // Cooldown flag to prevent double-skipping
  let skipCooldown = false;
  // When user manually jumps backward into waffle, temporarily bypass auto-skip
  let bypassAutoSkipUntil = 0;

  // References to injected DOM elements (for cleanup)
  let timelineEl = null;
  let scoreboardEl = null;
  let tooltipEl = null;

  // Reference to video timeupdate listener (for cleanup)
  let timeupdateHandler = null;
  let keydownHandler = null;

  // Pending resolve — set when we're waiting for page-extractor response
  let captionResolve = null;

  // Store the latest transcript data received from page-extractor
  // (may arrive before content script asks for it via XHR intercept)
  let latestTranscriptData = null;
  let latestTranscriptVideoId = null;

  console.log('[Waffle Skipper] Content script loaded');

  // Load the persisted auto-skip preference on startup
  chrome.storage.sync.get('autoSkipEnabled', (result) => {
    // Default to true if the key hasn't been set yet
    autoSkipEnabled = result.autoSkipEnabled !== false;
    updateScoreboardSkipState();
  });

  // Listen for live toggle changes from the popup (takes effect immediately)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && 'autoSkipEnabled' in changes) {
      autoSkipEnabled = changes.autoSkipEnabled.newValue !== false;
      updateScoreboardSkipState();
    }
  });

  // ============================================================
  // Initialization
  // ============================================================

  // Listen for status requests from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_STATUS') {
      sendResponse(getStatus());
      return true;
    }
    return false;
  });

  // ============================================================
  // Caption Track Reception (from page-extractor.js via postMessage)
  // ============================================================

  // Listen for data posted by page-extractor.js (MAIN world).
  // The extractor intercepts YouTube's own XHR/fetch requests to the
  // timedtext API and captures the transcript response.
  window.addEventListener('message', (event) => {
    // P0-3 fix: verify origin before trusting message content.
    // Any page script could post a spoofed 'waffle-skipper-extractor' message;
    // the origin check ensures we only accept messages from the YouTube page itself.
    if (event.origin !== 'https://www.youtube.com') return;
    if (event.data && event.data.source === 'waffle-skipper-extractor') {
      const hasTranscript = event.data.transcript && event.data.transcript.events;
      console.log('[Waffle Skipper] Received from extractor:',
        hasTranscript ? event.data.transcript.events.length + ' events' : 'no transcript',
        event.data.method || '', event.data.videoId || '');

      // Store latest transcript data (may arrive unprompted via XHR intercept)
      if (hasTranscript && event.data.videoId) {
        latestTranscriptData = event.data.transcript;
        latestTranscriptVideoId = event.data.videoId;

        // If transcript arrives after analysis gave up (YouTube loads captions late),
        // and this is still the current video, auto-trigger analysis
        if (event.data.videoId === currentVideoId && !isAnalyzing && segments.length === 0 && analysisError) {
          console.log('[Waffle Skipper] Late transcript arrived! Re-triggering analysis...');
          analyzeVideo(currentVideoId);
        }
      }

      // Resolve pending request if there is one
      if (captionResolve) {
        captionResolve(event.data);
        captionResolve = null;
      }
    }
  });

  // Request transcript data from the page extractor and wait for response
  function requestTranscriptData(videoId) {
    return new Promise((resolve) => {
      // Check if we already have data for this video (arrived via XHR intercept)
      if (latestTranscriptVideoId === videoId && latestTranscriptData) {
        console.log('[Waffle Skipper] Using already-captured transcript for', videoId);
        resolve({ transcript: latestTranscriptData, tracks: [], videoId: videoId });
        return;
      }

      captionResolve = resolve;

      // Ask the page extractor if it has captured data for this video.
      // P1-7 fix: target 'https://www.youtube.com' instead of '*' so other frames
      // (e.g. ad iframes) can't intercept transcript request messages.
      window.postMessage({ source: 'waffle-skipper-request', videoId: videoId }, 'https://www.youtube.com');

      // Timeout after 12 seconds
      setTimeout(() => {
        if (captionResolve === resolve) {
          captionResolve = null;
          resolve({ transcript: null, tracks: [], error: 'Timeout waiting for transcript capture' });
        }
      }, 12000);
    });
  }

  // Start watching for video changes
  initNavigation();
  setupKeyboardNavigation();

  // ============================================================
  // YouTube SPA Navigation
  // ============================================================

  function initNavigation() {
    // Primary: YouTube's custom SPA navigation event
    document.addEventListener('yt-navigate-finish', onNavigate);

    // Backup: popstate for browser back/forward
    window.addEventListener('popstate', onNavigate);

    // Also check immediately in case we loaded directly on a watch page
    onNavigate();
  }

  function onNavigate() {
    const videoId = getVideoId();
    if (!videoId) {
      // Not on a watch page — clean up
      cleanup();
      currentVideoId = null;
      return;
    }

    if (videoId === currentVideoId) {
      return; // Same video, nothing to do
    }

    console.log(`[Waffle Skipper] New video detected: ${videoId}`);
    currentVideoId = videoId;

    // Clean up previous video's UI
    cleanup();

    // Reset session stats for new video
    wafflesZapped = 0;
    timeSavedSec = 0;
    bypassAutoSkipUntil = 0;

    // Start analysis with a short delay — the XHR intercept is already capturing
    // YouTube's caption requests passively, so we just need to give YouTube
    // time to start fetching captions for the player
    setTimeout(() => {
      if (videoId === currentVideoId) {
        analyzeVideo(videoId);
      }
    }, 1000);
  }

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('v');
  }

  // ============================================================
  // Analysis Pipeline
  // ============================================================

  async function analyzeVideo(videoId) {
    isAnalyzing = true;
    analysisError = null;
    segments = [];

    // Show loading state
    injectLoadingState();

    try {
      // Wait for transcript data captured by the page extractor's XHR intercept.
      // YouTube fetches captions for its player automatically — we just need to
      // wait for that request to happen and be captured.
      let transcriptData = null;

      // Try up to 6 times with increasing delays.
      // YouTube may take a moment to fetch captions after the player initializes.
      for (let attempt = 1; attempt <= 6; attempt++) {
        const data = await requestTranscriptData(videoId);

        if (data.transcript && data.transcript.events && data.transcript.events.length > 0) {
          transcriptData = data.transcript;
          console.log(`[Waffle Skipper] Got transcript (attempt ${attempt}): ${transcriptData.events.length} events`);
          break;
        }

        if (attempt < 6) {
          const delay = attempt * 1500; // 1.5s, 3s, 4.5s, 6s, 7.5s
          console.log(`[Waffle Skipper] No transcript yet (attempt ${attempt}), retrying in ${delay/1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }

      if (!transcriptData) {
        console.warn('[Waffle Skipper] No transcript captured from page extractor; trying background fallback');
      }

      // Send to background for chunking + Claude classification
      const result = await chrome.runtime.sendMessage({
        type: 'ANALYZE_VIDEO',
        videoId: videoId,
        captionUrl: null,
        transcriptData: transcriptData
      });

      // Check if the user navigated away while we were analyzing
      if (videoId !== currentVideoId) {
        console.log('[Waffle Skipper] Video changed during analysis, discarding results');
        return;
      }

      if (result.error) {
        console.warn(`[Waffle Skipper] Analysis error: ${result.error}`, result.detail || '');
        isAnalyzing = false;
        const normalizedError = normalizeErrorCode(result.error, result.detail);
        analysisError = normalizedError;
        showError(normalizedError);
        return;
      }

      segments = result.segments || [];
      isAnalyzing = false;
      console.log(`[Waffle Skipper] Analysis complete: ${segments.length} segments`);

      // Render the timeline and set up skip logic
      renderTimeline();
      renderScoreboard();
      enableAutoSkip();

    } catch (err) {
      console.error('[Waffle Skipper] Analysis failed:', err);
      isAnalyzing = false;
      analysisError = 'UNKNOWN_ERROR';
      showError('UNKNOWN_ERROR');
    }
  }

  // ============================================================
  // Timeline Overlay
  // ============================================================

  function renderTimeline() {
    // Remove any existing timeline or loading state
    removeElement('#waffle-timeline');
    removeElement('#waffle-loading');

    const video = document.querySelector('video');
    if (!video || segments.length === 0) return;

    const duration = video.duration;
    if (!duration || duration === 0) {
      // Video not loaded yet — wait and retry
      video.addEventListener('loadedmetadata', () => renderTimeline(), { once: true });
      return;
    }

    // Create timeline container
    timelineEl = document.createElement('div');
    timelineEl.id = 'waffle-timeline';
    timelineEl.addEventListener('click', (e) => {
      const vid = document.querySelector('video');
      if (!vid || !vid.duration) return;

      const rect = timelineEl.getBoundingClientRect();
      const x = Math.min(Math.max(0, e.clientX - rect.left), rect.width);
      const targetTime = (x / rect.width) * vid.duration;
      vid.currentTime = targetTime;
      console.log(`[Waffle Skipper] Timeline seek: ${formatTime(targetTime)}`);
    });

    // Create a segment div for each classified chunk
    for (const segment of segments) {
      const segEl = document.createElement('div');
      segEl.className = `waffle-segment ${segment.type}`;

      // Position as percentage of total duration
      const leftPct = (segment.start / duration) * 100;
      const widthPct = ((segment.end - segment.start) / duration) * 100;
      segEl.style.left = `${leftPct}%`;
      segEl.style.width = `${widthPct}%`;

      // Store data for tooltip and click handling
      segEl.dataset.start = segment.start;
      segEl.dataset.end = segment.end;
      segEl.dataset.type = segment.type;
      segEl.dataset.text = segment.text || '';

      // Hover tooltip
      segEl.addEventListener('mouseenter', showTooltip);
      segEl.addEventListener('mouseleave', hideTooltip);

      timelineEl.appendChild(segEl);
    }

    // Inject below YouTube's progress bar
    injectTimeline(timelineEl);
  }

  function injectTimeline(el) {
    // Try to find YouTube's progress bar container and inject below it
    const progressBar = document.querySelector('.ytp-progress-bar-container');
    if (progressBar && progressBar.parentNode) {
      progressBar.parentNode.insertBefore(el, progressBar.nextSibling);
      return;
    }

    // Fallback: append to the chrome-bottom area
    const chromeBottom = document.querySelector('.ytp-chrome-bottom');
    if (chromeBottom) {
      chromeBottom.appendChild(el);
      return;
    }

    // Last resort: append to the player
    const player = document.querySelector('#movie_player');
    if (player) {
      player.appendChild(el);
    }
  }

  // ============================================================
  // Tooltips
  // ============================================================

  function showTooltip(e) {
    hideTooltip();

    const segEl = e.currentTarget;
    const type = segEl.dataset.type.toUpperCase();
    const start = parseFloat(segEl.dataset.start);
    const end = parseFloat(segEl.dataset.end);
    const text = segEl.dataset.text || '';
    const preview = text.length > 60 ? text.substring(0, 60) + '...' : text;

    tooltipEl = document.createElement('div');
    tooltipEl.id = 'waffle-tooltip';
    tooltipEl.innerHTML = `
      <div class="waffle-tooltip-label ${segEl.dataset.type}">${type}</div>
      <div class="waffle-tooltip-time">${formatTime(start)} - ${formatTime(end)}</div>
      <div class="waffle-tooltip-text">${escapeHtml(preview)}</div>
    `;

    // Position above the segment
    const rect = segEl.getBoundingClientRect();
    tooltipEl.style.left = `${rect.left + rect.width / 2}px`;
    tooltipEl.style.top = `${rect.top - 8}px`;

    document.body.appendChild(tooltipEl);
  }

  function hideTooltip() {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  }

  // ============================================================
  // Floating Scoreboard
  // ============================================================

  function renderScoreboard() {
    removeElement('#waffle-scoreboard');

    scoreboardEl = document.createElement('div');
    scoreboardEl.id = 'waffle-scoreboard';

    const waffleSegments = segments.filter(s => s.type === 'waffle');

    scoreboardEl.innerHTML = `
      <div class="waffle-scoreboard-head">
        <span class="waffle-chip">🧇</span>
        <div class="waffle-head-copy">
          <span class="waffle-head-title">WOFFLE</span>
          <span class="waffle-head-sub" id="waffle-skip-status">${autoSkipEnabled ? 'AUTO SKIP ⚡' : 'SKIP OFF'}</span>
        </div>
      </div>
      <div class="waffle-scoreboard-hint">TAB → NEXT · SHIFT+TAB → PREV</div>
      <div class="waffle-scoreboard-stats">
        <div class="waffle-scoreboard-line">
          <span class="waffle-label">FOUND</span>
          <span class="waffle-value" id="waffle-found-count">${waffleSegments.length}</span>
        </div>
        <div class="waffle-scoreboard-line">
          <span class="waffle-label">ZAPPED</span>
          <span class="waffle-value" id="waffle-zapped-count">${wafflesZapped}</span>
        </div>
        <div class="waffle-scoreboard-line">
          <span class="waffle-label">SAVED</span>
          <span class="waffle-value waffle-value-good" id="waffle-time-saved">${formatTimeSaved(timeSavedSec)}</span>
        </div>
      </div>
    `;

    const player = document.querySelector('#movie_player');
    if (player) {
      player.appendChild(scoreboardEl);
    }
  }

  function updateScoreboard() {
    const zappedEl = document.getElementById('waffle-zapped-count');
    const savedEl = document.getElementById('waffle-time-saved');
    if (zappedEl) {
      zappedEl.textContent = wafflesZapped;
      zappedEl.classList.remove('waffle-pulse');
      void zappedEl.offsetWidth; // Force reflow to restart animation
      zappedEl.classList.add('waffle-pulse');
    }
    if (savedEl) {
      savedEl.textContent = formatTimeSaved(timeSavedSec);
    }
  }

  // Update the scoreboard subtitle when the auto-skip toggle changes
  function updateScoreboardSkipState() {
    const statusEl = document.getElementById('waffle-skip-status');
    if (statusEl) {
      statusEl.textContent = autoSkipEnabled ? 'AUTO SKIP ⚡' : 'SKIP OFF';
    }
  }

  // Brief 🧇 emoji pop animation overlaid on the video when waffle is auto-skipped.
  // The element self-destructs after the CSS animation completes (0.6s).
  function showSkipFlash() {
    const player = document.querySelector('#movie_player');
    if (!player) return;
    const flash = document.createElement('div');
    flash.id = 'waffle-skip-flash';
    flash.textContent = '🧇';
    player.appendChild(flash);
    setTimeout(() => flash.remove(), 700);
  }

  // ============================================================
  // Skip Behavior
  // ============================================================

  function enableAutoSkip() {
    // Clean up existing timeupdate listener
    if (timeupdateHandler) {
      const video = document.querySelector('video');
      if (video) video.removeEventListener('timeupdate', timeupdateHandler);
      timeupdateHandler = null;
    }

    // Keep UI visible
    if (timelineEl) timelineEl.style.display = '';
    if (scoreboardEl) scoreboardEl.style.display = '';
    updateScoreboard();

    if (segments.length > 0) {
      const video = document.querySelector('video');
      if (video) {
        timeupdateHandler = () => handleTimeUpdate(video);
        video.addEventListener('timeupdate', timeupdateHandler);
      }
    }
  }

  function handleTimeUpdate(video) {
    // P1-5: Respect the auto-skip toggle — do nothing if user has disabled it
    if (!autoSkipEnabled) return;
    if (skipCooldown) return;

    const currentTime = video.currentTime;
    if (bypassAutoSkipUntil > 0) {
      if (currentTime < bypassAutoSkipUntil - 0.1) {
        return;
      }
      bypassAutoSkipUntil = 0;
    }

    for (const segment of segments) {
      if (segment.type === 'waffle' &&
          currentTime >= segment.start &&
          currentTime < segment.end - 0.5) {
        console.log(`[Waffle Skipper] AUTO SKIP: ${formatTime(segment.start)} -> ${formatTime(segment.end)}`);
        video.currentTime = segment.end;

        wafflesZapped++;
        timeSavedSec += (segment.end - currentTime);
        updateScoreboard();
        showSkipFlash(); // Brief 🧇 pop animation on the video player

        skipCooldown = true;
        setTimeout(() => { skipCooldown = false; }, 300);
        break;
      }
    }
  }

  function setupKeyboardNavigation() {
    if (keydownHandler) return;

    keydownHandler = (event) => {
      if (event.key !== 'Tab') return;
      if (event.defaultPrevented) return;

      const activeElement = document.activeElement;
      const tagName = activeElement?.tagName;
      const isTypingContext =
        activeElement?.isContentEditable ||
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT';
      if (isTypingContext) return;
      if (!segments.length) return;

      const video = document.querySelector('video');
      if (!video) return;

      let targetTime = null;
      let targetSegment = null;

      if (event.shiftKey) {
        targetSegment = findPreviousSegment(video.currentTime || 0);
        targetTime = targetSegment ? targetSegment.start : null;
      } else {
        targetTime = findNextSubstanceStart(video.currentTime || 0);
      }
      if (targetTime == null) return;

      event.preventDefault();
      video.currentTime = targetTime;
      if (event.shiftKey && targetSegment && targetSegment.type === 'waffle') {
        bypassAutoSkipUntil = targetSegment.end;
        console.log(`[Waffle Skipper] Auto-skip bypass armed until ${formatTime(targetSegment.end)} (manual review)`);
      } else {
        bypassAutoSkipUntil = 0;
      }
      console.log(`[Waffle Skipper] Section jump (${event.shiftKey ? 'prev' : 'next'}): ${formatTime(targetTime)}`);
    };

    window.addEventListener('keydown', keydownHandler, true);
  }

  function findNextSubstanceStart(currentTime) {
    const threshold = currentTime + 0.5;
    const next = segments
      .filter(segment => segment.type === 'substance')
      .sort((a, b) => a.start - b.start)
      .find(segment => segment.start > threshold);
    return next ? next.start : null;
  }

  function findPreviousSegment(currentTime) {
    const ordered = [...segments].sort((a, b) => a.start - b.start);
    if (ordered.length === 0) return null;

    const activeIndex = ordered.findIndex(segment =>
      currentTime >= segment.start + 0.15 && currentTime < segment.end - 0.15
    );

    if (activeIndex >= 0) {
      return ordered[Math.max(0, activeIndex - 1)];
    }

    const nextIndex = ordered.findIndex(segment => segment.start > currentTime);
    if (nextIndex === -1) {
      return ordered[ordered.length - 1];
    }
    if (nextIndex === 0) {
      return ordered[0];
    }
    return ordered[nextIndex - 1];
  }

  // ============================================================
  // Loading & Error States
  // ============================================================

  function injectLoadingState() {
    removeElement('#waffle-loading');
    removeElement('#waffle-timeline');
    removeElement('#waffle-error');

    const loadingEl = document.createElement('div');
    loadingEl.id = 'waffle-loading';
    loadingEl.innerHTML = '<span class="waffle-loading-text">🧇 SCANNING FOR WAFFLE...</span>';

    injectTimeline(loadingEl);
  }

  function showError(errorCode) {
    removeElement('#waffle-loading');
    removeElement('#waffle-timeline');
    removeElement('#waffle-error');

    const errorEl = document.createElement('div');
    errorEl.id = 'waffle-error';

    const messages = {
      'NO_CAPTIONS': 'WS NO CAPTIONS AVAILABLE',
      'NO_ENGLISH_CAPTIONS': 'WS ENGLISH CAPTIONS NOT FOUND',
      'NO_API_KEY': 'WS API KEY NOT SET - OPEN SETTINGS',
      'INVALID_API_KEY': 'WS API KEY INVALID - CHECK SETTINGS',
      'NO_CREDITS': 'WS NO API CREDITS - CHECK BILLING',
      'RATE_LIMIT': 'WS RATE LIMITED - TRY AGAIN SOON',
      'MODEL_UNAVAILABLE': 'WS MODEL NOT AVAILABLE - CHECK ACCESS',
      'CLASSIFICATION_FAILED': 'WS ANALYSIS FAILED - CLICK TO RETRY',
      'UNKNOWN_ERROR': 'WS SOMETHING WENT WRONG',
    };

    const msg = messages[errorCode] || messages['UNKNOWN_ERROR'];
    errorEl.innerHTML = `<span class="waffle-error-text">${msg}</span>`;

    if (errorCode === 'CLASSIFICATION_FAILED' || errorCode === 'UNKNOWN_ERROR') {
      errorEl.style.cursor = 'pointer';
      errorEl.addEventListener('click', () => {
        if (currentVideoId) {
          analyzeVideo(currentVideoId);
        }
      });
    }

    injectTimeline(errorEl);
  }

  function normalizeErrorCode(errorCode, detail) {
    if (errorCode === 'CLASSIFICATION_FAILED' && typeof detail === 'string') {
      const lower = detail.toLowerCase();
      if (lower.includes('api_error: 401') || lower.includes('api_error:401')) {
        return 'INVALID_API_KEY';
      }
      if (lower.includes('api_error: 429') || lower.includes('api_error:429')) {
        return 'RATE_LIMIT';
      }
    }
    return errorCode;
  }

  // ============================================================
  // Status (for popup)
  // ============================================================

  function getStatus() {
    const video = document.querySelector('video');
    const title = document.querySelector('yt-formatted-string.ytd-watch-metadata')?.textContent
      || document.querySelector('#title h1')?.textContent
      || document.title.replace(' - YouTube', '')
      || 'Unknown';

    const waffleSegments = segments.filter(s => s.type === 'waffle');
    const totalWaffleTime = waffleSegments.reduce((sum, s) => sum + (s.end - s.start), 0);

    return {
      videoId: currentVideoId,
      videoTitle: title.trim(),
      isAnalyzing,
      error: analysisError,
      segmentCount: segments.length,
      waffleCount: waffleSegments.length,
      substanceCount: segments.filter(s => s.type === 'substance').length,
      totalWaffleTimeSec: totalWaffleTime,
      wafflesZapped,
      timeSavedSec,
      autoSkipEnabled,
      videoDuration: video?.duration || 0,
    };
  }

  // ============================================================
  // Cleanup
  // ============================================================

  function cleanup() {
    removeElement('#waffle-timeline');
    removeElement('#waffle-scoreboard');
    removeElement('#waffle-loading');
    removeElement('#waffle-error');
    hideTooltip();

    if (timeupdateHandler) {
      const video = document.querySelector('video');
      if (video) video.removeEventListener('timeupdate', timeupdateHandler);
      timeupdateHandler = null;
    }

    segments = [];
    isAnalyzing = false;
    analysisError = null;
  }

  function removeElement(selector) {
    const el = document.querySelector(selector);
    if (el) el.remove();
  }

  // ============================================================
  // Utility
  // ============================================================

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function formatTimeSaved(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins > 0) {
      return `${mins}m ${secs}s`;
    }
    return `${secs}s`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

})();
