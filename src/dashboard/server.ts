import express, { type Request, type Response, type NextFunction } from 'express';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { getDailyReviewForm, submitDailyReview } from '../feedback/daily-form.js';
import type { DailyReview, ReviewFormData } from '../feedback/daily-form.js';
import { getWeeklyBatch, submitWeeklyReview } from '../feedback/weekly-review.js';
import type { WeeklyReviewItem, WeeklyBatchData } from '../feedback/weekly-review.js';
import type {
  ListingData,
  MarketingPlan,
  ProductBrief,
  ProductScores,
  Product,
  FeedbackSource,
  FeedbackDecision,
} from '../types/index.js';

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_PORT = 3000;
const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = resolve(STATE_DIR, 'products');
const LISTINGS_DIR = resolve(STATE_DIR, 'listings');
const MARKETING_DIR = resolve(STATE_DIR, 'marketing');
const ACTIVITY_LOG_PATH = resolve(STATE_DIR, 'logs', 'activity.json');
const FEEDBACK_DIR = resolve(process.cwd(), 'feedback');
const PUBLIC_DIR = resolve(import.meta.dirname, 'public');

// ── Types ────────────────────────────────────────────────────────────

interface ProductWithStatus {
  id: string;
  brief: ProductBrief | null;
  product: Product | null;
  scores: ProductScores | null;
  listing: ListingData | null;
  stage: string;
}

interface AggregatedMetrics {
  totalProducts: number;
  liveListings: number;
  totalRevenue: number;
  totalViews: number;
  totalFavorites: number;
  avgConversionRate: number;
}

interface PipelineStatus {
  research: number;
  strategy: number;
  design: number;
  copy: number;
  scoring: number;
  approval: number;
  listed: number;
}

interface NichePerformance {
  niche: string;
  productCount: number;
  totalRevenue: number;
  avgScore: number;
}

interface ActivityEntry {
  timestamp: string;
  agent: string;
  action: string;
  productId?: string;
  details?: string;
}

interface ApprovalRequest {
  decision: FeedbackDecision;
  notes?: string;
}

interface FeedbackRequest {
  layout: number;
  typography: number;
  color: number;
  differentiation: number;
  sellability: number;
  issues?: string;
  source: FeedbackSource;
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

async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    if (!existsSync(dirPath)) {
      return [];
    }
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
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

function determineStage(data: ProductWithStatus): string {
  if (data.listing) return 'listed';
  if (data.product?.status === 'approved') return 'approved';
  if (data.product?.status === 'scored') return 'approval';
  if (data.product?.status === 'copywritten') return 'scoring';
  if (data.product?.status === 'designed') return 'copy';
  if (data.product?.status === 'briefed') return 'design';
  if (data.product?.status === 'researched') return 'strategy';
  if (data.product) return data.product.status;
  if (data.brief) return 'strategy';
  return 'research';
}

// ── Data Loading ─────────────────────────────────────────────────────

async function loadProduct(productId: string): Promise<ProductWithStatus> {
  const productDir = resolve(PRODUCTS_DIR, productId);

  const brief = await readJsonFile<ProductBrief>(join(productDir, 'brief.json'));
  const product = await readJsonFile<Product>(join(productDir, 'product.json'));
  const scores = product?.scores ?? null;
  const listing = await readJsonFile<ListingData>(join(productDir, 'listing.json'));

  const result: ProductWithStatus = {
    id: productId,
    brief,
    product,
    scores,
    listing,
    stage: '',
  };
  result.stage = determineStage(result);

  return result;
}

async function loadAllProducts(): Promise<ProductWithStatus[]> {
  const productIds = await listDirectories(PRODUCTS_DIR);
  const products = await Promise.all(productIds.map(loadProduct));
  return products;
}

async function loadAllListings(): Promise<ListingData[]> {
  const files = await listJsonFiles(LISTINGS_DIR);
  const listings: ListingData[] = [];

  for (const file of files) {
    const listing = await readJsonFile<ListingData>(join(LISTINGS_DIR, file));
    if (listing) {
      listings.push(listing);
    }
  }

  return listings;
}

async function loadMarketingPlans(): Promise<MarketingPlan[]> {
  const files = await listJsonFiles(MARKETING_DIR);
  const plans: MarketingPlan[] = [];

  for (const file of files) {
    const plan = await readJsonFile<MarketingPlan>(join(MARKETING_DIR, file));
    if (plan) {
      plans.push(plan);
    }
  }

  return plans;
}

async function loadActivityLog(): Promise<ActivityEntry[]> {
  const entries = await readJsonFile<ActivityEntry[]>(ACTIVITY_LOG_PATH);
  if (!entries) return [];

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  return entries.filter((e) => new Date(e.timestamp) >= sevenDaysAgo);
}

// ── Middleware ────────────────────────────────────────────────────────

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const dashboardSecret = process.env.DASHBOARD_SECRET;

