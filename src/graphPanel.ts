import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { PROVIDER_LABEL } from './model';
import { Snapshot } from './providers';

/**
 * Libellés de la webview, traduits côté extension (vscode.l10n) : la webview ne garde
 * aucun dictionnaire propre et lit uniquement ces chaînes — une seule source de vérité.
 */
function webviewStrings(): Record<string, string> {
  return {
    appTitle: vscode.l10n.t('Agents'),
    pillOrchestrators: vscode.l10n.t('active orchestrator(s)'),
    pillSubagents: vscode.l10n.t('sub-agent(s) working'),
    pillAgents: vscode.l10n.t('available agents'),
    filterActive: vscode.l10n.t('Active'),
    filterAll: vscode.l10n.t('All'),
    providerAll: vscode.l10n.t('All tools'),
    noProviders: vscode.l10n.t('No agent tool detected (Claude Code, Codex, Gemini CLI). Check the folders in the "Agents Viewer" settings.'),
    headingTeam: vscode.l10n.t('Team'),
    memberWorking: vscode.l10n.t('working'),
    sourceProject: vscode.l10n.t('project'),
    sourceUser: vscode.l10n.t('personal'),
    sourceBuiltin: vscode.l10n.t('built-in'),
    headingActive: vscode.l10n.t('Running orchestrations'),
    headingRecent: vscode.l10n.t('Recent orchestrations'),
    emptyActive: vscode.l10n.t('Everyone is asleep 💤 — no active agent session. Switch to "All" to see history.'),
    emptyRecent: vscode.l10n.t('No recent agent session.'),
    openTranscript: vscode.l10n.t('Open transcript'),
    orchestrator: vscode.l10n.t('Orchestrator'),
    stWorking: vscode.l10n.t('working'),
    stSleeping: vscode.l10n.t('sleeping'),
    stDone: vscode.l10n.t('done'),
    stError: vscode.l10n.t('error'),
    stInterrupted: vscode.l10n.t('interrupted'),
  };
}

/**
 * Panneau « vue graphe ». Sécurité :
 *  - CSP stricte : aucun accès réseau, scripts uniquement locaux avec nonce, pas de style inline ;
 *  - la webview ne peut ouvrir qu'un transcript de session déjà listé (vérifié côté extension).
 */
export class GraphPanel {
  private static current: GraphPanel | undefined;
  private allowedFiles = new Set<string>();
  private lastPayload: unknown;

  static show(extensionUri: vscode.Uri, onReady: () => void) {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('agentViewer.graph', 'Agents', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    GraphPanel.current = new GraphPanel(panel, extensionUri, onReady);
  }

  static update(snap: Snapshot) {
    GraphPanel.current?.post(snap);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri, onReady: () => void) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'robot.svg');
    panel.webview.html = this.html(panel.webview, extensionUri);
    panel.onDidDispose(() => { GraphPanel.current = undefined; });
    panel.webview.onDidReceiveMessage(msg => {
      if (msg?.type === 'ready') {
        if (this.lastPayload) { panel.webview.postMessage(this.lastPayload); } else { onReady(); }
      } else if (msg?.type === 'open' && typeof msg.file === 'string' && this.allowedFiles.has(msg.file)) {
        vscode.window.showTextDocument(vscode.Uri.file(msg.file), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      }
    });
  }

  private post({ providers, agents, sessions }: Snapshot) {
    this.allowedFiles = new Set(sessions.map(s => s.file));
    // On n'envoie que ce que la vue affiche (pas de chemin des fichiers d'agents, pas d'outils).
    this.lastPayload = {
      type: 'update',
      locale: vscode.env.language,
      i18n: webviewStrings(),
      data: {
        providers: providers.map(id => ({ id, label: PROVIDER_LABEL[id] })),
        agents: agents.map(a => ({ provider: a.provider, name: a.name, description: a.description, model: a.model, source: a.source })),
        sessions: sessions.map(s => ({
          provider: s.provider,
          providerLabel: PROVIDER_LABEL[s.provider],
          file: s.file,
          title: s.title,
          projectName: path.basename(s.project),
          state: s.state,
          model: s.model,
          lastActivity: s.lastActivity.toISOString(),
          subAgents: s.subAgents.map(r => ({
            agentType: r.agentType,
            description: r.description,
            state: r.state,
            background: r.background,
            startedAt: r.startedAt?.toISOString(),
            endedAt: r.endedAt?.toISOString(),
          })),
        })),
      },
    };
    this.panel.webview.postMessage(this.lastPayload);
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'graph.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'graph.js'));
    const lang = (vscode.env.language || 'en').split('-')[0];
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Agents</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
