import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/claude.js', () => ({
  callClaude: vi.fn(),
}));

vi.mock('../../tracker/activity-log.js', () => ({
  logActivity: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import { runScoring } from '../scorer.js';

const TEST_BRIEF = {
  id: 'test-product-1',
  niche: 'habit-tracker',
  targetAudience: 'People interested in habit tracking',
  pageCount: 13,
  sections: ['Cover', 'habit-tracker - Page 2', 'habit-tracker - Page 3',
    'habit-tracker - Page 4', 'habit-tracker - Page 5', 'habit-tracker - Page 6',
    'habit-tracker - Page 7', 'habit-tracker - Page 8', 'habit-tracker - Page 9',
    'habit-tracker - Page 10', 'habit-tracker - Page 11', 'habit-tracker - Page 12',
    'habit-tracker - Page 13'],
  styleGuide: {
    primaryFont: 'Inter',
    accentColor: 'teal',
    palette: 'teal, navy, light-grey',
    layout: 'clean-minimal',
  },
  createdAt: '2026-03-14T00:00:00.000Z',
};

const TEST_DESIGN = {
  generationMethod: 'ai',
  htmlPages: 13,
  pdfPath: '/state/products/test-product-1/test-product-1.pdf',
  pageCount: 13,
  fileSizeBytes: 125000,
  renderDuration: 500,
};

const TEST_COPY = {
  title: 'Habit Tracker Printable | Digital Download | 13 Pages',
  description: 'Stay on top of your goals with this beautiful habit tracker. Track daily habits across 13 professionally designed pages.',
  tags: [
    'habit tracker printable', 'digital download planner', 'daily habit log',
    'printable habit journal', 'goal tracking printable', 'instant download tracker',
    'habit building tool', 'self improvement printable', 'productivity tracker pdf',
    'habit challenge sheet', 'monthly habit tracker', 'wellness printable pdf',
    'organization download',
  ],
  pinterestCopy: [
    'Transform your routine with this 13-page habit tracker!',
    'Beautiful minimal habit tracker - instant download!',
    'Stay consistent with your goals using this printable habit tracker.',
  ],
  emailCopy: 'Subject: New Habit Tracker!\n\nCheck out our latest tracker...',
  blogDraft: '# The Ultimate Habit Tracker\n\nBuilding good habits...',
};

const VALID_AI_SCORE_RESPONSE = JSON.stringify({
  designQuality: { score: 82, reasoning: 'Clean layout, good font choices' },
  marketFit: { score: 78, reasoning: 'Habit trackers are a strong niche' },
  copyQuality: { score: 85, reasoning: 'Well-optimized title and tags' },
  overallSellability: { score: 80, reasoning: 'Strong product overall' },
  flags: [],
  recommendation: 'strong-approve',
});

function mockReadFile(path: unknown): Promise<string> {
  const p = String(path);
  if (p.includes('brief.json')) return Promise.resolve(JSON.stringify(TEST_BRIEF));
  if (p.includes('design.json')) return Promise.resolve(JSON.stringify(TEST_DESIGN));
  if (p.includes('copy.json')) return Promise.resolve(JSON.stringify(TEST_COPY));
  return Promise.reject(new Error(`ENOENT: ${p}`));
}

describe('runScoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scores product with AI and generates score report', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockImplementation(mockReadFile as never);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(VALID_AI_SCORE_RESPONSE);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runScoring('test-product-1');

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.productId).toBe('test-product-1');
    expect(result.data!.scores.designQuality).toBe(82);
    expect(result.data!.scores.marketFit).toBe(78);
    expect(result.data!.scores.copyQuality).toBe(85);
    expect(result.data!.scores.overallSellability).toBe(80);
    expect(result.data!.recommendation).toBe('strong-approve');
  });

  it('falls back to heuristic scoring when AI fails', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockImplementation(mockReadFile as never);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockRejectedValue(new Error('AI service down'));

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runScoring('test-product-1');

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.scores.designQuality).toBeGreaterThanOrEqual(0);
    expect(result.data!.scores.designQuality).toBeLessThanOrEqual(100);
    expect(result.data!.scores.overallSellability).toBeGreaterThanOrEqual(0);
    expect(result.data!.scores.overallSellability).toBeLessThanOrEqual(100);
    expect(['strong-approve', 'approve', 'marginal', 'reject']).toContain(
      result.data!.recommendation,
    );
  });

  it('clamps AI scores to 0-100 range', async () => {
    const outOfRangeResponse = JSON.stringify({
      designQuality: { score: 150, reasoning: 'Excessive score' },
      marketFit: { score: -20, reasoning: 'Negative score' },
      copyQuality: { score: 85, reasoning: 'Normal' },
      overallSellability: { score: 200, reasoning: 'Way too high' },
      flags: [],
      recommendation: 'strong-approve',
    });

    const { readFile, writeFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockImplementation(mockReadFile as never);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(outOfRangeResponse);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runScoring('test-product-1');

    expect(result.success).toBe(true);
    expect(result.data!.scores.designQuality).toBe(100);
    expect(result.data!.scores.marketFit).toBe(0);
    expect(result.data!.scores.overallSellability).toBe(100);
  });

  it('derives correct recommendation from overall score', async () => {
    const noRecommendationResponse = JSON.stringify({
      designQuality: { score: 55, reasoning: 'Okay' },
      marketFit: { score: 45, reasoning: 'Weak' },
      copyQuality: { score: 50, reasoning: 'Average' },
      overallSellability: { score: 48, reasoning: 'Below average' },
      flags: ['Needs improvement'],
      recommendation: 'invalid-value',
    });

    const { readFile, writeFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockImplementation(mockReadFile as never);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(noRecommendationResponse);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runScoring('test-product-1');

    expect(result.success).toBe(true);
    // overallSellability is 48, so recommendation should be 'reject' (< 50)
    expect(result.data!.recommendation).toBe('reject');
  });

  it('writes score-report.json and scores.json', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockImplementation(mockReadFile as never);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(VALID_AI_SCORE_RESPONSE);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    await runScoring('test-product-1');

    const writeCalls = vi.mocked(writeFile).mock.calls;

    const scoreReportCall = writeCalls.find(
      (call) => String(call[0]).includes('score-report.json'),
    );
    expect(scoreReportCall).toBeDefined();
    const report = JSON.parse(scoreReportCall![1] as string);
    expect(report).toHaveProperty('productId', 'test-product-1');
    expect(report).toHaveProperty('scores');
    expect(report).toHaveProperty('recommendation');

    const scoresCall = writeCalls.find(
      (call) => String(call[0]).includes('scores.json'),
    );
    expect(scoresCall).toBeDefined();
    const scores = JSON.parse(scoresCall![1] as string);
    expect(scores).toHaveProperty('layout');
    expect(scores).toHaveProperty('typography');
    expect(scores).toHaveProperty('color');
    expect(scores).toHaveProperty('differentiation');
    expect(scores).toHaveProperty('sellability');
  });

  it('handles missing product files gracefully', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file or directory'));

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runScoring('nonexistent-product');

    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'scorer',
        action: 'scoring-failed',
        success: false,
      }),
    );
  });
});
