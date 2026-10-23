import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { duckduckgoBackend, search, searxngBackend } from "../src/search.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

describe("search", () => {
  it("maps SearXNG results into the web result shape", async () => {
    const result = await search({ query: "docs", limit: 2 }, { backend: searxngBackend(`${site.base}/searx`) });
    expect(result.backend).toBe("searxng");
    expect(result.data.web).toEqual([
      { url: `${site.base}/docs/a`, title: "Doc A", description: "snippet A" },
      { url: `${site.base}/blog/post-1`, title: "Post 1", description: "snippet B" },
    ]);
  });

  it("supports news sources and domain filters", async () => {
    const result = await search({ query: "docs", sources: ["web", "news"], excludeDomains: ["example.org"] }, { backend: searxngBackend(`${site.base}/searx`) });
    expect(result.data.web?.map((r) => r.url)).not.toContain("https://example.org/elsewhere");
    expect(result.data.news?.[0]).toMatchObject({ title: "Post 1 news", snippet: "news snippet", date: "2026-01-02", position: 1 });
  });

  it("scrapes results when scrapeOptions is set", async () => {
    const result = await search({ query: "docs", limit: 1, scrapeOptions: { formats: ["markdown"], render: "never" } }, { backend: searxngBackend(`${site.base}/searx`) });
    expect(result.data.web?.[0]?.markdown).toContain("# Doc A");
    expect(result.data.web?.[0]?.metadata?.title).toBe("Doc A");
  });

  it("warns when DuckDuckGo cannot serve non-web sources", async () => {
    const backend = duckduckgoBackend(`${site.base}/ddg`);
    const result = await search({ query: "x", sources: ["images"] }, {
      backend,
      fetch: async (url) => ({ url, status: 200, contentType: "text/html", body: Buffer.from("<html></html>"), headers: {} }),
    });
    expect(result.data.images).toEqual([]);
    expect(result.warning).toContain("images");
  });

  it("parses DuckDuckGo HTML results", async () => {
    const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fpage&amp;rut=1">A page</a><a class="result__snippet">About A</a></div>
<div class="result result--ad"><a class="result__a" href="https://ad.test">Ad</a></div>`;
    const result = await search({ query: "a" }, {
      backend: duckduckgoBackend(),
      fetch: async (url) => ({ url, status: 200, contentType: "text/html", body: Buffer.from(html), headers: {} }),
    });
    expect(result.data.web).toEqual([{ url: "https://a.test/page", title: "A page", description: "About A" }]);
  });
});

describe("search (review regressions)", () => {
  it("turns includeDomains into site: operators and over-fetches before filtering", async () => {
    const before = site.requests.length;
    await search({ query: "docs", limit: 2, includeDomains: ["127.0.0.1"] }, { backend: searxngBackend(`${site.base}/searx`) });
    const req = site.requests.slice(before).find((r) => r.startsWith("/searx/search"))!;
    const q = new URL(req, "http://x").searchParams.get("q");
    expect(q).toBe("docs site:127.0.0.1");
  });
});
