import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import logger from '../utils/logger.js';
import type { PinterestTrend, PinterestPin } from './types.js';

const USER_AGENTS: string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;
const PINTEREST_BASE_URL = 'https://www.pinterest.com';
const SCROLL_PAUSE_MS = 1500;
const MAX_SCROLLS = 3;

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

async function autoScroll(page: Page): Promise<void> {
  for (let i = 0; i < MAX_SCROLLS; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, SCROLL_PAUSE_MS));
  }
}

function classifyTrendDirection(
  pinCount: number,
  relatedTermsCount: number
): PinterestTrend['trendDirection'] {
  if (pinCount > 1000 && relatedTermsCount > 5) {
    return 'rising';
  }
  if (pinCount > 200) {
    return 'stable';
  }
  return 'declining';
}

export async function scrapePinterestTrends(
  keywords: string[]
): Promise<PinterestTrend[]> {
  logger.info(`Scraping Pinterest trends for ${keywords.length} keywords`);

  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await configurePage(page);

    const trends: PinterestTrend[] = [];

    for (const keyword of keywords) {
      logger.debug(`Scraping Pinterest trends for: "${keyword}"`);

      try {
        const trend = await scrapeTrendForKeyword(page, keyword);
        trends.push(trend);
        logger.info(
          `Pinterest trend for "${keyword}": ${trend.pinCount} pins, direction=${trend.trendDirection}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to scrape Pinterest trend for "${keyword}": ${message}`);
      }

      await randomDelay();
    }

    logger.info(`Pinterest trends scrape complete: ${trends.length} trends collected`);
    return trends;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function scrapeTrendForKeyword(
  page: Page,
  keyword: string
): Promise<PinterestTrend> {
  const searchQuery = encodeURIComponent(`${keyword} printable`);
  const url = `${PINTEREST_BASE_URL}/search/pins/?q=${searchQuery}`;

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await autoScroll(page);

  const scrapedData = await page.evaluate(() => {
    const pinEls = document.querySelectorAll('[data-test-id="pin"]');
    const pinCount = pinEls.length;

    const relatedTerms: string[] = [];
    const relatedEls = document.querySelectorAll(
      '[data-test-id="related-interest"], [data-test-id="search-guide"] a'
    );
    relatedEls.forEach((el) => {
      const text = el.textContent?.trim();
      if (text && !relatedTerms.includes(text)) {
        relatedTerms.push(text);
      }
    });

    return { pinCount, relatedTerms };
  });

  const trendDirection = classifyTrendDirection(
    scrapedData.pinCount,
    scrapedData.relatedTerms.length
  );

  return {
    keyword,
    relatedTerms: scrapedData.relatedTerms.slice(0, 10),
    pinCount: scrapedData.pinCount,
    trendDirection,
  };
}

export async function scrapePinterestSearch(
  query: string
): Promise<PinterestPin[]> {
  logger.info(`Scraping Pinterest search for: "${query}"`);

  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await configurePage(page);

    const searchQuery = encodeURIComponent(query);
    const url = `${PINTEREST_BASE_URL}/search/pins/?q=${searchQuery}`;

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await autoScroll(page);

    const pins = await page.evaluate(() => {
      const results: {
        title: string;
        description: string;
        saves: number;
        imageUrl: string;
        link: string;
      }[] = [];

      const pinEls = document.querySelectorAll('[data-test-id="pin"]');

      pinEls.forEach((pinEl) => {
        const imgEl = pinEl.querySelector('img');
        const linkEl = pinEl.querySelector('a');
        const titleEl = pinEl.querySelector('[data-test-id="pin-title"]');
        const descEl = pinEl.querySelector('[data-test-id="pin-description"]');
        const savesEl = pinEl.querySelector('[data-test-id="pin-save-count"]');

        const title = titleEl?.textContent?.trim() ?? '';
        const description = descEl?.textContent?.trim() ?? '';
        const imageUrl = imgEl?.getAttribute('src') ?? '';
        const link = linkEl?.getAttribute('href') ?? '';

        let saves = 0;
        if (savesEl) {
          const savesText = savesEl.textContent?.trim() ?? '0';
          const savesMatch = savesText.match(/(\d[\d,]*)/);
          if (savesMatch) {
            saves = parseInt(savesMatch[1].replace(/,/g, ''), 10) || 0;
          }
        }

        if (imageUrl || title) {
          results.push({ title, description, saves, imageUrl, link });
        }
      });

      return results;
    });

    logger.info(`Pinterest search complete: ${pins.length} pins for "${query}"`);
    return pins;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
