const assert = require('assert');
const Module = require('module');
const load = Module._load;
Module._load = (req, ...a) => (req === 'vscode' ? {} : load(req, ...a));
const { lastStartup, parseLogLine, parseMeta, findThinking, formatLine } = require('./extension');

const r = parseLogLine('2026-10-22 09:45:14.337 [info] ccreq:7880ce31.copilotmd | success | gpt-6-luna | 2730ms | [panel/editAgent]');
assert.deepStrictEqual(r, { time: '2026-10-22 09:45:14.337', id: '7880ce31', status: 'success', model: 'gpt-6-luna', ms: 2730, location: 'panel/editAgent' });
assert.strictEqual(parseLogLine('2026-10-22 09:45:15.071 [info] message 0 returned. finish reason: [stop]'), null);

const md = [
  '## Metadata', '<pre><code>',
  'model            : auto',
  'maxPromptTokens  : 128000',
  'reasoning        : {"effort":"high"}',
  'intent           : undefined',
  'timeToFirstToken : 812ms',
  'resolved model   : gpt-6-luna-2026-09',
  'usage            : {"prompt_tokens":64000,"completion_tokens":1234,"prompt_tokens_details":{"cached_tokens":30000},"completion_tokens_details":{"reasoning_tokens":512}}',
  'copilotUsage    : 0.12 AIC (120000000 nano-AIU)',
  '</code></pre>',
].join('\n');
const meta = parseMeta(md);
assert.strictEqual(meta.resolvedModel, 'gpt-6-luna-2026-09');
assert.strictEqual(meta.intent, undefined);
assert.strictEqual(meta.ttft, 812);
assert.strictEqual(meta.cached, 30000);
assert.strictEqual(meta.aic, 0.12);
assert.strictEqual(formatLine(r, meta),
  '09:45:14 ✓ gpt-6-luna-2026-09 | panel/editAgent | 2730ms ttft 812ms | in 64,000 (30,000 cached) out 1,234 (512 reasoning) | ctx 50% of 128k | effort high | 0.12 AIC');
// Missing doc degrades to the log-line data only.
assert.strictEqual(formatLine(r, parseMeta('')), '09:45:14 ✓ gpt-6-luna | panel/editAgent | 2730ms');

assert.strictEqual(findThinking({ a: [{ thinking: { text: ['step 1 ', 'step 2'] } }] }), 'step 1 step 2');
assert.strictEqual(findThinking({ a: 1 }), undefined);
assert.strictEqual(lastStartup(['a', '2026-10-20 [info] Copilot Chat: 0.69.0, VS Code', 'b', '2026-10-22 [info] Copilot Chat: 0.70.0, VS Code', 'c']), 3);
assert.strictEqual(lastStartup(['a', 'b']), 0);
const { cleanMd, sessionEvents, readNew } = require('./extension');
assert.strictEqual(cleanMd('Read [](file:///c%3A/Projects/CWE%20Midwest/Foo%20Bar.md), lines 1 to 5'), 'Read Foo Bar.md, lines 1 to 5');
assert.strictEqual(cleanMd('Searched for `a\\|b`'), 'Searched for `a|b`');

const st = {};
const tool = (id, complete, extra = {}) => ({ kind: 'toolInvocationSerialized', toolCallId: id, isComplete: complete, invocationMessage: { value: `Reading ${id}` }, pastTenseMessage: { value: `Read ${id}` }, ...extra });
assert.deepStrictEqual(sessionEvents(st, { kind: 2, k: ['requests'], v: [{ message: { text: 'fix the bug' } }] }), ['▶ fix the bug']);
assert.deepStrictEqual(sessionEvents(st, { kind: 2, k: ['requests', 3, 'response'], v: [tool('a', false), { kind: 'thinking', value: [] }] }), []);
// Splice re-sends 'a' now complete, plus a hidden tool and a new one.
assert.deepStrictEqual(sessionEvents(st, { kind: 2, k: ['requests', 3, 'response'], i: 0, v: [tool('a', true), tool('h', true, { presentation: 'hidden' }), tool('b', true)] }), ['    🔧 Read a', '    🔧 Read b']);
assert.deepStrictEqual(sessionEvents(st, { kind: 2, k: ['requests', 3, 'response'], i: 0, v: [tool('a', true), tool('b', true)] }), []);
sessionEvents(st, { kind: 1, k: ['requests', 3, 'promptTokens'], v: 114899 });
sessionEvents(st, { kind: 1, k: ['requests', 3, 'completionTokens'], v: 3319 });
sessionEvents(st, { kind: 1, k: ['requests', 3, 'copilotCredits'], v: 2.0931 });
sessionEvents(st, { kind: 1, k: ['requests', 3, 'elapsedMs'], v: 357648 });
sessionEvents(st, { kind: 1, k: ['requests', 3, 'promptTokenDetails'], v: [{ label: 'System Instructions', percentageOfPrompt: 16 }, { label: 'Messages', percentageOfPrompt: 28 }] });
assert.deepStrictEqual(sessionEvents(st, { kind: 1, k: ['requests', 3, 'modelState'], v: { value: 0 } }), []);
assert.deepStrictEqual(sessionEvents(st, { kind: 1, k: ['requests', 3, 'modelState'], v: { value: 1, completedAt: 1 } }),
  ['    ✔ turn done · 114,899 in · 3,319 out · 2.09 credits · 357.6s · ctx: System Instructions 16%, Messages 28%']);
