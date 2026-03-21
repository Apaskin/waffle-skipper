# WOFFLE — Frontend Extension Audit

**Date**: 2026-03-21
**Auditor**: Claude Opus 4.6
**Scope**: All files in extension root (excludes `worker/` and `supabase/`)
**Approach**: Full read of every file, line by line. No skimming.

---

## 1. File Inventory

| File | Lines | Purpose | Last Meaningful Change |
|---|---|---|---|
| `manifest.json` | 49 | Chrome MV3 manifest — permissions, content scripts, icons | `765e98d` Sonnet classification, woffle branding |
| `background.js` | 923 | Service worker — auth, transcript fetching, two-pass analysis pipeline, caching | `765e98d` Sonnet classification, woffle branding |
| `content.js` | 1327 | Content script (ISOLATED) — timeline, auto-skip, scan button, transcript panel, SPA nav | `df441df` tooltip overflow, stats update |
| `content.css` | 481 | Styles for timeline bar, tooltips, scan button, transcript panel, skip flash | `eedeb0c` font injection, segment diagnostics |
| `popup.html` | 154 | Popup markup — header, status, intensity, stats, credits, footer | `946cae5` replace zap branding with skip |
| `popup.js` | 281 | Popup logic — auto-skip toggle, intensity selector, stats, credits | `df441df` tooltip overflow, stats update |
| `popup.css` | 767 | Popup styles — full retro arcade aesthetic | `df441df` tooltip overflow, stats update |
| `options.html` | 89 | Settings page markup — auth form, account info, cache | `946cae5` replace zap branding with skip |
| `options.js` | 221 | Settings logic — login/signup, logout, manage subscription, clear cache | `952c05a` backend proxy with credits |
| `options.css` | 360 | Settings page styles — same retro aesthetic as popup | `946cae5` replace zap branding with skip |
| `page-extractor.js` | 590 | Runs in MAIN world — intercepts YouTube XHR/fetch for timedtext, Innertube fallback | `765e98d` Sonnet classification, woffle branding |
| `privacy.html` | 110 | Privacy policy page | `765e98d` Sonnet classification, woffle branding |
| `.gitignore` | 1 | Git ignore rules | — |
| `CLAUDE.md` | ~180 | Project instructions | `2026-03-21` |
| `AUDIT.md` | ~500 | Previous audit document | `2026-03-20` |
| `DEPLOY.md` | ~200 | Deployment documentation | `2026-03-21` |
| `README.md` | ~70 | Project readme | `2026-03-20` |

**Total extension code**: ~4,972 lines across 7 JS/HTML/CSS files.

---

## 2. Manifest Review

### Validity
✅ Valid Manifest V3. All required fields present. Correct structure.

### Permissions

| Permission | Needed? | Assessment |
|---|---|---|
| `storage` | ✅ Yes | Used for settings (sync) and analysis cache (local) |
| `https://www.youtube.com/*` (host) | ✅ Yes | Content scripts on YouTube |
| `https://*.supabase.co/*` (host) | ✅ Yes | Auth (login/signup/token refresh) |
| `https://*.workers.dev/*` (host) | ⚠️ Too broad | Should be `https://woffle-api.andrewpaskin.workers.dev/*` specifically |

**Missing permissions**: None. The extension doesn't use `tabs` explicitly but calls `chrome.tabs.query` and `chrome.tabs.sendMessage` from the popup, which works because popups have implicit tab access for the active tab.

### Content Scripts
✅ Two content scripts correctly declared:
- `page-extractor.js` at `document_start` in `MAIN` world (correct — needs to patch XHR/fetch before YouTube loads)
- `content.js` + `content.css` at `document_idle` in default `ISOLATED` world (correct)

### web_accessible_resources
✅ Fonts correctly declared as web-accessible for `youtube.com` (needed because content.js injects `@font-face` rules with `chrome.runtime.getURL()`).

### Version
✅ `0.4.0` — appropriate for pre-release.

### Chrome Web Store Review

⚠️ **Would likely pass with issues**:
1. ❌ **Privacy policy is outdated** — says "We collect nothing" and "no servers, no accounts" but the extension now has Supabase auth, a backend worker, and sends transcripts to the backend. This would fail review.
2. ⚠️ Host permission `https://*.workers.dev/*` is overly broad — reviewer may flag this.
3. ✅ No inline scripts, no eval(), no remote code loading — good.

---

