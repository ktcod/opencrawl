import ExcelJS from "exceljs";
import mammoth from "mammoth";
import type { ExtractedTable } from "./extract.js";

/** DOCX and XLSX readers used by parse (local files) and scrape (URLs serving them). */

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function docxToHtml(data: Buffer): Promise<{ html: string; warnings: string[] }> {
  let result: Awaited<ReturnType<typeof mammoth.convertToHtml>>;
  try {
    result = await mammoth.convertToHtml({ buffer: data });
  } catch (err) {
    throw new Error(`Invalid DOCX file: ${(err as Error).message}`);
  }
  const warnings = [...new Set(result.messages.map((m) => m.message))];
  return { html: result.value, warnings };
}

export interface SheetTable {
  name: string;
  /** First row of the sheet. */
  headers: string[];
  /** Remaining rows, padded to the header width. */
  rows: string[][];
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText)) return (v.richText as Array<{ text?: string }>).map((r) => r.text ?? "").join("");
    if (typeof v.text === "string") return v.text;
    if ("result" in v) return cellToString(v.result as ExcelJS.CellValue);
    if (typeof v.error === "string") return v.error;
    if (typeof v.hyperlink === "string") return v.hyperlink;
    return JSON.stringify(v);
  }
  return String(value);
}

export async function xlsxToTables(data: Buffer, maxRows = 10_000): Promise<SheetTable[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(data as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (err) {
    throw new Error(`Invalid XLSX file: ${(err as Error).message}`);
  }
  const out: SheetTable[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length > maxRows) return;
      const values = (Array.isArray(row.values) ? row.values : []) as ExcelJS.CellValue[];
      rows.push(values.slice(1).map(cellToString));
    });
    if (rows.length === 0) return;
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? "");
    out.push({ name: sheet.name, headers: pad(rows[0]!), rows: rows.slice(1).map(pad) });
  });
  return out;
}

const escapePipe = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function sheetsToMarkdown(sheets: SheetTable[]): string {
  return sheets
    .map((sheet) => {
      const header = `| ${sheet.headers.map(escapePipe).join(" | ")} |`;
      const divider = `| ${sheet.headers.map(() => "---").join(" | ")} |`;
      const body = sheet.rows.map((r) => `| ${r.map(escapePipe).join(" | ")} |`);
      return [`## ${sheet.name}`, "", header, divider, ...body].join("\n");
    })
    .join("\n\n");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function sheetsToHtml(sheets: SheetTable[]): string {
  return sheets
    .map(
      (sheet) =>
        `<h2>${escapeHtml(sheet.name)}</h2>\n<table><thead><tr>${sheet.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${sheet.rows
          .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
    )
    .join("\n");
}

export function sheetsToExtractedTables(sheets: SheetTable[]): ExtractedTable[] {
  return sheets.map((sheet, index) => {
    const seen = new Map<string, number>();
    const headers = sheet.headers.map((h, i) => {
      const base = h || `column_${i + 1}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : `${base}_${n}`;
    });
    return {
      index,
      caption: sheet.name,
      headers,
      rows: sheet.rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))),
      rowCount: sheet.rows.length,
      columnCount: headers.length,
    };
  });
}
