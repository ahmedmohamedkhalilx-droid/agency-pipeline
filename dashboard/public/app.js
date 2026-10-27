/* Pipeline dashboard: canvas, live log, step details. Vanilla JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  trigger: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  research: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  build: '<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/>',
  check: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  review: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  summary: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
};
const BADGE = {
  running: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  success: '<path d="m5 12 5 5 9-10"/>',
  fail: '<path d="M7 7l10 10M17 7 7 17"/>',
  stopped: '<path d="M12 7v6M12 17h.01"/>',
};
const svg = (paths) => `<svg viewBox="0 0 24 24">${paths}</svg>`;

const NODES = [
  // Snake layout: top row runs left→right, bottom row comes back right→left.
  { id: 'trigger', title: '/build-client', label: 'Trigger', x: 0, y: 0 },
  { id: 'research', title: 'Niche research', label: 'niche-researcher', x: 280, y: 0 },
  { id: 'build', title: 'Build & fix', label: 'builder', x: 560, y: 0 },
  { id: 'check', title: 'Site check', label: 'check.js', x: 560, y: 230 },
  { id: 'review', title: 'Visual review', label: 'visual-reviewer', x: 280, y: 230 },
  { id: 'summary', title: 'Summary', label: 'Result', x: 0, y: 230 },
];
const NW = 208;
// Each edge leaves one side of a node and enters a side of another: l, r, t, b.
// `dx` nudges the port along that side so two edges can share it.
const EDGES = [
  { from: 'trigger', fs: 'r', to: 'research', ts: 'l' },
  { from: 'research', fs: 'r', to: 'build', ts: 'l' },
  { from: 'build', fs: 'b', to: 'check', ts: 't' },
  { from: 'check', fs: 'l', to: 'review', ts: 'r', label: 'pass' },
  { from: 'review', fs: 'l', to: 'summary', ts: 'r', label: 'pass' },
  { from: 'check', fs: 'r', to: 'build', ts: 'r', loop: true, bend: 90, label: 'fail → fix' },
  { from: 'review', fs: 't', to: 'build', ts: 'b', tdx: -60, loop: true, bend: 60, label: 'changes → fix' },
];
const DIR = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };

const S = {
  projects: [], runs: [], maxRounds: 3,
  client: localStorage.getItem('pl.client') || null,
  viewRunId: null, // null = live
  selected: null, tab: 'live', shotWidth: '375',
  view: { x: 60, y: 140, k: 1 },
  pos: (() => { try { return JSON.parse(localStorage.getItem('pl.pos')) || {}; } catch { return {}; } })(),
};

// ---------- data ----------
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const project = () => S.projects.find((p) => p.slug === S.client);
const clientRuns = (slug = S.client) => S.runs.filter((r) => r.client === slug);
const liveRun = (slug = S.client) => { const rs = clientRuns(slug); return rs.length ? rs[rs.length - 1] : null; };
const shownRun = () => (S.viewRunId ? S.runs.find((r) => r.id === S.viewRunId) : liveRun());

function upsertRun(run) {
  const i = S.runs.findIndex((r) => r.id === run.id);
  if (i >= 0) S.runs[i] = run; else S.runs.push(run);
}

async function load() {
  const st = await api('/api/state');
  S.projects = st.projects; S.runs = st.runs; S.maxRounds = st.maxRounds;
  if (!S.client || !project()) S.client = S.projects[0]?.slug || null;
  render();
  fit();
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('run', (e) => {
    const run = JSON.parse(e.data);
    upsertRun(run);
    if (run.client !== S.client && run.status === 'running' && !S.viewRunId && !liveRun()?.status?.match(/running/)) {
      toast(`${run.client}: run started`);
    }
    render();
  });
  es.addEventListener('projects', (e) => { S.projects = JSON.parse(e.data); render(); });
  es.onerror = () => { $('#run-meta').textContent = 'Reconnecting…'; };
  es.addEventListener('hello', () => { if ($('#run-meta').textContent === 'Reconnecting…') load(); });
}

// ---------- node state (live run, or last known state from disk) ----------
function nodeState(id, run, p) {
  if (run) return run.nodes[id];
  const st = { status: 'idle', detail: '', runs: 0 };
  if (!p) return st;
  if (id === 'trigger') st.detail = p.status || 'intake';
  if (id === 'research') st.detail = p.nicheCached ? `niches/${p.niche}.md cached` : p.niche ? `${p.niche}: not researched` : 'No niche set';
  if (id === 'build') st.detail = p.hasSite ? 'Site exists' : 'No site yet';
  if (id === 'check' && p.report) st.detail = `Last: ${p.report.pass ? 'PASS' : 'FAIL'} · ${ago(p.report.checkedAt)}`;
  if (id === 'summary') st.detail = p.status || '';
  return st;
}

function foot(id, n, run) {
  const dur = n.startedAt ? fmtDur((n.endedAt || Date.now()) - n.startedAt) : '';
  if (id === 'build' && run) return [`Round ${run.rounds}/${run.maxRounds}`, dur];
  if (n.runs > 1) return [`×${n.runs}`, dur];
  return [n.status === 'idle' ? 'waiting' : n.status, dur];
}

// ---------- canvas ----------
const posOf = (n) => S.pos[n.id] || { x: n.x, y: n.y };

function renderCanvas() {
  const run = shownRun();
  const p = project();
  const nodesEl = $('#nodes');
  nodesEl.innerHTML = NODES.map((n) => {
    const st = nodeState(n.id, run, p);
    const [l, r] = foot(n.id, st, run);
    const { x, y } = posOf(n);
    return `<div class="node s-${st.status} ${S.selected === n.id ? 'selected' : ''}" data-id="${n.id}" style="left:${x}px;top:${y}px;--tint:var(--t-${n.id})">
      <span class="node-label">${esc(n.label)}</span>
      <span class="node-badge">${svg(BADGE[st.status] || '')}</span>
      <div class="node-main"><div class="node-icon">${svg(ICONS[n.id])}</div>
        <div class="node-text"><div class="node-title">${esc(n.title)}</div><div class="node-sub" title="${esc(st.detail)}">${esc(st.detail || '—')}</div></div>
      </div>
      <div class="node-foot"><span>${esc(l)}</span><span>${esc(r)}</span></div>
    </div>`;
  }).join('');

  const nodesState = Object.fromEntries(NODES.map((n) => [n.id, nodeState(n.id, run, p).status]));
  const size = Object.fromEntries([...nodesEl.children].map((el) => [el.dataset.id, { w: el.offsetWidth, h: el.offsetHeight }]));
  const port = (id, side, dx = 0) => {
    const { x, y } = posOf(NODES.find((n) => n.id === id)), { w, h } = size[id];
    return { l: [x, y + h / 2 + dx], r: [x + w, y + h / 2 + dx], t: [x + w / 2 + dx, y], b: [x + w / 2 + dx, y + h] }[side];
  };
  const lines = [], labels = [], dots = [];
  for (const e of EDGES) {
    const [x1, y1] = port(e.from, e.fs, e.fdx), [x2, y2] = port(e.to, e.ts, e.tdx);
    const [ax, ay] = DIR[e.fs], [bx, by] = DIR[e.ts];
    const c = e.bend || Math.max(40, Math.hypot(x2 - x1, y2 - y1) / 2.5);
    // Stop short of the target so the arrowhead sits on the port.
    const ex = x2 + bx * 9, ey = y2 + by * 9;
    const d = `M${x1},${y1} C${x1 + ax * c},${y1 + ay * c} ${ex + bx * c},${ey + by * c} ${ex},${ey}`;
    const src = nodesState[e.from], dst = nodesState[e.to];
    let cls = e.loop ? 'e-loop' : '';
    const fixing = dst === 'running' && run && run.rounds > 0;
    if (e.loop ? fixing && src === 'fail' : dst === 'running' && /success|skipped/.test(src)) cls += ' e-active';
    else if (!e.loop && /success|skipped/.test(src) && /success|skipped|running|fail/.test(dst)) cls += ' e-done';
    lines.push(`<path d="${d}" class="${cls}"/>`);
    // arrowhead pointing into the target port
    const px = -bx, py = -by, s = 6;
    dots.push(`<path class="arrow ${cls}" d="M${x2},${y2} L${ex - py * s + px * 0},${ey + px * s} L${ex + py * s},${ey - px * s}z"/>`);
    dots.push(`<circle class="port-dot" cx="${x1}" cy="${y1}" r="4.5"/>`);
    if (e.label) {
      // label at the curve's midpoint (t = .5 on the cubic)
      const lx = (x1 + 3 * (x1 + ax * c) + 3 * (ex + bx * c) + ex) / 8, ly = (y1 + 3 * (y1 + ay * c) + 3 * (ey + by * c) + ey) / 8;
      const w = e.label.length * 6.6 + 14;
      labels.push(`<rect class="lbl-bg ${cls}" x="${lx - w / 2}" y="${ly - 9}" width="${w}" height="18" rx="9"/><text x="${lx}" y="${ly + 4}" text-anchor="middle">${esc(e.label)}</text>`);
    }
  }
  $('#edges').innerHTML = lines.join('') + dots.join('') + labels.join('');
  applyView();
}

function applyView() {
  const { x, y, k } = S.view;
  $('#canvas').style.transform = `translate(${x}px,${y}px) scale(${k})`;
  const wrap = $('#canvas-wrap');
  wrap.style.backgroundPosition = `${x}px ${y}px`;
  wrap.style.backgroundSize = `${22 * k}px ${22 * k}px`;
}

function fit() {
  const wrap = $('#canvas-wrap').getBoundingClientRect();
  const ps = NODES.map(posOf);
  // extra room on the right for the "fail → fix" loop
  const minX = Math.min(...ps.map((p) => p.x)) - 30, maxX = Math.max(...ps.map((p) => p.x)) + NW + 130;
  const minY = Math.min(...ps.map((p) => p.y)) - 50, maxY = Math.max(...ps.map((p) => p.y)) + 130;
  const k = Math.min(1.15, Math.max(0.35, Math.min(wrap.width / (maxX - minX), wrap.height / (maxY - minY))));
  S.view = { k, x: (wrap.width - (maxX - minX) * k) / 2 - minX * k, y: (wrap.height - (maxY - minY) * k) / 2 - minY * k };
  applyView();
}

function zoomAt(f, cx, cy) {
  const k = Math.min(2, Math.max(0.3, S.view.k * f));
  S.view.x = cx - (cx - S.view.x) * (k / S.view.k);
  S.view.y = cy - (cy - S.view.y) * (k / S.view.k);
  S.view.k = k;
  applyView();
}

(function canvasInput() {
  const wrap = $('#canvas-wrap');
  let drag = null;
  wrap.addEventListener('pointerdown', (e) => {
    const nodeEl = e.target.closest('.node');
    if (e.target.closest('.zoom, .legend, .past-banner')) return;
    const r = wrap.getBoundingClientRect();
    if (nodeEl) {
      const id = nodeEl.dataset.id, p = posOf(NODES.find((n) => n.id === id));
      drag = { type: 'node', id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
    } else {
      drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: S.view.x, oy: S.view.y };
      wrap.classList.add('panning');
    }
    wrap.setPointerCapture(e.pointerId);
    void r;
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (drag.type === 'pan') { S.view.x = drag.ox + dx; S.view.y = drag.oy + dy; applyView(); }
    else if (Math.abs(dx) + Math.abs(dy) > 3 || drag.moved) {
      drag.moved = true;
      S.pos[drag.id] = { x: Math.round((drag.ox + dx / S.view.k) / 10) * 10, y: Math.round((drag.oy + dy / S.view.k) / 10) * 10 };
      renderCanvas();
    }
  });
  wrap.addEventListener('pointerup', () => {
    if (drag?.type === 'node') {
      if (drag.moved) localStorage.setItem('pl.pos', JSON.stringify(S.pos));
      else { S.selected = drag.id; setTab('step'); render(); }
    }
    drag = null;
    wrap.classList.remove('panning');
  });
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  document.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    const r = wrap.getBoundingClientRect();
    if (b.dataset.zoom === 'fit') fit(); else zoomAt(b.dataset.zoom === 'in' ? 1.2 : 1 / 1.2, r.width / 2, r.height / 2);
  }));
  wrap.addEventListener('dblclick', (e) => { if (!e.target.closest('.node')) { S.pos = {}; localStorage.removeItem('pl.pos'); renderCanvas(); fit(); } });
})();

// ---------- sidebar ----------
function renderClients() {
  const list = $('#client-list');
  $('#client-empty').hidden = S.projects.length > 0;
  list.innerHTML = S.projects.map((p) => {
    const r = liveRun(p.slug);
    const live = r?.status === 'running' ? 'on' : p.report ? (p.report.pass ? 'ok' : 'bad') : '';
    return `<li class="client ${p.slug === S.client ? 'active' : ''}" data-slug="${esc(p.slug)}">
      <span class="name">${esc(p.name)}</span><span class="live ${live}" title="${live === 'on' ? 'Running' : live === 'ok' ? 'Last check passed' : live === 'bad' ? 'Last check failed' : 'Not checked yet'}"></span>
      <span class="meta"><span>${esc(p.niche || 'no niche')}</span><span>·</span><span>${esc(p.status || '')}</span>${p.openBugs ? `<span>· ${p.openBugs} bugs</span>` : ''}</span>
    </li>`;
  }).join('');
}

// ---------- top bar ----------
function renderTop() {
  const p = project();
  const run = shownRun();
  $('#crumb-client').textContent = p ? p.name : 'No client';
  const pill = $('#run-pill');
  const st = run ? run.status : 'idle';
  pill.className = `pill pill-${st}`;
  pill.textContent = { idle: 'Idle', running: 'Running', done: 'Finished', failed: 'Failed', stopped: 'Stopped' }[st];
  $('#run-meta').textContent = run
    ? `${run.mode === 'check' ? 'Check only' : run.mode === 'manual' ? 'Manual steps' : 'Pipeline'} · started ${ago(run.startedAt)}${run.endedAt ? ' · took ' + fmtDur(run.endedAt - run.startedAt) : ''}`
    : '';
  const running = liveRun()?.status === 'running';
  $('#btn-run').disabled = !p || running;
  $('#btn-check').disabled = !p || running;
  $('#btn-stop').hidden = !running;
  $('#past-banner').hidden = !S.viewRunId;
}

// ---------- right panel ----------
function setTab(t) {
  S.tab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab-body').forEach((b) => (b.hidden = b.dataset.body !== t));
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { setTab(b.dataset.tab); render(); }));

function renderLog() {
  const run = shownRun();
  const el = $('#log');
  const body = el.parentElement;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const lines = run ? run.log : [];
  $('#log-empty').hidden = lines.length > 0;
  el.innerHTML = lines.map((l) => `<li class="k-${esc(l.kind)}"><time>${fmtTime(l.t)}</time><span class="txt">${esc(l.text)}</span></li>`).join('');
  if (atBottom) body.scrollTop = body.scrollHeight;
}

function renderRuns() {
  const rs = clientRuns().slice().reverse();
  $('#runs').innerHTML = rs.length ? rs.map((r, i) => `<li data-run="${r.id}" class="${(S.viewRunId || (i === 0 && rs[0].id)) === r.id ? 'active' : ''}">
      <strong>${r.mode === 'check' ? 'Check only' : r.mode === 'manual' ? 'Manual steps' : 'Pipeline run'}</strong>
      <span class="pill pill-${r.status}">${r.status}</span>
      <span class="when">${new Date(r.startedAt).toLocaleString()} · ${r.endedAt ? fmtDur(r.endedAt - r.startedAt) : 'in progress'}${r.rounds ? ` · ${r.rounds} fix rounds` : ''}</span>
    </li>`).join('') : '<div class="empty muted">No runs for this client yet.</div>';
}

let detailCache = { slug: null, at: 0, data: null };
async function projectDetail(force) {
  if (!S.client) return null;
  const p = project();
  const stamp = (p?.report?.checkedAt || '') + (p?.history?.[0]?.at || '');
  if (!force && detailCache.slug === S.client && detailCache.stamp === stamp) return detailCache.data;
  const data = await api(`/api/project/${encodeURIComponent(S.client)}`);
  detailCache = { slug: S.client, stamp, data };
  return data;
}

let stepSeq = 0;
async function renderStep() {
  // Only the newest call may write, so a slow fetch can't overwrite a fresher panel.
  const seq = ++stepSeq;
  try {
    const html = await stepHtml();
    if (seq === stepSeq) $('#step').innerHTML = html;
  } catch (err) {
    if (seq === stepSeq) $('#step').innerHTML = `<div class="empty">Couldn't load this step: ${esc(err.message)}</div>`;
  }
}

async function stepHtml() {
  const id = S.selected;
  if (!id) return '<div class="empty muted">Click a step on the canvas to see what it did.</div>';
  const n = NODES.find((x) => x.id === id);
  const run = shownRun();
  const p = project();
  const st = nodeState(id, run, p);
  const head = `<div class="step"><div class="step-head"><div class="node-icon" style="--tint:var(--t-${id})">${svg(ICONS[id])}</div>
    <div><h2>${esc(n.title)}</h2><span class="pill pill-${st.status === 'success' || st.status === 'skipped' ? 'done' : st.status === 'fail' ? 'failed' : st.status}">${esc(st.status)}</span>
    <span class="muted small"> ${esc(st.detail || '')}</span></div></div>`;
  let body = '';
  const timing = st.startedAt ? `<dt>Started</dt><dd>${fmtTime(st.startedAt)}</dd><dt>Took</dt><dd>${fmtDur((st.endedAt || Date.now()) - st.startedAt)}</dd>` : '';

  if (id === 'trigger') {
    body = `<dl class="kv"><dt>Client</dt><dd>${esc(p?.name)}</dd><dt>Folder</dt><dd><code>projects/${esc(S.client)}</code></dd>
      <dt>Status</dt><dd>${esc(p?.status)}</dd><dt>Open bugs</dt><dd>${p?.openBugs ?? 0}</dd><dt>Questions</dt><dd>${p?.openQuestions ?? 0}</dd>${timing}</dl>`;
  } else if (id === 'research') {
    body = `<dl class="kv"><dt>Niche</dt><dd>${esc(p?.niche || '—')}</dd><dt>Cached file</dt><dd>${p?.nicheCached ? `<code>niches/${esc(p.niche)}.md</code>` : 'not yet'}</dd>${timing}</dl>
      ${run?.nodes.research.report ? `<h3>Researcher reply</h3><pre class="report-text">${esc(run.nodes.research.report)}</pre>` : ''}`;
  } else if (id === 'build') {
    body = `<dl class="kv"><dt>Fix rounds</dt><dd>${run ? `${run.rounds} / ${run.maxRounds}` : '—'}</dd>${timing}</dl>
      <h3>Files touched this run</h3>${run?.files.length ? `<ul class="files">${run.files.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}
      ${run?.nodes.build.report ? `<h3>Builder reply</h3><pre class="report-text">${esc(run.nodes.build.report)}</pre>` : ''}`;
  } else if (id === 'check') {
    const d = await projectDetail();
    const rep = d?.report;
    if (!rep) body = '<p class="muted">No report yet. Click <strong>Run check</strong> once the site has an <code>index.html</code>.</p>';
    else {
      const widths = Object.entries(rep.widths);
      body = `<p class="muted small">Checked ${new Date(rep.checkedAt).toLocaleString()} · ${rep.pages.length} pages</p>
        <div class="widths">${widths.map(([w, v]) => `<div class="wcard ${v.pass ? 'ok' : 'bad'}"><span class="muted small">${w}px</span><b>${v.pass ? 'PASS' : 'FAIL'}</b><span class="small">${v.issues.length} issue types</span></div>`).join('')}</div>
        <h3>Issues</h3>${issuesList(rep)}
        <h3>Links</h3><p>${rep.links.checked} checked · ${rep.links.broken.length ? `<span style="color:var(--fail)">${rep.links.broken.length} broken</span>` : 'none broken'}${rep.links.warnings.length ? ` · ${rep.links.warnings.length} warnings` : ''}</p>
        ${rep.links.broken.length ? `<ul class="issues">${rep.links.broken.map((b) => `<li><span>${esc(b.href)}</span><span>${esc(b.error || b.status || 'ERR')}</span></li>`).join('')}</ul>` : ''}
        <h3>Screenshots</h3>${shotsGrid(p)}`;
    }
  } else if (id === 'review') {
    body = `<dl class="kv">${timing}</dl>${run?.nodes.review.report ? `<h3>Reviewer verdict</h3><pre class="report-text">${esc(run.nodes.review.report)}</pre>` : '<p class="muted">Runs once the site check passes. It scores the screenshots against <code>checks/visual-checklist.md</code>.</p>'}`;
  } else if (id === 'summary') {
    body = `<dl class="kv"><dt>Project status</dt><dd>${esc(p?.status)}</dd><dt>Open bugs</dt><dd>${p?.openBugs ?? 0}</dd></dl>
      <h3>History (project.json)</h3>${p?.history?.length ? `<ul class="hist">${p.history.map((h) => `<li><span class="by">${esc(h.by)}</span> <span class="muted small">${esc(h.at ? new Date(h.at).toLocaleString() : '')}</span><div>${esc(h.did)}</div></li>`).join('')}</ul>` : '<p class="muted">No history yet.</p>'}`;
  }
  return head + body + '</div>';
}

function issuesList(rep) {
  // One row per issue type + page, listing the widths it shows up at.
  const rows = new Map();
  for (const [w, v] of Object.entries(rep.widths)) for (const i of v.issues) {
    const page = new URL(i.page).pathname, key = i.type + page;
    if (!rows.has(key)) rows.set(key, { type: i.type, page, widths: [], count: 0, first: i.items?.[0] });
    const r = rows.get(key);
    r.widths.push(w); r.count = Math.max(r.count, i.count ?? 1);
  }
  if (!rows.size) return '<p class="muted">No issues.</p>';
  const hint = (f) => (f ? f.selector || (f.a && `${f.a.selector} ↔ ${f.b.selector}`) || f.url || String(f) : '');
  return `<ul class="issues">${[...rows.values()].map((r) => `<li title="${esc(hint(r.first))}"><span>${esc(r.type)} · ${esc(r.page)}${r.count > 1 ? ` ×${r.count}` : ''}</span><span class="muted">${r.widths.join(' · ')}</span></li>`).join('')}</ul>`;
}

function shotsGrid(p) {
  if (!p?.shots?.length) return '<p class="muted">No screenshots.</p>';
  const widths = [...new Set(p.shots.map((s) => s.match(/-(\d+)\.png$/)?.[1]).filter(Boolean))].sort((a, b) => a - b);
  if (!widths.includes(S.shotWidth)) S.shotWidth = widths[0];
  const shots = p.shots.filter((s) => s.endsWith(`-${S.shotWidth}.png`));
  const v = encodeURIComponent(p.report?.checkedAt || '');
  return `<div class="shots-tabs">${widths.map((w) => `<button class="chip ${w === S.shotWidth ? 'active' : ''}" data-shotw="${w}">${w}px</button>`).join('')}</div>
    <div class="shots">${shots.map((s) => `<button class="shot" data-shot="${esc(s)}"><img loading="lazy" src="/shots/${encodeURIComponent(p.slug)}/${encodeURIComponent(s)}?v=${v}" alt="${esc(s)}"><span>${esc(s.replace(/-\d+\.png$/, ''))}</span></button>`).join('')}</div>`;
}

// ---------- events ----------
$('#client-list').addEventListener('click', (e) => {
  const li = e.target.closest('.client');
  if (!li) return;
  S.client = li.dataset.slug; S.viewRunId = null;
  localStorage.setItem('pl.client', S.client);
  render();
});
$('#runs').addEventListener('click', (e) => {
  const li = e.target.closest('[data-run]');
  if (!li) return;
  const latest = liveRun();
  S.viewRunId = latest && latest.id === li.dataset.run ? null : li.dataset.run;
  render();
});
$('#btn-live').addEventListener('click', () => { S.viewRunId = null; render(); });
$('#step').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-shotw]');
  if (chip) { S.shotWidth = chip.dataset.shotw; renderStep(); return; }
  const shot = e.target.closest('[data-shot]');
  if (shot) {
    $('#lb-img').src = shot.querySelector('img').src;
    $('#lb-cap').textContent = shot.dataset.shot;
    $('#lightbox').hidden = false;
  }
});
$('#lightbox').addEventListener('click', (e) => { if (e.target.closest('.lb-close') || e.target.id === 'lightbox') $('#lightbox').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#lightbox').hidden = true; });

async function start(mode) {
  try {
    S.viewRunId = null;
    await api(`/api/run/${encodeURIComponent(S.client)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
    setTab('live'); render();
  } catch (err) { toast(err.message); }
}
$('#btn-run').addEventListener('click', () => {
  if (confirm(`Run /build-client ${S.client} with Claude Code?\n\nIt can edit files in projects/${S.client}/ and run check.js. This uses your Claude plan.`)) start('pipeline');
});
$('#btn-check').addEventListener('click', () => start('check'));
$('#btn-stop').addEventListener('click', async () => {
  try { await api(`/api/stop/${encodeURIComponent(S.client)}`, { method: 'POST' }); } catch (err) { toast(err.message); }
});
$('#btn-new').addEventListener('click', async () => {
  const name = prompt('Client name (copies projects/_template):');
  if (!name) return;
  try {
    const { slug } = await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    S.client = slug; localStorage.setItem('pl.client', slug);
    toast(`Created projects/${slug}. Paste the brief into project.json`);
    await load();
  } catch (err) { toast(err.message); }
});

// ---------- utils ----------
function fmtTime(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function ago(t) {
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function render() {
  renderTop(); renderClients(); renderCanvas();
  if (S.tab === 'live') renderLog();
  if (S.tab === 'runs') renderRuns();
  if (S.tab === 'step') renderStep();
}
// Keep durations and "x ago" fresh while something runs.
setInterval(() => { if (liveRun()?.status === 'running') { renderTop(); renderCanvas(); } }, 1000);
window.addEventListener('resize', () => fit());

load().then(connect).catch((err) => toast('Could not reach the dashboard server: ' + err.message));
