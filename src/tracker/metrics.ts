import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import logger from '../utils/logger.js';
import { getRecentActivity } from './activity-log.js';
import type { ActivityEntry } from './activity-log.js';
import type { ListingData } from '../types/index.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const LISTINGS_DIR = join(STATE_DIR, 'listings');
const PRODUCTS_DIR = join(STATE_DIR, 'products');
const METRICS_DIR = join(STATE_DIR, 'metrics');

export interface ProductMetrics {
  productId: string;
  listingId: string;
  views: number;
  favorites: number;
  sales: number;
  revenue: number;
  conversionRate: number;
  daysSinceListed: number;
}

export interface NicheMetrics {
  niche: string;
  productCount: number;
  totalRevenue: number;
  avgScore: number;
  trend: 'up' | 'down' | 'stable';
}

export interface TimelinePoint {
  date: string;
  revenue: number;
  sales: number;
}

export interface DashboardMetrics {
  totalProducts: number;
  liveListings: number;
  totalRevenue: number;
  totalViews: number;
  totalFavorites: number;
  avgConversionRate: number;
  topNiche: string;
  recentActivity: ActivityEntry[];
}

interface ProductState {
  id: string;
  niche: string;
  score?: number;
}

interface ListingMetricsFile {
  listingId: string;
  views: number;
  favorites: number;
  sales: number;
  revenue: number;
  publishedAt: string;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath);
    return entries.filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

async function loadAllListings(): Promise<ListingData[]> {
  const files = await listJsonFiles(LISTINGS_DIR);
  const listings: ListingData[] = [];

  for (const file of files) {
    const data = await readJsonFile<ListingData>(join(LISTINGS_DIR, file));
    if (data) {
      listings.push(data);
    }
  }

  return listings;
}

async function loadProductState(productId: string): Promise<ProductState | null> {
  const briefPath = join(PRODUCTS_DIR, productId, 'brief.json');
  return readJsonFile<ProductState>(briefPath);
}

async function loadListingMetrics(listingFile: string): Promise<ListingMetricsFile | null> {
  return readJsonFile<ListingMetricsFile>(join(LISTINGS_DIR, listingFile));
}

export async function getProductMetrics(productId: string): Promise<ProductMetrics> {
  const files = await listJsonFiles(LISTINGS_DIR);
  let found: ListingMetricsFile | null = null;

  for (const file of files) {
    const data = await loadListingMetrics(file);
    if (data && data.listingId === productId) {
      found = data;
      break;
    }
  }

  if (!found) {
    return {
      productId,
      listingId: '',
      views: 0,
      favorites: 0,
      sales: 0,
      revenue: 0,
      conversionRate: 0,
      daysSinceListed: 0,
    };
  }

  const publishedDate = found.publishedAt ? new Date(found.publishedAt) : new Date();
  const now = new Date();
  const daysSinceListed = Math.floor(
    (now.getTime() - publishedDate.getTime()) / (1000 * 60 * 60 * 24)
  );
  const conversionRate = found.views > 0 ? found.sales / found.views : 0;

  return {
    productId,
    listingId: found.listingId,
    views: found.views,
    favorites: found.favorites,
    sales: found.sales,
    revenue: found.revenue,
    conversionRate,
    daysSinceListed,
  };
}

export async function getNichePerformance(): Promise<NicheMetrics[]> {
  const listings = await loadAllListings();
  const nicheMap = new Map<string, { revenues: number[]; scores: number[]; count: number }>();

  for (const listing of listings) {
    const product = await loadProductState(listing.listingId);
    const niche = product?.niche ?? 'unknown';

    if (!nicheMap.has(niche)) {
      nicheMap.set(niche, { revenues: [], scores: [], count: 0 });
    }

    const entry = nicheMap.get(niche)!;
    entry.count += 1;

    const metrics = await getProductMetrics(listing.listingId);
    entry.revenues.push(metrics.revenue);

    if (product?.score !== undefined) {
      entry.scores.push(product.score);
    }
  }

  const results: NicheMetrics[] = [];

  for (const [niche, data] of nicheMap) {
    const totalRevenue = data.revenues.reduce((sum, r) => sum + r, 0);
    const avgScore =
      data.scores.length > 0
        ? data.scores.reduce((sum, s) => sum + s, 0) / data.scores.length
        : 0;

    const trend = determineTrend(data.revenues);

    results.push({
      niche,
      productCount: data.count,
      totalRevenue,
      avgScore,
      trend,
    });
  }

  results.sort((a, b) => b.totalRevenue - a.totalRevenue);
  return results;
}

