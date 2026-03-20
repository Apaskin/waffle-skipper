# 🧇 Waffle Skipper

**Skip the waffle in YouTube videos.**

A Chrome extension that uses AI to detect filler segments (sponsors, "like and subscribe" pleas, tangents, rambling) in YouTube videos and lets you skip them automatically.

## How It Works

1. Navigate to any YouTube video with captions
2. Waffle Skipper grabs the transcript and sends it to Claude AI for analysis
3. Each segment is classified as **SUBSTANCE** (the good stuff) or **WAFFLE** (the filler)
4. A colour-coded timeline appears below the video: green = substance, orange = waffle
5. Waffle segments are skipped automatically while the video plays

## Installation

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select the `WOFFLE` folder
5. Click the Waffle Skipper icon in your toolbar → Settings → enter your Anthropic API key

## Getting an API Key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account and add credits
3. Generate an API key (starts with `sk-ant-`)
4. Paste it into the Waffle Skipper settings page

## Claude Code Note

- This extension needs an **Anthropic API key** from `console.anthropic.com`.
- A Claude Code login/session by itself is not enough unless you also have API billing enabled.
- If analysis fails, open `chrome://extensions`, click **Service worker** under Waffle Skipper, and check logs for API errors.

## Controls

- Auto-skip is always on.
- Click anywhere on the waffle timeline to jump to that point.
- Press `Tab` to jump to the next substance (green) section.
- Press `Shift+Tab` to jump to the previous section (green or waffle). If you jump into waffle, auto-skip is temporarily bypassed for that section so you can review it.

## Tech Stack

- Chrome Manifest V3
- Vanilla JavaScript + CSS (no frameworks)
- Claude API (claude-haiku-4-5) for transcript classification
- "Press Start 2P" retro pixel font

## Limitations

- Requires videos to have captions (auto-generated or manual)
- Currently only analyses English captions
- Classification quality depends on the AI model — it's good but not perfect
- Uses your Anthropic API credits (Haiku is very cheap: ~$0.001 per video)

## Privacy

- Your API key is stored locally in Chrome's sync storage
- Video analyses are cached locally to avoid re-processing
- No data is sent anywhere except to the Anthropic API for classification
- No analytics, tracking, or telemetry
