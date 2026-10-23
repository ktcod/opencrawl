import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { watch } from "../src/watch.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

describe("watch", () => {
  it("walks new -> same -> changed -> removed -> same", async () => {
    const store = new Store(":memory:");
    const url = `${site.base}/mutable`;
    const deps = { store, render: async () => { throw new Error("no browser"); } };

    const first = await watch(url, {}, deps);
    expect(first).toMatchObject({ status: "new", checkCount: 1, current: { statusCode: 200, title: "Mutable" } });
    expect(first.previous).toBeUndefined();

    const second = await watch(url, {}, deps);
    expect(second).toMatchObject({ status: "same", checkCount: 2 });
    expect(second.diff).toBeUndefined();

    site.mutable.body = "<main><h1>Mutable</h1><p>version two</p><p>stable line</p><p>brand new line</p></main>";
    const third = await watch(url, {}, deps);
    expect(third).toMatchObject({ status: "changed", checkCount: 3, linesAdded: 2, linesRemoved: 1 });
    expect(third.diff).toContain("-version one");
    expect(third.diff).toContain("+version two");
    expect(third.diff).toContain("+brand new line");
    expect(third.lastChangedAt).toBe(third.checkedAt);

    site.mutable.status = 404;
    const fourth = await watch(url, {}, deps);
    expect(fourth).toMatchObject({ status: "removed", checkCount: 4, current: { statusCode: 404 } });

    site.mutable.status = 200;
    const fifth = await watch(url, { diff: false }, deps);
    expect(fifth).toMatchObject({ status: "same", checkCount: 5 });
    expect(store.getWatch(url)).toMatchObject({ checkCount: 5 });
  });

  it("uses an earlier scrape as the baseline and reports network errors", async () => {
    const store = new Store(":memory:");
    const url = `${site.base}/docs/a`;
    const { scrapeWithStore } = await import("../src/scrape.js");
    await scrapeWithStore(url, { render: "never" }, { store });
    const result = await watch(url, {}, { store });
    expect(result.status).toBe("same");
    expect(result.previous).toBeDefined();

    const broken = await watch(url, {}, {
      store,
      fetch: async () => {
        throw new Error("network down");
      },
    });
    expect(broken).toMatchObject({ status: "error", error: "network down", checkCount: 2 });
    expect(store.getWatch(url)?.lastDocumentId).toBe(result.current ? store.getLatestDocument(url)?.id : null);
  });
});
