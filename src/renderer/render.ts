import puppeteer from 'puppeteer';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import logger from '../utils/logger.js';

export interface RenderOptions {
  pageSize: 'A4' | 'Letter';
  dpi: number;
  margins: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export interface RenderResult {
  outputPath: string;
  pageCount: number;
  fileSizeBytes: number;
  duration: number;
}

const DEFAULT_OPTIONS: RenderOptions = {
  pageSize: 'A4',
  dpi: 300,
  margins: { top: 10, right: 10, bottom: 10, left: 10 },
};

const PAGE_DIMENSIONS: Record<string, { width: string; height: string }> = {
  A4: { width: '210mm', height: '297mm' },
  Letter: { width: '8.5in', height: '11in' },
};

export async function renderPdf(
  htmlPath: string,
  outputPath: string,
  options?: Partial<RenderOptions>
): Promise<RenderResult> {
  const opts: RenderOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    margins: { ...DEFAULT_OPTIONS.margins, ...options?.margins },
  };
  const resolvedHtml = resolve(htmlPath);
  const resolvedOutput = resolve(outputPath);
  const startTime = performance.now();

  logger.info(`Rendering PDF: ${resolvedHtml} -> ${resolvedOutput}`);

  let browser: puppeteer.Browser | null = null;

  try {
    const chromePath = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const page = await browser.newPage();

    const fileUrl = pathToFileURL(resolvedHtml).href;
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30_000 });

    await page.emulateMediaType('print');

    const dims = PAGE_DIMENSIONS[opts.pageSize] ?? PAGE_DIMENSIONS.A4;

    await page.pdf({
      path: resolvedOutput,
      width: dims.width,
      height: dims.height,
      printBackground: true,
      margin: {
        top: `${opts.margins.top}mm`,
        right: `${opts.margins.right}mm`,
        bottom: `${opts.margins.bottom}mm`,
        left: `${opts.margins.left}mm`,
      },
      preferCSSPageSize: true,
    });

    const fileInfo = await stat(resolvedOutput);

    if (fileInfo.size === 0) {
      throw new Error(`Rendered PDF is empty: ${resolvedOutput}`);
    }

    const pageCount = await getPageCount(page);
    const duration = Math.round(performance.now() - startTime);

    const result: RenderResult = {
      outputPath: resolvedOutput,
      pageCount,
      fileSizeBytes: fileInfo.size,
      duration,
    };

    logger.info(
      `PDF rendered: ${result.pageCount} pages, ${result.fileSizeBytes} bytes, ${result.duration}ms`
    );

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`PDF render failed: ${message}`);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function getPageCount(page: puppeteer.Page): Promise<number> {
  const count = await page.evaluate(() => {
    const pageBreaks = document.querySelectorAll('[data-page]');
    if (pageBreaks.length > 0) {
      return pageBreaks.length;
    }
    const body = document.body;
    const pageHeight = 297 * 3.7795275591; // A4 height in px at 96dpi
    return Math.max(1, Math.ceil(body.scrollHeight / pageHeight));
  });
  return count;
}

export default renderPdf;
