import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawl } from "../src/crawl.js";
import { fetchResource, retryDelayMs } from "../src/fetcher.js";
import { scrape } from "../src/scrape.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

describe("retries", () => {
  it("retries 503 with Retry-After and succeeds", async () => {
    site.knobs.flakyFailures = 2;
    const before = site.requests.filter((r) => r === "/flaky").length;
    const doc = await scrape(`${site.base}/flaky`, { render: "never" });
    expect(doc.metadata?.statusCode).toBe(200);
    expect(doc.markdown).toContain("# Recovered");
    expect(site.requests.filter((r) => r === "/flaky").length).toBe(before + 3);
  });

  it("gives up after the configured retries on 429", async () => {
    const before = site.requests.filter((r) => r === "/ratelimit").length;
    const res = await fetchResource(`${site.base}/ratelimit`);
    expect(res.status).toBe(429);
    expect(site.requests.filter((r) => r === "/ratelimit").length).toBe(before + 3);
    await fetchResource(`${site.base}/ratelimit`, { retries: 0 });
    expect(site.requests.filter((r) => r === "/ratelimit").length).toBe(before + 4);
  });

  it("computes retry delays from Retry-After or backoff, capped", () => {
    expect(retryDelayMs("3", 0)).toBe(3000);
    expect(retryDelayMs("0", 5)).toBe(0);
    const inFuture = new Date(Date.now() + 2000).toUTCString();
    const dateDelay = retryDelayMs(inFuture, 0);
    expect(dateDelay).toBeGreaterThan(500);
    expect(dateDelay).toBeLessThanOrEqual(2000);
    expect(retryDelayMs("99999", 0)).toBe(30_000);
    const backoff = retryDelayMs(null, 1);
    expect(backoff).toBeGreaterThanOrEqual(1000);
    expect(backoff).toBeLessThanOrEqual(1250);
    expect(retryDelayMs("garbage", 20)).toBe(30_000);
  });
});

describe("Crawl-delay", () => {
  it("serializes requests when robots.txt asks for a delay", async () => {
    site.knobs.crawlDelay = 0.05;
    try {
      const started: number[] = [];
      const job = await crawl(`${site.base}/docs/`, { sitemap: "skip", limit: 3, maxConcurrency: 5, scrapeOptions: { render: "never" } }, {
        fetch: async (url, opts) => {
          if (!url.endsWith("/robots.txt")) started.push(Date.now());
          return fetchResource(url, opts);
        },
      });
      expect(job.completed).toBe(3);
      const gaps = started.slice(1).map((t, i) => t - started[i]!);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(40);
    } finally {
      site.knobs.crawlDelay = undefined;
    }
  });
});
