import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import logger from '../utils/logger.js';
import type { TrendData } from './types.js';

const USER_AGENTS: string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;
const GOOGLE_TRENDS_BASE_URL = 'https://trends.google.com/trends';
const TREND_PERIOD = 'today 3-m'; // 90 days

function getRandomUserAgent(): string {
  const index = Math.floor(Math.random() * USER_AGENTS.length);
  return USER_AGENTS[index];
}

async function randomDelay(): Promise<void> {
  const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
}

async function configurePage(page: Page): Promise<void> {
  const userAgent = getRandomUserAgent();
  await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1366, height: 768 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });
}

function classifyTrend(interestOverTime: number): TrendData['trend'] {
  if (interestOverTime >= 60) {
    return 'rising';
  }
  if (interestOverTime >= 30) {
    return 'stable';
  }
  return 'declining';
}

async function scrapeTrendForKeyword(
  page: Page,
  keyword: string
): Promise<TrendData> {
  const encodedKeyword = encodeURIComponent(keyword);
  const url = `${GOOGLE_TRENDS_BASE_URL}/explore?q=${encodedKeyword}&date=${encodeURIComponent(TREND_PERIOD)}&geo=US`;

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

  // Wait for the interest over time widget to load
  await page.waitForSelector('fe-line-chart-header, .fe-atoms-generic-title', {
    timeout: 15000,
  }).catch(() => {
    logger.debug(`Trend chart did not load for keyword: "${keyword}"`);
  });

  // Allow additional render time for chart data
  await new Promise<void>((resolve) => setTimeout(resolve, 2000));

  const trendInfo = await page.evaluate(() => {
    // Try to extract the average interest value from the chart
    let interestOverTime = 0;

    // Look for the trend summary value
    const summaryEls = document.querySelectorAll(
      '.comparison-item-value, [class*="interest"] .value'
    );
    for (const el of summaryEls) {
      const text = el.textContent?.trim() ?? '';
      const parsed = parseInt(text.replace(/[^0-9]/g, ''), 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
        interestOverTime = parsed;
        break;
      }
    }

    // If no summary value, try to extract from chart data points
    if (interestOverTime === 0) {
      const dataPoints = document.querySelectorAll(
        'fe-line-chart .point, [class*="chart"] [class*="point"]'
      );
      const values: number[] = [];
      dataPoints.forEach((point) => {
        const ariaLabel = point.getAttribute('aria-label') ?? '';
        const match = ariaLabel.match(/(\d+)/);
        if (match) {
          values.push(parseInt(match[1], 10));
        }
      });
      if (values.length > 0) {
        interestOverTime = Math.round(
          values.reduce((sum, v) => sum + v, 0) / values.length
        );
      }
    }

    // Extract related queries
    const relatedQueries: string[] = [];
    const queryEls = document.querySelectorAll(
      '.fe-related-queries .comparison-item, [class*="related"] .item-text'
    );
    queryEls.forEach((el) => {
      const text = el.textContent?.trim();
      if (text && text.length > 1) {
        relatedQueries.push(text);
      }
    });

    return { interestOverTime, relatedQueries };
  });

  const trend = classifyTrend(trendInfo.interestOverTime);

  return {
    keyword,
    interestOverTime: trendInfo.interestOverTime,
    trend,
    relatedQueries: trendInfo.relatedQueries.slice(0, 10),
  };
}

export async function checkGoogleTrends(
  keywords: string[]
): Promise<TrendData[]> {
  logger.info(`Checking Google Trends for ${keywords.length} keywords`);

  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await configurePage(page);

    const results: TrendData[] = [];

    for (const keyword of keywords) {
      logger.debug(`Checking Google Trends for: "${keyword}"`);

      try {
        const trendData = await scrapeTrendForKeyword(page, keyword);
        results.push(trendData);
        logger.info(
          `Google Trends for "${keyword}": interest=${trendData.interestOverTime}, trend=${trendData.trend}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to check Google Trends for "${keyword}": ${message}`);
      }

      await randomDelay();
    }

    logger.info(`Google Trends check complete: ${results.length} keywords analyzed`);
    return results;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function getRelatedQueries(
  keyword: string
): Promise<string[]> {
  logger.info(`Getting related queries for: "${keyword}"`);

  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await configurePage(page);

    const encodedKeyword = encodeURIComponent(keyword);
    const url = `${GOOGLE_TRENDS_BASE_URL}/explore?q=${encodedKeyword}&date=${encodeURIComponent(TREND_PERIOD)}&geo=US`;

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    await page.waitForSelector('.fe-related-queries, [class*="related"]', {
      timeout: 15000,
    }).catch(() => {
      logger.debug(`Related queries section did not load for: "${keyword}"`);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 2000));

    const queries = await page.evaluate(() => {
      const results: string[] = [];
      const queryEls = document.querySelectorAll(
        '.fe-related-queries .comparison-item, ' +
        '[class*="related"] .item-text, ' +
        '.related-queries-content .label-text'
      );

      queryEls.forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length > 1 && !results.includes(text)) {
          results.push(text);
        }
      });

      return results;
    });

    logger.info(`Found ${queries.length} related queries for "${keyword}"`);
    return queries;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
