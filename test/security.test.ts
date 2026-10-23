import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { startFixtureSite, type FixtureSite } from "./helpers/site.js";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(() => site.close());

const jsonPost = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const tempDirs = async () => (await readdir(tmpdir())).filter((n) => n.startsWith("opencrawl-upload-")).length;

describe("HTTP hardening", () => {
  const app = createApp();

  it("multipart upload ignores the client filename, cleans up, and rejects bad extensions", async () => {
    const before = await tempDirs();
    const marker = `pwned-${Date.now()}.txt`;
    const form = new FormData();
    form.append("file", new Blob(["# Uploaded\n\nhello"], { type: "text/markdown" }), `../${marker}`);
    form.append("options", JSON.stringify({ formats: ["markdown"] }));
    const res = await app.request("/v2/parse", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.markdown).toContain("# Uploaded");
    expect(json.data.metadata.sourceURL).toBe(marker);
    await expect(stat(path.join(tmpdir(), marker))).rejects.toThrow();
    expect(await tempDirs()).toBe(before);

    const bad = new FormData();
    bad.append("file", new Blob(["x"]), "evil.sh");
    const rejected = await app.request("/v2/parse", { method: "POST", body: bad });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toMatch(/Unsupported file type/);
    expect(await tempDirs()).toBe(before);
  });

  it("requires application/json on JSON routes (no CORS-safelisted form posts)", async () => {
    const res = await app.request("/v2/scrape", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ url: site.base }) });
    expect(res.status).toBe(415);
    expect((await res.json()).success).toBe(false);
  });

  it("refuses browser origins and unexpected Host headers", async () => {
    const origin = await jsonPost(app, "/v2/map", { url: site.base }, { origin: "https://evil.example" });
    expect(origin.status).toBe(403);
    const host = await jsonPost(app, "/v2/map", { url: site.base }, { host: "rebind.evil.example" });
    expect(host.status).toBe(403);
    const ok = await jsonPost(app, "/v2/map", { url: site.base, sitemap: "only" }, { host: "localhost:3002" });
    expect(ok.status).toBe(200);
    const allowed = createApp({ allowedOrigins: ["https://ui.example"], allowedHosts: ["scraper.lan"] });
    const okOrigin = await jsonPost(allowed, "/v2/map", { url: site.base, sitemap: "only" }, { origin: "https://ui.example", host: "scraper.lan:3002" });
    expect(okOrigin.status).toBe(200);
  });

  it("validates bodies and returns 400 instead of silently misbehaving", async () => {
    expect((await jsonPost(app, "/v2/crawl", { url: site.base, limit: "abc" })).status).toBe(400);
    expect((await jsonPost(app, "/v2/crawl", { url: site.base, maxConcurrency: "abc" })).status).toBe(400);
    expect((await jsonPost(app, "/v2/scrape", { url: 42 })).status).toBe(400);
    const invalid = await jsonPost(app, "/v2/scrape", { url: "ftp://nope.test/x" });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatch(/Unsupported URL scheme/);
    const arr = await app.request("/v2/scrape", { method: "POST", headers: { "content-type": "application/json" }, body: "[1,2]" });
    expect(arr.status).toBe(400);
  });

  it("accepts case-insensitive format names and ignores unknown fields from third-party clients", async () => {
    const res = await jsonPost(app, "/v2/scrape", { url: `${site.base}/docs/a`, formats: ["Markdown", "LINKS"], integration: "cli", render: "never" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.markdown).toContain("# Doc A");
    expect(json.data.links).toContain(`${site.base}/docs/b`);
  });

  it("rejects oversized JSON bodies", async () => {
    const res = await jsonPost(app, "/v2/scrape", { url: site.base, headers: { x: "y".repeat(3 * 1024 * 1024) } });
    expect(res.status).toBe(413);
  });
});
