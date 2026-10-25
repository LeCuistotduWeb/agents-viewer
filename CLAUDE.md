# Agents Viewer — notes for Claude Code

## What this is
VS Code extension (publisher `lecuistotduweb`, id `lecuistotduweb.agents-viewer`, repo github.com/LeCuistotduWeb/agents-viewer, MIT).
A **local, read-only supervision dashboard** for AI coding agents: catalogue of available agents, orchestrator → sub-agent hierarchy, live status. Supports Claude Code, OpenAI Codex CLI and Gemini CLI through pluggable "providers". Positioning: monitoring/dashboard, not a game; avatars are a way to read state at a glance.

## Stack & layout
- TypeScript, VS Code API ^1.85, **zero runtime dependencies**. Dev deps: typescript, @types/*, @vscode/vsce.
- `src/model.ts` — shared types (`AgentDef`, `SessionInfo`, `SubAgentRun`, `Provider`) and helpers. No `vscode` import (testable with plain Node).
- `src/providers/{claude,codex,gemini}.ts` — one file per tool; `src/providers/index.ts` registry (`collect()` isolates provider failures).
- `src/extension.ts` — tree views, status bar, file watchers, settings (`agentViewer.*`).
- `src/graphPanel.ts` — webview host (strict CSP, nonce, only opens transcripts already listed).
- `media/graph.js`, `media/graph.css` — webview UI, avatars (static SVG template) and animations.
- `src/test/smoke.ts` — smoke test on fake `~/.claude`, `~/.codex`, `~/.gemini`.

## Commands
- `npm install` · `npm test` (compile + smoke test) · `npm run compile` · `npm run package` (builds .vsix)
- F5 in VS Code = Extension Development Host (`.vscode/launch.json`).
- CI: `.github/workflows/ci.yml` runs test + package on push/PR; on tag `v*` attaches the .vsix to a GitHub Release.

## Non-negotiables (they are the product's promise, see README "Privacy & security")
- Read-only and local: no network, no telemetry, no `child_process`, no new runtime dependency.
- Never read credentials (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`, `.env`, settings files).
- Webview: never inject data as HTML (`textContent` only), keep the CSP strict.
- Transcript formats are not public APIs: parse defensively, skip malformed lines, never throw out of a provider.
- Never commit real transcript content. Test fixtures must be synthetic or fully redacted.
- Settings keys `agentViewer.*` and the extension id are public contracts: don't rename them.

## Conventions
- UI strings currently French; README/CHANGELOG/CONTRIBUTING in English.
- Every user-visible change gets a CHANGELOG line. Keep `npm test` green.
- Git identity for this repo: `lecuistotduweb` / GitHub noreply address (check `git config user.email` before committing).
