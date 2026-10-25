/**
 * Claude Code
 *  - agents : ~/.claude/agents/*.md et <workspace>/.claude/agents/*.md (frontmatter YAML)
 *  - sessions : ~/.claude/projects/<cwd-encodé>/<sessionId>.jsonl
 *  - titre : <sessionId>/custom-title.json {customTitle} > ligne type:"ai-title" {aiTitle}
 *            > premier message humain
 *  - sous-agents : <sessionId>/subagents/agent-*.meta.json (agentType, description,
 *    requestShape foreground/background, toolUseId, finished) + mtime du .jsonl voisin.
 *    À défaut (format ancien / autre install) : appels d'outil Task/Agent du transcript.
 *
 * Aucun de ces formats n'est une API publique : tout est lu de façon défensive.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentDef, Provider, ProviderContext, RunState, SessionInfo, SubAgentRun,
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

/** Appel d'outil Task/Agent repéré dans le transcript principal, indexé par son id. */
interface ToolCall {
  startedAt?: Date;
  endedAt?: Date;
  isError?: boolean;
  runInBackground: boolean;
  agentType?: string;
  description?: string;
}

interface Parsed { aiTitle?: string; firstUser?: string; cwd?: string; model?: string; toolCalls: Map<string, ToolCall>; }

function textOf(content: unknown): string {
  if (typeof content === 'string') { return content; }
  if (Array.isArray(content)) {
    return content.map(c => (c && c.type === 'text') ? String(c.text) : '').join(' ');
  }
  return '';
}

function parse(file: string): Parsed {
  const toolCalls = new Map<string, ToolCall>();
  let aiTitle: string | undefined, firstUser: string | undefined;
  let cwd: string | undefined, model: string | undefined;
  for (const e of readJsonl(file)) {
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) { aiTitle = e.aiTitle; }
    if (e.cwd && !cwd) { cwd = e.cwd; }
    if (e.isSidechain) { continue; }
    const ts = toDate(e.timestamp);
    const msg = e.message;
    if (e.type === 'assistant' && typeof e.requestedModel === 'string' && e.requestedModel !== '<synthetic>' && !model) {
      model = e.requestedModel;
    }
    if (!msg) { continue; }
    if (msg.model && msg.model !== '<synthetic>') { model = msg.model; }
    if (e.type === 'user' && !e.isMeta && !firstUser) {
      const t = textOf(msg.content);
      if (isHumanText(t)) { firstUser = t; }
    }
    if (!Array.isArray(msg.content)) { continue; }
    for (const c of msg.content) {
      if (c?.type === 'tool_use' && SUBAGENT_TOOLS.has(c.name)) {
        const input = c.input || {};
        toolCalls.set(c.id, {
          startedAt: ts,
          runInBackground: input.run_in_background === true,
          agentType: input.subagent_type,
          description: input.description || (typeof input.prompt === 'string' ? input.prompt.slice(0, 80) : ''),
        });
      } else if (c?.type === 'tool_result') {
        const call = toolCalls.get(c.tool_use_id);
        if (call) { call.endedAt = ts; call.isError = c.is_error === true; }
      }
    }
  }
  return { aiTitle, firstUser, cwd, model, toolCalls };
}

/** Titre explicitement fixé par l'utilisateur (<sessionId>/custom-title.json). */
function customTitle(sessionDir: string): string | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(sessionDir, 'custom-title.json'), 'utf8'));
    const t = o?.customTitle;
    return typeof t === 'string' && t.trim() ? t : undefined;
  } catch { return undefined; }
}

interface SubMeta { id: string; agentType: string; description: string; background: boolean; toolUseId?: string; finished: boolean; mtimeMs: number; }

/** Lit <sessionId>/subagents/agent-*.meta.json (chaque sous-agent lancé, même après /clear). */
function readSubagentMetas(sessionDir: string): SubMeta[] {
  const dir = path.join(sessionDir, 'subagents');
  const out: SubMeta[] = [];
  for (const f of readDirSafe(dir)) {
    if (!f.endsWith('.meta.json')) { continue; }
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const base = f.slice(0, -'.meta.json'.length);
      out.push({
        id: base,
        agentType: typeof m.agentType === 'string' ? m.agentType : 'general-purpose',
        description: typeof m.description === 'string' ? m.description : '',
        background: m.requestShape === 'background',
        toolUseId: typeof m.toolUseId === 'string' ? m.toolUseId : undefined,
        finished: m.finished === true,
        mtimeMs: statSafe(path.join(dir, base + '.jsonl'))?.mtimeMs ?? 0,
      });
    } catch { /* méta illisible */ }
  }
  return out;
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
          if (!stat) { continue; }
          const sessionDir = file.replace(/\.jsonl$/, '');
          const metas = readSubagentMetas(sessionDir);
          const subWrite = metas.reduce((m, s) => Math.max(m, s.mtimeMs), 0);
          const lastWrite = Math.max(stat.mtimeMs, subWrite);
          if (ctx.now - lastWrite > ctx.recentMs) { continue; }

          let p: Parsed;
          try { p = cached(file, stat, () => parse(file)); } catch { continue; }

          const sessFresh = ctx.now - stat.mtimeMs < ctx.activeThresholdMs;
          const fresh = ctx.now - lastWrite < ctx.activeThresholdMs;
          const isFresh = (m: number) => m > 0 && ctx.now - m < ctx.activeThresholdMs;

          let runs: SubAgentRun[];
          if (metas.length) {
            runs = metas.map(s => {
              const call = s.toolUseId ? p.toolCalls.get(s.toolUseId) : undefined;
              const background = s.background || call?.runInBackground === true;
              const jsonlFresh = isFresh(s.mtimeMs);
              let state: RunState;
              if (s.finished) { state = 'done'; }
              else if (!background && call?.endedAt) { state = call.isError ? 'error' : 'done'; }
              else if (jsonlFresh) { state = 'running'; }
              else { state = background ? 'interrupted' : 'done'; }
              return {
                id: s.toolUseId || s.id,
                agentType: s.agentType,
                description: (s.description || call?.description || '').replace(/\s+/g, ' ').slice(0, 120),
                startedAt: call?.startedAt,
                endedAt: state === 'running' ? undefined : (call?.endedAt ?? (s.mtimeMs ? new Date(s.mtimeMs) : undefined)),
                state, background,
              };
            }).sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
          } else {
            // Format ancien / autre installation : on se rabat sur les appels Task/Agent du transcript.
            runs = [...p.toolCalls.entries()].map(([id, call]) => {
              let state: RunState = 'running';
              if (call.endedAt) { state = call.isError ? 'error' : 'done'; }
              if (state === 'running' && !sessFresh) { state = 'interrupted'; }
              return {
                id,
                agentType: call.agentType || 'general-purpose',
                description: call.description || '',
                startedAt: call.startedAt,
                endedAt: state === 'running' ? undefined : call.endedAt,
                state, background: call.runInBackground,
              };
            });
          }

          sessions.push({
            provider: 'claude',
            sessionId: f.replace(/\.jsonl$/, ''),
            file,
            project: p.cwd || pd,
            title: cleanTitle(customTitle(sessionDir) || p.aiTitle || p.firstUser),
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
