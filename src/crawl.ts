import { randomUUID } from "node:crypto";
import robotsParserImport from "robots-parser";
import { DEFAULT_CRAWL_CONCURRENCY, DEFAULT_CRAWL_LIMIT, MAX_CRAWL_CONCURRENCY, ROBOTS_USER_AGENT } from "./config.js";
import { fetchResource, type FetchFn } from "./fetcher.js";
import { normalizeFormats, scrapeWithStore, type ScrapeDeps } from "./scrape.js";
import { getStore, type Store, type StoredJob } from "./store.js";
import { discoverSitemapUrls, fetchSitemap, newSitemapBudget } from "./sitemap.js";
import { dedupeKey, normalizeUrl, stripWww, toRegex } from "./urls.js";
import type {
  CrawlErrors,
  CrawlJob,
  CrawlOptions,
  CrawlStartResponse,
  CrawlStatus,
  FormatOption,
  ScrapeOptions,
} from "./types.js";

type Robots = { isAllowed(url: string, ua?: string): boolean | undefined };
type RobotsFn = (url: string, body: string) => Robots;
// robots-parser ships a CommonJS function; under NodeNext the default import IS that function at runtime.
const robotsParser = robotsParserImport as unknown as RobotsFn;

export type CrawlDeps = ScrapeDeps;

interface JobState extends StoredJob {
  store: Store;
  cancelled: boolean;
  done: Promise<void>;
}

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
/** Jobs that are still running in this process. Finished jobs live only in the store. */
const jobs = new Map<string, JobState>();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function resolveStore(deps: CrawlDeps): Store {
  if (deps.store === false) throw new Error("crawl needs a store (deps.store cannot be false)");
  return deps.store ?? getStore();
}

interface Scope {
  allows(url: URL): boolean;
}

/**
 * Scoping rules: stay on the start host (subdomains/external links
 * opt-in), stay under the start path unless crawlEntireDomain, then apply
 * includePaths/excludePaths as regular expressions on the path (or on the
 * full URL with regexOnFullURL).
 */
export function buildScope(startUrl: URL, options: CrawlOptions): Scope {
  const baseHost = stripWww(startUrl.hostname);
  let basePath = startUrl.pathname.replace(/\/+$/, "");
  const lastSegment = basePath.split("/").pop() ?? "";
  if (lastSegment.includes(".")) basePath = basePath.slice(0, basePath.length - lastSegment.length).replace(/\/+$/, "");
  const include = (options.includePaths ?? []).map(toRegex);
  const exclude = (options.excludePaths ?? []).map(toRegex);
  return {
    allows(url) {
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      const host = stripWww(url.hostname);
      if (host !== baseHost) {
        const isSubdomain = host.endsWith(`.${baseHost}`);
        if (!(options.allowExternalLinks || (options.allowSubdomains && isSubdomain))) return false;
      } else if (
        !options.crawlEntireDomain &&
        basePath &&
        !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))
      ) {
        return false;
      }
      const subject = options.regexOnFullURL ? url.href : url.pathname;
      if (exclude.some((re) => re.test(subject))) return false;
      if (include.length > 0 && !include.some((re) => re.test(subject))) return false;
      return true;
    },
  };
}

/** One robots.txt fetch per origin, cached for the life of the crawl. */
function robotsCache(fetchFn: FetchFn) {
  const cache = new Map<string, Promise<Robots | null>>();
  return (origin: string): Promise<Robots | null> => {
    let entry = cache.get(origin);
    if (!entry) {
      entry = (async () => {
        try {
          const res = await fetchFn(`${origin}/robots.txt`, { timeoutMs: 10_000 });
          if (res.status !== 200) return null;
          return robotsParser(`${origin}/robots.txt`, res.body.toString("utf8"));
        } catch {
          return null;
        }
      })();
      cache.set(origin, entry);
    }
    return entry;
  };
}

