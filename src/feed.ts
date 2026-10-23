import { XMLParser } from "fast-xml-parser";
import { batchScrape } from "./batch.js";
import { decodeText, fetchResource, type FetchFn } from "./fetcher.js";
import { htmlToMarkdown, parseHtml } from "./html.js";
import type { ScrapeDeps } from "./scrape.js";
import { normalizeUrl } from "./urls.js";
import type { Document as ScrapedDocument, ScrapeOptions } from "./types.js";

/**
 * RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed discovery and parsing. Feeds
 * are the cheapest way to ask a site "what is new" without crawling it.
 */

export interface FeedItem {
  id?: string;
  title?: string;
  url?: string;
  published?: string;
  updated?: string;
  author?: string;
  /** Plain-text summary (HTML stripped, collapsed, capped). */
  summary?: string;
  /** Full content as markdown when the feed carries it. */
  content?: string;
  categories?: string[];
  /** Scraped page when `scrape: true` was requested. */
  document?: ScrapedDocument;
}

export interface Feed {
  /** URL of the feed that was parsed. */
  url: string;
  type: "rss" | "atom" | "rdf" | "json";
  title?: string;
  description?: string;
  /** The site the feed belongs to. */
  link?: string;
  updated?: string;
  items: FeedItem[];
  /** Feed URLs found while discovering from a non-feed page. */
  discovered?: string[];
}

export interface FeedOptions {
  /** Items to return (default 20). */
  limit?: number;
  /** Only items published or updated at or after this time (ISO string or epoch ms). */
  since?: string | number;
  /** Look for a feed when the URL is an HTML page (default true). */
  discover?: boolean;
  /** Scrape each item's page and attach it as `document`. */
  scrape?: boolean;
  scrapeOptions?: ScrapeOptions;
}

export interface FeedDeps extends ScrapeDeps {
  fetch?: FetchFn;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => ["item", "entry", "category", "link", "author"].includes(name),
});

type Node = Record<string, unknown>;

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object" && "#text" in (value as Node)) return text((value as Node)["#text"]);
  return undefined;
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? raw : new Date(parsed).toISOString();
}

function looksLikeHtml(value: string): boolean {
  return /<[a-z][\s\S]*>/i.test(value);
}

function toPlainText(value: string | undefined, cap = 1000): string | undefined {
  if (!value) return undefined;
  const plain = looksLikeHtml(value) ? (parseHtml(value, "http://localhost/").window.document.body?.textContent ?? "") : value;
  const collapsed = plain.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > cap ? `${collapsed.slice(0, cap)}…` : collapsed;
}

function toMarkdown(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const md = looksLikeHtml(value) ? htmlToMarkdown(value) : value.trim();
  return md || undefined;
}

function absolute(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function atomLink(links: unknown, rel: string, base: string): string | undefined {
  if (!Array.isArray(links)) return undefined;
  const candidates = links.filter((l): l is Node => typeof l === "object" && l !== null);
  const match = candidates.find((l) => (l["@_rel"] ?? "alternate") === rel) ?? (rel === "alternate" ? candidates[0] : undefined);
  return absolute(text(match?.["@_href"]), base);
}

function categories(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((c) => (typeof c === "object" && c !== null ? (text((c as Node)["@_term"]) ?? text(c)) : text(c)))
    .filter((c): c is string => Boolean(c));
  return out.length ? out : undefined;
}

function rssItem(item: Node, base: string): FeedItem {
  const description = text(item.description);
  const encoded = text(item["content:encoded"]);
  return {
    id: text(item.guid) ?? text(item["dc:identifier"]),
    title: text(item.title),
    url: absolute(text(item.link) ?? text(item.guid), base),
    published: isoDate(item.pubDate ?? item["dc:date"]),
    author: text(item["dc:creator"]) ?? text(item.author),
    summary: toPlainText(description),
    content: toMarkdown(encoded ?? (description && looksLikeHtml(description) ? description : undefined)),
    categories: categories(item.category),
  };
}

function atomEntry(entry: Node, base: string): FeedItem {
  const contentText = text(entry.content);
  return {
    id: text(entry.id),
    title: text(entry.title),
    url: atomLink(entry.link, "alternate", base),
    published: isoDate(entry.published),
    updated: isoDate(entry.updated),
    author: text((Array.isArray(entry.author) ? (entry.author[0] as Node | undefined) : undefined)?.name),
    summary: toPlainText(text(entry.summary) ?? contentText),
    content: toMarkdown(contentText),
    categories: categories(entry.category),
  };
}

function jsonFeedItem(item: Node, base: string): FeedItem {
  const authors = Array.isArray(item.authors) ? (item.authors as Node[]) : item.author ? [item.author as Node] : [];
  const html = text(item.content_html);
  return {
    id: text(item.id),
    title: text(item.title),
    url: absolute(text(item.url) ?? text(item.external_url), base),
    published: isoDate(item.date_published),
    updated: isoDate(item.date_modified),
    author: text(authors[0]?.name),
    summary: toPlainText(text(item.summary) ?? text(item.content_text) ?? html),
    content: toMarkdown(html ?? text(item.content_text)),
    categories: Array.isArray(item.tags) ? (item.tags as unknown[]).map((t) => text(t)).filter((t): t is string => Boolean(t)) : undefined,
  };
}

/** Parse a feed body (XML or JSON Feed) into a normalized Feed. */
export function parseFeed(body: string, url: string, contentType = ""): Feed {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || contentType.includes("json")) {
    const json = JSON.parse(trimmed) as Node;
    const base = text(json.home_page_url) ?? url;
    return {
      url,
      type: "json",
      title: text(json.title),
      description: text(json.description),
      link: absolute(text(json.home_page_url), url),
      items: Array.isArray(json.items) ? (json.items as Node[]).map((i) => jsonFeedItem(i, base)) : [],
    };
  }
  const xml = parser.parse(trimmed) as Node;
  if (xml.rss) {
    const channel = ((xml.rss as Node).channel ?? {}) as Node;
    const base = absolute(text(channel.link), url) ?? url;
    return {
      url,
      type: "rss",
      title: text(channel.title),
      description: text(channel.description),
      link: base,
      updated: isoDate(channel.lastBuildDate ?? channel.pubDate),
      items: Array.isArray(channel.item) ? (channel.item as Node[]).map((i) => rssItem(i, base)) : [],
    };
  }
  if (xml.feed) {
    const feed = xml.feed as Node;
    const base = atomLink(feed.link, "alternate", url) ?? url;
    return {
      url,
      type: "atom",
      title: text(feed.title),
      description: text(feed.subtitle),
      link: base,
      updated: isoDate(feed.updated),
      items: Array.isArray(feed.entry) ? (feed.entry as Node[]).map((e) => atomEntry(e, base)) : [],
    };
  }
  const rdf = (xml["rdf:RDF"] ?? xml.RDF) as Node | undefined;
  if (rdf) {
    const channel = (rdf.channel ?? {}) as Node;
    const base = absolute(text(channel.link), url) ?? url;
    return {
      url,
      type: "rdf",
      title: text(channel.title),
      description: text(channel.description),
      link: base,
      items: Array.isArray(rdf.item) ? (rdf.item as Node[]).map((i) => rssItem(i, base)) : [],
    };
  }
  throw new Error(`not a recognised feed: ${url}`);
}

