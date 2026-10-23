# opencrawl

Local, keyless web scraping for agents and scripts. One Node process gives you an MCP
server, a v2-style HTTP API, a CLI and a TypeScript library that turn web pages into clean
markdown. No account, no credits, no data leaving your machine except the requests you
make to the sites you scrape.

- **MCP server** with `scrape`, `map`, `crawl`, `check_crawl_status`, `search`, `parse`,
  `search_local` and `watch` tools for Claude Code and any other MCP client.
- **Local store** (SQLite, no server): every scrape and crawl is saved. `maxAge` serves
  repeat requests from it, `search_local` full-text searches everything you have ever
  scraped (offline), crawl jobs survive restarts, and `watch` tells you what changed on a
  page since you last looked, with a unified diff.
- **HTTP API** (`/v2/scrape`, `/v2/map`, `/v2/crawl`, `/v2/search`, `/v2/parse`) with
  `{ success, data }` envelopes, so clients that let you override their API base URL can
  point at it.
- **CLI** and **library** for direct use.
- Plain HTTP first; headless Chromium only when a page is a JavaScript shell or when you ask
  for a screenshot or `waitFor`. Uses your installed Google Chrome when Playwright's bundled
  Chromium is missing.

## Install

```bash
git clone https://github.com/ktcod/opencrawl
cd opencrawl
npm install         # Node 22.13 or newer (built-in SQLite)
npm run build
npm link            # puts `opencrawl` on your PATH
opencrawl doctor    # checks browser + search backend
```

If `doctor` reports no browser, either install Google Chrome or run
`npx playwright install chromium`.

## Use it from Claude Code (MCP)

```bash
claude mcp add --scope user opencrawl -- opencrawl mcp
```

Or edit `~/.claude.json`:

```json
{
  "mcpServers": {
    "opencrawl": { "command": "opencrawl", "args": ["mcp"] }
  }
}
```

Tools are registered as `scrape`, `map`, `crawl`, `check_crawl_status`, `search`, `parse`,
`search_local` and `watch`. Set `OPENCRAWL_TOOL_PREFIX` to prefix them if an existing
prompt expects other names.

## Use the HTTP API

