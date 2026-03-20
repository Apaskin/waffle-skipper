# CLAUDE.md — Woffle Chrome Extension

## Project Overview

Woffle is a Chrome extension that detects filler/waffle segments in YouTube videos and lets users skip them. It grabs YouTube transcripts, classifies segments via AI (Claude API) with confidence scores, and injects a visual timeline overlay into the YouTube player showing substance vs waffle segments with skip controls.

**Target user**: YouTube Premium subscribers who watch long-form content (podcasts, tutorials, lectures, tech reviews) and value their time. These users already pay $14-22/month to skip ads — Woffle is the next level: skip the waffle too.

**Tagline**: "You already skip ads. Now skip the waffle."

**Positioning**: SponsorBlock is crowdsourced and only catches sponsors. Woffle is AI-powered and catches everything — tangents, filler, repetition, self-promotion, rambling anecdotes, and more.

## Working Directory

`C:\Users\andre\OneDrive\Desktop\WOFFLE`

## Architecture

### Frontend (Chrome Extension)
- Chrome Manifest V3
- Vanilla JS + CSS (no frameworks)
- Content script injected on youtube.com/watch pages
- Background service worker for comms with backend
- Results cached locally by video ID

### Backend (Cloudflare Workers + Supabase)
- Cloudflare Workers proxy for Claude API calls
- Supabase for: user auth, subscription status, credit tracking, shared analysis cache
- Stripe for billing
- All analysis goes through the backend — no direct Claude API calls from the extension

### Analysis Flow
1. User lands on YouTube video → extension checks local cache → checks shared backend cache
2. Cache miss → extension sends video ID + transcript to backend
3. Backend verifies user auth + credits → calls Claude Haiku 4.5 → returns confidence-scored segments
4. Results stored in shared cache (all users benefit) + local cache
5. Extension renders timeline overlay with segments filtered by user's intensity setting

## Credit System

| Tier | Price | Analyses/month | Notes |
|---|---|---|---|
| **Free** | $0 | 10 videos | No channel auto-analyse |
| **Woffle Plus** | $4.99/mo | 150 videos | Channel auto-analyse (up to 5 channels) |
| **Woffle Pro** | $9.99/mo | 500 videos | Channel auto-analyse (unlimited channels) |
| **Top-up** | $1.99 | 50 videos | Available on any tier |

Credits always visible in popup: "42 of 150 scans remaining"

Cache hits (shared or local) do NOT consume credits — only fresh API analyses count.

## Confidence Scoring System

The AI returns a waffle confidence score (0-100) per segment rather than a binary classification. This enables client-side filtering across three intensity levels without re-analysing:

| Score range | Meaning | Light | Medium | Heavy |
|---|---|---|---|---|
| 80-100 | Definite waffle (sponsors, subscribe pleas) | WAFFLE | WAFFLE | WAFFLE |
| 50-79 | Probable waffle (tangents, anecdotes) | SUBSTANCE | WAFFLE | WAFFLE |
| 25-49 | Borderline (context-setting, stories) | SUBSTANCE | SUBSTANCE | WAFFLE |
| 0-24 | Definite substance | SUBSTANCE | SUBSTANCE | SUBSTANCE |

Switching intensity is instant and free — no API call, just a filter change on cached scores.

## Woffle Intensity Levels

**🟢 LIGHT — "Trim the fat"**
Sponsors, subscribe pleas, merch plugs, dead air, identical recaps. Skips ~10-15%.

**🟡 MEDIUM — "Get to the point"** (DEFAULT)
Everything in Light + personal tangents, repetitive examples, long intros/outros, slow preamble. Skips ~20-35%.

**🔴 HEAVY — "Just the substance"**
Everything in Medium + all anecdotes, banter, jokes off-topic, context-setting, any repeated points. Skips ~40-60%.

Default to MEDIUM for first-time users — Light is too conservative to demonstrate value on first use.

## Analysis Triggers

The extension does NOT auto-analyse every page load. Triggers are:

1. **Manual "SCAN" button** (all tiers) — user clicks the Woffle button in the player. Default trigger.
2. **Smart auto-analyse** (all tiers, user-enabled in settings) — fires only when:
   - User has watched for >15 seconds (not just bouncing)
   - Video is >3 minutes long
   - Not already cached (local or shared)
   - User has credits remaining
