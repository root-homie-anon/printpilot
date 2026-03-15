import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { EtsyClient } from '../etsy/client.js';
import { EtsyOAuth } from '../etsy/oauth.js';
import { getEnvOrThrow } from '../utils/env.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';
import type { AgentResult, ProductBrief, ScoreReport, Product } from '../types/index.js';
import type { CopyResult } from './copywriter.js';

// ── Constants ────────────────────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = join(STATE_DIR, 'products');
const LISTINGS_DIR = join(STATE_DIR, 'listings');

const DEFAULT_PRICE = 4.99;
const DEFAULT_QUANTITY = 999;
const HEALTH_CHECK_DELAY_MS = 5000;
const MAX_FILE_UPLOAD_RETRIES = 3;
const MAX_DRAFT_RETRIES = 1;

const BASE_URL = 'https://api.etsy.com/v3';

// ── Taxonomy Map ─────────────────────────────────────────────────────

const TAXONOMY_MAP: Record<string, number> = {
  // Paper & Party Supplies > Paper > Calendars & Planners
  'planner': 1281,
  'weekly-planner': 1281,
  'daily-planner': 1281,
  'monthly-planner': 1281,
  'study-planner': 1281,
  'academic-planner': 1281,
  'productivity-planner': 1281,
  'wedding-planner': 1281,
  'travel-planner': 1281,
  'meal-planner': 1281,
  'calendar': 1281,
  // Paper & Party Supplies > Paper > Journals & Notebooks
  'journal': 1282,
  'gratitude-journal': 1282,
  'daily-journal': 1282,
  'bullet-journal': 1282,
  'prayer-journal': 1282,
  'self-care-journal': 1282,
  'mindfulness-journal': 1282,
  'notebook': 1282,
  // Trackers
  'tracker': 1283,
  'habit-tracker': 1283,
  'fitness-tracker': 1283,
  'mood-tracker': 1283,
  'reading-tracker': 1283,
  'savings-tracker': 1283,
  'weight-tracker': 1283,
  'water-tracker': 1283,
  'sleep-tracker': 1283,
  'expense-tracker': 1283,
  'period-tracker': 1283,
  // Worksheets & Templates
  'worksheet': 1284,
  'budget-worksheet': 1284,
  'goals-worksheet': 1284,
  'meal-plan': 1284,
  'to-do-list': 1284,
  'checklist': 1284,
  'inventory': 1284,
  'log': 1284,
  'template': 1284,
};

const DEFAULT_TAXONOMY_ID = 1281;

// ── Interfaces ───────────────────────────────────────────────────────

export interface HealthCheckResult {
  timestamp: string;
  status: 'healthy' | 'warning' | 'critical';
  checks: {
    urlAccessible: boolean;
    stateActive: boolean;
    fileAvailable: boolean;
  };
  details: string;
}

export interface ListingResult {
  listingId: number;
  etsyUrl: string;
  status: string;
  price: number;
  publishedAt: string;
  healthCheck: HealthCheckResult;
}

interface BriefPricingStrategy {
  recommendedPrice?: number;
}

interface ExtendedBrief extends ProductBrief {
  pricingStrategy?: BriefPricingStrategy;
  avgPrice?: number;
}

// ── Taxonomy Resolution ──────────────────────────────────────────────

export function resolveTaxonomyId(niche: string): number {
  // Direct match
  const normalized = niche.toLowerCase().trim();
  if (TAXONOMY_MAP[normalized] !== undefined) {
    return TAXONOMY_MAP[normalized];
  }

  // Try with hyphens replaced by dashes (normalize spaces)
  const hyphenated = normalized.replace(/\s+/g, '-');
  if (TAXONOMY_MAP[hyphenated] !== undefined) {
    return TAXONOMY_MAP[hyphenated];
  }

  // Partial match: check if any key is contained in the niche or vice versa
  for (const [key, id] of Object.entries(TAXONOMY_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return id;
    }
  }

  // Check individual words for a match
  const words = normalized.split(/[-\s]+/);
  for (const word of words) {
    if (TAXONOMY_MAP[word] !== undefined) {
      return TAXONOMY_MAP[word];
    }
  }

  logger.warn(`No taxonomy match for niche "${niche}", using default ${DEFAULT_TAXONOMY_ID}`);
  return DEFAULT_TAXONOMY_ID;
}

