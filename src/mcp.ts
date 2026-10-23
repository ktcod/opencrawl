import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { closeBrowser } from "./browser.js";
import { VERSION } from "./config.js";
import { crawl, getCrawlStatus } from "./crawl.js";
import { batchScrape, saveDocuments } from "./batch.js";
import { extract } from "./extract.js";
import { fetchFeed } from "./feed.js";
import { map } from "./map.js";
import { parseFile } from "./parse.js";
import { crawlOptionShape, extractOptionShape, resolveScrapeOptions, scrapeOptionShape, scrapeOptionsSchema } from "./schemas.js";
import { scrape } from "./scrape.js";
import { search } from "./search.js";
import { getStore } from "./store.js";
import { watch } from "./watch.js";
import type { Document as ScrapedDocument } from "./types.js";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

function failure(err: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
}

/** Markdown-only requests get raw markdown; anything else gets the JSON document. */
function renderDocument(doc: ScrapedDocument, formats: Array<string | { type: string }> | undefined) {
  const requested = (formats ?? ["markdown"]).map((f) => (typeof f === "string" ? f : f.type).toLowerCase());
  if (requested.length === 1 && requested[0] === "markdown" && typeof doc.markdown === "string") {
    const header = doc.warning ? `> warning: ${doc.warning}\n\n` : "";
    return text(header + doc.markdown);
  }
  return json(doc);
}

const sourceEnum = z.enum(["web", "news", "images"]);

/**
 * MCP server exposing scrape, map, crawl, check_crawl_status, search and
 * parse. Set OPENCRAWL_TOOL_PREFIX to prefix every tool name, for example
 * when an existing prompt expects a particular naming scheme.
 */