## 3. Content Script (`content.js` + `content.css`)

### Transcript Capture
✅ **Working correctly (by design delegation)**
- content.js does NOT capture transcripts directly — it receives them from `page-extractor.js` via `window.postMessage`.
- Has retry logic (6 attempts, 1.5s incremental delay).
- Has late-transcript auto-trigger (if transcript arrives after initial analysis failed).
- Origin check on incoming messages: `event.origin !== 'https://www.youtube.com'` ✅

### Timeline Rendering
✅ **Working correctly**
- Creates segment divs positioned as % of video duration.
- Green for substance, orange for woffle.
- Falls back to segment end time when video metadata not ready.
- Injected outside `#movie_player` (between player and title area) to avoid YouTube control overlap.

### Auto-Skip
✅ **Working correctly**
- Listens on `timeupdate` events.
- Respects `autoSkipEnabled` toggle.
- Has skip cooldown (300ms) to prevent double-skipping.
- Has bypass mechanism (`bypassAutoSkipUntil`) for when user manually seeks backward into woffle.
- Tracks `wafflesZapped` and `timeSavedSec` for stats.

### Click-to-Skip
✅ **Working correctly**
- Waffle segments have click handlers that `e.stopPropagation()` and jump to segment end.
- Timeline background has a click handler for general seeking (click anywhere = seek to that time).

### Intensity Filtering
✅ **Working correctly**
- `applyIntensity()` updates `woffleThreshold` and calls `renderTimeline()`.
- Timeline re-renders with new substance/waffle classification.
- Transcript panel classifications also update via `updateTranscriptClassifications()`.
- CSS fade animation (`intensity-transition`) gives visual feedback.

### Keyboard Navigation
✅ **Working correctly**
- Tab = jump to next substance start.
- Shift+Tab = jump to previous segment.
- Correctly skips when in typing context (input/textarea/contentEditable).
- `flashSegment()` gives visual feedback on jump target.
- Shift+Tab into waffle arms `bypassAutoSkipUntil` so auto-skip doesn't immediately skip you away.

### Transcript Panel
✅ **Working correctly**
- Builds lines from raw transcript events (fine-grained) or falls back to classified segments.
- Woffle lines styled orange with strikethrough.
- Active line highlighted with gold left border.
- Auto-scrolls to active line via `scrollIntoView()`.
- Click-to-seek on any line.
- Close button and toggle button both work.
- Hidden in fullscreen (both via JS `fullscreenchange` and CSS `.ytp-fullscreen` safety net).

### Scan Button
✅ **Working correctly**
- 🧇 button injected into `#below` area (or fallback to `#movie_player`).
- Pulsing animation while scanning.
- Dims when analysis complete.
- Prevents double-click during analysis (`if (isAnalyzing) return`).

