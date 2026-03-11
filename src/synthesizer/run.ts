import { readFile, readdir, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import {
  extractPatterns,
  generateInstructionDiff,
  type FeedbackWithContext,
  type Pattern,
  type InstructionDiff,
} from './pattern-extractor.js';
import type { FeedbackSource } from '../types/index.js';

// ── Constants ────────────────────────────────────────────────────────

const FEEDBACK_DIR = resolve(process.cwd(), 'feedback');
const DAILY_DIR = resolve(FEEDBACK_DIR, 'daily');
const WEEKLY_DIR = resolve(FEEDBACK_DIR, 'weekly');
const SYNTHESIZED_DIR = resolve(FEEDBACK_DIR, 'synthesized');
const AGENTS_DIR = resolve(process.cwd(), '.claude', 'agents');
const CHANGELOG_PATH = resolve(process.cwd(), 'shared', 'agent-changelog.md');
const LAST_SYNTHESIS_PATH = resolve(SYNTHESIZED_DIR, 'last-synthesis.json');
const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = resolve(STATE_DIR, 'products');

// ── Types ────────────────────────────────────────────────────────────

export interface SynthesisResult {
  patternsFound: number;
  instructionsUpdated: number;
  agentsAffected: string[];
}

interface DailyFeedbackFile {
  productId: string;
  layout: number;
  typography: number;
  color: number;
  differentiation: number;
  sellability: number;
  issues: string;
  source: FeedbackSource;
  decision?: string;
  submittedAt: string;
}

interface WeeklyBatchFile {
  submittedAt: string;
  reviews: WeeklyReviewEntry[];
}

interface WeeklyReviewEntry {
  productId: string;
  detailedNotes: string;
  instructionSuggestions: string;
}

interface LastSynthesisRecord {
  timestamp: string;
  patternsFound: number;
  instructionsUpdated: number;
}

interface ProductBriefPartial {
  niche?: string;
}

interface ProductPartial {
  niche?: string;
}

// ── Errors ───────────────────────────────────────────────────────────

class SynthesizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynthesizerError';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    if (!existsSync(dirPath)) {
      return [];
    }
    const entries = await readdir(dirPath);
    return entries.filter((e) => e.endsWith('.json'));
  } catch {
    return [];
  }
}

