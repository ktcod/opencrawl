import { DEFAULT_MAP_LIMIT, MAP_LINK_DEPTH, MAP_MAX_PAGES } from "./config.js";
import { classifyContent, decodeText, fetchResource, type FetchFn } from "./fetcher.js";
import { extractLinksWithText, parseHtml } from "./html.js";
import { discoverSitemapUrls, fetchSitemap } from "./sitemap.js";
import { dedupeKey, normalizeUrl, sameSite } from "./urls.js";
import type { MapLink, MapOptions, MapResult } from "./types.js";

export interface MapDeps {
  fetch?: FetchFn;
}

function stripQuery(url: string): string {
  const u = new URL(url);
  u.search = "";
  return u.href;
}

/**
 * Rank links against a free-text search. Phrase hits weigh more than token
 * hits, and titles weigh more than URLs. Only matching links are returned.
 */
export function rankBySearch(links: MapLink[], search: string): MapLink[] {
  const phrase = search.toLowerCase().trim();
  if (!phrase) return links;
  const tokens = phrase.split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const scored = links.map((link) => {
    const url = link.url.toLowerCase();
    const title = (link.title ?? "").toLowerCase();
    let score = 0;
    if (url.includes(phrase)) score += 5;
    if (title.includes(phrase)) score += 6;
    for (const token of tokens) {
      if (url.includes(token)) score += 2;
      if (title.includes(token)) score += 3;
    }
    return { link, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.link);
}

/**
 * Discover the URLs of a site: sitemap(s) plus links found on the start page
 * (and, when OPENCRAWL_MAP_DEPTH > 1, on the pages it links to).
 */
export async function map(input: string, options: MapOptions = {}, deps: MapDeps = {}): Promise<MapResult> {
  const fetchFn = deps.fetch ?? fetchResource;
  const start = normalizeUrl(input);
  const startUrl = new URL(start);
  const limit = Math.max(1, options.limit ?? DEFAULT_MAP_LIMIT);
  const sitemapMode = options.sitemap ?? "include";
  const entries = new Map<string, MapLink>();

  const add = (candidate: string, title?: string): void => {
    const key = dedupeKey(candidate, options.ignoreQueryParameters);
    if (!key) return;
    let host: string;
    try {
      host = new URL(candidate).hostname;
    } catch {
      return;
    }
    if (!sameSite(host, startUrl.hostname, options.includeSubdomains)) return;
    const url = options.ignoreQueryParameters ? stripQuery(candidate) : candidate;
    const existing = entries.get(key);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      return;
    }
    entries.set(key, title ? { url, title } : { url });
  };

  add(start);

  if (sitemapMode !== "skip") {
    const seen = new Set<string>();
    for (const sitemapUrl of await discoverSitemapUrls(startUrl.origin, fetchFn)) {
      for (const entry of await fetchSitemap(sitemapUrl, { limit: Math.max(limit, 100), fetchFn, seen })) add(entry.url);
    }
  }

  if (sitemapMode !== "only") {
    const queue: Array<{ url: string; depth: number }> = [{ url: start, depth: 0 }];
    const visited = new Set<string>();
    let fetched = 0;
    while (queue.length > 0 && fetched < MAP_MAX_PAGES) {
      const { url, depth } = queue.shift()!;
      const key = dedupeKey(url, true);
      if (!key || visited.has(key)) continue;
      visited.add(key);
      fetched++;
      let res;
      try {
        res = await fetchFn(url, { timeoutMs: options.timeout });
      } catch {
        continue;
      }
      if (res.status >= 400 || classifyContent(res.contentType, res.url) !== "html") continue;
      const dom = parseHtml(decodeText(res.body, res.contentType), res.url);
      for (const link of extractLinksWithText(dom.window.document, res.url)) {
        add(link.url, link.text);
        if (depth + 1 < MAP_LINK_DEPTH && sameSite(new URL(link.url).hostname, startUrl.hostname, options.includeSubdomains)) {
          queue.push({ url: link.url, depth: depth + 1 });
        }
      }
    }
  }

  let links = [...entries.values()];
  if (options.search) links = rankBySearch(links, options.search);
  return { links: links.slice(0, limit) };
}
