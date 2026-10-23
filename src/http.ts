import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { CRAWL_PAGE_SIZE, MAX_CRAWL_CONCURRENCY, VERSION } from "./config.js";
import { activeCrawlCount, cancelCrawl, getCrawlErrors, getCrawlStatus, listActiveCrawls, startCrawl } from "./crawl.js";
import { extract } from "./extract.js";
import { map } from "./map.js";
import { PARSE_EXTENSIONS, parseFile } from "./parse.js";
import { scrape } from "./scrape.js";
import {
  crawlRequestSchema,
  extractRequestSchema,
  localSearchRequestSchema,
  mapRequestSchema,
  parseOptionsSchema,
  parseRequestSchema,
  resolveScrapeOptions,
  scrapeRequestSchema,
  searchRequestSchema,
  validate,
  ValidationError,
  watchRequestSchema,
} from "./schemas.js";
import { search } from "./search.js";
import { getStore } from "./store.js";
import { watch } from "./watch.js";
import { InvalidUrlError, isLoopbackHost } from "./urls.js";

class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const UPLOAD_BODY_LIMIT = 50 * 1024 * 1024;

/** True for in-process requests (tests) and connections from this machine. */
function isLocalCaller(c: Context): boolean {
  try {
    const address = getConnInfo(c).remote.address;
    return !address || isLoopbackHost(address);
  } catch {
    return true;
  }
}

/** Host header without the port: "127.0.0.1:3002" -> "127.0.0.1", "[::1]:3002" -> "[::1]". */
function hostOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  if (header.startsWith("[")) return header.slice(0, header.indexOf("]") + 1).toLowerCase();
  return header.split(":")[0]!.toLowerCase();
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be a JSON object");
    return body;
  } catch (err) {
    throw new HttpError(400, `Invalid JSON body: ${(err as Error).message}`);
  }
}

