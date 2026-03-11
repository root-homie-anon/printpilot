import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import logger from '../utils/logger.js';
import type { EtsyScrapedData, EtsySearchResult, ListingDetail } from './types.js';

const USER_AGENTS: string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;
const MAX_PAGES = 3;
const ETSY_BASE_URL = 'https://www.etsy.com';

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

function parsePrice(priceText: string): number {
  const cleaned = priceText.replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseCount(countText: string): number {
  const cleaned = countText.replace(/[^0-9]/g, '');
  const parsed = parseInt(cleaned, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function scrapeSearchPage(page: Page): Promise<EtsySearchResult[]> {
  return page.evaluate(() => {
    const results: {
      title: string;
      price: number;
      reviews: number;
      favorites: number;
      shopName: string;
      url: string;
      tags: string[];
      listingAge: string;
    }[] = [];

    const listingCards = document.querySelectorAll('[data-search-results] .wt-grid__item-xs-6');

    listingCards.forEach((card) => {
      const titleEl = card.querySelector('.v2-listing-card__title');
      const priceEl = card.querySelector('.currency-value');
      const shopEl = card.querySelector('.v2-listing-card__shop');
      const linkEl = card.querySelector('a.listing-link');
      const reviewEl = card.querySelector('.wt-text-caption');

      const title = titleEl?.textContent?.trim() ?? '';
      const priceText = priceEl?.textContent?.trim() ?? '0';
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      const shopName = shopEl?.textContent?.trim() ?? '';
      const url = linkEl?.getAttribute('href') ?? '';

      let reviews = 0;
      if (reviewEl) {
        const reviewMatch = reviewEl.textContent?.match(/\((\d[\d,]*)\)/);
        if (reviewMatch) {
          reviews = parseInt(reviewMatch[1].replace(/,/g, ''), 10) || 0;
        }
      }

      if (title && url) {
        results.push({
          title,
          price,
          reviews,
          favorites: 0,
          shopName,
          url,
          tags: [],
          listingAge: '',
        });
      }
    });

    return results;
  });
}

export async function scrapeEtsyTrending(
  categories: string[]
): Promise<EtsyScrapedData[]> {
  logger.info(`Scraping Etsy trending for ${categories.length} categories`);

  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await configurePage(page);

    const allResults: EtsyScrapedData[] = [];

    for (const category of categories) {
      logger.debug(`Scraping Etsy category: ${category}`);

      try {
        const categoryResults = await scrapeCategoryPages(page, category);
        allResults.push(...categoryResults);
        logger.info(
          `Found ${categoryResults.length} results for category: ${category}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to scrape category "${category}": ${message}`);
      }

      await randomDelay();
    }

    logger.info(`Etsy trending scrape complete: ${allResults.length} total results`);
    return allResults;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function scrapeCategoryPages(
  page: Page,
  category: string
): Promise<EtsyScrapedData[]> {
  const results: EtsyScrapedData[] = [];
  const query = encodeURIComponent(`${category} printable digital download`);

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const url = `${ETSY_BASE_URL}/search?q=${query}&ref=pagination&page=${pageNum}`;

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('[data-search-results]', { timeout: 10000 }).catch(() => {
      logger.debug(`No search results container found on page ${pageNum} for "${category}"`);
    });

    const pageResults = await scrapeSearchPage(page);

    if (pageResults.length === 0) {
      logger.debug(`No more results on page ${pageNum} for "${category}"`);
      break;
    }

    for (const result of pageResults) {
      results.push({
        title: result.title,
        price: result.price,
        reviews: result.reviews,
        favorites: result.favorites,
        shopName: result.shopName,
        url: result.url,
        tags: result.tags,
        category,
        estimatedAge: result.listingAge,
      });
    }

    if (pageNum < MAX_PAGES) {
      await randomDelay();
    }
  }

  return results;
}

export async function scrapeEtsySearch(
  query: string
): Promise<EtsySearchResult[]> {
  logger.info(`Scraping Etsy search for: "${query}"`);

  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await configurePage(page);

    const allResults: EtsySearchResult[] = [];
    const encodedQuery = encodeURIComponent(query);

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const url = `${ETSY_BASE_URL}/search?q=${encodedQuery}&ref=pagination&page=${pageNum}`;

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForSelector('[data-search-results]', { timeout: 10000 }).catch(() => {
        logger.debug(`No search results container found on page ${pageNum}`);
      });

      const pageResults = await scrapeSearchPage(page);

      if (pageResults.length === 0) {
        break;
      }

      allResults.push(...pageResults);

      if (pageNum < MAX_PAGES) {
        await randomDelay();
      }
    }

    logger.info(`Etsy search complete: ${allResults.length} results for "${query}"`);
    return allResults;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function scrapeListingDetails(
  url: string
): Promise<ListingDetail> {
  logger.info(`Scraping listing details: ${url}`);

  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await configurePage(page);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const detail = await page.evaluate(() => {
      const titleEl = document.querySelector('h1[data-buy-box-listing-title]');
      const priceEl = document.querySelector('[data-buy-box-region] .wt-text-title-03');
      const descriptionEl = document.querySelector('[data-product-details-description-text-content]');
      const shopNameEl = document.querySelector('[data-shop-name]');
      const shopSalesEl = document.querySelector('.wt-text-caption:not([class*="review"])');
      const reviewCountEl = document.querySelector('[data-reviews-total]');
      const favoritesEl = document.querySelector('[data-favorite-count]');

      const tagEls = document.querySelectorAll('.wt-tag');
      const tags: string[] = [];
      tagEls.forEach((el) => {
        const text = el.textContent?.trim();
        if (text) {
          tags.push(text);
        }
      });

      const imageEls = document.querySelectorAll('[data-listing-page-image-carousel] img');
      const images: string[] = [];
      imageEls.forEach((el) => {
        const src = el.getAttribute('src');
        if (src) {
          images.push(src);
        }
      });

      const title = titleEl?.textContent?.trim() ?? '';
      const priceText = priceEl?.textContent?.trim() ?? '0';
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      const description = descriptionEl?.textContent?.trim() ?? '';
      const shopName = shopNameEl?.textContent?.trim() ?? '';

      let shopSales = 0;
      if (shopSalesEl) {
        const salesMatch = shopSalesEl.textContent?.match(/([\d,]+)\s*sales/i);
        if (salesMatch) {
          shopSales = parseInt(salesMatch[1].replace(/,/g, ''), 10) || 0;
        }
      }

      let reviews = 0;
      if (reviewCountEl) {
        const reviewText = reviewCountEl.textContent?.trim() ?? '0';
        reviews = parseInt(reviewText.replace(/[^0-9]/g, ''), 10) || 0;
      }

      let favorites = 0;
      if (favoritesEl) {
        const favText = favoritesEl.textContent?.trim() ?? '0';
        favorites = parseInt(favText.replace(/[^0-9]/g, ''), 10) || 0;
      }

      return {
        title,
        description,
        price,
        reviews,
        favorites,
        shopName,
        shopSales,
        tags,
        images,
        createdAt: '',
      };
    });

    return {
      ...detail,
      url,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
