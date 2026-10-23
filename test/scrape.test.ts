import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrape } from "../src/scrape.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

describe("scrape", () => {
  it("returns markdown, links, images, html and metadata", async () => {
    const doc = await scrape(`${site.base}/`, { formats: ["markdown", "links", "images", "html", "rawHtml"], render: "never" });
    expect(doc.markdown).toContain("# Welcome");
    expect(doc.markdown).toContain(`[Doc A](${site.base}/docs/a)`);
    expect(doc.markdown).not.toContain("NAV-MARKER");
    expect(doc.markdown).not.toContain("FOOTER-MARKER");
    expect(doc.markdown).toContain("<Base64-Image-Removed>");
    expect(doc.links).toContain(`${site.base}/docs/a`);
    expect(doc.links).toContain("https://example.org/external");
    expect(doc.links).not.toContain("mailto:someone@example.org");
    expect(doc.images).toEqual([`${site.base}/img/one.png`, `${site.base}/og.png`]);
    expect(doc.html).toContain("<h1>Welcome</h1>");
    expect(doc.rawHtml).toContain("<script src=");
    expect(doc.metadata).toMatchObject({
      title: "Fixture Home",
      description: "A fixture site",
      language: "en",
      ogImage: "/og.png",
      favicon: `${site.base}/favicon.png`,
      sourceURL: `${site.base}/`,
      url: `${site.base}/`,
      statusCode: 200,
      rendered: false,
    });
    expect(doc.metadata?.scrapeId).toMatch(/[0-9a-f-]{36}/);
  });

  it("keeps page chrome when onlyMainContent is false", async () => {
    const doc = await scrape(`${site.base}/`, { onlyMainContent: false, render: "never" });
    expect(doc.markdown).toContain("NAV-MARKER");
    expect(doc.markdown).toContain("FOOTER-MARKER");
  });

  it("honours includeTags and excludeTags", async () => {
    const only = await scrape(`${site.base}/`, { includeTags: ["h1"], render: "never" });
    expect(only.markdown?.trim()).toBe("# Welcome");
    const without = await scrape(`${site.base}/`, { excludeTags: [".secret"], render: "never" });
    expect(without.markdown).not.toContain("SECRET-MARKER");
    expect(without.markdown).toContain("# Welcome");
  });

  it("reports 404 status but still returns content", async () => {
    const doc = await scrape(`${site.base}/missing`, { render: "never" });
    expect(doc.metadata?.statusCode).toBe(404);
    expect(doc.markdown).toContain("# Not found");
  });

  it("returns plain text bodies as markdown", async () => {
    const doc = await scrape(`${site.base}/plain.txt`, { render: "never" });
    expect(doc.markdown).toBe("Hello plain text\nSecond line\n");
    expect(doc.metadata?.contentType).toContain("text/plain");
  });

  it("warns about LLM-only formats instead of failing", async () => {
    const doc = await scrape(`${site.base}/docs/a`, { formats: ["summary", "markdown"], render: "never" });
    expect(doc.markdown).toContain("# Doc A");
    expect(doc.warning).toContain("summary");
  });

  it("falls back to a warning when a JS shell cannot be rendered", async () => {
    const doc = await scrape(`${site.base}/shell`, { render: "auto" }, {
      render: async () => {
        throw new Error("no browser in test");
      },
    });
    expect(doc.warning).toContain("could not be rendered");
    expect(doc.metadata?.rendered).toBe(false);
  });

  it("uses the renderer when the page is a JS shell", async () => {
    const doc = await scrape(`${site.base}/shell`, { render: "auto" }, {
      render: async (url) => ({ html: "<html><body><main><h1>Rendered</h1></main></body></html>", status: 200, url, contentType: "text/html" }),
    });
    expect(doc.markdown).toContain("# Rendered");
    expect(doc.metadata?.rendered).toBe(true);
  });

  it("rejects non-http URLs", async () => {
    await expect(scrape("ftp://x.test/file")).rejects.toThrow(/Unsupported URL scheme/);
  });
});

describe("scrape (review regressions)", () => {
  it("keeps every article on a multi-article index page", async () => {
    const doc = await scrape(`${site.base}/articles`, { render: "never" });
    for (const n of [1, 2, 3, 4, 5, 6]) expect(doc.markdown).toContain(`Article ${n}`);
  });

  it("includeTags on page chrome returns that chrome", async () => {
    const doc = await scrape(`${site.base}/`, { includeTags: ["footer"], render: "never" });
    expect(doc.markdown).toContain("FOOTER-MARKER");
    const nav = await scrape(`${site.base}/`, { includeTags: ["nav"], render: "never" });
    expect(nav.markdown).toContain("NAV-MARKER");
  });

  it("returns rawHtml for non-HTML bodies", async () => {
    const doc = await scrape(`${site.base}/plain.txt`, { formats: ["rawHtml"], render: "never" });
    expect(doc.rawHtml).toBe("Hello plain text\nSecond line\n");
    expect(doc.html).toBeUndefined();
  });
});
