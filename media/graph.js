// Vue graphe — tourne dans la webview. Aucune donnée n'est injectée en HTML :
// tout le texte passe par textContent ; seul le dessin SVG statique de l'avatar utilise innerHTML.
(function () {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() {}, setState() {} };
  const app = document.getElementById('app');
  let data = { providers: [], agents: [], sessions: [] };
  // Libellés fournis par l'extension (vscode.l10n) : aucune chaîne en dur ici.
  let i18n = {};
  let locale = 'en';
  let rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const T = (k) => i18n[k] || k;
  const saved = vscode.getState() || {};
  let filter = saved.filter || 'active';
  let only = saved.only || 'all';   // fournisseur affiché
  const save = () => vscode.setState({ filter, only });
  // Teinte de l'orchestrateur selon l'outil
  const PROVIDER_HUE = { claude: 22, codex: 160, gemini: 215 };

  const AVATAR_SVG = `
<svg viewBox="0 0 64 64" aria-hidden="true">
  <path class="crown" d="M22 6 l4 5 l6-7 l6 7 l4-5 l-2 9 h-16 z"/>
  <line class="antenna" x1="32" y1="9" x2="32" y2="15"/>
  <circle class="bulb" cx="32" cy="7" r="3.2"/>
  <rect class="ear" x="5" y="26" width="6" height="13" rx="3"/>
  <rect class="ear" x="53" y="26" width="6" height="13" rx="3"/>
  <rect class="head" x="9" y="14" width="46" height="37" rx="13"/>
  <rect class="screen" x="15" y="20" width="34" height="25" rx="8"/>
  <rect class="scan" x="15" y="20" width="34" height="5" rx="2"/>
  <g class="eyes open"><circle cx="25" cy="31" r="3.4"/><circle cx="39" cy="31" r="3.4"/></g>
  <g class="eyes closed"><path d="M21 31 q4 3 8 0 M35 31 q4 3 8 0"/></g>
  <g class="eyes happy"><path d="M21 32 q4 -4 8 0 M35 32 q4 -4 8 0"/></g>
  <g class="eyes cross"><path d="M22 28 l6 6 M28 28 l-6 6 M36 28 l6 6 M42 28 l-6 6"/></g>
  <g class="eyes dizzy"><path d="M25 31 m-3 0 a3 3 0 1 0 3 -3 M39 31 m-3 0 a3 3 0 1 0 3 -3"/></g>
  <path class="mouth flat" d="M28 39 h8"/>
  <path class="mouth smile" d="M26 37 q6 5 12 0"/>
  <path class="mouth sad" d="M26 40 q6 -4 12 0"/>
  <rect class="body" x="20" y="51" width="24" height="9" rx="4"/>
</svg>
<div class="zzz"><span>z</span><span>z</span><span>Z</span></div>
<div class="bubble"><i></i><i></i><i></i></div>
<div class="badge"></div>`;

  // Couleur stable par nom d'agent
  function hue(name) {
    let h = 0;
    for (const c of String(name)) { h = (h * 31 + c.charCodeAt(0)) % 360; }
    return h;
  }

  // running → working ; idle → sleeping ; le reste tel quel
  function look(state) { return state === 'running' ? 'working' : state === 'idle' ? 'sleeping' : state; }

  const LOOK_KEY = { working: 'stWorking', sleeping: 'stSleeping', done: 'stDone', error: 'stError', interrupted: 'stInterrupted' };
  function statusLabel(l) { return T(LOOK_KEY[l] || l); }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }

  function avatar(name, state, fixedHue) {
    const a = el('div', 'avatar ' + look(state));
    a.innerHTML = AVATAR_SVG; // gabarit statique, aucune donnée utilisateur
    a.style.setProperty('--hue', String(fixedHue ?? hue(name)));
    return a;
  }

  function duration(fromIso, toIso) {
    if (!fromIso) { return ''; }
    const s = Math.max(0, Math.round(((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)) / 1000));
    if (s < 60) { return s + 's'; }
    const m = Math.floor(s / 60);
    if (m < 60) { return m + ' min ' + String(s % 60).padStart(2, '0') + 's'; }
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  function ago(iso) {
    const s = Math.round((Date.parse(iso) - Date.now()) / 1000); // négatif = passé
    const abs = Math.abs(s);
    if (abs < 60) { return rtf.format(s, 'second'); }
    if (abs < 3600) { return rtf.format(Math.round(s / 60), 'minute'); }
    if (abs < 172800) { return rtf.format(Math.round(s / 3600), 'hour'); }
    return rtf.format(Math.round(s / 86400), 'day');
  }

  function statusLine(state, startedAt, endedAt) {
    const l = look(state);
    const s = el('div', 'status ' + l, statusLabel(l));
    if (startedAt && (l === 'working' || l === 'done' || l === 'error')) {
      s.dataset.start = startedAt;
      if (endedAt) { s.dataset.end = endedAt; }
      s.textContent = statusLabel(l) + ' · ' + duration(startedAt, endedAt);
    }
    return s;
  }

  function tag(provider, label) {
    const t = el('span', 'ptag', label || provider);
    t.dataset.p = provider;
    return t;
  }

  function open(file) { vscode.postMessage({ type: 'open', file }); }

  // ------------------------------------------------------------------ rendu
  function render() {
    app.replaceChildren();
    if (only !== 'all' && !data.providers.some(p => p.id === only)) { only = 'all'; }
    const pick = x => only === 'all' || x.provider === only;
    const sessions = data.sessions.filter(pick);
    const agents = data.agents.filter(pick);
    const labelOf = id => (data.providers.find(p => p.id === id) || {}).label || id;
    const liveSessions = sessions.filter(s => s.state === 'running');
    const liveSubs = sessions.reduce((n, s) => n + s.subAgents.filter(r => r.state === 'running').length, 0);

    // En-tête
    const header = el('header');
    header.append(el('h1', '', T('appTitle')));
    const stats = el('div', 'stats');
    const pill = (n, txt, live) => { const p = el('span', 'pill' + (live && n ? ' live' : '')); p.append(el('b', '', String(n)), document.createTextNode(' ' + txt)); return p; };
    stats.append(pill(liveSessions.length, T('pillOrchestrators'), true), pill(liveSubs, T('pillSubagents'), true), pill(agents.length, T('pillAgents')));
    header.append(stats);
    const filters = el('div', 'filters');
    for (const [key, txt] of [['active', T('filterActive')], ['all', T('filterAll')]]) {
      const b = el('button', filter === key ? 'on' : '', txt);
      b.addEventListener('click', () => { filter = key; save(); render(); });
      filters.append(b);
    }
    header.append(filters);
    if (data.providers.length > 1) {
      const pf = el('div', 'filters');
      for (const p of [{ id: 'all', label: T('providerAll') }, ...data.providers]) {
        const b = el('button', only === p.id ? 'on' : '', p.label);
        b.addEventListener('click', () => { only = p.id; save(); render(); });
        pf.append(b);
      }
      header.append(pf);
    }
    app.append(header);
    if (!data.providers.length) {
      app.append(el('div', 'empty', T('noProviders')));
      return;
    }

    // Équipe
    app.append(el('h2', '', T('headingTeam')));
    const team = el('div', 'team');
    const busy = new Map();
    const k = (p, n) => p + ':' + n;
    for (const s of sessions) { for (const r of s.subAgents) { if (r.state === 'running') { busy.set(k(s.provider, r.agentType), (busy.get(k(s.provider, r.agentType)) || 0) + 1); } } }
    const sorted = [...agents].sort((a, b) => (busy.get(k(b.provider, b.name)) || 0) - (busy.get(k(a.provider, a.name)) || 0));
    for (const a of sorted) {
      const n = busy.get(k(a.provider, a.name)) || 0;
      const card = el('div', 'member' + (n ? ' working' : ''));
      card.title = a.description || a.name;
      card.append(avatar(a.name, n ? 'running' : 'idle'));
      card.append(el('div', 'name', a.name));
      card.append(el('div', 'meta', n ? T('memberWorking') : ({ project: T('sourceProject'), user: T('sourceUser'), builtin: T('sourceBuiltin') }[a.source] || a.source) + (a.model ? ' · ' + a.model : '')));
      if (data.providers.length > 1) { const t = tag(a.provider, labelOf(a.provider)); t.classList.add('corner'); card.append(t); }
      if (n > 1) { card.append(el('span', 'count', '×' + n)); }
      team.append(card);
    }
    app.append(team);

    // Orchestrations
    app.append(el('h2', '', filter === 'active' ? T('headingActive') : T('headingRecent')));
    const shown = filter === 'active' ? liveSessions : sessions;
    const list = el('div', 'sessions');
    if (!shown.length) {
      list.append(el('div', 'empty', filter === 'active' ? T('emptyActive') : T('emptyRecent')));
    }
    for (const s of shown) { list.append(sessionCard(s)); }
    app.append(list);
  }

  function sessionCard(s) {
    const card = el('div', 'session' + (s.state === 'running' ? ' running' : ''));
    const head = el('div', 'session-head');
    head.append(tag(s.provider, s.providerLabel));
    head.append(el('span', 'title', s.title));
    head.append(el('span', 'when', (s.projectName ? s.projectName + ' · ' : '') + ago(s.lastActivity)));
    card.append(head);

    const tree = el('div', 'tree');
    const ul = el('ul');
    const root = el('li');
    const orch = el('div', 'node orch clickable');
    orch.title = T('openTranscript');
    orch.addEventListener('click', () => open(s.file));
    orch.append(avatar('orchestrateur', s.state, PROVIDER_HUE[s.provider]));
    orch.append(el('div', 'label', s.providerLabel || T('orchestrator')));
    orch.append(el('div', 'desc', s.model || ''));
    orch.append(statusLine(s.state));
    root.append(orch);

    if (s.subAgents.length) {
      const kids = el('ul');
      // les sous-agents actifs d'abord, puis les plus récents
      const runs = [...s.subAgents].reverse().sort((a, b) => (b.state === 'running') - (a.state === 'running'));
      for (const r of runs) {
        const li = el('li', r.state === 'running' ? 'live' : '');
        const node = el('div', 'node');
        node.title = r.description;
        node.append(avatar(r.agentType, r.state));
        node.append(el('div', 'label', r.agentType));
        node.append(el('div', 'desc', r.description));
        node.append(statusLine(r.state, r.startedAt, r.endedAt));
        li.append(node);
        kids.append(li);
      }
      root.append(kids);
    }
    ul.append(root);
    tree.append(ul);
    card.append(tree);
    return card;
  }

  // Chronos des agents au travail, mis à jour chaque seconde sans tout redessiner
  setInterval(() => {
    document.querySelectorAll('.status.working[data-start]').forEach(s => {
      s.textContent = statusLabel('working') + ' · ' + duration(s.dataset.start);
    });
  }, 1000);

  // On ne redessine que si quelque chose a changé, pour ne pas relancer les animations toutes les 3 s.
  let lastKey = '';
  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || m.type !== 'update') { return; }
    if (m.i18n) { i18n = m.i18n; }
    if (m.locale && m.locale !== locale) {
      locale = m.locale;
      try { rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }); } catch { /* locale inconnue */ }
    }
    const key = JSON.stringify([m.locale, m.i18n, m.data]);
    if (key === lastKey) { return; }
    lastKey = key;
    data = m.data;
    render();
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
