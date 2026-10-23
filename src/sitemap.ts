import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { MAX_RESPONSE_BYTES, MAX_SITEMAP_FETCHES } from "./config.js";
import { fetchResource, type FetchFn } from "./fetcher.js";
import { sameSite } from "./urls.js";

export interface SitemapEntry {
  url: string;
  lastmod?: string;
}

/** Sitemap locations declared in robots.txt, or the conventional defaults. */
export async function discoverSitemapUrls(origin: string, fetchFn: FetchFn = fetchResource): Promise<string[]> {
  const found = new Set<string>();
  try {
    const robots = await fetchFn(`${origin}/robots.txt`, { timeoutMs: 10_000 });
    if (robots.status === 200) {
      for (const line of robots.body.toString("utf8").split(/\r?\n/)) {
        const match = /^\s*sitemap:\s*(\S+)/i.exec(line);
        if (!match) continue;
        try {
          const sitemapUrl = new URL(match[1]!, origin);
          // Only follow sitemap locations on the site itself (or its subdomains).
          if (sameSite(sitemapUrl.hostname, new URL(origin).hostname, true)) found.add(sitemapUrl.href);
        } catch {
          /* ignore malformed */
        }
      }
    }
  } catch {
    /* no robots.txt */
  }
  if (found.size === 0) {
    found.add(`${origin}/sitemap.xml`);
    found.add(`${origin}/sitemap_index.xml`);
  }
  return [...found];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === "url" || name === "sitemap",
});

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) return str((value as { "#text": unknown })["#text"]);
  return undefined;
}

export interface SitemapBudget {
  /** Remaining sitemap files this map/crawl may still fetch. */
  remaining: number;
}

export function newSitemapBudget(max = MAX_SITEMAP_FETCHES): SitemapBudget {
  return { remaining: max };
}

export interface FetchSitemapOptions {
  limit?: number;
  fetchFn?: FetchFn;
  seen?: Set<string>;
  depth?: number;
  budget?: SitemapBudget;
}

/** Fetch a sitemap or sitemap index (recursively) and return its URL entries. */
export async function fetchSitemap(url: string, options: FetchSitemapOptions = {}): Promise<SitemapEntry[]> {
  const limit = options.limit ?? 5000;
  const fetchFn = options.fetchFn ?? fetchResource;
  const seen = options.seen ?? new Set<string>();
  const depth = options.depth ?? 0;
  const budget = options.budget ?? newSitemapBudget();
  if (seen.has(url) || depth > 5 || limit <= 0 || budget.remaining <= 0) return [];
  seen.add(url);
  budget.remaining--;
  let res;
  try {
    res = await fetchFn(url, { timeoutMs: 15_000 });
  } catch {
    return [];
  }
  if (res.status !== 200) return [];
  let body = res.body;
  if (url.endsWith(".gz") || res.contentType.includes("gzip") || (body[0] === 0x1f && body[1] === 0x8b)) {
    try {
      body = gunzipSync(body, { maxOutputLength: MAX_RESPONSE_BYTES });
    } catch {
      return [];
    }
  }
  const text = body.toString("utf8");
  if (!/<\s*(urlset|sitemapindex)/i.test(text)) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^https?:\/\//.test(line))
      .slice(0, limit)
      .map((u) => ({ url: u }));
  }
  let xml: Record<string, unknown>;
  try {
    xml = parser.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: SitemapEntry[] = [];
  const index = xml.sitemapindex as { sitemap?: Array<Record<string, unknown>> } | undefined;
  for (const child of index?.sitemap ?? []) {
    const loc = str(child.loc);
    if (!loc) continue;
    out.push(...(await fetchSitemap(loc, { limit: limit - out.length, fetchFn, seen, depth: depth + 1, budget })));
    if (out.length >= limit || budget.remaining <= 0) break;
  }
  const set = xml.urlset as { url?: Array<Record<string, unknown>> } | undefined;
  for (const entry of set?.url ?? []) {
    const loc = str(entry.loc);
    if (loc) out.push({ url: loc, lastmod: str(entry.lastmod) });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}
