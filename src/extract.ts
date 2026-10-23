import { parseHtml } from "./html.js";
import { scrapeWithStore, type ScrapeDeps } from "./scrape.js";
import { normalizeUrl } from "./urls.js";
import type { ScrapeOptions } from "./types.js";

/**
 * Structured extraction without a language model: the machine-readable data
 * pages already carry (JSON-LD, microdata, Open Graph, Twitter cards, meta
 * tags), caller-supplied CSS selectors, and HTML tables as JSON or CSV.
 */

export type StructuredSource = "jsonLd" | "microdata" | "openGraph" | "twitter" | "meta";
const ALL_SOURCES: StructuredSource[] = ["jsonLd", "microdata", "openGraph", "twitter", "meta"];

export interface SelectorSpec {
  /** CSS selector, evaluated relative to the page (or to the parent match inside `fields`). */
  selector: string;
  /** Attribute to read; implies type "attribute". href/src style attributes are absolutized. */
  attribute?: string;
  /** What to return per match: collapsed text (default), innerHTML, or an attribute value. */
  type?: "text" | "html" | "attribute";
  /** Return every match as an array instead of the first match. */
  multiple?: boolean;
  /** Sub-selectors evaluated inside each match; the match becomes an object. */
  fields?: Record<string, SelectorSpec | string>;
}

export interface TableOptions {
  /** Only tables matching (or inside) this selector (default: every <table>). */
  selector?: string;
  /** Also return each table as RFC 4180 CSV. */
  csv?: boolean;
  /** Cap on body rows per table (default 1000). */
  maxRows?: number;
  /** Skip tables with fewer body rows than this (default 1). */
  minRows?: number;
}

export interface ExtractOptions {
  /** Which embedded structured data to collect. true (default) means all. */
  structured?: boolean | StructuredSource[];
  /** Named CSS selectors to evaluate. */
  selectors?: Record<string, SelectorSpec | string>;
  /** Extract HTML tables. true (default) uses default TableOptions. */
  tables?: boolean | TableOptions;
}

export interface ExtractedTable {
  /** Position among the page's tables (0-based, before filtering). */
  index: number;
  caption?: string;
  headers: string[];
  /** Objects keyed by header when a header row exists, otherwise arrays of cells. */
  rows: Array<Record<string, string>> | string[][];
  rowCount: number;
  columnCount: number;
  csv?: string;
}

export interface MicrodataItem {
  "@type"?: string | string[];
  "@id"?: string;
  [property: string]: unknown;
}

export interface ExtractResult {
  url: string;
  jsonLd?: unknown[];
  microdata?: MicrodataItem[];
  openGraph?: Record<string, string | string[]>;
  twitter?: Record<string, string>;
  meta?: Record<string, string>;
  selected?: Record<string, unknown>;
  tables?: ExtractedTable[];
  /** Problems that did not stop extraction, keyed by what failed. */
  errors?: Record<string, string>;
}

const collapse = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

