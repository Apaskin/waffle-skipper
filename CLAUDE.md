# CLAUDE.md — Waffle Skipper Chrome Extension

## Project Overview

Waffle Skipper is a Chrome extension that detects filler/waffle segments in YouTube videos and lets users skip them. It grabs YouTube transcripts, classifies segments via AI (Claude API), and injects a visual overlay into the YouTube player showing substance vs waffle segments with skip controls.

The extension is broadly functional. It was built and audited across Codex and Claude Code sessions. We are now consolidating, auditing, and preparing for Chrome Web Store submission.

## Working Directory

`C:\Users\andre\OneDrive\Desktop\WOFFLE`

## Current Phase

Phase 1: Git init + push → Phase 2: Full audit → Phase 3: UI overhaul

---

## Design Language — MANDATORY

All UI (popup, overlay, options page, icons) MUST follow this retro arcade aesthetic:

- **Vibe**: PostHog hedgehog meets Atari Paperboy meets arcade cabinet. FUN, not enterprise.
- **Font**: "Press Start 2P" from Google Fonts everywhere
- **Background**: Dark (#1a1a2e, #16213e, #0f3460)
- **Accent colours**: Gold (#e2b714), Neon green (#00ff41), Orange/waffle (#ff6b35), Cyan (#00d4ff), Magenta (#ff00ff), Red (#ff3131)
- **Dim/muted text**: #5a6988
- **Effects**: CRT scanline overlay (subtle repeating-linear-gradient), neon glow (text-shadow/box-shadow), pixel-art icons
- **Mascot**: 🧇 waffle emoji or pixel-art waffle throughout
- **Tagline**: "Skip the fluff. Get the stuff."
- **Tone**: Playful copy. "Waffles zapped" not "segments skipped". "Time saved" with a ⚡. Score counter vibes.
- **Buttons**: Chunky, bordered, glow on hover. Never flat/corporate.
- **No**: Rounded pastel cards, Inter/Roboto fonts, purple gradients, generic SaaS aesthetic

## Code Standards

- Chrome Manifest V3
- Vanilla JS + CSS (no frameworks)
- All API calls via background service worker (not content script)
- Results cached in chrome.storage.local keyed by video ID
- API key stored in chrome.storage.sync
- Handle YouTube SPA navigation (yt-navigate-finish event)
- Australian/British English in comments, US English in user-facing copy
