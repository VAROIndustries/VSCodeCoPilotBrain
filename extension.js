const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// e.g. "2026-10-22 09:45:14.337 [info] ccreq:7880ce31.copilotmd | success | gpt-6-luna | 2730ms | [panel/editAgent]"
const CCREQ = /^(\S+ \S+) \[\w+\] ccreq:(\S+)\.copilotmd \| (\w+) \| (\S+) \| (\d+)ms \| \[([^\]]+)\]/;

function parseLogLine(line) {
  const m = CCREQ.exec(line);
  return m && { time: m[1], id: m[2], status: m[3], model: m[4], ms: +m[5], location: m[6] };
}

// Index of Copilot Chat's most recent startup line ("[info] Copilot Chat: 0.70.0, VS Code: 1.142.0"), or 0.
function lastStartup(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (/\] Copilot Chat: \d/.test(lines[i])) return i;
  return 0;
}

// Pulls the "key : value" metadata block out of a ccreq:<id>.copilotmd document.
function parseMeta(md) {
  const get = (key) => {
    const m = new RegExp(`^${key}\\s*: (.*)$`, 'm').exec(md);
    return m && m[1] !== 'undefined' ? m[1].trim() : undefined;
  };
  const json = (s) => { try { return s && JSON.parse(s); } catch { return undefined; } };
  const usage = json(get('usage')) || {};
  const aic = /([\d.]+) AIC/.exec(get('copilotUsage') || '');
  return {
    resolvedModel: get('resolved model'),
    maxPromptTokens: +get('maxPromptTokens') || undefined,
    ttft: parseInt(get('timeToFirstToken')) || undefined,
    effort: (json(get('reasoning')) || {}).effort,
    intent: get('intent'),
    prompt: usage.prompt_tokens,
    cached: usage.prompt_tokens_details?.cached_tokens,
    completion: usage.completion_tokens,
    reasoning: usage.completion_tokens_details?.reasoning_tokens,
    aic: aic ? +aic[1] : undefined,
  };
}

// ponytail: the json shape isn't documented, so just look for any `thinking.text` anywhere in it.
function findThinking(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj.thinking?.text) return [].concat(obj.thinking.text).join('');
  for (const v of Object.values(obj)) {
    const t = findThinking(v);
    if (t) return t;
  }
}

const n = (x) => (x ?? 0).toLocaleString('en-US');
const k = (x) => (x >= 1000 ? `${Math.round(x / 1000)}k` : `${x}`);

function formatLine(r, meta) {
  const parts = [`${r.time.slice(11, 19)} ${r.status === 'success' ? '✓' : '✗ ' + r.status} ${meta.resolvedModel || r.model}`, r.location];
  parts.push(`${r.ms}ms` + (meta.ttft ? ` ttft ${meta.ttft}ms` : ''));
  if (meta.prompt !== undefined) {
    parts.push(`in ${n(meta.prompt)}` + (meta.cached ? ` (${n(meta.cached)} cached)` : '') +
      ` out ${n(meta.completion)}` + (meta.reasoning ? ` (${n(meta.reasoning)} reasoning)` : ''));
  }
  if (meta.prompt !== undefined && meta.maxPromptTokens) {
    parts.push(`ctx ${Math.round((100 * meta.prompt) / meta.maxPromptTokens)}% of ${k(meta.maxPromptTokens)}`);
  }
  if (meta.effort) parts.push(`effort ${meta.effort}`);
  if (meta.aic !== undefined) parts.push(`${meta.aic} AIC`);
  return parts.join(' | ');
}

