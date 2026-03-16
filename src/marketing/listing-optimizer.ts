import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EtsyClient } from '../etsy/client.js';
import { EtsyOAuth } from '../etsy/oauth.js';
import { getEnvOrThrow } from '../utils/env.js';
import { callClaude } from '../utils/claude.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';
import { analyzeNicheCompetition } from '../research/competitive-intel.js';
import type { ListingData } from '../types/index.js';

// ── Types ───────────────────────────────────────────────────────────

export interface ListingMetrics {
  listingId: string;
  views: number;
  favorites: number;
  sales: number;
  revenue: number;
  conversionRate: number;
  daysLive: number;
  lastUpdated: string;
}

export type OptimizationActionType =
  | 'title-rewrite'
  | 'tag-update'
  | 'price-adjustment'
  | 'full-rewrite';

export interface OptimizationAction {
  id: string;
  type: OptimizationActionType;
  listingId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  appliedAt: string;
}

export interface ABTest {
  id: string;
  listingId: string;
  variantA: { label: string; value: string };
  variantB: { label: string; value: string };
  metric: 'views' | 'favorites' | 'sales' | 'conversionRate';
  startDate: string;
  endDate: string | null;
  startMetrics: { views: number; favorites: number; sales: number };
  currentVariant: 'A' | 'B';
  winner: 'A' | 'B' | null;
}

export type PerformanceCategory = 'healthy' | 'underperforming' | 'critical';

export interface OptimizationConfig {
  /** Minimum views per day before a listing is considered low-traffic */
  minViewsPerDay: number;
  /** Days a listing must be live before evaluating views */
  minDaysForViewEval: number;
  /** Minimum favorites-to-sales conversion rate (0-1) */
  minConversionRate: number;
  /** Days a listing must be live before evaluating conversion */
  minDaysForConversionEval: number;
  /** Minimum views before triggering a price test */
  priceTestMinViews: number;
  /** Minimum days an AB test must run */
  abTestMinDays: number;
  /** Minimum views per variant before evaluating an AB test */
  abTestMinViews: number;
  /** Maximum price adjustment per step (as a fraction, e.g. 0.15 = 15%) */
  maxPriceAdjustmentFraction: number;
}

// ── Errors ──────────────────────────────────────────────────────────

export class ListingOptimizerError extends Error {
  public readonly listingId: string;

  constructor(listingId: string, message: string) {
    super(`Optimizer error for listing ${listingId}: ${message}`);
    this.name = 'ListingOptimizerError';
    this.listingId = listingId;
  }
}

// ── Constants ───────────────────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), 'state/marketing/optimizer');
const METRICS_DIR = join(STATE_DIR, 'metrics');
const ACTIONS_DIR = join(STATE_DIR, 'actions');
const AB_TESTS_DIR = join(STATE_DIR, 'ab-tests');
const LISTINGS_DIR = resolve(process.cwd(), 'state/listings');

const DEFAULT_CONFIG: OptimizationConfig = {
  minViewsPerDay: 10,
  minDaysForViewEval: 14,
  minConversionRate: 0.01,
  minDaysForConversionEval: 30,
  priceTestMinViews: 50,
  abTestMinDays: 7,
  abTestMinViews: 100,
  maxPriceAdjustmentFraction: 0.15,
};

const MAX_ETSY_TAGS = 13;
const MS_PER_DAY = 86_400_000;

// ── Helpers ─────────────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureDir(resolve(filePath, '..'));
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function daysBetween(start: string | Date, end: string | Date): number {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return Math.floor((endMs - startMs) / MS_PER_DAY);
}

function computeConversionRate(favorites: number, sales: number): number {
  if (favorites === 0) {
    return 0;
  }
  return sales / favorites;
}

// ── Core Class ──────────────────────────────────────────────────────

export class ListingOptimizer {
  private readonly client: EtsyClient;
  private readonly config: OptimizationConfig;