function determineTrend(revenues: number[]): 'up' | 'down' | 'stable' {
  if (revenues.length < 2) {
    return 'stable';
  }

  const midpoint = Math.floor(revenues.length / 2);
  const firstHalf = revenues.slice(0, midpoint);
  const secondHalf = revenues.slice(midpoint);

  const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

  const THRESHOLD = 0.1;
  const change = avgFirst > 0 ? (avgSecond - avgFirst) / avgFirst : 0;

  if (change > THRESHOLD) {
    return 'up';
  }
  if (change < -THRESHOLD) {
    return 'down';
  }
  return 'stable';
}

export async function getRevenueTimeline(days: number): Promise<TimelinePoint[]> {
  const files = await listJsonFiles(METRICS_DIR);
  const timeline: TimelinePoint[] = [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  for (const file of files) {
    const dateStr = file.replace('.json', '');
    if (dateStr < cutoffIso) {
      continue;
    }

    const snapshot = await readJsonFile<{ revenue: number; sales: number }>(
      join(METRICS_DIR, file)
    );

    if (snapshot) {
      timeline.push({
        date: dateStr,
        revenue: snapshot.revenue,
        sales: snapshot.sales,
      });
    }
  }

  timeline.sort((a, b) => a.date.localeCompare(b.date));
  return timeline;
}

export async function aggregateMetrics(): Promise<DashboardMetrics> {
  logger.info('Aggregating dashboard metrics');

  const listings = await loadAllListings();
  const liveListings = listings.filter((l) => l.status === 'active');

  let totalRevenue = 0;
  let totalViews = 0;
  let totalFavorites = 0;
  let totalSales = 0;

  const listingIds = new Set<string>();

  for (const listing of listings) {
    listingIds.add(listing.listingId);
    const metrics = await getProductMetrics(listing.listingId);
    totalRevenue += metrics.revenue;
    totalViews += metrics.views;
    totalFavorites += metrics.favorites;
    totalSales += metrics.sales;
  }

  const productDirs = await listProductDirs();
  const totalProducts = Math.max(productDirs.length, listingIds.size);

  const avgConversionRate = totalViews > 0 ? totalSales / totalViews : 0;

  const nichePerf = await getNichePerformance();
  const topNiche = nichePerf.length > 0 ? nichePerf[0].niche : 'none';

  const recentActivity = await getRecentActivity(7);

  const dashboard: DashboardMetrics = {
    totalProducts,
    liveListings: liveListings.length,
    totalRevenue,
    totalViews,
    totalFavorites,
    avgConversionRate,
    topNiche,
    recentActivity,
  };

  await writeDailySnapshot(dashboard, totalSales);

  logger.info(
    `Dashboard: ${totalProducts} products, ${liveListings.length} live, $${totalRevenue.toFixed(2)} revenue`
  );

  return dashboard;
}

async function listProductDirs(): Promise<string[]> {
  try {
    const entries = await readdir(PRODUCTS_DIR);
    return entries;
  } catch {
    return [];
  }
}

async function writeDailySnapshot(
  dashboard: DashboardMetrics,
  totalSales: number
): Promise<void> {
  await mkdir(METRICS_DIR, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const snapshotPath = join(METRICS_DIR, `${today}.json`);

  const snapshot = {
    date: today,
    totalProducts: dashboard.totalProducts,
    liveListings: dashboard.liveListings,
    revenue: dashboard.totalRevenue,
    sales: totalSales,
    views: dashboard.totalViews,
    favorites: dashboard.totalFavorites,
    avgConversionRate: dashboard.avgConversionRate,
    topNiche: dashboard.topNiche,
  };

  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  logger.info(`Daily snapshot written: ${snapshotPath}`);
}
