import { describe, expect, it } from "vitest";
import { extractLinks, htmlToMarkdown, looksLikeJsShell, parseHtml, replaceBase64Images } from "../src/html.js";

describe("htmlToMarkdown", () => {
  it("converts headings, links and tables", () => {
    const md = htmlToMarkdown(`<h1>Title</h1><p>Hi <a href="https://a.test/x">link</a></p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`);
    expect(md).toContain("# Title");
    expect(md).toContain("[link](https://a.test/x)");
    expect(md).toMatch(/\|\s*A\s*\|\s*B\s*\|/);
    expect(md).toMatch(/\|\s*1\s*\|\s*2\s*\|/);
  });
});

describe("looksLikeJsShell", () => {
  it("flags an empty root with external scripts", () => {
    expect(looksLikeJsShell(`<html><body><div id="root"></div><script src="/b.js"></script></body></html>`)).toBe(true);
  });
  it("does not flag a content page", () => {
    const html = `<html><head><script src="/a.js"></script></head><body><main>${"word ".repeat(100)}</main></body></html>`;
    expect(looksLikeJsShell(html)).toBe(false);
  });
  it("does not flag pages without external scripts", () => {
    expect(looksLikeJsShell(`<html><body><div id="root"></div></body></html>`)).toBe(false);
  });
});

describe("extractLinks", () => {
  it("absolutizes, strips fragments, drops mailto and dedupes", () => {
    const dom = parseHtml(
      `<a href="/x">x</a><a href="/x#frag">x2</a><a href="mailto:a@b.c">m</a><a href="https://other.test/y">y</a><a href="javascript:void(0)">j</a>`,
      "https://site.test/base/",
    );
    expect(extractLinks(dom.window.document, "https://site.test/base/")).toEqual(["https://site.test/x", "https://other.test/y"]);
  });
});

describe("replaceBase64Images", () => {
  it("replaces inline images with a placeholder", () => {
    expect(replaceBase64Images("![a](data:image/png;base64,AAAA) tail")).toBe("![a](<Base64-Image-Removed>) tail");
  });
});

describe("looksLikeJsShell (hostile input)", () => {
  it("stays linear on pathological markup", () => {
    const html = `<html><head><script src="/a.js"></script></head><body>${"<div ".repeat(100_000)}</body></html>`;
    const started = Date.now();
    looksLikeJsShell(html);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
