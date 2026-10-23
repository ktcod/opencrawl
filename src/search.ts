import { DEFAULT_SEARCH_LIMIT } from "./config.js";
import { decodeText, fetchResource, type FetchFn } from "./fetcher.js";
import { parseHtml } from "./html.js";
import { scrape, type ScrapeDeps } from "./scrape.js";
import type {
  SearchData,
  SearchRequest,
  SearchResponse,
  SearchResultImages,
  SearchResultNews,
  SearchResultWeb,
  SearchSource,
} from "./types.js";

export interface BackendParams {
  limit: number;
  sources: SearchSource[];
  tbs?: string;
  location?: string;
  country?: string;
  timeoutMs?: number;
  fetchFn: FetchFn;
}

export interface SearchBackend {
  name: string;
  search(query: string, params: BackendParams): Promise<SearchData>;
}

export interface SearchDeps extends ScrapeDeps {
  backend?: SearchBackend;
}

type Freshness = "day" | "week" | "month" | "year";

function freshness(tbs?: string): Freshness | undefined {
  switch (tbs) {
    case "qdr:h":
    case "qdr:d":
      return "day";
    case "qdr:w":
      return "week";
    case "qdr:m":
      return "month";
    case "qdr:y":
      return "year";
    default:
      return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** SearXNG JSON API backend. Supports web, news and images. */
export function searxngBackend(baseUrl: string): SearchBackend {
  const base = baseUrl.replace(/\/$/, "");
  const categoryFor: Record<SearchSource, string> = { web: "general", news: "news", images: "images" };
  return {
    name: "searxng",
    async search(query, p) {
      const out: SearchData = {};
      for (const source of p.sources) {
        const u = new URL(`${base}/search`);
        u.searchParams.set("q", query);
        u.searchParams.set("format", "json");
        u.searchParams.set("categories", categoryFor[source]);
        const range = freshness(p.tbs);
        if (range) u.searchParams.set("time_range", range);
        const res = await p.fetchFn(u.href, { timeoutMs: p.timeoutMs, headers: { accept: "application/json" } });
        if (res.status !== 200) throw new Error(`SearXNG returned HTTP ${res.status} for ${u.origin}`);
        const json = JSON.parse(res.body.toString("utf8")) as { results?: Array<Record<string, unknown>> };
        const results = (json.results ?? []).slice(0, p.limit);
        if (source === "web") {
          out.web = results.map((r) => ({ url: String(r.url ?? ""), title: str(r.title), description: str(r.content) }));
        } else if (source === "news") {
          out.news = results.map((r, i) => ({
            url: str(r.url),
            title: str(r.title),
            snippet: str(r.content),
            date: str(r.publishedDate),
            imageUrl: str(r.thumbnail) ?? str(r.img_src),
            position: i + 1,
          }));
        } else {
          out.images = results.map((r, i) => ({
            url: str(r.url),
            title: str(r.title),
            imageUrl: str(r.img_src),
            position: i + 1,
          }));
        }
      }
      return out;
    },
  };
}

/** Brave Search API backend (needs a subscription token). Supports web, news and images. */
export function braveBackend(apiKey: string): SearchBackend {
  const endpoints: Record<SearchSource, string> = {
    web: "https://api.search.brave.com/res/v1/web/search",
    news: "https://api.search.brave.com/res/v1/news/search",
    images: "https://api.search.brave.com/res/v1/images/search",
  };
  const braveFreshness: Record<Freshness, string> = { day: "pd", week: "pw", month: "pm", year: "py" };
  return {
    name: "brave",
    async search(query, p) {
      const out: SearchData = {};
      for (const source of p.sources) {
        const u = new URL(endpoints[source]);
        u.searchParams.set("q", query);
        u.searchParams.set("count", String(Math.min(p.limit, 20)));
        const range = freshness(p.tbs);
        if (range && source !== "images") u.searchParams.set("freshness", braveFreshness[range]);
        if (p.country) u.searchParams.set("country", p.country);
        const res = await p.fetchFn(u.href, {
          timeoutMs: p.timeoutMs,
          headers: { accept: "application/json", "x-subscription-token": apiKey },
        });
        if (res.status !== 200) throw new Error(`Brave Search returned HTTP ${res.status}`);
        const json = JSON.parse(res.body.toString("utf8")) as Record<string, unknown>;
        if (source === "web") {
          const results = ((json.web as { results?: Array<Record<string, unknown>> } | undefined)?.results ?? []).slice(0, p.limit);
          out.web = results.map((r) => ({ url: String(r.url ?? ""), title: str(r.title), description: str(r.description) }));
        } else if (source === "news") {
          const results = ((json.results as Array<Record<string, unknown>> | undefined) ?? []).slice(0, p.limit);
          out.news = results.map((r, i) => ({
            url: str(r.url),
            title: str(r.title),
            snippet: str(r.description),
            date: str(r.age),
            imageUrl: str((r.thumbnail as Record<string, unknown> | undefined)?.src),
            position: i + 1,
          }));
        } else {
          const results = ((json.results as Array<Record<string, unknown>> | undefined) ?? []).slice(0, p.limit);
          out.images = results.map((r, i) => {
            const props = (r.properties as Record<string, unknown> | undefined) ?? {};
            return {
              url: str(r.url),
              title: str(r.title),
              imageUrl: str(props.url) ?? str((r.thumbnail as Record<string, unknown> | undefined)?.src),
              imageWidth: num(props.width),
              imageHeight: num(props.height),
              position: i + 1,
            };
          });
        }
      }
      return out;
    },
  };
}

function unwrapDuckDuckGo(href: string): string | undefined {
  try {
    const u = new URL(href, "https://duckduckgo.com/");
    const target = u.searchParams.get("uddg");
    if (target) return new URL(target).href;
    if (/^https?:$/.test(u.protocol) && !u.hostname.endsWith("duckduckgo.com")) return u.href;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Keyless fallback that reads DuckDuckGo's HTML endpoint. Web results only;
 * expect rate limiting under heavy use. Prefer SearXNG or Brave for anything
 * sustained.
 */
export function duckduckgoBackend(endpoint = "https://html.duckduckgo.com/html/"): SearchBackend {
  const df: Record<Freshness, string> = { day: "d", week: "w", month: "m", year: "y" };
  return {
    name: "duckduckgo",
    async search(query, p) {
      const out: SearchData = {};
      for (const source of p.sources) {
        if (source !== "web") {
          out[source] = [];
          continue;
        }
        const u = new URL(endpoint);
        u.searchParams.set("q", query);
        const range = freshness(p.tbs);
        if (range) u.searchParams.set("df", df[range]);
        if (p.country) u.searchParams.set("kl", `${p.country.toLowerCase()}-en`);
        const res = await p.fetchFn(u.href, { timeoutMs: p.timeoutMs });
        if (res.status !== 200) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
        const dom = parseHtml(decodeText(res.body, res.contentType), u.href);
        const web: SearchResultWeb[] = [];
        for (const result of dom.window.document.querySelectorAll(".result, .web-result")) {
          if (result.classList.contains("result--ad")) continue;
          const anchor = result.querySelector("a.result__a, a.result__url");
          const href = anchor?.getAttribute("href");
          if (!href) continue;
          const url = unwrapDuckDuckGo(href);
          if (!url) continue;
          web.push({
            url,
            title: anchor?.textContent?.replace(/\s+/g, " ").trim() || undefined,
            description: result.querySelector(".result__snippet")?.textContent?.replace(/\s+/g, " ").trim() || undefined,
          });
          if (web.length >= p.limit) break;
        }
        out.web = web;
      }
      return out;
    },
  };
}

export function resolveBackend(env: NodeJS.ProcessEnv = process.env): SearchBackend {
  const explicit = env.OPENCRAWL_SEARCH_BACKEND?.toLowerCase();
  const searx = env.SEARXNG_URL ?? env.OPENCRAWL_SEARXNG_URL;
  const brave = env.BRAVE_SEARCH_API_KEY;
  if (explicit === "searxng" || (!explicit && searx)) {
    if (!searx) throw new Error("OPENCRAWL_SEARCH_BACKEND=searxng but SEARXNG_URL is not set");
    return searxngBackend(searx);
  }
  if (explicit === "brave" || (!explicit && brave)) {
    if (!brave) throw new Error("OPENCRAWL_SEARCH_BACKEND=brave but BRAVE_SEARCH_API_KEY is not set");
    return braveBackend(brave);
  }
  return duckduckgoBackend();
}

function normalizeSources(sources: SearchRequest["sources"]): SearchSource[] {
  const out: SearchSource[] = [];
  for (const s of sources ?? ["web"]) {
    const type = typeof s === "string" ? s : s.type;
    if ((type === "web" || type === "news" || type === "images") && !out.includes(type)) out.push(type);
  }
  return out.length ? out : ["web"];
}

function applyCategories(query: string, categories: SearchRequest["categories"], includeDomains?: string[]): string {
  const modifiers: string[] = [];
  if (includeDomains?.length) {
    const sites = includeDomains.map((d) => `site:${d.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`);
    modifiers.push(sites.length === 1 ? sites[0]! : `(${sites.join(" OR ")})`);
  }
  for (const c of categories ?? []) {
    const type = typeof c === "string" ? c : c.type;
    if (type === "github") modifiers.push("site:github.com");
    else if (type === "pdf") modifiers.push("filetype:pdf");
    else if (type === "research") modifiers.push("(site:arxiv.org OR site:pubmed.ncbi.nlm.nih.gov OR site:biorxiv.org OR site:medrxiv.org)");
  }
  return modifiers.length ? `${query} ${modifiers.join(" ")}` : query;
}

function hostMatches(url: string | undefined, domains: string[]): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => {
      const dd = d.toLowerCase().replace(/^www\./, "");
      return host === dd || host.endsWith(`.${dd}`);
    });
  } catch {
    return false;
  }
}

function filterDomains<T extends { url?: string }>(items: T[] | undefined, include?: string[], exclude?: string[]): T[] | undefined {
  if (!items) return items;
  return items.filter((item) => {
    if (include?.length && !hostMatches(item.url, include)) return false;
    if (exclude?.length && hostMatches(item.url, exclude)) return false;
    return true;
  });
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Web search with optional per-result scraping, shaped like POST /v2/search. */
export async function search(request: SearchRequest, deps: SearchDeps = {}): Promise<SearchResponse> {
  if (!request.query?.trim()) throw new Error("query is required");
  const backend = deps.backend ?? resolveBackend();
  const fetchFn = deps.fetch ?? fetchResource;
  const sources = normalizeSources(request.sources);
  const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_SEARCH_LIMIT, 100));
  const query = applyCategories(request.query.trim(), request.categories, request.includeDomains);
  const filtering = Boolean(request.includeDomains?.length || request.excludeDomains?.length);
  const data = await backend.search(query, {
    limit: filtering ? Math.min(limit * 2, 100) : limit,
    sources,
    tbs: request.tbs,
    location: request.location,
    country: request.country,
    timeoutMs: request.timeout,
    fetchFn,
  });
  data.web = filterDomains(data.web, request.includeDomains, request.excludeDomains);
  data.news = filterDomains(data.news, request.includeDomains, request.excludeDomains);
  data.images = filterDomains(data.images, request.includeDomains, request.excludeDomains);
  if (filtering) {
    data.web = data.web?.slice(0, limit);
    data.news = data.news?.slice(0, limit);
    data.images = data.images?.slice(0, limit);
  }

  const warnings: string[] = [];
  for (const source of sources) {
    if (source !== "web" && backend.name === "duckduckgo") {
      warnings.push(`${source} results need the SearXNG or Brave backend (SEARXNG_URL or BRAVE_SEARCH_API_KEY)`);
    }
  }

  if (request.scrapeOptions) {
    const targets: Array<SearchResultWeb | SearchResultNews> = [...(data.web ?? []), ...(data.news ?? [])];
    await mapWithConcurrency(targets, 3, async (item) => {
      if (!item.url) return;
      try {
        const doc = await scrape(item.url, request.scrapeOptions, deps);
        Object.assign(item, doc);
      } catch (err) {
        Object.assign(item, { metadata: { sourceURL: item.url, error: (err as Error).message } });
      }
    });
  }

  const out: SearchResponse = { data, backend: backend.name };
  if (warnings.length) out.warning = warnings.join(" | ");
  return out;
}

export type { SearchResultImages };
