# AUDIT.md — Waffle Skipper Full Codebase Audit

**Date:** 2026-03-20
**Auditor:** Claude Opus 4.6 (initial) / Claude Sonnet 4.6 (P0+P1 fixes)
**Commit baseline:** `22527ea` (feat: initial commit — working Waffle Skipper extension (pre-audit))
**P0/P1 fixes applied:** commit `fix: resolve all P0 and P1 audit issues`
**Scope:** Every file in the repository. Nothing was skimmed.

---

## 2A. Manifest & Extension Structure

### ✅ Valid Manifest V3
`manifest.json` uses `"manifest_version": 3`. No deprecated keys (no `browser_action`, no `page_action`, no `persistent` background). Service worker declared correctly.

### ✅ `activeTab` permission removed (P1-8 fixed)
`"activeTab"` removed from `manifest.json` permissions array. Only `"storage"` remains, which is the minimum required. Permission prompt for users is now cleaner.

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

### ✅ `postMessage` origin verified (P0-3 fixed)
Content script now checks `event.origin === 'https://www.youtube.com'` before processing any incoming message. Spoofed messages from page scripts or other origins are silently ignored.

### ✅ `postMessage` target origin fixed (P1-7 fixed)
All `window.postMessage(...)` calls in both `page-extractor.js` and `content.js` now use `'https://www.youtube.com'` instead of `'*'`. Messages cannot be intercepted by ad iframes or other cross-origin frames.

### ✅ Fonts bundled locally (P1-2 fixed)
All `@import url(...)` removed from `content.css`, `popup.css`, and `options.css`. "Press Start 2P" (4.7KB) and "VT323" (6.6KB) WOFF2 files downloaded to `fonts/` directory. All CSS files now use local `@font-face` declarations. `manifest.json` updated with `web_accessible_resources` to serve font files to the content script CSS. No external network requests for fonts.

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

### ✅ Non-English captions — now correctly blocked (P0-1 fixed)
`selectBestTrack()` in both `background.js` and `page-extractor.js` no longer falls back to `tracks[0]`. `fetchTranscript()` tracks a `foundNonEnglishOnly` flag and throws `NO_ENGLISH_CAPTIONS` when tracks exist but none are English. `page-extractor.js`'s XHR intercept skips non-English caption URLs (detected via `lang=` parameter). Error message "WS ENGLISH CAPTIONS NOT FOUND" added to `content.js` and `popup.js`.

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

### ✅ Cache — now has 30-day TTL and 200-entry LRU limit (P0-2 fixed)
`getCachedAnalysis()` checks age against `CACHE_TTL_MS` (30 days) and removes stale entries on miss. `cacheAnalysis()` calls `evictStaleCacheEntries()` before writing, which removes expired entries and evicts oldest-first if count ≥ `CACHE_MAX_ENTRIES` (200). Cache is kept safely below the 10MB `chrome.storage.local` limit.

### ✅ Auto-skip toggle added (P1-5 fixed)
Popup now has an ON/OFF toggle button that persists to `chrome.storage.sync`. Content script reads the value on load and listens via `chrome.storage.onChanged` for live updates — toggling in the popup takes effect immediately on the active video. Scoreboard subtitle updates to "AUTO SKIP OFF" when disabled.

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

### ✅ Privacy policy document created (P1-1 fixed)
`privacy.html` created in the extension root. Covers: what data is collected (none), what is stored locally (API key + cache), what is sent to third parties (transcript text to Anthropic API only), permissions used, and contact info. **Action still required:** host this file at a public URL and add the link to the Chrome Web Store developer dashboard listing.

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

### ✅ Onboarding flow added (P1-3 fixed)
`background.js` `onInstalled` listener now calls `chrome.runtime.openOptionsPage()` when `details.reason === 'install'`. Options page now shows a first-run welcome banner ("WELCOME TO WAFFLE SKIPPER!") with step-by-step setup instructions. The banner is hidden automatically once an API key is saved.

### ✅ Rate limiting added (P1-6 fixed)
`background.js` now enforces a `MIN_API_CALL_INTERVAL_MS` (3 seconds) between Claude API calls. Cache hits bypass this entirely. The wait is applied inside `handleAnalyzeVideo` before `classifyChunks`, so rapid video-switching incurs a brief delay rather than firing concurrent API requests.

### ⚠️ User feedback for loading states — mostly good
- Loading: "WS ANALYZING..." with blinking animation — visible on the video page.
- Error: Specific error messages for each failure mode.
- Success: Timeline appears with scoreboard.
- **Missing:** No feedback in the popup during analysis beyond "ANALYZING..." — no progress indication of which step (fetching transcript, sending to Claude, etc.).

---

## Prioritized Fix List

### P0: Must Fix Before Anything Else (Broken / Security)

| # | Status | Issue | Details |
|---|--------|-------|---------|
| P0-1 | ✅ **FIXED** | **Non-English transcript sent to English-only classifier** | `selectBestTrack()` no longer falls back to `tracks[0]`. XHR intercept skips non-English URLs. `NO_ENGLISH_CAPTIONS` error added. |
| P0-2 | ✅ **FIXED** | **Cache has no expiry and no size limit** | 30-day TTL added. LRU eviction keeps entries ≤ 200. `evictStaleCacheEntries()` runs before every cache write. |
| P0-3 | ✅ **FIXED** | **`postMessage` origin not verified** | `event.origin === 'https://www.youtube.com'` check added to content script message listener. |

### P1: Must Fix Before Chrome Web Store Submission

| # | Status | Issue | Details |
|---|--------|-------|---------|
| P1-1 | ✅ **FIXED** | **No privacy policy** | `privacy.html` created. **Manual action still needed:** host at a public URL and add to Web Store dashboard. |
| P1-2 | ✅ **FIXED** | **External font loaded via CSS `@import` in content script** | Fonts downloaded to `fonts/`. All `@import url(...)` removed. `@font-face` with local paths used instead. `web_accessible_resources` added to manifest. |
| P1-3 | ✅ **FIXED** | **No onboarding — first-time users see cryptic error** | Options page opens automatically on first install. Welcome banner with step-by-step setup instructions added. |
| P1-4 | ⚠️ **MANUAL ACTION REQUIRED** | **No screenshots for Web Store listing** | Requires loading the extension in Chrome and capturing a 1280x800 screenshot. Cannot be automated. |
| P1-5 | ✅ **FIXED** | **No skip mode toggle** | ON/OFF toggle added to popup. Persisted in `chrome.storage.sync`. Live updates in content script via `onChanged` listener. |
| P1-6 | ✅ **FIXED** | **No rate limiting on API calls** | 3-second minimum interval between API calls enforced in `handleAnalyzeVideo`. Cache hits bypass the wait. |
| P1-7 | ✅ **FIXED** | **`postMessage` target origin should not be `'*'`** | All `postMessage` calls now target `'https://www.youtube.com'` in both `page-extractor.js` and `content.js`. |
| P1-8 | ✅ **FIXED** | **Remove `activeTab` permission** | Removed from `manifest.json`. Only `"storage"` permission remains. |

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
