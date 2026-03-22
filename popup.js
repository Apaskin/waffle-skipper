// popup.js — Woffle popup script.
// Queries content script for video status, manages auto-skip toggle
// and intensity selector, shows stats, and checks for API key.

document.addEventListener('DOMContentLoaded', async () => {

  // ============================================================
  // Wire up static buttons
  // ============================================================

  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ============================================================
  // API key check — show warning if no key is set
  // ============================================================

  const apiKeySection = document.getElementById('api-key-section');
  const btnSetApiKey = document.getElementById('btn-set-api-key');

  try {
    const result = await chrome.runtime.sendMessage({ type: 'CHECK_API_KEY' });
    if (!result || !result.hasKey) {
      apiKeySection.style.display = '';
    }
  } catch (err) {
    // If background script isn't ready, show the warning
    apiKeySection.style.display = '';
  }

  btnSetApiKey.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ============================================================
  // Usage indicator — daily counter, limit reached, or licensed
  // ============================================================

  const usageSection   = document.getElementById('usage-section');
  const usageFreeEl    = document.getElementById('usage-free');
  const usageLimitEl   = document.getElementById('usage-limit');
  const usageLicensed  = document.getElementById('usage-licensed');
  const usageCountEl   = document.getElementById('usage-count');
  const usageBarFill   = document.getElementById('usage-bar-fill');
  const btnUpgradePro  = document.getElementById('btn-upgrade-pro');

  btnUpgradePro.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://woffle.app' });
  });

  try {
    const usage = await chrome.runtime.sendMessage({ type: 'GET_USAGE_STATE' });

    if (usage && !usage.error) {
      usageSection.style.display = '';

      if (usage.licensed) {
        // Pro user — show gold badge
        usageLicensed.style.display = '';
      } else if (usage.atLimit) {
        // At daily limit — show upgrade prompt
        usageLimitEl.style.display = '';
      } else {
        // Free tier with scans remaining — show counter + bar
        const count = usage.dailyCount || 0;
        const limit = usage.dailyLimit || 3;
        usageCountEl.textContent = count;
        const pct = Math.round((count / limit) * 100);
        usageBarFill.style.width = `${pct}%`;
        if (count >= limit - 1) usageBarFill.classList.add('almost-full');
        usageFreeEl.style.display = '';
      }
    }
  } catch (err) {
    // Could not fetch usage state — silently skip the usage section
  }

  // ============================================================
  // Auto-skip toggle — single boolean, stored in chrome.storage.sync
  // ============================================================
  // Writing autoSkipEnabled triggers the storage.onChanged listener in
  // content.js, which updates the skip behaviour immediately.

  const btnAutoToggle = document.getElementById('btn-auto-toggle');
  const { autoSkipEnabled: initAutoSkip = true } = await chrome.storage.sync.get('autoSkipEnabled');
  setToggleState(initAutoSkip);

  btnAutoToggle.addEventListener('click', async () => {
    const next = !btnAutoToggle.classList.contains('on');
    await chrome.storage.sync.set({ autoSkipEnabled: next });
    setToggleState(next);
  });

  function setToggleState(enabled) {
    btnAutoToggle.textContent = enabled ? 'ON ⚡' : 'OFF';
    btnAutoToggle.className = `auto-toggle ${enabled ? 'on' : 'off'}`;
  }

  // ============================================================
  // Intensity selector — light / medium / heavy
  // ============================================================
  // Changes the waffle_confidence threshold client-side. Sends SET_INTENSITY
  // to the content script which re-renders the timeline and returns updated
  // stats (WAFFLES FOUND and TIME SAVEABLE recalculate based on threshold).

  const intensityBtns = document.querySelectorAll('.intensity-btn');
  const { woffleIntensity: initIntensity = 'medium' } = await chrome.storage.sync.get('woffleIntensity');
  setActiveIntensity(initIntensity);

  intensityBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const intensity = btn.dataset.intensity;
      setActiveIntensity(intensity);
      await chrome.storage.sync.set({ woffleIntensity: intensity });

      // Tell the content script to re-filter and get back updated stats.
      // SET_INTENSITY returns a status object directly; if for any reason the
      // response is missing (e.g. render error swallowed before sendResponse),
      // fall back to a plain GET_STATUS so the counters always refresh.
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && tab.url.includes('youtube.com/watch')) {
          let status = await chrome.tabs.sendMessage(tab.id, {
            type: 'SET_INTENSITY',
            intensity,
          });
          if (!status) {
            // Fallback: intensity was already written to storage, so content.js
            // has the correct threshold via storage.onChanged — just re-read status
            status = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
          }
          if (status) updateStats(status);
        }
      } catch (err) {
        // Could not update intensity on content script — intensity is still saved to storage
      }
    });
  });

  function setActiveIntensity(intensity) {
    intensityBtns.forEach(b => {
      b.classList.toggle('active', b.dataset.intensity === intensity);
    });
  }

  // ============================================================
  // Intensity tooltip hover — 500ms delay, shows description above button
  // ============================================================

  let tooltipTimer = null;
  intensityBtns.forEach(btn => {
    btn.addEventListener('mouseenter', () => {
      tooltipTimer = setTimeout(() => {
        btn.classList.add('show-tooltip');
      }, 500);
    });
    btn.addEventListener('mouseleave', () => {
      clearTimeout(tooltipTimer);
      btn.classList.remove('show-tooltip');
    });
  });

  // ============================================================
  // Timeline visibility checkbox — stored in chrome.storage.sync
  // ============================================================
  // When checked, content script injects the timeline into #movie_player
  // directly (not inside .ytp-chrome-bottom) so it stays visible even
  // when YouTube auto-hides its player controls.

  const chkAlwaysVisible = document.getElementById('chk-always-visible');
  const { timelineAlwaysVisible: initAlwaysVisible = true } =
    await chrome.storage.sync.get('timelineAlwaysVisible');
  chkAlwaysVisible.checked = initAlwaysVisible !== false;

  chkAlwaysVisible.addEventListener('change', async () => {
    await chrome.storage.sync.set({ timelineAlwaysVisible: chkAlwaysVisible.checked });
    // storage.onChanged in content.js picks this up and re-injects the timeline
  });

  // ============================================================
  // Stats helper — update score counters and ratio bar
  // ============================================================
  // Called on popup open (from GET_STATUS) and when intensity changes
  // (from SET_INTENSITY response). WAFFLES FOUND and TIME SAVEABLE
  // recalculate based on intensity; WAFFLES SKIPPED and TIME SAVED
  // are historical session counters that don't change.

  function updateStats(status) {
    document.getElementById('stat-waffle-count').textContent = status.waffleCount || 0;
    document.getElementById('stat-time-saveable').textContent =
      formatTimeSaved(status.totalWaffleTimeSec || 0);
    document.getElementById('stat-skipped').textContent = status.wafflesZapped || 0;
    document.getElementById('stat-time-saved').textContent =
      formatTimeSaved(status.timeSavedSec || 0);

    const total = (status.substanceCount || 0) + (status.waffleCount || 0);
    if (total > 0) {
      const subPct = Math.round((status.substanceCount / total) * 100);
      document.getElementById('ratio-substance').style.width = subPct + '%';
      document.getElementById('ratio-waffle').style.width = (100 - subPct) + '%';
    }
  }

  // ============================================================
  // Video status + stats — query the active YouTube tab
  // ============================================================

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
      document.getElementById('video-title').textContent = 'NO VIDEO DETECTED';
      document.getElementById('analysis-status').textContent = 'Navigate to a YouTube video';
      return;
    }

    const status = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
    if (!status) return;

    // Video title
    const title = status.videoTitle || 'Unknown Video';
    document.getElementById('video-title').textContent =
      title.length > 50 ? title.substring(0, 50) + '...' : title;

    // Analysis status line
    const statusEl = document.getElementById('analysis-status');
    if (status.isAnalyzing) {
      statusEl.textContent = 'SCANNING FOR WOFFLE...';
      statusEl.className = 'analysis-status scanning';
    } else if (status.error) {
      const errorMessages = {
        NO_CAPTIONS:           'NO CAPTIONS AVAILABLE',
        NO_ENGLISH_CAPTIONS:   'ENGLISH CAPTIONS NOT FOUND',
        NO_API_KEY:            'GAME OVER — SET API KEY FIRST',
        DAILY_LIMIT_REACHED:   'DAILY LIMIT — UPGRADE FOR MORE',
        RATE_LIMIT:            'RATE LIMITED — TRY AGAIN SOON',
        CLASSIFICATION_FAILED: 'ANALYSIS FAILED — RETRY?',
        UNKNOWN_ERROR:         'SOMETHING WENT WRONG',
      };
      statusEl.textContent = errorMessages[status.error] || 'ERROR';
      statusEl.className = status.error === 'NO_API_KEY'
        ? 'analysis-status game-over'
        : 'analysis-status error';
    } else if (status.segmentCount > 0) {
      if (status.autoSkipEnabled) {
        statusEl.textContent = 'AUTO-SKIP ACTIVE ⚡';
        statusEl.className = 'analysis-status ready';
      } else {
        statusEl.textContent = 'SKIP PAUSED';
        statusEl.className = 'analysis-status paused';
      }
    } else {
      statusEl.textContent = 'WAITING...';
      statusEl.className = 'analysis-status';
    }

    // Score counters + ratio bar
    updateStats(status);

  } catch (err) {
    // Could not connect to content script — likely no YouTube tab active
    document.getElementById('video-title').textContent = 'LOADING...';
    document.getElementById('analysis-status').textContent = 'Refresh the YouTube page';
  }
});

function formatTimeSaved(seconds) {
  if (!seconds || seconds === 0) return '0s';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}
