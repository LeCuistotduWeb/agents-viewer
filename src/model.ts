/**
 * Types et utilitaires communs à tous les fournisseurs (Claude Code, Codex, Gemini CLI…).
 * Aucune dépendance à l'API vscode : testable avec Node seul.
 */
import * as fs from 'fs';
import * as os from 'os';

export type ProviderId = 'claude' | 'codex' | 'gemini';

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
};

export type AgentSource = 'builtin' | 'user' | 'project';

export interface AgentDef {
  provider: ProviderId;
  name: string;
  description: string;
  model?: string;
  tools?: string;
  source: AgentSource;
  file?: string;
}

export type RunState = 'running' | 'idle' | 'done' | 'error' | 'interrupted';

export interface SubAgentRun {
  id: string;
  agentType: string;
  description: string;
  startedAt?: Date;
  endedAt?: Date;
  state: RunState;
  background: boolean;
}

/** Consommation de tokens cumulée sur le fil principal d'une session (hors sous-agents). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  thinking: number;
}

export interface SessionInfo {
  provider: ProviderId;
  sessionId: string;
  file: string;
  project: string;
  title: string;
  lastActivity: Date;
  state: RunState;          // running | idle
  model?: string;
  usage?: TokenUsage;       // absent si le format ne l'expose pas (Gemini) ou si tout est à zéro
  subAgents: SubAgentRun[];
}

export interface ProviderContext {
  workspaceDirs: string[];  // dossiers ouverts dans VS Code
  scopeAll: boolean;        // true = sessions de tous les projets
  activeThresholdMs: number;
  recentMs: number;
  now: number;
}

export interface Provider {
  id: ProviderId;
  /** Dossier racine de l'outil (~/.claude, ~/.codex…). */
  home: string;
  isInstalled(): boolean;
  listAgents(ctx: ProviderContext): AgentDef[];
  listSessions(ctx: ProviderContext): SessionInfo[];
}

// ------------------------------------------------------------------ utilitaires

export function expandHome(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

export function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function readDirSafe(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

export function statSafe(p: string): fs.Stats | undefined {
  try { return fs.statSync(p); } catch { return undefined; }
}

export function cleanTitle(t: string | undefined, fallback = '(session sans titre)'): string {
  return (t || fallback).replace(/\s+/g, ' ').trim().slice(0, 120) || fallback;
}

/** Ignore les messages techniques injectés par les outils (<environment_context>, Caveat:…). */
export function isHumanText(t: string): boolean {
  const s = t.trim();
  return !!s && !s.startsWith('<') && !s.startsWith('Caveat:') && !s.startsWith('# AGENTS.md');
}

export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) { return out; }
  let key: string | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].trim().replace(/^["']|["']$/g, '');
    } else if (key && /^\s+/.test(line)) {
      out[key] = (out[key] + ' ' + line.trim().replace(/^-\s*/, '')).trim();
    }
  }
  return out;
}

/** Lecture minimale de clés TOML de premier niveau (chaînes simples ou triple-guillemets). */
export function parseTomlStrings(text: string, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const triple = new RegExp(`^${k}\\s*=\\s*"""([\\s\\S]*?)"""`, 'm').exec(text);
    const single = new RegExp(`^${k}\\s*=\\s*["']([^"'\\n]*)["']`, 'm').exec(text);
    const v = triple?.[1] ?? single?.[1];
    if (v !== undefined) { out[k] = v.trim(); }
  }
  return out;
}

/** Cache par fichier, invalidé par mtime + taille : on ne reparse que ce qui a changé. */
const cache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();
export function cached<T>(file: string, stat: fs.Stats, parse: () => T): T {
  const c = cache.get(file);
  if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) { return c.value as T; }
  const value = parse();
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/** Lit un JSONL en ignorant les lignes corrompues ou en cours d'écriture. */
export function readJsonl(file: string): any[] {
  const out: any[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) { continue; }
    try { out.push(JSON.parse(line)); } catch { /* ligne partielle */ }
  }
  return out;
}

/** Nombre fini ≥ 0, sinon 0 (les champs d'usage sont parsés défensivement). */
export function toCount(v: unknown): number {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

/** Abrège un nombre de tokens : 320 → "320", 1858 → "1.9k", 103659 → "104k", 1_200_000 → "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) { return String(n); }
  if (n < 1_000_000) { return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k'; }
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** Vrai si au moins un compteur est non nul (sinon on n'affiche pas d'usage). */
export function hasUsage(u: TokenUsage): boolean {
  return u.input + u.output + u.cacheRead + u.cacheCreate + u.thinking > 0;
}

export function toDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') { return undefined; }
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

export function dedupeAgents(agents: AgentDef[]): AgentDef[] {
  const seen = new Set<string>();
  return agents.filter(a => {
    const k = a.provider + ':' + a.name;
    if (seen.has(k)) { return false; }
    seen.add(k);
    return true;
  });
}

export function readAgentDir(dir: string, ext: string, provider: ProviderId, source: AgentSource,
  parse: (text: string, file: string) => Partial<AgentDef>): AgentDef[] {
  const out: AgentDef[] = [];
  for (const f of readDirSafe(dir)) {
    if (!f.endsWith(ext)) { continue; }
    const file = require('path').join(dir, f) as string;
    try {
      const p = parse(fs.readFileSync(file, 'utf8'), file);
      out.push({ provider, source, file, name: p.name || f.slice(0, -ext.length), description: p.description || '', model: p.model, tools: p.tools });
    } catch { /* fichier illisible */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