async function runCrawl(job: JobState, start: string, options: CrawlOptions, deps: CrawlDeps): Promise<void> {
  const startUrl = new URL(start);
  const limit = Math.max(1, options.limit ?? DEFAULT_CRAWL_LIMIT);
  const maxDepth = options.maxDiscoveryDepth ?? Number.POSITIVE_INFINITY;
  const delayMs = Math.max(0, (options.delay ?? 0) * 1000);
  // A per-request delay only means something when requests are serialized.
  const concurrency = delayMs > 0 ? 1 : Math.min(MAX_CRAWL_CONCURRENCY, Math.max(1, options.maxConcurrency ?? DEFAULT_CRAWL_CONCURRENCY));
  const sitemapMode = options.sitemap ?? "include";
  const fetchFn = deps.fetch ?? fetchResource;
  const robotsFor = options.ignoreRobotsTxt ? null : robotsCache(fetchFn);
  const robotsUa = options.robotsUserAgent ?? ROBOTS_USER_AGENT;
  let scope = buildScope(startUrl, options);

  // The crawler stores each page itself (after dropping the links it added for discovery).
  const scrapeOptions: ScrapeOptions = { ...(options.scrapeOptions ?? {}), storeInCache: false };
  const wantsLinks = normalizeFormats(scrapeOptions.formats).types.has("links");
  const baseFormats: FormatOption[] = scrapeOptions.formats?.length ? scrapeOptions.formats : ["markdown"];
  scrapeOptions.formats = wantsLinks ? baseFormats : [...baseFormats, "links"];

  const queue: Array<{ url: string; depth: number }> = [];
  const seen = new Set<string>();
  let scheduled = 0;
  let inflight = 0;

  const enqueue = (candidate: string, depth: number, force = false): void => {
    const key = dedupeKey(candidate, options.ignoreQueryParameters);
    if (!key || seen.has(key)) return;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return;
    }
    if (!force && !scope.allows(url)) return;
    url.hash = "";
    if (options.ignoreQueryParameters) url.search = "";
    seen.add(key);
    queue.push({ url: url.href, depth });
    job.total = Math.min(seen.size, limit);
  };

  enqueue(start, 0, true);
  if (sitemapMode !== "skip") {
    const sitemapSeen = new Set<string>();
    const budget = newSitemapBudget();
    // Fetch more entries than the page limit: scope filtering happens in enqueue.
    const sitemapLimit = Math.max(limit * 10, 1000);
    for (const sitemapUrl of await discoverSitemapUrls(startUrl.origin, fetchFn)) {
      for (const entry of await fetchSitemap(sitemapUrl, { limit: sitemapLimit, fetchFn, seen: sitemapSeen, budget })) enqueue(entry.url, 1);
    }
  }

  const worker = async (): Promise<void> => {
    while (!job.cancelled) {
      if (scheduled >= limit) return;
      const item = queue.shift();
      if (!item) {
        if (inflight === 0) return;
        await sleep(25);
        continue;
      }
      scheduled++;
      inflight++;
      try {
        if (robotsFor) {
          const robots = await robotsFor(new URL(item.url).origin);
          if (robots && robots.isAllowed(item.url, robotsUa) === false) {
            job.robotsBlocked.push(item.url);
            scheduled--;
            continue;
          }
        }
        const { document: doc, fetchedAt } = await scrapeWithStore(item.url, scrapeOptions, { ...deps, store: job.store });
        if (job.cancelled) return;
        const status = doc.metadata?.statusCode ?? 200;
        if (status >= 400) {
          job.errors.push({ id: randomUUID(), url: item.url, error: `HTTP ${status}`, timestamp: new Date().toISOString() });
          job.store.updateJob(job);
          continue;
        }
        if (item.depth === 0 && doc.metadata?.url) {
          // The start URL redirected to another origin: scope the crawl to where we landed.
          const landed = new URL(doc.metadata.url);
          if (landed.origin !== startUrl.origin) scope = buildScope(landed, options);
        }
        const discovered = doc.links ?? [];
        if (!wantsLinks) delete doc.links;
        job.store.appendJobDocument(job.id, job.store.putDocument(doc, item.url, fetchedAt));
        job.completed++;
        job.creditsUsed = job.completed;
        job.store.updateJob(job);
        if (sitemapMode !== "only" && item.depth < maxDepth) {
          for (const link of discovered) enqueue(link, item.depth + 1);
        }
      } catch (err) {
        job.errors.push({ id: randomUUID(), url: item.url, error: (err as Error).message, timestamp: new Date().toISOString() });
        job.store.updateJob(job);
      } finally {
        inflight--;
      }
      if (delayMs > 0 && !job.cancelled) await sleep(delayMs);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  job.total = job.completed + job.errors.length;
  job.status = job.cancelled ? "cancelled" : "completed";
  job.store.updateJob(job);
}

/** Start a crawl in the background and return its job id (mirrors POST /v2/crawl). */
export function startCrawl(input: string, options: CrawlOptions = {}, deps: CrawlDeps = {}): CrawlStartResponse {
  const url = normalizeUrl(input);
  const id = randomUUID();
  const store = resolveStore(deps);
  const job: JobState = {
    id,
    url,
    status: "scraping",
    total: 0,
    completed: 0,
    creditsUsed: 0,
    expiresAt: new Date(Date.now() + JOB_TTL_MS).toISOString(),
    createdAt: Date.now(),
    options,
    errors: [],
    robotsBlocked: [],
    store,
    cancelled: false,
    done: Promise.resolve(),
  };
  store.insertJob(job);
  jobs.set(id, job);
  job.done = runCrawl(job, url, options, deps)
    .catch((err: Error) => {
      job.status = "failed";
      job.errors.push({ id: randomUUID(), url, error: err.message, timestamp: new Date().toISOString() });
      store.updateJob(job);
    })
    .finally(() => {
      jobs.delete(id);
    });
  return { id, url };
}

export interface CrawlPage {
  /** Documents to skip (pagination offset). */
  skip?: number;
  /** Documents to return; defaults to all remaining. */
  limit?: number;
}

function findJob(id: string, deps: CrawlDeps = {}): { job: StoredJob; store: Store } | undefined {
  const active = jobs.get(id);
  if (active) return { job: active, store: active.store };
  const store = deps.store === false ? null : (deps.store ?? getStore());
  const stored = store?.getJob(id);
  return stored && store ? { job: stored, store } : undefined;
}

/**
 * Status and (a page of) documents for a crawl, from memory while it runs
 * and from the store afterwards, including after a process restart.
 * `hasMore` tells HTTP callers whether to offer a `next` link.
 */
export function getCrawlStatus(id: string, page: CrawlPage = {}, deps: CrawlDeps = {}): (CrawlJob & { hasMore: boolean }) | undefined {
  const found = findJob(id, deps);
  if (!found) return undefined;
  const { job, store } = found;
  const skip = Math.max(0, page.skip ?? 0);
  const limit = Math.max(1, page.limit ?? Number.MAX_SAFE_INTEGER);
  const data = store.getJobDocuments(id, skip, limit);
  const hasMore = page.limit !== undefined && skip + data.length < store.countJobDocuments(id);
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    creditsUsed: job.creditsUsed,
    expiresAt: job.expiresAt,
    next: null,
    data,
    hasMore,
  };
}

