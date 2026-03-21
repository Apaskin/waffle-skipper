// options.js — Woffle settings page.
// Handles license key activation, API key input (BYOK), validation via
// test API call, and local cache management.

document.addEventListener('DOMContentLoaded', async () => {

  // ============================================================
  // Element references
  // ============================================================

  const licenseSection       = document.getElementById('license-section');
  const licenseActiveSection = document.getElementById('license-active-section');
  const licenseInput         = document.getElementById('license-input');
  const btnActivateLicense   = document.getElementById('btn-activate-license');
  const btnRemoveLicense     = document.getElementById('btn-remove-license');
  const btnDeactivateLicense = document.getElementById('btn-deactivate-license');
  const licenseStatus        = document.getElementById('license-status');

  const apikeyInput   = document.getElementById('apikey-input');
  const btnSaveKey    = document.getElementById('btn-save-key');
  const btnClearKey   = document.getElementById('btn-clear-key');
  const apikeyStatus  = document.getElementById('apikey-status');
  const clearCacheBtn = document.getElementById('btn-clear-cache');
  const cacheStatus   = document.getElementById('cache-status');

  // ============================================================
  // License key — check current state on load
  // ============================================================

  const usageState = await chrome.runtime.sendMessage({ type: 'GET_USAGE_STATE' });
  if (usageState && usageState.licensed) {
    showLicensedState();
  }

  // ============================================================
  // License key — activate
  // ============================================================

  btnActivateLicense.addEventListener('click', async () => {
    const key = licenseInput.value.trim().toUpperCase();

    if (!key) {
      showLicenseStatus('ENTER A LICENSE KEY', 'error');
      return;
    }

    btnActivateLicense.textContent = 'ACTIVATING...';
    btnActivateLicense.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({ type: 'VALIDATE_LICENSE_KEY', key });

      if (result && result.valid) {
        showLicensedState();
        showLicenseStatus('ACTIVATED ✓', 'success');
      } else {
        showLicenseStatus('INVALID KEY FORMAT ✗', 'error');
        btnActivateLicense.textContent = 'ACTIVATE';
        btnActivateLicense.disabled = false;
      }
    } catch (err) {
      showLicenseStatus('ERROR — TRY AGAIN', 'error');
      btnActivateLicense.textContent = 'ACTIVATE';
      btnActivateLicense.disabled = false;
    }
  });

  // Allow Enter key in the license input to trigger activate
  licenseInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnActivateLicense.click();
  });

  // ============================================================
  // License key — deactivate / remove
  // ============================================================

  async function deactivateLicense() {
    await chrome.runtime.sendMessage({ type: 'REMOVE_LICENSE_KEY' });
    licenseSection.style.display = '';
    licenseActiveSection.style.display = 'none';
    licenseInput.value = '';
    btnActivateLicense.textContent = 'ACTIVATE';
    btnActivateLicense.disabled = false;
    showLicenseStatus('LICENSE REMOVED', 'info');
  }

  btnDeactivateLicense.addEventListener('click', deactivateLicense);
  btnRemoveLicense.addEventListener('click', deactivateLicense);

  // ============================================================
  // Helper — toggle between unlicensed and licensed UI states
  // ============================================================

  function showLicensedState() {
    licenseSection.style.display = 'none';
    licenseActiveSection.style.display = '';
  }

  function showLicenseStatus(text, type) {
    licenseStatus.textContent = text;
    licenseStatus.className = `status-message ${type}`;
    licenseStatus.style.display = 'block';
    if (type !== 'success') {
      setTimeout(() => { licenseStatus.style.display = 'none'; }, 4000);
    }
  }

  // ============================================================
  // Load existing API key (masked display)
  // ============================================================

  const { anthropicApiKey: existingKey } = await chrome.storage.sync.get('anthropicApiKey');
  if (existingKey) {
    // Show masked version so user knows a key is saved
    apikeyInput.placeholder = existingKey.slice(0, 12) + '...' + existingKey.slice(-4);
    showApikeyStatus('ACCESS GRANTED ✓', 'success');
  }

  // ============================================================
  // Save API key — validate with a tiny test call first
  // ============================================================

  btnSaveKey.addEventListener('click', async () => {
    const key = apikeyInput.value.trim();

    if (!key) {
      showApikeyStatus('ENTER AN API KEY', 'error');
      return;
    }

    // Basic format check — Anthropic keys start with sk-ant-
    if (!key.startsWith('sk-ant-')) {
      showApikeyStatus('INVALID KEY FORMAT — SHOULD START WITH sk-ant-', 'error');
      return;
    }

    btnSaveKey.textContent = 'VALIDATING...';
    btnSaveKey.disabled = true;

    try {
      // Send a tiny test message to Haiku to validate the key
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      if (response.ok) {
        // Key works — save it
        await chrome.storage.sync.set({ anthropicApiKey: key });
        apikeyInput.value = '';
        apikeyInput.placeholder = key.slice(0, 12) + '...' + key.slice(-4);
        showApikeyStatus('ACCESS GRANTED ✓', 'success');
      } else {
        const err = await response.json().catch(() => ({}));
        const msg = err.error?.message || `HTTP ${response.status}`;
        showApikeyStatus(`INVALID KEY ✗ — ${msg}`, 'error');
      }
    } catch (err) {
      showApikeyStatus('CONNECTION ERROR — CHECK YOUR NETWORK', 'error');
    }

    btnSaveKey.textContent = 'SAVE KEY';
    btnSaveKey.disabled = false;
  });

  // ============================================================
  // Clear API key
  // ============================================================

  btnClearKey.addEventListener('click', async () => {
    await chrome.storage.sync.remove('anthropicApiKey');
    apikeyInput.value = '';
    apikeyInput.placeholder = 'sk-ant-api03-...';
    showApikeyStatus('KEY REMOVED', 'info');
  });

  // ============================================================
  // Clear local cache
  // ============================================================

  clearCacheBtn.addEventListener('click', async () => {
    const allData = await chrome.storage.local.get(null);
    const analysisKeys = Object.keys(allData).filter(k => k.startsWith('analysis_'));

    if (analysisKeys.length === 0) {
      showCacheStatus('CACHE ALREADY EMPTY', 'info');
      return;
    }

    await chrome.storage.local.remove(analysisKeys);
    showCacheStatus(`CLEARED ${analysisKeys.length} CACHED VIDEOS ⚡`, 'success');
  });

  // ============================================================
  // Status message helpers
  // ============================================================

  function showApikeyStatus(text, type) {
    apikeyStatus.textContent = text;
    apikeyStatus.className = `status-message ${type}`;
    apikeyStatus.style.display = 'block';
    // Don't auto-hide success so user can see their key is saved
    if (type !== 'success') {
      setTimeout(() => { apikeyStatus.style.display = 'none'; }, 4000);
    }
  }

  function showCacheStatus(text, type) {
    cacheStatus.textContent = text;
    cacheStatus.className = `status-message ${type}`;
    cacheStatus.style.display = 'block';
    setTimeout(() => { cacheStatus.style.display = 'none'; }, 3000);
  }
});
