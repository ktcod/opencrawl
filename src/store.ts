import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { JOB_RETENTION_MS } from "./config.js";
import { dedupeKey } from "./urls.js";
import type { CrawlErrors, CrawlOptions, CrawlStatus, Document as ScrapedDocument } from "./types.js";

type Row = Record<string, SQLOutputValue>;

/** Document fields that count as "formats" for cache matching. */
const FORMAT_FIELDS = ["markdown", "html", "rawHtml", "links", "images", "attributes"] as const;

export interface StoredDocument {
  id: number;
  key: string;
  url: string;
  finalUrl?: string;
  title?: string;
  statusCode?: number;
  contentType?: string;
  contentHash: string;
  formats: string[];
  fetchedAt: number;
  document: ScrapedDocument;
}

export interface SnapshotSummary {
  id: number;
  fetchedAt: number;
  title?: string;
  statusCode?: number;
  contentHash: string;
}

export interface LocalSearchOptions {
  limit?: number;
  /** Only documents whose URL contains this text (for example a hostname). */
  site?: string;
  /** Only documents fetched at or after this time (ISO string or epoch ms). */
  since?: string | number;
}

export interface LocalSearchHit {
  url: string;
  title?: string;
  snippet: string;
  fetchedAt: string;
  /** Lower is better (bm25). */
  score: number;
}

export interface StoredJob {
  id: string;
  url: string;
  status: CrawlStatus;
  total: number;
  completed: number;
  creditsUsed: number;
  expiresAt: string;
  createdAt: number;
  options: CrawlOptions;
  errors: CrawlErrors["errors"];
  robotsBlocked: string[];
}

export interface WatchState {
  key: string;
  url: string;
  lastDocumentId: number | null;
  lastCheckedAt: number | null;
  lastChangedAt: number | null;
  checkCount: number;
}

export function documentKey(url: string): string {
  return dedupeKey(url) ?? url;
}

/** Hash of the content a change-tracker should compare: markdown, else html, else the whole document. */
export function contentHash(doc: ScrapedDocument): string {
  const basis = doc.markdown ?? doc.html ?? doc.rawHtml ?? JSON.stringify({ ...doc, metadata: undefined });
  return createHash("sha256").update(basis).digest("hex");
}

