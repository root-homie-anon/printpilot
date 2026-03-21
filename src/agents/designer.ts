import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { AgentResult, ProductBrief, ProductFormat } from '../types/index.js';
import { loadConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { callClaude } from '../utils/claude.js';
import { logActivity } from '../tracker/activity-log.js';
import { generateProductHtml, getAvailableTemplates } from '../renderer/template-engine.js';
import { renderPdf } from '../renderer/render.js';
import { renderSpreadsheet, buildSpreadsheetPath } from '../renderer/spreadsheet.js';
import { renderGoogleSheet } from '../renderer/google-sheets.js';
import type { SheetSpec } from '../renderer/spreadsheet.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = join(STATE_DIR, 'products');
const DESIGN_SYSTEM_PATH = resolve(process.cwd(), 'shared/design-system.md');

export interface DesignResult {
  outputFormat: ProductFormat;
  htmlPages: string[];
  pdfPath: string;
  spreadsheetPath?: string;
  googleSheetsUrl?: string;
  googleSheetsId?: string;
  pageCount: number;
  sheetCount?: number;
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
  // Limit to 5 pages max per AI call to stay within token budget
  const pageCount = Math.min(brief.pageCount, 5);
  const sections = brief.sections.slice(0, pageCount);

  return `You are an expert Etsy printable product designer. Generate PREMIUM, SELLABLE HTML/CSS pages for a printable ${nicheLabel} product. This must look like a $5-10 product from a top Etsy seller with 100k+ sales.

## Product Brief
- Niche: ${nicheLabel}
- Target audience: ${brief.targetAudience}
- Pages to generate: ${pageCount}
- Sections (one per page): ${sections.join(', ')}
- Primary font: ${brief.styleGuide.primaryFont}
- Accent color: ${brief.styleGuide.accentColor}

## Design System
${designSystem}

## CRITICAL QUALITY REQUIREMENTS — Premium Etsy Seller Standard
- Dark header bar (#1E293B) with white title + colored accent badge on EVERY page
- Rich color-coded sections with background fills, NOT plain white
- Dashboard-style cards with box-shadow, colored top borders, rounded corners (8px)
- Alternating row colors in all tables (white / #F0F7FF)
- Fillable fields with dashed borders (1.5px dashed #CBD5E1) and subtle background
- Decorative elements: colored dots, progress bars, icon circles, category tags
- Color-coded categories (use greens, blues, reds, purples, ambers)
- Footer with branding accent line on every page
- Page dimensions: width 180mm, max-height 267mm, overflow hidden
- Font size 10px base, compact spacing to pack content
- EVERY page must be PACKED with useful, well-organized, niche-specific content
- NO empty space, NO generic placeholders — each section must have real structure
- Premium feel — professional dashboard layouts, not a homework assignment

## Page Structure
Each page is a standalone HTML document. Use this structure:
\`\`\`
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>{{title}} — [Section]</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 210mm; min-height: 297mm; font-family: ${brief.styleGuide.primaryFont}, sans-serif; font-size: 10px; color: #334155; background: #FFF; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  @page { size: A4 portrait; margin: 15mm; }
  .page { width: 180mm; min-height: 267mm; max-height: 267mm; overflow: hidden; display: flex; flex-direction: column; }
  .page-header { background: #1E293B; color: #FFF; padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
  .page-header h1 { font-size: 16px; font-weight: 800; }
  .header-badge { background: ${brief.styleGuide.accentColor}; color: #FFF; font-size: 8px; font-weight: 700; padding: 3px 10px; border-radius: 10px; text-transform: uppercase; letter-spacing: 1px; }
  .page-footer { margin-top: auto; padding-top: 6px; border-top: 1.5px solid #E2E8F0; font-size: 8px; color: #94A3B8; display: flex; justify-content: space-between; }
  /* ... section-specific styles ... */
</style></head>
<body><div class="page">
  <div class="page-header"><h1>[Section Title]</h1><div class="header-badge">[Section]</div></div>
  <!-- PACKED content here -->
  <div class="page-footer"><span>${nicheLabel}</span><span>Page X of ${pageCount}</span></div>
</div></body></html>
\`\`\`

## Output Format
Return EXACTLY ${pageCount} pages, each wrapped in <page> tags. One page per section:
${sections.map((s, i) => `Page ${i + 1}: "${s}"`).join('\n')}

Generate all ${pageCount} pages now. Make each page unique with section-specific content.`;
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

function buildSpreadsheetPrompt(brief: ProductBrief): string {
  const nicheLabel = brief.niche.replace(/-/g, ' ');

  return `You are a $280k Etsy spreadsheet seller. Design a PREMIUM ${nicheLabel} tracker that buyers pay $8-12 for.

## Brief
- Niche: ${nicheLabel}
- Audience: ${brief.targetAudience}
- Accent: ${brief.styleGuide.accentColor}

## EXACT TABS TO GENERATE (10 sheets):

### 1. "Dashboard" (sheetType: "dashboard")
The hero tab — buyers decide to purchase based on this. Include:
- 6 KPI columns: each a FORMULA referencing data sheets (totals, streaks, averages, progress %)
- 5 summary rows below with weekly aggregates
- Dashboard formulas use: COUNTA, SUMIF, COUNTIF, AVERAGE, MAX
- Example KPIs: Total Workouts, Current Streak, Avg Calories, Weight Change, Goal Progress %, Best Workout

### 2. "Workout Log" (sheetType: "data")
10 columns: Date, Day (dropdown Mon-Sun), Workout Type (dropdown: 25+ types like Strength-Upper, Strength-Lower, HIIT, Cardio-Running, Cardio-Cycling, Yoga-Flow, Pilates, Swimming, Boxing, CrossFit, Stretching, Walking, Hiking, Dance, Rock Climbing, Rowing, Jump Rope, Circuit Training, Martial Arts, Calisthenics, Stair Climber, Elliptical, Spin Class, Barre, TRX), Muscle Group (dropdown: Chest, Back, Shoulders, Arms, Legs, Core, Full Body, Glutes, Cardio), Duration (min), Exercises Done, Sets, Reps, Weight (lbs), Calories Burned (formula). Pre-fill 21 example rows (3 weeks of realistic workouts).

### 3. "Weight Tracker" (sheetType: "data")
8 columns: Date, Weight (lbs), Change from Last (formula: current-previous), Total Change (formula: current-start), Goal Weight (from Settings), Remaining (formula), Progress % (formula), Notes (dropdown: Normal, Cheat Day, Fasting, Post-Workout, Morning, Evening). Pre-fill 21 rows showing realistic downward trend (e.g., 185→178 over 3 weeks).

### 4. "Body Measurements" (sheetType: "data")
10 columns: Date, Chest (in), Waist, Hips, Right Arm, Left Arm, Right Thigh, Left Thigh, Neck, Total Change (formula: sum of all changes from first entry). Pre-fill 4 rows (monthly measurements).

### 5. "Calorie Tracker" (sheetType: "data")
10 columns: Date, Meal (dropdown: Breakfast, AM Snack, Lunch, PM Snack, Dinner, Post-Workout), Food Item, Serving Size, Calories, Protein (g), Carbs (g), Fat (g), Fiber (g), Daily Total (formula: SUM for that date). Pre-fill 14 rows (2 days of meals, 7 items per day).

### 6. "Meal Planner" (sheetType: "data")
9 columns: Day (dropdown Mon-Sun), Breakfast, AM Snack, Lunch, PM Snack, Dinner, Evening Snack, Total Calories (formula), Protein Total (formula). Pre-fill 7 rows (full week).

### 7. "Habit Tracker" (sheetType: "data")
10 columns: Date, Water (glasses, number), Sleep (hours), Steps (number), Workout Done (dropdown: Yes/No/Rest Day), Supplements (dropdown: Yes/No), Stretching (dropdown: Yes/No), Meal Prep (dropdown: Yes/No), Meditation (dropdown: Yes/No), Daily Score (formula: count of Yes values / total habits * 100). Pre-fill 14 rows.

### 8. "Exercise Database" (sheetType: "reference")
5 columns: Exercise Name, Muscle Group (dropdown), Category (dropdown: Compound/Isolation/Cardio/Flexibility), Equipment (dropdown: Barbell, Dumbbell, Machine, Cable, Bodyweight, Kettlebell, Resistance Band, None), Difficulty (dropdown: Beginner/Intermediate/Advanced). Pre-fill 50+ rows with real exercises (Bench Press, Squat, Deadlift, Pull-ups, Lunges, Plank, Bicep Curl, Tricep Extension, Lat Pulldown, Leg Press, Calf Raises, Shoulder Press, Face Pulls, Romanian Deadlift, Hip Thrust, Cable Flyes, etc.).

### 9. "Goals & Settings" (sheetType: "settings")
Two-column layout — Setting/Value:
- Name, Age, Height (in), Current Weight, Goal Weight, Activity Level (dropdown: Sedentary/Lightly Active/Active/Very Active)
- Weekly Workout Goal (number), Daily Calorie Target, Daily Protein Target, Daily Water Goal
- Start Date, Target Date, Measurement Frequency (dropdown: Weekly/Bi-Weekly/Monthly)
Pre-fill with realistic example values.

### 10. "Instructions" will be auto-generated — DO NOT include it.

## JSON Schema:
{"name":"string","sheetType":"dashboard|data|reference|settings","columns":[{"header":"string","key":"camelCase","width":15,"type":"text|number|date|formula|dropdown|currency","formula":"={ROW} for current row","dropdownValues":["..."],"numberFormat":"0%"}],"rows":[{"key":"value"}],"conditionalRules":[{"column":"key","type":"traffic-light","thresholds":{"green":80,"yellow":50}}]}

## CRITICAL RULES:
1. ALL thresholds must be NUMBERS (80, 50) — NEVER strings ("High")
2. Use {ROW} placeholder in formulas for the current row number
3. Cross-sheet refs: ='Sheet Name'!A1
4. Dropdown columns need 10-30 real values, never placeholders
5. Example rows must have REALISTIC data that tells a story (progressive overload, weight trending down)
6. Formula columns: BMI, % change, running averages, daily totals, streak counters
7. conditionalRules only on NUMBER columns — skip text columns

Return ONLY a JSON array of 9 sheet objects. No markdown, no commentary.`;
}

function parseSheetSpecs(response: string): SheetSpec[] {
  const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned) as SheetSpec[];

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('AI response contained no valid sheet specifications');
  }

  return parsed.map((sheet) => ({
    name: String(sheet.name ?? 'Sheet').slice(0, 31),
    sheetType: (['dashboard', 'data', 'reference', 'instructions', 'settings'].includes(
      String(sheet.sheetType ?? ''),
    ) ? String(sheet.sheetType) : 'data') as SheetSpec['sheetType'],
    columns: Array.isArray(sheet.columns)
      ? sheet.columns.map((col) => ({
          header: String(col.header ?? ''),
          key: String(col.key ?? ''),
          width: typeof col.width === 'number' ? col.width : 15,
          type: col.type,
          formula: col.formula ? String(col.formula) : undefined,
          dropdownValues: Array.isArray(col.dropdownValues) ? col.dropdownValues.map(String) : undefined,
          numberFormat: col.numberFormat ? String(col.numberFormat) : undefined,
        }))
      : [],
    rows: Array.isArray(sheet.rows) ? sheet.rows : [],
    mergedHeaders: Array.isArray(sheet.mergedHeaders) ? sheet.mergedHeaders : undefined,
    conditionalRules: Array.isArray(sheet.conditionalRules) ? sheet.conditionalRules : undefined,
    formatting: {
      alternatingRows: true,
      freezeHeader: true,
      autoFilter: sheet.sheetType !== 'dashboard',
      hideGridlines: sheet.sheetType === 'dashboard',
      protectSheet: sheet.sheetType === 'dashboard',
    },
  }));
}

