const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// e.g. "2026-10-22 09:45:14.337 [info] ccreq:7880ce31.copilotmd | success | gpt-6-luna | 2730ms | [panel/editAgent]"
const CCREQ = /^(\S+ \S+) \[\w+\] ccreq:(\S+)\.copilotmd \| (\w+) \| (\S+) \| (\d+)ms \| \[([^\]]+)\]/;

function parseLogLine(line) {
  const m = CCREQ.exec(line);
  return m && { time: m[1], id: m[2], status: m[3], model: m[4], ms: +m[5], location: m[6] };
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
    } catch { /* provider not ready */ }
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
    const meta = parseMeta((await readDoc(`ccreq:${r.id}.copilotmd`)) || '');
    out.appendLine(formatLine(r, meta));

    const model = meta.resolvedModel || r.model;
    const tok = (meta.prompt || 0) + (meta.completion || 0);
    totals.req++; totals.tokens += tok; totals.aic += meta.aic || 0;
    const t = (totals.byModel[model] ||= { req: 0, tokens: 0 });
    t.req++; t.tokens += tok;
    if (r.location.startsWith('panel/')) updateStatus(meta); else updateStatus({});

    if (cfg.get('showThinking')) {
      let thinking;
      try { thinking = findThinking(JSON.parse((await readDoc(`ccreq:${r.id}.json`)) || 'null')); } catch { /* not json */ }
      if (thinking) out.appendLine(thinking.trim().split(/\r?\n/).map((l) => `    💭 ${l}`).join('\n'));
    }
  };

  // Serialize so output stays in log order.
  let queue = Promise.resolve();
  let offset = 0;
  const read = () => {
    let size;
    try { size = fs.statSync(log).size; } catch { return; } // log not created yet
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fd = fs.openSync(log, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return; // wait for a full line
    offset += Buffer.byteLength(text.slice(0, lastNl + 1));
    for (const line of text.slice(0, lastNl).split(/\r?\n/)) {
      const r = parseLogLine(line);
      if (r) queue = queue.then(() => handle(r)).catch((e) => out.appendLine(`error: ${e}`));
    }
  };

  read();
  fs.watchFile(log, { interval: 1000 }, read);
  context.subscriptions.push(out, item,
    vscode.commands.registerCommand('copilotBrain.show', () => out.show(true)),
    { dispose: () => fs.unwatchFile(log, read) });
}

module.exports = { activate, deactivate() {}, parseLogLine, parseMeta, findThinking, formatLine };
