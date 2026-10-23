import { randomUUID } from "node:crypto";
import type { JSDOM } from "jsdom";
import { DEFAULT_MAX_AGE_MS, DEFAULT_TIMEOUT_MS } from "./config.js";
import { classifyContent, decodeText, fetchResource, type FetchFn, type FetchedResource } from "./fetcher.js";
import { renderPage, type RenderFn, type RenderOptions } from "./browser.js";
import {
  absolutizeUrls,
  applyTagFilters,
  documentLooksLikeJsShell,
  extractAttributes,
  extractImages,
  extractLinks,
  extractMetadata,
  htmlToMarkdown,
  parseHtml,
  replaceBase64Images,
  selectMainContent,
  serializeClean,
} from "./html.js";
import { extractPdf, isPdfBuffer } from "./pdf.js";
import { getStore, type Store } from "./store.js";
import { normalizeUrl } from "./urls.js";
import type {
  AttributesFormat,
  Document as ScrapedDocument,
  DocumentMetadata,
  FormatOption,
  ScrapeOptions,
  ScreenshotFormat,
} from "./types.js";

/** Formats that only exist with an LLM behind them. opencrawl reports them as warnings. */
const LLM_FORMATS = new Set(["json", "summary", "changetracking", "branding", "query", "audio", "video", "question", "highlights"]);

/** Canonical (camelCase) spelling for each format, keyed by lowercase. */
const CANONICAL_FORMATS = new Map(
  ["markdown", "html", "rawHtml", "links", "images", "screenshot", "attributes", "summary", "changeTracking", "branding", "json", "query", "audio", "video"].map((f) => [f.toLowerCase(), f]),
);

export interface NormalizedFormats {
  types: Set<string>;
  screenshot?: ScreenshotFormat;
  attributes?: AttributesFormat;
  unsupported: string[];
}

export function normalizeFormats(formats?: FormatOption[]): NormalizedFormats {
  const out: NormalizedFormats = { types: new Set(), unsupported: [] };
  const list: FormatOption[] = Array.isArray(formats) && formats.length > 0 ? formats : ["markdown"];
  for (const format of list) {
    const rawType = typeof format === "string" ? format : format?.type;
    if (typeof rawType !== "string") continue;
    const lower = rawType.toLowerCase();
    const type = CANONICAL_FORMATS.get(lower) ?? rawType;
    if (LLM_FORMATS.has(lower)) {
      out.unsupported.push(type);
      continue;
    }
    if (lower === "screenshot") {
      out.types.add("screenshot");
      out.screenshot = typeof format === "string" ? { type: "screenshot" } : (format as ScreenshotFormat);
      continue;
    }
    if (lower === "attributes") {
      out.types.add("attributes");
      if (typeof format !== "string") out.attributes = format as AttributesFormat;
      continue;
    }
    out.types.add(type);
  }
  if (out.types.size === 0) out.types.add("markdown");
  return out;
}

export interface ScrapeDeps {
  fetch?: FetchFn;
  render?: RenderFn;
  /** Store used for maxAge cache reads and writes. `false` disables both. */
  store?: Store | false;
}

export interface ScrapeResult {
  document: ScrapedDocument;
  /** Row id in the store, or null when nothing was stored. */
  storedId: number | null;
  /** True when the document came from the cache instead of the network. */
  cached: boolean;
  /** When the content was fetched from the network (the snapshot time on a cache hit). */
  fetchedAt: number;
}

export interface PageSource {
  html: string;
  status: number;
  url: string;
  contentType: string;
  screenshot?: string;
  rendered: boolean;
}

function baseMetadata(requested: string, finalUrl: string, status: number, contentType: string): DocumentMetadata {
  return {
    sourceURL: requested,
    url: finalUrl,
    statusCode: status,
    contentType: contentType || undefined,
    scrapeId: randomUUID(),
    proxyUsed: "basic",
    cacheState: "miss",
    creditsUsed: 0,
  };
}

function finish(doc: ScrapedDocument, warnings: string[]): ScrapedDocument {
  if (warnings.length) doc.warning = warnings.join(" | ");
  return doc;
}

