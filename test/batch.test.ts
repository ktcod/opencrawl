import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { batchScrape, documentDirectory, saveDocuments } from "../src/batch.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

const never = { formats: ["markdown" as const], render: "never" as const };

describe("batchScrape", () => {
  it("keeps input order, dedupes, and isolates failures", async () => {
    const result = await batchScrape([`${site.base}/docs/b`, `${site.base}/docs/a`, `${site.base}/docs/b`, "not a url", `${site.base}/docs/deep/c`], {
      scrapeOptions: never,
      ignoreInvalidURLs: true,
      concurrency: 2,
    });
    expect(result.total).toBe(4);
    expect(result.completed).toBe(3);
    expect(result.data.map((d) => d.metadata?.title)).toEqual(["Doc B", "Doc A", "Doc C"]);
    expect(result.errors).toEqual([{ url: "not a url", error: expect.stringMatching(/Invalid URL/) }]);
    await expect(batchScrape(["ftp://nope.test/x"], { scrapeOptions: never })).rejects.toThrow(/Unsupported URL scheme/);
  });
});

describe("documentDirectory / saveDocuments", () => {
  it("maps URLs to safe nested paths", () => {
    const out = "/tmp/out";
    expect(documentDirectory("https://www.Example.com/", out)).toBe(path.resolve(out, "example.com"));
    expect(documentDirectory("https://example.com/docs/intro%20page/", out)).toBe(path.resolve(out, "example.com", "docs", "intro_page"));
    expect(documentDirectory("https://example.com/a?x=1", out)).toMatch(/example\.com\/a\/_q_[0-9a-f]{8}$/);
    expect(documentDirectory("https://example.com/../../etc/passwd", out).startsWith(path.resolve(out) + path.sep)).toBe(true);
    expect(documentDirectory("https://example.com/..", out)).toBe(path.resolve(out, "example.com"));
    expect(documentDirectory("https://example.com/a%2F..%2F..%2Fb", out)).toBe(path.resolve(out, "example.com", "a_.._.._b"));
  });

  it("writes one folder per page with the formats present", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencrawl-out-"));
    try {
      const result = await batchScrape([`${site.base}/docs/a`, `${site.base}/`], { scrapeOptions: { formats: ["markdown", "links", "html"], render: "never" } });
      const saved = await saveDocuments(result.data, dir);
      expect(saved.errors).toEqual([]);
      expect(saved.saved).toHaveLength(2);
      const host = (await readdir(dir))[0]!;
      const files = (await readdir(path.join(dir, host, "docs", "a"))).sort();
      expect(files).toEqual(["index.html", "index.md", "links.txt", "metadata.json"]);
      expect(await readFile(path.join(dir, host, "docs", "a", "index.md"), "utf8")).toContain("# Doc A");
      expect(await readFile(path.join(dir, host, "index.md"), "utf8")).toContain("# Welcome");
      expect(JSON.parse(await readFile(path.join(dir, host, "metadata.json"), "utf8")).title).toBe("Fixture Home");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
