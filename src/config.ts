/**
 * Runtime configuration. Everything is overridable through environment
 * variables so the same build works as a stdio MCP server, an HTTP API and a
 * library.
 */
export const DESKTOP_USER_AGENT =
  process.env.OPENCRAWL_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** Token used when consulting robots.txt. */
export const ROBOTS_USER_AGENT = process.env.OPENCRAWL_ROBOTS_UA ?? "opencrawl";

export const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCRAWL_TIMEOUT_MS ?? 30_000);

/** Default page cap for a crawl. Deliberately conservative for a tool that runs on a laptop. */
export const DEFAULT_CRAWL_LIMIT = Number(process.env.OPENCRAWL_CRAWL_LIMIT ?? 100);

/** Default URL cap for map. */
export const DEFAULT_MAP_LIMIT = Number(process.env.OPENCRAWL_MAP_LIMIT ?? 5000);

/** How deep map follows links from the start page when no sitemap covers the site. */
export const MAP_LINK_DEPTH = Number(process.env.OPENCRAWL_MAP_DEPTH ?? 1);
export const MAP_MAX_PAGES = Number(process.env.OPENCRAWL_MAP_MAX_PAGES ?? 20);

export const DEFAULT_CRAWL_CONCURRENCY = Number(process.env.OPENCRAWL_CRAWL_CONCURRENCY ?? 5);
export const MAX_CRAWL_CONCURRENCY = 20;

export const DEFAULT_SEARCH_LIMIT = 5;

/** Largest response body (and decompressed sitemap) opencrawl will buffer. */
export const MAX_RESPONSE_BYTES = Number(process.env.OPENCRAWL_MAX_RESPONSE_BYTES ?? 50 * 1024 * 1024);

/** Upper bound on sitemap files fetched for one map or crawl. */
export const MAX_SITEMAP_FETCHES = Number(process.env.OPENCRAWL_MAX_SITEMAP_FETCHES ?? 50);

/** Browser pages open at once across all scrapes in this process. */
export const MAX_BROWSER_CONTEXTS = Number(process.env.OPENCRAWL_MAX_BROWSER_CONTEXTS ?? 4);

export const VERSION = "0.1.0";
