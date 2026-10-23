import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MutableState {
  status: number;
  body: string;
}

export interface FixtureSite {
  base: string;
  requests: string[];
  /** Controls the /mutable page: change body or status between requests. */
  mutable: MutableState;
  /** Mutable knobs: robots Crawl-delay (seconds) and how many 503s /flaky answers before 200. */
  knobs: { crawlDelay?: number; flakyFailures: number };
  close(): Promise<void>;
}

interface Route {
  status?: number;
  type?: string;
  body: string | ((url: URL) => string);
}

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

function routes(base: string): Record<string, Route> {
  return {
    "/": {
      body: page(
        "Fixture Home",
        `<nav class="navbar"><a href="/">Home</a> <a href="/docs/">Docs</a> NAV-MARKER</nav>
<main>
<h1>Welcome</h1>
<p>This is the fixture home page. It has enough prose that the JavaScript shell heuristic treats it as real content and not an empty application root.</p>
<ul>
<li><a href="/docs/">Docs</a></li>
<li><a href="/docs/a">Doc A</a></li>
<li><a href="/blog/post-1">Post 1</a></li>
<li><a href="https://example.org/external">External</a></li>
<li><a href="mailto:someone@example.org">Mail</a></li>
<li><a href="/docs/a#section">Doc A anchor</a></li>
<li><a href="/docs/a?ref=home">Doc A with query</a></li>
</ul>
<img src="/img/one.png" alt="one"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg" alt="inline">
<p class="secret">SECRET-MARKER</p>
<table><thead><tr><th>Col A</th><th>Col B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
</main>
<footer>FOOTER-MARKER</footer>`,
        `<meta name="description" content="A fixture site"><meta property="og:image" content="/og.png"><link rel="icon" href="/favicon.png"><script src="/app.js"></script>`,
      ),
    },
    "/docs/": {
      body: page(
        "Docs Index",
        `<main><h1>Docs</h1><ul><li><a href="/docs/a">A</a></li><li><a href="/docs/b">B</a></li><li><a href="/docs/deep/c">C</a></li><li><a href="/">Home</a></li><li><a href="/blog/post-1">Blog</a></li></ul></main>`,
      ),
    },
    "/docs/a": { body: page("Doc A", `<main><h1>Doc A</h1><p>Alpha content.</p><a href="/docs/b">B</a></main>`) },
    "/docs/b": { body: page("Doc B", `<main><h1>Doc B</h1><p>Beta content.</p><a href="/private/secret">secret</a></main>`) },
    "/docs/deep/c": { body: page("Doc C", `<main><h1>Doc C</h1><p>Gamma content.</p><a href="/docs/deep/d">D</a></main>`) },
    "/docs/deep/d": { body: page("Doc D", `<main><h1>Doc D</h1><p>Delta content.</p></main>`) },
    "/blog/post-1": { body: page("Post 1", `<main><h1>Post 1</h1><p>First post.</p><a href="/blog/post-2">next</a></main>`) },
    "/blog/post-2": { body: page("Post 2", `<main><h1>Post 2</h1><p>Second post.</p><a href="/blog/missing">gone</a></main>`) },
    "/structured": {
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Structured Fixture</title>
<meta name="description" content="A page full of structured data"><meta name="author" content="Fixture Author">
<meta property="og:title" content="OG Title"><meta property="og:image" content="/og1.png"><meta property="og:image" content="/og2.png">
<meta property="article:tag" content="fixtures"><meta name="twitter:card" content="summary"><meta name="twitter:site" content="@fixture">
<link rel="canonical" href="/structured">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget","offers":{"@type":"Offer","price":"9.99","priceCurrency":"USD"}}</script>
<script type="application/ld+json">[{"@type":"BreadcrumbList","itemListElement":[]}]</script>
<script type="application/ld+json">{ this is not json </script>
</head><body>
<div itemscope itemtype="https://schema.org/Person" itemid="#ada">
  <span itemprop="name">Ada Lovelace</span>
  <a itemprop="url" href="/ada">profile</a>
  <div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress"><span itemprop="addressLocality">London</span></div>
  <img itemprop="image" src="/ada.png" alt="">
  <meta itemprop="birthDate" content="1815-12-10">
  <span itemprop="knowsAbout">math</span><span itemprop="knowsAbout">engines</span>
  <time itemprop="deathDate" datetime="1852-11-27">27 Nov 1852</time>
</div>
<ul class="products">
  <li class="product"><h3 class="name">Alpha</h3><span class="price">$1</span><a class="buy" href="/buy/alpha">Buy</a></li>
  <li class="product"><h3 class="name">Beta</h3><span class="price">$2</span><a class="buy" href="/buy/beta">Buy</a></li>
</ul>
<table id="t1"><caption>Prices</caption><thead><tr><th>Item</th><th>Price</th><th>Price</th></tr></thead>
<tbody><tr><td>Alpha</td><td>1</td><td>1.5</td></tr><tr><td rowspan="2">Beta</td><td>2</td><td>2.5</td></tr><tr><td colspan="2">n/a</td></tr></tbody></table>
<table id="t2"><tr><td>a</td><td>b<br>c</td></tr><tr><td>d</td><td>e</td></tr></table>
<table id="t3"><tr><th>Name</th><th>Value, "quoted"</th></tr><tr><td>x</td><td>has, comma</td></tr></table>
<table id="t4"><tr><th>Only header</th></tr></table>
</body></html>`,
    },
    "/articles": {
      body: page(
        "Articles",
        [1, 2, 3, 4, 5, 6].map((n) => `<article><h2>Article ${n}</h2><p>Teaser for article number ${n} with a little prose.</p></article>`).join("\n"),
      ),
    },
    "/private/secret": { body: page("Secret", `<main><h1>Secret</h1><p>Robots should not see this.</p></main>`) },
    "/sitemap-only": { body: page("Sitemap Only", `<main><h1>Sitemap Only</h1><p>Only discoverable through the sitemap.</p></main>`) },
    "/shell": {
      body: `<!doctype html><html><head><title>Shell</title><script defer src="/bundle.js"></script></head><body><div id="root"></div></body></html>`,
    },
    "/bundle.js": {
      type: "application/javascript",
      body: `document.getElementById('root').innerHTML = '<main><h1>Rendered</h1><p>Filled in by JavaScript.</p></main>';`,
    },
    "/plain.txt": { type: "text/plain; charset=utf-8", body: "Hello plain text\nSecond line\n" },
    "/robots.txt": {
      type: "text/plain",
      body: `User-agent: *\nDisallow: /private/\nSitemap: ${base}/sitemap.xml\n`,
    },
    "/blog": {
      body: page(
        "Blog",
        `<main><h1>Blog</h1><p>Posts live here.</p></main>`,
        `<link rel="alternate" type="application/rss+xml" title="Posts" href="/feed.xml"><link rel="alternate" type="application/atom+xml" href="/atom.xml">`,
      ),
    },
    "/feed.xml": {
      type: "application/rss+xml",
      body: `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Fixture Posts</title><link>${base}/blog</link><description>All the posts</description>
<item><title>Post 1</title><link>${base}/blog/post-1</link><guid>${base}/blog/post-1</guid><pubDate>Mon, 02 Jan 2026 10:00:00 GMT</pubDate><dc:creator>Ada</dc:creator><category>news</category><category>fixtures</category><description>&lt;p&gt;First &lt;b&gt;post&lt;/b&gt; summary&lt;/p&gt;</description><content:encoded><![CDATA[<h2>Full</h2><p>Full <em>content</em> here.</p>]]></content:encoded></item>
<item><title>Post 2</title><link>${base}/blog/post-2</link><pubDate>Tue, 03 Jan 2026 10:00:00 GMT</pubDate><description>Second summary</description></item>
</channel></rss>`,
    },
    "/atom.xml": {
      type: "application/atom+xml",
      body: `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Fixture Atom</title><updated>2026-01-04T00:00:00Z</updated><link rel="self" href="${base}/atom.xml"/><link rel="alternate" href="${base}/blog"/>
<entry><id>urn:post-2</id><title>Atom Post 2</title><link rel="alternate" href="${base}/blog/post-2"/><updated>2026-01-03T10:00:00Z</updated><published>2026-01-03T09:00:00Z</published><author><name>Grace</name></author><summary>Atom summary</summary><content type="html">&lt;p&gt;Atom &lt;b&gt;body&lt;/b&gt;&lt;/p&gt;</content><category term="atom"/></entry>
</feed>`,
    },
    "/feed.json": {
      type: "application/feed+json",
      body: JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Fixture JSON Feed",
        home_page_url: `${base}/blog`,
        items: [{ id: "1", url: `${base}/blog/post-1`, title: "JSON Post 1", date_published: "2026-01-02T10:00:00Z", summary: "json summary", content_html: "<p>json body</p>", authors: [{ name: "Linus" }], tags: ["json"] }],
      }),
    },
    "/nolink": { body: page("No Link", `<main><h1>No feed link</h1></main>`) },
    "/rss.xml": {
      type: "text/xml",
      body: `<rss version="2.0"><channel><title>Probed</title><item><title>Probed item</title><link>${base}/blog/post-1</link></item></channel></rss>`,
    },
    "/sitemap.xml": {
      type: "application/xml",
      body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${base}/</loc></url>
<url><loc>${base}/docs/a</loc><lastmod>2026-01-01</lastmod></url>
<url><loc>${base}/docs/b</loc></url>
<url><loc>${base}/blog/post-1</loc></url>
<url><loc>${base}/private/secret</loc></url>
<url><loc>${base}/sitemap-only</loc></url>
</urlset>`,
    },
    "/searx/search": {
      type: "application/json",
      body: (url) =>
        JSON.stringify({
          query: url.searchParams.get("q"),
          results:
            url.searchParams.get("categories") === "news"
              ? [{ url: `${base}/blog/post-1`, title: "Post 1 news", content: "news snippet", publishedDate: "2026-01-02" }]
              : [
                  { url: `${base}/docs/a`, title: "Doc A", content: "snippet A" },
                  { url: `${base}/blog/post-1`, title: "Post 1", content: "snippet B" },
                  { url: "https://example.org/elsewhere", title: "Elsewhere", content: "off-site" },
                ],
        }),
    },
  };
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const requests: string[] = [];
  const mutable: MutableState = { status: 200, body: "<main><h1>Mutable</h1><p>version one</p><p>stable line</p></main>" };
  const knobs = { crawlDelay: undefined as number | undefined, flakyFailures: 0 };
  let flakyCount = 0;
  let base = "";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", base || "http://127.0.0.1");
    requests.push(url.pathname + url.search);
    if (url.pathname === "/robots.txt" && knobs.crawlDelay !== undefined) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`User-agent: *\nDisallow: /private/\nCrawl-delay: ${knobs.crawlDelay}\n`);
      return;
    }
    if (url.pathname === "/flaky") {
      if (flakyCount < knobs.flakyFailures) {
        flakyCount++;
        res.writeHead(503, { "content-type": "text/plain", "retry-after": "0" });
        res.end("busy");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Flaky", `<main><h1>Recovered</h1><p>after ${flakyCount} failures</p></main>`));
      return;
    }
    if (url.pathname === "/ratelimit") {
      res.writeHead(429, { "content-type": "text/plain", "retry-after": "0" });
      res.end("slow down");
      return;
    }
    if (url.pathname === "/mutable") {
      res.writeHead(mutable.status, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Mutable", mutable.body));
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
      res.end();
      return;
    }
    const route = routes(base)[url.pathname];
    if (!route) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Not Found", "<main><h1>Not found</h1><p>No such page.</p></main>"));
      return;
    }
    res.writeHead(route.status ?? 200, { "content-type": route.type ?? "text/html; charset=utf-8" });
    res.end(typeof route.body === "function" ? route.body(url) : route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    requests,
    mutable,
    knobs,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