export function resolveStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCRAWL_DB) return env.OPENCRAWL_DB;
  const dir = env.OPENCRAWL_DATA_DIR ?? path.join(homedir(), ".opencrawl");
  return path.join(dir, "opencrawl.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT,
  title TEXT,
  status_code INTEGER,
  content_type TEXT,
  content_hash TEXT NOT NULL,
  formats TEXT NOT NULL,
  markdown TEXT,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_key_fetched ON documents(key, fetched_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, markdown, content='documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, markdown) VALUES (new.id, new.title, new.markdown);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, markdown) VALUES ('delete', old.id, old.title, old.markdown);
END;
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  options TEXT NOT NULL,
  errors TEXT NOT NULL DEFAULT '[]',
  robots_blocked TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS crawl_documents (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  PRIMARY KEY (job_id, seq)
);
CREATE TABLE IF NOT EXISTS watches (
  key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  last_document_id INTEGER,
  last_checked_at INTEGER,
  last_changed_at INTEGER,
  check_count INTEGER NOT NULL DEFAULT 0
);
`;

const str = (v: SQLOutputValue): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: SQLOutputValue): number | undefined => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined);

/** SQLite-backed store for scraped documents, crawl jobs and watch state. */
export class Store {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(dbPath: string = resolveStorePath()) {
    this.path = dbPath;
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.recoverInterruptedJobs();
    this.pruneJobs(JOB_RETENTION_MS);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- documents

  /** Persist a scraped document (screenshots are dropped). Returns the row id. */
  putDocument(doc: ScrapedDocument, requestedUrl: string, fetchedAt: number = Date.now()): number {
    const { screenshot: _screenshot, ...stored } = doc;
    const formats = FORMAT_FIELDS.filter((f) => stored[f] !== undefined);
    const result = this.db
      .prepare(
        `INSERT INTO documents (key, url, final_url, title, status_code, content_type, content_hash, formats, markdown, json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentKey(requestedUrl),
        requestedUrl,
        stored.metadata?.url ?? null,
        stored.metadata?.title ?? null,
        stored.metadata?.statusCode ?? null,
        stored.metadata?.contentType ?? null,
        contentHash(stored),
        JSON.stringify(formats),
        stored.markdown ?? null,
        JSON.stringify(stored),
        fetchedAt,
      );
    return Number(result.lastInsertRowid);
  }

  private rowToDocument(row: Row): StoredDocument {
    return {
      id: num(row.id)!,
      key: str(row.key)!,
      url: str(row.url)!,
      finalUrl: str(row.final_url),
      title: str(row.title),
      statusCode: num(row.status_code),
      contentType: str(row.content_type),
      contentHash: str(row.content_hash)!,
      formats: JSON.parse(str(row.formats) ?? "[]") as string[],
      fetchedAt: num(row.fetched_at)!,
      document: JSON.parse(str(row.json)!) as ScrapedDocument,
    };
  }

  getDocumentById(id: number): StoredDocument | undefined {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
    return row ? this.rowToDocument(row) : undefined;
  }

  getLatestDocument(url: string): StoredDocument | undefined {
    const row = this.db
      .prepare("SELECT * FROM documents WHERE key = ? ORDER BY fetched_at DESC, id DESC LIMIT 1")
      .get(documentKey(url)) as Row | undefined;
    return row ? this.rowToDocument(row) : undefined;
  }

  /**
   * The newest successful snapshot of `url` fetched within `maxAgeMs` that
   * carries every format in `requiredFormats`, or undefined.
   */
  getFreshDocument(url: string, maxAgeMs: number, requiredFormats: Iterable<string>, now: number = Date.now()): StoredDocument | undefined {
    const required = [...requiredFormats].filter((f) => (FORMAT_FIELDS as readonly string[]).includes(f));
    const rows = this.db
      .prepare(
        "SELECT * FROM documents WHERE key = ? AND fetched_at >= ? AND (status_code IS NULL OR status_code < 400) ORDER BY fetched_at DESC, id DESC LIMIT 10",
      )
      .all(documentKey(url), now - maxAgeMs) as Row[];
    for (const row of rows) {
      const doc = this.rowToDocument(row);
      if (required.every((f) => doc.formats.includes(f))) return doc;
    }
    return undefined;
  }

  listSnapshots(url: string, limit = 20): SnapshotSummary[] {
    const rows = this.db
      .prepare("SELECT id, fetched_at, title, status_code, content_hash FROM documents WHERE key = ? ORDER BY fetched_at DESC, id DESC LIMIT ?")
      .all(documentKey(url), limit) as Row[];
    return rows.map((r) => ({
      id: num(r.id)!,
      fetchedAt: num(r.fetched_at)!,
      title: str(r.title),
      statusCode: num(r.status_code),
      contentHash: str(r.content_hash)!,
    }));
  }

  countDocuments(): number {
    return num((this.db.prepare("SELECT COUNT(*) AS n FROM documents").get() as Row).n) ?? 0;
  }

  /** Full-text search over stored titles and markdown. One hit per URL (its best-ranked snapshot). */
  searchLocal(query: string, options: LocalSearchOptions = {}): LocalSearchHit[] {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const terms = query
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`);
    if (terms.length === 0) return [];
    const clauses: string[] = ["documents_fts MATCH ?"];
    const params: SQLInputValue[] = [terms.join(" ")];
    if (options.site) {
      clauses.push("instr(d.url, ?) > 0");
      params.push(options.site);
    }
    if (options.since !== undefined) {
      const since = typeof options.since === "number" ? options.since : Date.parse(options.since);
      if (!Number.isNaN(since)) {
        clauses.push("d.fetched_at >= ?");
        params.push(since);
      }
    }
    params.push(limit * 4);
    const rows = this.db
      .prepare(
        `SELECT d.key, d.url, d.title, d.fetched_at,
                snippet(documents_fts, 1, '[', ']', '…', 20) AS snippet,
                bm25(documents_fts, 2.0, 1.0) AS score
         FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
         WHERE ${clauses.join(" AND ")}
         ORDER BY score LIMIT ?`,
      )
      .all(...params) as Row[];
    const seen = new Set<string>();
    const hits: LocalSearchHit[] = [];
    for (const row of rows) {
      const key = str(row.key)!;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        url: str(row.url)!,
        title: str(row.title),
        snippet: str(row.snippet) ?? "",
        fetchedAt: new Date(num(row.fetched_at)!).toISOString(),
        score: num(row.score) ?? 0,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // ---------------------------------------------------------------- crawl jobs

  insertJob(job: StoredJob): void {
    this.db
      .prepare(
        `INSERT INTO crawl_jobs (id, url, status, total, completed, credits_used, expires_at, created_at, updated_at, options, errors, robots_blocked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.url,
        job.status,
        job.total,
        job.completed,
        job.creditsUsed,
        job.expiresAt,
        job.createdAt,
        Date.now(),
        JSON.stringify(job.options),
        JSON.stringify(job.errors),
        JSON.stringify(job.robotsBlocked),
      );
  }

  updateJob(job: StoredJob): void {
    this.db
      .prepare("UPDATE crawl_jobs SET status = ?, total = ?, completed = ?, credits_used = ?, updated_at = ?, errors = ?, robots_blocked = ? WHERE id = ?")
      .run(job.status, job.total, job.completed, job.creditsUsed, Date.now(), JSON.stringify(job.errors), JSON.stringify(job.robotsBlocked), job.id);
  }

  private rowToJob(row: Row): StoredJob {
    return {
      id: str(row.id)!,
      url: str(row.url)!,
      status: str(row.status) as CrawlStatus,
      total: num(row.total) ?? 0,
      completed: num(row.completed) ?? 0,
      creditsUsed: num(row.credits_used) ?? 0,
      expiresAt: str(row.expires_at)!,
      createdAt: num(row.created_at)!,
      options: JSON.parse(str(row.options) ?? "{}") as CrawlOptions,
      errors: JSON.parse(str(row.errors) ?? "[]") as CrawlErrors["errors"],
      robotsBlocked: JSON.parse(str(row.robots_blocked) ?? "[]") as string[],
    };
  }

  getJob(id: string): StoredJob | undefined {
    const row = this.db.prepare("SELECT * FROM crawl_jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.rowToJob(row) : undefined;
  }

  listJobs(status?: CrawlStatus): StoredJob[] {
    const rows = (
      status
        ? this.db.prepare("SELECT * FROM crawl_jobs WHERE status = ? ORDER BY created_at DESC").all(status)
        : this.db.prepare("SELECT * FROM crawl_jobs ORDER BY created_at DESC").all()
    ) as Row[];
    return rows.map((r) => this.rowToJob(r));
  }

  appendJobDocument(jobId: string, documentId: number): void {
    this.db
      .prepare(
        "INSERT INTO crawl_documents (job_id, seq, document_id) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM crawl_documents WHERE job_id = ?), ?)",
      )
      .run(jobId, jobId, documentId);
  }

  countJobDocuments(jobId: string): number {
    return num((this.db.prepare("SELECT COUNT(*) AS n FROM crawl_documents WHERE job_id = ?").get(jobId) as Row).n) ?? 0;
  }

  getJobDocuments(jobId: string, skip = 0, limit = Number.MAX_SAFE_INTEGER): ScrapedDocument[] {
    const rows = this.db
      .prepare(
        "SELECT d.json FROM crawl_documents c JOIN documents d ON d.id = c.document_id WHERE c.job_id = ? ORDER BY c.seq LIMIT ? OFFSET ?",
      )
      .all(jobId, Math.min(limit, 2_000_000_000), skip) as Row[];
    return rows.map((r) => JSON.parse(str(r.json)!) as ScrapedDocument);
  }

  /** Jobs left in "scraping" by a previous process cannot resume; mark them failed. */
  recoverInterruptedJobs(): number {
    const rows = this.db.prepare("SELECT * FROM crawl_jobs WHERE status = 'scraping'").all() as Row[];
    for (const row of rows) {
      const job = this.rowToJob(row);
      job.status = "failed";
      job.errors.push({ url: job.url, error: "crawl interrupted by process restart", timestamp: new Date().toISOString() });
      this.updateJob(job);
    }
    return rows.length;
  }

  /** Remove finished jobs (and their document links) created before the retention window. */
  pruneJobs(retentionMs: number, now: number = Date.now()): number {
    const cutoff = now - retentionMs;
    const old = this.db.prepare("SELECT id FROM crawl_jobs WHERE status != 'scraping' AND created_at < ?").all(cutoff) as Row[];
    const dropLinks = this.db.prepare("DELETE FROM crawl_documents WHERE job_id = ?");
    const dropJob = this.db.prepare("DELETE FROM crawl_jobs WHERE id = ?");
    for (const row of old) {
      dropLinks.run(str(row.id)!);
      dropJob.run(str(row.id)!);
    }
    return old.length;
  }

  // ---------------------------------------------------------------- watches

  private rowToWatch(row: Row): WatchState {
    return {
      key: str(row.key)!,
      url: str(row.url)!,
      lastDocumentId: num(row.last_document_id) ?? null,
      lastCheckedAt: num(row.last_checked_at) ?? null,
      lastChangedAt: num(row.last_changed_at) ?? null,
      checkCount: num(row.check_count) ?? 0,
    };
  }

  getWatch(url: string): WatchState | undefined {
    const row = this.db.prepare("SELECT * FROM watches WHERE key = ?").get(documentKey(url)) as Row | undefined;
    return row ? this.rowToWatch(row) : undefined;
  }

  upsertWatch(state: WatchState): void {
    this.db
      .prepare(
        `INSERT INTO watches (key, url, last_document_id, last_checked_at, last_changed_at, check_count) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET url = excluded.url, last_document_id = excluded.last_document_id,
           last_checked_at = excluded.last_checked_at, last_changed_at = excluded.last_changed_at, check_count = excluded.check_count`,
      )
      .run(state.key, state.url, state.lastDocumentId, state.lastCheckedAt, state.lastChangedAt, state.checkCount);
  }

  listWatches(): WatchState[] {
    return (this.db.prepare("SELECT * FROM watches ORDER BY last_checked_at DESC").all() as Row[]).map((r) => this.rowToWatch(r));
  }

  deleteWatch(url: string): boolean {
    return Number(this.db.prepare("DELETE FROM watches WHERE key = ?").run(documentKey(url)).changes) > 0;
  }
}

let current: Store | null = null;

/** Process-wide store, opened lazily at OPENCRAWL_DB (default ~/.opencrawl/opencrawl.db). */
export function getStore(): Store {
  current ??= new Store();
  return current;
}

/** Swap the process-wide store (tests, or embedding with a custom path). Pass null to reopen lazily. */
export function useStore(store: Store | null): void {
  current = store;
}