export function createMcpServer(): McpServer {
  const prefix = process.env.OPENCRAWL_TOOL_PREFIX ?? "";
  const server = new McpServer({ name: "opencrawl", version: VERSION });

  server.registerTool(
    `${prefix}scrape`,
    {
      title: "Scrape a URL",
      description:
        "Scrape one URL and return its content as markdown (default), html, rawHtml, links, images or a screenshot. Runs locally: plain HTTP first, headless Chromium when the page needs JavaScript. Formats that need an LLM (json, summary, query, changeTracking, branding) are not available and produce a warning.",
      inputSchema: { url: z.string().min(1), ...scrapeOptionShape },
    },
    async ({ url, ...args }) => {
      try {
        const doc = await scrape(url, resolveScrapeOptions(args));
        return renderDocument(doc, args.formats);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    `${prefix}map`,
    {
      title: "Map a site's URLs",
      description:
        "List the URLs of a website from its sitemap and the links on its pages, without fetching every page. Use `search` to rank URLs by a keyword.",
      inputSchema: {
        url: z.string().min(1),
        search: z.string().optional(),
        sitemap: z.enum(["include", "skip", "only"]).optional(),
        includeSubdomains: z.boolean().optional(),
        ignoreQueryParameters: z.boolean().optional(),
        limit: z.number().int().min(1).max(100_000).optional(),
      },
    },
    async ({ url, ...options }) => {
      try {
        const result = await map(url, options);
        return json({ success: true, links: result.links });
      } catch (err) {
        return failure(err);
      }
    },
  );

  const { ignoreRobotsTxt: _ignoreRobots, robotsUserAgent: _robotsUa, webhook: _webhook, ...mcpCrawlShape } = crawlOptionShape;
  server.registerTool(
    `${prefix}crawl`,
    {
      title: "Crawl a site",
      description:
        "Crawl a website starting at a URL, following links within scope, and return the scraped pages when the crawl finishes. Keep `limit` small; default is 100 pages. Pass `outDir` to also write every page as files under <outDir>/<host>/<path>/ (index.md and friends) and get the paths back instead of the full content.",
      inputSchema: { url: z.string().min(1), outDir: z.string().min(1).max(4096).optional(), ...mcpCrawlShape },
    },
    async ({ url, outDir, scrapeOptions, prompt: _prompt, ...options }) => {
      try {
        const job = await crawl(url, { ...options, scrapeOptions: scrapeOptions ? resolveScrapeOptions(scrapeOptions) : undefined });
        if (outDir) {
          const { data, ...rest } = job;
          const saved = await saveDocuments(data, outDir);
          return json({ success: true, ...rest, outDir: saved.outDir, saved: saved.saved.map((s) => ({ url: s.url, dir: s.dir, files: s.files.length })), saveErrors: saved.errors });
        }
        return json({ success: true, ...job });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    `${prefix}batch_scrape`,
    {
      title: "Scrape many URLs",
      description:
        "Scrape a list of URLs in parallel and return the documents in input order, with per-URL errors listed separately. Same options as scrape. Pass `outDir` to write each page as files instead of returning content.",
      inputSchema: {
        urls: z.array(z.string().min(1)).min(1).max(1000),
        concurrency: z.number().int().min(1).max(20).optional(),
        outDir: z.string().min(1).max(4096).optional(),
        ...scrapeOptionShape,
      },
    },
    async ({ urls, concurrency, outDir, ...args }) => {
      try {
        const result = await batchScrape(urls, { concurrency, ignoreInvalidURLs: true, scrapeOptions: resolveScrapeOptions(args) });
        if (outDir) {
          const saved = await saveDocuments(result.data, outDir);
          return json({ success: true, total: result.total, completed: result.completed, errors: result.errors, outDir: saved.outDir, saved: saved.saved.map((s) => ({ url: s.url, dir: s.dir, files: s.files.length })), saveErrors: saved.errors });
        }
        return json({ success: true, ...result });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    `${prefix}feed`,
    {
      title: "Read a site's feed",
      description:
        "Fetch and parse an RSS, Atom, RSS 1.0 or JSON feed. Given an ordinary page URL, discovers the feed from its <link rel=\"alternate\"> tags or the usual paths (/feed, /rss.xml, /atom.xml, ...). Returns normalized items (title, url, published, author, summary, content as markdown). Set `scrape: true` to also fetch each item's page.",
      inputSchema: {
        url: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional(),
        since: z.string().optional(),
        scrape: z.boolean().optional(),
        render: z.enum(["auto", "always", "never"]).optional(),
      },
    },
    async ({ url, render, ...options }) => {
      try {
        return json({ success: true, data: await fetchFeed(url, { ...options, scrapeOptions: { render } }) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    `${prefix}check_crawl_status`,
    {
      title: "Check crawl status",
      description: "Return the status, progress and collected pages of a crawl started in this process.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      const job = getCrawlStatus(id);
      if (!job) return failure(new Error(`Crawl job not found: ${id}`));
      return json({ success: true, ...job });
    },
  );

  server.registerTool(
    `${prefix}search`,
    {
      title: "Search the web",
      description:
        "Search the web and return ranked results (url, title, description). Backend: DuckDuckGo by default, SearXNG when SEARXNG_URL is set, Brave when BRAVE_SEARCH_API_KEY is set. Set scrapeOptions to also fetch each result's content.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        sources: z.array(z.union([sourceEnum, z.object({ type: sourceEnum })])).optional(),
        categories: z.array(z.enum(["github", "research", "pdf"])).optional(),
        includeDomains: z.array(z.string()).optional(),
        excludeDomains: z.array(z.string()).optional(),
        tbs: z.string().optional(),
        location: z.string().optional(),
        country: z.string().optional(),
        timeout: z.number().optional(),
        scrapeOptions: scrapeOptionsSchema.optional(),
      },
    },
    async ({ scrapeOptions, ...request }) => {
      try {
        const result = await search({ ...request, scrapeOptions: scrapeOptions ? resolveScrapeOptions(scrapeOptions) : undefined });
        return json({ success: true, ...result });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    `${prefix}extract`,
    {
      title: "Extract structured data",
      description:
        "Pull structured data from a page without a language model: JSON-LD, microdata, Open Graph, Twitter card and meta tags (structured, default all), values matched by CSS selectors (selectors: { name: \"css\" } or { name: { selector, attribute?, type?, multiple?, fields? } }), and HTML tables as JSON rows (tables: true, or { csv: true } to also get CSV). Exact values, no hallucination; use this before asking a model to read a page.",
      inputSchema: {
        url: z.string().min(1),
        ...extractOptionShape,
        waitFor: z.number().min(0).max(60_000).optional(),
        render: z.enum(["auto", "always", "never"]).optional(),
        maxAge: z.number().optional(),
      },
    },
    async ({ url, waitFor, render, maxAge, ...options }) => {
      try {
        return json(await extract(url, { ...options, scrapeOptions: { waitFor, render, maxAge } }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    `${prefix}search_local`,
    {
      title: "Search previously scraped pages",
      description:
        "Full-text search over every page this opencrawl store has scraped or crawled (titles and markdown). Works offline. Returns one hit per URL with a snippet and when it was fetched. Use `site` to restrict to a host and `since` (ISO date) to restrict by fetch time.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        site: z.string().optional(),
        since: z.string().optional(),
      },
    },
    async ({ query, ...options }) => {
      try {
        return json({ success: true, data: getStore().searchLocal(query, options) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    `${prefix}watch`,
    {
      title: "Check a page for changes",
      description:
        "Re-scrape a URL and compare it with the last snapshot in the store. Returns status new (first check), same, changed (with a unified diff of the markdown and line counts), removed (404/410 after a baseline) or error. Call it again later to see what changed since.",
      inputSchema: {
        url: z.string().min(1),
        diff: z.boolean().optional(),
        onlyMainContent: z.boolean().optional(),
        includeTags: z.array(z.string()).optional(),
        excludeTags: z.array(z.string()).optional(),
        waitFor: z.number().min(0).max(60_000).optional(),
        render: z.enum(["auto", "always", "never"]).optional(),
      },
    },
    async ({ url, diff, ...scrapeOptions }) => {
      try {
        return json(await watch(url, { diff, scrapeOptions }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    `${prefix}parse`,
    {
      title: "Parse a local file",
      description: "Parse a local PDF, HTML or plain-text file into markdown (and optionally html or links).",
      inputSchema: {
        filePath: z.string().min(1),
        formats: z.array(z.enum(["markdown", "html", "rawHtml", "links"])).optional(),
        onlyMainContent: z.boolean().optional(),
        includeTags: z.array(z.string()).optional(),
        excludeTags: z.array(z.string()).optional(),
        pdfOptions: z.object({ maxPages: z.number().int().min(1).optional() }).optional(),
      },
    },
    async ({ filePath, ...options }) => {
      try {
        const doc = await parseFile(filePath, options);
        return renderDocument(doc, options.formats);
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

/**
 * Serve over stdio. When the client goes away (stdin ends) the browser is
 * closed and the process exits, so no headless Chromium outlives the session.
 */
export async function runStdioServer(): Promise<McpServer> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeBrowser();
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  transport.onclose = () => void shutdown();
  process.stdin.once("end", () => void shutdown());
  process.stdin.once("close", () => void shutdown());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown());
  await server.connect(transport);
  return server;
}
