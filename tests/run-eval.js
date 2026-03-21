#!/usr/bin/env node

// run-eval.js — Woffle classification eval harness.
//
// Sends test transcripts through the same Sonnet classification prompt
// used in the extension, then compares the AI's output against
// human-labelled segments to measure accuracy.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node run-eval.js
//   ANTHROPIC_API_KEY=sk-ant-... node run-eval.js frank-gioia-brooklyn
//   ANTHROPIC_API_KEY=sk-ant-... PROMPT_FILE=prompts/v3.1.txt node run-eval.js
//
// Environment variables:
//   ANTHROPIC_API_KEY  — required, your Anthropic API key
//   PROMPT_FILE        — optional, path to a custom prompt file (relative to tests/)
//   SONNET_MODEL       — optional, override the model (default: claude-sonnet-4-5-20250929)

const fs = require('fs');
const path = require('path');

// ============================================================
// Config
// ============================================================

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.SONNET_MODEL || 'claude-sonnet-4-5-20250929';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Intensity thresholds — must match the extension's CLAUDE.md spec
const INTENSITY_THRESHOLDS = {
  light:  80,  // woffle_confidence >= 80
  medium: 50,  // woffle_confidence >= 50
  heavy:  25,  // woffle_confidence >= 25
};

// Acceptable accuracy thresholds for a passing eval
const PASS_THRESHOLDS = {
  categoryMatch: 0.75,  // 75% of human-labelled segments must have matching category
  confidenceMatch: 0.65, // 65% must have confidence within expected range
  overall: 0.70,         // 70% combined score to pass
};

// ============================================================
// Helpers
// ============================================================

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Calculate the overlap in seconds between two time ranges.
function overlapSeconds(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

// For a given human-labelled segment, find the AI segment with
// the most time overlap. Returns null if no overlap at all.
function findBestOverlap(humanSeg, aiSegments) {
  let best = null;
  let bestOverlap = 0;

  for (const ai of aiSegments) {
    const overlap = overlapSeconds(humanSeg.start, humanSeg.end, ai.start, ai.end);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = ai;
    }
  }

  // Require at least 30% overlap with the human segment's duration
  // to count as a match (prevents spurious tiny overlaps)
  const humanDuration = humanSeg.end - humanSeg.start;
  if (humanDuration > 0 && bestOverlap / humanDuration < 0.3) {
    return null;
  }

  return best;
}

// ============================================================
// Prompt loading
// ============================================================
// If PROMPT_FILE is set, read that file. Otherwise use the hardcoded
// production prompt (v3.0 — same as background.js).

function loadSystemPrompt() {
  const promptFile = process.env.PROMPT_FILE;
  if (promptFile) {
    const fullPath = path.resolve(__dirname, promptFile);
    if (!fs.existsSync(fullPath)) {
      console.error(`ERROR: Prompt file not found: ${fullPath}`);
      process.exit(1);
    }
    console.log(`Using custom prompt: ${promptFile}`);
    return fs.readFileSync(fullPath, 'utf-8').trim();
  }

  // Default: load v3.0.txt (the production prompt)
  const defaultPath = path.join(__dirname, 'prompts', 'v3.0.txt');
  if (fs.existsSync(defaultPath)) {
    return fs.readFileSync(defaultPath, 'utf-8').trim();
  }

  console.error('ERROR: No prompt file found. Create tests/prompts/v3.0.txt');
  process.exit(1);
}

// ============================================================
// API call — same format as background.js fullAnalysis()
// ============================================================