```bash
opencrawl serve                # http://127.0.0.1:3002
curl -s http://127.0.0.1:3002/v2/scrape \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown","links"]}'
```

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /v2/scrape` | `{ url, formats?, onlyMainContent?, includeTags?, excludeTags?, waitFor?, timeout?, mobile?, headers?, render? }` | `{ success, data: Document }` |
| `POST /v2/map` | `{ url, search?, sitemap?, includeSubdomains?, ignoreQueryParameters?, limit? }` | `{ success, links: [{ url, title? }] }` |
| `POST /v2/crawl` | `{ url, limit?, maxDiscoveryDepth?, includePaths?, excludePaths?, sitemap?, crawlEntireDomain?, allowSubdomains?, allowExternalLinks?, delay?, maxConcurrency?, scrapeOptions? }` | `{ success, id, url }` |
| `GET /v2/crawl/:id?skip=0&limit=200` | | `{ success, status, total, completed, data: Document[], next }`; `next` is the URL of the following page or `null` |
| `GET /v2/crawl/:id/errors` | | `{ success, errors, robotsBlocked }` |
| `DELETE /v2/crawl/:id` | | `{ success, status: "cancelled" }` |
| `POST /v2/search` | `{ query, limit?, sources?, tbs?, includeDomains?, excludeDomains?, scrapeOptions? }` | `{ success, data: { web, news, images } }` |
| `POST /v2/parse` | multipart `file` (+ `options` JSON), or `{ filePath }` from localhost | `{ success, data: Document }` |
| `POST /v2/watch` | `{ url, diff?, scrapeOptions? }` | `{ success, status: new \| same \| changed \| removed \| error, previous, current, diff?, linesAdded?, linesRemoved? }` |
| `GET /v2/watches` | | `{ success, watches: [{ url, checkCount, lastCheckedAt, lastChangedAt }] }` |
| `POST /v2/local-search` | `{ query, limit?, site?, since? }` | `{ success, data: [{ url, title, snippet, fetchedAt, score }] }` |

A `Document` is `{ markdown?, html?, rawHtml?, links?, images?, screenshot?, metadata }`
where `metadata` carries `title`, `description`, `language`, `sourceURL`, `url`,
`statusCode`, `contentType` and the usual Open Graph fields.

The API refuses to bind a non-loopback address without `OPENCRAWL_API_KEY`; with a key,
every `/v2` request needs `Authorization: Bearer <token>`. Browser requests (any `Origin`
header), unexpected `Host` headers and non-JSON bodies are refused, so a web page cannot
drive the scraper. `/v2/parse` only accepts a raw `filePath` from loopback callers; remote
callers upload the file as multipart form-data.

## Use the CLI directly

```bash
opencrawl scrape https://example.com                     # markdown to stdout
opencrawl scrape https://example.com -f markdown,links --json
opencrawl scrape https://app.example.com --render always  # force a browser render
opencrawl map https://docs.example.com --search "auth" --limit 20
opencrawl crawl https://docs.example.com --limit 50 --include-paths "^/docs" -o crawl.json
opencrawl search "query" --limit 5 --scrape
opencrawl parse ./report.pdf
opencrawl scrape https://example.com --max-age 3600000   # reuse a snapshot under an hour old
opencrawl search-local "pricing tiers" --site docs.example.com
opencrawl watch https://example.com/changelog              # new | same | changed (+diff) | removed
opencrawl watch --list
```

## The local store

Every scrape, crawl page and watch snapshot is written to a SQLite file
(`~/.opencrawl/opencrawl.db` by default, `OPENCRAWL_DB` to move it). Screenshots are not
stored. What it gives you:

- **Cache.** `maxAge` (milliseconds) on a scrape or crawl returns the newest snapshot
  fetched within that window instead of hitting the network; the result carries
  `metadata.cacheState: "hit"` and `cachedAt`. The default window is 0 (always fresh); set
  `OPENCRAWL_DEFAULT_MAX_AGE_MS` to change it. `storeInCache: false` skips the write.
- **Local search.** `search_local` / `opencrawl search-local` runs SQLite FTS5 over titles
  and markdown of everything stored, one hit per URL, with a snippet. No network.
- **Persistent crawls.** Job status and pages are read from the store, so a crawl started by
  one process can be read by another and survives restarts (a crawl interrupted mid-run is
  marked `failed`). Finished jobs are kept for `OPENCRAWL_JOB_RETENTION_DAYS` (7).
- **Change tracking.** `watch` re-scrapes a URL and compares it with its last snapshot.
  The first call records a baseline (`new`); later calls answer `same`, `changed` (with a
  unified diff and added/removed line counts), `removed` (404/410 after a baseline) or
  `error`. Nothing is scheduled inside opencrawl; call it from cron, launchd or an agent.

Delete the file to start over.

## Use the library

```ts
import { scrape, map, crawl, search, parseFile } from "opencrawl";

const doc = await scrape("https://example.com", { formats: ["markdown", "links"] });
const { links } = await map("https://example.com", { search: "pricing" });
const job = await crawl("https://docs.example.com", { limit: 20, includePaths: ["^/docs"] });
const results = await search({ query: "self hosted scraper", limit: 5 });
```

## What it does and doesn't do

| Feature | opencrawl |
| --- | --- |
| Scrape formats markdown, html, rawHtml, links, images, screenshot, attributes | Yes |
| LLM-backed formats (json, summary, query, changeTracking, branding) | No. Returned as a `warning`, markdown still delivered |
| `onlyMainContent`, `includeTags`, `excludeTags`, `waitFor`, `mobile`, `headers`, `removeBase64Images`, `skipTlsVerification` | Yes |
| PDF scraping and parsing (`pdfOptions.maxPages`) | Yes (text layer only, no OCR) |
| Map with sitemap modes, keyword ranking, subdomains, query stripping, limit | Yes |
| Crawl with limit, depth, include/exclude paths, subdomains, external links, entire-domain, delay, concurrency, sitemap modes, robots.txt | Yes. Default limit 100 pages |
| Search sources web/news/images, time filters, domain filters, per-result scraping, github/pdf/research categories | Yes. News and images need SearXNG or Brave |
| Parse PDF, HTML, text files | Yes. DOCX/XLSX not yet |
| Cache (`maxAge`), offline full-text search, persistent crawl jobs, change tracking | Yes, via the local SQLite store |
| Browser actions, interactive sessions, agents, scheduled monitors, webhooks | No |
| Proxies, stealth, caching options | Accepted and ignored |

## Search backends

| Backend | Configure | Sources |
| --- | --- | --- |
| DuckDuckGo HTML (default) | nothing | web only; rate limited under heavy use |
| SearXNG | `SEARXNG_URL=http://localhost:8080` | web, news, images |
| Brave Search API | `BRAVE_SEARCH_API_KEY=...` | web, news, images |

