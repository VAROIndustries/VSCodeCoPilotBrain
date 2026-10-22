# Copilot Brain

Output channel ("Copilot Brain") listing every Copilot Chat request in this window: resolved model (even in Auto), latency/TTFT, prompt/cached/completion/reasoning tokens, context fill %, reasoning effort, AIC cost, and thinking text when Copilot records it. Status bar shows session totals; click to open.

Works by tailing Copilot Chat's own log and opening its `ccreq:` debug documents, so a Copilot update can change the format.

Test: `node test.js`. Package: `npx @vscode/vsce package --allow-missing-repository`.