async function readDoc(uri) {
  // The ccreq entry can lag the log line slightly; retry once.
  for (let i = 0; i < 2; i++) {
    try {
      const text = (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))).getText();
      if (text !== 'Request not found') return text;
      readDoc.lastError = text;
    } catch (e) { readDoc.lastError = String(e); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function activate(context) {
  // ponytail: no public API for Copilot's request log, so tail its log file and open the ccreq: docs it serves.
  // Breaks if Copilot changes the ccreq line or metadata format; current window only (ccreq docs are per window).
  const log = path.join(path.dirname(context.logUri.fsPath), 'GitHub.copilot-chat', 'GitHub Copilot Chat.log');
  const out = vscode.window.createOutputChannel('Copilot Brain', 'log');
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.command = 'copilotBrain.show';
  item.text = '$(pulse) Brain: —';
  item.tooltip = `Watching ${log}`;
  item.show();
  out.appendLine(`Watching ${log}`);

  let warned = false;
  const totals = { req: 0, tokens: 0, aic: 0, byModel: {} };
  const updateStatus = (meta) => {
    const ctx = meta.prompt !== undefined && meta.maxPromptTokens ? ` · ctx ${Math.round((100 * meta.prompt) / meta.maxPromptTokens)}%` : '';
    item.text = `$(pulse) ${totals.req} req · ${k(totals.tokens)} tok${ctx}`;
    item.tooltip = 'Copilot Brain (this window)\n' +
      Object.entries(totals.byModel).map(([m, t]) => `${m}: ${t.req} req, ${n(t.tokens)} tok`).join('\n') +
      (totals.aic ? `\nTotal: ${totals.aic.toFixed(2)} AIC` : '');
  };

  const handle = async (r) => {
    const cfg = vscode.workspace.getConfiguration('copilotBrain');
    if (!cfg.get('showBackground') && !r.location.startsWith('panel/')) return;
    const md = await readDoc(`ccreq:${r.id}.copilotmd`);
    const meta = parseMeta(md || '');
    out.appendLine(formatLine(r, meta));
    if (!md && !warned) { warned = true; out.appendLine(`    (no token details from ccreq:${r.id}: ${readDoc.lastError})`); }

    const model = meta.resolvedModel || r.model;
    const tok = (meta.prompt || 0) + (meta.completion || 0);
    totals.req++; totals.tokens += tok; totals.aic += meta.aic || 0;
    const t = (totals.byModel[model] ||= { req: 0, tokens: 0 });
    t.req++; t.tokens += tok;
    if (r.location.startsWith('panel/')) updateStatus(meta); else updateStatus({});

    if (md && cfg.get('showThinking')) {
      let thinking;
      try { thinking = findThinking(JSON.parse((await readDoc(`ccreq:${r.id}.json`)) || 'null')); } catch { /* not json */ }
      if (thinking) out.appendLine(thinking.trim().split(/\r?\n/).map((l) => `    💭 ${l}`).join('\n'));
    }
  };

  // Serialize so output stays in arrival order (log lines await ccreq docs).
  let queue = Promise.resolve();
  const emit = (fn) => { queue = queue.then(fn).catch((e) => out.appendLine(`error: ${e}`)); };

  let offset = 0;
  let first = true;
  const read = () => {
    const got = readNew(log, offset);
    if (!got) return;
    offset = got.offset;
    let lines = got.lines;
    if (first) {
      // The log spans the whole VS Code session, but Copilot only keeps request details since it last
      // activated, so skip everything before its latest startup line.
      first = false;
      lines = lines.slice(lastStartup(lines));
    }
    for (const line of lines) {
      const r = parseLogLine(line);
      if (r) emit(() => handle(r));
    }
  };
  read();
  const timer = setInterval(read, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Tool steps come from the chat session files VS Code keeps for this workspace.
  if (context.storageUri) {
    const dir = path.join(path.dirname(context.storageUri.fsPath), 'chatSessions');
    const files = {}; // file -> { offset, state }
    // Sessions that already exist start at EOF (they can be tens of MB); new ones are read from the start.
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files[f] = { offset: fs.statSync(path.join(dir, f)).size, state: {} };
    } catch { /* no chats in this workspace yet */ }
    const poll = () => {
      if (!vscode.workspace.getConfiguration('copilotBrain').get('showTools')) return;
      let names;
      try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return; }
      for (const f of names) {
        const s = (files[f] ||= { offset: 0, state: {} });
        const got = readNew(path.join(dir, f), s.offset);
        if (!got) continue;
        s.offset = got.offset;
        for (const line of got.lines) {
          let patch;
          try { patch = JSON.parse(line); } catch { continue; }
          for (const msg of sessionEvents(s.state, patch)) emit(() => out.appendLine(msg));
        }
      }
    };
    const sessionTimer = setInterval(poll, 1000);
    context.subscriptions.push({ dispose: () => clearInterval(sessionTimer) });
  }

  context.subscriptions.push(out, item,
    vscode.commands.registerCommand('copilotBrain.show', () => out.show(true)));
}

