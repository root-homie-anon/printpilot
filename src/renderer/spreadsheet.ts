import ExcelJS from 'exceljs';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import logger from '../utils/logger.js';
import type { ProductBrief } from '../types/index.js';

export interface SpreadsheetResult {
  outputPath: string;
  sheetCount: number;
  fileSizeBytes: number;
  duration: number;
}

export interface SheetSpec {
  name: string;
  sheetType?: 'dashboard' | 'data' | 'reference' | 'instructions' | 'settings';
  columns: ColumnSpec[];
  rows: RowData[];
  mergedHeaders?: MergedHeader[];
  conditionalRules?: ConditionalRule[];
  headerStyle?: Partial<StyleSpec>;
  formatting?: FormattingSpec;
}

export interface ColumnSpec {
  header: string;
  key: string;
  width: number;
  type?: 'text' | 'number' | 'date' | 'formula' | 'dropdown' | 'percentage' | 'currency';
  formula?: string;
  dropdownValues?: string[];
  numberFormat?: string;
}

export interface RowData {
  [key: string]: string | number | null | undefined;
}

interface MergedHeader {
  text: string;
  startCol: number;
  endCol: number;
  row: number;
  fillColor?: string;
}

interface ConditionalRule {
  column: string;
  type: 'traffic-light' | 'data-bar' | 'icon-set' | 'threshold';
  thresholds?: { green: number; yellow: number };
  barColor?: string;
}

interface StyleSpec {
  fillColor: string;
  fontColor: string;
  fontSize: number;
  bold: boolean;
}

interface FormattingSpec {
  alternatingRows?: boolean;
  alternateColor?: string;
  freezeHeader?: boolean;
  freezeRows?: number;
  autoFilter?: boolean;
  hideGridlines?: boolean;
  protectSheet?: boolean;
}

// ── Color palette system ────────────────────────────────────────────

interface ColorPalette {
  primary: string;
  primaryDark: string;
  accent: string;
  headerBg: string;
  headerFont: string;
  sectionBg: string;
  sectionFont: string;
  altRow: string;
  inputBg: string;
  borderLight: string;
  borderMedium: string;
  success: string;
  warning: string;
  danger: string;
  muted: string;
  white: string;
}

function buildPalette(accentColor: string): ColorPalette {
  return {
    primary: accentColor,
    primaryDark: darkenHex(accentColor, 30),
    accent: accentColor,
    headerBg: '#1E293B',
    headerFont: '#FFFFFF',
    sectionBg: darkenHex(accentColor, 10),
    sectionFont: '#FFFFFF',
    altRow: lightenHex(accentColor, 85),
    inputBg: '#FAFBFC',
    borderLight: '#E2E8F0',
    borderMedium: '#CBD5E1',
    success: '#10B981',
    warning: '#F59E0B',
    danger: '#EF4444',
    muted: '#94A3B8',
    white: '#FFFFFF',
  };
}

function hexToArgb(hex: string): string {
  return `FF${hex.replace('#', '')}`;
}

function darkenHex(hex: string, percent: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.floor((num >> 16) * (1 - percent / 100)));
  const g = Math.max(0, Math.floor(((num >> 8) & 0xFF) * (1 - percent / 100)));
  const b = Math.max(0, Math.floor((num & 0xFF) * (1 - percent / 100)));
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

function lightenHex(hex: string, percent: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.floor((num >> 16) + (255 - (num >> 16)) * percent / 100));
  const g = Math.min(255, Math.floor(((num >> 8) & 0xFF) + (255 - ((num >> 8) & 0xFF)) * percent / 100));
  const b = Math.min(255, Math.floor((num & 0xFF) + (255 - (num & 0xFF)) * percent / 100));
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

// ── Cell styling helpers ────────────────────────────────────────────

function applyFill(cell: ExcelJS.Cell, color: string): void {
  cell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: hexToArgb(color) },
  };
}

function applyBorders(cell: ExcelJS.Cell, color: string, style: 'thin' | 'medium' = 'thin'): void {
  const borderDef = { style, color: { argb: hexToArgb(color) } };
  cell.border = {
    top: borderDef,
    bottom: borderDef,
    left: borderDef,
    right: borderDef,
  };
}

// ── Premium sheet renderer ──────────────────────────────────────────