export function getCrawlErrors(id: string, deps: CrawlDeps = {}): CrawlErrors | undefined {
  const found = findJob(id, deps);
  if (!found) return undefined;
  return { errors: [...found.job.errors], robotsBlocked: [...found.job.robotsBlocked] };
}

export function cancelCrawl(id: string, deps: CrawlDeps = {}): boolean {
  const active = jobs.get(id);
  if (active) {
    active.cancelled = true;
    active.status = "cancelled";
    active.store.updateJob(active);
    return true;
  }
  return findJob(id, deps) !== undefined;
}

export function listActiveCrawls(): Array<{ id: string; url: string; options: CrawlOptions }> {
  return [...jobs.values()].map((j) => ({ id: j.id, url: j.url, options: j.options }));
}

export function activeCrawlCount(): number {
  return listActiveCrawls().length;
}

export interface WaitOptions {
  timeoutMs?: number;
}

/** Resolve once the crawl reaches a terminal state (or the timeout elapses). */
export async function waitForCrawl(id: string, options: WaitOptions = {}, deps: CrawlDeps = {}): Promise<CrawlJob> {
  const job = jobs.get(id);
  if (!job) {
    const stored = getCrawlStatus(id, {}, deps);
    if (!stored) throw new Error(`Crawl job not found: ${id}`);
    return stored;
  }
  if (options.timeoutMs && options.timeoutMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      job.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  } else {
    await job.done;
  }
  return getCrawlStatus(id, {}, deps)!;
}

/** Start a crawl and wait for it to finish (mirrors the SDK's crawl()). */
export async function crawl(
  input: string,
  options: CrawlOptions & WaitOptions = {},
  deps: CrawlDeps = {},
): Promise<CrawlJob> {
  const { timeoutMs, ...crawlOptions } = options;
  const { id } = startCrawl(input, crawlOptions, deps);
  return waitForCrawl(id, { timeoutMs }, deps);
}
