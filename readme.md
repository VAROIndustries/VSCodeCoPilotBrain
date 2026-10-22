# Copilot Brain

An Output channel that shows what GitHub Copilot is actually doing — the model it picked, the tokens it spent, the tools it ran, and its thinking, line by line as it works.

```
▶ check whether the retention jobs config is wired up
  🧭 Auto → gpt-6-luna
    💭 The config lives in the solution scripts. Checking the deploy module first.
    🔧 view C:\Projects\CWE\solution\scripts\New-RetentionJobs.ps1
    🔧 Search for retentionconfigs|asyncoperations
    🔧 bash -lc "git log --oneline -5"
    🤖 Explore (gpt-5.3-codex) · 4 tools · 12,000 tok · 8.5s
11:31:11 ✓ gpt-6-luna | cli | in 64,000 (30,000 cached) out 1,234 (512 reasoning)
    ✔ session so far · 3 premium req · 2.09 AIC
```

- **Which model really answered.** Auto mode picks for you and doesn't say which; this does, including the routing decision.
- **Tokens per request** — input, cached, output and reasoning — and how full the context window is.
- **Cost as it accrues:** premium requests and AI credits for the session.
- **Every agent step** as it finishes, named the same way the Chat panel names it, marked `✗` when it fails.
- **Thinking**, when the backend records it in readable form.
- **Status bar:** running request and token count for the window; click it to open the channel. Hover for a per-model breakdown.

## Install

1. Download `copilot-brain-*.vsix` from [Releases](https://github.com/VAROIndustries/VSCodeCoPilotBrain/releases).
2. `code --install-extension copilot-brain-0.0.4.vsix` (or Extensions view → `...` → *Install from VSIX...*).
3. Reload the window, then use Copilot Chat. Output panel → **Copilot Brain**.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `copilotBrain.showThinking` | `true` | Print the model's thinking under each request. |
| `copilotBrain.showTools` | `true` | Print each agent step and the per-turn summary. |
| `copilotBrain.showBackground` | `true` | Include Copilot's own background requests (titles, todo agent), not just your chat turns. |

## How it works

Copilot doesn't offer an API for any of this, and one extension can't read another's Output channel — so Copilot Brain reads the three places Copilot writes to on disk, because which one is live depends on the backend behind your chat:

| Source | What it gives |
|---|---|
| `GitHub Copilot Chat.log` + its `ccreq:` debug documents | Per-request model, latency, tokens, context limit, AI credits |
| `workspaceStorage/<id>/chatSessions/*.jsonl` | Tool steps and per-turn totals for Chat-extension sessions |
| `~/.copilot/session-state/<id>/events.jsonl` | Everything above *plus readable thinking*, for chats running on the agent host (Copilot CLI) |

The agent-host pane — the one with *Agent / Auto / Intelligence* along the bottom — writes to none of the first two. That's why a window can look idle while a chat is clearly working.

Nothing is sent anywhere. It only reads files Copilot already writes, and only appends to an Output channel.

## Caveats

- **Unofficial.** None of these formats are documented or promised. A Copilot update can change one, and then its lines stop appearing. The other sources keep working.
- **Per window** for the Chat-extension sources; the agent-host source shows every Copilot CLI session on the machine.
- **Existing chats start from the reload** — only new activity is shown.
- **Thinking isn't always readable.** Some backends store it encrypted or empty; those turns simply have no 💭 lines.

## Develop

Plain JavaScript, no dependencies, no build step. `node test.js` runs the self-check. `npx @vscode/vsce package` builds the `.vsix`.

## License

MIT
