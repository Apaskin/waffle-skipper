// options.js — Waffle Skipper options page
// Handles API key entry/save, key visibility toggle, and cache clearing.
// Retro arcade copy: "ACCESS GRANTED" / "INVALID CODE" / etc.

document.addEventListener('DOMContentLoaded', async () => {

  const apiKeyInput   = document.getElementById('api-key');
  const saveBtn       = document.getElementById('btn-save');
  const toggleBtn     = document.getElementById('btn-toggle-visibility');
  const statusMessage = document.getElementById('status-message');
  const clearCacheBtn = document.getElementById('btn-clear-cache');
  const welcomeSection = document.getElementById('welcome-section');

  // ============================================================
  // Load Saved Key
  // ============================================================

  const { claudeApiKey } = await chrome.storage.sync.get('claudeApiKey');
  if (claudeApiKey) {
    apiKeyInput.value = claudeApiKey;
    // Hide the first-run welcome banner once a key is already configured
    if (welcomeSection) welcomeSection.style.display = 'none';
  }

  // ============================================================
  // Save Key
  // ============================================================

  saveBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();

    if (!key) {
      showStatus('ENTER A CODE FIRST', 'error');
      return;
    }

    if (!key.startsWith('sk-')) {
      showStatus('INVALID CODE ✗ — NEED sk-ant-...', 'error');
      return;
    }

    await chrome.storage.sync.set({ claudeApiKey: key });
    showStatus('ACCESS GRANTED ✓', 'success');
    if (welcomeSection) welcomeSection.style.display = 'none';
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
    const allData = await chrome.storage.local.get(null);
    const analysisKeys = Object.keys(allData).filter(k => k.startsWith('analysis_'));

    if (analysisKeys.length === 0) {
      showStatus('CACHE ALREADY EMPTY', 'info');
      return;
    }

    await chrome.storage.local.remove(analysisKeys);
    showStatus(`CLEARED ${analysisKeys.length} CACHED VIDEOS ⚡`, 'success');
    console.log(`[Waffle Skipper] Cleared ${analysisKeys.length} cached analyses`);
  });

  // ============================================================
  // Status Message Helper
  // ============================================================

  function showStatus(text, type) {
    statusMessage.textContent = text;
    statusMessage.className = `status-message ${type}`;
    statusMessage.style.display = 'block';

    setTimeout(() => {
      statusMessage.style.display = 'none';
    }, 3000);
  }
});