/** Build a Document from already-fetched HTML. Shared by scrape() and parseFile(). */
export function documentFromHtml(
  page: PageSource,
  requested: string,
  options: ScrapeOptions,
  nf: NormalizedFormats,
  warnings: string[] = [],
  parsed?: JSDOM,
): ScrapedDocument {
  const dom = parsed ?? parseHtml(page.html, page.url);
  const document = dom.window.document;
  const metadata: DocumentMetadata = {
    ...extractMetadata(document, page.url),
    ...baseMetadata(requested, page.url, page.status, page.contentType),
    rendered: page.rendered,
  };
  absolutizeUrls(document, page.url);
  const doc: ScrapedDocument = { metadata };
  if (nf.types.has("links")) doc.links = extractLinks(document, page.url);
  if (nf.types.has("images")) doc.images = extractImages(document, page.url);
  if (nf.types.has("attributes") && nf.attributes) doc.attributes = extractAttributes(document, nf.attributes.selectors);
  if (nf.types.has("rawHtml")) doc.rawHtml = page.html;
  applyTagFilters(document, options.includeTags, options.excludeTags);
  // An explicit includeTags list is the caller's own main-content choice; do not prune it again.
  const onlyMainContent = (options.onlyMainContent ?? true) && !(options.includeTags && options.includeTags.length > 0);
  const content = selectMainContent(document, onlyMainContent);
  const removeBase64 = options.removeBase64Images ?? true;
  if (nf.types.has("markdown")) {
    const md = htmlToMarkdown(content.innerHTML);
    doc.markdown = removeBase64 ? replaceBase64Images(md) : md;
  }
  if (nf.types.has("html")) {
    const html = serializeClean(content);
    doc.html = removeBase64 ? replaceBase64Images(html) : html;
  }
  if (nf.types.has("screenshot")) {
    if (page.screenshot) doc.screenshot = page.screenshot;
    else warnings.push("screenshot requested but the page was not rendered in a browser");
  }
  return finish(doc, warnings);
}

function pdfMaxPages(options: ScrapeOptions): number | undefined {
  if (options.pdfOptions?.maxPages) return options.pdfOptions.maxPages;
  for (const parser of options.parsers ?? []) {
    if (typeof parser === "object" && parser.type === "pdf" && parser.maxPages) return parser.maxPages;
  }
  return undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const URL_IN_TEXT = /https?:\/\/[^\s)>\]"']+/g;

export async function documentFromPdf(
  data: Buffer,
  requested: string,
  finalUrl: string,
  status: number,
  options: ScrapeOptions,
  nf: NormalizedFormats,
  warnings: string[] = [],
): Promise<ScrapedDocument> {
  const { text, numPages, title } = await extractPdf(data, pdfMaxPages(options));
  const metadata: DocumentMetadata = { ...baseMetadata(requested, finalUrl, status, "application/pdf"), numPages };
  if (title) metadata.title = title;
  const doc: ScrapedDocument = { metadata };
  if (nf.types.has("markdown")) doc.markdown = text;
  if (nf.types.has("html")) {
    doc.html = `<div>${text
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
      .join("\n")}</div>`;
  }
  if (nf.types.has("links")) doc.links = [...new Set(text.match(URL_IN_TEXT) ?? [])];
  return finish(doc, warnings);
}

function documentFromText(res: FetchedResource, requested: string, nf: NormalizedFormats, warnings: string[]): ScrapedDocument {
  const text = decodeText(res.body, res.contentType);
  const doc: ScrapedDocument = { metadata: baseMetadata(requested, res.url, res.status, res.contentType) };
  if (nf.types.has("markdown")) doc.markdown = text;
  if (nf.types.has("rawHtml")) doc.rawHtml = text;
  if (nf.types.has("html")) doc.html = `<pre>${escapeHtml(text)}</pre>`;
  if (nf.types.has("links")) doc.links = [...new Set(text.match(URL_IN_TEXT) ?? [])];
  return finish(doc, warnings);
}

const CACHEABLE_FIELDS = ["markdown", "html", "rawHtml", "links", "images", "attributes"] as const;

/**
 * Scrape one URL into a Document, consulting the store first when `maxAge`
 * allows it and writing the fresh result back unless `storeInCache` is false.
 * Screenshot requests always go to the network (screenshots are not stored).
 */