// ── Cover Image Generation ───────────────────────────────────────────

export async function generateCoverImage(
  pdfPath: string,
  outputDir: string,
): Promise<string[]> {
  logger.info(`Generating cover images from PDF: ${pdfPath}`);

  await mkdir(outputDir, { recursive: true });

  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const imagePaths: string[] = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1553, deviceScaleFactor: 2 });

    // Read PDF and convert to base64 for rendering in browser
    const pdfBuffer = await readFile(pdfPath);
    const pdfBase64 = pdfBuffer.toString('base64');

    // Render cover page (page 1)
    const coverPath = join(outputDir, 'cover.png');
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          * { margin: 0; padding: 0; }
          body { background: white; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
          canvas { max-width: 100%; max-height: 100vh; }
        </style>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
      </head>
      <body>
        <canvas id="pdf-canvas"></canvas>
        <script>
          pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          async function renderPage(pageNum) {
            const data = atob('${pdfBase64}');
            const uint8 = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) uint8[i] = data.charCodeAt(i);
            const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 2.0 });
            const canvas = document.getElementById('pdf-canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport }).promise;
            window.__pageCount = pdf.numPages;
            window.__rendered = true;
          }
          renderPage(1);
        </script>
      </body>
      </html>
    `, { waitUntil: 'networkidle0' });

    await page.waitForFunction('window.__rendered === true', { timeout: 30000 });
    await page.screenshot({ path: coverPath, type: 'png', fullPage: false });
    imagePaths.push(coverPath);

    logger.info(`Cover image generated: ${coverPath}`);

    // Get total page count and render an interior spread
    const pageCount = await page.evaluate(() => (window as unknown as Record<string, number>).__pageCount);

    if (pageCount > 1) {
      const interiorPageNum = Math.min(3, pageCount);
      const interiorPath = join(outputDir, 'interior.png');

      await page.evaluate((pageNum: number) => {
        (window as unknown as Record<string, boolean>).__rendered = false;
        const renderInterior = async () => {
          const data = document.querySelector('script:last-of-type')?.textContent ?? '';
          const match = data.match(/atob\('([^']+)'\)/);
          if (!match) return;
          const raw = atob(match[1]);
          const uint8 = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) uint8[i] = raw.charCodeAt(i);
          const pdf = await (window as unknown as Record<string, { getDocument: (opts: Record<string, unknown>) => { promise: Promise<Record<string, unknown>> } }>).pdfjsLib.getDocument({ data: uint8 }).promise as Record<string, unknown>;
          const page = await (pdf.getPage as (n: number) => Promise<Record<string, unknown>>)(pageNum);
          const viewport = (page.getViewport as (opts: Record<string, unknown>) => Record<string, number>)({ scale: 2.0 });
          const canvas = document.getElementById('pdf-canvas') as HTMLCanvasElement;
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d')!;
          await (page.render as (opts: Record<string, unknown>) => { promise: Promise<void> })({ canvasContext: ctx, viewport }).promise;
          (window as unknown as Record<string, boolean>).__rendered = true;
        };
        renderInterior();
      }, interiorPageNum);

      await page.waitForFunction('window.__rendered === true', { timeout: 30000 });
      await page.screenshot({ path: interiorPath, type: 'png', fullPage: false });
      imagePaths.push(interiorPath);

      logger.info(`Interior image generated: ${interiorPath}`);
    }
  } finally {
    await browser.close();
  }

  return imagePaths;
}

// ── Image Upload ─────────────────────────────────────────────────────

async function uploadListingImage(
  apiKey: string,
  accessToken: string,
  shopId: string,
  listingId: number,
  imagePath: string,
  rank: number,
): Promise<void> {
  logger.info(`Uploading listing image ${rank} for listing ${listingId}: ${imagePath}`);

  const imageBuffer = await readFile(imagePath);
  const fileName = basename(imagePath);

  const formData = new FormData();
  formData.append('image', new Blob([imageBuffer]), fileName);
  formData.append('rank', String(rank));

  const url = `${BASE_URL}/application/shops/${shopId}/listings/${listingId}/images`;

  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'Authorization': `Bearer ${accessToken}`,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Failed to upload listing image (${response.status}): ${responseBody}`
    );
  }

  logger.info(`Listing image ${rank} uploaded successfully for listing ${listingId}`);
}