async function generateSpreadsheetWithAI(brief: ProductBrief): Promise<SheetSpec[]> {
  const prompt = buildSpreadsheetPrompt(brief);

  logger.info(`Generating AI spreadsheet design for ${brief.id}, requesting 9 sheets`);

  const response = await callClaude(prompt, {
    systemPrompt: 'You are a $280k Etsy spreadsheet seller. Generate premium tracker templates with: 10 tabs, 50+ exercise database rows, 21 days of sample workout data, cross-sheet dashboard formulas, 25+ dropdown options per menu, conditional formatting with NUMERIC thresholds only. Return ONLY a valid JSON array of 9 sheet objects. No markdown fences. Use short camelCase keys.',
    maxTokens: 64000,
    temperature: 0.6,
  });

  const sheets = parseSheetSpecs(response);

  logger.info(
    `AI generated ${sheets.length} premium sheet specs for ${brief.id}`,
  );

  return sheets;
}

export async function generateDesignWithAI(brief: ProductBrief): Promise<string[]> {
  const designSystem = await loadDesignSystem();
  const prompt = buildDesignPrompt(brief, designSystem);

  logger.info(`Generating AI design for ${brief.id}, requesting ${brief.pageCount} pages`);

  const response = await callClaude(prompt, {
    systemPrompt: 'You are an elite Etsy printable product designer competing with top sellers (100k+ sales). Generate PREMIUM HTML/CSS pages with rich colors, dashboard-style layouts, cards, progress bars, and decorative elements. Every page must be packed with useful content. Always wrap each page in <page> tags. Never output anything outside of <page> tags.',
    maxTokens: 16384,
    temperature: 0.7,
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

function buildCombinedHtml(pages: string[]): string {
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/i;
  const bodyRegex = /<body[^>]*>([\s\S]*?)<\/body>/i;

  const styles = pages.map((p) => {
    const m = styleRegex.exec(p);
    return m ? m[1] : '';
  });
  const bodies = pages.map((p) => {
    const m = bodyRegex.exec(p);
    return m ? m[1].trim() : p;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
${styles.join('\n')}
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
</style>
</head>
<body>
${bodies.join('\n')}
</body>
</html>`;
}

async function runPdfDesign(
  brief: ProductBrief,
  productDir: string,
  pageSize: 'A4' | 'Letter',
  exportDpi: number,
): Promise<{ designResult: DesignResult; generationMethod: string; fileSizeBytes: number }> {
  let htmlPages: string[];
  let generationMethod: string;

  try {
    htmlPages = await generateDesignWithAI(brief);
    generationMethod = 'ai';
    logger.info(`Using AI-generated PDF design for ${brief.id}`);
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

  // Create combined HTML for PDF rendering
  const combinedHtml = buildCombinedHtml(htmlPages);
  const combinedHtmlPath = join(productDir, 'combined.html');
  await writeFile(combinedHtmlPath, combinedHtml, 'utf-8');

  // Render PDF
  const pdfPath = join(productDir, `${brief.id}.pdf`);
  const renderResult = await renderPdf(combinedHtmlPath, pdfPath, {
    pageSize,
    dpi: exportDpi,
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
  });

  return {
    designResult: {
      outputFormat: 'pdf',
      htmlPages: htmlPaths,
      pdfPath: renderResult.outputPath,
      pageCount: renderResult.pageCount,
    },
    generationMethod,
    fileSizeBytes: renderResult.fileSizeBytes,
  };
}

async function runSpreadsheetDesign(
  brief: ProductBrief,
  productDir: string,
): Promise<{ designResult: DesignResult; generationMethod: string; fileSizeBytes: number }> {
  const sheetSpecs = await generateSpreadsheetWithAI(brief);
  const generationMethod = 'ai-google-sheets';

  // Write sheet specs to disk for debugging
  await writeFile(
    join(productDir, 'sheet-specs.json'),
    JSON.stringify(sheetSpecs, null, 2),
    'utf-8',
  );

  // Create Google Sheet (primary output)
  const gsResult = await renderGoogleSheet(sheetSpecs, brief);

  // Also render Excel file as backup deliverable
  const xlsxPath = buildSpreadsheetPath(productDir, brief.id);
  const xlsxResult = await renderSpreadsheet(sheetSpecs, xlsxPath, brief);

  return {
    designResult: {
      outputFormat: 'spreadsheet',
      htmlPages: [],
      pdfPath: '',
      spreadsheetPath: xlsxResult.outputPath,
      googleSheetsUrl: gsResult.spreadsheetUrl,
      googleSheetsId: gsResult.spreadsheetId,
      pageCount: 0,
      sheetCount: gsResult.sheetCount,
    },
    generationMethod,
    fileSizeBytes: xlsxResult.fileSizeBytes,
  };
}

export async function runDesign(brief: ProductBrief): Promise<AgentResult<DesignResult>> {
  const startTime = performance.now();
  const outputFormat = brief.outputFormat ?? 'pdf';

  logger.info(`Design agent starting for product: ${brief.id}, format: ${outputFormat}`);

  try {
    const config = await loadConfig();
    const { pageSize, exportDpi } = config.agents.designer;

    const productDir = join(PRODUCTS_DIR, brief.id);
    await mkdir(productDir, { recursive: true });

    let designResult: DesignResult;
    let generationMethod: string;
    let fileSizeBytes: number;

    if (outputFormat === 'spreadsheet' || outputFormat === 'google-sheets') {
      const result = await runSpreadsheetDesign(brief, productDir);
      designResult = result.designResult;
      generationMethod = result.generationMethod;
      fileSizeBytes = result.fileSizeBytes;
    } else {
      // Default to PDF for 'pdf' and 'canva-template'
      const result = await runPdfDesign(brief, productDir, pageSize, exportDpi);
      designResult = result.designResult;
      generationMethod = result.generationMethod;
      fileSizeBytes = result.fileSizeBytes;
    }

    // Write design metadata
    const designMeta = {
      outputFormat,
      generationMethod,
      htmlPages: designResult.htmlPages.length,
      pdfPath: designResult.pdfPath || undefined,
      spreadsheetPath: designResult.spreadsheetPath || undefined,
      pageCount: designResult.pageCount,
      sheetCount: designResult.sheetCount,
      fileSizeBytes,
    };
    await writeFile(
      join(productDir, 'design.json'),
      JSON.stringify(designMeta, null, 2),
      'utf-8',
    );

    const duration = Math.round(performance.now() - startTime);
    const countLabel = outputFormat === 'spreadsheet' || outputFormat === 'google-sheets'
      ? `${designResult.sheetCount} sheets`
      : `${designResult.pageCount} pages`;

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'designer',
      action: 'design-complete',
      productId: brief.id,
      details: `${countLabel} rendered as ${outputFormat}, method: ${generationMethod}`,
      duration,
      success: true,
    });

    logger.info(
      `Design complete for ${brief.id}: ${countLabel}, ${fileSizeBytes} bytes, format: ${outputFormat}, method: ${generationMethod}`,
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
