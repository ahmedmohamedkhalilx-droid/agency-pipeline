#!/usr/bin/env node
/*
 * check.js — free, deterministic site QA with Playwright.
 *
 * Usage:
 *   node checks/check.js <target> [--out <dir>] [--max-pages <n>] [--no-external]
 *
 * <target> can be:
 *   - a URL                      https://example.com
 *   - a static folder            ./projects/acme/site/out
 *   - a project folder           ./projects/acme   (uses site/, writes to reports/)
 *
 * For each width (375, 768, 1440) and each crawled page it:
 *   - takes a full-page screenshot
 *   - detects horizontal scrolling and the elements causing it
 *   - finds off-screen and overlapping elements
 *   - collects console errors, page errors and failed requests
 *   - flags tap targets smaller than 44px (mobile only)
 * Then it checks every link found for 4xx/5xx and missing #anchors.
 *
 * Writes <out>/report.json and <out>/<page>-<width>.png.
 * Exit code: 0 = pass, 1 = issues found, 2 = the script itself failed.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const WIDTHS = [
  { width: 375, height: 812, mobile: true },
  { width: 768, height: 1024, mobile: true },
  { width: 1440, height: 900, mobile: false },
];
const MIN_TAP = 44;
const MAX_ISSUES_PER_KIND = 25;

// ---------- args ----------
function parseArgs(argv) {
  const args = { target: null, out: null, maxPages: 10, external: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--max-pages') args.maxPages = parseInt(argv[++i], 10) || 1;
    else if (a === '--no-external') args.external = false;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (!args.target) args.target = a;
  }
  return args;
}

// ---------- target resolution ----------
function findStaticRoot(dir) {
  if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  for (const sub of ['out', 'dist', 'build', 'public', '_site']) {
    const p = path.join(dir, sub);
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  return null;
}

function resolveTarget(args) {
  const t = args.target;
  if (/^https?:\/\//i.test(t)) {
    return { kind: 'url', url: t, out: args.out || path.resolve('reports') };
  }
  const abs = path.resolve(t);
  if (!fs.existsSync(abs)) throw new Error(`Target not found: ${abs}`);
  let siteDir = abs;
  let out = args.out;
  if (fs.existsSync(path.join(abs, 'project.json'))) {
    siteDir = path.join(abs, 'site');
    out = out || path.join(abs, 'reports');
  }
  const root = findStaticRoot(siteDir);
  if (!root) {
    throw new Error(
      `No index.html in ${siteDir} (or its out/, dist/, build/). ` +
        'Build the site first, or pass a URL to a running dev server.'
    );
  }
  return { kind: 'folder', root, out: out || path.resolve('reports') };
}

// ---------- tiny static server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain', '.xml': 'application/xml', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.webmanifest': 'application/manifest+json',
};

function serveFolder(root) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const candidates = [p, p + '.html', path.posix.join(p, 'index.html')];
    for (const c of candidates) {
      const file = path.join(root, c);
      if (!file.startsWith(root)) break;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    const notFound = path.join(root, '404.html');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : 'Not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

// ---------- in-page layout audit (runs in the browser) ----------
function layoutAudit({ minTap, checkTap }) {
  const vw = document.documentElement.clientWidth;
  const out = { hscroll: null, offscreen: [], overlaps: [], smallTargets: [] };

  const describe = (el) => {
    const parts = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 4; i++, n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      const cls = (typeof n.className === 'string' ? n.className : '')
        .split(/\s+/).filter((c) => c && !c.includes(':') && c.length < 30).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const text = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '')
    .trim().replace(/\s+/g, ' ').slice(0, 60);
  // The part of el the user can actually see: its box intersected with every
  // ancestor that clips (overflow != visible). Null if nothing is visible, which
  // covers collapsed accordions (max-height:0) and faded-out (opacity:0) parents.
  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return null;
      if (a !== el && cs.overflow !== 'visible' && a !== document.body) {
        const ar = a.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(cs.overflowX)) { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
        if (/(hidden|clip|auto|scroll)/.test(cs.overflowY)) { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
      }
      if (right - left <= 1 || bottom - top <= 1) return null;
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const isVisible = (el) => visibleRect(el) !== null;
  // An element clipped by an overflow:hidden/clip ancestor can't cause visible problems.
  const clippedByAncestor = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (/(hidden|clip)/.test(cs.overflowX) || /(hidden|clip)/.test(cs.overflow)) {
        const r = a.getBoundingClientRect();
        if (r.left >= -1 && r.right <= vw + 1) return true;
      }
    }
    return false;
  };
  const rectOf = (r) => ({ x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });

  const all = Array.from(document.body.querySelectorAll('*'))
    .filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BR', 'svg'].includes(el.tagName) && !el.closest('svg'));

  // 1. horizontal scroll
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (sw > vw + 1) out.hscroll = { scrollWidth: sw, viewport: vw, overflowBy: sw - vw };

  // 2. off-screen elements (only report the outermost offender)
  const offSet = new Set();
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || !isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      if (clippedByAncestor(el)) continue;
      // Fully off the left edge doesn't scroll — it's a deliberate hide (honeypots, skip links).
      if (r.right <= 0) continue;
      if (el.parentElement && offSet.has(el.parentElement)) { offSet.add(el); continue; }
      // sr-only patterns
      if (r.width <= 2 || r.height <= 2) continue;
      offSet.add(el);
      out.offscreen.push({ selector: describe(el), text: text(el), rect: rectOf(r), overflowRight: Math.round(r.right - vw), overflowLeft: Math.round(-r.left) });
    }
  }
  out.offscreen = out.offscreen.filter((o, i, arr) => arr.findIndex((x) => x.selector === o.selector) === i);

  // 3. overlapping content (text, media, controls) — skip fixed/sticky overlays
  const contentSel = 'h1,h2,h3,h4,h5,h6,p,li,a,button,img,picture,video,input,select,textarea,label,blockquote,figcaption,td,th';
  const content = Array.from(document.body.querySelectorAll(contentSel)).filter((el) => {
    if (!isVisible(el)) return false;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const p = getComputedStyle(a).position;
      if (p === 'fixed' || p === 'sticky') return false;
    }
    if (el.tagName !== 'IMG' && el.tagName !== 'VIDEO' && el.tagName !== 'PICTURE' && !text(el) && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) return false;
    return true;
  }).slice(0, 800);
  const rects = content.map(visibleRect);
  const seenPair = new Set();
  for (let i = 0; i < content.length; i++) {
    for (let j = i + 1; j < content.length; j++) {
      const a = content[i], b = content[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = rects[i], rb = rects[j];
      const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ix <= 2 || iy <= 2) continue;
      const area = ix * iy;
      const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (area < 64 || area / smaller < 0.3) continue;
      // Images used as backgrounds behind text are intentional when one is absolutely positioned behind the other.
      const za = getComputedStyle(a).position, zb = getComputedStyle(b).position;
      const media = /^(IMG|PICTURE|VIDEO)$/;
      if ((media.test(a.tagName) || media.test(b.tagName)) && (za === 'absolute' || zb === 'absolute')) continue;
      const key = describe(a) + '|' + describe(b);
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      out.overlaps.push({
        a: { selector: describe(a), text: text(a) },
        b: { selector: describe(b), text: text(b) },
        rect: rectOf({ left: Math.max(ra.left, rb.left), top: Math.max(ra.top, rb.top), width: ix, height: iy }),
        overlapPct: Math.round((area / smaller) * 100),
      });
    }
  }

  // 4. small tap targets
  if (checkTap) {
    const tapSel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[onclick],label[for]';
    for (const el of document.body.querySelectorAll(tapSel)) {
      const cs = getComputedStyle(el);
      if (!isVisible(el)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      // WCAG 2.5.8 exempts links inline in a sentence.
      if (el.tagName === 'A' && cs.display === 'inline') {
        const p = el.parentElement;
        if (p && /^(P|LI|SPAN|TD|DD|BLOCKQUOTE|FIGCAPTION|SMALL|EM|STRONG)$/.test(p.tagName) && (p.innerText || '').trim().length > (el.innerText || '').trim().length + 15) continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < minTap || r.height < minTap) {
        out.smallTargets.push({ selector: describe(el), text: text(el), size: `${Math.round(r.width)}x${Math.round(r.height)}`, rect: rectOf(r) });
      }
    }
  }
  return out;
}

// ---------- helpers ----------
const slug = (u) => {
  const p = new URL(u).pathname.replace(/\/+$/, '') || '/';
  return p === '/' ? 'home' : p.replace(/^\//, '').replace(/[^\w-]+/g, '_').slice(0, 60);
};
const sameOrigin = (a, b) => new URL(a).origin === new URL(b).origin;
const normalize = (u) => { const x = new URL(u); x.hash = ''; x.search = ''; return x.href.replace(/\/$/, '') || x.href; };
const cap = (arr) => ({ count: arr.length, items: arr.slice(0, MAX_ISSUES_PER_KIND) });

async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
}

async function checkLink(request, href, timeout) {
  try {
    let res = await request.fetch(href, { method: 'HEAD', timeout, maxRedirects: 5, failOnStatusCode: false });
    if (res.status() === 405 || res.status() === 403 || res.status() === 501) {
      res = await request.fetch(href, { method: 'GET', timeout, maxRedirects: 5, failOnStatusCode: false });
    }
    return { status: res.status() };
  } catch (e) {
    return { status: 0, error: e.message.split('\n')[0] };
  }
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.target) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    process.exit(args.help ? 0 : 2);
  }

  const target = resolveTarget(args);
  let server = null;
  let baseUrl = target.url;
  if (target.kind === 'folder') {
    const s = await serveFolder(target.root);
    server = s.server;
    baseUrl = s.url;
  }
  fs.mkdirSync(target.out, { recursive: true });
  for (const f of fs.readdirSync(target.out)) if (/\.png$/.test(f)) fs.unlinkSync(path.join(target.out, f));

  const browser = await chromium.launch();
  const report = {
    target: target.kind === 'url' ? target.url : target.root,
    checkedAt: new Date().toISOString(),
    pass: true,
    pages: [],
    widths: {},
    links: null,
  };

  // Discover pages from the homepage (same-origin, up to maxPages).
  const pages = [baseUrl];
  const allLinks = new Map(); // href -> Set(pages it appears on)
  const anchorIds = new Map(); // normalized page url -> Set(ids)

  for (const vp of WIDTHS) {
    const key = String(vp.width);
    const w = { pass: true, issues: [] };
    report.widths[key] = w;
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile && vp.width < 768,
      hasTouch: vp.mobile,
      deviceScaleFactor: 1,
    });

    for (let pi = 0; pi < pages.length; pi++) {
      const url = pages[pi];
      const page = await context.newPage();
      const consoleErrors = [];
      const failedRequests = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
      page.on('pageerror', (e) => consoleErrors.push('Uncaught: ' + e.message.slice(0, 300)));
      page.on('requestfailed', (r) => failedRequests.push({ url: r.url(), error: r.failure()?.errorText }));
      page.on('response', (r) => { if (r.status() >= 400 && r.url() !== url) failedRequests.push({ url: r.url(), status: r.status() }); });

      let status = 0;
      try {
        const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        status = res ? res.status() : 0;
      } catch (e) {
        w.issues.push({ type: 'load-failed', severity: 'error', page: url, message: e.message.split('\n')[0] });
        await page.close();
        continue;
      }
      await autoScroll(page);

      const shot = `${slug(url)}-${vp.width}.png`;
      await page.screenshot({ path: path.join(target.out, shot), fullPage: true });
      const audit = await page.evaluate(layoutAudit, { minTap: MIN_TAP, checkTap: vp.width === 375 });

      const pageResult = { page: url, status, screenshot: shot };
      const add = (type, severity, data) => w.issues.push({ type, severity, page: url, ...data });

      if (status >= 400) add('http-status', 'error', { status });
      if (audit.hscroll) add('horizontal-scroll', 'error', audit.hscroll);
      if (audit.offscreen.length) add('off-screen', 'error', cap(audit.offscreen));
      if (audit.overlaps.length) add('overlap', 'error', cap(audit.overlaps));
      if (audit.smallTargets.length) add('small-tap-target', 'error', { minSize: MIN_TAP, ...cap(audit.smallTargets) });
      if (consoleErrors.length) add('console-error', 'error', cap([...new Set(consoleErrors)]));
      const uniqFailed = failedRequests.filter((f, i, a) => a.findIndex((x) => x.url === f.url) === i);
      if (uniqFailed.length) add('failed-request', 'error', cap(uniqFailed));

      // Links + anchors: gather once, from the desktop pass.
      if (vp.width === 1440 || WIDTHS.length === 1) {
        const found = await page.evaluate(() => ({
          links: Array.from(document.querySelectorAll('a[href]')).map((a) => a.href),
          ids: Array.from(document.querySelectorAll('[id],a[name]')).map((e) => e.id || e.getAttribute('name')),
        }));
        anchorIds.set(normalize(url), new Set(found.ids));
        for (const href of found.links) {
          if (!/^https?:/i.test(href)) continue;
          if (!allLinks.has(href)) allLinks.set(href, new Set());
          allLinks.get(href).add(url);
        }
      }

      // Crawl: discover more pages during the first width only.
      if (vp === WIDTHS[0] && pages.length < args.maxPages) {
        const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => a.href));
        for (const h of hrefs) {
          if (pages.length >= args.maxPages) break;
          if (!/^https?:/i.test(h) || !sameOrigin(h, baseUrl)) continue;
          if (/\.(pdf|png|jpe?g|gif|svg|webp|zip|mp4|docx?|xlsx?)$/i.test(new URL(h).pathname)) continue;
          const n = normalize(h);
          if (!pages.some((p) => normalize(p) === n)) pages.push(new URL(h).origin + new URL(h).pathname);
        }
      }

      if (vp === WIDTHS[0]) report.pages.push(pageResult);
      await page.close();
    }

    w.pass = !w.issues.some((i) => i.severity === 'error');
    await context.close();
  }

  // Broken links
  const request = (await browser.newContext()).request;
  const broken = [];
  const warnings = [];
  const checked = new Map();
  const entries = [...allLinks.entries()].slice(0, 300);
  await Promise.all(
    Array.from({ length: 8 }, async (_, worker) => {
      for (let i = worker; i < entries.length; i += 8) {
        const [href, onPages] = entries[i];
        const internal = sameOrigin(href, baseUrl);
        if (!internal && !args.external) continue;
        const u = new URL(href);
        const noHash = href.split('#')[0];
        if (!checked.has(noHash)) checked.set(noHash, await checkLink(request, noHash, internal ? 10000 : 15000));
        const r = checked.get(noHash);
        const where = [...onPages].map((p) => new URL(p).pathname);
        if (r.status >= 400 || r.status === 0) {
          // Many sites block bots with 403/429 — treat external ones as warnings.
          const soft = !internal && (r.status === 403 || r.status === 429 || r.status === 999);
          (soft ? warnings : broken).push({ href, status: r.status, error: r.error, internal, foundOn: where });
        } else if (u.hash.length > 1 && internal) {
          const ids = anchorIds.get(normalize(noHash));
          const id = decodeURIComponent(u.hash.slice(1));
          if (ids && !ids.has(id)) broken.push({ href, status: r.status, error: `missing anchor #${id}`, internal, foundOn: where });
        }
      }
    })
  );
  report.links = { pass: broken.length === 0, checked: checked.size, broken, warnings };

  report.pass = Object.values(report.widths).every((w) => w.pass) && report.links.pass;
  fs.writeFileSync(path.join(target.out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  if (server) server.close();

  // ---------- console summary (what agents read) ----------
  const line = (s) => process.stdout.write(s + '\n');
  line(`\nSite check: ${report.target}`);
  line(`Pages: ${report.pages.map((p) => new URL(p.page).pathname).join(', ')}`);
  for (const [width, w] of Object.entries(report.widths)) {
    line(`\n[${w.pass ? 'PASS' : 'FAIL'}] ${width}px`);
    for (const i of w.issues) {
      const where = new URL(i.page).pathname;
      const n = i.count != null ? ` (${i.count})` : '';
      let detail = '';
      if (i.type === 'http-status') detail = ` page returned ${i.status}`;
      else if (i.type === 'horizontal-scroll') detail = ` page is ${i.scrollWidth}px wide, overflows by ${i.overflowBy}px`;
      else if (i.items && i.items[0]) {
        const first = i.items[0];
        detail = ' e.g. ' + (typeof first === 'string' ? first
          : first.selector ? `${first.selector}${first.size ? ' ' + first.size : ''}${first.text ? ` "${first.text}"` : ''}`
          : first.a ? `${first.a.selector} ↔ ${first.b.selector}`
          : first.url || '');
      } else if (i.message) detail = ' ' + i.message;
      line(`  - ${i.type}${n} on ${where}:${detail.slice(0, 200)}`);
    }
  }
  line(`\n[${report.links.pass ? 'PASS' : 'FAIL'}] links: ${report.links.checked} checked, ${report.links.broken.length} broken, ${report.links.warnings.length} warnings`);
  for (const b of report.links.broken.slice(0, 15)) line(`  - ${b.status || 'ERR'} ${b.href}${b.error ? ' (' + b.error + ')' : ''} on ${b.foundOn.join(', ')}`);
  line(`\nOverall: ${report.pass ? 'PASS' : 'FAIL'} — full details in ${path.join(target.out, 'report.json')}\n`);
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error('check.js failed:', e.message);
  process.exit(2);
});
