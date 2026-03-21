// content.js — Woffle content script (ISOLATED world)
// Injected on YouTube pages. Handles:
// - Video ID detection and YouTube SPA navigation
// - Receiving caption track URLs from page-extractor.js (MAIN world)
// - Timeline overlay rendering (green=substance, orange=woffle)
// - Incremental timeline building as segments stream from Sonnet
// - Quick intro skip from Haiku pass
// - Auto-skip logic (toggleable via popup)
// - Manual SCAN button near YouTube controls
// - Communication with background service worker for backend API calls

(function () {
  'use strict';

  // ============================================================
  // State
  // ============================================================

  let currentVideoId = null;       // Currently tracked video ID
  let segments = [];                // Classified segments from Claude
  let isAnalyzing = false;         // Whether analysis is in progress
  let analysisError = null;        // Error message if analysis failed

  // Auto-skip toggle — loaded from chrome.storage.sync, defaults to true.
  // Updated live when the user toggles in the popup via storage change listener.
  let autoSkipEnabled = true;

  // Whether to keep the timeline permanently visible (default: true).
  // When true, the timeline is injected into #movie_player directly so it
  // is never inside .ytp-chrome-bottom (which YouTube fades to opacity:0).
  let timelineAlwaysVisible = true;

  // Skip stats for this session
  let wafflesZapped = 0;
  let timeSavedSec = 0;

  // Cooldown flag to prevent double-skipping
  let skipCooldown = false;
  // When user manually jumps backward into woffle, temporarily bypass auto-skip
  let bypassAutoSkipUntil = 0;

  // Intensity threshold — determines what confidence score counts as "woffle".
  // Maps to the three intensity levels:
  //   light (80+), medium (50+, default), heavy (25+)
  // Both woffleThreshold and currentIntensity are kept in sync — the threshold
  // is derived from the intensity via getWoffleThreshold().
  let woffleThreshold = 50;
  let currentIntensity = 'medium';

  // References to injected DOM elements (for cleanup)
  let timelineEl = null;
  let scanButtonEl = null;
  let tooltipEl = null;

  // Transcript follower panel — shows the full transcript synced to playback
  // with woffle segments colour-coded orange + strikethrough.
  let transcriptPanelOpen = false;   // persisted in chrome.storage.sync
  let transcriptPanelEl = null;      // outer container
  let transcriptToggleEl = null;     // 📜 TRANSCRIPT button
  let transcriptLines = [];           // [{start, end, text}] — from raw events or segments
  let lastActiveTranscriptIdx = -1;  // tracks which line is highlighted (avoid redundant DOM work)

  // Reference to video timeupdate listener (for cleanup)
  let timeupdateHandler = null;
  let keydownHandler = null;

  // Pending resolve — set when we're waiting for page-extractor response
  let captionResolve = null;

  // Store the latest transcript data received from page-extractor
  // (may arrive before content script asks for it via XHR intercept)
  let latestTranscriptData = null;
  let latestTranscriptVideoId = null;

  console.log('[Woffle] Content script loaded');

  // Load persisted preferences on startup
  chrome.storage.sync.get(['autoSkipEnabled', 'woffleIntensity', 'timelineAlwaysVisible', 'transcriptPanelOpen'], (result) => {
    autoSkipEnabled = result.autoSkipEnabled !== false;
    if (result.woffleIntensity) {
      currentIntensity = result.woffleIntensity;
      woffleThreshold = getWoffleThreshold(currentIntensity);
    }
    // Only override the default (true) if explicitly set to false in storage
    if (result.timelineAlwaysVisible !== undefined) {
      timelineAlwaysVisible = result.timelineAlwaysVisible !== false;
    }
    // Transcript panel defaults to closed
    transcriptPanelOpen = result.transcriptPanelOpen === true;
  });

  // Listen for live preference changes from the popup (take effect immediately)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if ('autoSkipEnabled' in changes) {
      autoSkipEnabled = changes.autoSkipEnabled.newValue !== false;
    }
    if ('woffleIntensity' in changes) {
      applyIntensity(changes.woffleIntensity.newValue || 'medium');
    }
    if ('timelineAlwaysVisible' in changes) {
      timelineAlwaysVisible = changes.timelineAlwaysVisible.newValue !== false;
      // Re-inject timeline in correct location if currently showing
      if (segments.length > 0) renderTimeline();
    }
    if ('transcriptPanelOpen' in changes) {
      transcriptPanelOpen = changes.transcriptPanelOpen.newValue === true;
      if (transcriptPanelEl) {
        transcriptPanelEl.classList.toggle('collapsed', !transcriptPanelOpen);
      }
      if (transcriptToggleEl) {
        transcriptToggleEl.classList.toggle('active', transcriptPanelOpen);
      }
    }
  });

  // ============================================================
  // Initialization
  // ============================================================

  // Listen for messages from popup AND background (streaming results)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_STATUS') {
      sendResponse(getStatus());
      return true;
    }
    if (message.type === 'SET_INTENSITY') {
      // Apply new threshold, re-render timeline, return updated stats.
      // The popup uses the returned status to update score counters immediately.
      // NOTE: we do NOT write to storage here — the popup already wrote before
      // sending this message. Writing here would trigger storage.onChanged, which
      // calls applyIntensity() again, causing a double re-render.
      const intensity = message.intensity || 'medium';
      console.log(`[Woffle] SET_INTENSITY received: ${intensity} (segments: ${segments.length})`);
      applyIntensity(intensity);
      sendResponse(getStatus());
      return true;
    }

    // ============================================================
    // Streaming results from background service worker
    // ============================================================

    if (message.type === 'WOFFLE_QUICK_RESULT') {
      handleQuickResult(message);
      return false;
    }
    if (message.type === 'WOFFLE_SEGMENT') {
      handleStreamedSegment(message);
      return false;
    }
    if (message.type === 'WOFFLE_COMPLETE') {
      handleStreamComplete(message);
      return false;
    }
    if (message.type === 'WOFFLE_ERROR') {
      handleStreamError(message);
      return false;
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
    // Verify origin before trusting message content.
    if (event.origin !== 'https://www.youtube.com') return;
    if (event.data && event.data.source === 'waffle-skipper-extractor') {
      const hasTranscript = event.data.transcript && event.data.transcript.events;
      console.log('[Woffle] Received from extractor:',
        hasTranscript ? event.data.transcript.events.length + ' events' : 'no transcript',
        event.data.method || '', event.data.videoId || '');

      // Store latest transcript data (may arrive unprompted via XHR intercept)
      if (hasTranscript && event.data.videoId) {
        latestTranscriptData = event.data.transcript;
        latestTranscriptVideoId = event.data.videoId;

        // If transcript arrives after analysis gave up (YouTube loads captions late),
        // and this is still the current video, auto-trigger analysis
        if (event.data.videoId === currentVideoId && !isAnalyzing && segments.length === 0 && analysisError) {
          console.log('[Woffle] Late transcript arrived! Re-triggering analysis...');
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
        console.log('[Woffle] Using already-captured transcript for', videoId);
        resolve({ transcript: latestTranscriptData, tracks: [], videoId: videoId });
        return;
      }

      captionResolve = resolve;

      // Ask the page extractor if it has captured data for this video.
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

    console.log(`[Woffle] New video detected: ${videoId}`);
    currentVideoId = videoId;

    // Clean up previous video's UI
    cleanup();

    // Reset session stats for new video
    wafflesZapped = 0;
    timeSavedSec = 0;
    bypassAutoSkipUntil = 0;

    // Inject the scan button near the player controls
    // We delay slightly to give YouTube's DOM time to settle after SPA navigation
    setTimeout(() => {
      if (videoId === currentVideoId) {
        injectScanButton();
        injectTranscriptToggle();
      }
    }, 1000);
  }

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('v');
  }

  // ============================================================
  // Analysis Pipeline — now event-driven (non-blocking)
  // ============================================================
  // Sends ANALYZE_VIDEO to background, which returns immediately with
  // {status: 'scanning'}. Results arrive via separate messages:
  //   WOFFLE_QUICK_RESULT → instant intro skip
  //   WOFFLE_SEGMENT      → add to segments[], re-render timeline
  //   WOFFLE_COMPLETE     → finalise, build transcript panel
  //   WOFFLE_ERROR        → show error state

  async function analyzeVideo(videoId) {
    isAnalyzing = true;
    analysisError = null;
    segments = [];

    // Show loading state
    injectLoadingState();

    try {
      // Wait for transcript data captured by the page extractor's XHR intercept.
      let transcriptData = null;

      for (let attempt = 1; attempt <= 6; attempt++) {
        const data = await requestTranscriptData(videoId);

        if (data.transcript && data.transcript.events && data.transcript.events.length > 0) {
          transcriptData = data.transcript;
          console.log(`[Woffle] Got transcript (attempt ${attempt}): ${transcriptData.events.length} events`);
          break;
        }

        if (attempt < 6) {
          const delay = attempt * 1500;
          console.log(`[Woffle] No transcript yet (attempt ${attempt}), retrying in ${delay/1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }

      if (!transcriptData) {
        console.warn('[Woffle] No transcript captured from page extractor; trying background fallback');
      }

      // Grab the video title for topic identification
      const videoTitle = document.querySelector('yt-formatted-string.ytd-watch-metadata')?.textContent
        || document.querySelector('#title h1')?.textContent
        || document.title.replace(' - YouTube', '')
        || '';

      // Send to background — it fires quick + full scans simultaneously.
      // Results arrive via WOFFLE_QUICK_RESULT, WOFFLE_SEGMENT, WOFFLE_COMPLETE messages.
      const result = await chrome.runtime.sendMessage({
        type: 'ANALYZE_VIDEO',
        videoId: videoId,
        captionUrl: null,
        transcriptData: transcriptData,
        videoTitle: videoTitle.trim()
      });

      // Check for immediate errors (auth, missing tab, etc.)
      if (result.error) {
        console.warn(`[Woffle] Immediate error: ${result.error}`);
        isAnalyzing = false;
        analysisError = result.error;
        showError(result.error);
        return;
      }

      // result.status === 'scanning' — results will arrive via messages
      console.log(`[Woffle] Analysis started for ${videoId} — awaiting streaming results`);
      updateScanButtonState();

    } catch (err) {
      console.error('[Woffle] Analysis failed:', err);
      isAnalyzing = false;
      analysisError = 'UNKNOWN_ERROR';
      showError('UNKNOWN_ERROR');
    }
  }

  // ============================================================
  // Streaming Result Handlers
  // ============================================================

  // Handle quick intro scan result from Haiku (arrives in 1-2 seconds).
  // If we have an intro to skip and auto-skip is on, jump the video immediately.
  function handleQuickResult(message) {
    const { introEndsAt, introType, topicStarts } = message;

    if (!introEndsAt || introEndsAt <= 0) return;

    console.log(`[Woffle] Quick scan: intro ends at ${introEndsAt}s (${introType})`);

    // Create a temporary intro segment on the timeline
    const introSegment = {
      start: 0,
      end: introEndsAt,
      woffle_confidence: 92,
      category: introType === 'sponsor' ? 'sponsor' : 'pleasantries',
      label: `Intro: ${topicStarts || introType}`,
    };

    // Only apply if we don't already have full scan segments
    if (segments.length === 0) {
      segments = [introSegment];
      renderTimeline();
      enableAutoSkip();
    }

    // Auto-skip the intro if enabled and user hasn't passed it yet
    const video = document.querySelector('video');
    if (video && autoSkipEnabled && video.currentTime < introEndsAt) {
      video.currentTime = introEndsAt;
      wafflesZapped++;
      timeSavedSec += introEndsAt;
      showSkipNotification(introEndsAt);
      console.log(`[Woffle] Skipped ${Math.round(introEndsAt)}s intro`);
    }
  }

  // Handle individual segment from Sonnet streaming analysis.
  // Adds to the segments array and re-renders the timeline incrementally.
  function handleStreamedSegment(message) {
    const seg = message.segment;
    if (!seg) return;

    // Normalize: support both woffle_confidence and legacy waffle_confidence
    if (seg.woffle_confidence === undefined && seg.waffle_confidence !== undefined) {
      seg.woffle_confidence = seg.waffle_confidence;
    }

    // Replace quick scan intro segments with real analysis data.
    // The first full segment arriving means Sonnet is now authoritative.
    if (segments.length <= 1 && segments[0]?.label?.startsWith('Intro:')) {
      segments = [];
    }

    segments.push(seg);

    // Re-render timeline with growing segment list
    renderTimeline();
    enableAutoSkip();
  }

  // Handle stream completion — all segments classified.
  function handleStreamComplete(message) {
    isAnalyzing = false;
    analysisError = null;

    console.log(`[Woffle] Analysis complete: ${segments.length} segments (cache: ${message.fromCache})`);

    // Normalize legacy segments
    for (const seg of segments) {
      if (seg.woffle_confidence === undefined && seg.waffle_confidence !== undefined) {
        seg.woffle_confidence = seg.waffle_confidence;
      }
      if (seg.woffle_confidence === undefined) {
        seg.woffle_confidence = seg.type === 'waffle' ? 90 : 10;
      }
    }

    // Final render
    renderTimeline();
    updateScanButtonState();
    enableAutoSkip();

    // Build and render the transcript follower panel
    buildTranscriptLines();
    renderTranscriptPanel();
  }

  // Handle analysis error
  function handleStreamError(message) {
    const errorCode = message.error || 'UNKNOWN_ERROR';
    console.warn(`[Woffle] Stream error: ${errorCode}`, message.detail || '');

    isAnalyzing = false;
    const normalized = normalizeErrorCode(errorCode, message.detail);
    analysisError = normalized;
    showError(normalized);
    updateScanButtonState();
  }

  // ============================================================
  // Skip Notification — "Skipped Xs intro" banner
  // ============================================================

  function showSkipNotification(secondsSkipped) {
    const player = document.querySelector('#movie_player');
    if (!player) return;

    const notif = document.createElement('div');
    notif.style.cssText = `
      position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
      z-index: 100; padding: 8px 16px; border-radius: 6px;
      background: rgba(8, 12, 30, 0.95); border: 1px solid #e2b714;
      font-family: 'Press Start 2P', monospace; font-size: 9px;
      color: #e2b714; text-shadow: 0 0 8px rgba(226, 183, 20, 0.4);
      pointer-events: none; opacity: 1; transition: opacity 0.5s ease;
    `;
    notif.textContent = `⚡ Skipped ${Math.round(secondsSkipped)}s intro`;
    player.appendChild(notif);

    setTimeout(() => { notif.style.opacity = '0'; }, 2000);
    setTimeout(() => notif.remove(), 2500);
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

    // Use last segment's end as fallback duration when video metadata isn't ready.
    const duration = video.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0);
    if (!duration || duration === 0) {
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
      console.log(`[Woffle] Timeline seek: ${formatTime(targetTime)}`);
    });

    // Create a segment div for each classified chunk.
    // The backend returns woffle_confidence (0-100) per segment. We apply
    // the user's intensity threshold to classify each as substance or woffle.
    for (const segment of segments) {
      const confidence = segment.woffle_confidence ?? segment.waffle_confidence ?? 0;
      const isWoffle = confidence >= woffleThreshold;
      const segType = isWoffle ? 'waffle' : 'substance';
      // Backwards compat: also check legacy segment.type field
      const effectiveType = (segment.woffle_confidence !== undefined || segment.waffle_confidence !== undefined)
        ? segType : (segment.type || 'substance');
      const segEl = document.createElement('div');
      segEl.className = `waffle-segment ${effectiveType}`;

      // Position as percentage of total duration
      const leftPct = (segment.start / duration) * 100;
      const widthPct = ((segment.end - segment.start) / duration) * 100;
      segEl.style.left = `${leftPct}%`;
      segEl.style.width = `${widthPct}%`;

      // Store data for tooltip and click handling
      segEl.dataset.start = segment.start;
      segEl.dataset.end = segment.end;
      segEl.dataset.type = effectiveType;
      segEl.dataset.text = segment.label || segment.text || '';

      // Hover tooltip
      segEl.addEventListener('mouseenter', showTooltip);
      segEl.addEventListener('mouseleave', hideTooltip);

      // Click-to-skip: clicking an orange (woffle) segment jumps to its end.
      if (effectiveType === 'waffle') {
        segEl.addEventListener('click', (e) => {
          e.stopPropagation();
          const vid = document.querySelector('video');
          if (!vid) return;
          const end = parseFloat(segEl.dataset.end);
          vid.currentTime = end;
          console.log(`[Woffle] CLICK SKIP: -> ${formatTime(end)}`);
        });
      }

      timelineEl.appendChild(segEl);
    }

    // Inject below YouTube's progress bar
    injectTimeline(timelineEl);

    // Re-attach timeupdate listener
    enableAutoSkip();
  }

  function injectTimeline(el) {
    // Insert the timeline BELOW the player container, between the video and
    // the title/metadata. This avoids overlapping YouTube's controls entirely
    // and doesn't fight with YouTube's show/hide behaviour.
    const player = document.querySelector('#movie_player');
    if (player && player.parentNode) {
      // Insert after #movie_player (or its parent container #player)
      const playerContainer = document.querySelector('#player') || player;
      if (playerContainer.parentNode) {
        playerContainer.parentNode.insertBefore(el, playerContainer.nextSibling);
        return;
      }
    }

    // Fallback: insert at top of #below
    const belowPlayer = document.querySelector('#below') || document.querySelector('#info');
    if (belowPlayer) {
      belowPlayer.insertBefore(el, belowPlayer.firstChild);
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
  // Scan Button — injected near YouTube's player controls
  // ============================================================

  function injectScanButton() {
    removeElement('#woffle-scan-btn');

    scanButtonEl = document.createElement('button');
    scanButtonEl.id = 'woffle-scan-btn';
    scanButtonEl.textContent = '🧇';
    scanButtonEl.title = 'Scan for woffle';
    scanButtonEl.addEventListener('click', () => {
      if (!currentVideoId || isAnalyzing) return;
      analyzeVideo(currentVideoId);
    });

    // Inject near YouTube's subscribe button area or below the player
    const belowPlayer = document.querySelector('#below') || document.querySelector('#info');
    if (belowPlayer) {
      belowPlayer.insertBefore(scanButtonEl, belowPlayer.firstChild);
    } else {
      const player = document.querySelector('#movie_player');
      if (player) player.appendChild(scanButtonEl);
    }
  }

  function updateScanButtonState() {
    if (!scanButtonEl) return;
    if (isAnalyzing) {
      scanButtonEl.classList.add('scanning');
      scanButtonEl.title = 'Scanning...';
    } else if (segments.length > 0) {
      scanButtonEl.classList.add('done');
      scanButtonEl.classList.remove('scanning');
      scanButtonEl.title = 'Analysis complete';
    } else {
      scanButtonEl.classList.remove('scanning', 'done');
      scanButtonEl.title = 'Scan for woffle';
    }
  }

  // NO scoreboard — per CLAUDE.md "NO Floating HUD".
  // Stats live in the popup only. The timeline bar IS the entire in-video UI.

  // Brief 🧇 emoji pop animation overlaid on the video when woffle is auto-skipped.
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

    // Keep timeline visible
    if (timelineEl) timelineEl.style.display = '';

    if (segments.length > 0) {
      const video = document.querySelector('video');
      if (video) {
        timeupdateHandler = () => handleTimeUpdate(video);
        video.addEventListener('timeupdate', timeupdateHandler);
      }
    }
  }

  function handleTimeUpdate(video) {
    // Always update transcript follower position, regardless of auto-skip toggle
    updateTranscriptScroll(video.currentTime);

    // Respect the auto-skip toggle
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
      // Use confidence threshold to decide if this segment is woffle.
      const confidence = segment.woffle_confidence ?? segment.waffle_confidence ?? 0;
      const isWoffle = (segment.woffle_confidence !== undefined || segment.waffle_confidence !== undefined)
        ? (confidence >= woffleThreshold)
        : (segment.type === 'waffle');
      if (isWoffle &&
          currentTime >= segment.start &&
          currentTime < segment.end - 0.5) {
        console.log(`[Woffle] AUTO SKIP: ${formatTime(segment.start)} -> ${formatTime(segment.end)}`);
        video.currentTime = segment.end;

        wafflesZapped++;
        timeSavedSec += (segment.end - currentTime);
        showSkipFlash();
        flashTranscriptLine(segment.start);

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
      flashSegment(targetTime);
      const confidence = targetSegment?.woffle_confidence ?? targetSegment?.waffle_confidence ?? 0;
      const targetIsWoffle = targetSegment && (
        (targetSegment.woffle_confidence !== undefined || targetSegment.waffle_confidence !== undefined)
          ? confidence >= woffleThreshold
          : targetSegment.type === 'waffle'
      );
      if (event.shiftKey && targetIsWoffle) {
        bypassAutoSkipUntil = targetSegment.end;
        console.log(`[Woffle] Auto-skip bypass armed until ${formatTime(targetSegment.end)} (manual review)`);
      } else {
        bypassAutoSkipUntil = 0;
      }
      console.log(`[Woffle] Section jump (${event.shiftKey ? 'prev' : 'next'}): ${formatTime(targetTime)}`);
    };

    window.addEventListener('keydown', keydownHandler, true);
  }

  // Flash the timeline segment containing the given time
  function flashSegment(time) {
    if (!timelineEl) return;
    const segEl = [...timelineEl.querySelectorAll('.waffle-segment')].find(el => {
      const start = parseFloat(el.dataset.start);
      const end = parseFloat(el.dataset.end);
      return time >= start && time <= end;
    });
    if (!segEl) return;
    segEl.classList.remove('nav-flash');
    void segEl.offsetWidth;
    segEl.classList.add('nav-flash');
    setTimeout(() => segEl.classList.remove('nav-flash'), 600);
  }

  function findNextSubstanceStart(currentTime) {
    const threshold = currentTime + 0.5;
    const next = segments
      .filter(segment => {
        const confidence = segment.woffle_confidence ?? segment.waffle_confidence ?? 0;
        const isWoffle = (segment.woffle_confidence !== undefined || segment.waffle_confidence !== undefined)
          ? confidence >= woffleThreshold
          : segment.type === 'waffle';
        return !isWoffle;
      })
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
    loadingEl.innerHTML = '<span class="waffle-loading-text">🧇 SCANNING FOR WOFFLE...</span>';

    injectTimeline(loadingEl);
    updateScanButtonState();
  }

  function showError(errorCode) {
    removeElement('#waffle-loading');
    removeElement('#waffle-timeline');
    removeElement('#waffle-error');

    const errorEl = document.createElement('div');
    errorEl.id = 'waffle-error';

    const messages = {
      'NO_CAPTIONS': 'NO CAPTIONS AVAILABLE',
      'NO_ENGLISH_CAPTIONS': 'ENGLISH CAPTIONS NOT FOUND',
      'NO_API_KEY': 'API KEY NOT SET - OPEN SETTINGS',
      'INVALID_API_KEY': 'API KEY INVALID - CHECK SETTINGS',
      'NO_CREDITS': 'NO API CREDITS - CHECK BILLING',
      'no_credits': 'OUT OF CREDITS',
      'NOT_LOGGED_IN': 'SIGN IN FIRST - OPEN SETTINGS',
      'RATE_LIMIT': 'RATE LIMITED - TRY AGAIN SOON',
      'MODEL_UNAVAILABLE': 'MODEL NOT AVAILABLE - CHECK ACCESS',
      'CLASSIFICATION_FAILED': 'ANALYSIS FAILED - CLICK TO RETRY',
      'UNKNOWN_ERROR': 'SOMETHING WENT WRONG',
    };

    const msg = messages[errorCode] || messages['UNKNOWN_ERROR'];
    errorEl.innerHTML = `<span class="waffle-error-text">🧇 ${msg}</span>`;

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
  // Transcript Follower Panel
  // ============================================================

  function buildTranscriptLines() {
    transcriptLines = [];

    // Prefer raw transcript events from page-extractor for fine-grained lines
    if (latestTranscriptData && latestTranscriptData.events) {
      for (const event of latestTranscriptData.events) {
        if (!event.segs) continue;
        const text = event.segs.map(s => s.utf8 || '').join('').trim();
        if (!text) continue;
        const startSec = (event.tStartMs || 0) / 1000;
        const endSec = startSec + ((event.dDurationMs || 0) / 1000);
        transcriptLines.push({ start: startSec, end: endSec, text });
      }
    }

    // Fallback: use the backend-classified segments
    if (transcriptLines.length === 0) {
      for (const seg of segments) {
        const text = seg.text || seg.label || '';
        if (!text) continue;
        transcriptLines.push({ start: seg.start, end: seg.end, text });
      }
    }

    transcriptLines.sort((a, b) => a.start - b.start);
    console.log(`[Woffle] Transcript lines: ${transcriptLines.length} (${latestTranscriptData ? 'raw' : 'segments'})`);
  }

  // Check whether a transcript line falls within a woffle segment.
  function isLineWoffle(line) {
    const mid = (line.start + line.end) / 2;
    const seg = segments.find(s => mid >= s.start && mid < s.end);
    if (!seg) return false;
    const confidence = seg.woffle_confidence ?? seg.waffle_confidence ?? 0;
    return (seg.woffle_confidence !== undefined || seg.waffle_confidence !== undefined)
      ? confidence >= woffleThreshold
      : seg.type === 'waffle';
  }

  // Inject the 📜 TRANSCRIPT toggle button
  function injectTranscriptToggle() {
    removeElement('#woffle-transcript-toggle');

    transcriptToggleEl = document.createElement('button');
    transcriptToggleEl.id = 'woffle-transcript-toggle';
    transcriptToggleEl.textContent = '📜 TRANSCRIPT';
    transcriptToggleEl.title = 'Toggle transcript panel';
    transcriptToggleEl.classList.toggle('active', transcriptPanelOpen);

    transcriptToggleEl.addEventListener('click', () => {
      transcriptPanelOpen = !transcriptPanelOpen;
      chrome.storage.sync.set({ transcriptPanelOpen });
      if (transcriptPanelEl) {
        transcriptPanelEl.classList.toggle('collapsed', !transcriptPanelOpen);
      }
      transcriptToggleEl.classList.toggle('active', transcriptPanelOpen);
    });

    // Place next to scan button
    if (scanButtonEl && scanButtonEl.parentNode) {
      scanButtonEl.parentNode.insertBefore(transcriptToggleEl, scanButtonEl.nextSibling);
    }
  }

  // Build and inject the full transcript panel
  function renderTranscriptPanel() {
    removeElement('#woffle-transcript-panel');
    lastActiveTranscriptIdx = -1;

    if (transcriptLines.length === 0) return;

    transcriptPanelEl = document.createElement('div');
    transcriptPanelEl.id = 'woffle-transcript-panel';
    if (!transcriptPanelOpen) transcriptPanelEl.classList.add('collapsed');

    // Header bar
    const header = document.createElement('div');
    header.className = 'woffle-transcript-header';

    const headerLabel = document.createElement('span');
    headerLabel.className = 'woffle-transcript-header-label';
    headerLabel.textContent = '📜 TRANSCRIPT';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'woffle-transcript-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close transcript';
    closeBtn.addEventListener('click', () => {
      transcriptPanelOpen = false;
      chrome.storage.sync.set({ transcriptPanelOpen: false });
      transcriptPanelEl.classList.add('collapsed');
      if (transcriptToggleEl) transcriptToggleEl.classList.remove('active');
    });

    header.appendChild(headerLabel);
    header.appendChild(closeBtn);
    transcriptPanelEl.appendChild(header);

    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'woffle-transcript-scroll';

    for (let i = 0; i < transcriptLines.length; i++) {
      const line = transcriptLines[i];
      const woffle = isLineWoffle(line);

      const row = document.createElement('div');
      row.className = `woffle-transcript-line${woffle ? ' waffle' : ''}`;
      row.dataset.index = i;
      row.dataset.start = line.start;
      row.dataset.end = line.end;

      const indicator = document.createElement('span');
      indicator.className = 'woffle-transcript-indicator';

      const timeEl = document.createElement('span');
      timeEl.className = 'woffle-transcript-time';
      timeEl.textContent = formatTime(line.start);

      const textEl = document.createElement('span');
      textEl.className = 'woffle-transcript-text';
      textEl.textContent = line.text;

      row.appendChild(indicator);
      row.appendChild(timeEl);
      row.appendChild(textEl);

      row.addEventListener('click', () => {
        const vid = document.querySelector('video');
        if (vid) {
          vid.currentTime = line.start;
          console.log(`[Woffle] Transcript seek: ${formatTime(line.start)}`);
        }
      });

      scrollContainer.appendChild(row);
    }

    transcriptPanelEl.appendChild(scrollContainer);

    const belowPlayer = document.querySelector('#below') || document.querySelector('#info');
    if (belowPlayer) {
      const insertRef = transcriptToggleEl?.nextSibling || scanButtonEl?.nextSibling || belowPlayer.firstChild;
      belowPlayer.insertBefore(transcriptPanelEl, insertRef);
    }
  }

  // Sync the transcript panel to the current playback position
  function updateTranscriptScroll(currentTime) {
    if (!transcriptPanelEl || !transcriptPanelOpen) return;

    let activeIdx = -1;
    for (let i = 0; i < transcriptLines.length; i++) {
      if (currentTime >= transcriptLines[i].start && currentTime < transcriptLines[i].end) {
        activeIdx = i;
        break;
      }
    }

    if (activeIdx === lastActiveTranscriptIdx) return;
    lastActiveTranscriptIdx = activeIdx;

    const scrollContainer = transcriptPanelEl.querySelector('.woffle-transcript-scroll');
    if (!scrollContainer) return;

    const rows = scrollContainer.querySelectorAll('.woffle-transcript-line');
    for (const row of rows) {
      row.classList.toggle('active', parseInt(row.dataset.index) === activeIdx);
    }

    if (activeIdx >= 0 && rows[activeIdx]) {
      rows[activeIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Re-apply woffle/substance classification to all transcript lines
  function updateTranscriptClassifications() {
    if (!transcriptPanelEl) return;

    const rows = transcriptPanelEl.querySelectorAll('.woffle-transcript-line');
    for (const row of rows) {
      const idx = parseInt(row.dataset.index);
      if (idx >= 0 && idx < transcriptLines.length) {
        row.classList.toggle('waffle', isLineWoffle(transcriptLines[idx]));
      }
    }
  }

  // Flash a transcript line orange when it's auto-skipped
  function flashTranscriptLine(startTime) {
    if (!transcriptPanelEl || !transcriptPanelOpen) return;

    const rows = transcriptPanelEl.querySelectorAll('.woffle-transcript-line');
    for (const row of rows) {
      const start = parseFloat(row.dataset.start);
      const end = parseFloat(row.dataset.end);
      if (startTime >= start && startTime < end) {
        row.classList.remove('skip-flash');
        void row.offsetWidth;
        row.classList.add('skip-flash');
        setTimeout(() => row.classList.remove('skip-flash'), 600);
        break;
      }
    }
  }

  // Hide transcript panel in fullscreen mode
  document.addEventListener('fullscreenchange', () => {
    if (transcriptPanelEl) {
      transcriptPanelEl.style.display = document.fullscreenElement ? 'none' : '';
    }
  });

  // ============================================================
  // Intensity Control
  // ============================================================

  function getWoffleThreshold(intensity) {
    switch (intensity) {
      case 'light':  return 80;
      case 'medium': return 50;
      case 'heavy':  return 25;
      default:       return 50;
    }
  }

  function applyIntensity(intensity) {
    currentIntensity = intensity;
    woffleThreshold = getWoffleThreshold(intensity);
    console.log(`[Woffle] Intensity → ${intensity.toUpperCase()} (threshold: ${woffleThreshold})`);

    if (segments.length > 0) {
      renderTimeline();
      if (timelineEl) timelineEl.classList.add('intensity-transition');
      updateTranscriptClassifications();
    }
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

    // Apply the current intensity threshold to classify segments
    const woffleSegments = segments.filter(s => {
      const confidence = s.woffle_confidence ?? s.waffle_confidence ?? 0;
      return (s.woffle_confidence !== undefined || s.waffle_confidence !== undefined)
        ? confidence >= woffleThreshold
        : s.type === 'waffle';
    });

    // De-overlap woffle segments before summing
    const videoDur = video?.duration || 0;
    const sortedWoffle = [...woffleSegments].sort((a, b) => a.start - b.start);
    let totalWoffleTime = 0;
    let lastWoffleEnd = 0;
    for (const seg of sortedWoffle) {
      const start = Math.max(seg.start, lastWoffleEnd);
      const end = videoDur > 0 ? Math.min(seg.end, videoDur) : seg.end;
      if (end > start) {
        totalWoffleTime += end - start;
        lastWoffleEnd = end;
      }
    }

    return {
      videoId: currentVideoId,
      videoTitle: title.trim(),
      isAnalyzing,
      error: analysisError,
      segmentCount: segments.length,
      waffleCount: woffleSegments.length,
      substanceCount: segments.length - woffleSegments.length,
      totalWaffleTimeSec: totalWoffleTime,
      wafflesZapped,
      timeSavedSec,
      autoSkipEnabled,
      woffleIntensity: currentIntensity,
      videoDuration: video?.duration || 0,
    };
  }

  // ============================================================
  // Cleanup
  // ============================================================

  function cleanup() {
    removeElement('#waffle-timeline');
    removeElement('#woffle-scan-btn');
    removeElement('#waffle-loading');
    removeElement('#waffle-error');
    removeElement('#woffle-transcript-panel');
    removeElement('#woffle-transcript-toggle');
    hideTooltip();
    scanButtonEl = null;
    transcriptPanelEl = null;
    transcriptToggleEl = null;
    transcriptLines = [];
    lastActiveTranscriptIdx = -1;

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
