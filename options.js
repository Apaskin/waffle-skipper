// options.js — Woffle settings page.
// Handles Supabase email/password auth (replaces the old API key input),
// shows account info for logged-in users, and manages local cache.

document.addEventListener('DOMContentLoaded', async () => {

  // ============================================================
  // Element references
  // ============================================================

  const authSection    = document.getElementById('auth-section');
  const accountSection = document.getElementById('account-section');
  const emailInput     = document.getElementById('auth-email');
  const passwordInput  = document.getElementById('auth-password');
  const btnLogin       = document.getElementById('btn-login');
  const btnSignup      = document.getElementById('btn-signup');
  const authStatus     = document.getElementById('auth-status');
  const btnLogout      = document.getElementById('btn-logout');
  const btnManageSub   = document.getElementById('btn-manage-subscription');
  const clearCacheBtn  = document.getElementById('btn-clear-cache');
  const cacheStatus    = document.getElementById('cache-status');

  // ============================================================
  // Check if already logged in
  // ============================================================

  const session = await new Promise(resolve => {
    chrome.storage.local.get('woffle_session', r => resolve(r.woffle_session || null));
  });

  if (session && session.access_token) {
    showLoggedInState(session.user?.email || '');
  }

  // ============================================================
  // Login
  // ============================================================

  btnLogin.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showAuthStatus('ENTER EMAIL + PASSWORD', 'error');
      return;
    }

    btnLogin.textContent = 'SIGNING IN...';
    btnLogin.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'LOGIN',
        email,
        password,
      });

      if (result.error) {
        showAuthStatus(result.error, 'error');
        btnLogin.textContent = 'SIGN IN';
        btnLogin.disabled = false;
        return;
      }

      showAuthStatus('ACCESS GRANTED ✓', 'success');
      setTimeout(() => showLoggedInState(email), 800);
    } catch (err) {
      showAuthStatus('CONNECTION ERROR', 'error');
      btnLogin.textContent = 'SIGN IN';
      btnLogin.disabled = false;
    }
  });

  // ============================================================
  // Signup
  // ============================================================

  btnSignup.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showAuthStatus('ENTER EMAIL + PASSWORD', 'error');
      return;
    }

    if (password.length < 6) {
      showAuthStatus('PASSWORD TOO SHORT (6+ CHARS)', 'error');
      return;
    }

    btnSignup.textContent = 'CREATING...';
    btnSignup.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SIGNUP',
        email,
        password,
      });

      if (result.error) {
        showAuthStatus(result.error, 'error');
        btnSignup.textContent = 'SIGN UP';
        btnSignup.disabled = false;
        return;
      }

      if (result.confirmed) {
        showAuthStatus('ACCOUNT CREATED ✓', 'success');
        setTimeout(() => showLoggedInState(email), 800);
      } else {
        // Email confirmation required
        showAuthStatus('CHECK YOUR EMAIL TO CONFIRM', 'info');
        btnSignup.textContent = 'SIGN UP';
        btnSignup.disabled = false;
      }
    } catch (err) {
      showAuthStatus('CONNECTION ERROR', 'error');
      btnSignup.textContent = 'SIGN UP';
      btnSignup.disabled = false;
    }
  });

  // ============================================================
  // Logout
  // ============================================================

  btnLogout.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'LOGOUT' });
    authSection.style.display = '';
    accountSection.style.display = 'none';
    emailInput.value = '';
    passwordInput.value = '';
    btnLogin.textContent = 'SIGN IN';
    btnLogin.disabled = false;
    btnSignup.textContent = 'SIGN UP';
    btnSignup.disabled = false;
  });

  // ============================================================
  // Manage subscription (Stripe Customer Portal)
  // ============================================================

  btnManageSub.addEventListener('click', async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_PORTAL_URL' });
      if (result && result.url) {
        chrome.tabs.create({ url: result.url });
      } else {
        showCacheStatus(result?.message || 'NO SUBSCRIPTION FOUND', 'error');
      }
    } catch (err) {
      showCacheStatus('CONNECTION ERROR', 'error');
    }
  });

  // ============================================================
  // Show logged-in state — hide auth form, show account info
  // ============================================================

  async function showLoggedInState(email) {
    authSection.style.display = 'none';
    accountSection.style.display = '';

    document.getElementById('account-email').textContent = email || '--';

    // Fetch full user state from backend
    try {
      const userState = await chrome.runtime.sendMessage({ type: 'GET_USER_STATE' });
      if (userState && !userState.error) {
        const tierLabels = { free: 'FREE', plus: 'PLUS ⚡', pro: 'PRO 🔥' };
        document.getElementById('account-tier').textContent =
          tierLabels[userState.tier] || 'FREE';
        document.getElementById('account-credits').textContent =
          `${userState.credits_remaining} / ${userState.credits_monthly_limit}`;
        document.getElementById('account-reset').textContent =
          userState.credits_reset_at
            ? new Date(userState.credits_reset_at).toLocaleDateString()
            : '--';
      }
    } catch (err) {
      console.log('[Woffle] Could not fetch user state:', err.message);
    }
  }

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

  function showAuthStatus(text, type) {
    authStatus.textContent = text;
    authStatus.className = `status-message ${type}`;
    authStatus.style.display = 'block';
    setTimeout(() => { authStatus.style.display = 'none'; }, 4000);
  }

  function showCacheStatus(text, type) {
    cacheStatus.textContent = text;
    cacheStatus.className = `status-message ${type}`;
    cacheStatus.style.display = 'block';
    setTimeout(() => { cacheStatus.style.display = 'none'; }, 3000);
  }
});
