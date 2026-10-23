import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchFeed, looksLikeFeed, parseFeed } from "../src/feed.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

describe("feeds", () => {
  it("parses RSS 2.0 with content:encoded, dc:creator and categories", async () => {
    const feed = await fetchFeed(`${site.base}/feed.xml`);
    expect(feed).toMatchObject({ type: "rss", title: "Fixture Posts", description: "All the posts", link: `${site.base}/blog` });
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({
      id: `${site.base}/blog/post-1`,
      title: "Post 1",
      url: `${site.base}/blog/post-1`,
      published: "2026-01-02T10:00:00.000Z",
      author: "Ada",
      summary: "First post summary",
      categories: ["news", "fixtures"],
    });
    expect(feed.items[0]?.content).toContain("## Full");
    expect(feed.items[0]?.content).toContain("_content_");
    expect(feed.items[1]).toMatchObject({ title: "Post 2", summary: "Second summary" });
    expect(feed.items[1]?.content).toBeUndefined();
  });

  it("parses Atom and JSON Feed", async () => {
    const atom = await fetchFeed(`${site.base}/atom.xml`);
    expect(atom).toMatchObject({ type: "atom", title: "Fixture Atom", link: `${site.base}/blog`, updated: "2026-01-04T00:00:00.000Z" });
    expect(atom.items[0]).toMatchObject({
      id: "urn:post-2",
      title: "Atom Post 2",
      url: `${site.base}/blog/post-2`,
      published: "2026-01-03T09:00:00.000Z",
      updated: "2026-01-03T10:00:00.000Z",
      author: "Grace",
      summary: "Atom summary",
      content: "Atom **body**",
      categories: ["atom"],
    });
    const json = await fetchFeed(`${site.base}/feed.json`);
    expect(json).toMatchObject({ type: "json", title: "Fixture JSON Feed", link: `${site.base}/blog` });
    expect(json.items[0]).toMatchObject({ title: "JSON Post 1", url: `${site.base}/blog/post-1`, author: "Linus", summary: "json summary", content: "json body", categories: ["json"] });
  });

  it("discovers feeds from link tags, then by probing common paths", async () => {
    const fromLinks = await fetchFeed(`${site.base}/blog`);
    expect(fromLinks.discovered).toEqual([`${site.base}/feed.xml`, `${site.base}/atom.xml`]);
    expect(fromLinks.url).toBe(`${site.base}/feed.xml`);
    expect(fromLinks.items).toHaveLength(2);
    const probed = await fetchFeed(`${site.base}/nolink`);
    expect(probed.discovered).toEqual([`${site.base}/rss.xml`]);
    expect(probed.items[0]?.title).toBe("Probed item");
    await expect(fetchFeed(`${site.base}/docs/a`, { discover: false })).rejects.toThrow(/not a feed/);
  });

  it("applies since and limit, and can scrape the items", async () => {
    const recent = await fetchFeed(`${site.base}/feed.xml`, { since: "2026-01-03T00:00:00Z" });
    expect(recent.items.map((i) => i.title)).toEqual(["Post 2"]);
    const one = await fetchFeed(`${site.base}/feed.xml`, { limit: 1 });
    expect(one.items).toHaveLength(1);
    const scraped = await fetchFeed(`${site.base}/feed.xml`, { scrape: true, scrapeOptions: { render: "never" } });
    expect(scraped.items[0]?.document?.markdown).toContain("# Post 1");
    expect(scraped.items[1]?.document?.markdown).toContain("# Post 2");
  });

  it("recognises RDF feeds and rejects HTML", () => {
    const rdf = parseFeed(`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>RDF</title><link>https://r.test/</link></channel><item><title>One</title><link>https://r.test/one</link></item></rdf:RDF>`, "https://r.test/rss");
    expect(rdf).toMatchObject({ type: "rdf", title: "RDF" });
    expect(rdf.items[0]).toMatchObject({ title: "One", url: "https://r.test/one" });
    expect(looksLikeFeed("<html><body>no</body></html>", "text/html")).toBe(false);
    expect(looksLikeFeed('<?xml version="1.0"?><rss version="2.0"></rss>', "")).toBe(true);
    expect(looksLikeFeed('{"version":"https://jsonfeed.org/version/1.1","items":[]}', "")).toBe(true);
    expect(() => parseFeed("<html></html>", "https://x.test/")).toThrow(/not a recognised feed/);
  });
});
