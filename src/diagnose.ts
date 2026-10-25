/**
 * Diagnostic en ligne de commande : `npm run diagnose`.
 * Affiche ce que chaque fournisseur détecte sur cette machine (agents, sessions, états),
 * pour comparer avec ce qu'on voit dans Claude Code / Codex / Gemini.
 *
 * Lecture seule, local, aucune dépendance : réutilise les mêmes fournisseurs que l'extension.
 * Portée « tous les projets » et fenêtre élargie pour tout montrer.
 */
import { AgentDef, ProviderContext, SessionInfo } from './model';
import { ALL_PROVIDERS, buildProviders, collect } from './providers';

const hours = Number(process.env.DIAG_RECENT_HOURS || 72);
const now = Date.now();
const ctx: ProviderContext = {
  workspaceDirs: [],
  scopeAll: true,
  activeThresholdMs: 30_000,
  recentMs: hours * 3600_000,
  now,
};

const providers = buildProviders({ enabled: ALL_PROVIDERS, dirs: {} });
const ago = (d: Date) => {
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 60) { return `${s}s`; }
  if (s < 3600) { return `${Math.round(s / 60)}min`; }
  return `${Math.round(s / 3600)}h`;
};

console.log(`Agents Viewer — diagnostic (fenêtre : ${hours} h, tous les projets)\n`);

for (const p of providers) {
  const installed = p.isInstalled();
  console.log(`== ${p.id} ==  home=${p.home}  installé=${installed ? 'oui' : 'non'}`);
  if (!installed) { console.log(''); continue; }

  let agents: AgentDef[], sessions: SessionInfo[];
  try { agents = p.listAgents(ctx); } catch (e) { console.log('  listAgents a échoué :', e); agents = []; }
  try { sessions = p.listSessions(ctx); } catch (e) { console.log('  listSessions a échoué :', e); sessions = []; }

  const custom = agents.filter(a => a.source !== 'builtin');
  console.log(`  Agents : ${agents.length} (${custom.length} personnalisés, ${agents.length - custom.length} intégrés)`);
  for (const a of custom) {
    console.log(`    · ${a.name} [${a.source}]${a.model ? ' model=' + a.model : ''} — ${a.description.slice(0, 60)}`);
  }

  console.log(`  Sessions récentes : ${sessions.length}`);
  for (const s of sessions) {
    console.log(`    · [${s.state}] "${s.title.slice(0, 50)}"  model=${s.model || '?'}  maj il y a ${ago(s.lastActivity)}`);
    console.log(`        projet=${s.project}`);
    for (const r of s.subAgents) {
      console.log(`        └─ ${r.agentType} [${r.state}]${r.background ? ' (bg)' : ''}${r.description ? ' — ' + r.description.slice(0, 50) : ''}`);
    }
  }
  console.log('');
}

// Vue agrégée (comme l'extension), pour vérifier l'isolation des pannes et le tri.
const snap = collect(providers, ctx);
console.log(`Total agrégé : ${snap.providers.join(', ') || '(aucun fournisseur installé)'} — ${snap.agents.length} agents, ${snap.sessions.length} sessions.`);
