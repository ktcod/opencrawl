import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { map } from "../src/map.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

const urls = (links: Array<{ url: string }>) => links.map((l) => l.url);

describe("map", () => {
  it("merges sitemap entries and start-page links, same site only", async () => {
    const result = await map(`${site.base}/`);
    const found = urls(result.links);
    expect(found).toContain(`${site.base}/`);
    expect(found).toContain(`${site.base}/docs/`);
    expect(found).toContain(`${site.base}/docs/a`);
    expect(found).toContain(`${site.base}/sitemap-only`);
    expect(found).toContain(`${site.base}/blog/post-1`);
    expect(found).not.toContain("https://example.org/external");
    expect(found.filter((u) => u.startsWith(`${site.base}/docs/a`))).toEqual([`${site.base}/docs/a`, `${site.base}/docs/a?ref=home`]);
    expect(result.links.find((l) => l.url === `${site.base}/docs/a`)?.title).toBe("Doc A");
  });

  it("sitemap: only skips link discovery", async () => {
    const result = await map(`${site.base}/`, { sitemap: "only" });
    const found = urls(result.links);
    expect(found).toContain(`${site.base}/sitemap-only`);
    expect(found).not.toContain(`${site.base}/docs/`);
  });

  it("sitemap: skip ignores the sitemap", async () => {
    const result = await map(`${site.base}/`, { sitemap: "skip" });
    const found = urls(result.links);
    expect(found).not.toContain(`${site.base}/sitemap-only`);
    expect(found).toContain(`${site.base}/docs/a`);
  });

  it("ignoreQueryParameters collapses query variants", async () => {
    const result = await map(`${site.base}/`, { ignoreQueryParameters: true });
    expect(urls(result.links).filter((u) => u.startsWith(`${site.base}/docs/a`))).toEqual([`${site.base}/docs/a`]);
  });

  it("search ranks matching links first and drops non-matches", async () => {
    const result = await map(`${site.base}/`, { search: "blog" });
    expect(result.links.length).toBeGreaterThan(0);
    expect(result.links[0]?.url).toBe(`${site.base}/blog/post-1`);
    expect(urls(result.links).every((u) => u.includes("blog"))).toBe(true);
  });

  it("limit caps the result", async () => {
    const result = await map(`${site.base}/`, { limit: 2 });
    expect(result.links).toHaveLength(2);
  });
});