  if (!dashboardSecret) {
    next();
    return;
  }

  // Skip auth for static files and the root page
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || authHeader !== `Bearer ${dashboardSecret}`) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing bearer token' });
    return;
  }

  next();
}

// ── Route Handlers ───────────────────────────────────────────────────

async function handleGetProducts(_req: Request, res: Response): Promise<void> {
  try {
    const products = await loadAllProducts();
    res.json({ products });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load products: ${message}`);
    res.status(500).json({ error: 'Failed to load products' });
  }
}

async function handleGetProductById(req: Request, res: Response): Promise<void> {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      res.status(400).json({ error: 'Product ID is required' });
      return;
    }
    const product = await loadProduct(id);
    if (!product.brief && !product.product && !product.listing) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json({ product });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load product: ${message}`);
    res.status(500).json({ error: 'Failed to load product' });
  }
}

async function handleGetListings(_req: Request, res: Response): Promise<void> {
  try {
    const listings = await loadAllListings();
    res.json({ listings });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load listings: ${message}`);
    res.status(500).json({ error: 'Failed to load listings' });
  }
}

async function handleGetMetrics(_req: Request, res: Response): Promise<void> {
  try {
    const products = await loadAllProducts();
    const listings = await loadAllListings();

    let totalViews = 0;
    let totalFavorites = 0;
    let totalRevenue = 0;

    for (const listing of listings) {
      if (listing.status === 'active') {
        totalRevenue += listing.price;
      }
    }

    // Read health check data for views/favorites
    for (const listing of listings) {
      const healthPath = join(LISTINGS_DIR, `${listing.listingId}-health.json`);
      const health = await readJsonFile<{ views: number; favorites: number }>(healthPath);
      if (health) {
        totalViews += health.views;
        totalFavorites += health.favorites;
      }
    }

    const activeListings = listings.filter((l) => l.status === 'active');
    const avgConversion = totalViews > 0 ? totalFavorites / totalViews : 0;

    const metrics: AggregatedMetrics = {
      totalProducts: products.length,
      liveListings: activeListings.length,
      totalRevenue,
      totalViews,
      totalFavorites,
      avgConversionRate: Math.round(avgConversion * 10000) / 10000,
    };

    res.json({ metrics });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load metrics: ${message}`);
    res.status(500).json({ error: 'Failed to load metrics' });
  }
}

async function handleGetPipeline(_req: Request, res: Response): Promise<void> {
  try {
    const products = await loadAllProducts();

    const pipeline: PipelineStatus = {
      research: 0,
      strategy: 0,
      design: 0,
      copy: 0,
      scoring: 0,
      approval: 0,
      listed: 0,
    };

    for (const product of products) {
      const stage = product.stage as keyof PipelineStatus;
      if (stage in pipeline) {
        pipeline[stage]++;
      }
    }

    res.json({ pipeline });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load pipeline: ${message}`);
    res.status(500).json({ error: 'Failed to load pipeline status' });
  }
}

async function handleGetNiches(_req: Request, res: Response): Promise<void> {
  try {
    const products = await loadAllProducts();
    const nicheMap = new Map<string, { count: number; totalScore: number; revenue: number }>();

    for (const product of products) {
      const niche = product.product?.niche ?? product.brief?.niche ?? 'unknown';
      const existing = nicheMap.get(niche) ?? { count: 0, totalScore: 0, revenue: 0 };

      existing.count++;
      if (product.scores) {
        const avg = (product.scores.layout + product.scores.typography + product.scores.color +
          product.scores.differentiation + product.scores.sellability) / 5;
        existing.totalScore += avg;
      }
      if (product.listing?.price) {
        existing.revenue += product.listing.price;
      }

      nicheMap.set(niche, existing);
    }

    const niches: NichePerformance[] = [];
    for (const [niche, data] of nicheMap) {
      niches.push({
        niche,
        productCount: data.count,
        totalRevenue: data.revenue,
        avgScore: data.count > 0 ? Math.round((data.totalScore / data.count) * 100) / 100 : 0,
      });
    }

    niches.sort((a, b) => b.totalRevenue - a.totalRevenue);

    res.json({ niches });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load niches: ${message}`);
    res.status(500).json({ error: 'Failed to load niche data' });
  }
}