function renderDashboardSheet(
  ws: ExcelJS.Worksheet,
  sheetSpec: SheetSpec,
  palette: ColorPalette,
  brief: ProductBrief,
): void {
  const nicheLabel = brief.niche.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  // Hide gridlines for clean dashboard look
  ws.views = [{ showGridLines: false, state: 'frozen', ySplit: 0, xSplit: 0 }];

  // ── Title banner (rows 1-2, merged across) ──
  const titleCols = Math.max(sheetSpec.columns.length, 6);
  ws.mergeCells(1, 1, 2, titleCols);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `${nicheLabel} Dashboard`;
  applyFill(titleCell, palette.headerBg);
  titleCell.font = { bold: true, size: 20, color: { argb: hexToArgb(palette.white) } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 25;
  ws.getRow(2).height = 25;

  // ── Subtitle row ──
  ws.mergeCells(3, 1, 3, titleCols);
  const subtitleCell = ws.getCell(3, 1);
  subtitleCell.value = `Your personal ${nicheLabel.toLowerCase()} — track, measure, improve`;
  applyFill(subtitleCell, palette.primaryDark);
  subtitleCell.font = { size: 11, color: { argb: hexToArgb(palette.white) }, italic: true };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(3).height = 24;

  // ── Spacer row ──
  ws.getRow(4).height = 10;

  // ── KPI cards section header ──
  ws.mergeCells(5, 1, 5, titleCols);
  const kpiHeader = ws.getCell(5, 1);
  kpiHeader.value = '  KEY METRICS';
  applyFill(kpiHeader, palette.accent);
  kpiHeader.font = { bold: true, size: 12, color: { argb: hexToArgb(palette.white) } };
  kpiHeader.alignment = { vertical: 'middle' };
  ws.getRow(5).height = 28;

  // ── KPI card labels (row 6) and values (row 7) ──
  const kpiLabels = sheetSpec.columns.map((c) => c.header);
  const kpiRow = sheetSpec.rows[0] || {};

  // Row 6: labels
  ws.getRow(6).height = 20;
  ws.getRow(7).height = 36;

  for (let i = 0; i < Math.min(kpiLabels.length, titleCols); i++) {
    const colNum = i + 1;
    ws.getColumn(colNum).width = sheetSpec.columns[i]?.width ?? 18;

    // Label cell
    const labelCell = ws.getCell(6, colNum);
    labelCell.value = kpiLabels[i];
    applyFill(labelCell, palette.inputBg);
    applyBorders(labelCell, palette.borderLight);
    labelCell.font = { size: 9, color: { argb: hexToArgb(palette.muted) }, bold: true };
    labelCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Value cell
    const valueCell = ws.getCell(7, colNum);
    const col = sheetSpec.columns[i];
    if (col?.type === 'formula' && col.formula) {
      valueCell.value = { formula: col.formula.replace(/\{ROW\}/g, '7') } as ExcelJS.CellFormulaValue;
    } else {
      const key = col?.key ?? '';
      valueCell.value = kpiRow[key] ?? '';
    }
    applyFill(valueCell, palette.white);
    applyBorders(valueCell, palette.accent, 'medium');
    valueCell.font = { size: 18, bold: true, color: { argb: hexToArgb(palette.primaryDark) } };
    valueCell.alignment = { vertical: 'middle', horizontal: 'center' };
  }

  // ── Remaining rows as summary data ──
  let currentRow = 9;

  if (sheetSpec.rows.length > 1) {
    // Section header for additional data
    ws.mergeCells(currentRow, 1, currentRow, titleCols);
    const summaryHeader = ws.getCell(currentRow, 1);
    summaryHeader.value = '  PROGRESS SUMMARY';
    applyFill(summaryHeader, palette.accent);
    summaryHeader.font = { bold: true, size: 12, color: { argb: hexToArgb(palette.white) } };
    summaryHeader.alignment = { vertical: 'middle' };
    ws.getRow(currentRow).height = 28;
    currentRow++;

    // Summary table headers
    for (let i = 0; i < sheetSpec.columns.length; i++) {
      const cell = ws.getCell(currentRow, i + 1);
      cell.value = sheetSpec.columns[i].header;
      applyFill(cell, palette.headerBg);
      cell.font = { bold: true, size: 10, color: { argb: hexToArgb(palette.white) } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      applyBorders(cell, palette.headerBg);
    }
    ws.getRow(currentRow).height = 24;
    currentRow++;

    // Summary data rows (skip first row, used for KPIs)
    for (let r = 1; r < sheetSpec.rows.length; r++) {
      const rowData = sheetSpec.rows[r];
      const isAlt = r % 2 === 0;
      for (let c = 0; c < sheetSpec.columns.length; c++) {
        const col = sheetSpec.columns[c];
        const cell = ws.getCell(currentRow, c + 1);
        if (col.type === 'formula' && col.formula) {
          cell.value = { formula: col.formula.replace(/\{ROW\}/g, String(currentRow)) } as ExcelJS.CellFormulaValue;
        } else {
          cell.value = rowData[col.key] ?? '';
        }
        if (isAlt) applyFill(cell, palette.altRow);
        applyBorders(cell, palette.borderLight);
        cell.font = { size: 10 };
        cell.alignment = { vertical: 'middle' };
      }
      ws.getRow(currentRow).height = 22;
      currentRow++;
    }
  }

  // ── Footer ──
  currentRow += 1;
  ws.mergeCells(currentRow, 1, currentRow, titleCols);
  const footerCell = ws.getCell(currentRow, 1);
  footerCell.value = `Created with PrintPilot  •  ${nicheLabel}`;
  footerCell.font = { size: 8, color: { argb: hexToArgb(palette.muted) }, italic: true };
  footerCell.alignment = { horizontal: 'center' };
}

function renderDataSheet(
  ws: ExcelJS.Worksheet,
  sheetSpec: SheetSpec,
  palette: ColorPalette,
  brief: ProductBrief,
): void {
  const nicheLabel = brief.niche.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const totalCols = sheetSpec.columns.length;

  // ── Title banner (row 1, merged) ──
  ws.mergeCells(1, 1, 1, totalCols);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `  ${sheetSpec.name}`;
  applyFill(titleCell, palette.headerBg);
  titleCell.font = { bold: true, size: 14, color: { argb: hexToArgb(palette.white) } };
  titleCell.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 36;

  // ── Accent stripe (row 2) ──
  ws.mergeCells(2, 1, 2, totalCols);
  const stripeCell = ws.getCell(2, 1);
  stripeCell.value = `  ${nicheLabel}`;
  applyFill(stripeCell, palette.accent);
  stripeCell.font = { size: 9, color: { argb: hexToArgb(palette.white) }, italic: true };
  stripeCell.alignment = { vertical: 'middle' };
  ws.getRow(2).height = 22;

  // ── Merged section headers (if any) ──
  let dataStartRow = 3;

  if (sheetSpec.mergedHeaders && sheetSpec.mergedHeaders.length > 0) {
    for (const mh of sheetSpec.mergedHeaders) {
      const rowNum = mh.row + 2; // offset for title rows
      ws.mergeCells(rowNum, mh.startCol, rowNum, mh.endCol);
      const cell = ws.getCell(rowNum, mh.startCol);
      cell.value = `  ${mh.text}`;
      applyFill(cell, mh.fillColor ?? palette.sectionBg);
      cell.font = { bold: true, size: 11, color: { argb: hexToArgb(palette.white) } };
      cell.alignment = { vertical: 'middle' };
      ws.getRow(rowNum).height = 26;
      dataStartRow = Math.max(dataStartRow, rowNum + 1);
    }
  }

  // ── Column headers (row after title/sections) ──
  const headerRowNum = dataStartRow;
  ws.getRow(headerRowNum).height = 30;

  for (let i = 0; i < sheetSpec.columns.length; i++) {
    const col = sheetSpec.columns[i];
    const colNum = i + 1;
    ws.getColumn(colNum).width = col.width;

    const cell = ws.getCell(headerRowNum, colNum);
    cell.value = col.header;
    applyFill(cell, palette.primaryDark);
    cell.font = { bold: true, size: 10, color: { argb: hexToArgb(palette.white) } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    applyBorders(cell, palette.primaryDark);
  }

  // ── Data rows ──
  const dataValidationRows = 50; // extend validation beyond example data
  const totalDataRows = Math.max(sheetSpec.rows.length, dataValidationRows);

  for (let i = 0; i < totalDataRows; i++) {
    const rowNum = headerRowNum + 1 + i;
    const rowData = i < sheetSpec.rows.length ? sheetSpec.rows[i] : null;
    const isAlt = i % 2 === 1;
    const isExample = i < sheetSpec.rows.length;

    ws.getRow(rowNum).height = 22;

    for (let c = 0; c < sheetSpec.columns.length; c++) {
      const col = sheetSpec.columns[c];
      const colNum = c + 1;
      const cell = ws.getCell(rowNum, colNum);

      // Set value
      if (col.type === 'formula' && col.formula) {
        const expandedFormula = col.formula
          .replace(/\{ROW\}/g, String(rowNum))
          .replace(/\{ROW-1\}/g, String(rowNum - 1));
        cell.value = { formula: expandedFormula } as ExcelJS.CellFormulaValue;
      } else if (rowData) {
        cell.value = rowData[col.key] ?? '';
      }

      // Number format
      if (col.type === 'percentage' || col.numberFormat === '0%') {
        cell.numFmt = '0.0%';
      } else if (col.type === 'currency' || col.numberFormat === '$') {
        cell.numFmt = '$#,##0.00';
      } else if (col.numberFormat) {
        cell.numFmt = col.numberFormat;
      }

      // Styling
      if (isAlt) {
        applyFill(cell, palette.altRow);
      } else if (!isExample) {
        applyFill(cell, palette.inputBg);
      }
      applyBorders(cell, palette.borderLight);
      cell.font = { size: 10, color: { argb: isExample ? 'FF334155' : hexToArgb(palette.muted) } };
      cell.alignment = { vertical: 'middle', wrapText: true };

      // Dropdown validation
      if (col.type === 'dropdown' && col.dropdownValues && col.dropdownValues.length > 0) {
        cell.dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [`"${col.dropdownValues.join(',')}"`],
        };
      }
    }
  }

  // ── Conditional formatting ──
  if (sheetSpec.conditionalRules) {
    for (const rule of sheetSpec.conditionalRules) {
      const colIdx = sheetSpec.columns.findIndex((c) => c.key === rule.column);
      if (colIdx < 0) continue;
      const colLetter = String.fromCharCode(65 + colIdx);
      const startRow = headerRowNum + 1;
      const endRow = headerRowNum + totalDataRows;
      const range = `${colLetter}${startRow}:${colLetter}${endRow}`;

      if (rule.type === 'traffic-light' && rule.thresholds) {
        ws.addConditionalFormatting({
          ref: range,
          rules: [
            {
              type: 'cellIs',
              operator: 'greaterThan',
              formulae: [String(rule.thresholds.green)],
              priority: 1,
              style: {
                fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FF10B981' } },
                font: { color: { argb: 'FF065F46' } },
              },
            },
            {
              type: 'cellIs',
              operator: 'greaterThan',
              formulae: [String(rule.thresholds.yellow)],
              priority: 2,
              style: {
                fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFEF3C7' } },
                font: { color: { argb: 'FF92400E' } },
              },
            },
            {
              type: 'cellIs',
              operator: 'lessThan',
              formulae: [String(rule.thresholds.yellow)],
              priority: 3,
              style: {
                fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFEE2E2' } },
                font: { color: { argb: 'FF991B1B' } },
              },
            },
          ],
        });
      }
    }
  }

  // ── Freeze panes ──
  const freezeRow = sheetSpec.formatting?.freezeRows ?? headerRowNum;
  ws.views = [{ state: 'frozen', ySplit: freezeRow, xSplit: 0, activeCell: `A${freezeRow + 1}` }];

  // ── Auto filter ──
  if (sheetSpec.formatting?.autoFilter !== false) {
    ws.autoFilter = {
      from: { row: headerRowNum, column: 1 },
      to: { row: headerRowNum + sheetSpec.rows.length, column: sheetSpec.columns.length },
    };
  }

  // ── Sheet protection (lock formula cells, allow input cells) ──
  if (sheetSpec.formatting?.protectSheet) {
    ws.protect('', {
      selectLockedCells: true,
      selectUnlockedCells: true,
      formatColumns: true,
      formatRows: true,
      sort: true,
      autoFilter: true,
    });
  }
}

function renderInstructionsSheet(
  ws: ExcelJS.Worksheet,
  palette: ColorPalette,
  brief: ProductBrief,
  sheetNames: string[],
): void {
  const nicheLabel = brief.niche.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  ws.views = [{ showGridLines: false }];
  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 60;
  ws.getColumn(3).width = 30;

  // Title
  ws.mergeCells(1, 1, 2, 3);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `How to Use Your ${nicheLabel}`;
  applyFill(titleCell, palette.headerBg);
  titleCell.font = { bold: true, size: 18, color: { argb: hexToArgb(palette.white) } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 25;
  ws.getRow(2).height = 25;

  // Accent stripe
  ws.mergeCells(3, 1, 3, 3);
  const stripe = ws.getCell(3, 1);
  stripe.value = '  Thank you for your purchase! Here\'s how to get started:';
  applyFill(stripe, palette.accent);
  stripe.font = { size: 11, color: { argb: hexToArgb(palette.white) }, italic: true };
  stripe.alignment = { vertical: 'middle' };
  ws.getRow(3).height = 28;

  let row = 5;

  // Steps
  const steps = [
    { title: 'Getting Started', desc: 'This spreadsheet works in Microsoft Excel, Google Sheets, and Apple Numbers. Simply open the file and start entering your data.' },
    { title: 'Navigation', desc: `Use the tabs at the bottom to switch between sheets. Your spreadsheet includes: ${sheetNames.join(', ')}.` },
    { title: 'Enter Your Data', desc: 'Click on any cell to start typing. Cells with dropdown arrows have pre-set options — click the arrow to select. Colored header rows are labels — enter your data in the rows below.' },
    { title: 'Automatic Calculations', desc: 'Columns with formulas will auto-calculate as you enter data. Do NOT edit formula cells (they update automatically). Look for totals, averages, and progress percentages.' },
    { title: 'Customization', desc: 'Feel free to add more rows as needed — formulas will extend automatically. You can also modify dropdown lists and add your own categories.' },
    { title: 'Tips for Best Results', desc: 'Update your tracker consistently for the most accurate progress view. Use the Dashboard tab to see your overall progress at a glance. Print any sheet for offline use.' },
  ];

  for (let i = 0; i < steps.length; i++) {
    // Step number
    ws.mergeCells(row, 1, row, 1);
    const numCell = ws.getCell(row, 1);
    numCell.value = i + 1;
    applyFill(numCell, palette.accent);
    numCell.font = { bold: true, size: 14, color: { argb: hexToArgb(palette.white) } };
    numCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Step title
    const stepTitle = ws.getCell(row, 2);
    stepTitle.value = steps[i].title;
    stepTitle.font = { bold: true, size: 13, color: { argb: hexToArgb(palette.primaryDark) } };
    stepTitle.alignment = { vertical: 'middle' };
    ws.getRow(row).height = 28;

    row++;

    // Step description
    ws.mergeCells(row, 2, row, 3);
    const stepDesc = ws.getCell(row, 2);
    stepDesc.value = steps[i].desc;
    stepDesc.font = { size: 11, color: { argb: 'FF475569' } };
    stepDesc.alignment = { vertical: 'top', wrapText: true };
    ws.getRow(row).height = 40;

    row += 2;
  }

  // Footer
  row++;
  ws.mergeCells(row, 1, row, 3);
  const footer = ws.getCell(row, 1);
  footer.value = 'Questions? We\'re here to help! Contact us through our Etsy shop.';
  footer.font = { size: 10, color: { argb: hexToArgb(palette.muted) }, italic: true };
  footer.alignment = { horizontal: 'center' };
}

// ── Main render function ────────────────────────────────────────────

export async function renderSpreadsheet(
  sheets: SheetSpec[],
  outputPath: string,
  brief: ProductBrief,
): Promise<SpreadsheetResult> {
  const startTime = performance.now();

  logger.info(`Rendering premium spreadsheet: ${sheets.length} sheets -> ${outputPath}`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PrintPilot';
  workbook.created = new Date();
  workbook.calcProperties = { fullCalcOnLoad: true };

  const accentColor = brief.styleGuide.accentColor || '#4A90D9';
  const palette = buildPalette(accentColor);

  // Collect sheet names for instructions
  const sheetNames = sheets.map((s) => s.name);
  sheetNames.push('Instructions');

  for (const sheetSpec of sheets) {
    const ws = workbook.addWorksheet(sheetSpec.name, {
      properties: { defaultColWidth: 15 },
    });

    const sheetType = sheetSpec.sheetType ?? 'data';

    if (sheetType === 'dashboard') {
      renderDashboardSheet(ws, sheetSpec, palette, brief);
    } else if (sheetType === 'instructions') {
      renderInstructionsSheet(ws, palette, brief, sheetNames);
    } else {
      renderDataSheet(ws, sheetSpec, palette, brief);
    }
  }

  // Always add an Instructions sheet at the end
  const hasInstructions = sheets.some((s) => s.sheetType === 'instructions');
  if (!hasInstructions) {
    const instrWs = workbook.addWorksheet('Instructions', {
      properties: { defaultColWidth: 15 },
    });
    renderInstructionsSheet(instrWs, palette, brief, sheetNames);
  }

  await workbook.xlsx.writeFile(outputPath);

  const fileInfo = await stat(outputPath);
  const duration = Math.round(performance.now() - startTime);

  const totalSheets = workbook.worksheets.length;

  const result: SpreadsheetResult = {
    outputPath,
    sheetCount: totalSheets,
    fileSizeBytes: fileInfo.size,
    duration,
  };

  logger.info(
    `Premium spreadsheet rendered: ${result.sheetCount} sheets, ${result.fileSizeBytes} bytes, ${result.duration}ms`,
  );

  return result;
}

export function buildSpreadsheetPath(productDir: string, productId: string): string {
  return join(productDir, `${productId}.xlsx`);
}
