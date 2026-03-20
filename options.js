// options.js — Waffle Skipper options page
// Handles API key entry/save and cache clearing.

document.addEventListener('DOMContentLoaded', async () => {

  const apiKeyInput = document.getElementById('api-key');
  const saveBtn = document.getElementById('btn-save');
  const toggleBtn = document.getElementById('btn-toggle-visibility');
  const statusMessage = document.getElementById('status-message');
  const clearCacheBtn = document.getElementById('btn-clear-cache');

  // ============================================================
  // Load Saved Key
  // ============================================================

  const { claudeApiKey } = await chrome.storage.sync.get('claudeApiKey');
  if (claudeApiKey) {
    apiKeyInput.value = claudeApiKey;
  }

  // ============================================================
  // Save Key
  // ============================================================

  saveBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();

    if (!key) {
      showStatus('ENTER A KEY FIRST', 'error');
      return;
    }

    if (!key.startsWith('sk-')) {
      showStatus('USE ANTHROPIC API KEY (sk-...)', 'error');
      return;
    }

    await chrome.storage.sync.set({ claudeApiKey: key });
    showStatus('KEY SAVED!', 'success');
    console.log('[Waffle Skipper] API key saved');
  });

  // ============================================================
  // Toggle Key Visibility
  // ============================================================

  toggleBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleBtn.textContent = '🙈';
    } else {
      apiKeyInput.type = 'password';
      toggleBtn.textContent = '👁';
    }
  });

  // ============================================================
  // Clear Cache
  // ============================================================

  clearCacheBtn.addEventListener('click', async () => {
    // Get all keys from local storage and remove ones that start with analysis_
    const allData = await chrome.storage.local.get(null);
    const analysisKeys = Object.keys(allData).filter(k => k.startsWith('analysis_'));

    if (analysisKeys.length === 0) {
      showStatus('CACHE IS EMPTY', 'info');
      return;
    }

    await chrome.storage.local.remove(analysisKeys);
    showStatus(`CLEARED ${analysisKeys.length} CACHED VIDEOS`, 'success');
    console.log(`[Waffle Skipper] Cleared ${analysisKeys.length} cached analyses`);
  });

  // ============================================================
  // Status Message Helper
  // ============================================================

  function showStatus(text, type) {
    statusMessage.textContent = text;
    statusMessage.className = `status-message ${type}`;
    statusMessage.style.display = 'block';

    // Auto-hide after 3 seconds
    setTimeout(() => {
      statusMessage.style.display = 'none';
    }, 3000);
  }
});
