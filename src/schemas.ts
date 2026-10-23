import { z } from "zod";
import type { FormatOption, ScrapeOptions } from "./types.js";

/**
 * Request validation shared by the HTTP API and the MCP server. Unknown keys
 * are stripped (not rejected) so third-party clients that send extra fields
 * such as `integration` keep working.
 */

export const formatEnum = z.enum([
  "markdown",
  "html",
  "rawHtml",
  "screenshot",
  "links",
  "images",
  "attributes",
  "summary",
  "changeTracking",
  "branding",
  "json",
  "query",
  "audio",
  "video",
]);
export const formatSchema = z.union([z.string().min(1), z.looseObject({ type: z.string().min(1) })]);

export const MAX_WAIT_FOR_MS = 60_000;
export const MAX_TIMEOUT_MS = 120_000;

export const scrapeOptionShape = {
  formats: z.array(formatSchema).max(20).optional(),
  onlyMainContent: z.boolean().optional(),
  includeTags: z.array(z.string().max(500)).max(50).optional(),
  excludeTags: z.array(z.string().max(500)).max(50).optional(),
  waitFor: z.number().min(0).max(MAX_WAIT_FOR_MS).optional(),
  timeout: z.number().min(1).max(MAX_TIMEOUT_MS).optional(),
  mobile: z.boolean().optional(),
  headers: z.record(z.string().max(200), z.string().max(8192)).optional(),
  screenshotOptions: z
    .object({
      fullPage: z.boolean().optional(),
      quality: z.number().min(1).max(100).optional(),
      viewport: z.object({ width: z.number().int().min(1).max(10_000), height: z.number().int().min(1).max(10_000) }).optional(),
    })
    .optional(),
  removeBase64Images: z.boolean().optional(),
  skipTlsVerification: z.boolean().optional(),
  parsers: z.array(z.union([z.string(), z.looseObject({ type: z.string() })])).optional(),
  pdfOptions: z.object({ maxPages: z.number().int().min(1).max(10_000).optional() }).optional(),
  maxAge: z.number().optional(),
  storeInCache: z.boolean().optional(),
  proxy: z.string().optional(),
  lockdown: z.boolean().optional(),
  redactPII: z.boolean().optional(),
  zeroDataRetention: z.boolean().optional(),
  location: z.object({ country: z.string().optional(), languages: z.array(z.string()).optional() }).optional(),
  actions: z.array(z.unknown()).max(50).optional(),
  render: z.enum(["auto", "always", "never"]).optional(),
};
export const scrapeOptionsSchema = z.object(scrapeOptionShape);
export type ScrapeArgs = z.infer<typeof scrapeOptionsSchema>;

export const scrapeRequestSchema = z.object({ url: z.string().min(1).max(8192), ...scrapeOptionShape });

/** Merge MCP-style `screenshotOptions` into the formats list and drop it. */
export function resolveScrapeOptions(args: ScrapeArgs): ScrapeOptions {
  const { screenshotOptions, formats, ...rest } = args;
  const resolved: FormatOption[] | undefined = formats?.map((f) => {
    if (f === "screenshot" && screenshotOptions) return { type: "screenshot" as const, ...screenshotOptions };
    return f as FormatOption;
  });
  return { ...(rest as ScrapeOptions), formats: resolved };
}

export const mapRequestSchema = z.object({
  url: z.string().min(1).max(8192),
  search: z.string().max(500).optional(),
  sitemap: z.enum(["include", "skip", "only"]).optional(),
  includeSubdomains: z.boolean().optional(),
  ignoreQueryParameters: z.boolean().optional(),
  limit: z.number().int().min(1).max(100_000).optional(),
  timeout: z.number().min(1).max(MAX_TIMEOUT_MS).optional(),
  location: z.object({ country: z.string().optional(), languages: z.array(z.string()).optional() }).optional(),
});

