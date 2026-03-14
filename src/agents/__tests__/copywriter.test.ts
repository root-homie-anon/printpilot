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

import { runCopywriting } from '../copywriter.js';
import type { ProductBrief } from '../../types/index.js';

const TEST_BRIEF: ProductBrief = {
  id: 'test-product-1',
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

const VALID_AI_RESPONSE = JSON.stringify({
  title: 'Habit Tracker Printable | Digital Download | Daily Habit Log | 13 Pages',
  description: 'Stay on top of your goals with this beautiful habit tracker printable. Track your daily habits across 13 pages designed for clarity and motivation.',
  tags: [
    'habit tracker printable',
    'digital download planner',
    'daily habit log',
    'printable habit journal',
    'goal tracking printable',
    'instant download tracker',
    'habit building tool',
    'self improvement printable',
    'productivity tracker pdf',
    'habit challenge sheet',
    'monthly habit tracker',
    'wellness printable pdf',
    'organization download',
  ],
  pinterestDescriptions: [
    'Transform your routine with this 13-page habit tracker! #printable #habittracker #organization',
    'Beautiful minimal habit tracker - instant download and print at home! #digitaldownload #planner',
    'Stay consistent with your goals using this printable habit tracker. Link in bio! #habits #wellness',
  ],
  emailAnnouncement: 'Subject: New Habit Tracker Just Dropped!\n\nHi there,\n\nOur latest habit tracker is here...',
  blogDraft: '# The Ultimate Habit Tracker Printable\n\nBuilding good habits is the key to success...',
});

describe('runCopywriting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates copy with AI and validates output', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(TEST_BRIEF));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(VALID_AI_RESPONSE);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runCopywriting('test-product-1');

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.title).toContain('Habit Tracker');
    expect(result.data!.tags).toHaveLength(13);
    expect(result.data!.pinterestCopy).toHaveLength(3);
    expect(result.data!.description.length).toBeGreaterThan(0);
  });

  it('falls back to template copy when AI fails', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(TEST_BRIEF));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockRejectedValue(new Error('API unavailable'));

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runCopywriting('test-product-1');

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    // Fallback title uses niche name
    expect(result.data!.title).toContain('Habit Tracker');
    expect(result.data!.tags).toHaveLength(13);
    expect(result.data!.pinterestCopy).toHaveLength(3);
  });

  it('validates title length is max 140 chars', async () => {
    const longTitle = 'A'.repeat(200) + ' Printable | Digital Download';
    const aiResponse = JSON.stringify({
      ...JSON.parse(VALID_AI_RESPONSE),
      title: longTitle,
    });

    const { readFile, writeFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(TEST_BRIEF));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(aiResponse);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runCopywriting('test-product-1');

    expect(result.success).toBe(true);
    expect(result.data!.title.length).toBeLessThanOrEqual(140);
  });

  it('ensures exactly 13 tags by supplementing with fallbacks', async () => {
    const shortTagsResponse = JSON.stringify({
      ...JSON.parse(VALID_AI_RESPONSE),
      tags: ['habit tracker', 'printable pdf', 'digital download'],
    });

    const { readFile, writeFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(TEST_BRIEF));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(shortTagsResponse);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runCopywriting('test-product-1');

    expect(result.success).toBe(true);
    expect(result.data!.tags).toHaveLength(13);
  });

  it('writes copy.json to product directory', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(TEST_BRIEF));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const { callClaude } = await import('../../utils/claude.js');
    vi.mocked(callClaude).mockResolvedValue(VALID_AI_RESPONSE);

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    await runCopywriting('test-product-1');

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('copy.json'),
      expect.any(String),
      'utf-8',
    );

    const writtenJson = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
    expect(writtenJson).toHaveProperty('title');
    expect(writtenJson).toHaveProperty('tags');
    expect(writtenJson).toHaveProperty('pinterestCopy');
  });

  it('handles missing brief file gracefully', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file or directory'));

    const { logActivity } = await import('../../tracker/activity-log.js');
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await runCopywriting('nonexistent-product');

    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'copywriter',
        action: 'copywriting-failed',
        success: false,
      }),
    );
  });
});
