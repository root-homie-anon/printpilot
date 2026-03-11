import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig, clearConfigCache } from '../config.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const VALID_CONFIG = {
  project: {
    name: 'PrintPilot',
    slug: 'printpilot',
    version: '1.0.0',
  },
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
    designer: {
      pageSize: 'A4',
      exportDpi: 300,
      referenceLibraryPath: 'src/renderer/reference-library',
    },
    researcher: {
      maxOpportunitiesPerRun: 10,
      minReviewCount: 50,
      targetPriceRange: [3, 25],
    },
    marketing: {
      pinsPerProduct: 3,
      emailEnabled: true,
      blogEnabled: true,
    },
  },
  notifications: {
    channel: 'telegram',
    approvalRequired: true,
    weeklyReviewDay: 'sunday',
  },
  features: {
    autoPublish: false,
    autoSynthesize: true,
    dashboardEnabled: true,
    marketingEnabled: true,
  },
};

describe('loadConfig', () => {
  beforeEach(() => {
    clearConfigCache();
    vi.clearAllMocks();
  });

  it('loads valid config.json successfully', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(VALID_CONFIG));

    const config = await loadConfig();

    expect(config.project.name).toBe('PrintPilot');
    expect(config.pipeline.productsPerDay).toBe(2);
    expect(config.agents.designer.pageSize).toBe('A4');
  });

  it('throws ConfigError on missing config file', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file or directory'));

    await expect(loadConfig()).rejects.toThrow();
  });

  it('validates required fields with Zod', async () => {
    const { readFile } = await import('node:fs/promises');
    const invalidConfig = { project: { name: 'PrintPilot' } };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(invalidConfig));

    await expect(loadConfig()).rejects.toThrow();
  });

  it('returns cached config on subsequent calls', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(VALID_CONFIG));

    const first = await loadConfig();
    const second = await loadConfig();

    expect(first).toBe(second);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
