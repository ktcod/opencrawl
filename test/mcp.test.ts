import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
let client: Client;
beforeAll(async () => {
  site = await startFixtureSite();
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});
afterAll(async () => {
  await client.close();
  await site.close();
});

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ type: string; text: string }>)[0]!.text;

describe("MCP server", () => {
  it("exposes the scrape, map, crawl, status, search and parse tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "batch_scrape",
      "check_crawl_status",
      "crawl",
      "extract",
      "feed",
      "map",
      "parse",
      "scrape",
      "search",
      "search_local",
      "watch",
    ]);
  });

  it("scrape returns raw markdown for markdown-only requests", async () => {
    const result = await client.callTool({ name: "scrape", arguments: { url: `${site.base}/docs/a`, render: "never" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("# Doc A");
  });

  it("scrape returns JSON for multi-format requests", async () => {
    const result = await client.callTool({ name: "scrape", arguments: { url: `${site.base}/docs/a`, formats: ["markdown", "links"], render: "never" } });
    const doc = JSON.parse(textOf(result));
    expect(doc.links).toContain(`${site.base}/docs/b`);
    expect(doc.metadata.title).toBe("Doc A");
  });

  it("map and crawl work end to end", async () => {
    const mapped = JSON.parse(textOf(await client.callTool({ name: "map", arguments: { url: site.base, sitemap: "only" } })));
    expect(mapped.links.map((l: { url: string }) => l.url)).toContain(`${site.base}/docs/a`);
    const crawled = JSON.parse(
      textOf(await client.callTool({ name: "crawl", arguments: { url: `${site.base}/docs/`, sitemap: "skip", limit: 2, scrapeOptions: { render: "never" } } })),
    );
    expect(crawled.status).toBe("completed");
    expect(crawled.data).toHaveLength(2);
    const status = JSON.parse(textOf(await client.callTool({ name: "check_crawl_status", arguments: { id: crawled.id } })));
    expect(status.completed).toBe(2);
  });

  it("watch and search_local work through MCP", async () => {
    const first = JSON.parse(textOf(await client.callTool({ name: "watch", arguments: { url: `${site.base}/docs/deep/d`, render: "never" } })));
    expect(first.status).toBe("new");
    const again = JSON.parse(textOf(await client.callTool({ name: "watch", arguments: { url: `${site.base}/docs/deep/d`, render: "never" } })));
    expect(again.status).toBe("same");
    const hits = JSON.parse(textOf(await client.callTool({ name: "search_local", arguments: { query: "Delta" } })));
    expect(hits.data[0].url).toBe(`${site.base}/docs/deep/d`);
  });

  it("extract works through MCP with nested selectors", async () => {
    const result = JSON.parse(
      textOf(await client.callTool({ name: "extract", arguments: { url: `${site.base}/structured`, structured: ["openGraph"], tables: false, selectors: { products: { selector: ".product", multiple: true, fields: { name: ".name" } } }, render: "never" } })),
    );
    expect(result.openGraph["og:title"]).toBe("OG Title");
    expect(result.selected.products).toEqual([{ name: "Alpha" }, { name: "Beta" }]);
  });

  it("batch_scrape and feed work through MCP", async () => {
    const batch = JSON.parse(textOf(await client.callTool({ name: "batch_scrape", arguments: { urls: [`${site.base}/docs/a`, `${site.base}/docs/b`], render: "never" } })));
    expect(batch.completed).toBe(2);
    const feed = JSON.parse(textOf(await client.callTool({ name: "feed", arguments: { url: `${site.base}/atom.xml` } })));
    expect(feed.data.items[0].title).toBe("Atom Post 2");
  });

  it("reports tool errors with isError", async () => {
    const result = await client.callTool({ name: "parse", arguments: { filePath: "/definitely/not/here.pdf" } });
    expect(result.isError).toBe(true);
  });
});
