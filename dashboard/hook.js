#!/usr/bin/env node
/*
 * Claude Code hook → pipeline event log.
 *
 * Registered in .claude/settings.json for UserPromptSubmit, PreToolUse,
 * PostToolUse, PostToolUseFailure and Stop. Reads the hook payload from stdin,
 * keeps only what the dashboard needs, and appends one line to
 * .pipeline/events.jsonl. It never blocks Claude: always exits 0, prints nothing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, '.pipeline', 'events.jsonl');

// The final text a subagent wrote, read from the end of its transcript.
function lastAssistantText(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').reverse();
    for (const l of lines) {
      const m = JSON.parse(l);
      if (m.type !== 'assistant' || !m.message) continue;
      const t = (m.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (t) return t.slice(-4000);
    }
  } catch {}
  return undefined;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const h = JSON.parse(raw);
    const input = h.tool_input || {};
    const blob = JSON.stringify(input) + ' ' + (h.prompt || '');
    const client = (blob.match(/projects(?:\\\\|\/|\\)+([\w.-]+)/) || [])[1];
    const ev = {
      t: Date.now(),
      ev: h.hook_event_name,
      session: h.session_id,
      client: client && client !== '_template' ? client : undefined,
      tool: h.tool_name,
      agent: input.subagent_type,
      cmd: input.command ? String(input.command).slice(0, 300) : undefined,
      file: input.file_path,
      desc: input.description ? String(input.description).slice(0, 200) : undefined,
    };
    if (h.hook_event_name === 'UserPromptSubmit') {
      const m = String(h.prompt || '').match(/\/build-client\s+([\w.-]+)/);
      if (m) { ev.client = m[1]; ev.start = 'pipeline'; }
    }
    // Background agents: the Agent call returns at launch, the real end is SubagentStop.
    if (h.hook_event_name === 'SubagentStop') {
      ev.agentId = h.agent_id;
      ev.agent = h.agent_type;
      ev.text = lastAssistantText(h.agent_transcript_path);
      const verdict = (ev.text || '').match(/VERDICT:\s*(PASS|FAIL)/);
      const score = (ev.text || '').match(/SCORE:\s*(\d+\/\d+)/);
      if (verdict) ev.result = verdict[1];
      if (score) ev.score = score[1];
    }
    const resp = h.tool_response;
    if (resp && typeof resp === 'object' && (resp.isAsync || resp.status === 'async_launched')) {
      ev.async = true;
      ev.agentId = resp.agentId;
    }
    if (/^PostToolUse/.test(h.hook_event_name) && !ev.async) {
      const out = JSON.stringify(h.tool_response || h.error || '');
      const overall = out.match(/Overall: (PASS|FAIL)/);
      const verdict = out.match(/VERDICT:\s*(PASS|FAIL)/);
      if (overall) ev.result = overall[1];
      if (verdict) ev.result = verdict[1];
      if (h.hook_event_name === 'PostToolUseFailure') ev.failed = true;
      const score = out.match(/SCORE:\s*(\d+\/\d+)/);
      if (score) ev.score = score[1];
      // A short readable snippet of what came back (subagent replies, check summary).
      const text = typeof h.tool_response === 'string' ? h.tool_response
        : h.tool_response && (h.tool_response.stdout || (Array.isArray(h.tool_response.content)
          ? h.tool_response.content.map((c) => c.text || '').join('\n') : ''));
      if (text && (ev.agent || ev.result)) ev.text = String(text).slice(-4000);
    }
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(ev) + '\n');
  } catch {
    /* never break Claude over a dashboard */
  }
  process.exit(0);
});
