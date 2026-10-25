import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentDef, PROVIDER_LABEL, ProviderId, RunState, SessionInfo, SubAgentRun } from './model';
import { ALL_PROVIDERS, Snapshot, buildProviders, collect } from './providers';
import { GraphPanel } from './graphPanel';

// ---------------------------------------------------------------- helpers

function cfg() { return vscode.workspace.getConfiguration('agentViewer'); }
function workspaceDirs() { return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath); }

function providers() {
  return buildProviders({
    enabled: cfg().get<ProviderId[]>('providers', ALL_PROVIDERS),
    dirs: { claude: cfg().get('claude.dir'), codex: cfg().get('codex.dir'), gemini: cfg().get('gemini.dir') },
  });
}

const SPIN = () => new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'));

function stateIcon(state: RunState): vscode.ThemeIcon {
  switch (state) {
    case 'running': return SPIN();
    case 'done': return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.blue'));
    case 'error': return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'interrupted': return new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('charts.orange'));
    default: return new vscode.ThemeIcon('circle-outline');
  }
}

function stateLabel(state: RunState): string {
  switch (state) {
    case 'running': return vscode.l10n.t('running');
    case 'idle': return vscode.l10n.t('idle');
    case 'done': return vscode.l10n.t('done');
    case 'error': return vscode.l10n.t('error');
    case 'interrupted': return vscode.l10n.t('interrupted');
  }
}
function sourceLabel(source: AgentDef['source']): string {
  switch (source) {
    case 'project': return vscode.l10n.t('project');
    case 'user': return vscode.l10n.t('personal');
    case 'builtin': return vscode.l10n.t('built-in');
  }
}

/** Durée relative (« 5 min ago » / « il y a 5 min ») selon la langue de VS Code. */
const rtf = new Intl.RelativeTimeFormat(vscode.env.language, { numeric: 'auto', style: 'short' });
function relativeTime(d: Date, now = Date.now()): string {
  const s = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) { return rtf.format(s, 'second'); }
  if (abs < 3600) { return rtf.format(Math.round(s / 60), 'minute'); }
  if (abs < 172800) { return rtf.format(Math.round(s / 3600), 'hour'); }
  return rtf.format(Math.round(s / 86400), 'day');
}

function openCommand(file: string): vscode.Command {
  return { command: 'agentViewer.openFile', title: vscode.l10n.t('Open'), arguments: [file] };
}

// ---------------------------------------------------------------- vue « Agents disponibles »

type AgentNode =
  | { kind: 'provider'; provider: ProviderId; agents: AgentDef[] }
  | { kind: 'agent'; agent: AgentDef; running: number };

class AgentsProvider implements vscode.TreeDataProvider<AgentNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private snap: Snapshot = { providers: [], agents: [], sessions: [] };
  private busy = new Map<string, number>();

  update(snap: Snapshot) {
    this.snap = snap;
    this.busy.clear();
    for (const s of snap.sessions) {
      for (const r of s.subAgents) {
        if (r.state === 'running') {
          const k = s.provider + ':' + r.agentType;
          this.busy.set(k, (this.busy.get(k) ?? 0) + 1);
        }
      }
    }
    this.emitter.fire();
  }

  getChildren(node?: AgentNode): AgentNode[] {
    if (!node) {
      return this.snap.providers
        .map(provider => ({ kind: 'provider' as const, provider, agents: this.snap.agents.filter(a => a.provider === provider) }))
        .filter(g => g.agents.length);
    }
    if (node.kind === 'provider') {
      return node.agents.map(agent => ({ kind: 'agent' as const, agent, running: this.busy.get(agent.provider + ':' + agent.name) ?? 0 }));
    }
    return [];
  }

  getTreeItem(node: AgentNode): vscode.TreeItem {
    if (node.kind === 'provider') {
      const item = new vscode.TreeItem(PROVIDER_LABEL[node.provider], vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.agents.length);
      item.iconPath = new vscode.ThemeIcon('organization');
      return item;
    }
    const a = node.agent;
    const item = new vscode.TreeItem(a.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = node.running ? SPIN() : new vscode.ThemeIcon('hubot');
    item.description = [node.running ? vscode.l10n.t('{0} running', node.running) : sourceLabel(a.source), a.model ?? ''].filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString(`**${a.name}** — ${PROVIDER_LABEL[a.provider]}\n\n${a.description || '_' + vscode.l10n.t('No description') + '_'}`);
    if (a.model) { md.appendMarkdown(`\n\n**${vscode.l10n.t('Model:')}** ${a.model}`); }
    if (a.tools) { md.appendMarkdown(`\n\n**${vscode.l10n.t('Tools:')}** ${a.tools}`); }
    md.isTrusted = false;
    item.tooltip = md;
    if (a.file) { item.command = openCommand(a.file); }
    return item;
  }
}

