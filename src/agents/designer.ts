import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { AgentResult, ProductBrief } from '../types/index.js';
import { loadConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { callClaude } from '../utils/claude.js';
import { logActivity } from '../tracker/activity-log.js';
import { generateProductHtml, getAvailableTemplates } from '../renderer/template-engine.js';
import { renderPdf } from '../renderer/render.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = join(STATE_DIR, 'products');
const DESIGN_SYSTEM_PATH = resolve(process.cwd(), 'shared/design-system.md');

export interface DesignResult {
  htmlPages: string[];
  pdfPath: string;
  pageCount: number;
}

async function loadDesignSystem(): Promise<string> {
  try {
    return await readFile(DESIGN_SYSTEM_PATH, 'utf-8');
  } catch {
    logger.warn('Could not load design-system.md, using defaults');
    return '';
  }
}

function buildDesignPrompt(brief: ProductBrief, designSystem: string): string {
  const nicheLabel = brief.niche.replace(/-/g, ' ');

  return `You are an expert printable product designer. Generate complete HTML/CSS pages for a printable ${nicheLabel} product.

## Product Brief
- Niche: ${nicheLabel}
- Target audience: ${brief.targetAudience}
- Total pages needed: ${brief.pageCount}
- Sections to include: ${brief.sections.join(', ')}
- Primary font: ${brief.styleGuide.primaryFont}
- Accent color: ${brief.styleGuide.accentColor}
- Color palette: ${brief.styleGuide.palette}
- Layout style: ${brief.styleGuide.layout}

## Design System Rules
${designSystem}

## Requirements
1. Generate exactly ${brief.pageCount} complete HTML pages
2. Each page must be a self-contained HTML document with embedded CSS
3. Design for A4 paper size (210mm x 297mm) with 15mm margins
4. Use the specified fonts, colors, and layout style
5. Include proper print CSS (@media print)
6. Each page should be functional and printable
7. Use clean, minimal design appropriate for the niche
8. Ensure text meets minimum 11pt size for readability
9. Include all sections from the brief across the pages

## Output Format
Return each HTML page wrapped in <page> tags:
<page>
<!DOCTYPE html>
<html>...complete page 1...</html>
</page>
<page>
<!DOCTYPE html>
<html>...complete page 2...</html>
</page>
...and so on for all ${brief.pageCount} pages.

Generate all ${brief.pageCount} pages now.`;
}

function parseHtmlPages(response: string): string[] {
  const pageRegex = /<page>([\s\S]*?)<\/page>/g;
  const pages: string[] = [];
  let match = pageRegex.exec(response);

  while (match !== null) {
    const content = match[1].trim();
    if (content.length > 0) {
      pages.push(content);
    }
    match = pageRegex.exec(response);
  }

  return pages;
}

export async function generateDesignWithAI(brief: ProductBrief): Promise<string[]> {
  const designSystem = await loadDesignSystem();
  const prompt = buildDesignPrompt(brief, designSystem);

  logger.info(`Generating AI design for ${brief.id}, requesting ${brief.pageCount} pages`);

  const response = await callClaude(prompt, {
    systemPrompt: 'You are an expert printable product designer. Generate clean, professional HTML/CSS pages optimized for printing. Always wrap each page in <page> tags.',
    maxTokens: 8192,
    temperature: 0.5,
  });

  const pages = parseHtmlPages(response);

  if (pages.length === 0) {
    throw new Error('AI response contained no valid HTML pages');
  }

  logger.info(
    `AI generated ${pages.length} HTML pages for ${brief.id} (requested ${brief.pageCount})`,
  );

  return pages;
}

function selectTemplate(brief: ProductBrief): string {
  const available = getAvailableTemplates();

  // Try to match niche keywords to available templates
  const niche = brief.niche.toLowerCase();
  const match = available.find((t) => niche.includes(t));

  if (match) {
    return match;
  }

  return 'base';
}

export async function runDesign(brief: ProductBrief): Promise<AgentResult<DesignResult>> {
  const startTime = performance.now();

  logger.info(`Design agent starting for product: ${brief.id}`);

  try {
    const config = await loadConfig();
    const { pageSize, exportDpi } = config.agents.designer;

    const productDir = join(PRODUCTS_DIR, brief.id);
    await mkdir(productDir, { recursive: true });

    // Try AI-powered generation first, fall back to template engine
    let htmlPages: string[];
    let generationMethod: string;

    try {
      htmlPages = await generateDesignWithAI(brief);
      generationMethod = 'ai';
      logger.info(`Using AI-generated design for ${brief.id}`);
    } catch (aiError) {
      const aiMessage = aiError instanceof Error ? aiError.message : String(aiError);
      logger.warn(
        `AI design generation failed for ${brief.id}, falling back to template engine: ${aiMessage}`,
      );

      const templateName = selectTemplate(brief);
      logger.info(`Using template fallback: ${templateName}`);
      htmlPages = await generateProductHtml(brief, templateName);
      generationMethod = `template:${templateName}`;
    }

    // Write each HTML page to disk
    const htmlDir = join(productDir, 'html');
    await mkdir(htmlDir, { recursive: true });

    const htmlPaths: string[] = [];
    for (let i = 0; i < htmlPages.length; i++) {
      const htmlPath = join(htmlDir, `page-${String(i + 1).padStart(3, '0')}.html`);
      await writeFile(htmlPath, htmlPages[i], 'utf-8');
      htmlPaths.push(htmlPath);
    }

    // Create a combined HTML for PDF rendering
    const combinedHtml = htmlPages.join('\n<div style="page-break-after: always;"></div>\n');
    const combinedHtmlPath = join(productDir, 'combined.html');
    await writeFile(combinedHtmlPath, combinedHtml, 'utf-8');

    // Render PDF
    const pdfPath = join(productDir, `${brief.id}.pdf`);
    const renderResult = await renderPdf(combinedHtmlPath, pdfPath, {
      pageSize,
      dpi: exportDpi,
      margins: { top: 10, right: 10, bottom: 10, left: 10 },
    });

    const designResult: DesignResult = {
      htmlPages: htmlPaths,
      pdfPath: renderResult.outputPath,
      pageCount: renderResult.pageCount,
    };

    // Write design metadata
    const designMeta = {
      generationMethod,
      htmlPages: htmlPaths.length,
      pdfPath: designResult.pdfPath,
      pageCount: designResult.pageCount,
      fileSizeBytes: renderResult.fileSizeBytes,
      renderDuration: renderResult.duration,
    };
    await writeFile(
      join(productDir, 'design.json'),
      JSON.stringify(designMeta, null, 2),
      'utf-8'
    );

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'designer',
      action: 'design-complete',
      productId: brief.id,
      details: `${designResult.pageCount} pages rendered, method: ${generationMethod}`,
      duration,
      success: true,
    });

    logger.info(
      `Design complete for ${brief.id}: ${designResult.pageCount} pages, ${renderResult.fileSizeBytes} bytes, method: ${generationMethod}`,
    );

    return {
      success: true,
      data: designResult,
      duration,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Design agent failed for ${brief.id}: ${message}`);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'designer',
      action: 'design-failed',
      productId: brief.id,
      details: message,
      duration,
      success: false,
    });

    return {
      success: false,
      error: message,
      duration,
    };
  }
}
