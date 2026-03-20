// popup.js - Waffle Skipper popup script
// Queries the active tab content script for status and stats,
// and opens the options page.

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
      document.getElementById('video-title').textContent = 'NO VIDEO DETECTED';
      document.getElementById('analysis-status').textContent = 'Navigate to a YouTube video';
      return;
    }

    const status = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
    if (!status) return;

    const title = status.videoTitle || 'Unknown Video';
    document.getElementById('video-title').textContent =
      title.length > 40 ? title.substring(0, 40) + '...' : title;

    const statusEl = document.getElementById('analysis-status');
    if (status.isAnalyzing) {
      statusEl.textContent = 'ANALYZING...';
      statusEl.className = 'analysis-status analyzing';
    } else if (status.error) {
      const errorMessages = {
        NO_CAPTIONS: 'NO CAPTIONS AVAILABLE',
        NO_API_KEY: 'API KEY NOT SET',
        INVALID_API_KEY: 'API KEY INVALID',
        NO_CREDITS: 'NO API CREDITS',
        RATE_LIMIT: 'RATE LIMITED',
        MODEL_UNAVAILABLE: 'MODEL UNAVAILABLE',
        CLASSIFICATION_FAILED: 'ANALYSIS FAILED',
        UNKNOWN_ERROR: 'ERROR OCCURRED'
      };
      statusEl.textContent = errorMessages[status.error] || 'ERROR';
      statusEl.className = 'analysis-status error';
    } else if (status.segmentCount > 0) {
      statusEl.textContent = 'AUTO-SKIP ACTIVE';
      statusEl.className = 'analysis-status ready';
    } else {
      statusEl.textContent = 'WAITING...';
      statusEl.className = 'analysis-status';
    }

    document.getElementById('stat-waffle-count').textContent = status.waffleCount || 0;
    document.getElementById('stat-time-saveable').textContent =
      formatTimeSaved(status.totalWaffleTimeSec || 0);
    document.getElementById('stat-skipped').textContent = status.wafflesZapped || 0;
    document.getElementById('stat-time-saved').textContent =
      formatTimeSaved(status.timeSavedSec || 0);
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