async function classifyTranscript(transcript, videoTitle, systemPrompt) {
  const chunkText = transcript
    .map(c => `[${fmtTime(c.start)}] ${c.text}`)
    .join('\n');

  const titleLine = videoTitle ? `Video title: "${videoTitle}"\n` : '';
  const userMessage = `${titleLine}\nFull transcript:\n${chunkText}`;

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim();

  if (!text) throw new Error('Empty API response');

  // Parse — same logic as background.js parseFinal()
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      video_topic: parsed.video_topic || '',
      segments: (parsed.segments || []).map(item => ({
        start: Number(item.start) || 0,
        end: Number(item.end) || 0,
        woffle_confidence: Math.min(100, Math.max(0, Number(item.woffle_confidence) || 0)),
        category: String(item.category || 'substance'),
        label: String(item.label || ''),
      })),
    };
  } catch {
    // Try regex extraction as fallback
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) throw new Error('Could not parse API response as JSON');
    const segments = JSON.parse(arrayMatch[0]);
    return {
      video_topic: '',
      segments: segments.map(item => ({
        start: Number(item.start) || 0,
        end: Number(item.end) || 0,
        woffle_confidence: Math.min(100, Math.max(0, Number(item.woffle_confidence) || 0)),
        category: String(item.category || 'substance'),
        label: String(item.label || ''),
      })),
    };
  }
}

// ============================================================
// Segment accuracy evaluation
// ============================================================
// For each human-labelled segment, find the best-overlapping AI segment
// and check category match + confidence range.

function evaluateSegmentAccuracy(humanLabels, aiSegments) {
  const results = [];

  for (const human of humanLabels) {
    const aiMatch = findBestOverlap(human, aiSegments);

    if (!aiMatch) {
      results.push({
        human,
        aiMatch: null,
        categoryMatch: false,
        confidenceInRange: false,
        score: 0,
        note: 'NO OVERLAP — AI has no segment covering this time range',
      });
      continue;
    }

    const categoryMatch = aiMatch.category === human.expected_category;

    // Check if the AI's confidence falls within the human's expected range
    const [minConf, maxConf] = human.expected_confidence_range;
    const confidenceInRange = aiMatch.woffle_confidence >= minConf && aiMatch.woffle_confidence <= maxConf;

    // Scoring:
    //   Category match + confidence in range = 1.0
    //   Category match only = 0.75
    //   Confidence in range only (close category) = 0.5
    //   Neither = 0.0
    let score = 0;
    if (categoryMatch && confidenceInRange) score = 1.0;
    else if (categoryMatch) score = 0.75;
    else if (confidenceInRange) score = 0.5;

    // Build a note about what went wrong (if anything)
    let note = '';
    if (!categoryMatch) {
      note += `category: expected ${human.expected_category}, got ${aiMatch.category}`;
    }
    if (!confidenceInRange) {
      if (note) note += '; ';
      note += `confidence: expected ${minConf}-${maxConf}, got ${aiMatch.woffle_confidence}`;
    }

    results.push({
      human,
      aiMatch,
      categoryMatch,
      confidenceInRange,
      score,
      note: note || 'OK',
    });
  }

  return results;
}

// ============================================================
// Intensity accuracy evaluation
// ============================================================
// At each intensity threshold, count how many AI segments are "woffle"
// and sum their durations. Compare against the expected ranges.

function evaluateIntensityAccuracy(aiSegments, expectedIntensity) {
  const results = {};

  for (const [level, threshold] of Object.entries(INTENSITY_THRESHOLDS)) {
    const woffleSegs = aiSegments.filter(s => s.woffle_confidence >= threshold);
    const woffleCount = woffleSegs.length;
    const timeSaved = woffleSegs.reduce((sum, s) => sum + (s.end - s.start), 0);

    const expected = expectedIntensity[level];
    if (!expected) {
      results[level] = { woffleCount, timeSaved, pass: true, note: 'No expected values defined' };
      continue;
    }

    const countPass = woffleCount >= expected.min_woffle_segments
                   && woffleCount <= expected.max_woffle_segments;
    const timePass = timeSaved >= expected.min_time_saved_seconds
                  && timeSaved <= expected.max_time_saved_seconds;

    results[level] = {
      woffleCount,
      timeSaved: Math.round(timeSaved),
      countPass,
      timePass,
      pass: countPass && timePass,
      expected,
    };
  }

  // Key metric: each intensity level must produce meaningfully different results.
  // Medium should have more woffle than Light, Heavy more than Medium.
  const lightCount = results.light?.woffleCount || 0;
  const mediumCount = results.medium?.woffleCount || 0;
  const heavyCount = results.heavy?.woffleCount || 0;

  results._differentiation = {
    mediumVsLight: mediumCount - lightCount,
    mediumVsLightPass: (mediumCount - lightCount) > 2,
    heavyVsMedium: heavyCount - mediumCount,
    heavyVsMediumPass: (heavyCount - mediumCount) > 1,
  };

  return results;
}

