export class InvalidUrlError extends Error {}

/** Normalize user input into an absolute http(s) URL without a fragment. */
export function normalizeUrl(input: string): string {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) throw new InvalidUrlError("URL cannot be empty");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidUrlError(`Invalid URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidUrlError(`Unsupported URL scheme: ${url.protocol}`);
  }
  url.hash = "";
  return url.href;
}

export function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Key used to decide whether two URLs are "the same page" for dedupe
 * purposes. Returns null for non-http URLs.
 */
export function dedupeKey(input: string, ignoreQueryParameters = false): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  if (ignoreQueryParameters) url.search = "";
  url.hostname = stripWww(url.hostname);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

export function sameSite(hostA: string, hostB: string, includeSubdomains = false): boolean {
  const a = stripWww(hostA);
  const b = stripWww(hostB);
  if (a === b) return true;
  if (!includeSubdomains) return false;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function toRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTS.has(host.toLowerCase()) || host.toLowerCase().endsWith(".localhost");
}