async function getProductNiche(productId: string): Promise<string> {
  const productPath = join(PRODUCTS_DIR, productId, 'product.json');
  const product = await readJsonFile<ProductPartial>(productPath);
  if (product?.niche) return product.niche;

  const briefPath = join(PRODUCTS_DIR, productId, 'brief.json');
  const brief = await readJsonFile<ProductBriefPartial>(briefPath);
  return brief?.niche ?? 'general';
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatDate(): string {
  return new Date().toISOString().split('T')[0] as string;
}

// ── Feedback Loading ─────────────────────────────────────────────────

async function loadLastSynthesisTime(): Promise<Date | null> {
  const record = await readJsonFile<LastSynthesisRecord>(LAST_SYNTHESIS_PATH);
  if (record?.timestamp) {
    return new Date(record.timestamp);
  }
  return null;
}

async function loadDailyFeedback(since: Date | null): Promise<FeedbackWithContext[]> {
  const files = await listJsonFiles(DAILY_DIR);
  const records: FeedbackWithContext[] = [];

  for (const file of files) {
    const filePath = join(DAILY_DIR, file);
    const data = await readJsonFile<DailyFeedbackFile>(filePath);
    if (!data) continue;

    // Filter by date if we have a last synthesis time
    if (since && data.submittedAt) {
      const submittedDate = new Date(data.submittedAt);
      if (submittedDate <= since) continue;
    }

    // Extract date from filename (format: YYYY-MM-DD-productId.json)
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : formatDate();

    const niche = await getProductNiche(data.productId);

    records.push({
      id: `daily-${file.replace('.json', '')}`,
      productId: data.productId,
      niche,
      date: date as string,
      decision: data.decision ?? 'approve',
      layout: data.layout,
      typography: data.typography,
      color: data.color,
      differentiation: data.differentiation,
      sellability: data.sellability,
      issues: data.issues,
      source: data.source,
    });
  }

  return records;
}

async function loadWeeklyFeedback(since: Date | null): Promise<FeedbackWithContext[]> {
  const files = await listJsonFiles(WEEKLY_DIR);
  const records: FeedbackWithContext[] = [];

  for (const file of files) {
    const filePath = join(WEEKLY_DIR, file);
    const data = await readJsonFile<WeeklyBatchFile>(filePath);
    if (!data) continue;

    if (since && data.submittedAt) {
      const submittedDate = new Date(data.submittedAt);
      if (submittedDate <= since) continue;
    }

    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : formatDate();

    // Convert weekly reviews to feedback context format
    // Weekly reviews don't have numeric scores, so we use neutral scores
    for (const review of data.reviews) {
      const niche = await getProductNiche(review.productId);

      records.push({
        id: `weekly-${file.replace('.json', '')}-${review.productId}`,
        productId: review.productId,
        niche,
        date: date as string,
        layout: 3,
        typography: 3,
        color: 3,
        differentiation: 3,
        sellability: 3,
        issues: [review.detailedNotes, review.instructionSuggestions]
          .filter(Boolean)
          .join(' | '),
        source: 'design',
        decision: 'approve',
      });
    }
  }

  return records;
}

// ── Instruction Updates ──────────────────────────────────────────────

async function applyInstructionDiff(diff: InstructionDiff): Promise<boolean> {
  const agentPath = resolve(process.cwd(), diff.agentFile);

  if (!existsSync(agentPath)) {
    logger.warn(`Agent file not found: ${diff.agentFile}`);
    return false;
  }

  try {
    const currentContent = await readFile(agentPath, 'utf-8');

    // Append the new guideline to the end of the file
    const updatedContent = currentContent.trimEnd() + '\n' + diff.newText;

    await writeFile(agentPath, updatedContent);
    logger.info(`Updated agent instructions: ${diff.agentFile} (section: ${diff.section})`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to update ${diff.agentFile}: ${message}`);
    return false;
  }
}

async function writeChangelog(
  patterns: Pattern[],
  diffs: InstructionDiff[],
  result: SynthesisResult
): Promise<void> {
  const sharedDir = resolve(process.cwd(), 'shared');
  await mkdir(sharedDir, { recursive: true });

  const timestamp = formatTimestamp();
  const dateStr = formatDate();

  let entry = `\n---\n\n## Synthesis Run: ${dateStr}\n\n`;
  entry += `**Timestamp:** ${timestamp}\n`;
  entry += `**Patterns Found:** ${result.patternsFound}\n`;
  entry += `**Instructions Updated:** ${result.instructionsUpdated}\n`;
  entry += `**Agents Affected:** ${result.agentsAffected.join(', ') || 'none'}\n\n`;

  if (patterns.length > 0) {
    entry += '### Patterns Detected\n\n';
    for (const pattern of patterns) {
      const nicheStr = pattern.niche ? ` [${pattern.niche}]` : '';
      entry += `- **${pattern.affectedAgent}**${nicheStr}: ${pattern.description} (${pattern.frequency} data points)\n`;
    }
    entry += '\n';
  }

  if (diffs.length > 0) {
    entry += '### Instruction Changes Applied\n\n';
    for (const diff of diffs) {
      entry += `- **${diff.agentFile}** (${diff.section}): ${diff.reasoning}\n`;
    }
    entry += '\n';
  }

  if (existsSync(CHANGELOG_PATH)) {
    await appendFile(CHANGELOG_PATH, entry);
  } else {
    const header = '# Agent Changelog\n\nAuto-generated log of instruction updates from the synthesizer.\n';
    await writeFile(CHANGELOG_PATH, header + entry);
  }

  logger.info('Changelog updated');
}

async function saveSynthesisRecord(result: SynthesisResult): Promise<void> {
  await mkdir(SYNTHESIZED_DIR, { recursive: true });

  const record: LastSynthesisRecord = {
    timestamp: formatTimestamp(),
    patternsFound: result.patternsFound,
    instructionsUpdated: result.instructionsUpdated,
  };

  await writeFile(LAST_SYNTHESIS_PATH, JSON.stringify(record, null, 2));

  // Also save a dated record
  const dateStr = formatDate();
  const datedPath = join(SYNTHESIZED_DIR, `${dateStr}-synthesis.json`);
  await writeFile(datedPath, JSON.stringify({ ...record, ...result }, null, 2));
}

// ── Notification ─────────────────────────────────────────────────────

async function sendTelegramSummary(result: SynthesisResult): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    logger.warn('Telegram credentials not configured; skipping notification');
    return;
  }

  const message =
    `PrintPilot Synthesis Complete\n\n` +
    `Patterns found: ${result.patternsFound}\n` +
    `Instructions updated: ${result.instructionsUpdated}\n` +
    `Agents affected: ${result.agentsAffected.join(', ') || 'none'}`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Telegram notification failed: ${errorText}`);
    } else {
      logger.info('Telegram synthesis summary sent');
    }
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to send Telegram notification: ${errMessage}`);
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────

export async function runSynthesis(): Promise<SynthesisResult> {
  logger.info('Starting synthesis run...');

  // Load last synthesis time
  const lastSynthesis = await loadLastSynthesisTime();
  if (lastSynthesis) {
    logger.info(`Last synthesis was at ${lastSynthesis.toISOString()}`);
  } else {
    logger.info('No previous synthesis found; processing all feedback');
  }

  // Load all feedback since last synthesis
  const [dailyRecords, weeklyRecords] = await Promise.all([
    loadDailyFeedback(lastSynthesis),
    loadWeeklyFeedback(lastSynthesis),
  ]);

  const allRecords = [...dailyRecords, ...weeklyRecords];
  logger.info(`Loaded ${allRecords.length} feedback records (${dailyRecords.length} daily, ${weeklyRecords.length} weekly)`);

  if (allRecords.length === 0) {
    const emptyResult: SynthesisResult = {
      patternsFound: 0,
      instructionsUpdated: 0,
      agentsAffected: [],
    };
    await saveSynthesisRecord(emptyResult);
    logger.info('No new feedback to process');
    return emptyResult;
  }

  // Extract patterns
  const patterns = extractPatterns(allRecords);
  logger.info(`Extracted ${patterns.length} patterns`);

  // Generate and apply instruction diffs
  const diffs: InstructionDiff[] = [];
  const affectedAgents = new Set<string>();
  let updatedCount = 0;

  for (const pattern of patterns) {
    const agentPath = resolve(AGENTS_DIR, `${pattern.affectedAgent}.md`);

    if (!existsSync(agentPath)) {
      logger.warn(`Skipping pattern for missing agent: ${pattern.affectedAgent}`);
      continue;
    }

    const currentInstructions = await readFile(agentPath, 'utf-8');
    const diff = generateInstructionDiff(pattern, currentInstructions);
    diffs.push(diff);

    const applied = await applyInstructionDiff(diff);
    if (applied) {
      updatedCount++;
      affectedAgents.add(pattern.affectedAgent);
    }
  }

  const result: SynthesisResult = {
    patternsFound: patterns.length,
    instructionsUpdated: updatedCount,
    agentsAffected: [...affectedAgents],
  };

  // Write changelog
  await writeChangelog(patterns, diffs, result);

  // Save synthesis record
  await saveSynthesisRecord(result);

  // Send Telegram notification
  await sendTelegramSummary(result);

  logger.info(
    `Synthesis complete: ${result.patternsFound} patterns, ${result.instructionsUpdated} updates, agents: ${result.agentsAffected.join(', ') || 'none'}`
  );

  return result;
}
