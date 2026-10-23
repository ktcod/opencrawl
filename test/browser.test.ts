import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeBrowserChannel, closeBrowser } from "../src/browser.js";
import { scrape } from "../src/scrape.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

// Opt in with OPENCRAWL_TEST_BROWSER=1: launches headless Chromium/Chrome.
const enabled = process.env.OPENCRAWL_TEST_BROWSER === "1";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await closeBrowser();
  await site.close();
});

describe.skipIf(!enabled)("browser rendering", () => {
  it("leaves a JS shell empty without a browser, and fills it with one", async () => {
    const plain = await scrape(`${site.base}/shell`, { render: "never" });
    expect(plain.markdown ?? "").not.toContain("Rendered");
    expect(plain.metadata?.rendered).toBe(false);

    const auto = await scrape(`${site.base}/shell`, { formats: ["markdown", "screenshot"] });
    expect(auto.markdown).toContain("# Rendered");
    expect(auto.metadata?.rendered).toBe(true);
    expect(auto.screenshot).toMatch(/^data:image\/png;base64,/);
    expect(activeBrowserChannel()).toBeTruthy();
  });

  it("does not render pages that already carry content", async () => {
    const doc = await scrape(`${site.base}/`);
    expect(doc.metadata?.rendered).toBe(false);
    expect(doc.markdown).toContain("# Welcome");
  });
});