assert.deepStrictEqual(sessionEvents(st, { kind: 1, k: ['requests', 3, 'modelState'], v: { value: 1, completedAt: 2 } }), []);

const { cliEvents } = require('./extension');
const cs = {};
const ts = '2026-10-22T15:31:11.000Z';
assert.deepStrictEqual(cliEvents(cs, { type: 'user.message', data: { content: 'what next?' } }), ['▶ what next?']);
assert.deepStrictEqual(cliEvents(cs, { type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-6-luna' } }), ['  🧭 Auto → gpt-6-luna']);
assert.deepStrictEqual(cliEvents(cs, { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'view', arguments: { path: 'C:\\x\\Plan.md' } } }), []);
assert.deepStrictEqual(cliEvents(cs, { type: 'tool.execution_start', data: { toolCallId: 'c2', toolName: 'grep', toolTitle: 'Search for retention', arguments: {} } }), []);
assert.deepStrictEqual(cliEvents(cs, { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true } }), ['    🔧 view C:\\x\\Plan.md']);
assert.deepStrictEqual(cliEvents(cs, { type: 'tool.execution_complete', data: { toolCallId: 'c2', success: false } }), ['    🔧 Search for retention ✗']);
assert.deepStrictEqual(cliEvents(cs, { type: 'tool.execution_complete', data: { toolCallId: 'c2', success: true } }), []); // unknown id
assert.deepStrictEqual(cliEvents(cs, { type: 'tool.execution_complete', data: { toolCallId: 'c3' } }, { tools: false }), []);
const usage = cliEvents(cs, { type: 'session.usage_record', timestamp: ts, data: { usage: { model: 'gpt-6-luna', inputTokens: 64000, cacheReadTokens: 30000, outputTokens: 1234, reasoningTokens: 512 } } });
assert.match(usage[0], /^\d\d:\d\d:\d\d ✓ gpt-6-luna \| cli \| in 64,000 \(30,000 cached\) out 1,234 \(512 reasoning\)$/);
assert.deepStrictEqual(cliEvents(cs, { type: 'assistant.message', data: { reasoningText: 'a\n\nb' } }), ['    💭 a', '    💭 b']);
assert.deepStrictEqual(cliEvents(cs, { type: 'assistant.message', data: { reasoningText: 'a' } }, { thinking: false }), []);
assert.deepStrictEqual(cliEvents(cs, { type: 'session.usage_checkpoint', data: { totalNanoAiu: 2.5e9, totalPremiumRequests: 3 } }), ['    ✔ session so far · 3 premium req · 2.50 AIC']);
assert.deepStrictEqual(cliEvents(cs, { type: 'session.usage_checkpoint', data: { totalNanoAiu: 2.5e9, totalPremiumRequests: 3 } }), []); // unchanged
assert.deepStrictEqual(cliEvents(cs, { type: 'subagent.completed', data: { agentDisplayName: 'Explore', model: 'gpt-5.3-codex', totalToolCalls: 4, totalTokens: 12000, durationMs: 8500 } }), ['    🤖 Explore (gpt-5.3-codex) · 4 tools · 12,000 tok · 8.5s']);

const tmp =require('path').join(require('os').tmpdir(), `brain-${process.pid}.jsonl`);
require('fs').writeFileSync(tmp, 'one\ntwo\npart');
const got = readNew(tmp, 0);
assert.deepStrictEqual(got, { offset: 8, lines: ['one', 'two'] });
assert.strictEqual(readNew(tmp, got.offset), null); // partial line waits
require('fs').unlinkSync(tmp);
console.log('ok');
