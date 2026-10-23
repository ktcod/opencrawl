import { Agent } from "undici";
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, DESKTOP_USER_AGENT, MAX_RESPONSE_BYTES, MAX_RETRY_WAIT_MS, MOBILE_USER_AGENT } from "./config.js";

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Abort once the body exceeds this many bytes. Defaults to MAX_RESPONSE_BYTES. */
  maxBytes?: number;
  /** Retries on 429/503 (default DEFAULT_RETRIES). 0 disables. */
  retries?: number;
  timeoutMs?: number;
  skipTlsVerification?: boolean;
  mobile?: boolean;
  method?: "GET" | "HEAD";
}

export interface FetchedResource {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  headers: Record<string, string>;
}

let insecureAgent: Agent | undefined;

export type FetchFn = (url: string, options?: FetchOptions) => Promise<FetchedResource>;

const RETRY_STATUSES = new Set([429, 503]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long to wait before retrying: Retry-After (seconds or HTTP date) when sane, else exponential backoff with jitter. */
export function retryDelayMs(retryAfter: string | null, attempt: number, now: number = Date.now()): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - now), MAX_RETRY_WAIT_MS);
  }
  const base = 500 * 2 ** attempt;
  return Math.min(base + Math.floor(Math.random() * base * 0.25), MAX_RETRY_WAIT_MS);
}

/** Plain HTTP fetch with a browser-like header set, a timeout, redirect following and 429/503 retries. */
export const fetchResource: FetchFn = async (url, options = {}) => {
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  for (let attempt = 0; ; attempt++) {
    const res = await fetchOnce(url, options);
    if (!RETRY_STATUSES.has(res.status) || attempt >= retries) return res;
    await sleep(retryDelayMs(res.headers["retry-after"] ?? null, attempt));
  }
};

async function fetchOnce(url: string, options: FetchOptions): Promise<FetchedResource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "user-agent": options.mobile ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7",
      "accept-language": "en-US,en;q=0.9",
      ...lowerCaseKeys(options.headers),
    };
    const init: RequestInit & { dispatcher?: Agent } = {
      method: options.method ?? "GET",
      redirect: "follow",
      signal: controller.signal,
      headers,
    };
    if (options.skipTlsVerification) {
      insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
      init.dispatcher = insecureAgent;
    }
    const res = await fetch(url, init as RequestInit);
    const body = await readBodyCapped(res, options.maxBytes ?? MAX_RESPONSE_BYTES, url);
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    return {
      url: res.url || url,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body,
      headers: outHeaders,
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body into a Buffer, aborting once it exceeds `maxBytes`. */
async function readBodyCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response body exceeded ${maxBytes} bytes: ${url}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function lowerCaseKeys(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

/** Decode a response body honoring the content-type or <meta charset> declaration. */
export function decodeText(body: Buffer, contentType: string): string {
  let charset = /charset=([^;\s"']+)/i.exec(contentType)?.[1]?.toLowerCase();
  if (!charset) {
    const head = body.subarray(0, 4096).toString("latin1");
    charset = /<meta[^>]+charset=["']?\s*([a-z0-9_-]+)/i.exec(head)?.[1]?.toLowerCase();
  }
  if (!charset || charset === "utf8") charset = "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return body.toString("utf8");
  }
}

export type ContentKind = "html" | "pdf" | "text" | "binary";

export function classifyContent(contentType: string, url: string): ContentKind {
  const ct = contentType.toLowerCase();
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    /* ignore */
  }
  if (ct.includes("application/pdf") || (pathname.endsWith(".pdf") && !ct.includes("html"))) return "pdf";
  if (!ct || ct.includes("text/html") || ct.includes("application/xhtml")) return "html";
  if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("javascript")) return "text";
  return "binary";
}
