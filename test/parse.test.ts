import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile } from "../src/parse.js";

describe("parseFile", () => {
  it("parses html and text files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencrawl-test-"));
    try {
    const htmlPath = path.join(dir, "page.html");
    await writeFile(htmlPath, `<html><head><title>Local</title></head><body><nav>NAV</nav><h1>Hello</h1><a href="other.html">rel</a></body></html>`);
    const html = await parseFile(htmlPath, { formats: ["markdown", "links"] });
    expect(html.markdown).toContain("# Hello");
    expect(html.markdown).toContain("NAV");
    expect(html.metadata?.title).toBe("Local");
    expect(html.links).toEqual([]);
    const txtPath = path.join(dir, "notes.md");
    await writeFile(txtPath, "# Notes\n\nplain");
    expect((await parseFile(txtPath)).markdown).toBe("# Notes\n\nplain");
    const otherPath = path.join(dir, "x.xyz");
    await writeFile(otherPath, "unknown format");
    await expect(parseFile(otherPath)).rejects.toThrow(/Unsupported file type/);
    const fakeDocx = path.join(dir, "fake.docx");
    await writeFile(fakeDocx, "not really a docx");
    await expect(parseFile(fakeDocx)).rejects.toThrow(/Invalid DOCX file/);
    const fakeXlsx = path.join(dir, "fake.xlsx");
    await writeFile(fakeXlsx, "not really a spreadsheet");
    await expect(parseFile(fakeXlsx)).rejects.toThrow(/Invalid XLSX file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
