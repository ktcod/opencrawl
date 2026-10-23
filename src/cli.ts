#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { VERSION } from "./config.js";
import { activeBrowserChannel, closeBrowser, isBrowserAvailable } from "./browser.js";
import { crawl } from "./crawl.js";
import { startServer } from "./http.js";
import { map } from "./map.js";
import { runStdioServer } from "./mcp.js";
import { parseFile } from "./parse.js";
import { scrape } from "./scrape.js";
import { resolveBackend, search } from "./search.js";
import type { FormatOption } from "./types.js";

const HELP = `opencrawl ${VERSION} - local, keyless web scraper (MCP server, HTTP API, CLI)

Usage:
  opencrawl mcp                         Run the MCP server on stdio (tools: scrape, map, crawl, check_crawl_status, search, parse)
  opencrawl serve [--port 3002] [--host 127.0.0.1]
                                         Serve the v2-style HTTP API on http://127.0.0.1:3002
  opencrawl scrape <url> [-f markdown,links] [--only-main-content | --no-main-content] [--wait-for ms] [--render auto|always|never] [--json] [-o file]
  opencrawl map <url> [--search q] [--limit n] [--sitemap include|skip|only] [--json] [-o file]
  opencrawl crawl <url> [--limit n] [--max-depth n] [--include-paths a,b] [--exclude-paths a,b] [--entire-domain] [-o file]
  opencrawl search <query> [--limit n] [--scrape] [--json] [-o file]
  opencrawl parse <file> [-f markdown,links] [--json] [-o file]
  opencrawl doctor                      Check browser and search backend availability

Environment:
  OPENCRAWL_BROWSER        auto|chromium|chrome|msedge|none (default auto)
  SEARXNG_URL               Use a SearXNG instance for search
  BRAVE_SEARCH_API_KEY      Use Brave Search for search
  OPENCRAWL_API_KEY        Require this bearer token on the HTTP API
  OPENCRAWL_CRAWL_LIMIT    Default crawl page cap (100)
`;