### YouTube SPA Handling
✅ **Working correctly**
- Listens for `yt-navigate-finish` (YouTube's custom SPA event) and `popstate` (browser back/forward).
- Checks on initial load (`onNavigate()` called immediately).
- Compares `videoId === currentVideoId` to avoid re-triggering on same video.
- 1000ms delay before injecting scan button to let YouTube DOM settle.

### Timeline Visibility
✅ **Working correctly**
- `timelineAlwaysVisible` setting respected.
- Timeline injected outside `#movie_player` so it's always visible regardless of YouTube's control auto-hide.
- Re-injects timeline on setting change.

### Font Loading
✅ **Working correctly**
- `injectFonts()` creates `@font-face` rules using `chrome.runtime.getURL()`.
- Deduplication via `#woffle-fonts` ID check.
- `font-display: swap` prevents invisible text during load.

### Memory Leaks
✅ **Well handled**
- `cleanup()` removes all injected DOM elements.
- `timeupdateHandler` properly removed from video on cleanup.
- `keydownHandler` set up once (guard `if (keydownHandler) return`).
- Tooltip removed on `mouseleave` and during cleanup.

⚠️ **Minor issue**: `keydownHandler` is never removed — it's set up once via `setupKeyboardNavigation()` called from module init, and the `window.addEventListener('keydown', ...)` persists for the lifetime of the page. This is acceptable since the handler checks for segments before doing anything.

### Console Logging
🔧 **Needs cleanup before release**
- Line 75: `[Woffle] Content script loaded` — diagnostic, remove
- Lines 211-213: Verbose extractor reception log — reduce
- Line 293: `[Woffle] New video detected` — diagnostic
- Lines 472-480: `[Woffle] SEGMENT DATA:` full JSON dump — **REMOVE** (comment says "Remove this log once confirmed")
- Lines 1206-1209: Intensity diagnostic — comment says "Remove once confirmed"
- Line 568: `[Woffle] Timeline seek` — diagnostic

---

## 4. Popup (`popup.html` + `popup.css` + `popup.js`)

### Layout & Display
✅ **Displays correctly without excessive scrolling**
- Fixed width: 380px (appropriate for popup).
- Compact padding throughout (7px-10px).
- No explicit height set — content determines height.

### NOW PLAYING Section
✅ **Working correctly**
- Queries active tab for YouTube URL check.
- Sends `GET_STATUS` to content script.
- Truncates title at 50 chars with ellipsis.
- Shows appropriate status messages: SCANNING, AUTO-SKIP ACTIVE, SKIP PAUSED, WAITING, error states.

### Auto-Skip Toggle
✅ **Working correctly**
- Reads from `chrome.storage.sync` on popup open.
- Writes to `chrome.storage.sync` on toggle.
- Visual states: ON (green glow) / OFF (dim).
- Content script picks up change via `storage.onChanged` listener.

### Intensity Buttons
✅ **Working correctly**
- Three buttons with correct data attributes (light/medium/heavy).
- Active state styled per-intensity (green/gold/red).
- Click writes to storage AND sends `SET_INTENSITY` message to content script.
- Fallback: if `SET_INTENSITY` response is null, sends `GET_STATUS` to refresh stats.

### Intensity Tooltips
✅ **Working correctly**
- 500ms hover delay before showing.
- Tooltips positioned above buttons with arrow.
- Edge buttons (light/heavy) have adjusted anchor positioning to prevent popup overflow.
- Clear content: what's cut, what's kept, best-for description.

### Stats
✅ **Working correctly**
- `updateStats()` called on popup open (from `GET_STATUS`) and on intensity change (from `SET_INTENSITY` response).
- WOFFLES FOUND and TIME SAVEABLE recalculate based on intensity.
- WOFFLES SKIPPED and TIME SAVED are session counters.
- Ratio bar updates substance/woffle split.

### Credit Counter
✅ **Working correctly**
- Fetches via `GET_USER_STATE` message to background.
- Shows remaining/total format.
- Progress bar with `low` class when under 20%.
- Handles not-logged-in state gracefully.
- Hides UPGRADE button when already on Pro.

### Upgrade / Buy Credits Buttons
✅ **Working correctly**
- UPGRADE sends `GET_CHECKOUT_URL` with `tier: 'plus'`.
- BUY CREDITS sends `GET_CHECKOUT_URL` with `topup: true`.
- Opens checkout URL in new tab.
- Error handling present.

### OPTIONS Button
✅ **Working correctly**
- Calls `chrome.runtime.openOptionsPage()`.

### Keep Timeline Visible Checkbox
✅ **Working correctly**
- Reads/writes `timelineAlwaysVisible` in `chrome.storage.sync`.
- Content script picks up change via `storage.onChanged`.

### Ratio Bar
✅ **Working correctly**
- Substance (green gradient) and woffle (orange gradient) with smooth width transitions.

### Visual Quality
✅ **Matches retro arcade spec well**
- Press Start 2P font throughout.
- VT323 for score values and secondary text.
- Dark backgrounds (#090b1a, #0f1330).
- CRT scanline overlay present.
- Gold (#e2b714), neon green (#00ff41), orange (#ff6b35), cyan (#00d4ff) palette.
- Chunky bordered buttons with glow on hover.
- Gold frame border around entire popup.
- Animations: mascot glow, scan pulse, coin blink.

---

## 5. Options Page (`options.html` + `options.css` + `options.js`)

### Sign Up / Sign In
✅ **Working correctly**
- Email and password inputs in terminal-style boxes.
- SIGN IN sends `LOGIN` message to background.
- SIGN UP sends `SIGNUP` message to background.
- Password validation: minimum 6 characters.
- Handles email confirmation required state.
- Button disabled + text changed during operation.
- Status messages: success (green), error (red), info (cyan).

### Account Info (logged in)
✅ **Working correctly**
- Shows email, tier (with emoji labels), credits (remaining/total), reset date.
- Auth section hidden, account section shown.

### Manage Subscription
✅ **Working correctly**
- Sends `GET_PORTAL_URL` to background.
- Opens Stripe Customer Portal in new tab.
- Error handling present.

⚠️ **Minor**: Error message for portal failure uses `showCacheStatus()` instead of a dedicated auth status function — works but semantically wrong.

### Log Out
✅ **Working correctly**
- Sends `LOGOUT` to background (which calls `clearAuthSession()`).
- Resets UI: shows auth section, hides account section, resets buttons.

### Clear Cache
✅ **Working correctly**
- Scans `chrome.storage.local` for keys prefixed `analysis_`.
- Shows count of cleared entries.
- Handles already-empty state.

### Styling
✅ **Consistent retro aesthetic**
- Same fonts, palette, CRT overlay.
- Terminal-style input boxes with green text and blinking cursor.
- Chunky gold/dim/orange buttons.

### Input Readability
✅ **Good** — VT323 at 16px in green on dark background. Clear and readable.

---

## 6. Background Service Worker (`background.js`)

### API Call Flow
✅ **Correct architecture — all calls go through Worker proxy**
- No direct Anthropic API calls.
- `workerFetch()` adds auth header and routes through `WOFFLE_CONFIG.WORKER_URL`.
- `workerFetchRaw()` for SSE streaming responses.

### Auth Flow
✅ **Working correctly**
- Supabase JWT stored in `chrome.storage.local`.
- `getValidAccessToken()` checks JWT expiry and auto-refreshes.
- 60-second buffer before token considered expired.
- Failed refresh clears session (forces re-login).

### Message Passing
✅ **Well structured**
- Popup → Background: `GET_USER_STATE`, `LOGIN`, `SIGNUP`, `LOGOUT`, `GET_CHECKOUT_URL`, `GET_PORTAL_URL`
- Content → Background: `ANALYZE_VIDEO`
- Background → Content: `WOFFLE_QUICK_RESULT`, `WOFFLE_SEGMENT`, `WOFFLE_COMPLETE`, `WOFFLE_ERROR`
- Popup → Content: `GET_STATUS`, `SET_INTENSITY`

### Two-Pass Analysis
✅ **Implemented and working**
1. **Quick scan (Haiku)**: First 90s, `mode: 'quick'`, returns intro end point.
2. **Full scan (Sonnet)**: Entire transcript, `mode: 'full'`, streams segments via SSE.
3. Both fire simultaneously via `Promise.allSettled`.
4. Quick scan failure is non-critical (logged, not propagated as error).

### Streaming (SSE)
✅ **Implemented and working**
- `consumeSSEStream()` reads response body chunk by chunk.
- Parses SSE events: `topic`, `segment`, `done`, `error`.
- Forwards each segment to content script immediately.
- Handles partial results (stream error mid-way → uses whatever segments arrived).
- Caches complete results locally.

### Hardcoded Values
⚠️ **Present but acceptable**:
- `WOFFLE_CONFIG.WORKER_URL` — non-secret, public endpoint.
- `WOFFLE_CONFIG.SUPABASE_URL` — non-secret, public project URL.
- `WOFFLE_CONFIG.SUPABASE_ANON_KEY` — Supabase anon key is designed to be public (Row Level Security enforces access).
- `YT_INNERTUBE_API_KEY_CANDIDATES` — public YouTube API key.

### Caching
✅ **Well implemented**
- Local cache with 30-day TTL and 200-entry LRU eviction.
- Check order: local cache → backend shared cache → fresh analysis.
- Cache hits sent immediately to content script.

### Error Handling
✅ **Comprehensive**
- Auth failures → `NOT_LOGGED_IN` error.
- No transcript → `NO_CAPTIONS` or `NO_ENGLISH_CAPTIONS`.
- Classification failure → `CLASSIFICATION_FAILED` with detail.
- Tab navigation during analysis → non-critical warning logged.
- Non-English captions properly detected and rejected.

### Transcript Fetching (Background Fallback)
✅ **Robust multi-strategy approach**
1. Direct caption URL (if provided by page-extractor).
2. Watch page HTML scraping for `captionTracks`.
3. Innertube Player API fallback with multiple client variants (ANDROID, WEB).
4. Non-English detection at each level.

### Transcript Chunking
✅ **Well engineered**
- Target 4-second segments, min 1.2s, max 8s, max 320 chars.
- Smart millisecond field detection (some YouTube APIs return seconds, some milliseconds).
- Handles zero-timestamp transcripts (auto-generated timestamps from word count).
- Sentence boundary detection for natural chunk breaks.
- Gap detection (>3.5s gap forces new chunk).

---

## 7. Page Extractor (`page-extractor.js`)

### Transcript Extraction
✅ **Working correctly**
- Patches `XMLHttpRequest.prototype.open/send` and `window.fetch` before YouTube loads.
- Captures `/api/timedtext` responses.
- Supports both JSON (json3) and XML (srv3/default) formats.

### Non-English Handling
✅ **Working correctly**
- Extracts `lang=` parameter from timedtext URL.
- Skips non-English tracks (only when `lang` is positively identified as non-English).
- Unknown language passes through (safe default).

### Innertube Fallback
✅ **Working correctly**
- Multiple request variants: ANDROID client, WEB client, bare headers.
- Tries multiple API key candidates.
- Polls up to 22 attempts at 700ms intervals (~15s total).

### Communication with content.js
✅ **Working correctly**
- Posts via `window.postMessage` with specific origin `'https://www.youtube.com'` (not `'*'`).
- Source identifier: `'waffle-skipper-extractor'` (legacy name, functional).
- Responds to `'waffle-skipper-request'` from content.js.
- Proactive capture on `yt-navigate-finish`, `popstate`, and timed intervals (1.2s, 2.6s, 4.5s).

### Deduplication
✅ Video IDs tracked in `capturedTranscripts` to avoid duplicate processing. Track deduplication by URL. In-flight request deduplication via `capturePromises`.

---

## 8. Assets & Branding

### Icons
✅ Correct sizes present: `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`.

### Branding — "Woffle" vs "Waffle"
⚠️ **Mixed — requires cleanup**

**User-facing strings**: All correctly use "Woffle" / "WOFFLE".

**Internal code**: Heavy use of "waffle" in CSS class names and DOM IDs:
- `#waffle-timeline`, `.waffle-segment`, `#waffle-tooltip`, `.waffle-tooltip-*`
- `#waffle-loading`, `#waffle-error`, `#waffle-skip-flash`
- `.waffle-loading-text`, `.waffle-error-text`

**Data field names**: Legacy `waffle_confidence` supported alongside `woffle_confidence`.

**Message source**: `'waffle-skipper-extractor'` and `'waffle-skipper-request'` (legacy, internal only).

**Assessment**: Internal names don't affect users, but consistency matters for maintainability. **LOW priority** — functional, just messy.

### Privacy Policy
❌ **Critically outdated**
- Says "We collect nothing" and "no servers, no accounts" — FALSE.
- References "Your Anthropic API key" in sync storage — architecture has changed.
- Says data sent to `api.anthropic.com` using "your own API key" — now goes through backend worker.
- References `api.anthropic.com` host permission — no longer in manifest.
- Lists `chrome.storage.sync` for API key — no longer used this way.
- GitHub link references `Apaskin/waffle-skipper` — may need updating.
- Version says `0.1.0` but extension is `0.4.0`.

### Fonts
✅ Both bundled correctly: `fonts/PressStart2P.woff2`, `fonts/VT323.woff2`.

---

## 9. Code Quality

### Dead Code
🗑️ **Identified dead code**:

1. **`content.js:580-581`** — `effectiveType` backwards-compat logic for segments without `woffle_confidence` or `waffle_confidence`. The backend now always returns `woffle_confidence`. This legacy path (`segment.type === 'waffle'`) is dead unless manually cached segments from v0.1 still exist. Keep for now but mark for removal after cache TTL expires.

2. **`background.js:163-171`** — `buildTimedtextCandidateUrls()` partially duplicates the same function in `page-extractor.js`. Both are used (background for its own transcript fetching, extractor for in-page fetching).

3. **`background.js:173-180`** — `decodeXmlEntities()` duplicated between background.js and page-extractor.js. Not dead, but duplicated.

4. **`background.js:217-233`** — `extractCaptionTracksFromWatchHtml()` — used in background fallback path. Not dead, but only triggers when page-extractor fails.

### Console.logs to Remove Before Release
🔧 **Should be cleaned up**:

| File | Line(s) | Content | Action |
|---|---|---|---|
| `content.js` | 75 | `Content script loaded` | Remove |
| `content.js` | 164 | `SET_INTENSITY received` | Keep (useful debug) or reduce |
| `content.js` | 211-213 | Extractor reception details | Reduce verbosity |
| `content.js` | 293 | `New video detected` | Remove |
| `content.js` | 472-480 | **SEGMENT DATA full JSON dump** | **REMOVE** (marked for removal in comment) |
| `content.js` | 568 | `Timeline seek` | Remove |
| `content.js` | 784 | `AUTO SKIP` | Remove |
| `content.js` | 608 | `CLICK SKIP` | Remove |
| `content.js` | 845 | `Section jump` | Remove |
| `content.js` | 1202 | `Intensity →` | Remove |
| `content.js` | 1206-1209 | Intensity diagnostic | **REMOVE** (marked for removal in comment) |
| `page-extractor.js` | 574 | `Listening for YouTube caption requests` | Remove |

### Error Handling
✅ **Generally well handled**
- All async operations wrapped in try/catch.
- Errors propagated via message types (`WOFFLE_ERROR`).
- `sendToTab()` catches tab-navigation errors.
- Timeout on transcript capture (12s).

⚠️ **One gap**: `page-extractor.js` swallows most errors silently in catch blocks (`} catch (e) {}`). This is intentional (MAIN world scripts shouldn't throw visible errors on YouTube) but means debugging transcript capture issues requires adding logs temporarily.

### Naming Inconsistencies
🔧 **Mixed but minor**:
- Internal CSS/DOM: `waffle-*` prefix (legacy).
- Variable names: `woffleThreshold`, `woffleSegments` (new) alongside `waffleCount`, `wafflesZapped` (legacy).
- Status object returns both patterns: `waffleCount`, `totalWaffleTimeSec`, `wafflesZapped`.
- Some functions use "woffle" (`isLineWoffle`), DOM IDs use "waffle" (`#waffle-timeline`).

### CSS Issues
✅ **Generally clean**
- No `!important` abuse (only 2 uses: `.green-text` in options.css and `.ytp-fullscreen #woffle-transcript-panel` in content.css — both appropriate).
- CSS custom properties used consistently for palette.
- No unused styles detected.
- Specificity is well managed.

---

## 10. Architecture Assessment

### Flow 1: User Clicks SCAN

1. ✅ User clicks 🧇 button → `analyzeVideo(currentVideoId)` called.
2. ✅ `isAnalyzing = true`, loading bar injected.
3. ✅ `requestTranscriptData()` called — checks `latestTranscriptData` first, then asks page-extractor via `postMessage`. Up to 6 retries.
4. ✅ Grabs video title from DOM.
5. ✅ Sends `ANALYZE_VIDEO` to background with videoId, transcriptData, videoTitle.
6. ✅ Background checks local cache → backend shared cache → fresh analysis.
7. ✅ Background fires quick scan (Haiku) and full scan (Sonnet) simultaneously.
8. ✅ Quick result arrives → content script creates temp intro segment, skips intro if auto-skip on.
9. ✅ Full scan streams segments → content script adds each to `segments[]`, re-renders timeline.
10. ✅ `WOFFLE_COMPLETE` → final render, transcript panel built.

**No broken steps.**

### Flow 2: User Switches Intensity

1. ✅ User clicks intensity button in popup.
2. ✅ Popup saves to `chrome.storage.sync`.
3. ✅ Popup sends `SET_INTENSITY` message to content script.
4. ✅ Content script calls `applyIntensity()` → updates `woffleThreshold`, re-renders timeline.
5. ✅ Content script sends updated status back to popup.
6. ✅ Popup calls `updateStats()` with new counts.

⚠️ **Double-render concern**: The popup writes to storage (`chrome.storage.sync.set`) AND sends `SET_INTENSITY`. Content script's `storage.onChanged` listener also calls `applyIntensity()`. This means `applyIntensity()` fires twice. The comment at `content.js:162` explicitly acknowledges this: "we do NOT write to storage here." But `storage.onChanged` at line 129 DOES call `applyIntensity()`. So there IS a double-render: once from `SET_INTENSITY` message, once from `storage.onChanged`. Each `applyIntensity()` call triggers `renderTimeline()`. The timeline renders correctly both times, so there's no visual bug — just wasted work.

### Flow 3: User Navigates to New Video

1. ✅ `yt-navigate-finish` or `popstate` fires → `onNavigate()`.
2. ✅ New video ID detected → `cleanup()` removes all UI, resets state.
3. ✅ Session stats reset.
4. ✅ After 1000ms delay, scan button and transcript toggle injected.
5. ✅ No auto-analysis — user must click SCAN (correct per spec unless smart auto-analyse or channel auto-analyse is enabled — neither is implemented yet).

**No broken steps.**

### Flow 4: User Signs Up

1. ✅ User enters email + password on options page.
2. ✅ Click SIGN UP → sends `SIGNUP` message to background.
3. ✅ Background calls Supabase `/auth/v1/signup`.
4. ✅ If no email confirmation needed: stores session, returns `confirmed: true`.
5. ✅ If confirmation needed: returns `confirmed: false`, shows "CHECK YOUR EMAIL" message.
6. ✅ Options page shows account info with fetched tier/credits.

**No broken steps.**

### Flow 5: User Clicks UPGRADE

1. ✅ Click UPGRADE → sends `GET_CHECKOUT_URL` with `tier: 'plus'` to background.
2. ✅ Background calls `workerFetch('/api/stripe/checkout?tier=plus')`.
3. ✅ Backend returns Stripe checkout URL.
4. ✅ Popup opens URL in new tab.

**No broken steps** (assuming backend endpoint is deployed and Stripe is configured).

---

## Prioritized Action List

### CRITICAL (Blocks basic functionality)

*Nothing critical found.* The core analysis pipeline, timeline rendering, auto-skip, and auth flows are all functional.

### HIGH (Must fix before any public release)

1. **❌ Privacy policy is completely wrong** (`privacy.html`)
   - Claims "no servers, no accounts, no data collection" — all false now.
   - References old direct-Anthropic-API architecture.
   - References API key storage that no longer exists.
   - Version mismatch (says 0.1.0, extension is 0.4.0).
   - **Chrome Web Store will reject this.**

2. **🔧 Remove diagnostic console.logs** (`content.js`)
   - Full segment JSON dump at line 472-480 (marked "remove once confirmed").
   - Intensity diagnostic at lines 1206-1209 (marked "remove once confirmed").
   - These leak user viewing data to the console.

3. **⚠️ Host permission too broad** (`manifest.json`)
   - `https://*.workers.dev/*` matches ALL Cloudflare Workers.
   - Should be `https://woffle-api.andrewpaskin.workers.dev/*`.

### MEDIUM (Should fix for quality)

4. **⚠️ Double-render on intensity change**
   - `SET_INTENSITY` message AND `storage.onChanged` both trigger `applyIntensity()`.
   - Fix: either don't write to storage before sending message, or skip message and rely on storage change only.

5. **🔧 Manage Subscription error uses wrong status function** (`options.js:151`)
   - Uses `showCacheStatus()` instead of `showAuthStatus()`.
   - Works but shows error in wrong location on page.

6. **🔧 `keydownHandler` never cleaned up**
   - Set up once on page load, never removed.
   - Not a real leak (content scripts are page-lifetime), but inconsistent with other cleanup patterns.

7. **⚠️ Smart auto-analyse not implemented**
   - Spec calls for auto-analysis after 15s watch on videos >3min.
   - Currently only manual SCAN trigger works.
   - Not blocking release (manual mode is fine for MVP) but a gap vs spec.

8. **⚠️ Channel auto-analyse not implemented**
   - Spec calls for per-channel auto-analysis for Plus/Pro tiers.
   - Not implemented.
   - Same as above — not blocking for MVP.

### LOW (Nice to have)

9. **🔧 Legacy "waffle" naming in internal code**
    - CSS classes, DOM IDs, message source identifiers all use "waffle-*".
    - No user impact but hurts code consistency.
    - Rename to "woffle-*" in a dedicated cleanup pass.

10. **🔧 Code duplication between background.js and page-extractor.js**
    - `decodeXmlEntities()`, `buildTimedtextCandidateUrls()`, `parseXmlTranscript()`, Innertube client variants.
    - Can't easily share code between MAIN world and service worker, so this is somewhat unavoidable.

11. **🔧 Verbose console logging throughout**
    - ~25+ console.log/warn/error calls across content.js alone.
    - Consider a debug mode flag (`WOFFLE_DEBUG`) to gate diagnostic logs.

12. **🔧 SponsorBlock awareness not implemented**
    - Spec mentions detecting SponsorBlock and showing a note.
    - Not implemented.

13. **🔧 Ad detection nudge not implemented**
    - Spec mentions showing a nudge for non-Premium users.
    - Not implemented.

14. **🔧 GitHub repo reference in privacy.html**
    - Links to `Apaskin/waffle-skipper` — may need updating to match current repo name.
