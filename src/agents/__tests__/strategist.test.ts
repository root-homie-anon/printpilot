import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../tracker/activity-log.js', () => ({
  logActivity: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

import { runStrategy } from '../strategist.js';
import type { Opportunity } from '../../types/index.js';

const VALID_CONFIG = {
  project: { name: 'PrintPilot', slug: 'printpilot', version: '1.0.0' },
  pipeline: {
    productsPerDay: 2,
    marketingBufferDays: 2,
    pinterestDelayDays: 2,
    emailDelayDays: 3,
    blogDelayDays: 7,
  },
  credentials: {
    etsyOAuth: '.credentials/etsy-oauth.json',
    pinterestOAuth: '.credentials/pinterest-oauth.json',
    emailProvider: '.credentials/email.json',
    blogApi: '.credentials/blog.json',
  },
  agents: {
    designer: { pageSize: 'A4' as const, exportDpi: 300, referenceLibraryPath: 'src/renderer/reference-library' },
    researcher: { maxOpportunitiesPerRun: 10, minReviewCount: 50, targetPriceRange: [3, 25] as [number, number] },
    marketing: { pinsPerProduct: 3, pinterestEnabled: false, emailEnabled: false, blogEnabled: false },
  },
  notifications: { channel: 'telegram', approvalRequired: false, weeklyReviewDay: 'sunday' },
  dashboard: { port: 3737 },
  features: { autoPublish: false, autoSynthesize: true, dashboardEnabled: true, marketingEnabled: true, pinterestDirect: true },
};

function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'opp-1',
    niche: 'habit-tracker',
    avgPrice: 5.99,
    reviewCount: 150,
    competitionLevel: 'medium',
    trendScore: 72,
    keywords: ['habit', 'tracker', 'printable'],
    source: 'etsy-scrape+pinterest',
    discoveredAt: '2026-03-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('runStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no opportunities are queued', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockResolvedValue(VALID_CONFIG);

    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockRejectedValue(new Error('ENOENT'));

    const result = await runStrategy();

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('scores and selects top opportunities based on productsPerDay', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockResolvedValue(VALID_CONFIG);

    const { readdir, readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue(['opp-1.json', 'opp-2.json', 'opp-3.json'] as never);
    vi.mocked(readFile).mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p.includes('opp-1')) return JSON.stringify(makeOpportunity({ id: 'opp-1', trendScore: 90 }));
      if (p.includes('opp-2')) return JSON.stringify(makeOpportunity({ id: 'opp-2', trendScore: 50 }));
      if (p.includes('opp-3')) return JSON.stringify(makeOpportunity({ id: 'opp-3', trendScore: 70 }));
      return '{}';
    });
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runStrategy();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2); // productsPerDay = 2
    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it('generates valid ProductBrief objects', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockResolvedValue(VALID_CONFIG);

    const { readdir, readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue(['opp-1.json'] as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(makeOpportunity()));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runStrategy();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);

    const brief = result.data![0];
    expect(brief).toHaveProperty('id');
    expect(brief).toHaveProperty('niche', 'habit-tracker');
    expect(brief).toHaveProperty('targetAudience', 'People interested in habit-tracker');
    expect(brief).toHaveProperty('pageCount');
    expect(brief.pageCount).toBeGreaterThan(0);
    expect(brief).toHaveProperty('sections');
    expect(brief.sections[0]).toBe('Cover');
    expect(brief).toHaveProperty('styleGuide');
    expect(brief.styleGuide).toHaveProperty('primaryFont');
    expect(brief.styleGuide).toHaveProperty('accentColor');
    expect(brief.styleGuide).toHaveProperty('palette');
    expect(brief.styleGuide).toHaveProperty('layout', 'clean-minimal');
    expect(brief).toHaveProperty('createdAt');
  });

  it('writes briefs to product directories', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockResolvedValue(VALID_CONFIG);

    const { readdir, readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue(['opp-1.json'] as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(makeOpportunity()));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    await runStrategy();

    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('products'), { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('brief.json'),
      expect.any(String),
      'utf-8',
    );

    const writtenJson = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
    expect(writtenJson).toHaveProperty('niche', 'habit-tracker');
  });

  it('logs activity on success', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockResolvedValue(VALID_CONFIG);

    const { readdir, readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue(['opp-1.json'] as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(makeOpportunity()));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    await runStrategy();

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'strategist',
        action: 'strategy-complete',
        success: true,
      }),
    );
  });

  it('handles errors gracefully and logs failure', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockRejectedValue(new Error('Config load failed'));

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runStrategy();

    expect(result.success).toBe(false);
    expect(result.error).toBe('Config load failed');
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'strategist',
        action: 'strategy-failed',
        success: false,
      }),
    );
  });
});