// ============================================================
// Report formatting
// ============================================================

function printEvalReport(testName, segResults, intensityResults, aiResult) {
  const totalLabels = segResults.length;
  const catMatches = segResults.filter(r => r.categoryMatch).length;
  const confMatches = segResults.filter(r => r.confidenceInRange).length;
  const avgScore = totalLabels > 0
    ? segResults.reduce((sum, r) => sum + r.score, 0) / totalLabels
    : 0;

  const catPct = totalLabels > 0 ? Math.round((catMatches / totalLabels) * 100) : 0;
  const confPct = totalLabels > 0 ? Math.round((confMatches / totalLabels) * 100) : 0;
  const overallPct = Math.round(avgScore * 100);

  console.log('');
  console.log(`=== EVAL REPORT: ${testName} ===`);
  if (aiResult.video_topic) {
    console.log(`AI detected topic: "${aiResult.video_topic}"`);
  }
  console.log(`AI returned ${aiResult.segments.length} segments`);
  console.log('');

  // Segment accuracy
  console.log('SEGMENT ACCURACY:');
  console.log(`  Labelled: ${totalLabels} segments`);
  console.log(`  Category match: ${catMatches}/${totalLabels} (${catPct}%)`);
  console.log(`  Confidence in range: ${confMatches}/${totalLabels} (${confPct}%)`);

  // Show mismatches
  const mismatches = segResults.filter(r => r.score < 1.0);
  if (mismatches.length > 0) {
    console.log('');
    console.log('  MISMATCHES:');
    for (const m of mismatches) {
      const timeRange = `[${fmtTime(m.human.start)}-${fmtTime(m.human.end)}]`;
      const humanDesc = `Expected: ${m.human.expected_category} (${m.human.expected_confidence_range.join('-')})`;

      if (!m.aiMatch) {
        console.log(`  ${timeRange} ${humanDesc} — NO AI SEGMENT FOUND`);
      } else {
        const aiDesc = `Got: ${m.aiMatch.category} (${m.aiMatch.woffle_confidence})`;
        const severity = m.score >= 0.5 ? 'BORDERLINE' : 'MISS';
        console.log(`  ${timeRange} ${humanDesc}, ${aiDesc} — ${severity}`);
      }
    }
  }

  // Intensity accuracy
  console.log('');
  console.log('INTENSITY ACCURACY:');
  for (const level of ['light', 'medium', 'heavy']) {
    const r = intensityResults[level];
    if (!r) continue;
    const passLabel = r.pass ? 'PASS' : 'FAIL';
    const expectedStr = r.expected
      ? `(expected ${r.expected.min_woffle_segments}-${r.expected.max_woffle_segments}, ${r.expected.min_time_saved_seconds}-${r.expected.max_time_saved_seconds}s)`
      : '';
    const levelLabel = level.toUpperCase().padEnd(7);
    console.log(`  ${levelLabel} ${r.woffleCount} woffle, ${r.timeSaved}s saved — ${passLabel} ${expectedStr}`);
  }

  // Differentiation metrics
  const diff = intensityResults._differentiation;
  if (diff) {
    console.log('');
    console.log(`KEY METRIC: Medium differs from Light by ${diff.mediumVsLight} segments — ${diff.mediumVsLightPass ? 'PASS' : 'FAIL'} (>2 required)`);
    console.log(`KEY METRIC: Heavy differs from Medium by ${diff.heavyVsMedium} segments — ${diff.heavyVsMediumPass ? 'PASS' : 'FAIL'} (>1 required)`);
  }

  // Overall
  const catPass = catPct / 100 >= PASS_THRESHOLDS.categoryMatch;
  const confPass = confPct / 100 >= PASS_THRESHOLDS.confidenceMatch;
  const overallPass = overallPct / 100 >= PASS_THRESHOLDS.overall;
  const allIntensityPass = ['light', 'medium', 'heavy'].every(l => intensityResults[l]?.pass !== false);
  const diffPass = diff ? diff.mediumVsLightPass && diff.heavyVsMediumPass : true;

  const finalPass = catPass && overallPass && diffPass;

  console.log('');
  console.log(`OVERALL: ${overallPct}% accuracy — ${finalPass ? 'PASS' : 'NEEDS WORK'}`);

  return {
    testName,
    catPct,
    confPct,
    overallPct,
    pass: finalPass,
    aiSegmentCount: aiResult.segments.length,
  };
}

