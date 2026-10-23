import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import type { DocumentMetadata } from "./types.js";

export const BASE64_IMAGE_PLACEHOLDER = "<Base64-Image-Removed>";

export function parseHtml(html: string, url: string): JSDOM {
  return new JSDOM(html, { url, virtualConsole: new VirtualConsole(), contentType: "text/html" });
}

function resolve(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

const META_FIELDS: Array<[keyof DocumentMetadata & string, string[]]> = [
  ["description", ['meta[name="description"]', 'meta[property="og:description"]']],
  ["keywords", ['meta[name="keywords"]']],
  ["robots", ['meta[name="robots"]']],
  ["ogTitle", ['meta[property="og:title"]']],
  ["ogDescription", ['meta[property="og:description"]']],
  ["ogUrl", ['meta[property="og:url"]']],
  ["ogImage", ['meta[property="og:image"]']],
  ["ogSiteName", ['meta[property="og:site_name"]']],
  ["ogLocale", ['meta[property="og:locale"]']],
  ["publishedTime", ['meta[property="article:published_time"]', 'meta[name="publishedTime"]', 'meta[name="date"]']],
  ["modifiedTime", ['meta[property="article:modified_time"]', 'meta[name="modifiedTime"]']],
  ["articleTag", ['meta[property="article:tag"]']],
  ["articleSection", ['meta[property="article:section"]']],
];

export function extractMetadata(document: Document, finalUrl: string): DocumentMetadata {
  const meta: DocumentMetadata = {};
  const title = document.querySelector("title")?.textContent?.trim();
  if (title) meta.title = title;
  for (const [key, selectors] of META_FIELDS) {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.getAttribute("content")?.trim();
      if (value) {
        meta[key] = value;
        break;
      }
    }
  }
  if (!meta.title && meta.ogTitle) meta.title = meta.ogTitle;
  const lang = document.documentElement.getAttribute("lang")?.trim();
  if (lang) meta.language = lang;
  const icon = document.querySelector('link[rel~="icon"]')?.getAttribute("href") ?? "/favicon.ico";
  const favicon = resolve(icon, finalUrl);
  if (favicon) meta.favicon = favicon;
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const canonicalUrl = resolve(canonical, finalUrl);
  if (canonicalUrl) meta.canonical = canonicalUrl;
  return meta;
}

const SKIP_HREF = /^(javascript:|mailto:|tel:|sms:|data:|blob:|#)/i;

export interface LinkWithText {
  url: string;
  text?: string;
}

export function extractLinksWithText(document: Document, baseUrl: string): LinkWithText[] {
  const seen = new Map<string, LinkWithText>();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href")?.trim();
    if (!href || SKIP_HREF.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";
    const text = anchor.textContent?.replace(/\s+/g, " ").trim() || undefined;
    const existing = seen.get(url.href);
    if (!existing) seen.set(url.href, { url: url.href, text });
    else if (!existing.text && text) existing.text = text;
  }
  return [...seen.values()];
}

export function extractLinks(document: Document, baseUrl: string): string[] {
  return extractLinksWithText(document, baseUrl).map((l) => l.url);
}

export function extractImages(document: Document, baseUrl: string): string[] {
  const out = new Set<string>();
  const push = (value: string | null | undefined) => {
    const src = value?.trim();
    if (!src || /^(data:|blob:|javascript:)/i.test(src)) return;
    const abs = resolve(src, baseUrl);
    if (abs && /^https?:/.test(abs)) out.add(abs);
  };
  for (const img of document.querySelectorAll("img")) {
    push(img.getAttribute("src") ?? img.getAttribute("data-src"));
    const srcset = img.getAttribute("srcset");
    if (srcset) push(srcset.split(",")[0]?.trim().split(/\s+/)[0]);
  }
  for (const source of document.querySelectorAll("picture source[srcset]")) {
    push(source.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/)[0]);
  }
  const og = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
  push(og);
  return [...out];
}

export function extractAttributes(
  document: Document,
  selectors: Array<{ selector: string; attribute: string }>,
): Array<{ selector: string; attribute: string; values: string[] }> {
  return selectors.map(({ selector, attribute }) => {
    const values: string[] = [];
    try {
      for (const el of document.querySelectorAll(selector)) {
        const v = el.getAttribute(attribute);
        if (v !== null) values.push(v);
      }
    } catch {
      /* invalid selector: return no values */
    }
    return { selector, attribute, values };
  });
}

const URL_ATTRS: Array<[string, string]> = [
  ["a[href]", "href"],
  ["img[src]", "src"],
  ["img[data-src]", "data-src"],
  ["source[src]", "src"],
  ["video[src]", "src"],
  ["audio[src]", "src"],
  ["iframe[src]", "src"],
  ["link[href]", "href"],
];

/** Rewrite relative href/src attributes into absolute URLs so markdown links work out of context. */
export function absolutizeUrls(document: Document, baseUrl: string): void {
  for (const [selector, attr] of URL_ATTRS) {
    for (const el of document.querySelectorAll(selector)) {
      const value = el.getAttribute(attr)?.trim();
      if (!value || SKIP_HREF.test(value)) continue;
      const abs = resolve(value, baseUrl);
      if (abs && abs !== value) el.setAttribute(attr, abs);
    }
  }
}

function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