function absolutize(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

const URL_ATTRIBUTES = new Set(["href", "src", "action", "data-src", "poster", "cite", "formaction"]);

// ------------------------------------------------------------------ JSON-LD

export function extractJsonLd(document: Document, errors: Record<string, string>): unknown[] {
  const out: unknown[] = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  scripts.forEach((script, index) => {
    const raw = (script.textContent ?? "")
      .replace(/^\s*<!--/, "")
      .replace(/-->\s*$/, "")
      .replace(/^\s*\/\/\s*<!\[CDATA\[/, "")
      .replace(/\/\/\s*\]\]>\s*$/, "")
      .trim();
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch (err) {
      errors[`jsonLd[${index}]`] = `invalid JSON: ${(err as Error).message}`;
    }
  });
  return out;
}

// ---------------------------------------------------------------- microdata

function microdataValue(el: Element, baseUrl: string, seen: Set<Element>): unknown {
  if (el.hasAttribute("itemscope")) return microdataItem(el, baseUrl, seen);
  const tag = el.tagName.toLowerCase();
  const attr = (name: string) => el.getAttribute(name)?.trim();
  switch (tag) {
    case "meta":
      return attr("content") ?? "";
    case "audio":
    case "embed":
    case "iframe":
    case "img":
    case "source":
    case "track":
    case "video":
      return absolutize(attr("src") ?? "", baseUrl);
    case "a":
    case "area":
    case "link":
      return absolutize(attr("href") ?? "", baseUrl);
    case "object":
      return absolutize(attr("data") ?? "", baseUrl);
    case "data":
    case "meter":
      return attr("value") ?? collapse(el.textContent);
    case "time":
      return attr("datetime") ?? collapse(el.textContent);
    default:
      return attr("content") ?? collapse(el.textContent);
  }
}

function collectProperties(scope: Element, out: Element[]): void {
  for (const child of scope.children) {
    if (child.hasAttribute("itemprop")) out.push(child);
    // A nested item owns its own properties; everything else may still hold ours.
    if (!child.hasAttribute("itemscope")) collectProperties(child, out);
  }
}

function microdataItem(el: Element, baseUrl: string, seen: Set<Element>): MicrodataItem {
  const item: MicrodataItem = {};
  if (seen.has(el)) return item;
  seen.add(el);
  const types = (el.getAttribute("itemtype") ?? "").split(/\s+/).filter(Boolean);
  if (types.length === 1) item["@type"] = types[0];
  else if (types.length > 1) item["@type"] = types;
  const id = el.getAttribute("itemid")?.trim();
  if (id) item["@id"] = absolutize(id, baseUrl);
  const propertyElements: Element[] = [];
  collectProperties(el, propertyElements);
  for (const refId of (el.getAttribute("itemref") ?? "").split(/\s+/).filter(Boolean)) {
    const referenced = el.ownerDocument.getElementById(refId);
    if (!referenced) continue;
    if (referenced.hasAttribute("itemprop")) propertyElements.push(referenced);
    collectProperties(referenced, propertyElements);
  }
  for (const propertyElement of propertyElements) {
    const value = microdataValue(propertyElement, baseUrl, seen);
    for (const name of (propertyElement.getAttribute("itemprop") ?? "").split(/\s+/).filter(Boolean)) {
      const existing = item[name];
      if (existing === undefined) item[name] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else item[name] = [existing, value];
    }
  }
  return item;
}

export function extractMicrodata(document: Document, baseUrl: string): MicrodataItem[] {
  const seen = new Set<Element>();
  return [...document.querySelectorAll("[itemscope]")]
    .filter((el) => !el.hasAttribute("itemprop"))
    .map((el) => microdataItem(el, baseUrl, seen));
}

// ---------------------------------------------------------- Open Graph, meta

const OG_PREFIXES = ["og:", "article:", "book:", "profile:", "music:", "video:", "product:", "fb:"];
const OG_URL_SUFFIXES = ["image", "url", "audio", "video", "secure_url"];

export function extractOpenGraph(document: Document, baseUrl: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const meta of document.querySelectorAll("meta[property]")) {
    const property = meta.getAttribute("property")?.trim().toLowerCase();
    const content = meta.getAttribute("content")?.trim();
    if (!property || content === undefined || !OG_PREFIXES.some((p) => property.startsWith(p))) continue;
    const value = OG_URL_SUFFIXES.some((s) => property.endsWith(s)) ? absolutize(content, baseUrl) : content;
    const existing = out[property];
    if (existing === undefined) out[property] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[property] = [existing, value];
  }
  return out;
}

export function extractTwitter(document: Document): Record<string, string> {
  const out: Record<string, string> = {};
  for (const meta of document.querySelectorAll('meta[name^="twitter:"], meta[property^="twitter:"]')) {
    const name = (meta.getAttribute("name") ?? meta.getAttribute("property") ?? "").trim().toLowerCase();
    const content = meta.getAttribute("content")?.trim();
    if (name && content !== undefined && out[name] === undefined) out[name] = content;
  }
  return out;
}

