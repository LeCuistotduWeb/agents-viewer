/**
 * Codex CLI (OpenAI)
 *  - agents : ~/.codex/agents/*.toml et <workspace>/.codex/agents/*.toml (name, description, model)
 *             + agents intégrés default / worker / explorer
 *  - sessions : $CODEX_HOME/sessions/AAAA/MM/JJ/rollout-*.jsonl
 *    1re ligne session_meta { id, cwd, … } ; puis response_item / event_msg / turn_context.
 *  - sous-agents : sessions « enfants » dont session_meta référence le fil parent
 *    (parent_thread_id) ; à défaut, appels d'outil spawn_agent.
 *
 * Le format des rollouts n'est pas une API publique : tout est lu de façon défensive.
 */
import * as os from 'os';
import * as path from 'path';
import {
  AgentDef, Provider, ProviderContext, RunState, SessionInfo, SubAgentRun,
  cached, cleanTitle, dedupeAgents, exists, expandHome, isHumanText, parseTomlStrings,
  readAgentDir, readDirSafe, readJsonl, statSafe, toDate,
} from '../model';

const BUILTIN: AgentDef[] = [
  { provider: 'codex', name: 'default', description: 'Agent Codex par défaut.', source: 'builtin' },
  { provider: 'codex', name: 'worker', description: "Agent d'exécution pour les tâches déléguées.", source: 'builtin' },
  { provider: 'codex', name: 'explorer', description: 'Agent de lecture et d’exploration du code.', source: 'builtin' },
];
const SPAWN_TOOLS = new Set(['spawn_agent', 'spawn_agents', 'create_agent']);

interface Parsed {
  id?: string;
  cwd?: string;
  parentId?: string;
  role?: string;
  title: string;
  model?: string;
  busy: boolean;            // task_started sans task_complete
  aborted: boolean;
  startedAt?: Date;
  endedAt?: Date;
  spawns: SubAgentRun[];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') { return content; }
  if (Array.isArray(content)) { return content.map(c => (c && typeof c.text === 'string') ? c.text : '').join(' '); }
  return '';
}

function parse(file: string): Parsed {
  const p: Parsed = { title: '', busy: false, aborted: false, spawns: [] };
  const spawns = new Map<string, SubAgentRun>();
  let metaSeen = false;
  let userMsg = '';

  for (const e of readJsonl(file)) {
    const ts = toDate(e.timestamp);
    const pl = e.payload ?? {};
    if (!p.startedAt && ts) { p.startedAt = ts; }

    if (e.type === 'session_meta' && !metaSeen) {
      metaSeen = true;
      p.id = pl.id;
      p.cwd = pl.cwd;
      const sub = pl.source?.subagent ?? pl.source?.SubAgent;
      p.parentId = pl.parent_thread_id ?? sub?.parent_thread_id ?? sub?.thread_spawn?.parent_thread_id;
      p.role = pl.agent_role ?? pl.agent_type ?? pl.agent_nickname ?? sub?.thread_spawn?.agent_role;
      continue;
    }
    if (e.type === 'turn_context' && pl.model) { p.model = pl.model; continue; }

    if (e.type === 'event_msg') {
      if (pl.type === 'user_message' && !userMsg && typeof pl.message === 'string' && isHumanText(pl.message)) { userMsg = pl.message; }
      if (pl.type === 'task_started') { p.busy = true; p.aborted = false; }
      if (pl.type === 'task_complete') { p.busy = false; p.endedAt = ts; }
      if (pl.type === 'turn_aborted') { p.busy = false; p.aborted = true; p.endedAt = ts; }
      continue;
    }

    if (e.type === 'response_item') {
      if (pl.type === 'message' && pl.role === 'user' && !p.title) {
        const t = textOf(pl.content);
        if (isHumanText(t)) { p.title = t; }
      } else if (pl.type === 'function_call' && SPAWN_TOOLS.has(pl.name)) {
        let args: any = {};
        try { args = typeof pl.arguments === 'string' ? JSON.parse(pl.arguments) : (pl.arguments ?? {}); } catch { /* */ }
        const desc = args.message ?? args.task ?? args.prompt ?? args.description ?? '';
        spawns.set(pl.call_id, {
          id: pl.call_id,
          agentType: args.agent_type ?? args.agent_role ?? args.agent ?? args.role ?? 'worker',
          description: typeof desc === 'string' ? desc.replace(/\s+/g, ' ').slice(0, 80) : '',
          startedAt: ts, state: 'running', background: false,
        });
      } else if (pl.type === 'function_call_output') {
        const run = spawns.get(pl.call_id);
        if (run) { run.endedAt = ts; run.state = 'done'; }
      }
    }
  }
  p.title = cleanTitle(p.title || userMsg);
  p.spawns = [...spawns.values()];
  return p;
}

