import { PDFParse } from "pdf-parse";

export interface PdfExtract {
  text: string;
  numPages: number;
  title?: string;
}

export async function extractPdf(data: Buffer, maxPages?: number): Promise<PdfExtract> {
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const info = await parser.getInfo();
    const total = info.total;
    const range = maxPages && maxPages > 0 && maxPages < total ? { first: 1, last: maxPages } : {};
    const result = await parser.getText({ ...range, pageJoiner: "\n\n" });
    const rawTitle = (info.info as Record<string, unknown> | undefined)?.Title;
    return {
      text: result.text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
      numPages: total,
      title: typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : undefined,
    };
  } finally {
    await parser.destroy();
  }
}

export function isPdfBuffer(data: Buffer): boolean {
  return data.subarray(0, 5).toString("latin1") === "%PDF-";
}
