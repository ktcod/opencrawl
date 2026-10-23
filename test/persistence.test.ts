import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawl, getCrawlErrors, getCrawlStatus } from "../src/crawl.js";
import { scrapeWithStore } from "../src/scrape.js";
import { Store } from "../src/store.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

const never = { formats: ["markdown" as const], render: "never" as const };

describe("persistent crawl jobs", () => {
  it("survive a store reopen and paginate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencrawl-jobs-"));
    const file = path.join(dir, "jobs.db");
    const store = new Store(file);
    const job = await crawl(`${site.base}/docs/`, { sitemap: "skip", scrapeOptions: never }, { store });
    expect(job.status).toBe("completed");
    expect(job.data).toHaveLength(5);
    store.close();

    const reopened = new Store(file);
    const page = getCrawlStatus(job.id, { skip: 1, limit: 2 }, { store: reopened });
    expect(page).toMatchObject({ status: "completed", completed: 5, total: 5, hasMore: true });
    expect(page?.data).toHaveLength(2);
    expect(page?.data[0]?.metadata?.sourceURL).toBe(`${site.base}/docs/a`);
    const last = getCrawlStatus(job.id, { skip: 4, limit: 2 }, { store: reopened });
    expect(last).toMatchObject({ hasMore: false });
    expect(last?.data).toHaveLength(1);
    expect(getCrawlErrors(job.id, { store: reopened })).toEqual({ errors: [], robotsBlocked: [] });
    expect(getCrawlStatus("missing", {}, { store: reopened })).toBeUndefined();
    reopened.close();
  });
});

describe("scrape cache", () => {
  it("serves repeat requests within maxAge without touching the network", async () => {
    const store = new Store(":memory:");
    const url = `${site.base}/docs/b`;
    const before = site.requests.filter((r) => r === "/docs/b").length;
    const first = await scrapeWithStore(url, { maxAge: 60_000, render: "never" }, { store });
    expect(first.cached).toBe(false);
    expect(first.document.metadata?.cacheState).toBe("miss");
    const second = await scrapeWithStore(url, { maxAge: 60_000, render: "never" }, { store });
    expect(second.cached).toBe(true);
    expect(second.document.metadata?.cacheState).toBe("hit");
    expect(second.document.metadata?.cachedAt).toBeTruthy();
    expect(second.document.markdown).toBe(first.document.markdown);
    expect(site.requests.filter((r) => r === "/docs/b").length).toBe(before + 1);

    // A format the snapshot lacks forces a fresh fetch; the result is trimmed to what was asked.
    const withLinks = await scrapeWithStore(url, { maxAge: 60_000, formats: ["markdown", "links"], render: "never" }, { store });
    expect(withLinks.cached).toBe(false);
    expect(site.requests.filter((r) => r === "/docs/b").length).toBe(before + 2);
    const mdOnly = await scrapeWithStore(url, { maxAge: 60_000, render: "never" }, { store });
    expect(mdOnly.cached).toBe(true);
    expect(mdOnly.document.links).toBeUndefined();

    // maxAge 0 (the default) and storeInCache: false bypass the cache.
    const fresh = await scrapeWithStore(url, { render: "never" }, { store });
    expect(fresh.cached).toBe(false);
    const count = store.countDocuments();
    await scrapeWithStore(url, { render: "never", storeInCache: false }, { store });
    expect(store.countDocuments()).toBe(count);
    await scrapeWithStore(url, { render: "never" }, { store: false });
    expect(store.countDocuments()).toBe(count);
  });
});
