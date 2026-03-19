// popup.js — Waffle Skipper popup script
// Queries the active tab's content script for video status and stats,
// handles mode switching, and opens the options page.

document.addEventListener('DOMContentLoaded', async () => {

  // ============================================================
  // Mode Buttons
  // ============================================================

  const modeButtons = document.querySelectorAll('.mode-btn');

  // Load current mode and highlight the active button
  const { skipMode } = await chrome.storage.sync.get('skipMode');
  setActiveButton(skipMode || 'MANUAL');

  // Handle mode button clicks
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      chrome.storage.sync.set({ skipMode: mode });
      setActiveButton(mode);
    });
  });

  function setActiveButton(mode) {
    modeButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }

  // ============================================================
  // Settings Button
  // ============================================================

  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ============================================================
  // Query Active Tab for Status
  // ============================================================

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
      // Not on a YouTube video page
      document.getElementById('video-title').textContent = 'NO VIDEO DETECTED';
      document.getElementById('analysis-status').textContent = 'Navigate to a YouTube video';
      return;
    }

    // Request status from content script
    const status = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });

    if (!status) return;

    // Update video title (truncate if too long)
    const title = status.videoTitle || 'Unknown Video';
    document.getElementById('video-title').textContent =
      title.length > 40 ? title.substring(0, 40) + '...' : title;

    // Update analysis status
    const statusEl = document.getElementById('analysis-status');
    if (status.isAnalyzing) {
      statusEl.textContent = 'ANALYZING...';
      statusEl.className = 'analysis-status analyzing';
    } else if (status.error) {
      const errorMessages = {
        'NO_CAPTIONS': 'NO CAPTIONS AVAILABLE',
        'NO_API_KEY': 'API KEY NOT SET',
        'CLASSIFICATION_FAILED': 'ANALYSIS FAILED',
        'UNKNOWN_ERROR': 'ERROR OCCURRED',
      };
      statusEl.textContent = errorMessages[status.error] || 'ERROR';
      statusEl.className = 'analysis-status error';
    } else if (status.segmentCount > 0) {
      statusEl.textContent = 'READY';
      statusEl.className = 'analysis-status ready';
    } else {
      statusEl.textContent = 'WAITING...';
      statusEl.className = 'analysis-status';
    }

    // Update stats
    document.getElementById('stat-waffle-count').textContent = status.waffleCount || 0;
    document.getElementById('stat-time-saveable').textContent =
      formatTimeSaved(status.totalWaffleTimeSec || 0);
    document.getElementById('stat-skipped').textContent = status.wafflesZapped || 0;
    document.getElementById('stat-time-saved').textContent =
      formatTimeSaved(status.timeSavedSec || 0);

    // Update mode buttons to match content script state
    setActiveButton(status.currentMode || 'MANUAL');

  } catch (err) {
    // Content script might not be injected yet (e.g., page just loaded)
    console.log('[Waffle Skipper] Could not connect to content script:', err.message);
    document.getElementById('video-title').textContent = 'LOADING...';
    document.getElementById('analysis-status').textContent = 'Refresh the YouTube page';
  }
});

// Format seconds into human-readable time
function formatTimeSaved(seconds) {
  if (!seconds || seconds === 0) return '0s';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}
