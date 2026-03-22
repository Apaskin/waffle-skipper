# 🧇 WOFFLE

**Skip the fluff. Get the stuff.**

> "You already skip ads. Now skip the woffle."

A Chrome extension that uses AI to detect filler segments in YouTube videos — sponsors, tangents, rambling intros, co-host reactions, repetition — and skips them automatically while you watch.

---

## How It Works

1. Navigate to any YouTube video with captions
2. Click the 🧇 **SCAN** button below the video
3. Woffle grabs the transcript and sends it to Claude AI for classification
4. Each segment is scored 0–100 for "woffle confidence"
5. A colour-coded timeline appears below the player: **green = substance**, **orange = woffle**
6. Woffle segments are skipped automatically — or you can skip manually by clicking them

---

## Features

- **Auto-skip** — woffle segments skipped in real time as you watch
- **3 intensity levels** — Light (trim the fat), Medium (get to the point), Heavy (just the substance)
- **Transcript panel** — full synced transcript with woffle highlighted and struck through
- **Keyboard shortcuts** — `Tab` jumps to next substance section, `Shift+Tab` jumps back
- **Cached results** — analysed videos are cached locally; re-watching is instant and free
- **Two-pass analysis** — Haiku does a fast intro scan (~1s), Sonnet streams the full analysis

---

## Installation

1. Clone or download this repo
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (toggle, top right)
4. Click **Load unpacked** → select the `WOFFLE` folder
5. Click the Woffle icon → **OPTIONS** → enter your Anthropic API key

---

## Getting an API Key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account — new accounts get **$5 free credit**
3. Generate an API key (starts with `sk-ant-`)
4. Paste it into the Woffle options page

---

## Cost

Each video analysis costs approximately **3–5 cents** (Haiku quick scan + Sonnet full analysis).
Cache hits are free — if another user already analysed the same video at the same intensity, you get instant results.

---

## Pricing

| Tier | Price | Daily scans |
|---|---|---|
| **Free** | $0 | 3 scans/day |
| **Woffle Pro** | $14.99 one-time | Unlimited |

Pro license keys use the format `WOFFLE-XXXX-XXXX-XXXX-XXXX`. Enter yours in the Options page.

---

## Privacy

Woffle has no servers and no accounts. Your API key and cached results stay in your browser.
Transcripts are sent directly from your browser to Anthropic using your own API key.
We never see your data.

→ [Full privacy policy](privacy.html)

---

## Tech Stack

- Chrome Manifest V3
- Vanilla JS + CSS (no frameworks)
- Claude Haiku 4.5 (quick intro scan) + Claude Sonnet 4.5 (full streaming analysis)
- "Press Start 2P" + "VT323" retro pixel fonts

---

## Limitations

- Requires videos to have captions (auto-generated or manual)
- English captions only
- Classification quality depends on the AI — it's good, not perfect

---

## License

MIT
