import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const MOCK_CONFIG = {
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
    designer: { pageSize: 'A4', exportDpi: 300, referenceLibraryPath: 'src/renderer/reference-library' },
    researcher: { maxOpportunitiesPerRun: 10, minReviewCount: 50, targetPriceRange: [3, 25] },
    marketing: { pinsPerProduct: 3, emailEnabled: true, blogEnabled: true },
  },
  notifications: { channel: 'telegram', approvalRequired: true, weeklyReviewDay: 'sunday' },
  features: { autoPublish: false, autoSynthesize: true, dashboardEnabled: true, marketingEnabled: true },
};

vi.mock('../../utils/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue(MOCK_CONFIG),
}));

let tempDir: string;
const originalCwd = process.cwd;

describe('marketing scheduler', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'printpilot-marketing-'));
    process.cwd = () => tempDir;
    vi.clearAllMocks();
    vi.resetModules();
    // Re-apply the config mock after resetModules
    vi.doMock('../../utils/config.js', () => ({
      loadConfig: vi.fn().mockResolvedValue(MOCK_CONFIG),
    }));
    vi.doMock('../../utils/logger.js', () => ({
      default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('scheduleMarketing creates correct schedule with configured delays', async () => {
    const { scheduleMarketing } = await import('../scheduler.js');
    const schedule = await scheduleMarketing('prod-100', 'https://etsy.com/listing/123');

    expect(schedule.productId).toBe('prod-100');
    expect(schedule.actions).toHaveLength(3);

    const channels = schedule.actions.map((a) => a.channel);
    expect(channels).toContain('pinterest');
    expect(channels).toContain('email');
    expect(channels).toContain('blog');
  });

  it('Pinterest scheduled at +2 days', async () => {
    const now = new Date();
    const { scheduleMarketing } = await import('../scheduler.js');
    const schedule = await scheduleMarketing('prod-101', 'https://etsy.com/listing/101');

    const pinterestAction = schedule.actions.find((a) => a.channel === 'pinterest');
    expect(pinterestAction).toBeDefined();

    const scheduledDate = new Date(pinterestAction!.scheduledDate);
    const diffDays = (scheduledDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(Math.round(diffDays)).toBe(2);
  });

  it('Email scheduled at +3 days', async () => {
    const now = new Date();
    const { scheduleMarketing } = await import('../scheduler.js');
    const schedule = await scheduleMarketing('prod-102', 'https://etsy.com/listing/102');

    const emailAction = schedule.actions.find((a) => a.channel === 'email');
    expect(emailAction).toBeDefined();

    const scheduledDate = new Date(emailAction!.scheduledDate);
    const diffDays = (scheduledDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(Math.round(diffDays)).toBe(3);
  });

  it('Blog scheduled at +7 days', async () => {
    const now = new Date();
    const { scheduleMarketing } = await import('../scheduler.js');
    const schedule = await scheduleMarketing('prod-103', 'https://etsy.com/listing/103');

    const blogAction = schedule.actions.find((a) => a.channel === 'blog');
    expect(blogAction).toBeDefined();

    const scheduledDate = new Date(blogAction!.scheduledDate);
    const diffDays = (scheduledDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(Math.round(diffDays)).toBe(7);
  });

  it('getScheduledActions returns all actions for a product', async () => {
    const { scheduleMarketing, getScheduledActions } = await import('../scheduler.js');
    await scheduleMarketing('prod-104', 'https://etsy.com/listing/104');

    const actions = await getScheduledActions('prod-104');
    expect(actions).toHaveLength(3);
    expect(actions.every((a) => a.status === 'scheduled')).toBe(true);
  });

  it('executeScheduledActions only processes due actions', async () => {
    const { executeScheduledActions } = await import('../scheduler.js');

    // Create a schedule with one past-due action and one future action
    const stateDir = join(tempDir, 'state/marketing/prod-105');
    await mkdir(stateDir, { recursive: true });

    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const futureDate = new Date(Date.now() + 86400000 * 10).toISOString();

    const schedule = {
      productId: 'prod-105',
      actions: [
        {
          channel: 'pinterest',
          scheduledDate: pastDate,
          status: 'scheduled',
          data: { listingUrl: 'https://etsy.com/listing/105', pinCount: '3' },
        },
        {
          channel: 'email',
          scheduledDate: futureDate,
          status: 'scheduled',
          data: { listingUrl: 'https://etsy.com/listing/105' },
        },
      ],
    };

    await writeFile(join(stateDir, 'schedule.json'), JSON.stringify(schedule), 'utf-8');

    const executors = {
      pinterest: vi.fn().mockResolvedValue(undefined),
      email: vi.fn().mockResolvedValue(undefined),
      blog: vi.fn().mockResolvedValue(undefined),
    };

    const results = await executeScheduledActions(executors);

    expect(executors.pinterest).toHaveBeenCalledTimes(1);
    expect(executors.email).not.toHaveBeenCalled();
    expect(executors.blog).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].channel).toBe('pinterest');
    expect(results[0].success).toBe(true);
  });
});
