import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelCrawl, crawl, getCrawlErrors, getCrawlStatus, startCrawl, waitForCrawl } from "../src/crawl.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

const sourceUrls = (job: { data: Array<{ metadata?: { sourceURL?: string } }> }) => job.data.map((d) => d.metadata?.sourceURL).sort();
const never = { formats: ["markdown" as const], render: "never" as const };

describe("crawl", () => {
  it("stays under the start path by default", async () => {
    const job = await crawl(`${site.base}/docs/`, { sitemap: "skip", scrapeOptions: never });
    expect(job.status).toBe("completed");
    expect(sourceUrls(job)).toEqual([`${site.base}/docs/`, `${site.base}/docs/a`, `${site.base}/docs/b`, `${site.base}/docs/deep/c`, `${site.base}/docs/deep/d`]);
    expect(job.completed).toBe(5);
    expect(job.total).toBe(5);
    expect(job.data[0]?.links).toBeUndefined();
    expect(job.data[0]?.markdown).toContain("# Docs");
  });

  it("respects maxDiscoveryDepth", async () => {
    const job = await crawl(`${site.base}/docs/`, { sitemap: "skip", maxDiscoveryDepth: 1, scrapeOptions: never });
    expect(sourceUrls(job)).toEqual([`${site.base}/docs/`, `${site.base}/docs/a`, `${site.base}/docs/b`, `${site.base}/docs/deep/c`]);
  });

  it("respects excludePaths and includePaths", async () => {
    const excluded = await crawl(`${site.base}/docs/`, { sitemap: "skip", excludePaths: ["deep"], scrapeOptions: never });
    expect(sourceUrls(excluded)).toEqual([`${site.base}/docs/`, `${site.base}/docs/a`, `${site.base}/docs/b`]);
    const included = await crawl(`${site.base}/`, { sitemap: "skip", includePaths: ["^/blog"], scrapeOptions: never });
    expect(sourceUrls(included)).toEqual([`${site.base}/`, `${site.base}/blog/post-1`, `${site.base}/blog/post-2`]);
  });

  it("crawlEntireDomain follows siblings; limit caps pages", async () => {
    const job = await crawl(`${site.base}/docs/`, { sitemap: "skip", crawlEntireDomain: true, limit: 3, scrapeOptions: never, maxConcurrency: 1 });
    expect(job.completed).toBe(3);
    expect(job.status).toBe("completed");
  });

  it("seeds from the sitemap and honours robots.txt", async () => {
    const job = await crawl(`${site.base}/`, { crawlEntireDomain: true, scrapeOptions: never });
    const found = sourceUrls(job);
    expect(found).toContain(`${site.base}/sitemap-only`);
    expect(found).not.toContain(`${site.base}/private/secret`);
    expect(getCrawlErrors(job.id)?.robotsBlocked).toEqual([`${site.base}/private/secret`]);
  });

  it("includes links when the caller asks for them", async () => {
    const job = await crawl(`${site.base}/docs/a`, { sitemap: "skip", limit: 1, scrapeOptions: { formats: ["markdown", "links"], render: "never" } });
    expect(job.data[0]?.links).toContain(`${site.base}/docs/b`);
  });

  it("exposes async job status and cancellation", async () => {
    const { id } = startCrawl(`${site.base}/`, { crawlEntireDomain: true, delay: 0.2, maxConcurrency: 1, scrapeOptions: never });
    expect(getCrawlStatus(id)?.status).toBe("scraping");
    expect(cancelCrawl(id)).toBe(true);
    const job = await waitForCrawl(id);
    expect(job.status).toBe("cancelled");
    expect(job.completed).toBeLessThan(5);
    expect(getCrawlStatus("nope")).toBeUndefined();
  });
});

describe("crawl (review regressions)", () => {
  it("re-scopes to the landing origin after a redirect and applies that origin's robots.txt", async () => {
    const other = await startFixtureSite();
    try {
      const start = `${site.base}/redirect?to=${encodeURIComponent(`${other.base}/docs/b`)}`;
      const job = await crawl(start, { sitemap: "skip", crawlEntireDomain: true, scrapeOptions: never });
      expect(job.status).toBe("completed");
      expect(sourceUrls(job)).toEqual([start]);
      expect(job.data[0]?.metadata?.url).toBe(`${other.base}/docs/b`);
      expect(getCrawlErrors(job.id)?.robotsBlocked).toEqual([`${other.base}/private/secret`]);
    } finally {
      await other.close();
    }
  });

  it("records 4xx pages as errors instead of content and does not follow their links", async () => {
    const job = await crawl(`${site.base}/blog/post-2`, { sitemap: "skip", crawlEntireDomain: true, scrapeOptions: never });
    expect(sourceUrls(job)).toEqual([`${site.base}/blog/post-2`]);
    expect(job.completed).toBe(1);
    expect(job.total).toBe(2);
    expect(getCrawlErrors(job.id)?.errors.map((e) => [e.url, e.error])).toEqual([[`${site.base}/blog/missing`, "HTTP 404"]]);
  });

  it("matches includePaths/excludePaths against the path only", async () => {
    const job = await crawl(`${site.base}/`, { sitemap: "skip", crawlEntireDomain: true, excludePaths: ["^/docs/a$"], scrapeOptions: never, limit: 20 });
    const found = sourceUrls(job);
    expect(found).not.toContain(`${site.base}/docs/a`);
    expect(found).not.toContain(`${site.base}/docs/a?ref=home`);
  });

  it("serializes requests when a delay is set", async () => {
    const started: number[] = [];
    const job = await crawl(`${site.base}/docs/`, {
      sitemap: "skip",
      delay: 0.05,
      maxConcurrency: 5,
      limit: 3,
      scrapeOptions: never,
    }, {
      fetch: async (url, opts) => {
        if (!url.endsWith("/robots.txt")) started.push(Date.now());
        const { fetchResource } = await import("../src/fetcher.js");
        return fetchResource(url, opts);
      },
    });
    expect(job.completed).toBe(3);
    const gaps = started.slice(1).map((t, i) => t - started[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(40);
  });
});
