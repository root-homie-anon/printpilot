import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, basename, extname } from 'node:path';
import type { ProductBrief } from '../types/index.js';
import logger from '../utils/logger.js';

const TEMPLATES_DIR = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  'templates'
);

const DESIGN_SYSTEM_CSS = `
  :root {
    /* Typography */
    --font-heading: {{primaryFont}}, 'Georgia', serif;
    --font-body: 'Helvetica Neue', 'Arial', sans-serif;
    --font-size-xs: 10px;
    --font-size-sm: 12px;
    --font-size-base: 14px;
    --font-size-lg: 18px;
    --font-size-xl: 24px;
    --font-size-2xl: 32px;
    --font-size-3xl: 40px;

    /* Spacing */
    --space-xs: 4px;
    --space-sm: 8px;
    --space-md: 16px;
    --space-lg: 24px;
    --space-xl: 32px;
    --space-2xl: 48px;
    --space-3xl: 64px;

    /* Colors */
    --color-primary: {{accentColor}};
    --color-secondary: #6c757d;
    --color-accent: {{accentColor}};
    --color-background: #ffffff;
    --color-surface: #f8f9fa;
    --color-text: #212529;
    --color-text-muted: #6c757d;
    --color-border: #dee2e6;
    --color-border-light: #e9ecef;

    /* Layout */
    --page-width: 210mm;
    --page-height: 297mm;
    --margin-top: 15mm;
    --margin-right: 15mm;
    --margin-bottom: 15mm;
    --margin-left: 15mm;
  }
`;

export async function generateProductHtml(
  brief: ProductBrief,
  templateName: string
): Promise<string[]> {
  logger.info(`Generating HTML for brief "${brief.id}" with template "${templateName}"`);

  const templateContent = await loadTemplate(templateName);
  const pages: string[] = [];

  const cssVars = buildDesignSystemCss(brief);

  for (let i = 0; i < brief.pageCount; i++) {
    const sectionName = brief.sections[i] ?? '';
    const pageHtml = interpolate(templateContent, {
      title: brief.niche,
      description: `${brief.niche} - ${brief.targetAudience}`,
      niche: brief.niche,
      pageNumber: String(i + 1),
      totalPages: String(brief.pageCount),
      designSystemCss: cssVars,
      primaryFont: brief.styleGuide.primaryFont,
      accentColor: brief.styleGuide.accentColor,
      palette: brief.styleGuide.palette,
      layout: brief.styleGuide.layout,
      sectionName,
    });

    pages.push(pageHtml);
  }

  logger.info(`Generated ${pages.length} HTML pages for brief "${brief.id}"`);
  return pages;
}

export function getAvailableTemplates(): string[] {
  return [
    'base',
    'planner-weekly',
    'tracker-habit',
    'journal-gratitude',
    'worksheet-budget',
  ];
}

export async function loadTemplate(name: string): Promise<string> {
  const templatePath = join(TEMPLATES_DIR, `${name}.html`);
  logger.info(`Loading template: ${templatePath}`);

  try {
    const content = await readFile(templatePath, 'utf-8');
    return content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to load template "${name}": ${message}`);
    throw new Error(`Template "${name}" not found at ${templatePath}`);
  }
}

export async function listTemplateFiles(): Promise<string[]> {
  const entries = await readdir(TEMPLATES_DIR);
  return entries
    .filter((f) => extname(f) === '.html')
    .map((f) => basename(f, '.html'));
}

function buildDesignSystemCss(brief: ProductBrief): string {
  return interpolate(DESIGN_SYSTEM_CSS, {
    primaryFont: brief.styleGuide.primaryFont,
    accentColor: brief.styleGuide.accentColor,
  });
}

function interpolate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(pattern, value);
  }
  return result;
}

export default generateProductHtml;
