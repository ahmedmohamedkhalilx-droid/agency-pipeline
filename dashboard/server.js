#!/usr/bin/env node
/*
 * Pipeline dashboard — a local, n8n-style view of the agency pipeline.
 *
 *   node dashboard/server.js        → http://localhost:4321
 *
 * Every step of a run is an event in .pipeline/events.jsonl. Events come from:
 *   - dashboard/hook.js (Claude Code hooks), whether the run was started here,
 *     in the desktop app, or in a terminal
 *   - this server (runs it starts, their output, report.json changes)
 * The server folds events into run state and streams it to the page over SSE.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECTS = path.join(ROOT, 'projects');
const NICHES = path.join(ROOT, 'niches');
const PUBLIC = path.join(__dirname, 'public');
const LOG = path.join(ROOT, '.pipeline', 'events.jsonl');
const PORT = Number(process.env.PORT) || 4321;
const MAX_ROUNDS = 3;
const SLUG = /^[\w.-]+$/;

fs.mkdirSync(path.dirname(LOG), { recursive: true });
if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, '');

// ---------- event log ----------
function emit(ev) {
  fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
}

// ---------- run state ----------
const NODES = ['trigger', 'research', 'build', 'check', 'review', 'summary'];
const AGENT_NODE = { 'niche-researcher': 'research', builder: 'build', 'visual-reviewer': 'review' };
const runs = []; // newest last
const active = {}; // client -> run
const sessionClient = {};
let runSeq = 0;

function newRun(client, mode, session) {
  const run = {
    id: `${Date.now().toString(36)}-${++runSeq}`,
    client, mode, session: session || null,
    status: 'running', startedAt: Date.now(), endedAt: null, lastAt: Date.now(),
    rounds: 0, maxRounds: MAX_ROUNDS,
    nodes: Object.fromEntries(NODES.map((n) => [n, { status: 'idle', detail: '', startedAt: null, endedAt: null, runs: 0 }])),
    files: [], log: [],
  };
  runs.push(run);
  if (runs.length > 60) runs.shift();
  active[client] = run;
  return run;
}

function setNode(run, id, status, detail, t) {
  const n = run.nodes[id];
  if (status === 'running') { n.startedAt = t; n.endedAt = null; n.runs++; }
  else if (status !== 'idle') n.endedAt = t;
  n.status = status;
  if (detail != null) n.detail = detail;
}

function addLog(run, t, kind, text, node) {
  run.log.push({ t, kind, text: String(text).slice(0, 2000), node });
  if (run.log.length > 400) run.log.splice(0, run.log.length - 400);
}

function finishRun(run, t, how) {
  if (run.status !== 'running') return;
  for (const id of NODES) if (run.nodes[id].status === 'running') setNode(run, id, how === 'stopped' ? 'stopped' : 'fail', null, t);
  const failed = NODES.some((id) => run.nodes[id].status === 'fail');
  if (run.mode !== 'check') {
    const reviewOk = run.nodes.review.status === 'success';
    setNode(run, 'summary', how === 'stopped' ? 'stopped' : reviewOk ? 'success' : 'fail',
      how === 'stopped' ? 'Stopped' : reviewOk ? 'Review-ready' : 'Needs a human', t);
  }
  run.status = how === 'stopped' ? 'stopped' : how === 'error' || failed ? 'failed' : 'done';
  run.endedAt = t;
  if (active[run.client] === run) delete active[run.client];
}

const isCheckCmd = (cmd) => /checks[\\/]+check\.js/.test(cmd || '');

function apply(e) {
  if (e.client && e.session) sessionClient[e.session] = e.client;
  const client = e.client || (e.session && sessionClient[e.session]);
  if (!client) return null;
  const t = e.t || Date.now();
  let run = active[client];

  // ---- run start ----
  if (e.ev === 'RunStart') {
    if (run) finishRun(run, t, 'stopped');
    run = newRun(client, e.mode, null);
    setNode(run, 'trigger', 'success', e.mode === 'check' ? 'Check only' : 'Started from dashboard', t);
    addLog(run, t, 'system', e.mode === 'check' ? 'Check started' : `Pipeline started: /build-client ${client}`, 'trigger');
    return run;
  }
  if (e.ev === 'UserPromptSubmit' && e.start) {
    // A run the dashboard spawned announces its session here: attach, don't duplicate.
    if (run && !run.session && run.mode === 'pipeline' && t - run.startedAt < 60000) { run.session = e.session; return run; }
    if (run) finishRun(run, t, 'stopped');
    run = newRun(client, 'pipeline', e.session);
    setNode(run, 'trigger', 'success', 'Started from Claude Code', t);
    addLog(run, t, 'system', `Pipeline started: /build-client ${client}`, 'trigger');
    return run;
  }

  const agentNode = /^(Task|Agent)$/.test(e.tool || '') && AGENT_NODE[e.agent];
  const checkNode = e.tool === 'Bash' && isCheckCmd(e.cmd);
  const pipelineish = agentNode || checkNode || e.ev === 'CheckStart';
  if (!run) {
    if (!pipelineish) return null;
    // Pipeline steps run by hand (e.g. "use the builder on acme") still get a run.
    run = newRun(client, 'manual', e.session);
    setNode(run, 'trigger', 'success', 'Started by hand', t);
  }
  run.lastAt = t;
  if (e.session && !run.session) run.session = e.session;

  // ---- agents ----
  if (agentNode && e.ev === 'PreToolUse') {
    let detail = e.desc || '';
    if (agentNode === 'build') {
      if (run.nodes.build.runs > 0) run.rounds++;
      detail = run.rounds ? `Fix round ${run.rounds}/${MAX_ROUNDS}` : 'First build';
    }
    setNode(run, agentNode, 'running', detail, t);
    addLog(run, t, 'step', `${e.agent} started${e.desc ? ': ' + e.desc : ''}`, agentNode);
  } else if (agentNode && /^PostToolUse/.test(e.ev)) {
    let status = e.failed ? 'fail' : 'success';
    let detail = run.nodes[agentNode].detail;
    if (agentNode === 'review' && e.result) { status = e.result === 'PASS' ? 'success' : 'fail'; detail = `${e.result}${e.score ? ' · ' + e.score : ''}`; }
    if (agentNode === 'research' && /already exists/i.test(e.text || '')) { status = 'skipped'; detail = 'Cached niche file'; }
    setNode(run, agentNode, status, detail, t);
    if (agentNode === 'review') run.nodes.review.report = e.text;
    if (agentNode === 'build') run.nodes.build.report = e.text;
    if (agentNode === 'research') run.nodes.research.report = e.text;
    addLog(run, t, status === 'fail' ? 'error' : 'ok', `${e.agent} ${status === 'fail' ? 'failed' : 'finished'}${detail ? ' · ' + detail : ''}`, agentNode);
  }

  // ---- check.js ----
  else if ((checkNode && e.ev === 'PreToolUse') || e.ev === 'CheckStart') {
    setNode(run, 'check', 'running', 'Running at 375 · 768 · 1440', t);
    addLog(run, t, 'step', 'check.js started', 'check');
  } else if ((checkNode && /^PostToolUse/.test(e.ev)) || e.ev === 'CheckEnd') {
    const pass = e.result === 'PASS';
    setNode(run, 'check', pass ? 'success' : 'fail', pass ? 'All widths pass' : e.result === 'FAIL' ? 'Issues found' : 'Script error', t);
    addLog(run, t, pass ? 'ok' : 'error', `check.js: ${e.result || 'error'}`, 'check');
  }

  // ---- edits ----
  else if (e.ev === 'PreToolUse' && /^(Edit|Write|MultiEdit)$/.test(e.tool || '') && e.file) {
    const rel = path.relative(path.join(PROJECTS, client), e.file).replace(/\\/g, '/');
    if (!rel.startsWith('..')) {
      if (!run.files.includes(rel)) run.files.push(rel);
      addLog(run, t, 'edit', `${e.tool === 'Write' ? 'wrote' : 'edited'} ${rel}`, run.nodes.build.status === 'running' ? 'build' : null);
    }
  }

  // ---- report.json changed on disk ----
  else if (e.ev === 'Report') {
    if (run.nodes.check.status === 'running' || run.nodes.check.status === 'idle') {
      setNode(run, 'check', e.pass ? 'success' : 'fail', e.pass ? 'All widths pass' : 'Issues found', t);
    }
  }

  // ---- output from runs the dashboard started ----
  else if (e.ev === 'Log') addLog(run, t, e.kind || 'out', e.text, e.node);

  // ---- end ----
  else if (e.ev === 'Stop' && run.session && e.session === run.session && run.mode !== 'check') finishRun(run, t, 'done');
  else if (e.ev === 'RunEnd') {
    if (e.text) addLog(run, t, e.how === 'error' ? 'error' : 'system', e.text);
    finishRun(run, t, e.how || 'done');
  }
  return run;
}

// ---------- tail the event log ----------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

let offset = 0;
let partial = '';
function readNew(live) {
  const size = fs.statSync(LOG).size;
  if (size < offset) offset = 0;
  if (size === offset) return;
  const fd = fs.openSync(LOG, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  const lines = (partial + buf.toString('utf8')).split('\n');
  partial = lines.pop();
  const touched = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const r = apply(JSON.parse(line)); if (r) touched.add(r); } catch { /* skip bad line */ }
  }
  if (live) for (const r of touched) broadcast('run', r);
}
readNew(false);
// Runs that were mid-flight when the server last died are not coming back.
for (const r of runs) if (r.status === 'running' && Date.now() - r.lastAt > 30 * 60000) finishRun(r, r.lastAt, 'stopped');
fs.watchFile(LOG, { interval: 250 }, () => readNew(true));

