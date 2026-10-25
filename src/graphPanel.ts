import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { PROVIDER_LABEL } from './model';
import { Snapshot } from './providers';

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
    return `<!DOCTYPE html>
<html lang="fr">
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