// ---------------------------------------------------------------- vue « Orchestrateurs & sous-agents »

type SessionNode =
  | { kind: 'session'; session: SessionInfo }
  | { kind: 'run'; run: SubAgentRun }
  | { kind: 'empty'; text: string };

class SessionsProvider implements vscode.TreeDataProvider<SessionNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private sessions: SessionInfo[] = [];
  showProject = false;

  update(sessions: SessionInfo[]) { this.sessions = sessions; this.emitter.fire(); }

  getChildren(node?: SessionNode): SessionNode[] {
    if (!node) {
      return this.sessions.length
        ? this.sessions.map(session => ({ kind: 'session' as const, session }))
        : [{ kind: 'empty', text: vscode.l10n.t('No recent agent session') }];
    }
    if (node.kind === 'session') {
      return [...node.session.subAgents].reverse().map(run => ({ kind: 'run' as const, run }));
    }
    return [];
  }

  getTreeItem(node: SessionNode): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    if (node.kind === 'session') {
      const s = node.session;
      const running = s.subAgents.filter(r => r.state === 'running').length;
      const item = new vscode.TreeItem(
        s.title,
        s.subAgents.length
          ? (s.state === 'running' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
          : vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = s.state === 'running' ? SPIN() : new vscode.ThemeIcon('comment-discussion');
      item.description = [
        PROVIDER_LABEL[s.provider],
        s.state === 'running' ? vscode.l10n.t('active') : relativeTime(s.lastActivity),
        s.subAgents.length ? vscode.l10n.t('{0}/{1} sub-agents', running, s.subAgents.length) : '',
        this.showProject ? path.basename(s.project) : '',
      ].filter(Boolean).join(' · ');
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${PROVIDER_LABEL[s.provider]}** — ${vscode.l10n.t('orchestrator {0}', stateLabel(s.state))}\n\n`);
      md.appendText(s.title);
      md.appendMarkdown(`\n\n- ${vscode.l10n.t('Project')}: \`${s.project}\`\n- ${vscode.l10n.t('Session')}: \`${s.sessionId}\`\n`);
      if (s.model) { md.appendMarkdown(`- ${vscode.l10n.t('Model')}: ${s.model}\n`); }
      md.appendMarkdown(`- ${vscode.l10n.t('Last activity')}: ${s.lastActivity.toLocaleString(vscode.env.language)}`);
      item.tooltip = md;
      item.command = openCommand(s.file);
      return item;
    }
    const r = node.run;
    const item = new vscode.TreeItem(r.agentType, vscode.TreeItemCollapsibleState.None);
    item.iconPath = stateIcon(r.state);
    const dur = r.startedAt ? Math.round(((r.endedAt ?? new Date()).getTime() - r.startedAt.getTime()) / 1000) : undefined;
    item.description = [r.description, stateLabel(r.state), dur !== undefined ? `${dur}s` : '', r.background ? vscode.l10n.t('background') : '']
      .filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString(`**${vscode.l10n.t('Sub-agent {0}', r.agentType)}** — ${stateLabel(r.state)}\n\n`);
    md.appendText(r.description);
    item.tooltip = md;
    return item;
  }
}

