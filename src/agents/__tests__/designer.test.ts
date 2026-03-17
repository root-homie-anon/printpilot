import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../utils/claude.js', () => ({
  callClaude: vi.fn(),
}));

vi.mock('../../tracker/activity-log.js', () => ({
  logActivity: vi.fn(),
}));

vi.mock('../../renderer/template-engine.js', () => ({
  generateProductHtml: vi.fn(),
  getAvailableTemplates: vi.fn(),
}));

vi.mock('../../renderer/render.js', () => ({
  renderPdf: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import { runDesign } from '../designer.js';
import type { ProductBrief } from '../../types/index.js';

const VALID_CONFIG = {
  project: { name: 'PrintPilot', slug: 'printpilot', version: '1.0.0' },
  pipeline: { productsPerDay: 2, marketingBufferDays: 2, pinterestDelayDays: 2, emailDelayDays: 3, blogDelayDays: 7 },
  credentials: { etsyOAuth: '', pinterestOAuth: '', emailProvider: '', blogApi: '' },
  agents: {
    designer: { pageSize: 'A4' as const, exportDpi: 300, referenceLibraryPath: 'src/renderer/reference-library' },
    researcher: { maxOpportunitiesPerRun: 10, minReviewCount: 50, targetPriceRange: [3, 25] as [number, number] },
    marketing: { pinsPerProduct: 3, pinterestEnabled: false, emailEnabled: false, blogEnabled: false },
  },
  notifications: { channel: 'telegram', approvalRequired: false, weeklyReviewDay: 'sunday' },
  dashboard: { port: 3737 },
  features: { autoPublish: false, autoSynthesize: true, dashboardEnabled: true, marketingEnabled: true, pinterestDirect: true },
};

const TEST_BRIEF: ProductBrief = {
  id: 'test-brief-1',
  niche: 'habit-tracker',
  targetAudience: 'People interested in habit tracking',
  pageCount: 13,
  sections: ['Cover', 'habit-tracker - Page 2', 'habit-tracker - Page 3'],
  styleGuide: {
    primaryFont: 'Inter',
    accentColor: 'teal',
    palette: 'teal, navy, light-grey',
    layout: 'clean-minimal',
  },
  createdAt: '2026-03-14T00:00:00.000Z',
};

const RENDER_RESULT = {
  outputPath: '/state/products/test-brief-1/test-brief-1.pdf',
  pageCount: 13,
  fileSizeBytes: 125000,
  duration: 500,
};

describe('runDesign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates design with AI and renders PDF successfully', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockResolvedValue(VALID_CONFIG);

    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue('# Design System\nUse clean layouts.');
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(
      '<page><!DOCTYPE html><html><body>Page 1</body></html></page>' +
      '<page><!DOCTYPE html><html><body>Page 2</body></html></page>',
    );

    const { renderPdf } = await import('../../renderer/render.js');
    vi.mocked(renderPdf).mockResolvedValue(RENDER_RESULT);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runDesign(TEST_BRIEF);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.pageCount).toBe(13);
    expect(result.data!.pdfPath).toContain('test-brief-1.pdf');
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(renderPdf).toHaveBeenCalledTimes(1);
  });

  it('falls back to template engine when AI fails', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockResolvedValue(VALID_CONFIG);

    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue('');
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockRejectedValue(new Error('API rate limit exceeded'));

    const { generateProductHtml, getAvailableTemplates } = await import('../../renderer/template-engine.js');
    vi.mocked(getAvailableTemplates).mockReturnValue(['base', 'tracker', 'planner']);
    vi.mocked(generateProductHtml).mockResolvedValue([
      '<html><body>Template Page 1</body></html>',
      '<html><body>Template Page 2</body></html>',
    ]);

    const { renderPdf } = await import('../../renderer/render.js');
    vi.mocked(renderPdf).mockResolvedValue(RENDER_RESULT);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runDesign(TEST_BRIEF);

    expect(result.success).toBe(true);
    expect(generateProductHtml).toHaveBeenCalled();
    // Verify design.json was written with template method
    const designJsonCall = vi.mocked(writeFile).mock.calls.find(
      (call) => String(call[0]).includes('design.json'),
    );
    expect(designJsonCall).toBeDefined();
    const designMeta = JSON.parse(designJsonCall![1] as string);
    expect(designMeta.generationMethod).toContain('template');
  });

  it('writes HTML pages and design metadata to disk', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockResolvedValue(VALID_CONFIG);

    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue('');
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(
      '<page><html><body>P1</body></html></page><page><html><body>P2</body></html></page>',
    );

    const { renderPdf } = await import('../../renderer/render.js');
    vi.mocked(renderPdf).mockResolvedValue(RENDER_RESULT);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    await runDesign(TEST_BRIEF);

    // Should create product dir and html subdir
    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('test-brief-1'), { recursive: true });
    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('html'), { recursive: true });

    // Should write individual HTML pages
    const htmlWriteCalls = vi.mocked(writeFile).mock.calls.filter(
      (call) => String(call[0]).includes('page-'),
    );
    expect(htmlWriteCalls.length).toBe(2);

    // Should write combined.html
    const combinedCall = vi.mocked(writeFile).mock.calls.find(
      (call) => String(call[0]).includes('combined.html'),
    );
    expect(combinedCall).toBeDefined();

    // Should write design.json
    const designCall = vi.mocked(writeFile).mock.calls.find(
      (call) => String(call[0]).includes('design.json'),
    );
    expect(designCall).toBeDefined();
  });

  it('handles render failures gracefully', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockResolvedValue(VALID_CONFIG);

    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue('');
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(
      '<page><html><body>P1</body></html></page>',
    );

    const { renderPdf } = await import('../../renderer/render.js');
    vi.mocked(renderPdf).mockRejectedValue(new Error('Puppeteer crashed'));

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runDesign(TEST_BRIEF);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Puppeteer crashed');
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'designer',
        action: 'design-failed',
        success: false,
      }),
    );
  });

  it('logs activity on successful design', async () => {
    const { loadConfig } = await import('../../utils/config.js');
    vi.mocked(loadConfig).mockResolvedValue(VALID_CONFIG);

    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue('');
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(
      '<page><html><body>P1</body></html></page>',
    );

    const { renderPdf } = await import('../../renderer/render.js');
    vi.mocked(renderPdf).mockResolvedValue(RENDER_RESULT);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    await runDesign(TEST_BRIEF);

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'designer',
        action: 'design-complete',
        productId: 'test-brief-1',
        success: true,
      }),
    );
  });
});
