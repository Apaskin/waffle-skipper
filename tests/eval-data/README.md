# Eval Test Data Format

Each `.json` file in this directory is a test case for the classification eval.

## File Structure

```json
{
  "video_id": "YouTube video ID",
  "video_title": "Full video title",
  "video_duration_seconds": 600,

  "transcript": [
    {"start": 0, "end": 10, "text": "First segment text..."},
    {"start": 10, "end": 25, "text": "Next segment text..."}
  ],

  "human_labels": [
    {
      "start": 0,
      "end": 45,
      "expected_category": "pleasantries",
      "expected_confidence_range": [80, 95],
      "notes": "Why this segment is labelled this way"
    }
  ],

  "expected_intensity_results": {
    "light":  { "min_woffle_segments": 3, "max_woffle_segments": 7, "min_time_saved_seconds": 60, "max_time_saved_seconds": 140 },
    "medium": { "min_woffle_segments": 7, "max_woffle_segments": 12, "min_time_saved_seconds": 120, "max_time_saved_seconds": 240 },
    "heavy":  { "min_woffle_segments": 10, "max_woffle_segments": 16, "min_time_saved_seconds": 180, "max_time_saved_seconds": 340 }
  }
}
```

## Field Reference

### transcript

Array of chunks matching the extension's internal format. Get these from:
- The extension's console log: `[Woffle] Built N transcript chunks`
- Or manually from YouTube's timedtext API

Each chunk has `start` (seconds), `end` (seconds), `text` (transcript text).

### human_labels

Your manual assessment of what the AI *should* classify each notable segment as.
You don't need to label every second — label the segments you care about testing:
- Clear substance that should not be marked as woffle
- Clear woffle that must be caught (sponsors, self-promo, echoes)
- Borderline cases where you want to check the AI's judgment

**Categories** (must match the prompt's category list):
`sponsor`, `self_promo`, `pleasantries`, `tangent`, `repetition`,
`cohost_echo`, `filler`, `intro_outro`, `context`, `substance`

**Confidence range**: `[min, max]` — the range you consider correct.
Use wide ranges for borderline cases (e.g. `[40, 70]`) and narrow
ranges for clear-cut cases (e.g. `[90, 100]`).

### expected_intensity_results

Expected woffle counts and time savings at each intensity level.
These are ranges, not exact values — the AI's segment boundaries
will vary run to run. Use generous ranges initially and tighten
as you build confidence in the prompt.

Intensity thresholds:
- **Light**: woffle_confidence >= 80
- **Medium**: woffle_confidence >= 50
- **Heavy**: woffle_confidence >= 25

## Tips for Good Test Cases

- Include diverse content: podcasts, tutorials, lectures, tech reviews
- Label at least 10-15 segments per test case for meaningful accuracy
- Include a mix of clear substance, clear woffle, and borderline cases
- The `notes` field is for you — explain your reasoning so you can
  revisit labels later when the AI disagrees and decide who's right