export interface AppOptions {
  /** When set, every /v2 request must send `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** Host header values accepted besides loopback. "*" accepts any. */
  allowedHosts?: string[];
  /** Browser origins allowed to call the API. Requests carrying any other Origin are refused. */
  allowedOrigins?: string[];
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * v2-style HTTP API: POST /v2/scrape, /v2/map, /v2/crawl, /v2/search,
 * /v2/parse plus crawl status, errors and account endpoints, all answering
 * `{ success, ... }` envelopes. Any client that lets you override its API
 * base URL can point at http://127.0.0.1:3002.
 *
 * Browser-origin requests are refused by default (Origin header present but
 * not allowlisted), the Host header must be loopback or allowlisted (DNS
 * rebinding), JSON routes require application/json (no CORS-safelisted
 * form posts), and bodies are size-limited.
 */
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const apiKey = options.apiKey ?? process.env.OPENCRAWL_API_KEY;
  const allowedHosts = new Set([...(options.allowedHosts ?? []), ...csv(process.env.OPENCRAWL_ALLOWED_HOSTS)].map((h) => h.toLowerCase()));
  const allowedOrigins = new Set([...(options.allowedOrigins ?? []), ...csv(process.env.OPENCRAWL_ALLOWED_ORIGINS)]);
  const allowAnyHost = allowedHosts.has("*");

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message }, err.status);
    if (err instanceof ValidationError || err instanceof InvalidUrlError) return c.json({ success: false, error: err.message }, 400);
    const status = (err as unknown as { status?: unknown }).status;
    return c.json({ success: false, error: err.message }, status === 413 ? 413 : 500);
  });

  app.use("/v2/*", async (c, next) => {
    const host = hostOf(c.req.header("host"));
    if (host !== undefined && !allowAnyHost && !isLoopbackHost(host) && !allowedHosts.has(host)) {
      throw new HttpError(403, `Host "${host}" is not allowed; set OPENCRAWL_ALLOWED_HOSTS`);
    }
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins.has(origin)) {
      throw new HttpError(403, "cross-origin browser requests are not allowed; set OPENCRAWL_ALLOWED_ORIGINS");
    }
    if (apiKey) {
      const auth = c.req.header("authorization") ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!tokenMatches(presented, apiKey)) throw new HttpError(401, "Unauthorized");
    }
    const isUpload = c.req.path === "/v2/parse";
    if (c.req.method === "POST" && !isUpload) {
      const type = c.req.header("content-type") ?? "";
      if (!type.toLowerCase().includes("application/json")) throw new HttpError(415, "Content-Type must be application/json");
    }
    return bodyLimit({
      maxSize: isUpload ? UPLOAD_BODY_LIMIT : JSON_BODY_LIMIT,
      onError: () => {
        throw new HttpError(413, "request body too large");
      },
    })(c, next);
  });

  app.get("/", (c) => c.json({ status: "ok", name: "opencrawl", version: VERSION }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/v2/health", (c) => c.json({ status: "ok" }));

  app.post("/v2/scrape", async (c) => {
    const { url, ...rest } = validate(scrapeRequestSchema, await readJson(c));
    const data = await scrape(url, resolveScrapeOptions(rest));
    return c.json({ success: true, data });
  });

  app.post("/v2/map", async (c) => {
    const { url, ...rest } = validate(mapRequestSchema, await readJson(c));
    const result = await map(url, rest);
    return c.json({ success: true, links: result.links });
  });

  app.post("/v2/crawl", async (c) => {
    const { url, scrapeOptions, ...rest } = validate(crawlRequestSchema, await readJson(c));
    const { id, url: started } = startCrawl(url, { ...rest, scrapeOptions: scrapeOptions ? resolveScrapeOptions(scrapeOptions) : undefined });
    return c.json({ success: true, id, url: started });
  });

  app.get("/v2/crawl/active", (c) => c.json({ success: true, crawls: listActiveCrawls() }));

  app.get("/v2/crawl/:id", (c) => {
    const id = c.req.param("id");
    const skip = Math.max(0, Number.parseInt(c.req.query("skip") ?? "0", 10) || 0);
    const limit = Math.max(1, Math.min(Number.parseInt(c.req.query("limit") ?? "", 10) || CRAWL_PAGE_SIZE, 10_000));
    const job = getCrawlStatus(id, { skip, limit });
    if (!job) throw new HttpError(404, "Job not found");
    const { hasMore, ...rest } = job;
    const next = hasMore ? `${new URL(c.req.url).origin}/v2/crawl/${id}?skip=${skip + limit}&limit=${limit}` : null;
    return c.json({ success: true, ...rest, next });
  });

  app.get("/v2/crawl/:id/errors", (c) => {
    const errors = getCrawlErrors(c.req.param("id"));
    if (!errors) throw new HttpError(404, "Job not found");
    return c.json({ success: true, ...errors });
  });

  app.delete("/v2/crawl/:id", (c) => {
    if (!cancelCrawl(c.req.param("id"))) throw new HttpError(404, "Job not found");
    return c.json({ success: true, status: "cancelled" });
  });

  app.post("/v2/search", async (c) => {
    const { scrapeOptions, ...request } = validate(searchRequestSchema, await readJson(c));
    const result = await search({ ...request, scrapeOptions: scrapeOptions ? resolveScrapeOptions(scrapeOptions) : undefined });
    return c.json({ success: true, data: result.data, warning: result.warning, id: randomUUID(), creditsUsed: 0 });
  });

  app.post("/v2/extract", async (c) => {
    const { url, scrapeOptions, ...options } = validate(extractRequestSchema, await readJson(c));
    const data = await extract(url, { ...options, scrapeOptions: scrapeOptions ? resolveScrapeOptions(scrapeOptions) : undefined });
    return c.json({ success: true, data });
  });

  app.post("/v2/watch", async (c) => {
    const { url, scrapeOptions, diff } = validate(watchRequestSchema, await readJson(c));
    const result = await watch(url, { diff, scrapeOptions: scrapeOptions ? resolveScrapeOptions(scrapeOptions) : undefined });
    return c.json({ success: true, ...result });
  });

  app.get("/v2/watches", (c) =>
    c.json({
      success: true,
      watches: getStore()
        .listWatches()
        .map((w) => ({
          url: w.url,
          checkCount: w.checkCount,
          lastCheckedAt: w.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : null,
          lastChangedAt: w.lastChangedAt ? new Date(w.lastChangedAt).toISOString() : null,
        })),
    }),
  );

  app.post("/v2/local-search", async (c) => {
    const { query, ...options } = validate(localSearchRequestSchema, await readJson(c));
    return c.json({ success: true, data: getStore().searchLocal(query, options) });
  });

  app.post("/v2/parse", async (c) => {
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw new HttpError(400, 'multipart field "file" is required');
      // Never trust the client's filename: keep only a vetted extension.
      const original = path.basename(typeof file.name === "string" && file.name ? file.name : "upload");
      const ext = path.extname(original).toLowerCase();
      if (!PARSE_EXTENSIONS.has(ext)) {
        throw new HttpError(400, `Unsupported file type "${ext || "(none)"}". opencrawl parses PDF, HTML and plain-text files.`);
      }
      let parseOptions = {};
      if (typeof form.options === "string" && form.options.trim()) {
        let raw: unknown;
        try {
          raw = JSON.parse(form.options);
        } catch (err) {
          throw new HttpError(400, `Invalid options JSON: ${(err as Error).message}`);
        }
        parseOptions = validate(parseOptionsSchema, raw);
      }
      const dir = await mkdtemp(path.join(tmpdir(), "opencrawl-upload-"));
      try {
        const filePath = path.join(dir, `upload${ext}`);
        await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
        const data = await parseFile(filePath, resolveScrapeOptions(parseOptions));
        if (data.metadata) {
          data.metadata.sourceURL = original;
          data.metadata.url = original;
        }
        return c.json({ success: true, data });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    if (!contentType.includes("application/json")) throw new HttpError(415, "Content-Type must be multipart/form-data or application/json");
    // A raw filePath reads from this machine's disk, so only loopback callers
    // (or an explicit opt-in) may use it. Remote callers must upload.
    if (!isLocalCaller(c) && process.env.OPENCRAWL_ALLOW_REMOTE_FILE_PATHS !== "1") {
      throw new HttpError(403, "filePath is only accepted from localhost; upload the file as multipart form-data instead");
    }
    const { filePath, ...parseOptions } = validate(parseRequestSchema, await readJson(c));
    const data = await parseFile(filePath, resolveScrapeOptions(parseOptions));
    return c.json({ success: true, data });
  });

  // Account endpoints the official CLI calls before bulk operations. There
  // are no credits locally, so report an effectively unlimited plan.
  app.get("/v2/team/credit-usage", (c) =>
    c.json({
      success: true,
      data: { remainingCredits: 999_999_999, planCredits: 999_999_999, billingPeriodStart: null, billingPeriodEnd: null },
    }),
  );
  app.get("/v2/team/token-usage", (c) =>
    c.json({ success: true, data: { remainingTokens: 999_999_999, planTokens: 999_999_999, billingPeriodStart: null, billingPeriodEnd: null } }),
  );
  app.get("/v2/team/queue-status", (c) =>
    c.json({
      success: true,
      jobsInQueue: activeCrawlCount(),
      activeJobsInQueue: activeCrawlCount(),
      waitingJobsInQueue: 0,
      maxConcurrency: MAX_CRAWL_CONCURRENCY,
      mostRecentSuccess: null,
    }),
  );
  app.get("/v2/concurrency-check", (c) =>
    c.json({ success: true, concurrency: activeCrawlCount(), maxConcurrency: MAX_CRAWL_CONCURRENCY }),
  );

  return app;
}

export interface ServeOptions extends AppOptions {
  port?: number;
  host?: string;
}

export function startServer(options: ServeOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 3002);
  const hostname = options.host ?? process.env.HOST ?? "127.0.0.1";
  const apiKey = options.apiKey ?? process.env.OPENCRAWL_API_KEY;
  const bindsEverywhere = hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]";
  if (!isLoopbackHost(hostname) && !apiKey && process.env.OPENCRAWL_INSECURE !== "1") {
    throw new Error(
      `Refusing to listen on ${hostname} without OPENCRAWL_API_KEY. Set a key, or OPENCRAWL_INSECURE=1 to expose an unauthenticated scraper on purpose.`,
    );
  }
  const allowedHosts = [...(options.allowedHosts ?? []), bindsEverywhere ? "*" : hostname];
  const app = createApp({ ...options, apiKey, allowedHosts });
  const server = serve({ fetch: app.fetch, port, hostname });
  return { server, port, hostname, app };
}