async function handleGetActivity(_req: Request, res: Response): Promise<void> {
  try {
    const activity = await loadActivityLog();
    res.json({ activity });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load activity: ${message}`);
    res.status(500).json({ error: 'Failed to load activity log' });
  }
}

async function handlePostApproval(req: Request, res: Response): Promise<void> {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      res.status(400).json({ error: 'Product ID is required' });
      return;
    }

    const body = req.body as ApprovalRequest;
    const validDecisions: FeedbackDecision[] = ['approve', 'reject', 'revise'];
    if (!body.decision || !validDecisions.includes(body.decision)) {
      res.status(400).json({ error: 'Valid decision (approve/reject/revise) is required' });
      return;
    }

    const { writeFile, mkdir } = await import('node:fs/promises');
    const productDir = resolve(PRODUCTS_DIR, id);
    await mkdir(productDir, { recursive: true });

    const productPath = join(productDir, 'product.json');
    const existing = await readJsonFile<Product>(productPath);

    if (existing) {
      const statusMap: Record<FeedbackDecision, Product['status']> = {
        approve: 'approved',
        reject: 'rejected',
        revise: 'revision',
      };
      const updated: Product = {
        ...existing,
        status: statusMap[body.decision],
        updatedAt: new Date().toISOString(),
      };
      await writeFile(productPath, JSON.stringify(updated, null, 2));
    }

    logger.info(`Product ${id} ${body.decision}d`);
    res.json({ success: true, decision: body.decision });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to submit approval: ${message}`);
    res.status(500).json({ error: 'Failed to submit approval' });
  }
}

async function handlePostFeedback(req: Request, res: Response): Promise<void> {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      res.status(400).json({ error: 'Product ID is required' });
      return;
    }

    const body = req.body as FeedbackRequest;

    const numericFields: (keyof Pick<FeedbackRequest, 'layout' | 'typography' | 'color' | 'differentiation' | 'sellability'>)[] = [
      'layout',
      'typography',
      'color',
      'differentiation',
      'sellability',
    ];

    for (const field of numericFields) {
      if (body[field] === undefined || body[field] === null) {
        res.status(400).json({ error: `Field '${field}' is required` });
        return;
      }
    }

    if (!body.source) {
      res.status(400).json({ error: "Field 'source' is required" });
      return;
    }

    const { writeFile, mkdir } = await import('node:fs/promises');
    const dailyDir = resolve(FEEDBACK_DIR, 'daily');
    await mkdir(dailyDir, { recursive: true });

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `${dateStr}-${id}.json`;

    await writeFile(join(dailyDir, filename), JSON.stringify(body, null, 2));

    logger.info(`Feedback submitted for product ${id}`);
    res.json({ success: true, filename });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to submit feedback: ${message}`);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
}

// ── Review Route Handlers ────────────────────────────────────────────

async function handleGetDailyReview(req: Request, res: Response): Promise<void> {
  try {
    const rawId = req.params.productId;
    const productId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!productId) {
      res.status(400).json({ error: 'Product ID is required' });
      return;
    }

    const formData = await getDailyReviewForm(productId);
    res.json({ formData });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load daily review form: ${message}`);
    const status = message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: message });
  }
}

async function handlePostDailyReview(req: Request, res: Response): Promise<void> {
  try {
    const rawId = req.params.productId;
    const productId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!productId) {
      res.status(400).json({ error: 'Product ID is required' });
      return;
    }

    const review = req.body as DailyReview;
    await submitDailyReview(productId, review);

    logger.info(`Daily review submitted for product ${productId}`);
    res.json({ success: true, productId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to submit daily review: ${message}`);
    res.status(400).json({ error: message });
  }
}

async function handleGetWeeklyBatch(_req: Request, res: Response): Promise<void> {
  try {
    const batch = await getWeeklyBatch();
    res.json({ batch });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load weekly batch: ${message}`);
    res.status(500).json({ error: 'Failed to load weekly batch' });
  }
}

