# Contributing

Thanks for helping!

## Setup

```bash
npm install
npm test        # compile + smoke test
```

Press **F5** in VS Code to start an Extension Development Host with the extension loaded.

## Project layout

| Path | Role |
|---|---|
| `src/model.ts` | Shared types (`AgentDef`, `SessionInfo`, `Provider`…) and helpers. No `vscode` import. |
| `src/providers/*.ts` | One file per tool: Claude Code, Codex CLI, Gemini CLI |
| `src/providers/index.ts` | Provider registry; a failing provider never breaks the others |
| `src/extension.ts` | Tree views, status bar, file watchers |
| `src/graphPanel.ts` | Graph webview host (CSP, message handling) |
| `media/graph.js`, `media/graph.css` | Graph webview UI and avatar animations |
| `src/test/smoke.ts` | Smoke test on fake data folders |

## Adding a provider (Cursor, Aider, opencode, Copilot…)

1. Create `src/providers/<tool>.ts` exporting a function that returns a `Provider`.
2. Add its id to `ProviderId` / `PROVIDER_LABEL` in `src/model.ts` and register it in `src/providers/index.ts`.
3. Add its folders to the watcher list in `src/extension.ts`, its color in `media/graph.css` (`.ptag[data-p=…]`) and its hue in `media/graph.js` (`PROVIDER_HUE`).
4. Add fake data and assertions in `src/test/smoke.ts`.
5. Document paths and format in the README table.

Parse defensively: these formats are not public APIs. Skip malformed lines, never throw.

## Ground rules

- **Stay local and read-only.** No network calls, telemetry, child processes or new runtime dependencies.
- **Never read credentials** (`auth.json`, `.credentials.json`, `oauth_creds.json`, `.env`…).
- **Never inject data as HTML** in the webview: use `textContent`.
- **Redact** any real transcript sample you add to tests or issues.

## Pull requests

1. Open an issue first for anything bigger than a small fix.
2. Keep `npm test` green; CI runs it on every PR.
3. Add a line to `CHANGELOG.md`.
