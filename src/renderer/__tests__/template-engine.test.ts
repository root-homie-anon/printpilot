import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProductBrief } from '../../types/index.js';

vi.mock('../../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const MOCK_TEMPLATE_HTML = `<!DOCTYPE html>
<html>
<head><title>{{title}}</title><style>{{designSystemCss}}</style></head>
<body>
  <h1>{{title}}</h1>
  <p>{{description}}</p>
  <span>{{sectionName}}</span>
  <footer>Page {{pageNumber}} of {{totalPages}}</footer>
</body>
</html>`;

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

function makeBrief(overrides?: Partial<ProductBrief>): ProductBrief {
  return {
    id: 'brief-001',
    niche: 'Budget Planner',
    targetAudience: 'Young professionals',
    pageCount: 2,
    sections: ['Monthly Overview', 'Weekly Tracker'],
    styleGuide: {
      primaryFont: 'Playfair Display',
      accentColor: '#4A90D9',
      palette: 'cool-blue',
      layout: 'minimal',
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('template-engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getAvailableTemplates returns all templates', async () => {
    const { getAvailableTemplates } = await import('../template-engine.js');
    const templates = getAvailableTemplates();

    expect(templates).toContain('base');
    expect(templates).toContain('planner-weekly');
    expect(templates).toContain('tracker-habit');
    expect(templates).toContain('journal-gratitude');
    expect(templates).toContain('worksheet-budget');
    expect(templates).toHaveLength(5);
  });

  it('loadTemplate loads HTML file content', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(MOCK_TEMPLATE_HTML);

    const { loadTemplate } = await import('../template-engine.js');
    const content = await loadTemplate('base');

    expect(content).toContain('<!DOCTYPE html>');
    expect(content).toContain('{{title}}');
  });

  it('loadTemplate throws on missing template', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file'));

    const { loadTemplate } = await import('../template-engine.js');

    await expect(loadTemplate('nonexistent')).rejects.toThrow('Template "nonexistent" not found');
  });

  it('generateProductHtml produces valid HTML strings', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(MOCK_TEMPLATE_HTML);

    const { generateProductHtml } = await import('../template-engine.js');
    const brief = makeBrief();
    const pages = await generateProductHtml(brief, 'base');

    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page).toContain('<!DOCTYPE html>');
      expect(page).toContain('<html>');
    }
  });

  it('template variables are interpolated correctly', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(MOCK_TEMPLATE_HTML);

    const { generateProductHtml } = await import('../template-engine.js');
    const brief = makeBrief({ niche: 'Habit Tracker', pageCount: 1, sections: ['Daily Habits'] });
    const pages = await generateProductHtml(brief, 'base');

    expect(pages[0]).toContain('Habit Tracker');
    expect(pages[0]).toContain('Daily Habits');
    expect(pages[0]).toContain('Page 1 of 1');
    expect(pages[0]).not.toContain('{{title}}');
    expect(pages[0]).not.toContain('{{pageNumber}}');
  });
});
