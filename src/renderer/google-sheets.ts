import { google, type sheets_v4 } from 'googleapis';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import logger from '../utils/logger.js';
import type { ProductBrief } from '../types/index.js';
import type { SheetSpec } from './spreadsheet.js';

const OAUTH_CLIENT_PATH = resolve(process.cwd(), '.credentials/google-oauth-client.json');
const OAUTH_TOKEN_PATH = resolve(process.cwd(), '.credentials/google-oauth-token.json');

export interface GoogleSheetsResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  sheetCount: number;
  duration: number;
}

// ── Auth ────────────────────────────────────────────────────────────

async function getAuthClient(): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const clientJson = JSON.parse(await readFile(OAUTH_CLIENT_PATH, 'utf-8'));
  const tokenJson = JSON.parse(await readFile(OAUTH_TOKEN_PATH, 'utf-8'));
  const { client_id, client_secret } = clientJson.installed;

  const auth = new google.auth.OAuth2(client_id, client_secret);
  auth.setCredentials(tokenJson);
  return auth;
}

// ── Color system ────────────────────────────────────────────────────

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

function hex(h: string): Rgb {
  const c = h.replace('#', '');
  return {
    red: parseInt(c.substring(0, 2), 16) / 255,
    green: parseInt(c.substring(2, 4), 16) / 255,
    blue: parseInt(c.substring(4, 6), 16) / 255,
  };
}

function darken(c: Rgb, n: number): Rgb {
  return { red: c.red * (1 - n), green: c.green * (1 - n), blue: c.blue * (1 - n) };
}

function lighten(c: Rgb, n: number): Rgb {
  return {
    red: Math.min(1, c.red + (1 - c.red) * n),
    green: Math.min(1, c.green + (1 - c.green) * n),
    blue: Math.min(1, c.blue + (1 - c.blue) * n),
  };
}

// Aesthetic pastel palette — matches top-selling Etsy templates
const WHITE: Rgb = { red: 1, green: 1, blue: 1 };
const CREAM: Rgb = hex('#FDF8F4');        // Warm off-white background
const TEXT: Rgb = hex('#434343');          // Soft gray body text (never pure black)
const TEXT_LIGHT: Rgb = hex('#888888');    // Muted labels
const TEXT_HEADER: Rgb = hex('#2D2D2D');  // Slightly darker for headers
const BORDER_SOFT: Rgb = hex('#E8E4E0');  // Barely-there warm gray border
const GREEN_BG: Rgb = hex('#D1FAE5');
const GREEN_TEXT: Rgb = hex('#065F46');
const YELLOW_BG: Rgb = hex('#FEF3C7');
const YELLOW_TEXT: Rgb = hex('#92400E');
const RED_BG: Rgb = hex('#FEE2E2');
const RED_TEXT: Rgb = hex('#991B1B');

// Aesthetic accent colors for KPI cards
const CARD_PINK: Rgb = hex('#FCDEF0');
const CARD_LAVENDER: Rgb = hex('#EDDBF4');
const CARD_MINT: Rgb = hex('#D6ECD2');
const CARD_PEACH: Rgb = hex('#FCE8D2');
const CARD_BLUE: Rgb = hex('#CFE2F3');
const CARD_YELLOW: Rgb = hex('#FFF2CC');
const CARD_COLORS: Rgb[] = [CARD_PINK, CARD_LAVENDER, CARD_MINT, CARD_PEACH, CARD_BLUE, CARD_YELLOW];

interface Palette {
  primary: Rgb;
  primaryDark: Rgb;
  primaryMedium: Rgb;
  primaryLight: Rgb;
  primaryVeryLight: Rgb;
}

function makePalette(accentHex: string): Palette {
  const primary = hex(accentHex || '#C9A4D8'); // Default: soft lavender
  return {
    primary,
    primaryDark: darken(primary, 0.35),
    primaryMedium: darken(primary, 0.15),
    primaryLight: lighten(primary, 0.4),
    primaryVeryLight: lighten(primary, 0.85),
  };
}

// ── Border helper (minimal, soft) ───────────────────────────────────

function softBorder(color?: Rgb): sheets_v4.Schema$Border {
  return { style: 'SOLID', color: color ?? BORDER_SOFT, width: 1 };
}

// ── Cell builders ───────────────────────────────────────────────────

interface CellOpts {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  bg?: Rgb;
  fg?: Rgb;
  align?: string;
  vAlign?: string;
  wrap?: boolean;
  numFmt?: string;
  formula?: string;
  borders?: sheets_v4.Schema$Borders;
}

function cell(value: string | number | null | undefined, o: CellOpts = {}): sheets_v4.Schema$CellData {
  const c: sheets_v4.Schema$CellData = {
    userEnteredFormat: {
      backgroundColor: o.bg ?? WHITE,
      textFormat: {
        bold: o.bold ?? false,
        italic: o.italic ?? false,
        fontSize: o.fontSize ?? 10,
        foregroundColor: o.fg ?? TEXT,
        fontFamily: 'Poppins',
      },
      horizontalAlignment: o.align ?? 'LEFT',
      verticalAlignment: o.vAlign ?? 'MIDDLE',
      wrapStrategy: o.wrap ? 'WRAP' : 'CLIP',
      padding: { top: 4, bottom: 4, left: 8, right: 8 },
    },
  };

  if (o.borders) c.userEnteredFormat!.borders = o.borders;
  if (o.numFmt) c.userEnteredFormat!.numberFormat = { type: 'NUMBER', pattern: o.numFmt };

  if (o.formula) {
    c.userEnteredValue = { formulaValue: o.formula };
  } else if (typeof value === 'number') {
    c.userEnteredValue = { numberValue: value };
  } else if (value !== null && value !== undefined && value !== '') {
    c.userEnteredValue = { stringValue: String(value) };
  }

  return c;
}

