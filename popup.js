// popup.js — Woffle popup script.
// Queries content script for video status, manages auto-skip toggle
// and intensity selector, shows credit counter + tier badge,
// and handles upgrade/top-up CTAs.

document.addEventListener('DOMContentLoaded', async () => {

  // ============================================================
  // Wire up static buttons
  // ============================================================

  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

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

      // Tell the content script to re-filter and get back updated stats
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && tab.url.includes('youtube.com/watch')) {
          const status = await chrome.tabs.sendMessage(tab.id, {
            type: 'SET_INTENSITY',
            intensity,
          });
          if (status) updateStats(status);
        }
      } catch (err) {
        console.log('[Woffle] Could not update intensity on content script:', err.message);
      }
    });
  });

  function setActiveIntensity(intensity) {
    intensityBtns.forEach(b => {
      b.classList.toggle('active', b.dataset.intensity === intensity);
    });
  }

  // ============================================================
  // Stats helper — update score counters and ratio bar
  // ============================================================
  // Called on popup open (from GET_STATUS) and when intensity changes
  // (from SET_INTENSITY response). WAFFLES FOUND and TIME SAVEABLE
  // recalculate based on intensity; WAFFLES ZAPPED and TIME SAVED
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
  // Credits + Tier — fetch from backend via background script
  // ============================================================

  const tierBadge = document.getElementById('tier-badge');
  const creditsText = document.getElementById('credits-text');
  const creditsBarFill = document.getElementById('credits-bar-fill');
  const btnUpgrade = document.getElementById('btn-upgrade');
  const btnTopup = document.getElementById('btn-topup');

  try {
    const userState = await chrome.runtime.sendMessage({ type: 'GET_USER_STATE' });

    if (userState && !userState.error) {
      // Tier badge
      const tier = (userState.tier || 'free').toLowerCase();
      const tierLabels = { free: 'FREE', plus: 'PLUS ⚡', pro: 'PRO 🔥' };
      tierBadge.textContent = tierLabels[tier] || 'FREE';
      tierBadge.className = `tier-badge ${tier}`;

      // Credit counter
      const remaining = userState.credits_remaining ?? 0;
      const limit = userState.credits_monthly_limit ?? 10;
      creditsText.textContent = `${remaining} of ${limit} scans remaining`;

      // Credit bar fill
      const pct = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
      creditsBarFill.style.width = `${pct}%`;
      if (pct < 20) creditsBarFill.classList.add('low');

      // Hide upgrade button if already on Pro
      if (tier === 'pro') btnUpgrade.style.display = 'none';
    } else {
      // Not logged in or fetch failed
      creditsText.textContent = 'Sign in to start';
      creditsBarFill.style.width = '0%';
    }
  } catch (err) {
    console.log('[Woffle] Could not fetch user state:', err.message);
    creditsText.textContent = 'Sign in to start';
    creditsBarFill.style.width = '0%';
  }

  // Upgrade button — opens Stripe checkout for Plus (default)
  btnUpgrade.addEventListener('click', async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_CHECKOUT_URL', tier: 'plus' });
      if (result && result.url) {
        chrome.tabs.create({ url: result.url });
      } else {
        console.error('[Woffle] No checkout URL returned:', result);
      }
    } catch (err) {
      console.error('[Woffle] Upgrade failed:', err);
    }
  });

  // Top-up button — opens Stripe checkout for one-time credit purchase
  btnTopup.addEventListener('click', async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_CHECKOUT_URL', topup: true });
      if (result && result.url) {
        chrome.tabs.create({ url: result.url });
      } else {
        console.error('[Woffle] No checkout URL returned:', result);
      }
    } catch (err) {
      console.error('[Woffle] Top-up failed:', err);
    }
  });

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
      statusEl.textContent = 'SCANNING FOR WAFFLE...';
      statusEl.className = 'analysis-status scanning';
    } else if (status.error) {
      const errorMessages = {
        NO_CAPTIONS:           'NO CAPTIONS AVAILABLE',
        NO_ENGLISH_CAPTIONS:   'ENGLISH CAPTIONS NOT FOUND',
        NOT_LOGGED_IN:         'GAME OVER — SIGN IN FIRST',
        no_credits:            'OUT OF CREDITS',
        RATE_LIMIT:            'RATE LIMITED — TRY AGAIN SOON',
        CLASSIFICATION_FAILED: 'ANALYSIS FAILED — RETRY?',
        UNKNOWN_ERROR:         'SOMETHING WENT WRONG',
      };
      statusEl.textContent = errorMessages[status.error] || 'ERROR';
      statusEl.className = (status.error === 'NOT_LOGGED_IN' || status.error === 'no_credits')
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
    console.log('[Woffle] Could not connect to content script:', err.message);
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
