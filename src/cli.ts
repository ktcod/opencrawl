#!/usr/bin/env node
import "./quiet.js";
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { VERSION } from "./config.js";
import { activeBrowserChannel, closeBrowser, isBrowserAvailable } from "./browser.js";
import { batchScrape, saveDocuments } from "./batch.js";
import { crawl } from "./crawl.js";
import { fetchFeed } from "./feed.js";
import { extract } from "./extract.js";
import type { SelectorSpec } from "./extract.js";
import { startServer } from "./http.js";
import { map } from "./map.js";
import { runStdioServer } from "./mcp.js";
import { parseFile } from "./parse.js";
import { scrape } from "./scrape.js";
import { resolveBackend, search } from "./search.js";
import { getStore } from "./store.js";
import { watch } from "./watch.js";
import type { FormatOption } from "./types.js";

const HELP = `opencrawl ${VERSION} - local, keyless web scraper (MCP server, HTTP API, CLI)

Usage:
  opencrawl mcp                         Run the MCP server on stdio (tools: scrape, map, crawl, check_crawl_status, search, parse)
  opencrawl serve [--port 3002] [--host 127.0.0.1]
                                         Serve the v2-style HTTP API on http://127.0.0.1:3002
  opencrawl scrape <url> [-f markdown,links] [--only-main-content | --no-main-content] [--wait-for ms] [--render auto|always|never] [--max-age ms] [--json] [-o file]
  opencrawl scrape <url> <url> ... [--concurrency n] [--out-dir dir]
                                         Batch: several URLs in parallel; JSON to stdout or files under --out-dir
  opencrawl map <url> [--search q] [--limit n] [--sitemap include|skip|only] [--json] [-o file]
  opencrawl crawl <url> [--limit n] [--max-depth n] [--include-paths a,b] [--exclude-paths a,b] [--entire-domain] [-o file] [--out-dir dir]
                                         --out-dir writes every page to <dir>/<host>/<path>/index.md (plus other formats)
  opencrawl feed <url> [--limit n] [--since iso] [--scrape] [--json]
                                         Parse an RSS/Atom/JSON feed, or discover one from a page
  opencrawl search <query> [--limit n] [--scrape] [--json] [-o file]
  opencrawl extract <url> [--select name=css[@attr][*]]... [--no-structured] [--no-tables] [--csv] [-o file]
                                         JSON-LD, microdata, Open Graph, meta, CSS selections and tables (no LLM)
  opencrawl search-local <query> [--limit n] [--site host] [--since iso] [--json]
                                         Full-text search over everything already scraped (offline)
  opencrawl watch <url> [--no-diff] [--json]   Re-scrape and report new | same | changed (+diff) | removed
  opencrawl watch --list                 List watched URLs
  opencrawl parse <file> [-f markdown,links] [--json] [-o file]   PDF, DOCX, XLSX, HTML, text
  opencrawl doctor                      Check browser and search backend availability

Environment:
  OPENCRAWL_BROWSER        auto|chromium|chrome|msedge|none (default auto)
  SEARXNG_URL               Use a SearXNG instance for search
  BRAVE_SEARCH_API_KEY      Use Brave Search for search
  OPENCRAWL_API_KEY        Require this bearer token on the HTTP API
  OPENCRAWL_CRAWL_LIMIT    Default crawl page cap (100)
  OPENCRAWL_DB              SQLite store path (default ~/.opencrawl/opencrawl.db)
  OPENCRAWL_DEFAULT_MAX_AGE_MS  Cache window when a request sets no maxAge (0 = always fresh)
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
          "max-age": { type: "string" },
          render: { type: "string" },
          json: { type: "boolean" },
          output: { type: "string", short: "o" },
          "out-dir": { type: "string" },
          concurrency: { type: "string" },
          "include-tags": { type: "string" },
          "exclude-tags": { type: "string" },
        },
      });
      if (positionals.length === 0) throw new Error("scrape needs a URL");
      const formats = (list(values.format) ?? ["markdown"]) as FormatOption[];
      const scrapeOptions = {
        formats,
        onlyMainContent: values["no-main-content"] ? false : values["only-main-content"] ? true : undefined,
        waitFor: values["wait-for"] ? Number(values["wait-for"]) : undefined,
        maxAge: values["max-age"] ? Number(values["max-age"]) : undefined,
        render: values.render as "auto" | "always" | "never" | undefined,
        includeTags: list(values["include-tags"]),
        excludeTags: list(values["exclude-tags"]),
      };
      if (positionals.length > 1 || values["out-dir"]) {
        const result = await batchScrape(positionals, { scrapeOptions, ignoreInvalidURLs: true, concurrency: values.concurrency ? Number(values.concurrency) : undefined });
        for (const e of result.errors) process.stderr.write(`error: ${e.url}: ${e.error}\n`);
        if (values["out-dir"]) {
          const saved = await saveDocuments(result.data, values["out-dir"]);
          for (const s of saved.saved) process.stderr.write(`saved: ${s.dir} (${s.files.length} files)\n`);
          process.stderr.write(`${saved.saved.length}/${result.total} pages written under ${saved.outDir}\n`);
          return result.errors.length === result.total ? 1 : 0;
        }
        await emit(JSON.stringify({ success: true, ...result }, null, 2), values.output);
        return result.errors.length === result.total ? 1 : 0;
      }
      const doc = await scrape(positionals[0]!, scrapeOptions);
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
          "out-dir": { type: "string" },
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
      if (values["out-dir"]) {
        const saved = await saveDocuments(job.data, values["out-dir"]);
        for (const s of saved.saved) process.stderr.write(`saved: ${s.dir} (${s.files.length} files)\n`);
        for (const e of saved.errors) process.stderr.write(`error: ${e.url}: ${e.error}\n`);
        process.stderr.write(`${saved.saved.length} page(s) written under ${saved.outDir}\n`);
        return 0;
      }
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
    case "feed": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { limit: { type: "string" }, since: { type: "string" }, scrape: { type: "boolean" }, json: { type: "boolean" }, output: { type: "string", short: "o" }, render: { type: "string" } },
      });
      const url = positionals[0];
      if (!url) throw new Error("feed needs a URL");
      const feed = await fetchFeed(url, {
        limit: values.limit ? Number(values.limit) : undefined,
        since: values.since,
        scrape: values.scrape,
        scrapeOptions: { render: values.render as "auto" | "always" | "never" | undefined },
      });
      if (values.json || values.scrape) {
        await emit(JSON.stringify({ success: true, data: feed }, null, 2), values.output);
      } else {
        const lines = [`${feed.title ?? "Untitled feed"} (${feed.type}) ${feed.url}`, ""];
        for (const item of feed.items) lines.push(item.title ?? "Untitled", `  URL: ${item.url ?? "-"}`, `  Date: ${item.published ?? item.updated ?? "-"}`, item.summary ? `  ${item.summary.slice(0, 200)}` : "", "");
        await emit(lines.join("\n"), values.output);
      }
      return 0;
    }
    case "extract": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          select: { type: "string", multiple: true },
          "no-structured": { type: "boolean" },
          "no-tables": { type: "boolean" },
          csv: { type: "boolean" },
          render: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      const url = positionals[0];
      if (!url) throw new Error("extract needs a URL");
      const selectors: Record<string, SelectorSpec> = {};
      for (const raw of values.select ?? []) {
        // name=selector[@attribute][*]
        const match = /^([^=]+)=(.+?)(?:@([\w:-]+))?(\*)?$/.exec(raw);
        if (!match) throw new Error(`--select expects name=selector[@attribute][*], got "${raw}"`);
        const [, name, selector, attribute, star] = match;
        selectors[name!.trim()] = { selector: selector!.trim(), attribute: attribute || undefined, multiple: star === "*" };
      }
      const result = await extract(url, {
        structured: !values["no-structured"],
        tables: values["no-tables"] ? false : { csv: !!values.csv },
        selectors: Object.keys(selectors).length ? selectors : undefined,
        scrapeOptions: { render: values.render as "auto" | "always" | "never" | undefined },
      });
      if (values.csv && result.tables?.length) {
        await emit(result.tables.map((t) => `# table ${t.index}${t.caption ? `: ${t.caption}` : ""}\n${t.csv ?? ""}`).join("\n\n"), values.output);
      } else {
        await emit(JSON.stringify({ success: true, data: result }, null, 2), values.output);
      }
      return 0;
    }
    case "search-local": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { limit: { type: "string" }, site: { type: "string" }, since: { type: "string" }, json: { type: "boolean" }, output: { type: "string", short: "o" } },
      });
      const query = positionals.join(" ").trim();
      if (!query) throw new Error("search-local needs a query");
      const hits = getStore().searchLocal(query, { limit: values.limit ? Number(values.limit) : undefined, site: values.site, since: values.since });
      if (values.json) {
        await emit(JSON.stringify({ success: true, data: hits }, null, 2), values.output);
      } else {
        const lines = hits.flatMap((h) => [h.title ?? "Untitled", `  URL: ${h.url}`, `  Fetched: ${h.fetchedAt}`, `  ${h.snippet}`, ""]);
        await emit(lines.join("\n") || "No local results.", values.output);
      }
      return 0;
    }
    case "watch": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { list: { type: "boolean" }, "no-diff": { type: "boolean" }, json: { type: "boolean" }, output: { type: "string", short: "o" }, render: { type: "string" } },
      });
      if (values.list) {
        const watches = getStore().listWatches();
        const lines = watches.map((w) => `${w.url}\tchecks=${w.checkCount}\tlastChanged=${w.lastChangedAt ? new Date(w.lastChangedAt).toISOString() : "never"}`);
        await emit(lines.join("\n") || "No watches yet.", values.output);
        return 0;
      }
      const url = positionals[0];
      if (!url) throw new Error("watch needs a URL (or --list)");
      const result = await watch(url, { diff: !values["no-diff"], scrapeOptions: { render: values.render as "auto" | "always" | "never" | undefined } });
      if (values.json) {
        await emit(JSON.stringify(result, null, 2), values.output);
      } else {
        const head = `${result.status.toUpperCase()}  ${result.url}` + (result.error ? `  (${result.error})` : "") + (result.linesAdded !== undefined ? `  +${result.linesAdded} -${result.linesRemoved}` : "");
        await emit(result.diff ? `${head}\n\n${result.diff}` : head, values.output);
      }
      return result.status === "error" ? 1 : 0;
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
      const store = getStore();
      process.stdout.write(`store: ${store.path} (${store.countDocuments()} documents, ${store.listWatches().length} watches)\n`);
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