function emptyBg(bg: Rgb): sheets_v4.Schema$CellData {
  return { userEnteredFormat: { backgroundColor: bg } };
}

function row(cells: sheets_v4.Schema$CellData[]): sheets_v4.Schema$RowData {
  return { values: cells };
}

// ── Dashboard builder ───────────────────────────────────────────────

function buildDashboard(
  spec: SheetSpec,
  pal: Palette,
  label: string,
  totalCols: number,
  allSheets?: SheetSpec[],
  dashIdx?: number,
): sheets_v4.Schema$RowData[] {
  const rows: sheets_v4.Schema$RowData[] = [];
  const fill = (bg: Rgb, n: number): sheets_v4.Schema$CellData[] => Array(n).fill(emptyBg(bg));

  // ── Row 0-1: Soft pastel title banner ──
  rows.push(row([
    cell(`📊  ${label}`, { bold: true, fontSize: 26, bg: pal.primaryLight, fg: TEXT_HEADER, align: 'CENTER' }),
    ...fill(pal.primaryLight, totalCols - 1),
  ]));
  rows.push(row(fill(pal.primaryLight, totalCols)));

  // ── Row 2: Accent subtitle ──
  rows.push(row([
    cell(`Your Complete ${label} — Track · Measure · Improve`, {
      bold: true, fontSize: 12, bg: pal.primary, fg: WHITE, align: 'CENTER',
    }),
    ...fill(pal.primary, totalCols - 1),
  ]));

  // ── Row 3: Thin accent line ──
  rows.push(row(fill(pal.primaryDark, totalCols)));

  // ── Row 4: Spacer ──
  rows.push(row(fill(CREAM, totalCols)));

  // ── Row 5: Section header "KEY METRICS" ──
  rows.push(row([
    cell('⚡  KEY METRICS', { bold: true, fontSize: 14, bg: CREAM, fg: TEXT_HEADER, align: 'LEFT',
      borders: { bottom: softBorder(pal.primary) },
    }),
    ...Array(totalCols - 1).fill(cell('', { bg: CREAM,
      borders: { bottom: softBorder(pal.primary) },
    })),
  ]));

  // ── KPI Cards: Each column gets a pastel card ──
  // Label row
  const kpiLabelCells = spec.columns.map((col, ci) =>
    cell(col.header.toUpperCase(), {
      bold: true, fontSize: 9, bg: CARD_COLORS[ci % CARD_COLORS.length], fg: TEXT_LIGHT, align: 'CENTER',
      borders: { bottom: softBorder() },
    }),
  );
  // Pad to totalCols
  while (kpiLabelCells.length < totalCols) kpiLabelCells.push(emptyBg(CREAM));
  rows.push(row(kpiLabelCells));

  // Value row (large numbers on pastel cards)
  const kpiRow = spec.rows[0] || {};
  const kpiValueCells = spec.columns.map((col, ci) => {
    const cardBg = CARD_COLORS[ci % CARD_COLORS.length];
    const opts: CellOpts = {
      bold: true, fontSize: 28, bg: cardBg, fg: TEXT_HEADER, align: 'CENTER',
      borders: { bottom: softBorder() },
    };
    if (col.type === 'formula' && col.formula) {
      return cell(null, { ...opts, formula: col.formula.replace(/\{ROW\}/g, '8') });
    }
    return cell(kpiRow[col.key] ?? '—', opts);
  });
  while (kpiValueCells.length < totalCols) kpiValueCells.push(emptyBg(CREAM));
  rows.push(row(kpiValueCells));

  // ── Spacer ──
  rows.push(row(fill(CREAM, totalCols)));

  // ── Progress summary table ──
  if (spec.rows.length > 1) {
    rows.push(row([
      cell('📈  PROGRESS SUMMARY', { bold: true, fontSize: 14, bg: CREAM, fg: TEXT_HEADER, align: 'LEFT',
        borders: { bottom: softBorder(pal.primary) },
      }),
      ...Array(totalCols - 1).fill(cell('', { bg: CREAM,
        borders: { bottom: softBorder(pal.primary) },
      })),
    ]));

    // Table headers — soft pastel instead of dark
    const headerCells = spec.columns.map((c) =>
      cell(c.header, {
        bold: true, fontSize: 11, bg: pal.primaryLight, fg: TEXT_HEADER, align: 'CENTER',
        borders: { bottom: softBorder(pal.primary), right: softBorder() },
      }),
    );
    while (headerCells.length < totalCols) headerCells.push(emptyBg(pal.primaryLight));
    rows.push(row(headerCells));

    // Data rows with soft alternating
    for (let i = 1; i < spec.rows.length; i++) {
      const rd = spec.rows[i];
      const isAlt = i % 2 === 0;
      const bg = isAlt ? pal.primaryVeryLight : WHITE;
      const dataRowNum = i + 12; // approximate row offset

      const dataCells = spec.columns.map((col) => {
        const cellOpts: CellOpts = {
          fontSize: 11, bg, align: 'CENTER',
          borders: { bottom: softBorder(), right: softBorder() },
        };
        if (col.type === 'formula' && col.formula) {
          return cell(null, { ...cellOpts, formula: col.formula.replace(/\{ROW\}/g, String(dataRowNum)) });
        }
        return cell(rd[col.key] ?? '', cellOpts);
      });
      while (dataCells.length < totalCols) dataCells.push(emptyBg(bg));
      rows.push(row(dataCells));
    }
  }

  // ── Progress bars section ──
  rows.push(row(fill(CREAM, totalCols)));
  rows.push(row([
    cell('🎯  GOAL PROGRESS', { bold: true, fontSize: 14, bg: CREAM, fg: TEXT_HEADER, align: 'LEFT',
      borders: { bottom: softBorder(pal.primary) },
    }),
    ...Array(totalCols - 1).fill(cell('', { bg: CREAM,
      borders: { bottom: softBorder(pal.primary) },
    })),
  ]));

  // Progress bar rows using SPARKLINE bar charts
  const progressItems = [
    ['Weight Loss', `=SPARKLINE({ABS(IFERROR('Weight Tracker'!D2,0)),ABS(IFERROR('Goals & Settings'!B5-'Goals & Settings'!B4,10))},{"charttype","bar";"color1","#${rgbToHex(pal.primary)}";"color2","#F0ECE8";"max",ABS(IFERROR('Goals & Settings'!B5-'Goals & Settings'!B4,10))})`],
    ['Workout Goal', `=SPARKLINE({IFERROR(COUNTA('Workout Log'!A4:A24),0),IFERROR('Goals & Settings'!B8*4,20)},{"charttype","bar";"color1","#86EFAC";"color2","#F0ECE8"})`],
    ['Calorie Target', `=SPARKLINE({IFERROR(AVERAGE('Calorie Tracker'!E4:E24),0),IFERROR('Goals & Settings'!B9,2000)},{"charttype","bar";"color1","#FCD34D";"color2","#F0ECE8"})`],
    ['Habit Score', `=SPARKLINE({IFERROR(AVERAGE('Habit Tracker'!J4:J17),0),100},{"charttype","bar";"color1","#C4B5FD";"color2","#F0ECE8"})`],
  ];

  for (const [label, formula] of progressItems) {
    const cells: sheets_v4.Schema$CellData[] = [
      cell(label, { bold: true, fontSize: 11, fg: TEXT, bg: WHITE, align: 'RIGHT' }),
      cell(null, { bg: WHITE, formula }),
    ];
    // Fill rest with empty white cells
    while (cells.length < totalCols) cells.push(emptyBg(WHITE));
    rows.push(row(cells));
  }

  // ── Sparkline trends section ──
  rows.push(row(fill(CREAM, totalCols)));
  if (allSheets && dashIdx !== undefined) {
    const sparkRows = addSparklinesToDashboard(allSheets, dashIdx, totalCols, pal);
    rows.push(...sparkRows);
  }

  // ── Spacer for charts (charts overlay on top) ──
  for (let i = 0; i < 20; i++) {
    rows.push(row(fill(CREAM, totalCols)));
  }

  // ── Footer ──
  rows.push(row(fill(CREAM, totalCols)));
  rows.push(row([
    cell('💡 This dashboard auto-updates as you enter data in the other tabs. Do not edit formula cells.', {
      italic: true, fontSize: 10, bg: CREAM, fg: TEXT_LIGHT, align: 'CENTER', wrap: true,
    }),
    ...fill(CREAM, totalCols - 1),
  ]));

  return rows;
}