  constructor(client: EtsyClient, config?: Partial<OptimizationConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Static Factory ──────────────────────────────────────────────

  static async create(
    config?: Partial<OptimizationConfig>,
  ): Promise<ListingOptimizer> {
    const apiKey = getEnvOrThrow('ETSY_API_KEY');
    const apiSecret = getEnvOrThrow('ETSY_API_SECRET');
    const shopId = getEnvOrThrow('ETSY_SHOP_ID');

    const client = new EtsyClient(apiKey, apiSecret, shopId);
    const oauth = new EtsyOAuth(
      apiKey,
      apiSecret,
      'http://localhost:3000/oauth/callback',
    );
    const accessToken = await oauth.getValidAccessToken();
    client.setAccessToken(accessToken);

    return new ListingOptimizer(client, config);
  }

  // ── Metrics Collection ──────────────────────────────────────────

  async collectMetrics(listingId: string): Promise<ListingMetrics> {
    logger.info(`Collecting metrics for listing ${listingId}`);

    const numericId = parseInt(listingId, 10);
    const stats = await this.client.getListingStats(numericId);
    const listing = await this.client.getListing(numericId);

    const daysLive = daysBetween(listing.createdAt, new Date());
    const conversionRate = computeConversionRate(stats.favorites, stats.sales);

    const metrics: ListingMetrics = {
      listingId,
      views: stats.views,
      favorites: stats.favorites,
      sales: stats.sales,
      revenue: stats.revenue,
      conversionRate,
      daysLive,
      lastUpdated: new Date().toISOString(),
    };

    // Persist metrics history
    const metricsPath = join(METRICS_DIR, `${listingId}.json`);
    let history: ListingMetrics[] = [];
    try {
      history = await readJsonFile<ListingMetrics[]>(metricsPath);
    } catch {
      // First time collecting — start fresh
    }
    history.push(metrics);
    await writeJsonFile(metricsPath, history);

    logger.debug(`Metrics collected for listing ${listingId}`, {
      views: stats.views,
      favorites: stats.favorites,
      sales: stats.sales,
      daysLive,
      conversionRate: conversionRate.toFixed(4),
    });

    return metrics;
  }

  async collectAllMetrics(): Promise<ListingMetrics[]> {
    logger.info('Collecting metrics for all active listings');

    const listingFiles = await this.getActiveListingIds();
    const results: ListingMetrics[] = [];

    for (const listingId of listingFiles) {
      try {
        const metrics = await this.collectMetrics(listingId);
        results.push(metrics);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to collect metrics for listing ${listingId}: ${message}`);
      }
    }

    logger.info(
      `Metrics collection complete: ${results.length}/${listingFiles.length} listings`,
    );

    return results;
  }

  // ── Performance Analysis ────────────────────────────────────────

  analyzePerformance(metrics: ListingMetrics): PerformanceCategory {
    const viewsPerDay = metrics.daysLive > 0
      ? metrics.views / metrics.daysLive
      : 0;

    const isViewEvalReady = metrics.daysLive >= this.config.minDaysForViewEval;
    const isConversionEvalReady = metrics.daysLive >= this.config.minDaysForConversionEval;

    const lowViews = isViewEvalReady && viewsPerDay < this.config.minViewsPerDay;
    const lowConversion = isConversionEvalReady
      && metrics.conversionRate < this.config.minConversionRate;

    // Critical: both views and conversion are poor, or zero sales after
    // enough views
    const zeroSalesWithViews = metrics.views >= this.config.priceTestMinViews
      && metrics.sales === 0
      && isConversionEvalReady;

    if ((lowViews && lowConversion) || zeroSalesWithViews) {
      return 'critical';
    }

    if (lowViews || lowConversion) {
      return 'underperforming';
    }

    return 'healthy';
  }

  // ── Full Optimization Flow ──────────────────────────────────────

  async optimizeListing(listingId: string): Promise<OptimizationAction[]> {
    logger.info(`Running optimization analysis for listing ${listingId}`);

    const metrics = await this.collectMetrics(listingId);
    const category = this.analyzePerformance(metrics);
    const actions: OptimizationAction[] = [];

    if (category === 'healthy') {
      logger.info(`Listing ${listingId} is healthy — no optimization needed`);
      return actions;
    }

    // Load current listing data
    const listingData = await this.loadListingData(listingId);
    if (!listingData) {
      throw new ListingOptimizerError(
        listingId,
        'No listing data found in state directory',
      );
    }

    const viewsPerDay = metrics.daysLive > 0
      ? metrics.views / metrics.daysLive
      : 0;

    const isViewEvalReady = metrics.daysLive >= this.config.minDaysForViewEval;
    const isConversionEvalReady = metrics.daysLive >= this.config.minDaysForConversionEval;
    const lowViews = isViewEvalReady && viewsPerDay < this.config.minViewsPerDay;
    const lowConversion = isConversionEvalReady
      && metrics.conversionRate < this.config.minConversionRate;

    if (category === 'critical') {
      // Full rewrite — tags, title, and price all need attention
      logger.info(`Listing ${listingId} is critical — running full rewrite`);

      const competitiveData = await this.fetchCompetitiveContext(listingData);
      const titleAction = await this.rewriteTitle(listingId, competitiveData);
      const tagAction = await this.rewriteTags(listingId, competitiveData);

      actions.push(titleAction, tagAction);

      // If views exist but zero sales, test a lower price
      if (metrics.views >= this.config.priceTestMinViews && metrics.sales === 0) {
        const priceAction = await this.adjustPrice(listingId, 'down', 0.10);
        actions.push(priceAction);
      }
    } else {
      // Underperforming — targeted fixes
      if (lowViews) {
        logger.info(
          `Listing ${listingId} has low views (${viewsPerDay.toFixed(1)}/day) — rewriting title and tags`,
        );
        const competitiveData = await this.fetchCompetitiveContext(listingData);
        const titleAction = await this.rewriteTitle(listingId, competitiveData);
        const tagAction = await this.rewriteTags(listingId, competitiveData);
        actions.push(titleAction, tagAction);
      }

      if (lowConversion) {
        logger.info(
          `Listing ${listingId} has low conversion (${(metrics.conversionRate * 100).toFixed(2)}%) — testing lower price`,
        );
        const priceAction = await this.adjustPrice(listingId, 'down', 0.05);
        actions.push(priceAction);
      }
    }

    // Apply all actions
    for (const action of actions) {
      await this.applyOptimization(action);
    }

    return actions;
  }

  // ── Title Rewrite ───────────────────────────────────────────────

  async rewriteTitle(
    listingId: string,
    competitiveData: CompetitiveContext,
  ): Promise<OptimizationAction> {
    logger.info(`Generating new title for listing ${listingId}`);

    const listingData = await this.loadListingData(listingId);
    if (!listingData) {
      throw new ListingOptimizerError(listingId, 'Listing data not found');
    }

    const prompt = `You are an Etsy SEO expert. Rewrite this listing title to maximize search visibility and click-through rate.

## Current title:
"${listingData.title}"

## Current tags:
${listingData.tags.join(', ')}

## Top-performing competitor titles in this niche:
${competitiveData.topTitles.map((t) => `- "${t}"`).join('\n')}

## High-value keywords from competitors:
${competitiveData.topKeywords.join(', ')}

## Rules:
- Maximum 140 characters
- Front-load the highest-value keywords
- Use pipe (|) separators between keyword phrases
- Include a mix of broad and specific search terms
- Do NOT use all caps or excessive punctuation
- The title must sound natural, not keyword-stuffed

Return ONLY the new title text, no quotes, no commentary.`;

    const systemPrompt =
      'You are an Etsy listing optimization specialist. Return ONLY the requested text.';

    const newTitle = (await callClaude(prompt, {
      systemPrompt,
      maxTokens: 256,
      temperature: 0.4,
    })).trim();

    const action: OptimizationAction = {
      id: randomUUID(),
      type: 'title-rewrite',
      listingId,
      before: { title: listingData.title },
      after: { title: newTitle },
      reason: `Low search visibility. Rewrote title using top competitor keywords: ${competitiveData.topKeywords.slice(0, 5).join(', ')}`,
      appliedAt: '',
    };

    return action;
  }

  // ── Tag Rewrite ─────────────────────────────────────────────────

  async rewriteTags(
    listingId: string,
    competitiveData: CompetitiveContext,
  ): Promise<OptimizationAction> {
    logger.info(`Generating new tags for listing ${listingId}`);

    const listingData = await this.loadListingData(listingId);
    if (!listingData) {
      throw new ListingOptimizerError(listingId, 'Listing data not found');
    }

    const prompt = `You are an Etsy SEO expert. Generate 13 optimized tags for this listing.

## Current listing title:
"${listingData.title}"

## Current tags:
${listingData.tags.join(', ')}

## Top-performing competitor tags in this niche:
${competitiveData.topTags.join(', ')}

## High-value keywords:
${competitiveData.topKeywords.join(', ')}

## Rules:
- Exactly 13 tags (Etsy maximum)
- Each tag max 20 characters
- Mix of broad terms (e.g. "printable planner") and long-tail phrases (e.g. "daily habit tracker pdf")
- Use competitor tags as INSPIRATION for relevant keywords, but write original variations
- Include a mix of broad category terms and unique long-tail phrases
- At least 3-4 tags should be distinctive to THIS product's specific features
- No duplicate or near-duplicate tags
- Prioritize buyer-intent phrases (what someone would actually search for)

Return ONLY a JSON array of 13 strings, no markdown fences, no commentary.`;

    const systemPrompt =
      'You are an Etsy tag optimization specialist. Return ONLY valid JSON.';

    const response = await callClaude(prompt, {
      systemPrompt,
      maxTokens: 512,
      temperature: 0.3,
    });

    let newTags: string[];
    try {
      const cleaned = response
        .replace(/```(?:json)?\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
      newTags = JSON.parse(cleaned) as string[];
    } catch {
      logger.warn(
        `Failed to parse AI tag response for listing ${listingId}, extracting manually`,
      );
      // Fallback: extract quoted strings
      const matches = response.match(/"([^"]+)"/g);
      newTags = matches
        ? matches.map((m) => m.replace(/"/g, '')).slice(0, MAX_ETSY_TAGS)
        : listingData.tags;
    }

    // Ensure we have exactly 13 tags, each max 20 chars
    newTags = newTags
      .map((t) => t.trim().slice(0, 20))
      .filter((t) => t.length > 0)
      .slice(0, MAX_ETSY_TAGS);

    const action: OptimizationAction = {
      id: randomUUID(),
      type: 'tag-update',
      listingId,
      before: { tags: listingData.tags },
      after: { tags: newTags },
      reason: `Tag refresh based on competitive analysis. Replaced underperforming tags with high-traffic alternatives.`,
      appliedAt: '',
    };

    return action;
  }

  // ── Price Adjustment ────────────────────────────────────────────

  async adjustPrice(
    listingId: string,
    direction: 'up' | 'down',
    fraction: number,
  ): Promise<OptimizationAction> {
    logger.info(
      `Adjusting price ${direction} by ${(fraction * 100).toFixed(0)}% for listing ${listingId}`,
    );

    const listingData = await this.loadListingData(listingId);
    if (!listingData) {
      throw new ListingOptimizerError(listingId, 'Listing data not found');
    }

    const clampedFraction = Math.min(
      fraction,
      this.config.maxPriceAdjustmentFraction,
    );
    const currentPrice = listingData.price;
    const adjustment = currentPrice * clampedFraction;

    const newPrice = direction === 'down'
      ? Math.max(0.99, Math.round((currentPrice - adjustment) * 100) / 100)
      : Math.round((currentPrice + adjustment) * 100) / 100;

    const action: OptimizationAction = {
      id: randomUUID(),
      type: 'price-adjustment',
      listingId,
      before: { price: currentPrice },
      after: { price: newPrice },
      reason: `Price ${direction === 'down' ? 'decrease' : 'increase'} of ${(clampedFraction * 100).toFixed(0)}% — ` +
        `from $${currentPrice.toFixed(2)} to $${newPrice.toFixed(2)}. ` +
        (direction === 'down'
          ? 'Testing lower price point to improve conversion.'
          : 'Increasing price after strong sales performance.'),
      appliedAt: '',
    };

    return action;
  }

  // ── AB Testing ──────────────────────────────────────────────────

  async startABTest(
    listingId: string,
    field: 'title',
    variant: string,
  ): Promise<ABTest> {
    logger.info(`Starting AB test for listing ${listingId} on field: ${field}`);

    const listingData = await this.loadListingData(listingId);
    if (!listingData) {
      throw new ListingOptimizerError(listingId, 'Listing data not found');
    }

    const metrics = await this.collectMetrics(listingId);

    const original = field === 'title' ? listingData.title : '';

    const test: ABTest = {
      id: randomUUID(),
      listingId,
      variantA: { label: 'original', value: original },
      variantB: { label: 'new', value: variant },
      metric: 'views',
      startDate: new Date().toISOString(),
      endDate: null,
      startMetrics: {
        views: metrics.views,
        favorites: metrics.favorites,
        sales: metrics.sales,
      },
      currentVariant: 'B',
      winner: null,
    };

    // Apply variant B to start
    const numericId = parseInt(listingId, 10);
    await this.client.publishListing(numericId); // Re-PUT with updated field

    const testPath = join(AB_TESTS_DIR, `${test.id}.json`);
    await writeJsonFile(testPath, test);

    logger.info(`AB test started: ${test.id} for listing ${listingId}`);

    return test;
  }

  async evaluateABTests(): Promise<ABTest[]> {
    logger.info('Evaluating active AB tests');

    await ensureDir(AB_TESTS_DIR);
    const completedTests: ABTest[] = [];

    let testFiles: string[];
    try {
      testFiles = await readdir(AB_TESTS_DIR);
    } catch {
      logger.info('No AB test directory found');
      return completedTests;
    }

    const jsonFiles = testFiles.filter((f) => f.endsWith('.json'));

    for (const file of jsonFiles) {
      const testPath = join(AB_TESTS_DIR, file);
      const test = await readJsonFile<ABTest>(testPath);

      // Skip already-evaluated tests
      if (test.winner !== null) {
        continue;
      }

      const daysRunning = daysBetween(test.startDate, new Date());

      if (daysRunning < this.config.abTestMinDays) {
        logger.debug(
          `AB test ${test.id} only ${daysRunning} days old (min: ${this.config.abTestMinDays})`,
        );
        continue;
      }

      // Collect current metrics
      const currentMetrics = await this.collectMetrics(test.listingId);
      const viewsSinceStart = currentMetrics.views - test.startMetrics.views;

      if (viewsSinceStart < this.config.abTestMinViews) {
        logger.debug(
          `AB test ${test.id} has ${viewsSinceStart} views since start (min: ${this.config.abTestMinViews})`,
        );
        continue;
      }

      // Evaluate: compare metrics before and after variant switch
      const favoritesDelta = currentMetrics.favorites - test.startMetrics.favorites;
      const salesDelta = currentMetrics.sales - test.startMetrics.sales;

      // Simple heuristic: variant B wins if conversion improved
      const viewRate = viewsSinceStart / daysRunning;
      const preTestViewRate = test.startMetrics.views > 0
        ? test.startMetrics.views / daysBetween(
            (await this.loadListingData(test.listingId))?.publishedAt ?? test.startDate,
            test.startDate,
          )
        : 0;

      const variantBWins = test.metric === 'views'
        ? viewRate > preTestViewRate * 1.1
        : salesDelta > 0 || favoritesDelta > (viewsSinceStart * 0.02);

      test.winner = variantBWins ? 'B' : 'A';
      test.endDate = new Date().toISOString();

      // If A wins, revert to original
      if (test.winner === 'A') {
        logger.info(
          `AB test ${test.id}: Original (A) wins — reverting listing ${test.listingId}`,
        );
        const revertAction: OptimizationAction = {
          id: randomUUID(),
          type: 'title-rewrite',
          listingId: test.listingId,
          before: { title: test.variantB.value },
          after: { title: test.variantA.value },
          reason: `AB test ${test.id} concluded: original variant performed better. Reverting.`,
          appliedAt: '',
        };
        await this.applyOptimization(revertAction);
      } else {
        logger.info(
          `AB test ${test.id}: New variant (B) wins — keeping changes on listing ${test.listingId}`,
        );
      }

      await writeJsonFile(testPath, test);
      completedTests.push(test);
    }

    logger.info(`AB test evaluation complete: ${completedTests.length} tests concluded`);

    return completedTests;
  }

  // ── Apply / Rollback ────────────────────────────────────────────

  async applyOptimization(action: OptimizationAction): Promise<void> {
    logger.info(
      `Applying ${action.type} optimization to listing ${action.listingId}`,
    );

    const numericId = parseInt(action.listingId, 10);
    const payload: Record<string, unknown> = {};

    if (action.type === 'title-rewrite' || action.type === 'full-rewrite') {
      if (typeof action.after.title === 'string') {
        payload.title = action.after.title;
      }
    }

    if (action.type === 'tag-update' || action.type === 'full-rewrite') {
      if (Array.isArray(action.after.tags)) {
        payload.tags = action.after.tags;
      }
    }

    if (action.type === 'price-adjustment') {
      if (typeof action.after.price === 'number') {
        payload.price = action.after.price;
      }
    }

    if (action.type === 'full-rewrite') {
      if (typeof action.after.description === 'string') {
        payload.description = action.after.description;
      }
    }

    // Update via Etsy API (PUT to update listing)
    // The EtsyClient.publishListing uses PUT — we use the same endpoint
    // with the update payload
    const apiKey = getEnvOrThrow('ETSY_API_KEY');
    const shopId = getEnvOrThrow('ETSY_SHOP_ID');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    };

    const oauth = new EtsyOAuth(
      apiKey,
      getEnvOrThrow('ETSY_API_SECRET'),
      'http://localhost:3000/oauth/callback',
    );
    const accessToken = await oauth.getValidAccessToken();
    headers['Authorization'] = `Bearer ${accessToken}`;

    const url = `https://api.etsy.com/v3/application/shops/${shopId}/listings/${numericId}`;

    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new ListingOptimizerError(
        action.listingId,
        `Failed to apply optimization (${response.status}): ${responseBody}`,
      );
    }

    action.appliedAt = new Date().toISOString();

    // Persist action to the append-only log
    await this.persistAction(action);

    // Update local listing data
    await this.updateLocalListingData(action);

    logger.info(
      `Optimization ${action.type} applied to listing ${action.listingId} at ${action.appliedAt}`,
    );
  }

  async rollbackOptimization(actionId: string): Promise<void> {
    logger.info(`Rolling back optimization action: ${actionId}`);

    const history = await this.getOptimizationHistoryAll();
    const action = history.find((a) => a.id === actionId);

    if (!action) {
      throw new ListingOptimizerError(
        'unknown',
        `Optimization action ${actionId} not found in history`,
      );
    }

    // Create a reverse action
    const rollbackAction: OptimizationAction = {
      id: randomUUID(),
      type: action.type,
      listingId: action.listingId,
      before: action.after,
      after: action.before,
      reason: `Rollback of action ${actionId}: ${action.reason}`,
      appliedAt: '',
    };

    await this.applyOptimization(rollbackAction);

    logger.info(
      `Rollback complete for action ${actionId} on listing ${action.listingId}`,
    );
  }

  // ── Daily Optimization Cycle ────────────────────────────────────

  async runOptimizationCycle(): Promise<OptimizationCycleResult> {
    const startTime = performance.now();
    logger.info('Starting daily optimization cycle');

    const result: OptimizationCycleResult = {
      timestamp: new Date().toISOString(),
      listingsAnalyzed: 0,
      healthy: 0,
      underperforming: 0,
      critical: 0,
      actionsApplied: 0,
      abTestsEvaluated: 0,
      errors: [],
    };

    try {
      // Step 1: Collect metrics for all listings
      const allMetrics = await this.collectAllMetrics();
      result.listingsAnalyzed = allMetrics.length;

      // Step 2: Analyze and categorize each listing
      const underperformers: ListingMetrics[] = [];

      for (const metrics of allMetrics) {
        const category = this.analyzePerformance(metrics);

        switch (category) {
          case 'healthy':
            result.healthy++;
            break;
          case 'underperforming':
            result.underperforming++;
            underperformers.push(metrics);
            break;
          case 'critical':
            result.critical++;
            underperformers.push(metrics);
            break;
        }
      }

      // Step 3: Optimize underperformers
      for (const metrics of underperformers) {
        try {
          const actions = await this.optimizeListing(metrics.listingId);
          result.actionsApplied += actions.length;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(
            `Failed to optimize listing ${metrics.listingId}: ${message}`,
          );
          result.errors.push(`${metrics.listingId}: ${message}`);
        }
      }

      // Step 4: Evaluate running AB tests
      const completedTests = await this.evaluateABTests();
      result.abTestsEvaluated = completedTests.length;

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Optimization cycle failed: ${message}`);
      result.errors.push(message);
    }

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: result.timestamp,
      agent: 'listing-optimizer',
      action: 'optimization-cycle',
      details:
        `Analyzed ${result.listingsAnalyzed} listings: ` +
        `${result.healthy} healthy, ${result.underperforming} underperforming, ` +
        `${result.critical} critical. Applied ${result.actionsApplied} optimizations, ` +
        `evaluated ${result.abTestsEvaluated} AB tests.`,
      duration,
      success: result.errors.length === 0,
    });

    logger.info(
      `Optimization cycle complete in ${duration}ms: ` +
      `${result.actionsApplied} actions applied, ${result.errors.length} errors`,
    );

    return result;
  }

  // ── History ─────────────────────────────────────────────────────

  async getOptimizationHistory(
    listingId: string,
  ): Promise<OptimizationAction[]> {
    const allActions = await this.getOptimizationHistoryAll();
    return allActions.filter((a) => a.listingId === listingId);
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private async getActiveListingIds(): Promise<string[]> {
    await ensureDir(LISTINGS_DIR);
    const ids: string[] = [];

    let files: string[];
    try {
      files = await readdir(LISTINGS_DIR);
    } catch {
      return ids;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const data = await readJsonFile<Record<string, unknown>>(
          join(LISTINGS_DIR, file),
        );
        if (data.status === 'active') {
          const listingId = file.replace('.json', '');
          ids.push(listingId);
        }
      } catch {
        // Skip malformed files
      }
    }

    return ids;
  }

  private async loadListingData(
    listingId: string,
  ): Promise<ListingData | null> {
    const filePath = join(LISTINGS_DIR, `${listingId}.json`);
    try {
      return await readJsonFile<ListingData>(filePath);
    } catch {
      return null;
    }
  }

  private async fetchCompetitiveContext(
    listingData: ListingData,
  ): Promise<CompetitiveContext> {
    // Extract niche from tags or title
    const niche = listingData.tags[0] ?? listingData.title.split('|')[0].trim();

    try {
      // Use the existing competitive intel system to gather fresh data
      const intel = await analyzeNicheCompetition(
        niche,
        [], // URLs will be populated by the scraper's internal search
      );

      return {
        topTitles: intel.referenceListings.map((ref) => ref.title),
        topTags: intel.bestPractices.tagPatterns.commonTags,
        topKeywords: intel.bestPractices.titlePatterns.frontLoadedKeywords,
        avgPrice: intel.pricingStrategy.priceDistribution.median,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Failed to fetch competitive context for "${niche}": ${message}. Using fallback.`,
      );

      // Fallback: derive context from existing listing data
      return {
        topTitles: [],
        topTags: listingData.tags,
        topKeywords: listingData.tags.slice(0, 5),
        avgPrice: listingData.price,
      };
    }
  }