export const crawlOptionShape = {
  limit: z.number().int().min(1).max(100_000).nullable().optional(),
  maxDiscoveryDepth: z.number().int().min(0).max(1000).nullable().optional(),
  includePaths: z.array(z.string().max(500)).max(100).nullable().optional(),
  excludePaths: z.array(z.string().max(500)).max(100).nullable().optional(),
  sitemap: z.enum(["skip", "include", "only"]).optional(),
  ignoreQueryParameters: z.boolean().optional(),
  deduplicateSimilarURLs: z.boolean().optional(),
  crawlEntireDomain: z.boolean().optional(),
  allowExternalLinks: z.boolean().optional(),
  allowSubdomains: z.boolean().optional(),
  ignoreRobotsTxt: z.boolean().optional(),
  robotsUserAgent: z.string().max(200).nullable().optional(),
  delay: z.number().min(0).max(300).nullable().optional(),
  maxConcurrency: z.number().int().min(1).max(100).nullable().optional(),
  regexOnFullURL: z.boolean().optional(),
  prompt: z.string().max(10_000).nullable().optional(),
  webhook: z.unknown().optional(),
  zeroDataRetention: z.boolean().optional(),
  scrapeOptions: scrapeOptionsSchema.nullable().optional(),
};
export const crawlRequestSchema = z.object({ url: z.string().min(1).max(8192), ...crawlOptionShape });

const sourceEnum = z.enum(["web", "news", "images"]);
export const searchRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(100).optional(),
  sources: z.array(z.union([sourceEnum, z.object({ type: sourceEnum })])).max(3).optional(),
  categories: z.array(z.union([z.string().max(50), z.object({ type: z.string().max(50) })])).max(5).optional(),
  includeDomains: z.array(z.string().max(253)).max(50).optional(),
  excludeDomains: z.array(z.string().max(253)).max(50).optional(),
  tbs: z.string().max(20).optional(),
  location: z.string().max(100).optional(),
  country: z.string().max(10).optional(),
  ignoreInvalidURLs: z.boolean().optional(),
  timeout: z.number().min(1).max(MAX_TIMEOUT_MS).optional(),
  scrapeOptions: scrapeOptionsSchema.optional(),
  highlights: z.boolean().optional(),
});

export const parseOptionsSchema = z.object({
  formats: z.array(formatSchema).max(20).optional(),
  includeTags: z.array(z.string().max(500)).max(50).optional(),
  excludeTags: z.array(z.string().max(500)).max(50).optional(),
  onlyMainContent: z.boolean().optional(),
  parsers: z.array(z.union([z.string(), z.looseObject({ type: z.string() })])).optional(),
  pdfOptions: z.object({ maxPages: z.number().int().min(1).max(10_000).optional() }).optional(),
  removeBase64Images: z.boolean().optional(),
});
export const parseRequestSchema = z.object({ filePath: z.string().min(1).max(4096), ...parseOptionsSchema.shape });

export interface SelectorSpecInput {
  selector: string;
  attribute?: string;
  type?: "text" | "html" | "attribute";
  multiple?: boolean;
  fields?: Record<string, SelectorSpecInput | string>;
}

export const selectorSpecSchema: z.ZodType<SelectorSpecInput> = z.lazy(() =>
  z.object({
    selector: z.string().min(1).max(500),
    attribute: z.string().min(1).max(100).optional(),
    type: z.enum(["text", "html", "attribute"]).optional(),
    multiple: z.boolean().optional(),
    fields: z.record(z.string().min(1).max(100), z.union([z.string().min(1).max(500), selectorSpecSchema])).optional(),
  }),
);

export const extractOptionShape = {
  structured: z.union([z.boolean(), z.array(z.enum(["jsonLd", "microdata", "openGraph", "twitter", "meta"]))]).optional(),
  selectors: z.record(z.string().min(1).max(100), z.union([z.string().min(1).max(500), selectorSpecSchema])).optional(),
  tables: z
    .union([
      z.boolean(),
      z.object({
        selector: z.string().min(1).max(500).optional(),
        csv: z.boolean().optional(),
        maxRows: z.number().int().min(1).max(100_000).optional(),
        minRows: z.number().int().min(1).max(100_000).optional(),
      }),
    ])
    .optional(),
};

export const extractRequestSchema = z.object({
  url: z.string().min(1).max(8192),
  ...extractOptionShape,
  scrapeOptions: scrapeOptionsSchema.optional(),
});

export const watchRequestSchema = z.object({
  url: z.string().min(1).max(8192),
  diff: z.boolean().optional(),
  scrapeOptions: scrapeOptionsSchema.optional(),
});

export const localSearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(100).optional(),
  site: z.string().max(253).optional(),
  since: z.union([z.string().max(40), z.number()]).optional(),
});

export class ValidationError extends Error {}

export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ValidationError(z.prettifyError(result.error));
  return result.data;
}