export function applyTagFilters(document: Document, includeTags?: string[], excludeTags?: string[]): void {
  for (const selector of excludeTags ?? []) {
    for (const el of safeQueryAll(document, selector)) el.remove();
  }
  if (includeTags && includeTags.length > 0) {
    const kept: Element[] = [];
    for (const selector of includeTags) kept.push(...safeQueryAll(document, selector));
    const wrapper = document.createElement("div");
    for (const el of kept) wrapper.appendChild(el.cloneNode(true));
    document.body.replaceChildren(wrapper);
  }
}

/** Elements that never carry readable content. */
const ALWAYS_REMOVE = "script, style, noscript, template, link, meta";

/** Page chrome removed when onlyMainContent is on. */
const CHROME_SELECTORS = [
  "header",
  "footer",
  "nav",
  "aside",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="dialog"]',
  '[aria-hidden="true"]',
  ".header",
  "#header",
  ".footer",
  "#footer",
  ".navbar",
  ".nav",
  "#nav",
  ".navigation",
  ".menu",
  ".sidebar",
  "#sidebar",
  ".side",
  ".aside",
  ".modal",
  ".popup",
  "#modal",
  ".overlay",
  ".ad",
  ".ads",
  ".advert",
  ".advertisement",
  "#ad",
  ".cookie",
  "#cookie",
  ".cookie-banner",
  "#cookie-banner",
  ".breadcrumbs",
  "#breadcrumbs",
  ".share",
  "#share",
  ".social",
  ".social-links",
  ".widget",
  ".lang-selector",
  "#language-selector",
].join(", ");

export function textLength(el: Element): number {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

/**
 * Pick the element whose contents become markdown/html. With
 * onlyMainContent the page chrome is stripped and a <main>/<article>
 * landmark is preferred when it carries real text.
 */
/**
 * The element that holds the page's primary content, when the page says so
 * unambiguously: a <main>/[role=main], or exactly one <article>, or exactly
 * one of the conventional content ids/classes. Multi-article index pages
 * return null so nothing gets dropped.
 */
export function findLandmark(document: Document): Element | null {
  const main = document.querySelector("main, [role='main']");
  if (main) return main;
  const articles = document.querySelectorAll("article");
  if (articles.length === 1) return articles[0]!;
  for (const selector of ["#main", "#content", ".main-content", ".content"]) {
    const matches = safeQueryAll(document, selector);
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

export function selectMainContent(document: Document, onlyMainContent: boolean): Element {
  for (const el of safeQueryAll(document, ALWAYS_REMOVE)) el.remove();
  const body = document.body ?? document.documentElement;
  if (!onlyMainContent) return body;
  const landmark = findLandmark(document);
  for (const el of safeQueryAll(document, CHROME_SELECTORS)) {
    if (landmark && (el === landmark || el.contains(landmark))) continue;
    el.remove();
  }
  if (landmark && landmark.isConnected && textLength(landmark) >= Math.min(200, textLength(body) * 0.3)) {
    return landmark;
  }
  return body;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
  strongDelimiter: "**",
  hr: "---",
});
turndown.use(gfm);
const MARKDOWN_DROP = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed"]);
turndown.remove((node) => MARKDOWN_DROP.has(node.nodeName.toLowerCase()));

export function htmlToMarkdown(html: string): string {
  const md = turndown.turndown(html);
  return md
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Serialize an element to HTML with the noise elements already removed. */
export function serializeClean(el: Element): string {
  if (el.tagName === "BODY") {
    return el.ownerDocument.documentElement.outerHTML;
  }
  return el.outerHTML;
}

const BASE64_IMAGE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

export function replaceBase64Images(input: string): string {
  return input.replace(BASE64_IMAGE, BASE64_IMAGE_PLACEHOLDER);
}

const INVISIBLE_TEXT_PARENTS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT

/** Length of the visible text under `root`, stopping early once `cap` is reached. */
export function visibleTextLength(root: Node, cap = Number.POSITIVE_INFINITY): number {
  const walker = root.ownerDocument!.createTreeWalker(root, SHOW_TEXT);
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent && INVISIBLE_TEXT_PARENTS.has(parent.tagName)) continue;
    total += (node.textContent ?? "").replace(/\s+/g, " ").trim().length;
    if (total >= cap) return total;
  }
  return total;
}

const APP_ROOT_IDS = ["root", "app", "__next", "__nuxt", "app-root", "main", "react-root"];
const JS_SHELL_TEXT_THRESHOLD = 100;

/**
 * Heuristic for "this HTML is an empty shell filled in by JavaScript".
 * True when external scripts exist and either a known app root is empty,
 * a <noscript> asks for JavaScript, or the visible text is under 100
 * characters. Small static pages with a script tag stay on plain HTTP.
 * Works on the parsed DOM so hostile markup costs linear time.
 */
export function documentLooksLikeJsShell(document: Document): boolean {
  if (!document.querySelector("script[src]")) return false;
  const body = document.body;
  if (!body) return true;
  for (const id of APP_ROOT_IDS) {
    const root = document.getElementById(id);
    if (root && root.children.length === 0 && (root.textContent ?? "").trim() === "") return true;
  }
  for (const noscript of document.querySelectorAll("noscript")) {
    if (/(enable|requires?) javascript/i.test(noscript.textContent ?? "")) return true;
  }
  return visibleTextLength(body, JS_SHELL_TEXT_THRESHOLD) < JS_SHELL_TEXT_THRESHOLD;
}

/** String convenience wrapper around documentLooksLikeJsShell. */
export function looksLikeJsShell(html: string): boolean {
  return documentLooksLikeJsShell(parseHtml(html, "http://localhost/").window.document);
}
