import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import logger from '../utils/logger.js';
import { getNichePerformance } from './metrics.js';
import type { NicheMetrics } from './metrics.js';

const NICHE_REGISTRY_PATH = resolve(process.cwd(), 'shared', 'niche-registry.md');

const DECLINING_THRESHOLD = -0.15;

interface NicheRow {
  slug: string;
  category: string;
  avgPrice: string;
  competitionLevel: string;
  qualityScoreTrend: string;
  notes: string;
}

function parseNicheRegistry(content: string): NicheRow[] {
  const lines = content.split('\n');
  const rows: NicheRow[] = [];

  let inTable = false;
  let headerPassed = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('| Niche Slug')) {
      inTable = true;
      continue;
    }

    if (inTable && trimmed.startsWith('|---')) {
      headerPassed = true;
      continue;
    }

    if (inTable && headerPassed && trimmed.startsWith('|')) {
      const cells = trimmed
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);

      if (cells.length >= 6 && cells[0] !== '') {
        rows.push({
          slug: cells[0],
          category: cells[1],
          avgPrice: cells[2],
          competitionLevel: cells[3],
          qualityScoreTrend: cells[4],
          notes: cells[5],
        });
      }
    }

    if (inTable && headerPassed && !trimmed.startsWith('|')) {
      break;
    }
  }

  return rows;
}

function trendArrow(trend: 'up' | 'down' | 'stable'): string {
  if (trend === 'up') return '↑';
  if (trend === 'down') return '↓';
  return '→';
}

function competitionLevel(productCount: number): string {
  if (productCount <= 2) return 'low';
  if (productCount <= 5) return 'medium';
  return 'high';
}

function buildRegistryMarkdown(rows: NicheRow[]): string {
  const header = [
    '# PrintPilot Niche Registry',
    '',
    'Tracks all explored niches with performance data. Updated by @researcher and @tracker agents.',
    '',
    '| Niche Slug | Category | Avg Price ($) | Competition Level | Quality Score Trend | Notes |',
    '|------------|----------|---------------|-------------------|--------------------:|-------|',
  ];

  const dataRows = rows.map(
    (r) =>
      `| ${r.slug} | ${r.category} | ${r.avgPrice} | ${r.competitionLevel} | ${r.qualityScoreTrend} | ${r.notes} |`
  );

  const footer = [
    '',
    '## Column Definitions',
    '',
    '- **Niche Slug**: kebab-case identifier (e.g., `daily-planner`, `budget-tracker-couples`)',
    '- **Category**: broad grouping (wellness, productivity, kids, home, finance, wedding, fitness)',
    '- **Avg Price ($)**: average selling price on Etsy for top listings in this niche',
    '- **Competition Level**: low / medium / high — based on number of competing listings and seller count',
    '- **Quality Score Trend**: average design quality score (1-5) across our products in this niche, with directional arrow',
    '- **Notes**: free text — seasonal trends, saturation warnings, audience insights',
  ];

  return [...header, ...dataRows, ...footer].join('\n') + '\n';
}

export async function updateNicheRegistry(): Promise<void> {
  logger.info('Updating niche registry');

  let currentContent: string;
  try {
    currentContent = await readFile(NICHE_REGISTRY_PATH, 'utf-8');
  } catch {
    logger.warn('Niche registry not found, creating new one');
    currentContent = '';
  }

  const existingRows = parseNicheRegistry(currentContent);
  const existingMap = new Map<string, NicheRow>();
  for (const row of existingRows) {
    existingMap.set(row.slug, row);
  }

  const nicheMetrics = await getNichePerformance();

  for (const metric of nicheMetrics) {
    const slug = metric.niche;
    const existing = existingMap.get(slug);

    const avgPriceStr = metric.totalRevenue > 0
      ? (metric.totalRevenue / metric.productCount).toFixed(2)
      : existing?.avgPrice ?? '0.00';

    const arrow = trendArrow(metric.trend);
    const scoreStr = metric.avgScore > 0
      ? `${metric.avgScore.toFixed(1)} ${arrow}`
      : existing?.qualityScoreTrend ?? `0.0 ${arrow}`;

    const notes = buildNotes(metric, existing?.notes);

    existingMap.set(slug, {
      slug,
      category: existing?.category ?? inferCategory(slug),
      avgPrice: avgPriceStr,
      competitionLevel: existing?.competitionLevel ?? competitionLevel(metric.productCount),
      qualityScoreTrend: scoreStr,
      notes,
    });
  }

  const updatedRows = Array.from(existingMap.values());
  updatedRows.sort((a, b) => a.slug.localeCompare(b.slug));

  const markdown = buildRegistryMarkdown(updatedRows);
  await writeFile(NICHE_REGISTRY_PATH, markdown, 'utf-8');

  logger.info(`Niche registry updated: ${updatedRows.length} niches`);
}

function buildNotes(metric: NicheMetrics, existingNotes?: string): string {
  const parts: string[] = [];

  if (existingNotes && existingNotes.trim()) {
    parts.push(existingNotes.trim());
  }

  if (metric.trend === 'down') {
    const revenuePerProduct = metric.productCount > 0
      ? metric.totalRevenue / metric.productCount
      : 0;

    if (revenuePerProduct < DECLINING_THRESHOLD * -100) {
      parts.push('⚠ declining performance');
    }
  }

  return parts.join('; ');
}

function inferCategory(slug: string): string {
  const CATEGORY_KEYWORDS: Record<string, string[]> = {
    wellness: ['wellness', 'self-care', 'mindfulness', 'meditation', 'gratitude'],
    productivity: ['planner', 'organizer', 'schedule', 'to-do', 'task', 'goal'],
    fitness: ['fitness', 'workout', 'exercise', 'gym', 'health'],
    finance: ['budget', 'finance', 'money', 'savings', 'expense'],
    kids: ['kids', 'children', 'baby', 'toddler', 'school'],
    home: ['home', 'cleaning', 'meal', 'recipe', 'garden'],
    wedding: ['wedding', 'bride', 'bridal'],
  };

  const lower = slug.toLowerCase();

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        return category;
      }
    }
  }

  return 'general';
}
