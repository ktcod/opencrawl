import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractPdf, isPdfBuffer } from "./pdf.js";
import { documentFromDocx, documentFromHtml, documentFromXlsx, normalizeFormats } from "./scrape.js";
import type { Document as ScrapedDocument, ParseOptions } from "./types.js";

const HTML_EXT = new Set([".html", ".htm", ".xhtml"]);
const DOCX_EXT = new Set([".docx"]);
const XLSX_EXT = new Set([".xlsx", ".xlsm"]);
const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".rst", ".log", ".yaml", ".yml", ".toml"]);

/** File extensions parseFile accepts. Uploads with any other extension are rejected before being written. */
export const PARSE_EXTENSIONS: ReadonlySet<string> = new Set([".pdf", ...HTML_EXT, ...TEXT_EXT, ...DOCX_EXT, ...XLSX_EXT]);

function pdfMaxPages(options: ParseOptions): number | undefined {
  if (options.pdfOptions?.maxPages) return options.pdfOptions.maxPages;
  for (const parser of options.parsers ?? []) {
    if (typeof parser === "object" && parser.type === "pdf" && parser.maxPages) return parser.maxPages;
  }
  return undefined;
}

/**
 * Parse a local file into a Document. Backs /v2/parse for the formats
 * opencrawl can handle offline: PDF, HTML and plain text.
 */
export async function parseFile(filePath: string, options: ParseOptions = {}): Promise<ScrapedDocument> {
  const absolute = path.resolve(filePath);
  const data = await readFile(absolute);
  const ext = path.extname(absolute).toLowerCase();
  const nf = normalizeFormats(options.formats);
  const warnings = nf.unsupported.map((f) => `format "${f}" needs an LLM and is not available in opencrawl`);
  const fileUrl = pathToFileURL(absolute).href;

  if (ext === ".pdf" || isPdfBuffer(data)) {
    const { text, numPages, title } = await extractPdf(data, pdfMaxPages(options));
    const doc: ScrapedDocument = {
      metadata: { sourceURL: fileUrl, url: fileUrl, contentType: "application/pdf", numPages, statusCode: 200, title },
    };
    if (nf.types.has("markdown")) doc.markdown = text;
    if (nf.types.has("html")) doc.html = `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
    if (nf.types.has("links")) doc.links = [...new Set(text.match(/https?:\/\/[^\s)>\]"']+/g) ?? [])];
    if (warnings.length) doc.warning = warnings.join(" | ");
    return doc;
  }

  if (DOCX_EXT.has(ext)) return documentFromDocx(data, fileUrl, fileUrl, 200, options, nf, warnings);
  if (XLSX_EXT.has(ext)) return documentFromXlsx(data, fileUrl, fileUrl, 200, nf, warnings);

  if (HTML_EXT.has(ext)) {
    return documentFromHtml(
      { html: data.toString("utf8"), status: 200, url: fileUrl, contentType: "text/html", rendered: false },
      fileUrl,
      { ...options, onlyMainContent: options.onlyMainContent ?? false },
      nf,
      warnings,
    );
  }

  if (TEXT_EXT.has(ext)) {
    const text = data.toString("utf8");
    const doc: ScrapedDocument = { metadata: { sourceURL: fileUrl, url: fileUrl, contentType: "text/plain", statusCode: 200 } };
    if (nf.types.has("markdown")) doc.markdown = text;
    if (nf.types.has("html")) doc.html = `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
    if (warnings.length) doc.warning = warnings.join(" | ");
    return doc;
  }

  throw new Error(`Unsupported file type "${ext || "(none)"}". opencrawl parses PDF, DOCX, XLSX, HTML and plain-text files.`);
}
