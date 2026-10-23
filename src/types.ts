/**
 * Public types for documents, map, crawl and search results. Fields
 * opencrawl cannot produce stay optional and are simply absent.
 */

export type FormatString =
  | "markdown"
  | "html"
  | "rawHtml"
  | "links"
  | "images"
  | "screenshot"
  | "summary"
  | "json"
  | "changeTracking"
  | "branding"
  | "attributes"
  | "query"
  | "audio"
  | "video";

export interface ScreenshotFormat {
  type: "screenshot";
  fullPage?: boolean;
  quality?: number;
  viewport?: { width: number; height: number };
}

export interface AttributesFormat {
  type: "attributes";
  selectors: Array<{ selector: string; attribute: string }>;
}

export interface GenericFormat {
  type: FormatString;
  [key: string]: unknown;
}

export type FormatOption = FormatString | ScreenshotFormat | AttributesFormat | GenericFormat;

export interface LocationConfig {
  country?: string;
  languages?: string[];
}

export interface ScrapeOptions {
  formats?: FormatOption[];
  headers?: Record<string, string>;
  includeTags?: string[];
  excludeTags?: string[];
  /** Default is true. */
  onlyMainContent?: boolean;
  /** Milliseconds. */
  timeout?: number;
  /** Milliseconds to wait after load before capturing (forces a browser render). */
  waitFor?: number;
  mobile?: boolean;
  parsers?: Array<string | { type: "pdf"; mode?: string; maxPages?: number }>;
  pdfOptions?: { maxPages?: number };
  location?: LocationConfig;
  skipTlsVerification?: boolean;
  /** Default is true. */
  removeBase64Images?: boolean;
  actions?: unknown[];
  maxAge?: number;
  storeInCache?: boolean;
  proxy?: string;
  lockdown?: boolean;
  redactPII?: boolean;
  zeroDataRetention?: boolean;
  profile?: unknown;
  blockAds?: boolean;
  fastMode?: boolean;
  integration?: string;
  origin?: string;
  /**
   * opencrawl extension. "auto" fetches with plain HTTP first and only opens
   * a browser when the page looks like a JavaScript shell. "always" and
   * "never" force the choice.
   */
  render?: "auto" | "always" | "never";
}

export interface DocumentMetadata {
  title?: string;
  description?: string;
  url?: string;
  language?: string;
  keywords?: string | string[];
  robots?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogUrl?: string;
  ogImage?: string;
  ogSiteName?: string;
  ogLocale?: string;
  favicon?: string;
  modifiedTime?: string;
  publishedTime?: string;
  articleTag?: string;
  articleSection?: string;
  sourceURL?: string;
  statusCode?: number;
  scrapeId?: string;
  numPages?: number;
  contentType?: string;
  proxyUsed?: "basic" | "stealth";
  cacheState?: "hit" | "miss";
  /** ISO time the cached snapshot was fetched (present on cache hits). */
  cachedAt?: string;
  creditsUsed?: number;
  error?: string;
  /** opencrawl extension: true when a headless browser rendered the page. */
  rendered?: boolean;
  [key: string]: unknown;
}

export interface Document {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  json?: unknown;
  summary?: string;
  metadata?: DocumentMetadata;
  links?: string[];
  images?: string[];
  screenshot?: string;
  attributes?: Array<{ selector: string; attribute: string; values: string[] }>;
  warning?: string;
}

export interface MapOptions {
  search?: string;
  sitemap?: "only" | "include" | "skip";
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  limit?: number;
  /** Milliseconds. */
  timeout?: number;
  location?: LocationConfig;
  integration?: string;
  origin?: string;
}

export interface MapLink {
  url: string;
  title?: string;
  description?: string;
}

export interface MapResult {
  links: MapLink[];
}

export interface CrawlOptions {
  prompt?: string | null;
  excludePaths?: string[] | null;
  includePaths?: string[] | null;
  maxDiscoveryDepth?: number | null;
  sitemap?: "skip" | "include" | "only";
  ignoreQueryParameters?: boolean;
  deduplicateSimilarURLs?: boolean;
  limit?: number | null;
  crawlEntireDomain?: boolean;
  allowExternalLinks?: boolean;
  allowSubdomains?: boolean;
  ignoreRobotsTxt?: boolean;
  robotsUserAgent?: string | null;
  /** Seconds between page fetches per worker. */
  delay?: number | null;
  maxConcurrency?: number | null;
  webhook?: unknown;
  scrapeOptions?: ScrapeOptions | null;
  regexOnFullURL?: boolean;
  zeroDataRetention?: boolean;
  integration?: string;
  origin?: string;
}

export type CrawlStatus = "scraping" | "completed" | "failed" | "cancelled";

export interface CrawlStartResponse {
  id: string;
  url: string;
}

export interface CrawlJob {
  id: string;
  status: CrawlStatus;
  total: number;
  completed: number;
  creditsUsed?: number;
  expiresAt?: string;
  next?: string | null;
  data: Document[];
}

export interface CrawlErrors {
  errors: Array<{ id?: string; url: string; error: string; timestamp?: string }>;
  robotsBlocked: string[];
}

export type SearchSource = "web" | "news" | "images";

export interface SearchResultWeb {
  url: string;
  title?: string;
  description?: string;
  category?: string;
}

export interface SearchResultNews {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
  imageUrl?: string;
  position?: number;
}

export interface SearchResultImages {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  url?: string;
  position?: number;
}

export interface SearchData {
  web?: Array<SearchResultWeb & Partial<Document>>;
  news?: Array<SearchResultNews & Partial<Document>>;
  images?: Array<SearchResultImages & Partial<Document>>;
}

export interface SearchRequest {
  query: string;
  sources?: Array<SearchSource | { type: SearchSource }>;
  categories?: Array<string | { type: string }>;
  includeDomains?: string[];
  excludeDomains?: string[];
  limit?: number;
  /** Google-style time filter: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y. */
  tbs?: string;
  location?: string;
  country?: string;
  ignoreInvalidURLs?: boolean;
  /** Milliseconds. */
  timeout?: number;
  scrapeOptions?: ScrapeOptions;
  highlights?: boolean;
  integration?: string;
  origin?: string;
}

export interface SearchResponse {
  data: SearchData;
  warning?: string;
  /** Which backend produced the results (opencrawl extension). */
  backend?: string;
}

export interface ParseOptions {
  formats?: FormatOption[];
  includeTags?: string[];
  excludeTags?: string[];
  onlyMainContent?: boolean;
  parsers?: ScrapeOptions["parsers"];
  pdfOptions?: { maxPages?: number };
  removeBase64Images?: boolean;
}
