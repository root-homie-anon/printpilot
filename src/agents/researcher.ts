import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { AgentResult, Opportunity } from '../types/index.js';
import { loadConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';
import { scrapeEtsyTrending } from '../research/etsy-scraper.js';
import { scrapePinterestTrends } from '../research/pinterest-scraper.js';
import { checkGoogleTrends } from '../research/trends-checker.js';
import { buildOpportunities } from '../research/opportunity-builder.js';
import { DEFAULT_CATEGORIES } from '../research/categories.js';
import type { EtsyScrapedData, PinterestTrend, TrendData } from '../research/types.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const QUEUE_DIR = join(STATE_DIR, 'queue');

async function runEtsyScraper(categories: string[]): Promise<EtsyScrapedData[]> {
  try {
    logger.info('Starting Etsy scraper');
    const results = await scrapeEtsyTrending(categories);
    logger.info(`Etsy scraper returned ${results.length} results`);
    return results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Etsy scraper failed: ${message}`);
    return [];
  }
}

async function runPinterestScraper(keywords: string[]): Promise<PinterestTrend[]> {
  try {
    logger.info('Starting Pinterest scraper');
    const results = await scrapePinterestTrends(keywords);
    logger.info(`Pinterest scraper returned ${results.length} trends`);
    return results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Pinterest scraper failed: ${message}`);
    return [];
  }
}

async function runGoogleTrendsChecker(keywords: string[]): Promise<TrendData[]> {
  try {
    logger.info('Starting Google Trends checker');
    const results = await checkGoogleTrends(keywords);
    logger.info(`Google Trends checker returned ${results.length} results`);
    return results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Google Trends checker failed: ${message}`);
    return [];
  }
}

export async function runResearch(): Promise<AgentResult<Opportunity[]>> {
  const startTime = performance.now();

  logger.info('Research agent starting');

  try {
    const config = await loadConfig();
    const { maxOpportunitiesPerRun } = config.agents.researcher;

    // Run all three scrapers in parallel for speed.
    // Each scraper handles its own errors internally and returns
    // an empty array on failure (graceful degradation).
    const [etsyData, pinterestData, trendsData] = await Promise.all([
      runEtsyScraper(DEFAULT_CATEGORIES),
      runPinterestScraper(DEFAULT_CATEGORIES),
      runGoogleTrendsChecker(DEFAULT_CATEGORIES),
    ]);

    const totalDataPoints = etsyData.length + pinterestData.length + trendsData.length;
    logger.info(
      `Research data collected: ${etsyData.length} Etsy, ` +
      `${pinterestData.length} Pinterest, ${trendsData.length} Google Trends`
    );

    if (totalDataPoints === 0) {
      logger.warn('All scrapers returned empty results — no opportunities to build');

      const duration = Math.round(performance.now() - startTime);

      await logActivity({
        timestamp: new Date().toISOString(),
        agent: 'researcher',
        action: 'research-complete',
        details: 'All scrapers returned empty results',
        duration,
        success: true,
      });

      return {
        success: true,
        data: [],
        duration,
      };
    }

    // Build and score opportunities by cross-referencing all data sources
    const opportunities = await buildOpportunities(etsyData, pinterestData, trendsData);
    const selected = opportunities.slice(0, maxOpportunitiesPerRun);

    // Write opportunities to the queue directory
    await mkdir(QUEUE_DIR, { recursive: true });

    for (const opp of selected) {
      const filePath = join(QUEUE_DIR, `${opp.id}.json`);
      await writeFile(filePath, JSON.stringify(opp, null, 2), 'utf-8');
    }

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'researcher',
      action: 'research-complete',
      details:
        `Found ${selected.length} opportunities from ` +
        `${DEFAULT_CATEGORIES.length} categories ` +
        `(${etsyData.length} Etsy, ${pinterestData.length} Pinterest, ` +
        `${trendsData.length} Google Trends data points)`,
      duration,
      success: true,
    });

    logger.info(`Research complete: ${selected.length} opportunities queued in ${duration}ms`);

    return {
      success: true,
      data: selected,
      duration,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Research agent failed: ${message}`);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'researcher',
      action: 'research-failed',
      details: message,
      duration,
      success: false,
    });

    return {
      success: false,
      error: message,
      duration,
    };
  }
}
