import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseFile } from "../src/parse.js";

const DOCX = path.resolve(import.meta.dirname, "fixtures", "sample.docx");

describe("office documents", () => {
  it("parses DOCX into markdown through the HTML pipeline", async () => {
    const doc = await parseFile(DOCX, { formats: ["markdown", "html"] });
    expect(doc.markdown).toContain("# Quarterly Report");
    expect(doc.markdown).toContain("Revenue grew **twelve percent** year over year.");
    expect(doc.markdown).toContain("Second paragraph");
    expect(doc.html).toContain("<h1>Quarterly Report</h1>");
    expect(doc.metadata?.contentType).toContain("wordprocessingml");
  });

  it("parses XLSX sheets into markdown tables and extract tables", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencrawl-xlsx-"));
    try {
      const file = path.join(dir, "book.xlsx");
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Sales");
      sheet.addRow(["Region", "Units", "When"]);
      sheet.addRow(["North", 12, new Date(Date.UTC(2026, 0, 2))]);
      sheet.addRow(["South", 7.5, "n/a"]);
      const second = workbook.addWorksheet("Notes");
      second.addRow(["Only", "a | pipe"]);
      await workbook.xlsx.writeFile(file);

      const doc = await parseFile(file, { formats: ["markdown", "extract"] });
      expect(doc.markdown).toContain("## Sales");
      expect(doc.markdown).toContain("| Region | Units | When |");
      expect(doc.markdown).toContain("| North | 12 | 2026-01-02T00:00:00.000Z |");
      expect(doc.markdown).toContain("| South | 7.5 | n/a |");
      expect(doc.markdown).toContain("## Notes");
      expect(doc.markdown).toContain("a \\| pipe");
      expect(doc.metadata?.numPages).toBe(2);
      const tables = (doc.extract as { tables: Array<{ caption?: string; rows: unknown[] }> }).tables;
      expect(tables[0]).toMatchObject({ caption: "Sales", headers: ["Region", "Units", "When"], rowCount: 2 });
      expect(tables[0]?.rows[0]).toEqual({ Region: "North", Units: "12", When: "2026-01-02T00:00:00.000Z" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
