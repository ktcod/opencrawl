import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extract, extractFromHtml, toCsv } from "../src/extract.js";
import { scrape } from "../src/scrape.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

describe("extract", () => {
  it("collects JSON-LD, microdata, Open Graph, Twitter and meta", async () => {
    const result = await extract(`${site.base}/structured`, { tables: false, scrapeOptions: { render: "never" } });
    expect(result.jsonLd).toHaveLength(2);
    expect(result.jsonLd?.[0]).toMatchObject({ "@type": "Product", name: "Widget", offers: { price: "9.99" } });
    expect(result.jsonLd?.[1]).toMatchObject({ "@type": "BreadcrumbList" });
    expect(result.errors?.["jsonLd[2]"]).toMatch(/invalid JSON/);
    expect(result.microdata).toEqual([
      {
        "@type": "https://schema.org/Person",
        "@id": `${site.base}/structured#ada`,
        name: "Ada Lovelace",
        url: `${site.base}/ada`,
        address: { "@type": "https://schema.org/PostalAddress", addressLocality: "London" },
        image: `${site.base}/ada.png`,
        birthDate: "1815-12-10",
        knowsAbout: ["math", "engines"],
        deathDate: "1852-11-27",
      },
    ]);
    expect(result.openGraph).toEqual({ "og:title": "OG Title", "og:image": [`${site.base}/og1.png`, `${site.base}/og2.png`], "article:tag": "fixtures" });
    expect(result.twitter).toEqual({ "twitter:card": "summary", "twitter:site": "@fixture" });
    expect(result.meta).toMatchObject({ title: "Structured Fixture", lang: "en", canonical: `${site.base}/structured`, description: "A page full of structured data", author: "Fixture Author" });
    expect(result.meta?.["twitter:card"]).toBeUndefined();
    expect(result.selected).toBeUndefined();
  });

  it("evaluates CSS selectors with attributes, lists and nested fields", async () => {
    const result = await extract(
      `${site.base}/structured`,
      {
        structured: false,
        tables: false,
        selectors: {
          first: ".product .name",
          names: { selector: ".product .name", multiple: true },
          products: { selector: ".product", multiple: true, fields: { name: ".name", price: ".price", link: { selector: ".buy", attribute: "href" }, html: { selector: ".name", type: "html" } } },
          missing: ".does-not-exist",
          bad: "div[",
          noattr: { selector: ".buy", type: "attribute" },
        },
      },
      { render: async () => { throw new Error("no browser"); } },
    );
    expect(result.selected).toMatchObject({
      first: "Alpha",
      names: ["Alpha", "Beta"],
      products: [
        { name: "Alpha", price: "$1", link: `${site.base}/buy/alpha`, html: "Alpha" },
        { name: "Beta", price: "$2", link: `${site.base}/buy/beta`, html: "Beta" },
      ],
      missing: null,
      bad: null,
      noattr: null,
    });
    expect(result.errors?.bad).toMatch(/invalid selector/);
    expect(result.errors?.noattr).toMatch(/needs an attribute/);
    expect(result.jsonLd).toBeUndefined();
  });

  it("turns tables into rows with header, colspan and rowspan handling, plus CSV", async () => {
    const result = await extract(`${site.base}/structured`, { structured: false, tables: { csv: true } , scrapeOptions: { render: "never" } });
    const tables = result.tables!;
    expect(tables.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(tables[0]).toMatchObject({
      caption: "Prices",
      headers: ["Item", "Price", "Price_2"],
      rows: [
        { Item: "Alpha", Price: "1", Price_2: "1.5" },
        { Item: "Beta", Price: "2", Price_2: "2.5" },
        { Item: "Beta", Price: "n/a", Price_2: "n/a" },
      ],
      rowCount: 3,
      columnCount: 3,
    });
    expect(tables[0]?.csv).toBe("Item,Price,Price_2\nAlpha,1,1.5\nBeta,2,2.5\nBeta,n/a,n/a");
    expect(tables[1]).toMatchObject({ headers: [], rows: [["a", "b c"], ["d", "e"]], columnCount: 2 });
    expect(tables[2]?.csv).toBe('Name,"Value, ""quoted"""\nx,"has, comma"');
    const only = await extract(`${site.base}/structured`, { structured: false, tables: { selector: "#t3", minRows: 1 }, scrapeOptions: { render: "never" } });
    expect(only.tables?.map((t) => t.index)).toEqual([2]);
  });

  it("works as a scrape format so crawls can extract too, and skips the cache", async () => {
    const doc = await scrape(`${site.base}/structured`, { formats: ["markdown", { type: "extract", structured: ["jsonLd"], tables: false }], render: "never" });
    expect(doc.markdown).toContain("Ada Lovelace");
    expect((doc.extract as { jsonLd: unknown[] }).jsonLd).toHaveLength(2);
    const { scrapeWithStore } = await import("../src/scrape.js");
    const { Store } = await import("../src/store.js");
    const store = new Store(":memory:");
    await scrapeWithStore(`${site.base}/structured`, { formats: ["extract"], maxAge: 60_000, render: "never" }, { store });
    const again = await scrapeWithStore(`${site.base}/structured`, { formats: ["extract"], maxAge: 60_000, render: "never" }, { store });
    expect(again.cached).toBe(false);
  });

  it("reports non-HTML pages instead of failing", async () => {
    const result = await extract(`${site.base}/plain.txt`, { scrapeOptions: { render: "never" } });
    expect(result.errors?.page).toMatch(/no HTML/);
    expect(result.tables).toBeUndefined();
  });

  it("extractFromHtml and toCsv are usable standalone", () => {
    const result = extractFromHtml(`<html><body><table><tr><th>A</th></tr><tr><td>1</td></tr></table></body></html>`, "https://x.test/", { structured: ["meta"] });
    expect(result.tables?.[0]?.rows).toEqual([{ A: "1" }]);
    expect(toCsv(["a", "b"], [["1", "x,y"]])).toBe('a,b\n1,"x,y"');
  });
});