Force one with `OPENCRAWL_SEARCH_BACKEND=duckduckgo|searxng|brave`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCRAWL_BROWSER` | `auto` | `auto` tries bundled Chromium, then Chrome, then Edge. `chromium`, `chrome`, `msedge`, or `none` |
| `OPENCRAWL_TIMEOUT_MS` | `30000` | Per-request timeout |
| `OPENCRAWL_CRAWL_LIMIT` | `100` | Default crawl page cap |
| `OPENCRAWL_CRAWL_CONCURRENCY` | `5` | Parallel pages per crawl (max 20) |
| `OPENCRAWL_MAP_LIMIT` | `5000` | Default map URL cap |
| `OPENCRAWL_MAP_DEPTH` / `OPENCRAWL_MAP_MAX_PAGES` | `1` / `20` | How far map follows links when the sitemap is thin |
| `OPENCRAWL_USER_AGENT` | Chrome desktop UA | User agent for HTTP and browser requests |
| `OPENCRAWL_ROBOTS_UA` | `opencrawl` | Token checked against robots.txt during crawls |
| `OPENCRAWL_TOOL_PREFIX` | empty | MCP tool name prefix |
| `OPENCRAWL_DB` | `~/.opencrawl/opencrawl.db` | SQLite store path (`:memory:` for a throwaway store); `OPENCRAWL_DATA_DIR` moves the folder |
| `OPENCRAWL_DEFAULT_MAX_AGE_MS` | `0` | Cache window used when a request sets no `maxAge` |
| `OPENCRAWL_CRAWL_PAGE_SIZE` | `200` | Documents per page on `GET /v2/crawl/:id` |
| `OPENCRAWL_JOB_RETENTION_DAYS` | `7` | How long finished crawl jobs stay in the store |
| `OPENCRAWL_API_KEY` | unset | Bearer token required by the HTTP API. Required to bind a non-loopback `HOST` (or set `OPENCRAWL_INSECURE=1`) |
| `OPENCRAWL_ALLOWED_HOSTS` | bind host | Extra `Host` header values the HTTP API accepts (DNS-rebinding guard); `*` disables the check |
| `OPENCRAWL_ALLOWED_ORIGINS` | none | Browser origins allowed to call the HTTP API; any other `Origin` header is refused |
| `OPENCRAWL_MAX_RESPONSE_BYTES` | `52428800` | Largest page or sitemap body buffered (50 MB) |
| `OPENCRAWL_MAX_SITEMAP_FETCHES` | `50` | Sitemap files fetched per map or crawl |
| `OPENCRAWL_MAX_BROWSER_CONTEXTS` | `4` | Browser pages open at once across all scrapes |
| `PORT` / `HOST` | `3002` / `127.0.0.1` | HTTP API bind |

## Development

```bash
npm test             # vitest against a local fixture site; no network, no browser
npm run typecheck
OPENCRAWL_TEST_BROWSER=1 npm test   # also runs the Chrome rendering tests
```

Design decisions and known gaps are in [DESIGN.md](DESIGN.md).

## License

MIT
