# AUDIT.md — Waffle Skipper Full Codebase Audit

**Date:** 2026-03-20
**Auditor:** Claude Opus 4.6 (automated)
**Commit baseline:** `22527ea` (feat: initial commit — working Waffle Skipper extension (pre-audit))
**Scope:** Every file in the repository. Nothing was skimmed.

---

## 2A. Manifest & Extension Structure

### ✅ Valid Manifest V3
`manifest.json` uses `"manifest_version": 3`. No deprecated keys (no `browser_action`, no `page_action`, no `persistent` background). Service worker declared correctly.

### ⚠️ Permissions — `activeTab` is unnecessary
- `"storage"` — **needed** (chrome.storage.sync for API key, chrome.storage.local for cache).
- `"activeTab"` — **unnecessary**. The extension never calls `chrome.tabs.executeScript()` or `chrome.scripting.executeScript()` dynamically. Content scripts are declared statically in the manifest, and `popup.js` uses `chrome.tabs.query()` + `chrome.tabs.sendMessage()`, which do not require `activeTab`. Removing it tightens the permission surface.

### ✅ Content scripts correctly declared
Two content script entries: `page-extractor.js` in `"world": "MAIN"` at `document_start` (correct — it must intercept XHR/fetch before YouTube's scripts load) and `content.js` + `content.css` at `document_idle` in the default ISOLATED world. Separation is correct.

### ✅ Background service worker correctly declared
`"background": { "service_worker": "background.js" }` — correct for MV3.

### ✅ Icon set complete
16px, 48px, 128px icons present in `/icons/`. All three sizes referenced in both `action.default_icon` and top-level `icons`.

### ✅ No `web_accessible_resources` declared
None needed — the extension doesn't expose any files to web pages.

### ⚠️ `host_permissions` include `api.anthropic.com`
`"host_permissions": ["https://www.youtube.com/*", "https://api.anthropic.com/*"]` — both are needed. YouTube for fetching watch page HTML as a fallback transcript source; Anthropic for the Claude API. However, Chrome Web Store reviewers may ask why a YouTube extension needs Anthropic access. The description should explain this clearly.

---

## 2B. Security & Chrome Web Store Compliance

### ✅ No inline scripts
All HTML files (`popup.html`, `options.html`) load JS via `<script src="...">` tags. No inline `onclick`, no `<script>` blocks with code. CSP compliant.

### ✅ No `eval()`, `new Function()`, or `document.write()`
Searched entire codebase — zero matches.

### ⚠️ `innerHTML` used in content.js — mostly safe, one concern
Five `innerHTML` assignments in `content.js`:
1. **Line 360 (tooltip):** `${type}` is `segEl.dataset.type.toUpperCase()` — controlled string ("SUBSTANCE" or "WAFFLE"). `${escapeHtml(preview)}` is properly escaped. `${formatTime(...)}` returns "M:SS" strings. **Safe.**
2. **Line 393 (scoreboard):** All values are static strings or numbers (`waffleSegments.length`, `wafflesZapped`, `formatTimeSaved(...)`). **Safe.**
3. **Line 580 (loading):** Static string. **Safe.**
4. **Line 605 (error):** `msg` comes from a hardcoded dictionary lookup (`messages[errorCode]`), and the fallback is also a hardcoded string. **Safe.**
5. **Line 711 (escapeHtml):** Uses the standard `div.textContent = text; return div.innerHTML` pattern. **Safe — this IS the sanitizer.**

However, **line 361** interpolates `${segEl.dataset.type}` into a CSS class name unsanitized: `<div class="waffle-tooltip-label ${segEl.dataset.type}">`. The `dataset.type` value is set by the extension itself at line 308 (`segEl.dataset.type = segment.type`) from Claude API output. If the API returned a malformed `type` string containing a quote, it could break out of the attribute. The risk is **very low** because Claude's response is parsed from a constrained JSON format and normalised by `normalizeClassificationType()` (line 697) which only returns "substance" or "waffle". But as a defense-in-depth measure, this should be escaped or validated at the DOM write site.

### ✅ API key stored in `chrome.storage.sync`, never hardcoded
API key is read from `chrome.storage.sync.get('claudeApiKey')` in both `background.js` and `options.js`. The only "hardcoded" key is the YouTube public Innertube key (`AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`) which is intentionally public — YouTube embeds it in every watch page.

### ✅ No remote code execution
No dynamically loaded JS. The only external resources loaded at runtime are:
- Google Fonts CSS (`@import url(...)` in CSS files) — loads a stylesheet, not executable code.
- YouTube API endpoints (timedtext, innertube player) — data fetches, not code.
- Anthropic API — data fetch, not code.

### ✅ All fetch/XHR calls go to expected domains only
- `background.js`: `https://www.youtube.com/watch?v=...`, `https://www.youtube.com/youtubei/v1/player`, `https://api.anthropic.com/v1/messages`
- `page-extractor.js`: Intercepts existing YouTube requests to `/api/timedtext`; makes its own fetches to `https://www.youtube.com/youtubei/v1/player`
- No other domains contacted.

### ✅ No data collection or tracking
No analytics, no telemetry, no third-party SDKs. Privacy claim in README is accurate.

### ⚠️ Content script ↔ page context communication via `window.postMessage`
`page-extractor.js` (MAIN world) sends data to `content.js` (ISOLATED world) via `window.postMessage(..., '*')`. The content script checks `event.data.source === 'waffle-skipper-extractor'` but this is a **string check, not a cryptographic verification**. Any page JavaScript could spoof this message source. The impact is limited — a malicious page could inject fake transcript data, which would result in incorrect substance/waffle classifications. It could NOT steal the API key or execute code.

**Recommendation:** Add `event.origin` check (`event.origin === 'https://www.youtube.com'`) as defense-in-depth.

### ⚠️ `postMessage` target origin is `'*'`
Both `page-extractor.js` (line 468) and `content.js` (line 111) use `window.postMessage(..., '*')`. Since both run on the same page and the messages only contain transcript data (no secrets), the risk is low. But `'*'` means any listening frame (including ads in iframes) can read these messages. Should be `window.location.origin` or `'https://www.youtube.com'`.

### ❌ Chrome Web Store: `@import url()` for Google Fonts in content script CSS
`content.css` line 1: `@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap');`

This loads an external stylesheet into every YouTube page. Chrome Web Store reviewers **may flag this** because:
1. It makes a network request to a third-party domain (Google Fonts) on every YouTube page load.
2. The extension's `host_permissions` don't include `fonts.googleapis.com` or `fonts.gstatic.com`, but CSS `@import` doesn't require host permissions — it works implicitly via content script injection.
3. Some reviewers interpret this as loading remote resources, which can delay or block approval.

**Fix:** Bundle the font files locally in the extension (download the WOFF2 files and reference them via `@font-face` with local paths). This also improves performance (no extra DNS lookup + HTTP request on every page load) and avoids the review concern entirely.

### ⚠️ `anthropic-dangerous-direct-browser-access` header
`background.js` line 640: `'anthropic-dangerous-direct-browser-access': 'true'`. This is a required header for calling the Anthropic API directly from a browser context. Anthropic requires this as an explicit opt-in acknowledging that the API key is exposed to the client. This is inherent to the extension architecture (user provides their own key), but **Chrome Web Store reviewers may question it**. The options page should clearly warn users that their API key is stored locally and used for direct API calls.

---

## 2C. Functionality Audit

### ✅ Transcript fetching — robust multi-fallback pipeline
Three approaches tried in order:
1. Pre-captured data from `page-extractor.js` XHR/fetch intercept (best — uses YouTube's own session/cookies).
2. Fetch watch page HTML, parse `captionTracks` from embedded JSON, fetch timedtext directly.
3. Innertube player API fallback with multiple client contexts (ANDROID, WEB).

Handles both JSON and XML transcript formats. Multiple retry attempts with increasing delays.

### ⚠️ No captions — good error message, but no guidance
When no captions are available, displays "WS NO CAPTIONS AVAILABLE". This is correct. However, there's no guidance to the user about WHY (auto-generated captions not available for this video, or video is in a non-English language where captions might exist but weren't detected).

### ❌ Non-English captions — silently falls back to first available track
`selectBestTrack()` (background.js line 116, page-extractor.js line 113) tries English first, then `en-*`, then falls back to `tracks[0]` — which could be any language. Sending non-English transcript text to Claude with an English-only classification prompt will produce unreliable or nonsensical results. The user gets no warning.

### ⚠️ Age-restricted / private / live — error handling is implicit
- **Age-restricted:** YouTube may not return captions for age-restricted videos without authentication. The transcript fetch will fail, and the "NO_CAPTIONS" error will show. But the user won't know WHY — it looks the same as a video without captions.
- **Private/unlisted:** If the user has access, it should work. If not, the watch page fetch in the background service worker will fail (no YouTube session cookies), but the page-extractor MAIN world script DOES have cookies, so the intercept approach should still work.
- **Live streams:** No special handling. Live streams may have captions but the transcript format may differ. Not explicitly tested.

### ✅ YouTube SPA handling — correctly implemented
- `yt-navigate-finish` event listener (line 133) — primary SPA detection.
- `popstate` event listener (line 136) — backup for browser back/forward.
- Immediate `onNavigate()` call (line 139) — catches direct page loads.
- `cleanup()` called when navigating to non-video page or different video.

### ✅ Cleanup on navigation — thorough
`cleanup()` (line 666) removes all injected DOM elements (#waffle-timeline, #waffle-scoreboard, #waffle-loading, #waffle-error, tooltip), removes the `timeupdate` listener, and resets state variables (`segments`, `isAnalyzing`, `analysisError`).

### ✅ Claude API integration — correctly structured
- API call in service worker (`background.js` line 607).
- System prompt is clear and well-structured (line 616–625).
- `max_tokens: 4096` is sufficient for the response size.
- Uses `anthropic-version: 2023-06-01` header.
- Batch processing: chunks split into batches of 40 (`CLASSIFY_BATCH_SIZE`).

### ✅ Error handling — comprehensive for API
- Model fallback: tries multiple model candidates (`claude-haiku-4-5-20251001`, `claude-haiku-4-5-latest`, `claude-3-5-haiku-latest`). Falls back on model-not-found errors.
- Specific error codes: `INVALID_API_KEY` (401/403), `RATE_LIMIT` (429), `NO_CREDITS` (billing/credit errors), `MODEL_UNAVAILABLE`.
- User-facing error messages for each code.
- "Click to retry" on classification failures.

### ⚠️ Malformed Claude response — partially handled
`parseJsonArrayFromClaudeText()` strips markdown fences and extracts a JSON array. If parsing fails, an error is thrown. However, the error message is `'INVALID_MODEL_OUTPUT: No JSON array found'` which is mapped to `CLASSIFICATION_FAILED`. The user sees "WS ANALYSIS FAILED - CLICK TO RETRY" which is reasonable. **But:** if Claude returns a valid array with unexpected segment numbers or missing fields, the code silently defaults unmatched segments to "substance" (line 749). This is actually a reasonable degradation — substance is the safe default (don't skip anything).

### ✅ Caching — correctly implemented
- Results cached in `chrome.storage.local` keyed by `analysis_${videoId}`.
- Cache versioning (`ANALYSIS_CACHE_VERSION = 2`) — old cache entries are ignored.
- Timestamp stored for each cache entry.

### ❌ Cache never expires, no max size limit
- Cached entries have a `timestamp` but it's never checked — entries live forever.
- No maximum cache size. A heavy user could accumulate thousands of cached entries (each ~10-50KB), potentially consuming significant storage. `chrome.storage.local` has a 10MB limit by default (unlimited with `"unlimitedStorage"` permission, which is NOT requested).
- The "Clear Cache" button in options is the only way to manage cache. Users may not know to do this.

### ❌ No MANUAL or OFF skip modes
CLAUDE.md mentions "always-on auto-skip" and the codebase confirms: auto-skip is **always active** when segments are loaded. There is no toggle, no manual mode, no off mode. The popup shows "AUTO SKIP ALWAYS ON" as a static label.

This is a **significant UX issue**. Users WILL want to disable auto-skip for specific segments or watch waffle sections voluntarily. The Shift+Tab "bypass until segment end" feature partially addresses this, but there's no persistent toggle.

### ⚠️ Timeline overlay — injection is fragile
`injectTimeline()` (line 322) tries three DOM locations:
1. `querySelector('.ytp-progress-bar-container')` — inserting after.
2. `.ytp-chrome-bottom` — appending.
3. `#movie_player` — last resort.

This works for the current YouTube layout but YouTube frequently changes its DOM structure. No `MutationObserver` is used to re-inject if YouTube removes the timeline (which can happen during ad playback, quality changes, or DOM updates).

### ⚠️ Fullscreen handling — partially addressed
`content.css` line 272: `#movie_player.ytp-fullscreen #waffle-scoreboard { bottom: 92px; }` adjusts the scoreboard position in fullscreen. But the timeline itself has no fullscreen-specific styling. It should still work since it's injected relative to the progress bar, but hasn't been explicitly tested for all fullscreen edge cases.

### ❌ No mode persistence (N/A — no modes exist)
Since there are no skip modes, there's nothing to persist. This will become relevant when modes are added.

### ✅ Popup — correctly queries content script
`popup.js` uses `chrome.tabs.query()` to find the active YouTube tab and `chrome.tabs.sendMessage()` to get status. Handles the case where no YouTube tab is active. Displays all relevant stats.

### ✅ Options page — save/load works
API key is saved to and loaded from `chrome.storage.sync`. Input validation checks for `sk-` prefix. Toggle visibility button works. Cache clear works.

---

## 2D. Code Quality

### ⚠️ Console.log statements throughout
Both `background.js` and `content.js` are peppered with `console.log` and `console.warn` statements. These are useful for debugging but will appear in users' DevTools console. Production extensions typically use a debug flag:
- `background.js`: 15+ console.log/warn/error calls
- `content.js`: 10+ console.log/warn calls
- `page-extractor.js`: 3+ console.log calls
- `popup.js`: 1 console.log call

Not a blocker, but noisy for end users.

### ✅ No dead code or unused variables
All declared functions are called. No orphaned code blocks. Some variables are declared at module scope and used later (standard pattern for IIFEs).

### ⚠️ Error handling — inconsistent `catch` coverage in page-extractor.js
`page-extractor.js` has numerous empty `catch (e) {}` blocks (lines 97, 110, 197, 209, 222, 233, 256, 345, 522). These silently swallow errors. While this is somewhat intentional (the extractor is a best-effort interceptor that shouldn't crash), it makes debugging extremely difficult. At minimum, each should log at `console.debug` level.

### ⚠️ Potential race condition — concurrent analysis
In `content.js`, if a user navigates to a video, the analysis starts. If they navigate away and back to the same video very quickly, the first analysis may still be in flight. The `videoId !== currentVideoId` check at line 231 handles this for navigation to a DIFFERENT video, but if they return to the same video while the first analysis is pending, `currentVideoId` would be set to the same ID and `isAnalyzing` would be `true`. The `onNavigate()` function at line 151 returns early when `videoId === currentVideoId`, so a second analysis wouldn't fire. **But** the `cleanup()` at line 159 would have already been called when they navigated away, clearing `segments` and `isAnalyzing`, so when they return, a fresh analysis WOULD fire — which is correct. **No actual race condition**, but the flow is fragile and not obvious.

### ⚠️ Potential race in page-extractor.js capture promises
`tryCaptureFromPlayerResponse()` uses `capturePromises[videoId]` to deduplicate concurrent capture attempts. This is correctly implemented — subsequent calls for the same video ID get the same promise. The `finally` block (line 441) cleans up. **Sound, but complex.**

### ✅ Event listeners cleaned up
- `timeupdateHandler` is removed in `cleanup()` and before re-adding in `enableAutoSkip()`.
- `keydownHandler` is only added once (guarded by `if (keydownHandler) return`).
- SPA navigation listeners (`yt-navigate-finish`, `popstate`) persist for the lifetime of the content script, which is correct.

### ⚠️ No timeout clearing
`content.js` uses `setTimeout` at lines 169, 213, 487 without storing the timer IDs. If `cleanup()` is called while these timeouts are pending, they'll still fire. The line 169 timeout has a guard (`if (videoId === currentVideoId)`) but lines 213 and 487 do not. Low risk — the 300ms skip cooldown (line 487) will fire harmlessly; the retry delays (line 213) could trigger a `requestTranscriptData` for a stale video, but `requestTranscriptData` for a non-current video is harmless since `analyzeVideo` checks `videoId !== currentVideoId` before using results.

### ✅ Naming consistency
Consistent `camelCase` for functions and variables. Consistent `SCREAMING_SNAKE` for constants. HTML IDs use `kebab-case`. CSS classes use `waffle-` prefix to avoid collisions with YouTube's styles. Clean and readable.

### ⚠️ Duplicated code between background.js and page-extractor.js
Several functions are duplicated:
- `selectBestTrack()` — nearly identical in both files
- `buildTimedtextCandidateUrls()` / `buildTimedtextUrls()` — same logic, different names
- `decodeXmlEntities()` — identical
- `parseXmlTimedtext()` / `parseXmlTranscript()` — similar logic
- `fetchCaptionTracksViaInnertubePlayer()` / `fetchCaptionTracksViaInnertube()` — same approach
- `YT_INNERTUBE_API_KEY_CANDIDATES` — identical constant

This is partly inherent to the architecture (MAIN world script can't share code with service worker), but it means bugs fixed in one file may not be fixed in the other.

---

## 2E. Missing for Chrome Web Store Viability

### ❌ No privacy policy
Chrome Web Store **requires** a privacy policy URL for extensions that use `host_permissions` or make network requests. This extension does both. Must provide a hosted privacy policy page.

### ⚠️ Extension description needs work
The current manifest description is "Skip the waffle in YouTube videos 🧇". This is fine for a short description but the Chrome Web Store listing also needs a detailed description (up to 132 characters for summary, plus a full description). Not a blocker for submission, but impacts discoverability.

### ❌ No screenshots or promotional images
Chrome Web Store requires at least one screenshot (1280x800 or 640x400). These don't exist yet.

### ⚠️ No keyboard accessibility for popup/options
The popup and options page buttons have no visible focus indicators beyond browser defaults. The retro styling overrides default focus styles. Keyboard-only users would struggle to navigate the popup.

### ✅ Graceful degradation when API key not set
When no API key is configured:
- `handleAnalyzeVideo()` returns `{ error: 'NO_API_KEY' }`.
- Content script shows "WS API KEY NOT SET - OPEN SETTINGS".
- Popup shows "API KEY NOT SET".
This is clear and actionable.

### ❌ No onboarding flow for first-time users
After installation, the user must:
1. Know to click the extension icon
2. Know to go to Settings
3. Know they need an Anthropic API key
4. Know how to get one from console.anthropic.com

There's no welcome page, no instructions on install, no tooltip guidance. The "NO_API_KEY" error is the first thing every new user will see, with no obvious next step visible in the YouTube overlay.

**Recommendation:** Use `chrome.runtime.onInstalled` to open the options page automatically on first install, with clear setup instructions.

### ❌ No rate limiting on API calls
Each new video triggers a Claude API call immediately (after the 1-second initial delay). There's no:
- Minimum delay between API calls
- Maximum calls per time period
- Queuing or debouncing for rapid video switching

A user quickly clicking through videos could fire many API calls in rapid succession. This wastes their API credits and could trigger Anthropic's rate limiter (which IS handled, but reactively, not proactively).

### ⚠️ User feedback for loading states — mostly good
- Loading: "WS ANALYZING..." with blinking animation — visible on the video page.
- Error: Specific error messages for each failure mode.
- Success: Timeline appears with scoreboard.
- **Missing:** No feedback in the popup during analysis beyond "ANALYZING..." — no progress indication of which step (fetching transcript, sending to Claude, etc.).

---

## Prioritized Fix List

### P0: Must Fix Before Anything Else (Broken / Security)

| # | Issue | Section | Details |
|---|-------|---------|---------|
| P0-1 | **Non-English transcript sent to English-only classifier** | 2C | `selectBestTrack()` falls back to the first available track regardless of language. Claude will produce garbage classifications. Add a language check — if no English track found, show "WS ENGLISH CAPTIONS NOT FOUND" instead of sending non-English text to the classifier. |
| P0-2 | **Cache has no expiry and no size limit** | 2C | `chrome.storage.local` has a 10MB default limit. Each cached analysis is ~10-50KB. After ~200-500 videos, storage will silently fail. Add a 30-day TTL and an LRU eviction that keeps the cache under 5MB. |
| P0-3 | **`postMessage` origin not verified** | 2B | Content script accepts messages from any source matching `event.data.source === 'waffle-skipper-extractor'`. Add `event.origin === 'https://www.youtube.com'` check. |

### P1: Must Fix Before Chrome Web Store Submission

| # | Issue | Section | Details |
|---|-------|---------|---------|
| P1-1 | **No privacy policy** | 2E | Mandatory for Web Store. Must be hosted at a public URL and linked in the developer dashboard. |
| P1-2 | **External font loaded via CSS `@import` in content script** | 2B | Bundle "Press Start 2P" and "VT323" font files locally. Remove all `@import url(...)` from CSS. This eliminates the third-party network request concern and improves load performance. |
| P1-3 | **No onboarding — first-time users see cryptic error** | 2E | Open options page on first install. Add a brief setup guide visible to new users. |
| P1-4 | **No screenshots for Web Store listing** | 2E | Need at least one 1280x800 screenshot showing the timeline overlay on a YouTube video. |
| P1-5 | **No skip mode toggle** | 2C | Users need the ability to disable auto-skip. At minimum, add a simple on/off toggle that persists in `chrome.storage.sync`. |
| P1-6 | **No rate limiting on API calls** | 2E | Add a minimum 3-second cooldown between API calls. Queue or cancel pending calls when video changes rapidly. |
| P1-7 | **`postMessage` target origin should not be `'*'`** | 2B | Replace `'*'` with `window.location.origin` in both `page-extractor.js` and `content.js`. |
| P1-8 | **Remove `activeTab` permission** | 2A | Not needed. Removing it simplifies the permission prompt for users. |

### P2: Should Fix (Quality / UX)

| # | Issue | Section | Details |
|---|-------|---------|---------|
| P2-1 | **Console.log noise in production** | 2D | Add a `DEBUG` flag or remove most console statements. Keep `console.error` for genuine errors. |
| P2-2 | **Empty `catch` blocks in page-extractor.js** | 2D | Add `console.debug` logging to aid debugging without cluttering the console. |
| P2-3 | **Timeline not re-injected after YouTube DOM mutations** | 2C | Add a `MutationObserver` to detect if the timeline element is removed and re-inject it. Especially important during ad playback. |
| P2-4 | **No `overflow: hidden` / scroll on popup** | 2A | If the video title is very long, the popup could overflow. The title is already truncated at 40 chars, but stats could also overflow on extreme values. |
| P2-5 | **Keyboard focus styles missing on popup/options** | 2E | Add `:focus-visible` outlines to all interactive elements. |
| P2-6 | **Age-restricted / private video — same error as "no captions"** | 2C | Differentiate the error messages where possible. |
| P2-7 | **Duplicated code between background.js and page-extractor.js** | 2D | Extract shared utilities into a shared file, or accept the duplication with a comment noting both must be updated together. |
| P2-8 | **`innerHTML` class injection from API data** | 2B | In tooltip rendering (line 361), `segEl.dataset.type` is interpolated into a class attribute. While normalised to "substance"/"waffle" upstream, add a safeguard at the template site. |
| P2-9 | **Timeout IDs not stored for cleanup** | 2D | Store `setTimeout` return values and clear them in `cleanup()`. |

### P3: Nice to Have

| # | Issue | Section | Details |
|---|-------|---------|---------|
| P3-1 | **Progress feedback during analysis** | 2E | Show transcript/classification steps in popup or overlay. |
| P3-2 | **Chrome Web Store detailed description** | 2E | Write compelling store description with keywords. |
| P3-3 | **Options page — model selector** | 2C | The code supports a `claudeModel` storage key but there's no UI to set it. Add a dropdown. |
| P3-4 | **Scoreboard dismiss/minimize** | 2C | The floating scoreboard may obscure video content. Add a close/minimize button. |
| P3-5 | **Cache management UI** | 2C | Show cache size and entry count on options page, not just a "Clear" button. |
| P3-6 | **Subtitle indicating "your API key" in options** | 2E | Clarify that the key is stored locally and used for direct API calls. |
| P3-7 | **`manifest.json` — consider adding `options_ui` instead of `options_page`** | 2A | `options_ui` with `open_in_tab: true` is the modern MV3 pattern. `options_page` still works but is older style. |