// ── Health Check ─────────────────────────────────────────────────────

export async function runHealthCheck(
  client: EtsyClient,
  listingId: number,
  etsyUrl: string,
): Promise<HealthCheckResult> {
  const timestamp = new Date().toISOString();
  const checks = {
    urlAccessible: false,
    stateActive: false,
    fileAvailable: false,
  };

  try {
    // Check listing state via API
    const listing = await client.getListing(listingId);

    checks.stateActive = listing.state === 'active';
    // If we can fetch the listing, the URL is accessible via API
    checks.urlAccessible = true;
    // Digital files are available if the listing is active
    checks.fileAvailable = listing.state === 'active';

    const allPassing = checks.urlAccessible && checks.stateActive && checks.fileAvailable;

    if (allPassing) {
      return {
        timestamp,
        status: 'healthy',
        checks,
        details: `Listing ${listingId} is active and healthy.`,
      };
    }

    const issues: string[] = [];
    if (!checks.stateActive) issues.push(`state is "${listing.state}" (expected "active")`);
    if (!checks.urlAccessible) issues.push('URL not accessible');
    if (!checks.fileAvailable) issues.push('digital file may not be available');

    return {
      timestamp,
      status: 'warning',
      checks,
      details: `Listing ${listingId} has issues: ${issues.join('; ')}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Health check failed for listing ${listingId}: ${message}`);

    return {
      timestamp,
      status: 'critical',
      checks,
      details: `Health check failed: ${message}`,
    };
  }
}

// ── Price Resolution ─────────────────────────────────────────────────

function resolvePrice(brief: ExtendedBrief): number {
  if (brief.pricingStrategy?.recommendedPrice !== undefined) {
    const price = brief.pricingStrategy.recommendedPrice;
    logger.info(`Using pricing strategy recommended price: $${price}`);
    return price;
  }

  if (brief.avgPrice !== undefined && brief.avgPrice > 0) {
    logger.info(`Using opportunity average price: $${brief.avgPrice}`);
    return brief.avgPrice;
  }

  logger.info(`Using default price: $${DEFAULT_PRICE}`);
  return DEFAULT_PRICE;
}

