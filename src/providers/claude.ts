/**
 * Claude Code
 *  - agents : ~/.claude/agents/*.md et <workspace>/.claude/agents/*.md (frontmatter YAML)
 *  - sessions : ~/.claude/projects/<cwd-encodé>/<sessionId>.jsonl
 *  - sous-agents : appels d'outil Task/Agent ; transcripts dans <sessionId>/subagents/*.jsonl
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentDef, Provider, ProviderContext, SessionInfo, SubAgentRun,
  cached, cleanTitle, dedupeAgents, exists, expandHome, isHumanText, parseFrontmatter,
  readAgentDir, readDirSafe, readJsonl, statSafe, toDate,
} from '../model';

const BUILTIN: AgentDef[] = [
  { provider: 'claude', name: 'general-purpose', description: 'Agent polyvalent pour les tâches multi-étapes et la recherche.', source: 'builtin' },
  { provider: 'claude', name: 'Explore', description: 'Agent de recherche en lecture seule dans le code.', source: 'builtin' },
  { provider: 'claude', name: 'Plan', description: "Agent d'architecture qui prépare des plans d'implémentation.", source: 'builtin' },
  { provider: 'claude', name: 'statusline-setup', description: 'Configure la status line de Claude Code.', source: 'builtin' },
];
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

export function encodeClaudeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

interface Parsed { title: string; cwd?: string; model?: string; runs: SubAgentRun[]; }

function textOf(content: unknown): string {
  if (typeof content === 'string') { return content; }
  if (Array.isArray(content)) {
    return content.map(c => (c && c.type === 'text') ? String(c.text) : '').join(' ');
  }
  return '';
}

function parse(file: string): Parsed {
  const runs = new Map<string, SubAgentRun>();
  let title = '', summary = '', cwd: string | undefined, model: string | undefined;
  for (const e of readJsonl(file)) {
    if (e.type === 'summary' && e.summary) { summary = String(e.summary); }
    if (e.cwd && !cwd) { cwd = e.cwd; }
    if (e.isSidechain) { continue; }
    const ts = toDate(e.timestamp);
    const msg = e.message;
    if (!msg) { continue; }
    if (msg.model && msg.model !== '<synthetic>') { model = msg.model; }
    if (e.type === 'user' && !title) {
      const t = textOf(msg.content);
      if (isHumanText(t)) { title = t; }
    }
    if (!Array.isArray(msg.content)) { continue; }
    for (const c of msg.content) {
      if (c?.type === 'tool_use' && SUBAGENT_TOOLS.has(c.name)) {
        const input = c.input || {};
        runs.set(c.id, {
          id: c.id,
          agentType: input.subagent_type || 'general-purpose',
          description: input.description || (typeof input.prompt === 'string' ? input.prompt.slice(0, 80) : ''),
          startedAt: ts, state: 'running', background: input.run_in_background === true,
        });
      } else if (c?.type === 'tool_result') {
        const run = runs.get(c.tool_use_id);
        if (run) { run.endedAt = ts; run.state = c.is_error ? 'error' : 'done'; }
      }
    }
  }
  return { title: cleanTitle(summary || title), cwd, model, runs: [...runs.values()] };
}

function latestSubagentWrite(sessionFile: string): number {
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  let latest = 0;
  for (const f of readDirSafe(dir)) {
    if (f.endsWith('.jsonl')) { latest = Math.max(latest, statSafe(path.join(dir, f))?.mtimeMs ?? 0); }
  }
  return latest;
}

export function claudeProvider(dirOverride?: string): Provider {
  const home = dirOverride?.trim()
    ? expandHome(dirOverride)
    : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

  return {
    id: 'claude',
    home,
    isInstalled: () => exists(home),

    listAgents(ctx: ProviderContext) {
      const md = (text: string) => parseFrontmatter(text);
      return dedupeAgents([
        ...ctx.workspaceDirs.flatMap(d => readAgentDir(path.join(d, '.claude', 'agents'), '.md', 'claude', 'project', md)),
        ...readAgentDir(path.join(home, 'agents'), '.md', 'claude', 'user', md),
        ...BUILTIN,
      ]);
    },

    listSessions(ctx: ProviderContext) {
      const projectsDir = path.join(home, 'projects');
      let dirs = readDirSafe(projectsDir);
      if (!ctx.scopeAll) {
        const wanted = new Set(ctx.workspaceDirs.map(encodeClaudeProjectPath));
        dirs = dirs.filter(d => wanted.has(d));
      }
      const sessions: SessionInfo[] = [];
      for (const pd of dirs) {
        const dir = path.join(projectsDir, pd);
        for (const f of readDirSafe(dir)) {
          if (!f.endsWith('.jsonl')) { continue; }
          const file = path.join(dir, f);
          const stat = statSafe(file);
          if (!stat || ctx.now - stat.mtimeMs > ctx.recentMs) { continue; }
          let p: Parsed;
          try { p = cached(file, stat, () => parse(file)); } catch { continue; }

          const subWrite = latestSubagentWrite(file);
          const lastWrite = Math.max(stat.mtimeMs, subWrite);
          const fresh = ctx.now - lastWrite < ctx.activeThresholdMs;
          const subFresh = subWrite > 0 && ctx.now - subWrite < ctx.activeThresholdMs;
          const runs = p.runs.map(r => {
            const run = { ...r };
            if (run.state === 'running' && !fresh) { run.state = 'interrupted'; }
            if (run.background && run.state === 'done' && subFresh) { run.state = 'running'; }
            return run;
          });
          sessions.push({
            provider: 'claude',
            sessionId: f.replace(/\.jsonl$/, ''),
            file,
            project: p.cwd || pd,
            title: p.title,
            lastActivity: new Date(lastWrite),
            state: fresh || runs.some(r => r.state === 'running') ? 'running' : 'idle',
            model: p.model,
            subAgents: runs,
          });
        }
      }
      return sessions;
    },
  };
}
