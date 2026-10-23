# Design notes

What opencrawl chooses and why, and what it knowingly leaves out. Written 2026-10-22.

## Goals

- Run as one Node process on a laptop: no queue, no database, no external services.
- Need no account or key for the core work. Search has a keyless default and two optional
  backends.
- Be safe to leave running: default to loopback, refuse browser-origin requests, bound every
  input size and every fan-out.
- Keep the request and response shapes stable and conventional (`{ success, data }`) so
  existing scraping clients and prompts need little or no adaptation.

## Choices

| Area | Choice | Why |
| --- | --- | --- |
| Rendering | Plain HTTP first; Chromium only on screenshot, `waitFor`, `render: "always"`, or when the fetched HTML looks like an empty JavaScript shell (external scripts plus an empty app root, a `<noscript>` asking for JavaScript, or under 100 characters of visible text) | Most pages do not need a browser; launching one per page is the main cost of a local scraper |
| Browser | Playwright; bundled Chromium, then the `chrome` channel, then `msedge`; at most `OPENCRAWL_MAX_BROWSER_CONTEXTS` pages open at once; caller headers reach only the target origin | Bundled builds are often missing; an installed Chrome usually exists; headers must not leak to third-party subresources |
| Main content | Strip a selector list of page chrome, then prefer a `<main>`/`[role=main]`, a sole `<article>`, or a sole conventional content container. Multi-article index pages keep everything. An explicit `includeTags` list is never pruned | Predictable; readability-style scoring drops tables and docs navigation |
| Markdown | Turndown with the GFM plugin | Tables, strikethrough, task lists and fenced code come out as GitHub-flavoured markdown |
| Defaults | `onlyMainContent: true`, `removeBase64Images: true`, crawl `limit` 100, map `limit` 5000 | A crawl that accidentally walks ten thousand pages is a worse failure than one that stops at a hundred |
| Crawl scope | Same host; under the start path unless `crawlEntireDomain`; `includePaths`/`excludePaths` are regular expressions on the path (or on the full URL with `regexOnFullURL`); robots.txt fetched once per origin and checked at scrape time, so a redirect to another host cannot bypass it; the scope re-bases itself when the start URL redirects elsewhere | Matches what people expect from "crawl this section" |
| Crawl results | Pages answering 4xx/5xx go to `/v2/crawl/:id/errors`, not to `data`, and their links are not followed. A `delay` serializes requests. Jobs live in memory for 24 hours | Rate-limit and challenge pages must not be mistaken for content |
| Search | Pluggable backend: DuckDuckGo HTML (keyless default), SearXNG, Brave. `includeDomains` becomes `site:` operators and the backend is over-fetched before domain filtering | Keyless by default, self-hostable when it matters |
| LLM formats | `json`, `summary`, `query`, `changeTracking`, `branding` return a `warning` and still deliver markdown | Honest degradation beats a hard error inside a crawl |
| HTTP security | Loopback bind by default; refuse a non-loopback bind without a key; constant-time bearer check; `Host` allowlist (DNS rebinding); any unlisted `Origin` refused; JSON content type required; body limits; uploads written under a server-chosen name with a vetted extension and deleted after parsing; raw `filePath` only from loopback | A scraper reachable from a browser tab is a request forgery target |
| Input bounds | 50 MB response cap, gzip output cap, 50 sitemap fetches per job, validated request bodies with clamped numbers | Hostile sites and bad clients should cost bounded memory and time |

## Not supported

Browser actions and interactive sessions, agent-style extraction, change monitors,
webhooks, batch endpoints, OCR, and any format that needs a language model.

## Known gaps

- `total` on a crawl job is the number of pages attempted (successes plus HTTP errors).
- No pagination on crawl status (`next` is always `null`); a huge crawl is returned whole.
- PDF extraction is text-layer only; scanned PDFs yield nothing.
- DuckDuckGo's HTML endpoint rate-limits sustained use; use SearXNG or Brave for that.
- A `delay` forces one worker; `Crawl-delay` in robots.txt is ignored.
- In-flight scrapes are not aborted on cancel; the job stops after they finish.