// ============================================================
// Run a single test case
// ============================================================

async function runTestCase(filePath, systemPrompt) {
  const testName = path.basename(filePath, '.json');
  console.log(`\nRunning eval: ${testName}...`);

  const testData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // Validate test data structure
  if (!testData.transcript || !Array.isArray(testData.transcript)) {
    console.error(`  ERROR: ${testName} has no transcript array`);
    return null;
  }
  if (!testData.human_labels || !Array.isArray(testData.human_labels)) {
    console.error(`  ERROR: ${testName} has no human_labels array`);
    return null;
  }

  // Call the API
  let aiResult;
  try {
    aiResult = await classifyTranscript(
      testData.transcript,
      testData.video_title,
      systemPrompt
    );
  } catch (err) {
    console.error(`  API ERROR: ${err.message}`);
    return null;
  }

  // Evaluate
  const segResults = evaluateSegmentAccuracy(testData.human_labels, aiResult.segments);
  const intensityResults = evaluateIntensityAccuracy(
    aiResult.segments,
    testData.expected_intensity_results || {}
  );

  // Print report
  return printEvalReport(testName, segResults, intensityResults, aiResult);
}

// ============================================================
// Main
// ============================================================

async function main() {
  // Validate API key
  if (!API_KEY) {
    console.error('ERROR: Set ANTHROPIC_API_KEY environment variable');
    console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... node run-eval.js [test-name]');
    process.exit(1);
  }

  // Load prompt
  const systemPrompt = loadSystemPrompt();

  // Find test files
  const evalDir = path.join(__dirname, 'eval-data');
  const specificTest = process.argv[2];

  let testFiles;
  if (specificTest) {
    // Run a single named test
    const filePath = path.join(evalDir, `${specificTest}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`ERROR: Test file not found: ${filePath}`);
      console.error(`Available tests:`);
      const available = fs.readdirSync(evalDir).filter(f => f.endsWith('.json'));
      available.forEach(f => console.error(`  ${path.basename(f, '.json')}`));
      process.exit(1);
    }
    testFiles = [filePath];
  } else {
    // Run all tests
    testFiles = fs.readdirSync(evalDir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(evalDir, f));
  }

  if (testFiles.length === 0) {
    console.error('ERROR: No test files found in tests/eval-data/');
    process.exit(1);
  }

  console.log(`Woffle Classification Eval`);
  console.log(`Model: ${MODEL}`);
  console.log(`Prompt: ${process.env.PROMPT_FILE || 'v3.0 (production)'}`);
  console.log(`Tests: ${testFiles.length}`);

  // Run each test sequentially (to avoid rate limits)
  const summaries = [];
  for (const file of testFiles) {
    const result = await runTestCase(file, systemPrompt);
    if (result) summaries.push(result);

    // Small delay between API calls to be respectful of rate limits
    if (testFiles.indexOf(file) < testFiles.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Print summary if multiple tests ran
  if (summaries.length > 1) {
    console.log('\n');
    console.log('=== SUMMARY ===');
    const maxName = Math.max(...summaries.map(s => s.testName.length));
    for (const s of summaries) {
      const name = s.testName.padEnd(maxName + 2);
      const status = s.pass ? 'PASS' : 'NEEDS WORK';
      console.log(`${name} ${s.overallPct}% — ${status}`);
    }
    const passing = summaries.filter(s => s.pass).length;
    console.log(`OVERALL: ${Math.round(summaries.reduce((sum, s) => sum + s.overallPct, 0) / summaries.length)}% — ${passing}/${summaries.length} passing`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