// ---------------------------------------------------------------- activation

export function activate(context: vscode.ExtensionContext) {
  const agentsView = new AgentsProvider();
  const sessionsView = new SessionsProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'agentViewer.openGraph';

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('agentViewer.available', agentsView),
    vscode.window.registerTreeDataProvider('agentViewer.sessions', sessionsView),
    status,
  );

  let provs = providers();

  const refresh = () => {
    const scopeAll = cfg().get<string>('scope') === 'all' || !workspaceDirs().length;
    sessionsView.showProject = scopeAll;
    const snap = collect(provs, {
      workspaceDirs: workspaceDirs(),
      scopeAll,
      activeThresholdMs: cfg().get<number>('activeThresholdSeconds', 30) * 1000,
      recentMs: cfg().get<number>('recentHours', 24) * 3600 * 1000,
      now: Date.now(),
    });
    agentsView.update(snap);
    sessionsView.update(snap.sessions);
    GraphPanel.update(snap);

    const orch = snap.sessions.filter(s => s.state === 'running').length;
    const subs = snap.sessions.reduce((n, s) => n + s.subAgents.filter(r => r.state === 'running').length, 0);
    status.text = orch || subs
      ? `$(sync~spin) ${vscode.l10n.t('Agents: {0} orch. · {1} sub-agents', orch, subs)}`
      : `$(hubot) ${vscode.l10n.t('Agents: idle')}`;
    status.tooltip = vscode.l10n.t('Detected tools: {0} — click for the graph view', snap.providers.map(p => PROVIDER_LABEL[p]).join(', ') || vscode.l10n.t('none'));
    status.show();
  };

  // Watchers sur les dossiers de sessions + sondage (pour faire passer « en cours » → « inactif »)
  let debounce: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (debounce) { clearTimeout(debounce); }
    debounce = setTimeout(refresh, 300);
  };
  let watchers: fs.FSWatcher[] = [];
  const rewatch = () => {
    watchers.forEach(w => w.close());
    watchers = [];
    const targets: Record<ProviderId, string[]> = { claude: ['projects', 'agents'], codex: ['sessions', 'agents'], gemini: ['tmp', 'agents'] };
    for (const p of provs) {
      for (const sub of targets[p.id]) {
        try { watchers.push(fs.watch(path.join(p.home, sub), { recursive: true }, scheduleRefresh)); } catch { /* absent ou non supporté */ }
      }
    }
  };
  rewatch();

  const projectAgents = vscode.workspace.createFileSystemWatcher('**/.{claude,codex,gemini}/agents/*.{md,toml}');
  projectAgents.onDidChange(scheduleRefresh);
  projectAgents.onDidCreate(scheduleRefresh);
  projectAgents.onDidDelete(scheduleRefresh);

  let timer = setInterval(refresh, cfg().get<number>('pollIntervalSeconds', 3) * 1000);

  context.subscriptions.push(
    projectAgents,
    { dispose: () => { clearInterval(timer); watchers.forEach(w => w.close()); } },
    vscode.commands.registerCommand('agentViewer.refresh', refresh),
    vscode.commands.registerCommand('agentViewer.openGraph', () => GraphPanel.show(context.extensionUri, refresh)),
    vscode.commands.registerCommand('agentViewer.openFile', (file: string) => {
      vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
    }),
    vscode.commands.registerCommand('agentViewer.toggleScope', async () => {
      const next = cfg().get<string>('scope') === 'all' ? 'workspace' : 'all';
      await cfg().update('scope', next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(next === 'all' ? vscode.l10n.t('Agents: all projects') : vscode.l10n.t('Agents: current workspace'), 2000);
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('agentViewer')) { return; }
      provs = providers();
      rewatch();
      clearInterval(timer);
      timer = setInterval(refresh, cfg().get<number>('pollIntervalSeconds', 3) * 1000);
      refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
  );

  refresh();
}

export function deactivate() { /* rien */ }