/** Write to a file, or to stdout and wait for the pipe to drain (process.exit would truncate it). */
async function emit(content: string, outPath?: string): Promise<void> {
  if (outPath) {
    await writeFile(outPath, content, "utf8");
    process.stderr.write(`Saved: ${outPath}\n`);
    return;
  }
  const text = content.endsWith("\n") ? content : `${content}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

async function shutdown(code: number): Promise<never> {
  await closeBrowser();
  process.exit(code);
}

function list(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  switch (command) {
    case "mcp": {
      await runStdioServer();
      return -1; // keep running; runStdioServer exits when stdin closes
    }
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { port: { type: "string" }, host: { type: "string" } } });
      const { port, hostname } = startServer({ port: values.port ? Number(values.port) : undefined, host: values.host });
      process.stderr.write(`opencrawl API listening on http://${hostname}:${port}\n`);
      process.stderr.write(`  API base URL for clients: http://${hostname}:${port}\n`);
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(0));
      return -1;
    }
    case "scrape": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          format: { type: "string", short: "f" },
          "only-main-content": { type: "boolean" },
          "no-main-content": { type: "boolean" },
          "wait-for": { type: "string" },
          render: { type: "string" },
          json: { type: "boolean" },
          output: { type: "string", short: "o" },
          "include-tags": { type: "string" },
          "exclude-tags": { type: "string" },
        },
      });
      const url = positionals[0];
      if (!url) throw new Error("scrape needs a URL");
      const formats = (list(values.format) ?? ["markdown"]) as FormatOption[];
      const doc = await scrape(url, {
        formats,
        onlyMainContent: values["no-main-content"] ? false : values["only-main-content"] ? true : undefined,
        waitFor: values["wait-for"] ? Number(values["wait-for"]) : undefined,
        render: values.render as "auto" | "always" | "never" | undefined,
        includeTags: list(values["include-tags"]),
        excludeTags: list(values["exclude-tags"]),
      });
      if (doc.warning) process.stderr.write(`warning: ${doc.warning}\n`);
      if (!values.json && formats.length === 1 && formats[0] === "markdown" && doc.markdown !== undefined) {
        await emit(doc.markdown, values.output);
      } else {
        await emit(JSON.stringify({ success: true, data: doc }, null, 2), values.output);
      }
      return 0;
    }
    case "map": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          search: { type: "string" },
          limit: { type: "string" },
          sitemap: { type: "string" },
          "include-subdomains": { type: "boolean" },
          json: { type: "boolean" },
          output: { type: "string", short: "o" },
        },
      });
      const url = positionals[0];
      if (!url) throw new Error("map needs a URL");
      const result = await map(url, {
        search: values.search,
        limit: values.limit ? Number(values.limit) : undefined,
        sitemap: values.sitemap as "include" | "skip" | "only" | undefined,
        includeSubdomains: values["include-subdomains"],
      });
      if (values.json) await emit(JSON.stringify({ success: true, data: result }, null, 2), values.output);
      else await emit(result.links.map((l) => l.url).join("\n"), values.output);
      return 0;
    }
    case "crawl": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          limit: { type: "string" },
          "max-depth": { type: "string" },
          "include-paths": { type: "string" },
          "exclude-paths": { type: "string" },
          "entire-domain": { type: "boolean" },
          "allow-subdomains": { type: "boolean" },
          sitemap: { type: "string" },
          format: { type: "string", short: "f" },
          output: { type: "string", short: "o" },
        },
      });
      const url = positionals[0];
      if (!url) throw new Error("crawl needs a URL");
      const job = await crawl(url, {
        limit: values.limit ? Number(values.limit) : undefined,
        maxDiscoveryDepth: values["max-depth"] ? Number(values["max-depth"]) : undefined,
        includePaths: list(values["include-paths"]),
        excludePaths: list(values["exclude-paths"]),
        crawlEntireDomain: values["entire-domain"],
        allowSubdomains: values["allow-subdomains"],
        sitemap: values.sitemap as "include" | "skip" | "only" | undefined,
        scrapeOptions: values.format ? { formats: list(values.format) as FormatOption[] } : undefined,
      });
      process.stderr.write(`Crawled ${job.completed} page(s), status ${job.status}\n`);
      await emit(JSON.stringify({ success: true, ...job }, null, 2), values.output);
      return 0;
    }
    case "search": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          limit: { type: "string" },
          scrape: { type: "boolean" },
          tbs: { type: "string" },
          json: { type: "boolean" },
          output: { type: "string", short: "o" },
        },
      });
      const query = positionals.join(" ").trim();
      if (!query) throw new Error("search needs a query");
      const result = await search({
        query,
        limit: values.limit ? Number(values.limit) : undefined,
        tbs: values.tbs,
        scrapeOptions: values.scrape ? { formats: ["markdown"] } : undefined,
      });
      if (result.warning) process.stderr.write(`warning: ${result.warning}\n`);
      if (values.json || values.scrape) {
        await emit(JSON.stringify({ success: true, data: result.data, backend: result.backend }, null, 2), values.output);
      } else {
        const lines: string[] = [];
        for (const r of result.data.web ?? []) {
          lines.push(r.title ?? "Untitled", `  URL: ${r.url}`);
          if (r.description) lines.push(`  ${r.description}`);
          lines.push("");
        }
        await emit(lines.join("\n") || "No results found.", values.output);
      }
      return 0;
    }
    case "parse": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { format: { type: "string", short: "f" }, json: { type: "boolean" }, output: { type: "string", short: "o" } },
      });
      const file = positionals[0];
      if (!file) throw new Error("parse needs a file path");
      const formats = (list(values.format) ?? ["markdown"]) as FormatOption[];
      const doc = await parseFile(file, { formats });
      if (!values.json && formats.length === 1 && formats[0] === "markdown" && doc.markdown !== undefined) {
        await emit(doc.markdown, values.output);
      } else {
        await emit(JSON.stringify({ success: true, data: doc }, null, 2), values.output);
      }
      return 0;
    }
    case "doctor": {
      const browser = await isBrowserAvailable();
      process.stdout.write(`browser: ${browser ? `ok (${activeBrowserChannel()})` : "unavailable (set OPENCRAWL_BROWSER or run: npx playwright install chromium)"}\n`);
      try {
        process.stdout.write(`search backend: ${resolveBackend().name}\n`);
      } catch (err) {
        process.stdout.write(`search backend: error (${(err as Error).message})\n`);
      }
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then(async (code) => {
    if (code >= 0) await shutdown(code);
  })
  .catch(async (err: Error) => {
    await new Promise<void>((resolve) => process.stderr.write(`Error: ${err.message}\n`, () => resolve()));
    await shutdown(1);
  });
