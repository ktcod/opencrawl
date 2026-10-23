import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store, contentHash, documentKey } from "../src/store.js";
import type { Document as ScrapedDocument } from "../src/types.js";

const doc = (url: string, markdown: string, extra: Partial<ScrapedDocument> = {}, status = 200): ScrapedDocument => ({
  markdown,
  metadata: { sourceURL: url, url, statusCode: status, title: markdown.split("\n")[0]?.replace(/^#\s*/, "") },
  ...extra,
});

describe("Store documents", () => {
  it("stores snapshots and serves fresh ones by age and formats", () => {
    const store = new Store(":memory:");
    const url = "https://site.test/page";
    const t0 = 1_000_000;
    const first = store.putDocument(doc(url, "# One\n\nfirst"), url, t0);
    const second = store.putDocument(doc(url, "# Two\n\nsecond", { links: ["https://site.test/x"] }), url, t0 + 1000);
    expect(store.getLatestDocument(url)?.id).toBe(second);
    expect(store.getLatestDocument("https://www.site.test/page/")?.id).toBe(second);
    expect(store.getFreshDocument(url, 500, ["markdown"], t0 + 1200)?.id).toBe(second);
    expect(store.getFreshDocument(url, 100, ["markdown"], t0 + 1200)).toBeUndefined();
    expect(store.getFreshDocument(url, 5000, ["markdown", "links"], t0 + 1200)?.id).toBe(second);
    expect(store.getFreshDocument(url, 5000, ["markdown", "html"], t0 + 1200)).toBeUndefined();
    expect(store.listSnapshots(url).map((s) => s.id)).toEqual([second, first]);
    expect(store.getDocumentById(first)?.document.markdown).toBe("# One\n\nfirst");
    expect(store.countDocuments()).toBe(2);
  });

  it("never serves error pages from the cache and drops screenshots", () => {
    const store = new Store(":memory:");
    const url = "https://site.test/gone";
    store.putDocument(doc(url, "# Not found", { screenshot: "data:image/png;base64,AAAA" }, 404), url, 10);
    expect(store.getFreshDocument(url, 1_000_000, ["markdown"], 20)).toBeUndefined();
    expect(store.getLatestDocument(url)?.document.screenshot).toBeUndefined();
  });

  it("full-text search ranks, dedupes per URL, and filters by site and time", () => {
    const store = new Store(":memory:");
    store.putDocument(doc("https://a.test/pricing", "# Pricing\n\nOur pricing plans start at ten dollars."), "https://a.test/pricing", 100);
    store.putDocument(doc("https://a.test/pricing", "# Pricing\n\nOur pricing plans start at twelve dollars."), "https://a.test/pricing", 200);
    store.putDocument(doc("https://b.test/about", "# About\n\nWe talk about pricing once."), "https://b.test/about", 300);
    store.putDocument(doc("https://b.test/blog", "# Blog\n\nNothing relevant here."), "https://b.test/blog", 400);
    const hits = store.searchLocal("pricing");
    expect(hits.map((h) => h.url)).toEqual(["https://a.test/pricing", "https://b.test/about"]);
    expect(hits[0]?.snippet).toContain("[Pricing]");
    expect(store.searchLocal("pricing", { site: "b.test" }).map((h) => h.url)).toEqual(["https://b.test/about"]);
    expect(store.searchLocal("pricing", { since: 250 }).map((h) => h.url)).toEqual(["https://b.test/about"]);
    expect(store.searchLocal('"unbalanced quote')).toEqual([]);
    expect(store.searchLocal("   ")).toEqual([]);
  });
});

describe("Store crawl jobs", () => {
  const job = (id: string, status: "scraping" | "completed" = "completed") => ({
    id,
    url: "https://site.test/",
    status,
    total: 0,
    completed: 0,
    creditsUsed: 0,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    createdAt: Date.now(),
    options: { limit: 3 },
    errors: [],
    robotsBlocked: [],
  });

  it("persists jobs and pages their documents in order", () => {
    const store = new Store(":memory:");
    store.insertJob(job("j1"));
    const ids = ["a", "b", "c"].map((p) => store.putDocument(doc(`https://site.test/${p}`, `# ${p}`), `https://site.test/${p}`));
    for (const id of ids) store.appendJobDocument("j1", id);
    expect(store.countJobDocuments("j1")).toBe(3);
    expect(store.getJobDocuments("j1").map((d) => d.markdown)).toEqual(["# a", "# b", "# c"]);
    expect(store.getJobDocuments("j1", 1, 1).map((d) => d.markdown)).toEqual(["# b"]);
    const updated = { ...job("j1"), total: 3, completed: 3, creditsUsed: 3, errors: [{ url: "x", error: "boom" }] };
    store.updateJob(updated);
    expect(store.getJob("j1")).toMatchObject({ total: 3, completed: 3, errors: [{ url: "x", error: "boom" }], options: { limit: 3 } });
    expect(store.listJobs().map((j) => j.id)).toEqual(["j1"]);
  });

  it("marks interrupted jobs failed on reopen and prunes old ones", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencrawl-store-"));
    const file = path.join(dir, "t.db");
    const a = new Store(file);
    a.insertJob(job("running", "scraping"));
    a.insertJob({ ...job("ancient"), createdAt: Date.now() - 30 * 24 * 3600 * 1000 });
    a.close();
    const b = new Store(file);
    expect(b.getJob("running")).toMatchObject({ status: "failed" });
    expect(b.getJob("running")?.errors[0]?.error).toMatch(/interrupted/);
    expect(b.getJob("ancient")).toBeUndefined();
    b.close();
  });
});

describe("Store watches", () => {
  it("upserts, lists and deletes watch state", () => {
    const store = new Store(":memory:");
    expect(store.getWatch("https://site.test/w")).toBeUndefined();
    store.upsertWatch({ key: documentKey("https://site.test/w"), url: "https://site.test/w", lastDocumentId: 1, lastCheckedAt: 5, lastChangedAt: 5, checkCount: 1 });
    store.upsertWatch({ key: documentKey("https://site.test/w"), url: "https://site.test/w", lastDocumentId: 2, lastCheckedAt: 9, lastChangedAt: 5, checkCount: 2 });
    expect(store.getWatch("https://www.site.test/w/")).toMatchObject({ lastDocumentId: 2, checkCount: 2 });
    expect(store.listWatches()).toHaveLength(1);
    expect(store.deleteWatch("https://site.test/w")).toBe(true);
    expect(store.listWatches()).toHaveLength(0);
  });

  it("hashes markdown first, then html, then the document", () => {
    expect(contentHash({ markdown: "a" })).toBe(contentHash({ markdown: "a", html: "<p>b</p>" }));
    expect(contentHash({ html: "<p>b</p>" })).not.toBe(contentHash({ html: "<p>c</p>" }));
  });
});