// ---------- projects on disk ----------
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function listProjects() {
  if (!fs.existsSync(PROJECTS)) return [];
  return fs.readdirSync(PROJECTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_template' && SLUG.test(d.name))
    .map((d) => projectSummary(d.name))
    .filter(Boolean);
}

function projectSummary(slug) {
  const dir = path.join(PROJECTS, slug);
  const pj = readJSON(path.join(dir, 'project.json'));
  if (!pj) return { slug, name: slug, missingProjectJson: true };
  const report = readJSON(path.join(dir, 'reports', 'report.json'));
  const reportsDir = path.join(dir, 'reports');
  const shots = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir).filter((f) => f.endsWith('.png')).sort() : [];
  const siteDir = path.join(dir, 'site');
  const hasSite = fs.existsSync(siteDir) && fs.readdirSync(siteDir).some((f) => !f.startsWith('.'));
  return {
    slug, name: pj.client || slug, niche: pj.niche, status: pj.status,
    nicheCached: !!pj.niche && fs.existsSync(path.join(NICHES, `${pj.niche}.md`)),
    hasSite,
    openBugs: (pj.bugs || []).filter((b) => b.status !== 'fixed').length,
    openQuestions: (pj.open_questions || []).length,
    history: (pj.history || []).slice(-15).reverse(),
    report: report && {
      pass: report.pass, checkedAt: report.checkedAt, links: report.links && { pass: report.links.pass, checked: report.links.checked, broken: report.links.broken.length },
      widths: Object.fromEntries(Object.entries(report.widths || {}).map(([w, v]) => [w, { pass: v.pass, issues: v.issues.map((i) => ({ type: i.type, page: new URL(i.page).pathname, count: i.count ?? 1 })) }])),
    },
    shots,
    running: !!procs[slug],
  };
}

