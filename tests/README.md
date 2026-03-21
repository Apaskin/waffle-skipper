# Woffle Classification Eval System

Test the AI classification prompt against human-labelled video segments.
Measures category accuracy, confidence scoring, and intensity-level differentiation.

## Quick Start

```bash
cd tests
ANTHROPIC_API_KEY=sk-ant-... node run-eval.js
```

Run a single test:

```bash
ANTHROPIC_API_KEY=sk-ant-... node run-eval.js frank-gioia-brooklyn
```

## How It Works

1. Reads test cases from `eval-data/*.json`
2. Sends each transcript through the same Sonnet prompt used in the extension
3. Compares the AI's segment output against human-labelled ground truth
4. Reports category match rate, confidence accuracy, and intensity-level results

## Adding New Test Cases

1. Analyse a YouTube video with the extension
2. Copy the transcript chunks from the console log (`[Woffle] Built N transcript chunks`)
3. Create a new JSON file in `eval-data/` following the format in `eval-data/README.md`
4. Label the segments manually — watch the video and decide what's substance vs woffle
5. Run the eval: `ANTHROPIC_API_KEY=sk-ant-... node run-eval.js your-test-name`

## Iterating on Prompts

The eval supports A/B testing different prompt versions:

```bash
# Test with the current production prompt (v3.0)
ANTHROPIC_API_KEY=sk-ant-... node run-eval.js

# Test with a modified prompt
ANTHROPIC_API_KEY=sk-ant-... PROMPT_FILE=prompts/v3.1.txt node run-eval.js
```

To create a new prompt version:
1. Copy `prompts/v3.0.txt` to `prompts/v3.1.txt`
2. Make your changes
3. Run the eval with `PROMPT_FILE=prompts/v3.1.txt`
4. Compare the results — if v3.1 scores higher, update `background.js` with the new prompt

## Accuracy Thresholds

A test case **passes** when:
- Category match >= 75% (human-labelled segments matched by the AI)
- Combined score >= 70% (weighing category + confidence accuracy)
- All three intensity levels (light/medium/heavy) produce different segment counts
- Medium has >2 more woffle segments than Light
- Heavy has >1 more woffle segments than Medium

These thresholds are in `run-eval.js` under `PASS_THRESHOLDS`.

## What the Scores Mean

| Metric | Good | Acceptable | Needs Work |
|--------|------|-----------|------------|
| Category match | >85% | 75-85% | <75% |
| Confidence in range | >75% | 65-75% | <65% |
| Overall score | >85% | 70-85% | <70% |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `PROMPT_FILE` | No | Path to custom prompt file (relative to `tests/`) |
| `SONNET_MODEL` | No | Override model ID (default: `claude-sonnet-4-5-20250929`) |

## Cost

Each eval run calls Sonnet once per test case. A typical test case costs ~3-5 cents.
Running all test cases costs ~10-20 cents depending on transcript length.