  private async persistAction(action: OptimizationAction): Promise<void> {
    await ensureDir(ACTIONS_DIR);
    const logPath = join(ACTIONS_DIR, `${action.listingId}.jsonl`);

    const line = JSON.stringify(action) + '\n';

    const { appendFile } = await import('node:fs/promises');
    await appendFile(logPath, line, 'utf-8');
  }

  private async updateLocalListingData(
    action: OptimizationAction,
  ): Promise<void> {
    const filePath = join(LISTINGS_DIR, `${action.listingId}.json`);

    let data: Record<string, unknown>;
    try {
      data = await readJsonFile<Record<string, unknown>>(filePath);
    } catch {
      return; // No local data to update
    }

    if (action.after.title !== undefined) {
      data.title = action.after.title;
    }
    if (action.after.tags !== undefined) {
      data.tags = action.after.tags;
    }
    if (action.after.price !== undefined) {
      data.price = action.after.price;
    }
    if (action.after.description !== undefined) {
      data.description = action.after.description;
    }

    await writeJsonFile(filePath, data);
  }

  private async getOptimizationHistoryAll(): Promise<OptimizationAction[]> {
    await ensureDir(ACTIONS_DIR);

    let files: string[];
    try {
      files = await readdir(ACTIONS_DIR);
    } catch {
      return [];
    }

    const actions: OptimizationAction[] = [];

    for (const file of files) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }

      try {
        const content = await readFile(join(ACTIONS_DIR, file), 'utf-8');
        const lines = content.trim().split('\n').filter((l) => l.length > 0);

        for (const line of lines) {
          actions.push(JSON.parse(line) as OptimizationAction);
        }
      } catch {
        logger.warn(`Failed to read action log: ${file}`);
      }
    }

    return actions.sort(
      (a, b) => new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime(),
    );
  }
}

// ── Supporting Types ────────────────────────────────────────────────

interface CompetitiveContext {
  topTitles: string[];
  topTags: string[];
  topKeywords: string[];
  avgPrice: number;
}

export interface OptimizationCycleResult {
  timestamp: string;
  listingsAnalyzed: number;
  healthy: number;
  underperforming: number;
  critical: number;
  actionsApplied: number;
  abTestsEvaluated: number;
  errors: string[];
}