const FEED_TYPES = ["rss+xml", "atom+xml", "feed+json", "rdf+xml", "text/xml", "application/xml"];
const PROBE_PATHS = ["/feed", "/feed/", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/feed.json", "/?feed=rss2"];

export function looksLikeFeed(body: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("html")) return false;
  if (FEED_TYPES.some((t) => ct.includes(t))) return true;
  const head = body.slice(0, 2000).trimStart();
  if (/^<\?xml[^>]*>\s*(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(head) || /^<(rss|feed|rdf:RDF)\b/i.test(head)) return true;
  return head.startsWith("{") && /"version"\s*:\s*"https:\/\/jsonfeed\.org/.test(head);
}

/** Feed URLs advertised by an HTML page's <link rel="alternate"> tags. */
export function feedLinksInHtml(html: string, baseUrl: string): string[] {
  const document = parseHtml(html, baseUrl).window.document;
  const out: string[] = [];
  for (const link of document.querySelectorAll('link[rel~="alternate"][type]')) {
    const type = (link.getAttribute("type") ?? "").toLowerCase();
    const href = link.getAttribute("href");
    if (!href || !FEED_TYPES.some((t) => type.includes(t))) continue;
    const abs = absolute(href, baseUrl);
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}

/** Probe the conventional feed paths of a site; returns the first one that answers with a feed. */
export async function probeFeedPaths(pageUrl: string, fetchFn: FetchFn): Promise<string[]> {
  const origin = new URL(pageUrl).origin;
  for (const probe of PROBE_PATHS) {
    const candidate = `${origin}${probe}`;
    try {
      const res = await fetchFn(candidate, { timeoutMs: 10_000, retries: 0 });
      if (res.status === 200 && looksLikeFeed(decodeText(res.body, res.contentType), res.contentType)) return [candidate];
    } catch {
      /* try the next one */
    }
  }
  return [];
}

/**
 * Fetch and parse a feed. Given an HTML page instead, discover its feed from
 * <link rel="alternate"> tags or the conventional paths and parse that.
 */
export async function fetchFeed(input: string, options: FeedOptions = {}, deps: FeedDeps = {}): Promise<Feed> {
  const fetchFn = deps.fetch ?? fetchResource;
  const url = normalizeUrl(input);
  const res = await fetchFn(url, { timeoutMs: 20_000 });
  let feedUrl = url;
  let body = decodeText(res.body, res.contentType);
  let contentType = res.contentType;
  let discovered: string[] | undefined;
  if (!looksLikeFeed(body, contentType)) {
    if (options.discover === false) throw new Error(`not a feed: ${url}`);
    discovered = feedLinksInHtml(body, res.url || url);
    if (discovered.length === 0) discovered = await probeFeedPaths(res.url || url, fetchFn);
    if (discovered.length === 0) throw new Error(`no feed found at ${url}`);
    feedUrl = discovered[0]!;
    const feedRes = await fetchFn(feedUrl, { timeoutMs: 20_000 });
    body = decodeText(feedRes.body, feedRes.contentType);
    contentType = feedRes.contentType;
  }
  const feed = parseFeed(body, feedUrl, contentType);
  if (discovered) feed.discovered = discovered;
  if (options.since !== undefined) {
    const since = typeof options.since === "number" ? options.since : Date.parse(options.since);
    if (!Number.isNaN(since)) {
      feed.items = feed.items.filter((item) => {
        const stamp = Date.parse(item.updated ?? item.published ?? "");
        return Number.isNaN(stamp) ? true : stamp >= since;
      });
    }
  }
  feed.items = feed.items.slice(0, Math.max(1, Math.min(options.limit ?? 20, 500)));
  if (options.scrape) {
    const urls = feed.items.map((i) => i.url).filter((u): u is string => Boolean(u));
    const result = await batchScrape(urls, { scrapeOptions: options.scrapeOptions, ignoreInvalidURLs: true }, deps);
    const byUrl = new Map(result.data.map((d) => [d.metadata?.sourceURL, d]));
    for (const item of feed.items) {
      const doc = item.url ? byUrl.get(normalizeUrl(item.url)) : undefined;
      if (doc) item.document = doc;
    }
  }
  return feed;
}