// ── Data sheet builder ──────────────────────────────────────────────

function buildDataSheet(
  spec: SheetSpec,
  pal: Palette,
  label: string,
): sheets_v4.Schema$RowData[] {
  const rows: sheets_v4.Schema$RowData[] = [];
  const cols = spec.columns.length;
  const fill = (bg: Rgb): sheets_v4.Schema$CellData[] => Array(cols).fill(emptyBg(bg));

  // ── Row 0: Soft pastel title ──
  rows.push(row([
    cell(`  ${spec.name}`, {
      bold: true, fontSize: 16, bg: pal.primaryLight, fg: TEXT_HEADER,
      borders: { bottom: softBorder(pal.primary) },
    }),
    ...Array(cols - 1).fill(cell('', { bg: pal.primaryLight, borders: { bottom: softBorder(pal.primary) } })),
  ]));

  // ── Row 1: Accent bar with label ──
  rows.push(row([
    cell(`  ${label}`, { bold: true, fontSize: 10, bg: pal.primary, fg: WHITE }),
    ...Array(cols - 1).fill(emptyBg(pal.primary)),
  ]));

  // ── Row 2: Column headers — light pastel bg ──
  rows.push(row(
    spec.columns.map((c) =>
      cell(c.header, {
        bold: true, fontSize: 11, bg: pal.primaryVeryLight, fg: TEXT_HEADER, align: 'CENTER', wrap: true,
        borders: {
          bottom: softBorder(pal.primary),
          right: softBorder(),
        },
      }),
    ),
  ));

  // ── Example data rows ──
  for (let i = 0; i < spec.rows.length; i++) {
    const rd = spec.rows[i];
    const isAlt = i % 2 === 1;
    const bg = isAlt ? pal.primaryVeryLight : WHITE;
    const rowNum = i + 4;

    rows.push(row(
      spec.columns.map((col) => {
        const o: CellOpts = {
          fontSize: 10, bg, wrap: true,
          borders: { bottom: softBorder(), right: softBorder() },
        };
        if (col.type === 'formula' && col.formula) {
          const f = col.formula
            .replace(/\{ROW\}/g, String(rowNum))
            .replace(/\{ROW-1\}/g, String(rowNum - 1));
          return cell(null, { ...o, formula: f });
        }
        if (col.type === 'number' || col.type === 'currency') {
          const val = rd[col.key];
          const num = Number(val);
          if (!isNaN(num) && val !== '' && val !== null && val !== undefined) {
            return cell(num, o);
          }
        }
        return cell(rd[col.key] ?? '', o);
      }),
    ));
  }

  // ── Empty input rows (extend to 50 total) ──
  const emptyRowCount = Math.max(50 - spec.rows.length, 20);
  for (let i = 0; i < emptyRowCount; i++) {
    const isAlt = (spec.rows.length + i) % 2 === 1;
    const bg = isAlt ? pal.primaryVeryLight : WHITE;
    const rowNum = spec.rows.length + i + 4;

    rows.push(row(
      spec.columns.map((col) => {
        const o: CellOpts = {
          bg,
          borders: { bottom: softBorder(), right: softBorder() },
        };
        if (col.type === 'formula' && col.formula) {
          const f = col.formula
            .replace(/\{ROW\}/g, String(rowNum))
            .replace(/\{ROW-1\}/g, String(rowNum - 1));
          return cell(null, { ...o, formula: f });
        }
        return cell('', o);
      }),
    ));
  }

  return rows;
}