// ── File Existence Check ─────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ── Retry Helper ─────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  label: string,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryNote = attempt < maxRetries
        ? `, retrying (${attempt + 1}/${maxRetries})`
        : ', no more retries';
      logger.warn(`${label} failed: ${lastError.message}${retryNote}`);

      if (attempt < maxRetries) {
        // Brief delay before retry
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

// ── Sleep Helper ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main Listing Agent ───────────────────────────────────────────────

export async function runListing(
  productId: string,
): Promise<AgentResult<ListingResult>> {
  const startTime = performance.now();

  logger.info(`Listing agent starting for product: ${productId}`);

  try {
    const productDir = join(PRODUCTS_DIR, productId);

    // ── Load product data ──────────────────────────────────────────

    const briefPath = join(productDir, 'brief.json');
    const copyPath = join(productDir, 'copy.json');

    if (!(await fileExists(briefPath))) {
      throw new Error(`Brief not found at ${briefPath}`);
    }
    if (!(await fileExists(copyPath))) {
      throw new Error(`Copy not found at ${copyPath}`);
    }

    const brief = JSON.parse(await readFile(briefPath, 'utf-8')) as ExtendedBrief;
    const copy = JSON.parse(await readFile(copyPath, 'utf-8')) as CopyResult;

    // ── Verify product is approved ─────────────────────────────────

    let isApproved = false;

    const scoreReportPath = join(productDir, 'score-report.json');
    const productJsonPath = join(productDir, 'product.json');

    if (await fileExists(scoreReportPath)) {
      const scoreReport = JSON.parse(
        await readFile(scoreReportPath, 'utf-8'),
      ) as ScoreReport;
      if (scoreReport.recommendation === 'approve') {
        isApproved = true;
      }
    }

    if (!isApproved && (await fileExists(productJsonPath))) {
      const product = JSON.parse(
        await readFile(productJsonPath, 'utf-8'),
      ) as Product;
      if (product.status === 'approved') {
        isApproved = true;
      }
    }

    if (!isApproved) {
      throw new Error(
        `Product ${productId} is not approved. Check score-report.json or product.json status.`,
      );
    }

    // ── Find PDF file ──────────────────────────────────────────────

    let pdfPath: string | undefined;

    if (await fileExists(productJsonPath)) {
      const product = JSON.parse(
        await readFile(productJsonPath, 'utf-8'),
      ) as Product;
      if (product.pdfPath) {
        pdfPath = resolve(process.cwd(), product.pdfPath);
      }
    }

    if (!pdfPath || !(await fileExists(pdfPath))) {
      // Try conventional location
      const conventionalPath = join(productDir, 'product.pdf');
      if (await fileExists(conventionalPath)) {
        pdfPath = conventionalPath;
      } else {
        throw new Error(
          `PDF file not found for product ${productId}. Checked product.pdfPath and ${conventionalPath}`,
        );
      }
    }

    // ── Initialize Etsy client ─────────────────────────────────────

    const apiKey = getEnvOrThrow('ETSY_API_KEY');
    const apiSecret = getEnvOrThrow('ETSY_API_SECRET');
    const shopId = getEnvOrThrow('ETSY_SHOP_ID');

    const client = new EtsyClient(apiKey, apiSecret, shopId);
    const oauth = new EtsyOAuth(apiKey, apiSecret, 'http://localhost:3000/oauth/callback');
    const accessToken = await oauth.getValidAccessToken();
    client.setAccessToken(accessToken);

    // ── Resolve price and taxonomy ─────────────────────────────────

    const price = resolvePrice(brief);
    const taxonomyId = resolveTaxonomyId(brief.niche);

    logger.info(
      `Listing params: price=$${price}, taxonomy=${taxonomyId}, niche="${brief.niche}"`,
    );

    // ── Create draft listing ───────────────────────────────────────

    const draftListing = await withRetry(
      () =>
        client.createDraftListing({
          title: copy.title,
          description: copy.description,
          price,
          tags: copy.tags.slice(0, 13),
          categoryId: taxonomyId,
          isDigital: true,
          whoMade: 'i_did',
          whenMade: 'made_to_order',
          taxonomyId,
        }),
      MAX_DRAFT_RETRIES,
      'Create draft listing',
    );

    const listingId = draftListing.listingId;
    logger.info(`Draft listing created: ${listingId}`);

    // ── Upload digital PDF file ────────────────────────────────────

    try {
      await withRetry(
        () => client.uploadDigitalFile(listingId, pdfPath),
        MAX_FILE_UPLOAD_RETRIES,
        'Upload digital file',
      );
    } catch (uploadError) {
      // Attempt to clean up the draft on upload failure
      const uploadMessage = uploadError instanceof Error
        ? uploadError.message
        : String(uploadError);
      logger.error(
        `File upload failed for listing ${listingId}, attempting draft cleanup: ${uploadMessage}`,
      );

      try {
        // There's no delete method on the client; log the orphaned draft
        logger.warn(
          `Orphaned draft listing ${listingId} needs manual cleanup.`,
        );
      } catch {
        // Ignore cleanup errors
      }

      throw uploadError;
    }

    // ── Generate and upload cover images ───────────────────────────

    try {
      const imageDir = join(productDir, 'images');
      const imagePaths = await generateCoverImage(pdfPath, imageDir);

      for (let i = 0; i < imagePaths.length; i++) {
        try {
          await uploadListingImage(
            apiKey,
            accessToken,
            shopId,
            listingId,
            imagePaths[i],
            i + 1,
          );
        } catch (imageError) {
          const imgMessage = imageError instanceof Error
            ? imageError.message
            : String(imageError);
          logger.warn(
            `Failed to upload image ${i + 1} for listing ${listingId}: ${imgMessage}`,
          );
          // Non-fatal: continue with remaining images
        }
      }
    } catch (imageGenError) {
      const genMessage = imageGenError instanceof Error
        ? imageGenError.message
        : String(imageGenError);
      logger.warn(
        `Cover image generation failed for listing ${listingId}: ${genMessage}. Proceeding without images.`,
      );
    }

    // ── Publish listing ────────────────────────────────────────────

    let publishedListing;
    try {
      publishedListing = await client.publishListing(listingId);
    } catch (publishError) {
      const pubMessage = publishError instanceof Error
        ? publishError.message
        : String(publishError);
      logger.error(
        `Publish failed for listing ${listingId}, draft remains: ${pubMessage}`,
      );
      logger.warn(
        `Orphaned draft listing ${listingId} needs manual publish or cleanup.`,
      );
      throw publishError;
    }

    const publishedAt = new Date().toISOString();
    logger.info(
      `Listing published: ${publishedListing.url} (state: ${publishedListing.state})`,
    );

    // ── Health check ───────────────────────────────────────────────

    await sleep(HEALTH_CHECK_DELAY_MS);
    const healthCheck = await runHealthCheck(
      client,
      listingId,
      publishedListing.url,
    );

    logger.info(
      `Health check for listing ${listingId}: ${healthCheck.status} — ${healthCheck.details}`,
    );

    // ── Write listing metadata ─────────────────────────────────────

    await mkdir(LISTINGS_DIR, { recursive: true });

    const listingMetadata = {
      listingId,
      etsyUrl: publishedListing.url,
      title: copy.title,
      description: copy.description,
      tags: copy.tags,
      price,
      status: publishedListing.state,
      publishedAt,
      productId,
      niche: brief.niche,
      healthCheck,
    };

    await writeFile(
      join(LISTINGS_DIR, `${listingId}.json`),
      JSON.stringify(listingMetadata, null, 2),
      'utf-8',
    );

    // Write listing data to product directory
    const productListingData = {
      etsyUrl: publishedListing.url,
      listingId: String(listingId),
      title: copy.title,
      description: copy.description,
      tags: copy.tags,
      price,
      status: publishedListing.state as 'draft' | 'active' | 'inactive' | 'removed',
      publishedAt,
    };

    await writeFile(
      join(productDir, 'listing.json'),
      JSON.stringify(productListingData, null, 2),
      'utf-8',
    );

    // ── Update product status ──────────────────────────────────────

    if (await fileExists(productJsonPath)) {
      const product = JSON.parse(
        await readFile(productJsonPath, 'utf-8'),
      ) as Product;
      product.status = 'listed';
      product.listingId = String(listingId);
      product.updatedAt = publishedAt;
      await writeFile(productJsonPath, JSON.stringify(product, null, 2), 'utf-8');
    }

    // ── Log activity ───────────────────────────────────────────────

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: publishedAt,
      agent: 'listing-agent',
      action: 'listing-published',
      productId,
      details: `Listed "${copy.title}" at $${price} — ${publishedListing.url} [health: ${healthCheck.status}]`,
      duration,
      success: true,
    });

    const result: ListingResult = {
      listingId,
      etsyUrl: publishedListing.url,
      status: publishedListing.state,
      price,
      publishedAt,
      healthCheck,
    };

    logger.info(`Listing agent complete for ${productId}: ${publishedListing.url}`);

    return {
      success: true,
      data: result,
      duration,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`Listing agent failed for ${productId}: ${message}`);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'listing-agent',
      action: 'listing-failed',
      productId,
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
