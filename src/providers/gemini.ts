/**
 * Gemini CLI (Google)
 *  - agents : ~/.gemini/agents/*.md et <workspace>/.gemini/agents/*.md (frontmatter YAML)
 *  - sessions : ~/.gemini/tmp/<projet>/chats/session-*.json (ancien format, un document)
 *               ou session-*.jsonl (0.46+, journal : ligne de métadonnées puis mises à jour {$set…}).
 *    <projet> = hash SHA-256 du chemin du projet (ou, selon les versions, un nom lisible ;
 *    un fichier .project_root peut contenir le chemin réel).
 *  - sous-agents : pas encore exposés de façon fiable dans les fichiers → non affichés.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Provider, ProviderContext, SessionInfo,
  cached, cleanTitle, dedupeAgents, exists, expandHome, isHumanText, parseFrontmatter,
  readAgentDir, readDirSafe, statSafe,
} from '../model';

interface Parsed { title: string; model?: string; projectHash?: string; }

function textOf(c: unknown): string {
  if (typeof c === 'string') { return c; }
  if (Array.isArray(c)) { return c.map(x => (x && typeof x.text === 'string') ? x.text : '').join(' '); }
  if (c && typeof c === 'object' && Array.isArray((c as any).parts)) { return textOf((c as any).parts); }
  return '';
}

function digest(messages: any[], meta: any): Parsed {
  let title = '', model: string | undefined;
  for (const m of messages) {
    if (!m || typeof m !== 'object') { continue; }
    if (m.type === 'user' && !title) {
      const t = textOf(m.content);
      if (isHumanText(t)) { title = t; }
    }
    if (m.model) { model = m.model; }
  }
  return { title: cleanTitle(meta?.summary || title), model, projectHash: meta?.projectHash };
}

function parse(file: string): Parsed {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const doc = JSON.parse(raw);
    return digest(doc.messages ?? [], doc);
  }
  let meta: any = {};
  let messages: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) { continue; }
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.sessionId && !meta.sessionId) { meta = { ...e }; }
    if (e.$set) {
      if (Array.isArray(e.$set.messages)) { messages = e.$set.messages; }
      if (e.$set.summary) { meta.summary = e.$set.summary; }
    }
    if (e.$push?.messages) { messages.push(...[].concat(e.$push.messages)); }
    if (e.type && e.content !== undefined && !e.$set) { messages.push(e); }
  }
  return digest(messages, meta);
}

/** Retrouve le dossier de projet réel si possible. */
function projectRoot(projectDir: string): string | undefined {
  try { return fs.readFileSync(path.join(projectDir, '.project_root'), 'utf8').trim() || undefined; } catch { return undefined; }
}

export function geminiProvider(dirOverride?: string): Provider {
  const home = dirOverride?.trim() ? expandHome(dirOverride) : path.join(os.homedir(), '.gemini');

  return {
    id: 'gemini',
    home,
    isInstalled: () => exists(home),

    listAgents(ctx: ProviderContext) {
      const md = (text: string) => parseFrontmatter(text);
      return dedupeAgents([
        ...ctx.workspaceDirs.flatMap(d => readAgentDir(path.join(d, '.gemini', 'agents'), '.md', 'gemini', 'project', md)),
        ...readAgentDir(path.join(home, 'agents'), '.md', 'gemini', 'user', md),
      ]);
    },

    listSessions(ctx: ProviderContext) {
      const tmp = path.join(home, 'tmp');
      const wanted = new Map<string, string>(); // clé de dossier → chemin du workspace
      for (const w of ctx.workspaceDirs) {
        wanted.set(crypto.createHash('sha256').update(w).digest('hex'), w);
        wanted.set(path.basename(w), w);
      }
      const sessions: SessionInfo[] = [];
      for (const pd of readDirSafe(tmp)) {
        const projectDir = path.join(tmp, pd);
        const root = projectRoot(projectDir);
        const match = root && ctx.workspaceDirs.includes(root) ? root : wanted.get(pd);
        if (!ctx.scopeAll && !match) { continue; }
        const chats = path.join(projectDir, 'chats');
        for (const f of readDirSafe(chats)) {
          if (!f.startsWith('session-') || !(f.endsWith('.json') || f.endsWith('.jsonl'))) { continue; }
          const file = path.join(chats, f);
          const stat = statSafe(file);
          if (!stat || ctx.now - stat.mtimeMs > ctx.recentMs) { continue; }
          let p: Parsed;
          try { p = cached(file, stat, () => parse(file)); } catch { continue; }
          sessions.push({
            provider: 'gemini',
            sessionId: f.replace(/\.jsonl?$/, ''),
            file,
            project: match || root || pd,
            title: p.title,
            lastActivity: new Date(stat.mtimeMs),
            state: ctx.now - stat.mtimeMs < ctx.activeThresholdMs ? 'running' : 'idle',
            model: p.model,
            subAgents: [],
          });
        }
      }
      return sessions;
    },
  };
}