// ── Instructions builder ────────────────────────────────────────────

function buildInstructions(
  pal: Palette,
  label: string,
  sheetNames: string[],
): sheets_v4.Schema$RowData[] {
  const rows: sheets_v4.Schema$RowData[] = [];

  // Title — soft pastel
  rows.push(row([
    emptyBg(pal.primaryLight),
    cell(`📋  How to Use Your ${label}`, { bold: true, fontSize: 22, bg: pal.primaryLight, fg: TEXT_HEADER, align: 'CENTER' }),
    emptyBg(pal.primaryLight),
  ]));
  rows.push(row([emptyBg(pal.primaryLight), emptyBg(pal.primaryLight), emptyBg(pal.primaryLight)]));

  // Subtitle
  rows.push(row([
    emptyBg(pal.primary),
    cell('Thank you for your purchase! Follow these steps to get started:', {
      bold: true, fontSize: 12, bg: pal.primary, fg: WHITE, align: 'CENTER',
    }),
    emptyBg(pal.primary),
  ]));

  rows.push(row([emptyBg(CREAM), emptyBg(CREAM), emptyBg(CREAM)]));

  const steps: [string, string][] = [
    ['🚀 Getting Started', 'Click "File → Make a copy" to create your own editable version. This spreadsheet works perfectly in Google Sheets, Microsoft Excel, and Apple Numbers.'],
    ['📑 Navigation', `Use the tabs at the bottom to navigate between sheets: ${sheetNames.join(', ')}. Start with the Dashboard for your overview.`],
    ['✏️ Entering Data', 'Click any cell in the data rows to start typing. Look for dropdown arrows (▼) — these have pre-set options to choose from. Colored header rows are labels; enter your data in the white rows below.'],
    ['🔢 Auto-Calculations', 'Formula columns update automatically as you enter data. DO NOT edit cells that show formulas — they calculate totals, averages, and progress for you. The Dashboard tab pulls from all other sheets.'],
    ['🎨 Customization', 'Add more rows by right-clicking and selecting "Insert row below". You can modify dropdown lists via Data → Data Validation. Formulas extend automatically.'],
    ['⭐ Pro Tips', 'Update consistently for accurate tracking. Bookmark this sheet for quick access. Use the Dashboard tab as your daily check-in. If you have questions, refer back to this tab!'],
  ];

  for (let i = 0; i < steps.length; i++) {
    const [title, desc] = steps[i];
    // Step number + title
    rows.push(row([
      cell(String(i + 1), {
        bold: true, fontSize: 18, bg: pal.primary, fg: WHITE, align: 'CENTER',
        borders: {
          top: softBorder(pal.primary), bottom: softBorder(pal.primary),
          left: softBorder(pal.primary), right: softBorder(pal.primary),
        },
      }),
      cell(title, { bold: true, fontSize: 14, bg: WHITE, fg: pal.primaryDark }),
      emptyBg(WHITE),
    ]));
    // Description
    rows.push(row([
      emptyBg(WHITE),
      cell(desc, { fontSize: 11, fg: TEXT, wrap: true, bg: WHITE }),
      emptyBg(WHITE),
    ]));
    // Spacer
    rows.push(row([emptyBg(CREAM), emptyBg(CREAM), emptyBg(CREAM)]));
  }

  // Footer
  rows.push(row([emptyBg(CREAM), emptyBg(CREAM), emptyBg(CREAM)]));
  rows.push(row([
    emptyBg(CREAM),
    cell('Made with ❤️ by PrintPilot  •  Need help? Check our Etsy shop FAQ', {
      italic: true, fontSize: 10, bg: CREAM, fg: TEXT_LIGHT, align: 'CENTER',
    }),
    emptyBg(CREAM),
  ]));

  return rows;
}

// ── Conditional formats ─────────────────────────────────────────────

