import type { FeedbackRecord, FeedbackSource } from '../types/index.js';

// ── Types ────────────────────────────────────────────────────────────

export interface Pattern {
  type: 'design' | 'copy' | 'research' | 'strategy';
  frequency: number;
  description: string;
  affectedAgent: string;
  niche?: string;
  suggestedChange: string;
}

export interface InstructionDiff {
  agentFile: string;
  section: string;
  oldText: string;
  newText: string;
  reasoning: string;
}

export interface FeedbackWithContext {
  id: string;
  productId: string;
  niche: string;
  date: string;
  layout: number;
  typography: number;
  color: number;
  differentiation: number;
  sellability: number;
  issues: string;
  source: FeedbackSource;
  decision: string;
}

// ── Constants ────────────────────────────────────────────────────────

const SOURCE_TO_TYPE: Record<FeedbackSource, Pattern['type']> = {
  design: 'design',
  spec: 'strategy',
  research: 'research',
};

const TYPE_TO_AGENT: Record<Pattern['type'], string> = {
  design: 'designer',
  copy: 'copywriter',
  research: 'researcher',
  strategy: 'strategist',
};

const LOW_SCORE_THRESHOLD = 3;
const HIGH_SCORE_THRESHOLD = 4;
const MINIMUM_DATA_POINTS = 3;

// ── Errors ───────────────────────────────────────────────────────────

class PatternExtractorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternExtractorError';
  }
}

// ── Grouping ─────────────────────────────────────────────────────────

export function groupByAgentAndNiche(
  records: FeedbackWithContext[]
): Map<string, FeedbackWithContext[]> {
  const groups = new Map<string, FeedbackWithContext[]>();

  for (const record of records) {
    const patternType = SOURCE_TO_TYPE[record.source] ?? 'design';
    const agent = TYPE_TO_AGENT[patternType] ?? 'designer';
    const niche = record.niche || 'general';
    const key = `${agent}:${niche}`;

    const existing = groups.get(key) ?? [];
    existing.push(record);
    groups.set(key, existing);
  }

  return groups;
}

// ── Score Analysis ───────────────────────────────────────────────────

interface ScoreAnalysis {
  avgLayout: number;
  avgTypography: number;
  avgColor: number;
  avgDifferentiation: number;
  avgSellability: number;
  weakestArea: string;
  strongestArea: string;
  issueKeywords: string[];
}