/** Dossiers AAAA/MM/JJ couvrant la fenêtre « récente » (heure locale et UTC, + 1 jour de marge). */
function recentDayDirs(sessionsDir: string, ctx: ProviderContext): string[] {
  const days = Math.ceil(ctx.recentMs / 86400000) + 1;
  const set = new Set<string>();
  for (let i = 0; i <= days; i++) {
    const d = new Date(ctx.now - i * 86400000);
    const pad = (n: number) => String(n).padStart(2, '0');
    set.add(path.join(sessionsDir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
    set.add(path.join(sessionsDir, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
  }
  return [...set];
}

function inWorkspace(cwd: string | undefined, ctx: ProviderContext): boolean {
  if (ctx.scopeAll) { return true; }
  if (!cwd) { return false; }
  const c = path.resolve(cwd);
  return ctx.workspaceDirs.some(w => c === path.resolve(w) || c.startsWith(path.resolve(w) + path.sep));
}

export function codexProvider(dirOverride?: string): Provider {
  const home = dirOverride?.trim()
    ? expandHome(dirOverride)
    : process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

  return {
    id: 'codex',
    home,
    isInstalled: () => exists(home),

    listAgents(ctx: ProviderContext) {
      const toml = (text: string) => parseTomlStrings(text, ['name', 'description', 'model']);
      return dedupeAgents([
        ...ctx.workspaceDirs.flatMap(d => readAgentDir(path.join(d, '.codex', 'agents'), '.toml', 'codex', 'project', toml)),
        ...readAgentDir(path.join(home, 'agents'), '.toml', 'codex', 'user', toml),
        ...BUILTIN,
      ]);
    },

    listSessions(ctx: ProviderContext) {
      type Row = { file: string; mtime: number; p: Parsed };
      const rows: Row[] = [];
      for (const dir of recentDayDirs(path.join(home, 'sessions'), ctx)) {
        for (const f of readDirSafe(dir)) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) { continue; }
          const file = path.join(dir, f);
          const stat = statSafe(file);
          if (!stat || ctx.now - stat.mtimeMs > ctx.recentMs) { continue; }
          try { rows.push({ file, mtime: stat.mtimeMs, p: cached(file, stat, () => parse(file)) }); } catch { /* */ }
        }
      }

      const fresh = (m: number) => ctx.now - m < ctx.activeThresholdMs;
      const children = new Map<string, Row[]>();
      for (const r of rows) {
        if (r.p.parentId) {
          const list = children.get(r.p.parentId) ?? [];
          list.push(r);
          children.set(r.p.parentId, list);
        }
      }

      const sessions: SessionInfo[] = [];
      for (const r of rows) {
        if (r.p.parentId || !inWorkspace(r.p.cwd, ctx)) { continue; }
        const sessionFresh = fresh(r.mtime);
        const kids = children.get(r.p.id ?? '') ?? [];

        let runs: SubAgentRun[];
        if (kids.length) {
          runs = kids.map(k => {
            let state: RunState;
            if (k.p.aborted) { state = 'interrupted'; }
            else if (fresh(k.mtime) && (k.p.busy || !k.p.endedAt)) { state = 'running'; }
            else if (k.p.busy) { state = 'interrupted'; }
            else { state = 'done'; }
            return {
              id: k.p.id ?? k.file, agentType: k.p.role || 'worker', description: k.p.title,
              startedAt: k.p.startedAt, endedAt: state === 'running' ? undefined : (k.p.endedAt ?? new Date(k.mtime)),
              state, background: false,
            };
          }).sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
        } else {
          runs = r.p.spawns.map(s => ({ ...s, state: s.state === 'running' && !sessionFresh ? 'interrupted' : s.state }));
        }

        const lastWrite = Math.max(r.mtime, ...kids.map(k => k.mtime));
        sessions.push({
          provider: 'codex',
          sessionId: r.p.id ?? path.basename(r.file, '.jsonl'),
          file: r.file,
          project: r.p.cwd ?? '?',
          title: r.p.title,
          lastActivity: new Date(lastWrite),
          state: fresh(lastWrite) || runs.some(x => x.state === 'running') ? 'running' : 'idle',
          model: r.p.model,
          subAgents: runs,
        });
      }
      return sessions;
    },
  };
}