export async function scrapeWithStore(input: string, options: ScrapeOptions = {}, deps: ScrapeDeps = {}): Promise<ScrapeResult> {
  const store = deps.store === false ? null : (deps.store ?? getStore());
  const url = normalizeUrl(input);
  const nf = normalizeFormats(options.formats);
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE_MS;
  if (store && maxAge > 0 && !nf.types.has("screenshot")) {
    const hit = store.getFreshDocument(url, maxAge, nf.types);
    if (hit) {
      const document: ScrapedDocument = { ...hit.document };
      for (const field of CACHEABLE_FIELDS) if (!nf.types.has(field)) delete document[field];
      document.metadata = { ...document.metadata, cacheState: "hit", cachedAt: new Date(hit.fetchedAt).toISOString() };
      return { document, storedId: hit.id, cached: true, fetchedAt: hit.fetchedAt };
    }
  }
  const fetchedAt = Date.now();
  const document = await scrapeFresh(url, options, nf, deps);
  const storedId = store && (options.storeInCache ?? true) ? store.putDocument(document, url, fetchedAt) : null;
  return { document, storedId, cached: false, fetchedAt };
}

/** Scrape one URL into a Document (see scrapeWithStore). */
export async function scrape(input: string, options: ScrapeOptions = {}, deps: ScrapeDeps = {}): Promise<ScrapedDocument> {
  return (await scrapeWithStore(input, options, deps)).document;
}

/**
 * Network path. Plain HTTP first (fast, no browser). A headless browser is
 * used when the caller asks for a screenshot or waitFor, forces render
 * "always", or when the fetched HTML looks like an empty JavaScript shell.
 */
async function scrapeFresh(url: string, options: ScrapeOptions, nf: NormalizedFormats, deps: ScrapeDeps): Promise<ScrapedDocument> {
  const fetchFn = deps.fetch ?? fetchResource;
  const renderFn = deps.render ?? renderPage;
  const warnings = nf.unsupported.map((f) => `format "${f}" needs an LLM and is not available in opencrawl`);
  if (options.actions && options.actions.length > 0) warnings.push("browser actions are not supported by opencrawl and were ignored");
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const renderMode = options.render ?? "auto";
  const renderOptions: RenderOptions = {
    timeoutMs,
    waitForMs: options.waitFor,
    mobile: options.mobile,
    headers: options.headers,
    skipTlsVerification: options.skipTlsVerification,
    screenshot: nf.screenshot
      ? { fullPage: nf.screenshot.fullPage, quality: nf.screenshot.quality, viewport: nf.screenshot.viewport }
      : null,
  };
  const wantsBrowser = renderMode === "always" || nf.screenshot !== undefined || (options.waitFor ?? 0) > 0;

  if (wantsBrowser && renderMode !== "never") {
    const page: PageSource = { ...(await renderFn(url, renderOptions)), rendered: true };
    return documentFromHtml(page, url, options, nf, warnings);
  }

  const res = await fetchFn(url, {
    headers: options.headers,
    timeoutMs,
    skipTlsVerification: options.skipTlsVerification,
    mobile: options.mobile,
  });
  let kind = classifyContent(res.contentType, res.url);
  if (kind === "binary" && isPdfBuffer(res.body)) kind = "pdf";
  if (kind === "pdf") return documentFromPdf(res.body, url, res.url, res.status, options, nf, warnings);
  if (kind === "text") return documentFromText(res, url, nf, warnings);
  if (kind === "binary") {
    warnings.push(`unsupported content type "${res.contentType}"; nothing to extract`);
    return finish({ metadata: baseMetadata(url, res.url, res.status, res.contentType) }, warnings);
  }

  const html = decodeText(res.body, res.contentType);
  let page: PageSource = { html, status: res.status, url: res.url, contentType: res.contentType, rendered: false };
  let dom: JSDOM | undefined = parseHtml(html, res.url);
  if (renderMode === "auto" && documentLooksLikeJsShell(dom.window.document)) {
    try {
      page = { ...(await renderFn(url, renderOptions)), rendered: true };
      dom = undefined;
    } catch (err) {
      warnings.push(`page looks JavaScript-rendered but could not be rendered: ${(err as Error).message}`);
    }
  }
  return documentFromHtml(page, url, options, nf, warnings, dom);
}