export function extractMeta(document: Document, baseUrl: string): Record<string, string> {
  const out: Record<string, string> = {};
  const title = collapse(document.querySelector("title")?.textContent);
  if (title) out.title = title;
  const lang = document.documentElement.getAttribute("lang")?.trim();
  if (lang) out.lang = lang;
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim();
  if (canonical) out.canonical = absolutize(canonical, baseUrl);
  for (const meta of document.querySelectorAll("meta[name]")) {
    const name = meta.getAttribute("name")?.trim().toLowerCase();
    const content = meta.getAttribute("content")?.trim();
    if (!name || name.startsWith("twitter:") || content === undefined || out[name] !== undefined) continue;
    out[name] = content;
  }
  return out;
}

// ---------------------------------------------------------------- selectors

function normalizeSpec(spec: SelectorSpec | string): SelectorSpec {
  if (typeof spec === "string") return { selector: spec };
  return spec;
}

function elementValue(el: Element, spec: SelectorSpec, baseUrl: string, errors: Record<string, string>, path: string): unknown {
  if (spec.fields) {
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(spec.fields)) {
      out[name] = selectValue(el, normalizeSpec(child), baseUrl, errors, `${path}.${name}`);
    }
    return out;
  }
  const type = spec.type ?? (spec.attribute ? "attribute" : "text");
  if (type === "attribute") {
    if (!spec.attribute) {
      errors[path] = 'type "attribute" needs an attribute name';
      return null;
    }
    const value = el.getAttribute(spec.attribute);
    if (value === null) return null;
    return URL_ATTRIBUTES.has(spec.attribute.toLowerCase()) ? absolutize(value.trim(), baseUrl) : value;
  }
  if (type === "html") return el.innerHTML.trim();
  return collapse(el.textContent);
}

function selectValue(root: ParentNode, spec: SelectorSpec, baseUrl: string, errors: Record<string, string>, path: string): unknown {
  let matches: Element[];
  try {
    matches = spec.multiple
      ? [...root.querySelectorAll(spec.selector)]
      : [root.querySelector(spec.selector)].filter((m): m is Element => m !== null);
  } catch (err) {
    errors[path] = `invalid selector "${spec.selector}": ${(err as Error).message}`;
    return spec.multiple ? [] : null;
  }
  if (spec.multiple) return matches.map((el) => elementValue(el, spec, baseUrl, errors, path));
  const first = matches[0];
  return first ? elementValue(first, spec, baseUrl, errors, path) : null;
}

export function extractSelectors(
  document: Document,
  selectors: Record<string, SelectorSpec | string>,
  baseUrl: string,
  errors: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(selectors)) {
    out[name] = selectValue(document, normalizeSpec(spec), baseUrl, errors, name);
  }
  return out;
}

// ------------------------------------------------------------------- tables

function cellText(cell: Element): string {
  const clone = cell.cloneNode(true) as Element;
  for (const br of clone.querySelectorAll("br")) br.replaceWith(" ");
  return collapse(clone.textContent);
}