function analyzeScores(records: FeedbackWithContext[]): ScoreAnalysis {
  const count = records.length;
  if (count === 0) {
    throw new PatternExtractorError('Cannot analyze empty record set');
  }

  let totalLayout = 0;
  let totalTypography = 0;
  let totalColor = 0;
  let totalDifferentiation = 0;
  let totalSellability = 0;
  const allIssues: string[] = [];

  for (const r of records) {
    totalLayout += r.layout;
    totalTypography += r.typography;
    totalColor += r.color;
    totalDifferentiation += r.differentiation;
    totalSellability += r.sellability;

    if (r.issues && r.issues.trim()) {
      allIssues.push(r.issues.trim());
    }
  }

  const avgs: Record<string, number> = {
    layout: totalLayout / count,
    typography: totalTypography / count,
    color: totalColor / count,
    differentiation: totalDifferentiation / count,
    sellability: totalSellability / count,
  };

  const sortedAreas = Object.entries(avgs).sort(([, a], [, b]) => a - b);
  const weakestArea = sortedAreas[0]?.[0] ?? 'layout';
  const strongestArea = sortedAreas[sortedAreas.length - 1]?.[0] ?? 'sellability';

  // Extract common keywords from issues
  const wordCounts = new Map<string, number>();
  for (const issue of allIssues) {
    const words = issue.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  const issueKeywords = [...wordCounts.entries()]
    .filter(([, cnt]) => cnt >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([word]) => word);

  return {
    avgLayout: avgs.layout ?? 0,
    avgTypography: avgs.typography ?? 0,
    avgColor: avgs.color ?? 0,
    avgDifferentiation: avgs.differentiation ?? 0,
    avgSellability: avgs.sellability ?? 0,
    weakestArea,
    strongestArea,
    issueKeywords,
  };
}

// ── Pattern Extraction ───────────────────────────────────────────────

export function extractPatterns(feedbackRecords: FeedbackWithContext[]): Pattern[] {
  if (feedbackRecords.length < MINIMUM_DATA_POINTS) {
    return [];
  }

  const groups = groupByAgentAndNiche(feedbackRecords);
  const patterns: Pattern[] = [];

  for (const [key, records] of groups) {
    if (records.length < MINIMUM_DATA_POINTS) {
      continue;
    }

    const [agent, niche] = key.split(':') as [string, string];
    const analysis = analyzeScores(records);
    const type = (Object.entries(TYPE_TO_AGENT).find(([, a]) => a === agent)?.[0] ?? 'design') as Pattern['type'];

    // Detect low-scoring areas
    if (analysis.avgLayout < LOW_SCORE_THRESHOLD) {
      patterns.push({
        type,
        frequency: records.length,
        description: `Layout quality consistently low (avg ${analysis.avgLayout.toFixed(1)}/5) for ${niche} products`,
        affectedAgent: agent,
        niche: niche === 'general' ? undefined : niche,
        suggestedChange: 'Improve layout structure: add more whitespace, better visual hierarchy, and clearer section separation.',
      });
    }

    if (analysis.avgTypography < LOW_SCORE_THRESHOLD) {
      patterns.push({
        type,
        frequency: records.length,
        description: `Typography quality consistently low (avg ${analysis.avgTypography.toFixed(1)}/5) for ${niche} products`,
        affectedAgent: agent,
        niche: niche === 'general' ? undefined : niche,
        suggestedChange: 'Improve typography: use better font pairings, adjust sizes for readability, ensure consistent heading hierarchy.',
      });
    }

    if (analysis.avgColor < LOW_SCORE_THRESHOLD) {
      patterns.push({
        type,
        frequency: records.length,
        description: `Color/aesthetic match consistently low (avg ${analysis.avgColor.toFixed(1)}/5) for ${niche} products`,
        affectedAgent: agent,
        niche: niche === 'general' ? undefined : niche,
        suggestedChange: 'Align color palette more closely with top-selling designs in this niche. Research current aesthetic trends.',
      });
    }

    if (analysis.avgDifferentiation < LOW_SCORE_THRESHOLD) {
      patterns.push({
        type,
        frequency: records.length,
        description: `Differentiation consistently low (avg ${analysis.avgDifferentiation.toFixed(1)}/5) for ${niche} products`,
        affectedAgent: agent,
        niche: niche === 'general' ? undefined : niche,
        suggestedChange: 'Add unique differentiating features: custom illustrations, unique section types, or innovative layout patterns.',
      });
    }

    if (analysis.avgSellability < LOW_SCORE_THRESHOLD) {
      patterns.push({
        type,
        frequency: records.length,
        description: `Overall sellability consistently low (avg ${analysis.avgSellability.toFixed(1)}/5) for ${niche} products`,
        affectedAgent: agent,
        niche: niche === 'general' ? undefined : niche,
        suggestedChange: 'Re-evaluate product-market fit. Cross-reference design choices with actual top sellers in this niche.',
      });
    }

    // Detect consistently strong areas worth reinforcing
    if (analysis.avgLayout >= HIGH_SCORE_THRESHOLD && analysis.avgTypography >= HIGH_SCORE_THRESHOLD) {
      patterns.push({
        type,
        frequency: records.length,
        description: `Strong visual execution (layout: ${analysis.avgLayout.toFixed(1)}, typography: ${analysis.avgTypography.toFixed(1)}) for ${niche} products`,
        affectedAgent: agent,
        niche: niche === 'general' ? undefined : niche,
        suggestedChange: 'Maintain current design approach. Document successful patterns for reuse across other niches.',
      });
    }

    // Detect issue patterns from keywords
    if (analysis.issueKeywords.length >= 3) {
      patterns.push({
        type,
        frequency: records.length,
        description: `Recurring issue keywords in ${niche}: ${analysis.issueKeywords.slice(0, 5).join(', ')}`,
        affectedAgent: agent,
        niche: niche === 'general' ? undefined : niche,
        suggestedChange: `Address recurring issues related to: ${analysis.issueKeywords.slice(0, 5).join(', ')}. Review specific feedback for actionable details.`,
      });
    }
  }

  // Sort by frequency (most common patterns first)
  patterns.sort((a, b) => b.frequency - a.frequency);

  return patterns;
}

// ── Instruction Diff Generation ──────────────────────────────────────

export function generateInstructionDiff(
  pattern: Pattern,
  currentInstructions: string
): InstructionDiff {
  const agentFile = `.claude/agents/${pattern.affectedAgent}.md`;
  const nicheContext = pattern.niche ? ` (${pattern.niche})` : '';

  // Find the most relevant section in current instructions
  const sectionHeaders = currentInstructions.match(/^#{1,3}\s+.+$/gm) ?? [];
  let targetSection = 'General Guidelines';

  // Try to find a matching section
  for (const header of sectionHeaders) {
    const headerLower = header.toLowerCase();
    if (
      (pattern.type === 'design' && (headerLower.includes('design') || headerLower.includes('layout') || headerLower.includes('style'))) ||
      (pattern.type === 'copy' && (headerLower.includes('copy') || headerLower.includes('writing') || headerLower.includes('seo'))) ||
      (pattern.type === 'research' && (headerLower.includes('research') || headerLower.includes('market') || headerLower.includes('trend'))) ||
      (pattern.type === 'strategy' && (headerLower.includes('strategy') || headerLower.includes('scoring') || headerLower.includes('criteria')))
    ) {
      targetSection = header.replace(/^#+\s+/, '');
      break;
    }
  }

  // Generate the new text to append
  const newGuideline = `\n\n### Auto-updated guideline${nicheContext}\n` +
    `> Pattern detected (${pattern.frequency} data points): ${pattern.description}\n\n` +
    `${pattern.suggestedChange}\n`;

  return {
    agentFile,
    section: targetSection,
    oldText: '',
    newText: newGuideline,
    reasoning: `Based on ${pattern.frequency} feedback records: ${pattern.description}. ` +
      `This pattern exceeds the minimum threshold of ${MINIMUM_DATA_POINTS} data points.`,
  };
}
