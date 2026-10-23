import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("v2 HTTP API", () => {
  const app = createApp();

  it("POST /v2/scrape returns { success, data }", async () => {
    const res = await post(app, "/v2/scrape", { url: `${site.base}/docs/a`, formats: ["markdown", "links"], render: "never" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.markdown).toContain("# Doc A");
    expect(json.data.links).toContain(`${site.base}/docs/b`);
    expect(json.data.metadata.sourceURL).toBe(`${site.base}/docs/a`);
  });

  it("rejects missing url with 400 and the error envelope", async () => {
    const res = await post(app, "/v2/scrape", {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/url/);
  });

  it("POST /v2/map returns { success, links }", async () => {
    const res = await post(app, "/v2/map", { url: site.base, sitemap: "only" });
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.links.map((l: { url: string }) => l.url)).toContain(`${site.base}/sitemap-only`);
  });

  it("crawl lifecycle: start, poll, errors, cancel", async () => {
    const start = await post(app, "/v2/crawl", { url: `${site.base}/docs/`, sitemap: "skip", scrapeOptions: { render: "never" } });
    const started = await start.json();
    expect(started).toMatchObject({ success: true, url: `${site.base}/docs/` });
    expect(started.id).toMatch(/[0-9a-f-]{36}/);
    let status;
    for (let i = 0; i < 100; i++) {
      status = await (await app.request(`/v2/crawl/${started.id}`)).json();
      if (status.status !== "scraping") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toMatchObject({ success: true, status: "completed", completed: 5, total: 5, next: null });
    expect(status.data).toHaveLength(5);
    const errors = await (await app.request(`/v2/crawl/${started.id}/errors`)).json();
    expect(errors).toMatchObject({ success: true, errors: [], robotsBlocked: [] });
    const cancel = await (await app.request(`/v2/crawl/${started.id}`, { method: "DELETE" })).json();
    expect(cancel).toEqual({ success: true, status: "cancelled" });
    expect((await app.request("/v2/crawl/does-not-exist")).status).toBe(404);
  });

  it("POST /v2/search returns the search envelope", async () => {
    process.env.SEARXNG_URL = `${site.base}/searx`;
    try {
      const res = await post(app, "/v2/search", { query: "docs", limit: 1 });
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.web[0].url).toBe(`${site.base}/docs/a`);
      expect(json.creditsUsed).toBe(0);
    } finally {
      delete process.env.SEARXNG_URL;
    }
  });

  it("serves account endpoints for clients that preflight credits and concurrency", async () => {
    const credits = await (await app.request("/v2/team/credit-usage")).json();
    expect(credits.success).toBe(true);
    expect(credits.data.remainingCredits).toBeGreaterThan(1_000_000);
    const queue = await (await app.request("/v2/team/queue-status")).json();
    expect(queue).toMatchObject({ success: true, maxConcurrency: 20 });
    const conc = await (await app.request("/v2/concurrency-check")).json();
    expect(conc).toMatchObject({ success: true, maxConcurrency: 20 });
  });

  it("enforces a bearer token when configured", async () => {
    const secured = createApp({ apiKey: "s3cret" });
    expect((await post(secured, "/v2/scrape", { url: site.base })).status).toBe(401);
    const ok = await post(secured, "/v2/scrape", { url: `${site.base}/docs/b`, render: "never" }, { authorization: "Bearer s3cret" });
    expect(ok.status).toBe(200);
  });
});

describe("store-backed endpoints", () => {
  const app = createApp();

  it("paginates crawl status with a next link", async () => {
    const start = await post(app, "/v2/crawl", { url: `${site.base}/docs/`, sitemap: "skip", scrapeOptions: { render: "never" } });
    const { id } = await start.json();
    let status;
    for (let i = 0; i < 100; i++) {
      status = await (await app.request(`/v2/crawl/${id}?limit=2`)).json();
      if (status.status !== "scraping") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status.data).toHaveLength(2);
    expect(status.next).toMatch(new RegExp(`/v2/crawl/${id}\\?skip=2&limit=2$`));
    const page2 = await (await app.request(new URL(status.next).pathname + new URL(status.next).search)).json();
    expect(page2.data).toHaveLength(2);
    const page3 = await (await app.request(`/v2/crawl/${id}?skip=4&limit=2`)).json();
    expect(page3.data).toHaveLength(1);
    expect(page3.next).toBeNull();
    const all = await (await app.request(`/v2/crawl/${id}`)).json();
    expect(all.data).toHaveLength(5);
    expect(all.next).toBeNull();
  });

  it("watches a page and searches the local store", async () => {
    const first = await (await post(app, "/v2/watch", { url: `${site.base}/mutable`, scrapeOptions: { render: "never" } })).json();
    expect(first).toMatchObject({ success: true, status: "new" });
    site.mutable.body = "<main><h1>Mutable</h1><p>http edition</p></main>";
    const second = await (await post(app, "/v2/watch", { url: `${site.base}/mutable`, scrapeOptions: { render: "never" } })).json();
    expect(second).toMatchObject({ success: true, status: "changed" });
    expect(second.diff).toContain("+http edition");
    const list = await (await app.request("/v2/watches")).json();
    expect(list.watches.map((w: { url: string }) => w.url)).toContain(`${site.base}/mutable`);
    const found = await (await post(app, "/v2/local-search", { query: "edition", limit: 5 })).json();
    expect(found.success).toBe(true);
    expect(found.data[0].url).toBe(`${site.base}/mutable`);
    expect((await post(app, "/v2/local-search", { query: "" })).status).toBe(400);
  });
});

describe("POST /v2/extract", () => {
  it("returns structured data, selections and tables", async () => {
    const app = createApp();
    const res = await post(app, "/v2/extract", { url: `${site.base}/structured`, selectors: { names: { selector: ".name", multiple: true } }, tables: { csv: true }, scrapeOptions: { render: "never" } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.jsonLd[0].name).toBe("Widget");
    expect(json.data.selected.names).toEqual(["Alpha", "Beta"]);
    expect(json.data.tables[0].csv).toContain("Item,Price,Price_2");
    expect((await post(app, "/v2/extract", { url: site.base, selectors: { x: { selector: "" } } })).status).toBe(400);
  });
});
