# Changelog

## 0.4.0
- Reliability: Claude Code detection rewritten against the real `~/.claude` transcript
  format — titles from `custom-title.json` / `ai-title`, sub-agents from
  `<session>/subagents/*.meta.json` (survive `/clear`), correct background and
  finished/running/interrupted states.
- New `npm run diagnose` command: prints what each provider detects on the machine.
- English UI by default, French when VS Code runs in French (`vscode.l10n` +
  `package.nls*.json`); dates and relative times follow the VS Code locale.

## 0.3.0
- Multi-tool support: Claude Code, OpenAI Codex CLI and Gemini CLI, through a pluggable provider system.
- Graph view: filter by tool, tool badges, orchestrator colored by tool.
- Renamed to **Agents Viewer**; settings moved to the `agentViewer.*` namespace.

## 0.2.0
- Graph view: animated agent avatars and a per-session orchestrator → sub-agents org chart with live timers.
- Status bar item opens the graph view.

## 0.1.0
- First version: available agents tree, sessions and sub-agents tree, status bar indicator.
