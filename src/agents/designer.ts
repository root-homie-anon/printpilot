import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { AgentResult, ProductBrief } from '../types/index.js';
import { loadConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';
import { generateProductHtml, getAvailableTemplates } from '../renderer/template-engine.js';
import { renderPdf } from '../renderer/render.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = join(STATE_DIR, 'products');

export interface DesignResult {
  htmlPages: string[];
  pdfPath: string;
  pageCount: number;
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

    // Select template and generate HTML pages
    const templateName = selectTemplate(brief);
    logger.info(`Using template: ${templateName}`);

    const htmlPages = await generateProductHtml(brief, templateName);

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
      template: templateName,
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
      details: `${designResult.pageCount} pages rendered, template: ${templateName}`,
      duration,
      success: true,
    });

    logger.info(
      `Design complete for ${brief.id}: ${designResult.pageCount} pages, ${renderResult.fileSizeBytes} bytes`
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