// Reads complete lines appended to `file` since byte `offset`. Returns null if nothing new.
function readNew(file, offset) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (size < offset) offset = 0; // truncated / rotated
  if (size === offset) return null;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  const lastNl = buf.lastIndexOf(10);
  if (lastNl < 0) return null; // wait for a full line
  return { offset: offset + lastNl + 1, lines: buf.toString('utf8', 0, lastNl).split(/\r?\n/).filter(Boolean) };
}

// "Read [](file:///c%3A/x/Foo.md), lines 1 to 5" -> "Read Foo.md, lines 1 to 5"
function cleanMd(s) {
  return s
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_, text, url) => text || decodeURIComponent(url.split('/').pop()))
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Applies one chat-session jsonl patch ({kind, k, v, i}) and returns lines to print.
// ponytail: undocumented VS Code format; kind 1 = set k to v, kind 2 = append/splice v into array k.
function sessionEvents(state, { kind, k, v }) {
  const out = [];
  if (!Array.isArray(k)) return out;
  if (kind === 2 && k.length === 1 && k[0] === 'requests') {
    for (const r of v) {
      const text = r?.message?.text;
      if (text) out.push(`▶ ${cleanMd(text).slice(0, 120)}`);
    }
    return out;
  }
  if (k[0] !== 'requests' || typeof k[1] !== 'number') return out;
  const req = ((state.reqs ||= {})[k[1]] ||= { tools: new Set() });
  const field = k[2];
  if (kind === 2 && field === 'response') {
    for (const p of v) {
      if (p?.kind !== 'toolInvocationSerialized' || !p.isComplete || p.presentation === 'hidden') continue;
      const id = p.toolCallId || JSON.stringify(p.invocationMessage);
      if (req.tools.has(id)) continue; // re-sent when the response is spliced
      req.tools.add(id);
      const msg = p.pastTenseMessage?.value || p.invocationMessage?.value || p.toolId;
      if (msg) out.push(`    🔧 ${cleanMd(msg)}`);
    }
  } else if (kind === 1) {
    if (['promptTokens', 'completionTokens', 'copilotCredits', 'elapsedMs', 'promptTokenDetails'].includes(field)) req[field] = v;
    if (field === 'modelState' && v?.completedAt && !req.done) {
      req.done = true;
      const parts = ['    ✔ turn done'];
      if (req.promptTokens !== undefined) parts.push(`${n(req.promptTokens)} in`, `${n(req.completionTokens)} out`);
      if (req.copilotCredits !== undefined) parts.push(`${req.copilotCredits.toFixed(2)} credits`);
      if (req.elapsedMs !== undefined) parts.push(`${(req.elapsedMs / 1000).toFixed(1)}s`);
      if (Array.isArray(req.promptTokenDetails)) {
        parts.push('ctx: ' + req.promptTokenDetails.map((d) => `${d.label} ${d.percentageOfPrompt}%`).join(', '));
      }
      out.push(parts.join(' · '));
    }
  }
  return out;
}

module.exports = { activate, deactivate() {}, lastStartup, parseLogLine, parseMeta, findThinking, formatLine, readNew, cleanMd, sessionEvents };