function spanOf(cell: Element, attr: "colspan" | "rowspan"): number {
  const n = Number.parseInt(cell.getAttribute(attr) ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 1;
}

interface Grid {
  rows: string[][];
  headerRows: number;
}

/** Expand a table into a rectangular grid, honouring colspan/rowspan and detecting header rows. */
function tableGrid(table: Element): Grid {
  const trs = [...table.querySelectorAll("tr")].filter((tr) => tr.closest("table") === table);
  const grid: string[][] = [];
  const occupied: boolean[][] = [];
  const isHeaderRow: boolean[] = [];
  trs.forEach((tr, r) => {
    grid[r] ??= [];
    occupied[r] ??= [];
    const cells = [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH");
    let c = 0;
    for (const cell of cells) {
      while (occupied[r]![c]) c++;
      const text = cellText(cell);
      const rowspan = spanOf(cell, "rowspan");
      const colspan = spanOf(cell, "colspan");
      for (let dr = 0; dr < rowspan; dr++) {
        grid[r + dr] ??= [];
        occupied[r + dr] ??= [];
        for (let dc = 0; dc < colspan; dc++) {
          grid[r + dr]![c + dc] = text;
          occupied[r + dr]![c + dc] = true;
        }
      }
      c += colspan;
    }
    isHeaderRow[r] = tr.parentElement?.tagName === "THEAD" || (cells.length > 0 && cells.every((cell) => cell.tagName === "TH"));
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  const rows = grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
  let headerRows = 0;
  while (headerRows < rows.length && isHeaderRow[headerRows]) headerRows++;
  return { rows, headerRows };
}

function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h || `column_${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

export function toCsv(headers: string[], rows: string[][]): string {
  const quote = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = headers.length ? [headers.map(quote).join(",")] : [];
  for (const row of rows) lines.push(row.map(quote).join(","));
  return lines.join("\n");
}

export function extractTables(document: Document, options: TableOptions = {}): ExtractedTable[] {
  const maxRows = Math.max(1, options.maxRows ?? 1000);
  const minRows = Math.max(1, options.minRows ?? 1);
  const out: ExtractedTable[] = [];
  const all = [...document.querySelectorAll("table")];
  let wanted = all;
  if (options.selector) {
    try {
      const selected = [...document.querySelectorAll(options.selector)];
      wanted = all.filter((t) => selected.some((s) => s === t || s.contains(t)));
    } catch {
      wanted = [];
    }
  }
  for (const table of wanted) {
    const { rows, headerRows } = tableGrid(table);
    const body = rows.slice(headerRows, headerRows + maxRows);
    if (body.length < minRows) continue;
    const width = rows[0]?.length ?? 0;
    const headers =
      headerRows > 0
        ? uniqueHeaders(Array.from({ length: width }, (_, i) => collapse(rows.slice(0, headerRows).map((r) => r[i] ?? "").join(" "))))
        : [];
    const caption = collapse(table.querySelector("caption")?.textContent) || undefined;
    const entry: ExtractedTable = {
      index: all.indexOf(table),
      caption,
      headers,
      rows: headers.length ? body.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]))) : body,
      rowCount: body.length,
      columnCount: width,
    };
    if (options.csv) entry.csv = toCsv(headers, body);
    out.push(entry);
  }
  return out;
}

// ------------------------------------------------------------------ driver

export function extractFromDocument(document: Document, url: string, options: ExtractOptions = {}): ExtractResult {
  const errors: Record<string, string> = {};
  const result: ExtractResult = { url };
  const sources =
    options.structured === false ? [] : options.structured === true || options.structured === undefined ? ALL_SOURCES : options.structured;
  if (sources.includes("jsonLd")) result.jsonLd = extractJsonLd(document, errors);
  if (sources.includes("microdata")) result.microdata = extractMicrodata(document, url);
  if (sources.includes("openGraph")) result.openGraph = extractOpenGraph(document, url);
  if (sources.includes("twitter")) result.twitter = extractTwitter(document);
  if (sources.includes("meta")) result.meta = extractMeta(document, url);
  if (options.selectors && Object.keys(options.selectors).length > 0) {
    result.selected = extractSelectors(document, options.selectors, url, errors);
  }
  if (options.tables !== false) {
    result.tables = extractTables(document, typeof options.tables === "object" ? options.tables : {});
  }
  if (Object.keys(errors).length > 0) result.errors = errors;
  return result;
}

export function extractFromHtml(html: string, url: string, options: ExtractOptions = {}): ExtractResult {
  const dom = parseHtml(html, url);
  return extractFromDocument(dom.window.document, url, options);
}

export interface ExtractRequestOptions extends ExtractOptions {
  scrapeOptions?: ScrapeOptions;
}

/** Fetch a page (browser-rendered when needed) and run structured extraction on it. */
export async function extract(input: string, options: ExtractRequestOptions = {}, deps: ScrapeDeps = {}): Promise<ExtractResult> {
  const url = normalizeUrl(input);
  const { scrapeOptions, ...extractOptions } = options;
  const { document: doc } = await scrapeWithStore(url, { ...(scrapeOptions ?? {}), formats: ["rawHtml"], onlyMainContent: false }, deps);
  const contentType = doc.metadata?.contentType ?? "";
  if (doc.rawHtml === undefined || (contentType && !/html/i.test(contentType))) {
    return { url, errors: { page: doc.warning ?? `no HTML to extract from (${contentType || "unknown content type"})` } };
  }
  const result = extractFromHtml(doc.rawHtml, doc.metadata?.url ?? url, extractOptions);
  result.url = url;
  return result;
}