function buildConditionalFormats(spec: SheetSpec, sheetId: number): sheets_v4.Schema$ConditionalFormatRule[] {
  if (!spec.conditionalRules) return [];
  const rules: sheets_v4.Schema$ConditionalFormatRule[] = [];

  for (const rule of spec.conditionalRules) {
    const colIdx = spec.columns.findIndex((c) => c.key === rule.column);
    if (colIdx < 0) continue;

    const range: sheets_v4.Schema$GridRange = {
      sheetId,
      startRowIndex: 3,
      endRowIndex: 100,
      startColumnIndex: colIdx,
      endColumnIndex: colIdx + 1,
    };

    if (rule.type === 'traffic-light' && rule.thresholds) {
      const greenVal = Number(rule.thresholds.green);
      const yellowVal = Number(rule.thresholds.yellow);
      if (isNaN(greenVal) || isNaN(yellowVal)) continue;

      // Green
      rules.push({
        ranges: [range],
        booleanRule: {
          condition: { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: String(greenVal) }] },
          format: { backgroundColor: GREEN_BG, textFormat: { foregroundColor: GREEN_TEXT, bold: true } },
        },
      });
      // Yellow
      rules.push({
        ranges: [range],
        booleanRule: {
          condition: { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: String(yellowVal) }] },
          format: { backgroundColor: YELLOW_BG, textFormat: { foregroundColor: YELLOW_TEXT, bold: true } },
        },
      });
      // Red
      rules.push({
        ranges: [range],
        booleanRule: {
          condition: { type: 'NUMBER_LESS', values: [{ userEnteredValue: String(yellowVal) }] },
          format: { backgroundColor: RED_BG, textFormat: { foregroundColor: RED_TEXT, bold: true } },
        },
      });
    }
  }

  return rules;
}

// ── Chart builders ──────────────────────────────────────────────────

function buildChartRequests(
  sheets: SheetSpec[],
  pal: Palette,
): sheets_v4.Schema$Request[] {
  const reqs: sheets_v4.Schema$Request[] = [];
  let chartId = 100;

  // Find the dashboard sheet and data sheets for chart references
  const dashIdx = sheets.findIndex((s) => (s.sheetType ?? 'data') === 'dashboard');
  if (dashIdx < 0) return reqs;

  const dashSpec = sheets[dashIdx];
  const totalCols = Math.max(dashSpec.columns.length, 6);

  // Find data sheets that have numeric columns suitable for charts
  for (let idx = 0; idx < sheets.length; idx++) {
    const spec = sheets[idx];
    if ((spec.sheetType ?? 'data') === 'dashboard') continue;

    // Find a good dropdown column (categories) and numeric column (values) for a pie/bar chart
    const catCol = spec.columns.findIndex((c) => c.type === 'dropdown');
    const numCols = spec.columns
      .map((c, i) => ({ col: c, idx: i }))
      .filter((x) => x.col.type === 'number' || x.col.type === 'formula' || x.col.type === 'currency');

    if (catCol >= 0 && numCols.length > 0) {
      const numCol = numCols[0];
      const dataRows = Math.max(spec.rows.length, 7);

      // Add a pie chart on the dashboard
      reqs.push({
        addChart: {
          chart: {
            chartId: chartId++,
            position: {
              overlayPosition: {
                anchorCell: { sheetId: dashIdx, rowIndex: 10, columnIndex: 0 },
                widthPixels: totalCols * 80,
                heightPixels: 300,
              },
            },
            spec: {
              title: `${spec.name} Breakdown`,
              titleTextFormat: { bold: true, fontSize: 12, foregroundColor: TEXT_HEADER },
              pieChart: {
                legendPosition: 'RIGHT_LEGEND',
                domain: {
                  sourceRange: {
                    sources: [{
                      sheetId: idx,
                      startRowIndex: 2,
                      endRowIndex: 3 + dataRows,
                      startColumnIndex: catCol,
                      endColumnIndex: catCol + 1,
                    }],
                  },
                },
                series: {
                  sourceRange: {
                    sources: [{
                      sheetId: idx,
                      startRowIndex: 2,
                      endRowIndex: 3 + dataRows,
                      startColumnIndex: numCol.idx,
                      endColumnIndex: numCol.idx + 1,
                    }],
                  },
                },
                pieHole: 0.4, // Donut chart
              },
              backgroundColor: WHITE,
            },
          },
        },
      });

          break;
    }
  }

  // Add a line chart for weight/progress tracking (find a sheet with date + number columns)
  for (let idx = 0; idx < sheets.length; idx++) {
    const spec = sheets[idx];
    if ((spec.sheetType ?? 'data') === 'dashboard') continue;
    const lowerName = spec.name.toLowerCase();
    if (!lowerName.includes('weight') && !lowerName.includes('progress') && !lowerName.includes('measurement')) continue;

    const dateCol = spec.columns.findIndex((c) => c.type === 'date');
    const numCol = spec.columns.findIndex((c) => c.type === 'number' || c.type === 'formula');
    if (dateCol < 0 || numCol < 0) continue;

    const dataRows = Math.max(spec.rows.length, 7);
    reqs.push({
      addChart: {
        chart: {
          chartId: chartId++,
          position: {
            overlayPosition: {
              anchorCell: { sheetId: dashIdx, rowIndex: 30, columnIndex: 0 },
              widthPixels: totalCols * 80,
              heightPixels: 280,
            },
          },
          spec: {
            title: `${spec.name} Trend`,
            titleTextFormat: { bold: true, fontSize: 12, foregroundColor: TEXT_HEADER },
            basicChart: {
              chartType: 'LINE',
              legendPosition: 'BOTTOM_LEGEND',
              lineSmoothing: true,
              axis: [
                { position: 'BOTTOM_AXIS', title: 'Date' },
                { position: 'LEFT_AXIS', title: spec.columns[numCol]?.header ?? 'Value' },
              ],
              domains: [{
                domain: {
                  sourceRange: {
                    sources: [{
                      sheetId: idx,
                      startRowIndex: 2,
                      endRowIndex: 3 + dataRows,
                      startColumnIndex: dateCol,
                      endColumnIndex: dateCol + 1,
                    }],
                  },
                },
              }],
              series: [{
                series: {
                  sourceRange: {
                    sources: [{
                      sheetId: idx,
                      startRowIndex: 2,
                      endRowIndex: 3 + dataRows,
                      startColumnIndex: numCol,
                      endColumnIndex: numCol + 1,
                    }],
                  },
                },
                targetAxis: 'LEFT_AXIS',
                color: pal.primary,
                lineStyle: { width: 3, type: 'SOLID' },
              }],
              headerCount: 1,
            },
            backgroundColor: WHITE,
          },
        },
      },
    });
    break;
  }

  // Add a bar chart from the second suitable data sheet
  let barChartAdded = false;
  for (let idx = 0; idx < sheets.length && !barChartAdded; idx++) {
    const spec = sheets[idx];
    if ((spec.sheetType ?? 'data') === 'dashboard') continue;

    const numCols = spec.columns
      .map((c, i) => ({ col: c, idx: i }))
      .filter((x) => x.col.type === 'number' || x.col.type === 'currency');

    if (numCols.length >= 2) {
      const dataRows = Math.max(spec.rows.length, 7);

      reqs.push({
        addChart: {
          chart: {
            chartId: chartId++,
            position: {
              overlayPosition: {
                anchorCell: { sheetId: idx, rowIndex: 3 + dataRows + 2, columnIndex: 0 },
                widthPixels: spec.columns.length * 100,
                heightPixels: 280,
              },
            },
            spec: {
              title: `${spec.name} Overview`,
              titleTextFormat: { bold: true, fontSize: 11, foregroundColor: TEXT_HEADER },
              basicChart: {
                chartType: 'COLUMN',
                legendPosition: 'BOTTOM_LEGEND',
                axis: [
                  { position: 'BOTTOM_AXIS', title: spec.columns[0]?.header ?? '' },
                  { position: 'LEFT_AXIS', title: numCols[0].col.header },
                ],
                domains: [{
                  domain: {
                    sourceRange: {
                      sources: [{
                        sheetId: idx,
                        startRowIndex: 2,
                        endRowIndex: 3 + dataRows,
                        startColumnIndex: 0,
                        endColumnIndex: 1,
                      }],
                    },
                  },
                }],
                series: numCols.slice(0, 3).map((nc) => ({
                  series: {
                    sourceRange: {
                      sources: [{
                        sheetId: idx,
                        startRowIndex: 2,
                        endRowIndex: 3 + dataRows,
                        startColumnIndex: nc.idx,
                        endColumnIndex: nc.idx + 1,
                      }],
                    },
                  },
                  targetAxis: 'LEFT_AXIS' as const,
                  color: pal.primary,
                })),
                headerCount: 1,
              },
              backgroundColor: WHITE,
            },
          },
        },
      });
      barChartAdded = true;
    }
  }

  return reqs;
}