3. **Channel auto-analyse** (Plus/Pro only) — user tags specific YouTube channels. Any video from a tagged channel auto-analyses on load. Stored in chrome.storage.sync.

## YouTube Premium Focus

Woffle is designed for YouTube Premium subscribers. We do NOT build:
- Ad-state detection
- Ad-interruption pause/resume logic
- MutationObserver on ad DOM classes
- Any ad-related UI states

If ads are detected (`.ad-showing` class on player), show a soft nudge: "🧇 Woffle works best with YouTube Premium — ads can interrupt waffle detection." Not a block, just expectation-setting.

## Design Language — MANDATORY

All UI must follow this retro arcade aesthetic:

- **Vibe**: PostHog hedgehog meets Atari Paperboy meets arcade cabinet. FUN, not enterprise.
- **Font**: "Press Start 2P" (bundled locally at `fonts/PressStart2P.woff2`) everywhere. VT323 (`fonts/VT323.woff2`) for score counters.
- **Background**: Dark (#1a1a2e, #16213e, #0f3460)
- **Accent colours**: Gold (#e2b714), Neon green (#00ff41), Orange/waffle (#ff6b35), Cyan (#00d4ff), Magenta (#ff00ff), Red (#ff3131)
- **Dim/muted text**: #5a6988
- **Effects**: CRT scanline overlay (subtle repeating-linear-gradient), neon glow (text-shadow/box-shadow), pixel-art icons
- **Mascot**: 🧇 waffle emoji or pixel-art waffle throughout
- **Buttons**: Chunky, bordered, glow on hover. Never flat/corporate.
- **No**: Rounded pastel cards, Inter/Roboto fonts, purple gradients, generic SaaS aesthetic

## In-Video UI Spec

### Timeline Bar
- **Height**: 12-14px, positioned below YouTube's progress bar
- **Segments**: Green (#00ff41) for substance, orange (#ff6b35) for waffle
- **Waffle texture**: Small repeating pixel-art waffle pattern inside orange segments (for segments wide enough). Short waffle segments just solid orange.
- **Hover**: Segment scales up (scaleY 1.4), tooltip shows: "🧇 Sponsor read (2:31 - 3:48) — SKIP →"
- **Click on waffle segment**: Jumps video to segment end

### NO Floating HUD
- No scoreboard pill overlaying the video. Zero video obstruction.
- Stats live in the popup only.
- The timeline bar IS the entire in-video UI.
- On hover over the timeline bar, show a minimal expanded strip with mode + intensity indicators. Collapses when not hovering.

### Scan Button
- Small 🧇 button injected near YouTube's existing controls (subscribe area or below player)
- Click to trigger manual analysis
- Shows spinner/pulse while scanning
- Disappears or dims once analysis is complete and timeline is rendered

## Popup Spec

- Header: 🧇 + "WOFFLE" in Press Start 2P with gold glow + tagline in cyan
- NOW PLAYING: video title + analysis status
- Mode selector: ⚡ AUTO / 👆 MANUAL / 😴 OFF (3 chunky buttons)
- Intensity selector: 🟢 LIGHT / 🟡 MEDIUM / 🔴 HEAVY (3 chunky buttons)
- Score panel: WAFFLES FOUND, TIME SAVEABLE, WAFFLES ZAPPED, TIME SAVED ⚡
- Credit counter: "42 of 150 scans remaining" with progress bar
- Substance/waffle ratio bar
- Footer: ⚙ OPTIONS button + "INSERT COIN TO CONTINUE"
- No API key state: "GAME OVER — Need Access Code" with link to options

## SponsorBlock Awareness

If SponsorBlock is detected (it injects known class names into the progress bar):
- Note in popup: "SponsorBlock detected — Woffle catches what SponsorBlock doesn't"
- Optionally defer sponsor-segment classification to SponsorBlock and focus Woffle on broader waffle categories

## Code Standards

- Australian/British English in comments and internal docs
- US English in all user-facing copy (targeting US market primarily)
- No inline scripts (CSP compliance)
- No eval(), new Function(), unsanitised innerHTML
- All API calls through backend proxy, never direct from extension
- Fonts bundled locally, no external font imports
- Error handling on all async operations
- Event listeners cleaned up on navigation