async function handlePostWeeklyReview(req: Request, res: Response): Promise<void> {
  try {
    const reviews = req.body as WeeklyReviewItem[];
    await submitWeeklyReview(reviews);

    logger.info(`Weekly review submitted: ${reviews.length} products`);
    res.json({ success: true, count: reviews.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to submit weekly review: ${message}`);
    res.status(400).json({ error: message });
  }
}

async function handleGetFeedbackDaily(_req: Request, res: Response): Promise<void> {
  try {
    const dailyDir = resolve(FEEDBACK_DIR, 'daily');
    const files = await listJsonFiles(dailyDir);
    const records: Record<string, unknown>[] = [];

    for (const file of files) {
      const record = await readJsonFile<Record<string, unknown>>(join(dailyDir, file));
      if (record) {
        records.push({ ...record, filename: file });
      }
    }

    // Sort by filename descending (newest first)
    records.sort((a, b) => {
      const fa = a.filename as string;
      const fb = b.filename as string;
      return fb.localeCompare(fa);
    });

    res.json({ records });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load daily feedback: ${message}`);
    res.status(500).json({ error: 'Failed to load daily feedback records' });
  }
}

async function handleGetFeedbackWeekly(_req: Request, res: Response): Promise<void> {
  try {
    const weeklyDir = resolve(FEEDBACK_DIR, 'weekly');
    const files = await listJsonFiles(weeklyDir);
    const records: Record<string, unknown>[] = [];

    for (const file of files) {
      const record = await readJsonFile<Record<string, unknown>>(join(weeklyDir, file));
      if (record) {
        records.push({ ...record, filename: file });
      }
    }

    // Sort by filename descending (newest first)
    records.sort((a, b) => {
      const fa = a.filename as string;
      const fb = b.filename as string;
      return fb.localeCompare(fa);
    });

    res.json({ records });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load weekly feedback: ${message}`);
    res.status(500).json({ error: 'Failed to load weekly feedback records' });
  }
}

async function handleGetFeedbackScores(req: Request, res: Response): Promise<void> {
  try {
    const rawId = req.params.productId;
    const productId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!productId) {
      res.status(400).json({ error: 'Product ID is required' });
      return;
    }

    const productDir = resolve(PRODUCTS_DIR, productId);
    const scoreReport = await readJsonFile<Record<string, unknown>>(
      join(productDir, 'score-report.json')
    );
    const scores = await readJsonFile<Record<string, unknown>>(
      join(productDir, 'scores.json')
    );

    if (!scoreReport && !scores) {
      res.status(404).json({ error: 'No score data found for this product' });
      return;
    }

    res.json({ scoreReport, scores, productId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Failed to load feedback scores: ${message}`);
    res.status(500).json({ error: 'Failed to load feedback scores' });
  }
}

// ── Server Setup ─────────────────────────────────────────────────────

export async function startDashboardServer(): Promise<void> {
  const config = await loadConfig();
  const port = parseInt(process.env.DASHBOARD_PORT ?? String(DEFAULT_PORT), 10);

  if (!config.features.dashboardEnabled) {
    logger.warn('Dashboard is disabled in config. Set features.dashboardEnabled to true.');
    return;
  }

  const app = express();

  // Middleware
  app.use(express.json());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
  });
  app.use(authMiddleware);

  // Static files
  app.use(express.static(PUBLIC_DIR));

  // API routes
  app.get('/api/products', handleGetProducts);
  app.get('/api/products/:id', handleGetProductById);
  app.get('/api/listings', handleGetListings);
  app.get('/api/metrics', handleGetMetrics);
  app.get('/api/pipeline', handleGetPipeline);
  app.get('/api/niches', handleGetNiches);
  app.get('/api/activity', handleGetActivity);
  app.post('/api/approve/:id', handlePostApproval);
  app.post('/api/feedback/:id', handlePostFeedback);

  // Review routes
  app.get('/api/review/daily/:productId', handleGetDailyReview);
  app.post('/api/review/daily/:productId', handlePostDailyReview);
  app.get('/api/review/weekly', handleGetWeeklyBatch);
  app.post('/api/review/weekly', handlePostWeeklyReview);

  // Feedback listing routes
  app.get('/api/feedback/daily', handleGetFeedbackDaily);
  app.get('/api/feedback/weekly', handleGetFeedbackWeekly);
  app.get('/api/feedback/scores/:productId', handleGetFeedbackScores);

  // Root route
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  });

  app.listen(port, () => {
    logger.info(`PrintPilot Dashboard running at http://localhost:${port}`);
  });
}

// Run directly
startDashboardServer().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown error';
  logger.error(`Dashboard failed to start: ${message}`);
  process.exit(1);
});
