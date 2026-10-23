import { createTwoFilesPatch, diffLines } from "diff";
import { scrapeWithStore, type ScrapeDeps } from "./scrape.js";
import { documentKey, getStore, type StoredDocument } from "./store.js";
import { normalizeUrl } from "./urls.js";
import type { FormatOption, ScrapeOptions } from "./types.js";

export type WatchStatus = "new" | "same" | "changed" | "removed" | "error";

export interface WatchSnapshotInfo {
  fetchedAt: string;
  title?: string;
  statusCode?: number;
}

export interface WatchResult {
  url: string;
  status: WatchStatus;
  checkedAt: string;
  checkCount: number;
  previous?: WatchSnapshotInfo;
  current?: WatchSnapshotInfo;
  /** Unified diff of the markdown when the page changed and `diff` was not disabled. */
  diff?: string;
  linesAdded?: number;
  linesRemoved?: number;
  lastChangedAt?: string;
  error?: string;
}

export interface WatchOptions {
  scrapeOptions?: ScrapeOptions;
  /** Include a unified diff on change (default true). */
  diff?: boolean;
}

const info = (doc: StoredDocument): WatchSnapshotInfo => ({
  fetchedAt: new Date(doc.fetchedAt).toISOString(),
  title: doc.title,
  statusCode: doc.statusCode,
});

/**
 * Re-scrape a URL and report whether it changed since the last check. The
 * first call records a baseline ("new"); a 404/410 after a baseline is
 * "removed". Snapshots live in the store, so the baseline can also be a
 * document an earlier scrape or crawl already saved.
 */
export async function watch(input: string, options: WatchOptions = {}, deps: ScrapeDeps = {}): Promise<WatchResult> {
  const store = deps.store === false ? null : (deps.store ?? getStore());
  if (!store) throw new Error("watch needs a store");
  const url = normalizeUrl(input);
  const key = documentKey(url);
  const state = store.getWatch(url) ?? { key, url, lastDocumentId: null, lastCheckedAt: null, lastChangedAt: null, checkCount: 0 };
  const previous = (state.lastDocumentId !== null ? store.getDocumentById(state.lastDocumentId) : undefined) ?? store.getLatestDocument(url);
  const now = Date.now();
  const base: ScrapeOptions = { ...(options.scrapeOptions ?? {}), maxAge: 0, storeInCache: true };
  const formats: FormatOption[] = base.formats?.length ? [...base.formats] : ["markdown"];
  if (!formats.some((f) => (typeof f === "string" ? f : f.type).toLowerCase() === "markdown")) formats.push("markdown");
  base.formats = formats;

  const result: WatchResult = { url, status: "error", checkedAt: new Date(now).toISOString(), checkCount: state.checkCount + 1 };
  if (previous) result.previous = info(previous);
  let current: StoredDocument | undefined;
  try {
    const { storedId } = await scrapeWithStore(url, base, { ...deps, store });
    current = storedId !== null ? store.getDocumentById(storedId) : undefined;
  } catch (err) {
    result.error = (err as Error).message;
  }

  if (current) {
    result.current = info(current);
    const status = current.statusCode ?? 200;
    if (status === 404 || status === 410) {
      result.status = previous ? "removed" : "error";
      if (!previous) result.error = `HTTP ${status}`;
    } else if (status >= 400) {
      result.status = "error";
      result.error = `HTTP ${status}`;
    } else if (!previous) {
      result.status = "new";
    } else if (previous.contentHash === current.contentHash) {
      result.status = "same";
    } else {
      result.status = "changed";
      const before = `${(previous.document.markdown ?? previous.document.html ?? "").replace(/\n+$/, "")}\n`;
      const after = `${(current.document.markdown ?? current.document.html ?? "").replace(/\n+$/, "")}\n`;
      const contentLines = (text: string) => text.split("\n").filter((line) => line.trim().length > 0).length;
      let added = 0;
      let removed = 0;
      for (const part of diffLines(before, after)) {
        if (part.added) added += contentLines(part.value);
        else if (part.removed) removed += contentLines(part.value);
      }
      result.linesAdded = added;
      result.linesRemoved = removed;
      if (options.diff !== false) {
        result.diff = createTwoFilesPatch(url, url, before, after, result.previous?.fetchedAt ?? "", result.current.fetchedAt, { context: 3 });
      }
    }
  }

  const changed = result.status === "new" || result.status === "changed" || result.status === "removed";
  const next = {
    key,
    url,
    lastDocumentId: current && (result.status === "new" || result.status === "changed" || result.status === "same") ? current.id : state.lastDocumentId,
    lastCheckedAt: now,
    lastChangedAt: changed ? now : state.lastChangedAt,
    checkCount: state.checkCount + 1,
  };
  store.upsertWatch(next);
  if (next.lastChangedAt !== null) result.lastChangedAt = new Date(next.lastChangedAt).toISOString();
  return result;
}
