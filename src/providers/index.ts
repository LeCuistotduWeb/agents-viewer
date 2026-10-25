import { AgentDef, Provider, ProviderContext, ProviderId, SessionInfo } from '../model';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
import { geminiProvider } from './gemini';

export interface ProviderSettings {
  enabled: ProviderId[];
  dirs: Partial<Record<ProviderId, string>>;
}

export const ALL_PROVIDERS: ProviderId[] = ['claude', 'codex', 'gemini'];

export function buildProviders(s: ProviderSettings): Provider[] {
  const make: Record<ProviderId, (dir?: string) => Provider> = {
    claude: claudeProvider, codex: codexProvider, gemini: geminiProvider,
  };
  return s.enabled.filter(id => make[id]).map(id => make[id](s.dirs[id]));
}

export interface Snapshot {
  providers: ProviderId[];   // fournisseurs installés sur la machine
  agents: AgentDef[];
  sessions: SessionInfo[];
}

/** Un fournisseur en panne (format inattendu…) ne doit jamais casser les autres. */
export function collect(providers: Provider[], ctx: ProviderContext): Snapshot {
  const installed = providers.filter(p => p.isInstalled());
  const agents: AgentDef[] = [];
  const sessions: SessionInfo[] = [];
  for (const p of installed) {
    try { agents.push(...p.listAgents(ctx)); } catch (e) { console.warn(`[agent-viewer] ${p.id} agents`, e); }
    try { sessions.push(...p.listSessions(ctx)); } catch (e) { console.warn(`[agent-viewer] ${p.id} sessions`, e); }
  }
  sessions.sort((a, b) => {
    if (a.state !== b.state) { return a.state === 'running' ? -1 : 1; }
    return b.lastActivity.getTime() - a.lastActivity.getTime();
  });
  return { providers: installed.map(p => p.id), agents, sessions };
}
