import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BATCH_CONCURRENCY, MAX_CRAWL_CONCURRENCY } from "./config.js";
import { scrape, type ScrapeDeps } from "./scrape.js";
import { normalizeUrl } from "./urls.js";
import type { Document as ScrapedDocument, ScrapeOptions } from "./types.js";

// ------------------------------------------------------------- batch scrape

export interface BatchOptions {
  /** Parallel scrapes (default DEFAULT_BATCH_CONCURRENCY, max MAX_CRAWL_CONCURRENCY). */
  concurrency?: number;
  scrapeOptions?: ScrapeOptions;
  /** Report unparsable URLs under `errors` instead of rejecting the whole batch. */
  ignoreInvalidURLs?: boolean;
}

export interface BatchError {
  url: string;
  error: string;
}

export interface BatchResult {
  /** Successful documents in input order (duplicates removed). */
  data: ScrapedDocument[];
  errors: BatchError[];
  /** Distinct URLs submitted. */
  total: number;
  /** Documents returned. */
  completed: number;
}

/** Scrape many URLs with a bounded worker pool, keeping input order in the output. */
export async function batchScrape(urls: string[], options: BatchOptions = {}, deps: ScrapeDeps = {}): Promise<BatchResult> {
  const distinct = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  const errors: BatchError[] = [];
  const targets: string[] = [];
  for (const raw of distinct) {
    try {
      targets.push(normalizeUrl(raw));
    } catch (err) {
      if (!options.ignoreInvalidURLs) throw err;
      errors.push({ url: raw, error: (err as Error).message });
    }
  }
  const concurrency = Math.min(MAX_CRAWL_CONCURRENCY, Math.max(1, options.concurrency ?? DEFAULT_BATCH_CONCURRENCY));
  const results: Array<ScrapedDocument | undefined> = new Array(targets.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const index = next++;
      const url = targets[index]!;
      try {
        results[index] = await scrape(url, options.scrapeOptions ?? {}, deps);
      } catch (err) {
        errors.push({ url, error: (err as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  const data = results.filter((d): d is ScrapedDocument => d !== undefined);
  return { data, errors, total: distinct.length, completed: data.length };
}

// ------------------------------------------------------------ save to disk

const UNSAFE = /[^A-Za-z0-9._-]+/g;

function safeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    /* keep as-is */
  }
  const cleaned = decoded.replace(UNSAFE, "_").replace(/^\.+$/, "_").slice(0, 150);
  return cleaned || "_";
}

/**
 * Directory a page is saved under: `<outDir>/<host>/<path segments>/`, with
 * the query string folded into a short hash so variants do not collide.
 */
export function documentDirectory(url: string, outDir: string): string {
  const parsed = new URL(url);
  const host = safeSegment(parsed.hostname.replace(/^www\./, ""));
  const segments = parsed.pathname.split("/").filter(Boolean).map(safeSegment);
  if (parsed.search) segments.push(`_q_${createHash("sha1").update(parsed.search).digest("hex").slice(0, 8)}`);
  const dir = path.resolve(outDir, host, ...segments);
  const root = path.resolve(outDir);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error(`refusing to write outside ${outDir}`);
  return dir;
}

export interface SavedDocument {
  url: string;
  dir: string;
  files: string[];
}

/** Write one document's formats as files under outDir. Returns what was written. */
export async function saveDocument(doc: ScrapedDocument, outDir: string): Promise<SavedDocument> {
  const url = doc.metadata?.sourceURL ?? doc.metadata?.url;
  if (!url) throw new Error("document has no URL to derive a path from");
  const dir = documentDirectory(url, outDir);
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const put = async (name: string, content: string | Buffer) => {
    const file = path.join(dir, name);
    await writeFile(file, content);
    files.push(file);
  };
  if (doc.markdown !== undefined) await put("index.md", doc.markdown);
  if (doc.html !== undefined) await put("index.html", doc.html);
  if (doc.rawHtml !== undefined) await put("raw.html", doc.rawHtml);
  if (doc.links) await put("links.txt", doc.links.join("\n"));
  if (doc.images) await put("images.txt", doc.images.join("\n"));
  if (doc.extract !== undefined) await put("extract.json", JSON.stringify(doc.extract, null, 2));
  if (doc.attributes) await put("attributes.json", JSON.stringify(doc.attributes, null, 2));
  if (doc.screenshot?.startsWith("data:image/")) {
    const match = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(doc.screenshot);
    if (match) await put(`screenshot.${match[1]}`, Buffer.from(match[2]!, "base64"));
  }
  await put("metadata.json", JSON.stringify(doc.metadata ?? {}, null, 2));
  return { url, dir, files };
}

export interface SaveSummary {
  outDir: string;
  saved: SavedDocument[];
  errors: BatchError[];
}

export async function saveDocuments(docs: ScrapedDocument[], outDir: string): Promise<SaveSummary> {
  const saved: SavedDocument[] = [];
  const errors: BatchError[] = [];
  for (const doc of docs) {
    try {
      saved.push(await saveDocument(doc, outDir));
    } catch (err) {
      errors.push({ url: doc.metadata?.sourceURL ?? "", error: (err as Error).message });
    }
  }
  return { outDir: path.resolve(outDir), saved, errors };
}