// ── Sparkline formulas for dashboard ────────────────────────────────

function addSparklinesToDashboard(
  sheets: SheetSpec[],
  dashIdx: number,
  totalCols: number,
  pal: Palette,
): sheets_v4.Schema$RowData[] {
  const sparkRows: sheets_v4.Schema$RowData[] = [];

  // Section header
  sparkRows.push(row([
    cell('📈  TRENDS', {
      bold: true, fontSize: 14, bg: CREAM, fg: TEXT_HEADER, align: 'LEFT',
      borders: { bottom: softBorder(pal.primary) },
    }),
    ...Array(totalCols - 1).fill(cell('', { bg: CREAM,
      borders: { bottom: softBorder(pal.primary) },
    })),
  ]));

  // Find data sheets with numeric columns for sparklines
  let sparkCount = 0;
  for (let idx = 0; idx < sheets.length && sparkCount < 4; idx++) {
    const spec = sheets[idx];
    if ((spec.sheetType ?? 'data') === 'dashboard') continue;

    const numCols = spec.columns.filter((c) => c.type === 'number' || c.type === 'formula' || c.type === 'currency');
    if (numCols.length === 0) continue;

    const firstNumCol = spec.columns.indexOf(numCols[0]);
    const colLetter = String.fromCharCode(65 + firstNumCol);
    const sheetName = spec.name.replace(/'/g, "''");

    // Label + sparkline cell
    const cells: sheets_v4.Schema$CellData[] = [
      cell(`${spec.name}`, { bold: true, fontSize: 11, fg: TEXT, bg: WHITE }),
      cell(null, {
        bg: WHITE,
        formula: `=SPARKLINE('${sheetName}'!${colLetter}4:${colLetter}30,{"charttype","line";"color","#${rgbToHex(pal.primary)}";"linewidth",2})`,
      }),
    ];
    // Fill remaining cols
    while (cells.length < totalCols) cells.push(emptyBg(WHITE));
    sparkRows.push(row(cells));

    sparkCount++;
  }

  if (sparkCount === 0) return []; // No sparklines possible
  return sparkRows;
}

function rgbToHex(c: Rgb): string {
  const r = Math.round(c.red * 255).toString(16).padStart(2, '0');
  const g = Math.round(c.green * 255).toString(16).padStart(2, '0');
  const b = Math.round(c.blue * 255).toString(16).padStart(2, '0');
  return `${r}${g}${b}`;
}

// ── batchUpdate requests builder ────────────────────────────────────

function buildBatchRequests(
  sheets: SheetSpec[],
  instrIdx: number,
  pal: Palette,
): sheets_v4.Schema$Request[] {
  const reqs: sheets_v4.Schema$Request[] = [];

  for (let idx = 0; idx < sheets.length; idx++) {
    const spec = sheets[idx];
    const sheetType = spec.sheetType ?? 'data';
    const totalCols = Math.max(spec.columns.length, 6);

    if (sheetType === 'dashboard') {
      // Merge title (rows 0-1)
      reqs.push({ mergeCells: { range: { sheetId: idx, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: totalCols }, mergeType: 'MERGE_ALL' } });
      // Merge subtitle (row 2)
      reqs.push({ mergeCells: { range: { sheetId: idx, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: totalCols }, mergeType: 'MERGE_ALL' } });
      // Merge accent line (row 3)
      reqs.push({ mergeCells: { range: { sheetId: idx, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: totalCols }, mergeType: 'MERGE_ALL' } });
      // Merge section header (row 5)
      reqs.push({ mergeCells: { range: { sheetId: idx, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: totalCols }, mergeType: 'MERGE_ALL' } });

      // Merge progress summary header if exists (row 10)
      if (spec.rows.length > 1) {
        reqs.push({ mergeCells: { range: { sheetId: idx, startRowIndex: 10, endRowIndex: 11, startColumnIndex: 0, endColumnIndex: totalCols }, mergeType: 'MERGE_ALL' } });
      }

      // Footer merge (last 2 rows)
      const footerStart = 10 + (spec.rows.length > 1 ? spec.rows.length + 2 : 0);
      reqs.push({ mergeCells: { range: { sheetId: idx, startRowIndex: footerStart, endRowIndex: footerStart + 1, startColumnIndex: 0, endColumnIndex: totalCols }, mergeType: 'MERGE_ALL' } });

      // Hide gridlines
      reqs.push({
        updateSheetProperties: {
          properties: { sheetId: idx, gridProperties: { hideGridlines: true } },
          fields: 'gridProperties.hideGridlines',
        },
      });

      // Row heights: title=60, subtitle=35, accent line=6, spacer=20, section header=40, kpi label=30, kpi value=70
      reqs.push({ updateDimensionProperties: { range: { sheetId: idx, dimension: 'ROWS', startIndex: 0, endIndex: 2 }, properties: { pixelSize: 40 }, fields: 'pixelSize' } });
      reqs.push({ updateDimensionProperties: { range: { sheetId: idx, dimension: 'ROWS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 35 }, fields: 'pixelSize' } });
      reqs.push({ updateDimensionProperties: { range: { sheetId: idx, dimension: 'ROWS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 6 }, fields: 'pixelSize' } });
      reqs.push({ updateDimensionProperties: { range: { sheetId: idx, dimension: 'ROWS', startIndex: 5, endIndex: 6 }, properties: { pixelSize: 40 }, fields: 'pixelSize' } });
      reqs.push({ updateDimensionProperties: { range: { sheetId: idx, dimension: 'ROWS', startIndex: 6, endIndex: 7 }, properties: { pixelSize: 30 }, fields: 'pixelSize' } });
      reqs.push({ updateDimensionProperties: { range: { sheetId: idx, dimension: 'ROWS', startIndex: 7, endIndex: 8 }, properties: { pixelSize: 70 }, fields: 'pixelSize' } });

      // Column widths for dashboard
      for (let c = 0; c < totalCols; c++) {
        const w = c < spec.columns.length ? Math.max((spec.columns[c].width ?? 20) * 10, 160) : 160;
        reqs.push({
          updateDimensionProperties: {
            range: { sheetId: idx, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
            properties: { pixelSize: w },
            fields: 'pixelSize',
          },
        });
      }
    } else {
      // Data sheet merges: title (row 0), accent bar (row 1)
      reqs.push({ mergeCells: { range: { sheetId: idx, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: totalCols }, mergeType: 'MERGE_ALL' } });
      reqs.push({ mergeCells: { range: { sheetId: idx, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: totalCols }, mergeType: 'MERGE_ALL' } });

      // Hide gridlines on data sheets too — cleaner aesthetic
      reqs.push({
        updateSheetProperties: {
          properties: { sheetId: idx, gridProperties: { hideGridlines: true } },
          fields: 'gridProperties.hideGridlines',
        },
      });

      // Data validation (dropdowns)
      for (let c = 0; c < spec.columns.length; c++) {
        const col = spec.columns[c];
        if (col.type === 'dropdown' && col.dropdownValues && col.dropdownValues.length > 0) {
          reqs.push({
            setDataValidation: {
              range: { sheetId: idx, startRowIndex: 3, endRowIndex: 100, startColumnIndex: c, endColumnIndex: c + 1 },
              rule: {
                condition: {
                  type: 'ONE_OF_LIST',
                  values: col.dropdownValues.slice(0, 500).map((v) => ({ userEnteredValue: v })),
                },
                showCustomUi: true,
                strict: false,
              },
            },
          });
        }
      }

      // Column widths — smart sizing
      for (let c = 0; c < spec.columns.length; c++) {
        const col = spec.columns[c];
        let w = (col.width ?? 15) * 10;
        // Minimum widths by type
        if (col.type === 'dropdown') w = Math.max(w, 160);
        else if (col.type === 'text') w = Math.max(w, 130);
        else if (col.type === 'date') w = Math.max(w, 120);
        else if (col.type === 'formula') w = Math.max(w, 110);
        else w = Math.max(w, 100);

        reqs.push({
          updateDimensionProperties: {
            range: { sheetId: idx, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
            properties: { pixelSize: w },
            fields: 'pixelSize',
          },
        });
      }

      // Row heights
      reqs.push({ updateDimensionProperties: { range: { sheetId: idx, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 45 }, fields: 'pixelSize' } });
      reqs.push({ updateDimensionProperties: { range: { sheetId: idx, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 28 }, fields: 'pixelSize' } });
      reqs.push({ updateDimensionProperties: { range: { sheetId: idx, dimension: 'ROWS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 36 }, fields: 'pixelSize' } });
    }
  }

  // Instructions sheet
  reqs.push({ mergeCells: { range: { sheetId: instrIdx, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 }, mergeType: 'MERGE_ALL' } });
  reqs.push({ mergeCells: { range: { sheetId: instrIdx, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 3 }, mergeType: 'MERGE_ALL' } });
  reqs.push({
    updateSheetProperties: {
      properties: { sheetId: instrIdx, gridProperties: { hideGridlines: true } },
      fields: 'gridProperties.hideGridlines',
    },
  });
  reqs.push({ updateDimensionProperties: { range: { sheetId: instrIdx, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 60 }, fields: 'pixelSize' } });
  reqs.push({ updateDimensionProperties: { range: { sheetId: instrIdx, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 600 }, fields: 'pixelSize' } });
  reqs.push({ updateDimensionProperties: { range: { sheetId: instrIdx, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } });
  // Row heights for instructions
  reqs.push({ updateDimensionProperties: { range: { sheetId: instrIdx, dimension: 'ROWS', startIndex: 0, endIndex: 2 }, properties: { pixelSize: 40 }, fields: 'pixelSize' } });
  reqs.push({ updateDimensionProperties: { range: { sheetId: instrIdx, dimension: 'ROWS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 35 }, fields: 'pixelSize' } });

  return reqs;
}

// ── Main render function ────────────────────────────────────────────

export async function renderGoogleSheet(
  sheets: SheetSpec[],
  brief: ProductBrief,
): Promise<GoogleSheetsResult> {
  const startTime = performance.now();
  const nicheLabel = brief.niche.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const pal = makePalette(brief.styleGuide.accentColor || '#4F46E5');

  logger.info(`Creating Google Sheet: ${sheets.length} sheets for ${brief.id}`);

  const auth = await getAuthClient();
  const sheetsApi = google.sheets({ version: 'v4', auth });
  const driveApi = google.drive({ version: 'v3', auth });

  const sheetNames = sheets.map((s) => s.name);
  sheetNames.push('Instructions');

  // ── Build all sheet definitions ──
  const sheetDefs: sheets_v4.Schema$Sheet[] = [];

  for (let idx = 0; idx < sheets.length; idx++) {
    const spec = sheets[idx];
    const sheetType = spec.sheetType ?? 'data';
    const totalCols = Math.max(spec.columns.length, 6);

    const rowData = sheetType === 'dashboard'
      ? buildDashboard(spec, pal, nicheLabel, totalCols, sheets, idx)
      : buildDataSheet(spec, pal, nicheLabel);

    sheetDefs.push({
      properties: {
        sheetId: idx,
        title: spec.name,
        gridProperties: {
          rowCount: Math.max(rowData.length + 10, 60),
          columnCount: totalCols,
          frozenRowCount: sheetType === 'dashboard' ? 0 : 3,
        },
      },
      data: [{ startRow: 0, startColumn: 0, rowData }],
      conditionalFormats: buildConditionalFormats(spec, idx),
    });
  }

  // Instructions sheet
  const instrIdx = sheets.length;
  const instrRows = buildInstructions(pal, nicheLabel, sheetNames);
  sheetDefs.push({
    properties: {
      sheetId: instrIdx,
      title: 'Instructions',
      gridProperties: {
        rowCount: instrRows.length + 5,
        columnCount: 3,
        hideGridlines: true,
      },
    },
    data: [{ startRow: 0, startColumn: 0, rowData: instrRows }],
  });

  // ── Create the spreadsheet ──
  const createResponse = await sheetsApi.spreadsheets.create({
    requestBody: {
      properties: {
        title: `${nicheLabel} Tracker — PrintPilot`,
        defaultFormat: {
          textFormat: { fontFamily: 'Poppins', fontSize: 10 },
        },
      },
      sheets: sheetDefs,
    },
  });

  const spreadsheetId = createResponse.data.spreadsheetId!;
  const spreadsheetUrl = createResponse.data.spreadsheetUrl!;

  // ── Apply merges, validation, sizing ──
  const requests = buildBatchRequests(sheets, instrIdx, pal);

  if (requests.length > 0) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }

  // ── Add charts ──
  const chartRequests = buildChartRequests(sheets, pal);
  if (chartRequests.length > 0) {
    try {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: chartRequests },
      });
      logger.info(`Added ${chartRequests.length} charts to spreadsheet`);
    } catch (chartErr) {
      // Charts are nice-to-have, don't fail the whole render
      logger.warn(`Chart creation failed (non-fatal): ${chartErr instanceof Error ? chartErr.message : String(chartErr)}`);
    }
  }

  // ── Share as "anyone with link can view" ──
  await driveApi.permissions.create({
    fileId: spreadsheetId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  const duration = Math.round(performance.now() - startTime);

  const result: GoogleSheetsResult = {
    spreadsheetId,
    spreadsheetUrl,
    sheetCount: sheetDefs.length,
    duration,
  };

  logger.info(
    `Google Sheet created: ${result.sheetCount} sheets, ${result.duration}ms — ${result.spreadsheetUrl}`,
  );

  return result;
}