// report.json and project.json changes → push fresh project data
const stamps = {};
setInterval(() => {
  let changed = false;
  for (const p of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) {
    if (p === '_template' || !SLUG.test(p)) continue;
    for (const f of ['project.json', 'reports/report.json']) {
      const file = path.join(PROJECTS, p, f);
      let m = 0;
      try { m = fs.statSync(file).mtimeMs; } catch {}
      const key = p + '/' + f;
      if (stamps[key] !== undefined && stamps[key] !== m) {
        changed = true;
        if (f.startsWith('reports') && m) {
          const r = readJSON(file);
          if (r && active[p]) emit({ ev: 'Report', client: p, pass: !!r.pass });
        }
      }
      stamps[key] = m;
    }
  }
  if (changed) broadcast('projects', listProjects());
}, 1000);

// ---------- starting and stopping runs ----------
const procs = {};

function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const base = path.join(process.env.APPDATA || '', 'Claude', 'claude-code');
  try {
    const versions = fs.readdirSync(base).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
    for (const v of versions) {
      for (const sub of fs.readdirSync(path.join(base, v))) {
        const exe = path.join(base, v, sub, process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch {}
  return 'claude';
}

const ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'Agent', 'WebSearch', 'WebFetch',
  'Bash(node checks/check.js:*)', 'Bash(npm run build:*)',
].join(',');

function lineStream(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (c) => {
    buf += c;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach((l) => l.trim() && onLine(l));
  });
  stream.on('end', () => buf.trim() && onLine(buf));
}

function startRun(slug, mode) {
  if (procs[slug]) throw new Error('Already running');
  if (!fs.existsSync(path.join(PROJECTS, slug, 'project.json'))) throw new Error('No project.json for this client');
  emit({ ev: 'RunStart', client: slug, mode });
  let child;
  if (mode === 'check') {
    emit({ ev: 'CheckStart', client: slug });
    child = spawn(process.execPath, [path.join(ROOT, 'checks', 'check.js'), path.join('projects', slug)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let result = null;
    const onLine = (l) => {
      const m = l.match(/Overall: (PASS|FAIL)/);
      if (m) result = m[1];
      emit({ ev: 'Log', client: slug, kind: /\[FAIL\]|^\s+- /.test(l) ? 'error' : /\[PASS\]/.test(l) ? 'ok' : 'out', text: l, node: 'check' });
    };
    lineStream(child.stdout, onLine);
    lineStream(child.stderr, onLine);
    child.on('exit', (code) => {
      delete procs[slug];
      if (child.stoppedByUser) return;
      emit({ ev: 'CheckEnd', client: slug, result: result || (code === 0 ? 'PASS' : null) });
      emit({ ev: 'RunEnd', client: slug, how: code === 2 ? 'error' : 'done' });
      broadcast('projects', listProjects());
    });
  } else {
    const args = ['-p', `/build-client ${slug}`, '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS];
    child = spawn(findClaude(), args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    lineStream(child.stdout, (l) => {
      let m;
      try { m = JSON.parse(l); } catch { return onErr(l); }
      if (m.type === 'assistant' && m.message && !m.parent_tool_use_id) {
        for (const c of m.message.content || []) {
          if (c.type === 'text' && c.text.trim()) emit({ ev: 'Log', client: slug, kind: 'claude', text: c.text.trim() });
        }
      } else if (m.type === 'result') {
        if (m.is_error) onErr(m.result || 'Run ended with an error');
        else emit({ ev: 'Log', client: slug, kind: 'claude', text: m.result || 'Done' });
      }
    });
    const onErr = (l) => {
      emit({ ev: 'Log', client: slug, kind: 'error', text: l });
      if (/authenticate|not logged in|login/i.test(l)) {
        emit({ ev: 'Log', client: slug, kind: 'system', text: 'Claude Code CLI is not signed in. Run it once in a terminal and use /login, or start the run from the Claude app with /build-client ' + slug + ' (the dashboard follows it live).' });
      }
    };
    lineStream(child.stderr, onErr);
    child.on('error', (err) => {
      delete procs[slug];
      emit({ ev: 'RunEnd', client: slug, how: 'error', text: `Could not start Claude Code: ${err.message}. Set CLAUDE_BIN to the claude executable.` });
    });
    child.on('exit', (code) => {
      delete procs[slug];
      if (child.stoppedByUser) return;
      emit({ ev: 'RunEnd', client: slug, how: code === 0 ? 'done' : 'error', text: code === 0 ? null : `Claude Code exited with code ${code}` });
      broadcast('projects', listProjects());
    });
  }
  procs[slug] = child;
}

function stopRun(slug) {
  const child = procs[slug];
  if (child) {
    child.stoppedByUser = true;
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else child.kill('SIGTERM');
    delete procs[slug];
  }
  emit({ ev: 'RunEnd', client: slug, how: 'stopped', text: 'Stopped from dashboard' });
}

function createProject(name) {
  const slug = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('Give the client a name');
  const dir = path.join(PROJECTS, slug);
  if (fs.existsSync(dir)) throw new Error(`projects/${slug} already exists`);
  fs.cpSync(path.join(PROJECTS, '_template'), dir, { recursive: true });
  const pj = readJSON(path.join(dir, 'project.json'));
  Object.assign(pj, { client: name.trim(), slug });
  pj.history = [{ at: new Date().toISOString(), by: 'dashboard', did: 'Created from template', files: ['project.json'] }];
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(pj, null, 2));
  return slug;
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: hello\ndata: {}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (p === '/api/state') return send(res, 200, { projects: listProjects(), runs, maxRounds: MAX_ROUNDS });
    if (p === '/api/projects' && req.method === 'POST') {
      const { name } = await body(req);
      const slug = createProject(name || '');
      broadcast('projects', listProjects());
      return send(res, 200, { slug });
    }
    let m;
    if ((m = p.match(/^\/api\/project\/([\w.-]+)$/))) {
      const dir = path.join(PROJECTS, m[1]);
      return send(res, 200, {
        project: readJSON(path.join(dir, 'project.json')),
        report: readJSON(path.join(dir, 'reports', 'report.json')),
      });
    }
    if ((m = p.match(/^\/api\/(run|stop)\/([\w.-]+)$/)) && req.method === 'POST') {
      const { mode } = await body(req);
      if (m[1] === 'run') startRun(m[2], mode === 'check' ? 'check' : 'pipeline');
      else stopRun(m[2]);
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/shots\/([\w.-]+)\/([\w.-]+\.png)$/))) {
      const file = path.join(PROJECTS, m[1], 'reports', m[2]);
      if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p);
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Pipeline dashboard: http://localhost:${PORT}`);
});
