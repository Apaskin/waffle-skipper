// content.js — Waffle Skipper content script (ISOLATED world)
// Injected on YouTube pages. Handles:
// - Video ID detection and YouTube SPA navigation
// - Receiving caption track URLs from page-extractor.js (MAIN world)
// - Timeline overlay rendering (green=substance, orange=waffle)
// - Skip logic (AUTO/MANUAL/OFF modes)
// - Floating scoreboard with live counters
// - Communication with background service worker for Claude API calls

(function () {
  'use strict';

  // ============================================================
  // State
  // ============================================================

  let currentVideoId = null;       // Currently tracked video ID
  let segments = [];                // Classified segments from Claude
  let currentMode = 'MANUAL';      // AUTO_SKIP | MANUAL | OFF
  let isAnalyzing = false;         // Whether analysis is in progress
  let analysisError = null;        // Error message if analysis failed

  // Skip stats for this session
  let wafflesZapped = 0;
  let timeSavedSec = 0;

  // Cooldown flag to prevent double-skipping in AUTO mode
  let skipCooldown = false;

  // References to injected DOM elements (for cleanup)
  let timelineEl = null;
  let scoreboardEl = null;
  let tooltipEl = null;

  // Reference to video timeupdate listener (for cleanup)
  let timeupdateHandler = null;

  // Pending caption resolve — set when we're waiting for page-extractor response
  let captionResolve = null;

  console.log('[Waffle Skipper] Content script loaded');

  // ============================================================
  // Initialization
  // ============================================================

  // Load saved mode preference
  chrome.storage.sync.get('skipMode', (result) => {
    currentMode = result.skipMode || 'MANUAL';
    console.log(`[Waffle Skipper] Mode: ${currentMode}`);
  });

  // Listen for mode changes from popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.skipMode) {
      currentMode = changes.skipMode.newValue;
      console.log(`[Waffle Skipper] Mode changed to: ${currentMode}`);
      applyMode();
    }
  });

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

  // Listen for caption track data posted by page-extractor.js (MAIN world).
  // The extractor runs in the page context and can read ytInitialPlayerResponse
  // and the movie_player API — things we can't access from the ISOLATED world.
  window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'waffle-skipper-extractor') {
      console.log('[Waffle Skipper] Received caption data from page extractor:', event.data);
      if (captionResolve) {
        captionResolve(event.data);
        captionResolve = null;
      }
    }
  });

  // Request caption tracks from the page extractor and wait for response
  function requestCaptionTracks() {
    return new Promise((resolve) => {
      captionResolve = resolve;

      // Ask the page extractor to send us caption data
      window.postMessage({ source: 'waffle-skipper-request' }, '*');

      // Timeout after 5 seconds
      setTimeout(() => {
        if (captionResolve === resolve) {
          captionResolve = null;
          resolve({ tracks: [], error: 'Timeout waiting for page extractor' });
        }
      }, 5000);
    });
  }

  // Start watching for video changes
  initNavigation();

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

    // Start analysis — delay to let YouTube's player initialize after SPA navigation
    // The page-extractor also has a 1s delay on yt-navigate-finish
    setTimeout(() => {
      if (videoId === currentVideoId) {
        analyzeVideo(videoId);
      }
    }, 2000);
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
      // Request caption tracks from the page extractor (MAIN world script)
      let captionData = await requestCaptionTracks();

      // If no tracks found, retry once after a delay (player might still be loading)
      if (!captionData.tracks || captionData.tracks.length === 0) {
        console.log('[Waffle Skipper] No tracks on first try, retrying in 2s...');
        await new Promise(r => setTimeout(r, 2000));
        captionData = await requestCaptionTracks();
      }

      console.log('[Waffle Skipper] Caption tracks:', captionData);

      // Find the best caption track URL
      let captionUrl = null;
      if (captionData.tracks && captionData.tracks.length > 0) {
        const englishTrack = captionData.tracks.find(t => t.lang === 'en')
          || captionData.tracks.find(t => t.lang && t.lang.startsWith('en'))
          || captionData.tracks[0];
        captionUrl = englishTrack.baseUrl;
        console.log(`[Waffle Skipper] Using caption track: ${englishTrack.lang} (${englishTrack.name})`);
      }

      // Send to background service worker for transcript fetching + Claude classification
      const result = await chrome.runtime.sendMessage({
        type: 'ANALYZE_VIDEO',
        videoId: videoId,
        captionUrl: captionUrl
      });

      // Check if the user navigated away while we were analyzing
      if (videoId !== currentVideoId) {
        console.log('[Waffle Skipper] Video changed during analysis, discarding results');
        return;
      }

      if (result.error) {
        console.warn(`[Waffle Skipper] Analysis error: ${result.error}`);
        isAnalyzing = false;
        analysisError = result.error;
        showError(result.error);
        return;
      }

      segments = result.segments || [];
      isAnalyzing = false;
      console.log(`[Waffle Skipper] Analysis complete: ${segments.length} segments`);

      // Render the timeline and set up skip logic
      renderTimeline();
      renderScoreboard();
      applyMode();

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

      // Click to skip (waffle segments only)
      if (segment.type === 'waffle') {
        segEl.addEventListener('click', () => {
          const vid = document.querySelector('video');
          if (vid) {
            vid.currentTime = segment.end;
            console.log(`[Waffle Skipper] Skipped to ${formatTime(segment.end)}`);
          }
        });
      }

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
      <div class="waffle-scoreboard-mascot">🧇</div>
      <div class="waffle-scoreboard-stats">
        <div class="waffle-scoreboard-line">
          <span class="waffle-label">FOUND:</span>
          <span class="waffle-value" id="waffle-found-count">${waffleSegments.length}</span>
        </div>
        <div class="waffle-scoreboard-line">
          <span class="waffle-label">ZAPPED:</span>
          <span class="waffle-value" id="waffle-zapped-count">${wafflesZapped}</span>
        </div>
        <div class="waffle-scoreboard-line">
          <span class="waffle-label">SAVED:</span>
          <span class="waffle-value" id="waffle-time-saved">${formatTimeSaved(timeSavedSec)}</span>
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

  // ============================================================
  // Skip Modes
  // ============================================================

  function applyMode() {
    // Clean up existing timeupdate listener
    if (timeupdateHandler) {
      const video = document.querySelector('video');
      if (video) video.removeEventListener('timeupdate', timeupdateHandler);
      timeupdateHandler = null;
    }

    if (currentMode === 'OFF') {
      if (timelineEl) timelineEl.style.display = 'none';
      if (scoreboardEl) scoreboardEl.style.display = 'none';
      return;
    }

    // Show timeline and scoreboard for MANUAL and AUTO_SKIP
    if (timelineEl) timelineEl.style.display = '';
    if (scoreboardEl) scoreboardEl.style.display = '';

    if (currentMode === 'AUTO_SKIP' && segments.length > 0) {
      const video = document.querySelector('video');
      if (video) {
        timeupdateHandler = () => handleTimeUpdate(video);
        video.addEventListener('timeupdate', timeupdateHandler);
      }
    }
  }

  function handleTimeUpdate(video) {
    if (skipCooldown) return;

    const currentTime = video.currentTime;

    for (const segment of segments) {
      if (segment.type === 'waffle' &&
          currentTime >= segment.start &&
          currentTime < segment.end - 0.5) {
        console.log(`[Waffle Skipper] AUTO SKIP: ${formatTime(segment.start)} → ${formatTime(segment.end)}`);
        video.currentTime = segment.end;

        wafflesZapped++;
        timeSavedSec += (segment.end - currentTime);
        updateScoreboard();

        skipCooldown = true;
        setTimeout(() => { skipCooldown = false; }, 300);
        break;
      }
    }
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
    loadingEl.innerHTML = '<span class="waffle-loading-text">🧇 ANALYZING...</span>';

    injectTimeline(loadingEl);
  }

  function showError(errorCode) {
    removeElement('#waffle-loading');
    removeElement('#waffle-timeline');
    removeElement('#waffle-error');

    const errorEl = document.createElement('div');
    errorEl.id = 'waffle-error';

    const messages = {
      'NO_CAPTIONS': '🧇 NO CAPTIONS AVAILABLE',
      'NO_API_KEY': '🧇 API KEY NOT SET — CLICK EXTENSION ICON',
      'CLASSIFICATION_FAILED': '🧇 ANALYSIS FAILED — CLICK TO RETRY',
      'UNKNOWN_ERROR': '🧇 SOMETHING WENT WRONG',
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
      currentMode,
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
