import type { Browser, BrowserContext } from "playwright";
import { DESKTOP_USER_AGENT, MAX_BROWSER_CONTEXTS, MOBILE_USER_AGENT } from "./config.js";

export type BrowserMode = "auto" | "chromium" | "chrome" | "msedge" | "none";

let browserPromise: Promise<Browser> | null = null;
let activeChannel: string | null = null;

async function launch(): Promise<Browser> {
  const mode = (process.env.OPENCRAWL_BROWSER ?? "auto") as BrowserMode;
  if (mode === "none") throw new Error("browser rendering is disabled (OPENCRAWL_BROWSER=none)");
  const { chromium } = await import("playwright");
  const attempts: Array<string | undefined> =
    mode === "auto" ? [undefined, "chrome", "msedge"] : [mode === "chromium" ? undefined : mode];
  const failures: string[] = [];
  for (const channel of attempts) {
    try {
      const browser = await chromium.launch({ headless: true, channel });
      activeChannel = channel ?? "chromium";
      browser.on("disconnected", () => {
        browserPromise = null;
        activeChannel = null;
      });
      return browser;
    } catch (err) {
      failures.push(`${channel ?? "chromium"}: ${String((err as Error).message).split("\n")[0]}`);
    }
  }
  throw new Error(
    `no usable browser (${failures.join("; ")}). Run "npx playwright install chromium" or install Google Chrome.`,
  );
}

export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launch().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export function activeBrowserChannel(): string | null {
  return activeChannel;
}

export async function isBrowserAvailable(): Promise<boolean> {
  try {
    await getBrowser();
    return true;
  } catch {
    return false;
  }
}

/** Simple counting semaphore so a crawl cannot open unbounded Chromium contexts. */
let openContexts = 0;
const waiters: Array<() => void> = [];
async function acquireContextSlot(): Promise<void> {
  if (openContexts < MAX_BROWSER_CONTEXTS) {
    openContexts++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  openContexts++;
}
function releaseContextSlot(): void {
  openContexts--;
  waiters.shift()?.();
}

export interface RenderOptions {
  timeoutMs?: number;
  waitForMs?: number;
  mobile?: boolean;
  /** Sent only to the target page's origin, never to third-party subresources. */
  headers?: Record<string, string>;
  skipTlsVerification?: boolean;
  screenshot?: {
    fullPage?: boolean;
    quality?: number;
    viewport?: { width: number; height: number };
  } | null;
}

export interface RenderResult {
  html: string;
  status: number;
  url: string;
  contentType: string;
  /** data: URL (PNG, or JPEG when a quality was requested). */
  screenshot?: string;
}

export type RenderFn = (url: string, options?: RenderOptions) => Promise<RenderResult>;

const MAX_WAIT_FOR_MS = 60_000;

async function scopeHeaders(context: BrowserContext, targetUrl: string, headers: Record<string, string>): Promise<void> {
  const targetOrigin = new URL(targetUrl).origin;
  await context.route("**/*", (route, request) => {
    let origin = "";
    try {
      origin = new URL(request.url()).origin;
    } catch {
      /* non-http request */
    }
    if (origin === targetOrigin) return route.continue({ headers: { ...request.headers(), ...headers } });
    return route.continue();
  });
}

/** Load a page in headless Chromium and return the rendered DOM (and optionally a screenshot). */
export const renderPage: RenderFn = async (url, options = {}) => {
  const browser = await getBrowser();
  const timeout = options.timeoutMs ?? 30_000;
  await acquireContextSlot();
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      userAgent: options.mobile ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT,
      viewport: options.screenshot?.viewport ?? (options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }),
      isMobile: !!options.mobile,
      hasTouch: !!options.mobile,
      ignoreHTTPSErrors: !!options.skipTlsVerification,
      locale: "en-US",
    });
    if (options.headers && Object.keys(options.headers).length > 0) await scopeHeaders(context, url, options.headers);
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 10_000) }).catch(() => undefined);
    if (options.waitForMs && options.waitForMs > 0) await page.waitForTimeout(Math.min(options.waitForMs, MAX_WAIT_FOR_MS));
    const html = await page.content();
    let screenshot: string | undefined;
    if (options.screenshot) {
      const jpeg = typeof options.screenshot.quality === "number";
      const buffer = await page.screenshot(
        jpeg
          ? { fullPage: !!options.screenshot.fullPage, type: "jpeg", quality: options.screenshot.quality }
          : { fullPage: !!options.screenshot.fullPage, type: "png" },
      );
      screenshot = `data:image/${jpeg ? "jpeg" : "png"};base64,${buffer.toString("base64")}`;
    }
    return {
      html,
      status: response?.status() ?? 200,
      url: page.url(),
      contentType: response?.headers()["content-type"] ?? "text/html",
      screenshot,
    };
  } finally {
    // Never let a close() failure replace the error that got us here.
    await context?.close().catch(() => undefined);
    releaseContextSlot();
  }
};

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  activeChannel = null;
  await browser?.close().catch(() => undefined);
}
