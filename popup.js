// popup.js — Waffle Skipper popup script
// Queries the active tab content script for status and stats,
// manages the 3-mode selector (AUTO / MANUAL / OFF), and opens options.

document.addEventListener('DOMContentLoaded', async () => {

  // ============================================================
  // Wire up static buttons
  // ============================================================

  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ============================================================
  // Mode selector: AUTO / MANUAL / OFF
  // ============================================================
  // Stored in chrome.storage.sync as 'skipMode' — values: 'auto', 'manual', 'off'.
  // For backwards compatibility with the P1-5 autoSkipEnabled toggle:
  //   auto   → autoSkipEnabled = true
  //   manual → autoSkipEnabled = false  (timeline visible, no auto-skip)
  //   off    → autoSkipEnabled = false  (timeline visible, no auto-skip)

  const modeBtns = document.querySelectorAll('.mode-btn');
  const { skipMode = 'auto' } = await chrome.storage.sync.get('skipMode');
  setActiveMode(skipMode);

  modeBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      // Write both the new mode AND the legacy autoSkipEnabled flag
      // so the content script (which reads autoSkipEnabled) still works.
      const autoSkip = mode === 'auto';
      await chrome.storage.sync.set({ skipMode: mode, autoSkipEnabled: autoSkip });
      setActiveMode(mode);
    });
  });

  function setActiveMode(mode) {
    modeBtns.forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  // ============================================================
  // Status + Stats — query the active YouTube tab
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
      statusEl.textContent = 'SCANNING FOR WAFFLE...';
      statusEl.className = 'analysis-status scanning';
    } else if (status.error) {
      const errorMessages = {
        NO_CAPTIONS:         'NO CAPTIONS AVAILABLE',
        NO_ENGLISH_CAPTIONS: 'ENGLISH CAPTIONS NOT FOUND',
        NO_API_KEY:          'GAME OVER — NEED ACCESS CODE',
        INVALID_API_KEY:     'ACCESS CODE INVALID',
        NO_CREDITS:          'NO API CREDITS — CHECK BILLING',
        RATE_LIMIT:          'RATE LIMITED — TRY AGAIN SOON',
        MODEL_UNAVAILABLE:   'MODEL UNAVAILABLE',
        CLASSIFICATION_FAILED: 'ANALYSIS FAILED — RETRY?',
        UNKNOWN_ERROR:       'SOMETHING WENT WRONG'
      };
      statusEl.textContent = errorMessages[status.error] || 'ERROR';
      // Special "GAME OVER" style for missing API key
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

    // Score counters
    document.getElementById('stat-waffle-count').textContent = status.waffleCount || 0;
    document.getElementById('stat-time-saveable').textContent =
      formatTimeSaved(status.totalWaffleTimeSec || 0);
    document.getElementById('stat-skipped').textContent = status.wafflesZapped || 0;
    document.getElementById('stat-time-saved').textContent =
      formatTimeSaved(status.timeSavedSec || 0);

    // Ratio bar
    const total = (status.substanceCount || 0) + (status.waffleCount || 0);
    if (total > 0) {
      const subPct = Math.round((status.substanceCount / total) * 100);
      const wafPct = 100 - subPct;
      document.getElementById('ratio-substance').style.width = subPct + '%';
      document.getElementById('ratio-waffle').style.width = wafPct + '%';
    }

  } catch (err) {
    console.log('[Waffle Skipper] Could not connect to content script:', err.message);
    document.getElementById('video-title').textContent = 'LOADING...';
    document.getElementById('analysis-status').textContent = 'Refresh the YouTube page';
  }
});

function formatTimeSaved(seconds) {
  if (!seconds || seconds === 0) return '0s';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}
