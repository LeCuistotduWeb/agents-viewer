// Test de fumée : fabrique de faux dossiers ~/.claude, ~/.codex, ~/.gemini et vérifie la détection.
import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderContext } from '../model';
import { buildProviders, collect } from '../providers';
import { encodeClaudeProjectPath } from '../providers/claude';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));
const ws = path.join(root, 'mon-projet');
const dirs = { claude: path.join(root, '.claude'), codex: path.join(root, '.codex'), gemini: path.join(root, '.gemini') };
const now = Date.now();
const t = (s: number) => new Date(now - s * 1000).toISOString();
const jl = (...o: object[]) => o.map(x => JSON.stringify(x)).join('\n') + '\n';
const write = (f: string, c: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const age = (f: string, s: number) => fs.utimesSync(f, new Date(now - s * 1000), new Date(now - s * 1000));

// ------------------------------------------------ Claude Code
write(path.join(dirs.claude, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Relit le code\nmodel: sonnet\n---\n');
write(path.join(ws, '.claude', 'agents', 'tester.md'), '---\nname: tester\ndescription: Écrit les tests\n---\n');
const cproj = path.join(dirs.claude, 'projects', encodeClaudeProjectPath(ws));
write(path.join(cproj, 'aaa.jsonl'), jl(
  { type: 'user', cwd: ws, timestamp: t(60), message: { role: 'user', content: 'Refactor le module de paiement' } },
  { type: 'assistant', timestamp: t(50), message: { model: 'claude-opus-5-5', content: [
    { type: 'tool_use', id: 'tu1', name: 'Task', input: { subagent_type: 'Explore', description: 'Cartographier' } },
    { type: 'tool_use', id: 'tu2', name: 'Agent', input: { subagent_type: 'reviewer', description: 'Relire' } },
  ] } },
  { type: 'user', timestamp: t(20), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
));
const cold = path.join(cproj, 'bbb.jsonl');
write(cold, jl(
  { type: 'user', cwd: ws, timestamp: t(3600), message: { content: 'Ancienne tâche' } },
  { type: 'assistant', timestamp: t(3590), message: { content: [{ type: 'tool_use', id: 'x', name: 'Task', input: { subagent_type: 'Plan' } }] } },
));
age(cold, 3600);
// Titre explicite fixé par l'utilisateur : <sessionId>/custom-title.json gagne sur tout le reste.
write(path.join(cproj, 'bbb', 'custom-title.json'), JSON.stringify({ customTitle: 'Titre perso' }));

// Format réel récent : titre via ai-title, modèle via requestedModel, sous-agents via subagents/*.meta.json.
const ccc = path.join(cproj, 'ccc.jsonl');
write(ccc, jl(
  { type: 'user', cwd: ws, timestamp: t(40), isMeta: true, message: { content: '<command-name>/clear</command-name>' } },
  { type: 'user', cwd: ws, timestamp: t(38), message: { content: 'Question initiale de la session' } },
  { type: 'ai-title', aiTitle: 'Titre généré par IA' },
  { type: 'assistant', requestedModel: 'claude-opus-5-5', timestamp: t(35), message: { model: 'claude-opus-5-5', content: [
    { type: 'tool_use', id: 'toolu_bg1', name: 'Agent', input: { subagent_type: 'reviewer' } },
    { type: 'tool_use', id: 'toolu_bg2', name: 'Agent', input: { subagent_type: 'backend' } },
  ] } },
));
// Sous-agents : un background terminé, un background encore actif, un background interrompu, un foreground terminé.
const subDir = path.join(cproj, 'ccc', 'subagents');
const sub = (name: string, meta: object, ageS: number) => {
  write(path.join(subDir, name + '.meta.json'), JSON.stringify(meta));
  write(path.join(subDir, name + '.jsonl'), jl({ type: 'assistant', timestamp: t(ageS) }));
  age(path.join(subDir, name + '.jsonl'), ageS);
};
sub('agent-bg1', { agentType: 'reviewer', description: 'Relire le code', requestShape: 'background', toolUseId: 'toolu_bg1', finished: true }, 3600);
sub('agent-bg2', { agentType: 'backend', description: 'Implémenter', requestShape: 'background', toolUseId: 'toolu_bg2' }, 2);
sub('agent-bg3', { agentType: 'worker', requestShape: 'background' }, 3600);
sub('agent-fg1', { agentType: 'general-purpose', requestShape: 'foreground' }, 3600);

// ------------------------------------------------ Codex CLI
write(path.join(dirs.codex, 'agents', 'security.toml'), 'name = "security"\ndescription = """Audite la sécurité"""\nmodel = "gpt-5.5"\ndeveloper_instructions = "..."\n');
const d = new Date(now);
const day = path.join(dirs.codex, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
write(path.join(day, 'rollout-2026-10-25T10-00-00-p1.jsonl'), jl(
  { timestamp: t(90), type: 'session_meta', payload: { id: 'p1', cwd: ws } },
  { timestamp: t(89), type: 'turn_context', payload: { model: 'gpt-5.5-codex' } },
  { timestamp: t(89), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] } },
  { timestamp: t(88), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Migrer la base vers Postgres' }] } },
  { timestamp: t(87), type: 'event_msg', payload: { type: 'task_started' } },
  { timestamp: t(80), type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'c1', arguments: '{"agent_type":"explorer","message":"Lister les requêtes SQL"}' } },
  { timestamp: t(79), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: [] } },
));
write(path.join(day, 'rollout-2026-10-25T10-01-00-k1.jsonl'), jl(
  { timestamp: t(78), type: 'session_meta', payload: { id: 'k1', cwd: ws, source: { subagent: { thread_spawn: { parent_thread_id: 'p1', agent_role: 'explorer' } } } } },
  { timestamp: t(78), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Lister les requêtes SQL' }] } },
  { timestamp: t(77), type: 'event_msg', payload: { type: 'task_started' } },
));
const k2 = path.join(day, 'rollout-2026-10-25T10-01-30-k2.jsonl');
write(k2, jl(
  { timestamp: t(75), type: 'session_meta', payload: { id: 'k2', cwd: ws, parent_thread_id: 'p1', agent_role: 'security' } },
  { timestamp: t(75), type: 'event_msg', payload: { type: 'user_message', message: 'Auditer les migrations' } },
  { timestamp: t(74), type: 'event_msg', payload: { type: 'task_started' } },
  { timestamp: t(60), type: 'event_msg', payload: { type: 'task_complete' } },
));
age(k2, 60);

// ------------------------------------------------ Gemini CLI
const ghash = crypto.createHash('sha256').update(ws).digest('hex');
write(path.join(dirs.gemini, 'agents', 'docs.md'), '---\nname: docs-writer\ndescription: Rédige la doc\n---\n');
write(path.join(dirs.gemini, 'tmp', ghash, 'chats', 'session-2026-10-25-g1.jsonl'), jl(
  { sessionId: 'g1', projectHash: ghash, startTime: t(30), kind: 'main' },
  { $set: { messages: [{ type: 'user', content: [{ text: 'Écrire le guide d’installation' }] }, { type: 'gemini', content: 'ok', model: 'gemini-3-pro' }] } },
));
const gold = path.join(dirs.gemini, 'tmp', ghash, 'chats', 'session-2026-10-24-g0.json');
write(gold, JSON.stringify({ sessionId: 'g0', projectHash: ghash, messages: [{ type: 'user', content: 'Ancienne question' }] }));
age(gold, 7200);

// ------------------------------------------------ vérifications
const ctx: ProviderContext = { workspaceDirs: [ws], scopeAll: false, activeThresholdMs: 30000, recentMs: 86400e3, now };
const snap = collect(buildProviders({ enabled: ['claude', 'codex', 'gemini'], dirs }), ctx);

assert.deepStrictEqual(snap.providers, ['claude', 'codex', 'gemini']);
const names = (p: string) => snap.agents.filter(a => a.provider === p && a.source !== 'builtin').map(a => a.name);
assert.deepStrictEqual(names('claude'), ['tester', 'reviewer']);
assert.deepStrictEqual(names('codex'), ['security']);
assert.strictEqual(snap.agents.find(a => a.name === 'security')!.description, 'Audite la sécurité');
assert.deepStrictEqual(names('gemini'), ['docs-writer']);

const by = (p: string) => snap.sessions.filter(s => s.provider === p);
// Claude
const cById = (id: string) => by('claude').find(s => s.sessionId === id)!;
// aaa : format de repli (appels Task/Agent du transcript), titre = 1er message humain.
const cActive = cById('aaa');
assert.strictEqual(cActive.title, 'Refactor le module de paiement');
assert.strictEqual(cActive.state, 'running');
assert.deepStrictEqual(cActive.subAgents.map(r => [r.agentType, r.state]), [['Explore', 'done'], ['reviewer', 'running']]);
// bbb : session idle + titre perso (custom-title.json) prioritaire sur le 1er message.
const cIdle = cById('bbb');
assert.strictEqual(cIdle.title, 'Titre perso');
assert.strictEqual(cIdle.subAgents[0].state, 'interrupted');
// ccc : format réel — titre ai-title (le message meta /clear est ignoré), modèle, états des sous-agents.
const cReal = cById('ccc');
assert.strictEqual(cReal.title, 'Titre généré par IA');
assert.strictEqual(cReal.model, 'claude-opus-5-5');
assert.strictEqual(cReal.state, 'running'); // un sous-agent background est encore actif
const states = Object.fromEntries(cReal.subAgents.map(r => [r.agentType, r.state]));
assert.deepStrictEqual(states, { reviewer: 'done', backend: 'running', worker: 'interrupted', 'general-purpose': 'done' });
assert.strictEqual(cReal.subAgents.find(r => r.agentType === 'backend')!.background, true);
// Codex : 1 session parente, sous-agents = sessions enfants (pas listées à part)
const cx = by('codex');
assert.strictEqual(cx.length, 1);
assert.strictEqual(cx[0].title, 'Migrer la base vers Postgres');
assert.strictEqual(cx[0].model, 'gpt-5.5-codex');
assert.deepStrictEqual(cx[0].subAgents.map(r => [r.agentType, r.state, r.description]),
  [['explorer', 'running', 'Lister les requêtes SQL'], ['security', 'done', 'Auditer les migrations']]);
// Gemini
const gm = by('gemini');
assert.strictEqual(gm.length, 2);
assert.strictEqual(gm.find(s => s.sessionId.endsWith('g1'))!.title, 'Écrire le guide d’installation');
assert.strictEqual(gm.find(s => s.sessionId.endsWith('g1'))!.state, 'running');
assert.strictEqual(gm.find(s => s.sessionId.endsWith('g0'))!.state, 'idle');

// Autre workspace : rien ; scope global : tout
assert.strictEqual(collect(buildProviders({ enabled: ['claude', 'codex', 'gemini'], dirs }), { ...ctx, workspaceDirs: ['/ailleurs'] }).sessions.length, 0);
assert.strictEqual(collect(buildProviders({ enabled: ['claude', 'codex', 'gemini'], dirs }), { ...ctx, workspaceDirs: [], scopeAll: true }).sessions.length, 6);
// Fournisseur absent : ignoré sans erreur
assert.deepStrictEqual(collect(buildProviders({ enabled: ['codex'], dirs: { codex: path.join(root, 'nope') } }), ctx).providers, []);

console.log(`OK — ${snap.agents.length} agents, ${snap.sessions.length} sessions (Claude ${by('claude').length}, Codex ${cx.length}, Gemini ${gm.length})`);
fs.rmSync(root, { recursive: true, force: true });
