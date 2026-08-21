import * as vscode from "vscode";
import { LocalProxyServer } from "../proxy/LocalProxyServer";

export class DashboardWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "copilotPulse.dashboardView";
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((data: any) => {
      switch (data.type) {
        case "refresh":
          this.updateDashboard();
          break;
      }
    });

    this.updateDashboard();
  }

  public updateDashboard() {
    if (!this._view) return;
    const metrics = LocalProxyServer.getInstance().getMetrics();
    
    const totalCount = metrics.length;
    const cheapCount = metrics.filter(m => m.savings).length;
    const savingsPercent = totalCount > 0 ? Math.round((cheapCount / totalCount) * 100) : 0;
    const avgLatency = totalCount > 0 ? Math.round(metrics.reduce((acc, m) => acc + m.latencyMs, 0) / totalCount) : 0;
    const totalSaved = metrics.reduce((acc, m) => acc + (m.simulatedSavings || 0), 0);
    const avgScore = totalCount > 0 ? (metrics.reduce((acc, m) => acc + (m.score || m.complexityScore || 0), 0) / totalCount).toFixed(1) : "0.0";
    
    // Task distribution
    const taskCounts: Record<string, number> = {};
    metrics.forEach(m => {
      const type = m.taskType || "GENERAL";
      taskCounts[type] = (taskCounts[type] || 0) + 1;
    });

    // Model distribution
    const modelCounts: Record<string, number> = {};
    metrics.forEach(m => {
      const model = (m.routedModel || m.model || "unknown").split("/").pop() || "unknown";
      modelCounts[model] = (modelCounts[model] || 0) + 1;
    });

    // Tier distribution
    const tierCounts: Record<string, number> = { "Light tier": 0, "Medium tier": 0, "Heavy tier": 0 };
    metrics.forEach(m => {
      const tier = m.tier || "Light tier";
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    });

    // Premium credits estimate (Heavy=1 credit, Medium=0.5, Light=0.1)
    const creditsUsed = metrics.reduce((acc, m) => {
      const t = (m.tier || "").toLowerCase();
      if (t.includes("heavy")) return acc + 1.0;
      if (t.includes("medium")) return acc + 0.5;
      return acc + 0.1;
    }, 0);
    const creditsIfAllHeavy = totalCount * 1.0;
    const creditsSaved = Math.max(0, creditsIfAllHeavy - creditsUsed);

    this._view.webview.postMessage({
      type: "update",
      metrics,
      summary: {
        totalCount,
        cheapCount,
        savingsPercent,
        avgLatency,
        totalSaved,
        avgScore,
        taskCounts,
        modelCounts,
        tierCounts,
        creditsUsed: creditsUsed.toFixed(1),
        creditsSaved: creditsSaved.toFixed(1),
        creditsIfAllHeavy: creditsIfAllHeavy.toFixed(1)
      }
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Copilot Pulse Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      padding: 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-size: 12px;
      line-height: 1.4;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.08));
      margin-bottom: 12px;
    }
    .header h3 {
      font-size: 13px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .live-badge {
      font-size: 9px;
      font-weight: 600;
      color: #2ecc71;
      background: rgba(46,204,113,0.12);
      padding: 2px 7px;
      border-radius: 10px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    .query-counter {
      font-size: 10px;
      opacity: 0.5;
    }

    /* ── Hero KPIs ── */
    .hero-row {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 6px;
      margin-bottom: 10px;
    }
    .hero-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.06));
      border-radius: 8px;
      padding: 10px 8px;
      text-align: center;
      transition: transform 0.2s, border-color 0.3s;
    }
    .hero-card:hover {
      transform: translateY(-1px);
      border-color: rgba(0,210,255,0.3);
    }
    .hero-label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.55;
      margin-bottom: 3px;
    }
    .hero-value {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.5px;
    }
    .hero-sub {
      font-size: 9px;
      opacity: 0.45;
      margin-top: 2px;
    }
    .color-green { color: #2ecc71; }
    .color-blue { color: #00d2ff; }
    .color-orange { color: #f39c12; }
    .color-red { color: #e74c3c; }
    .color-purple { color: #9b59b6; }

    /* ── Credit Savings Visualizer ── */
    .savings-viz {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.06));
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 10px;
    }
    .savings-viz-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .savings-viz-title {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
    }
    .savings-highlight {
      font-size: 11px;
      font-weight: 700;
      color: #2ecc71;
    }
    .savings-bar-track {
      height: 18px;
      background: rgba(255,255,255,0.04);
      border-radius: 9px;
      overflow: hidden;
      position: relative;
      margin-bottom: 6px;
    }
    .savings-bar-fill {
      height: 100%;
      border-radius: 9px;
      background: linear-gradient(90deg, #2ecc71, #27ae60);
      transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      color: #fff;
      min-width: 30px;
    }
    .savings-stats {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      opacity: 0.5;
    }

    /* ── Tier Donut ── */
    .tier-section {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.06));
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 10px;
    }
    .section-title {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
      margin-bottom: 8px;
    }
    .tier-bars {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .tier-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tier-label {
      font-size: 10px;
      width: 58px;
      flex-shrink: 0;
      font-weight: 600;
    }
    .tier-bar-bg {
      flex: 1;
      height: 14px;
      background: rgba(255,255,255,0.04);
      border-radius: 7px;
      overflow: hidden;
    }
    .tier-bar-fill {
      height: 100%;
      border-radius: 7px;
      transition: width 0.6s ease;
      display: flex;
      align-items: center;
      padding-left: 6px;
      font-size: 9px;
      font-weight: 700;
      color: #fff;
    }
    .tier-count {
      font-size: 10px;
      width: 28px;
      text-align: right;
      opacity: 0.7;
    }
    .light-fill { background: linear-gradient(90deg, #2ecc71, #27ae60); }
    .medium-fill { background: linear-gradient(90deg, #f39c12, #e67e22); }
    .heavy-fill { background: linear-gradient(90deg, #e74c3c, #c0392b); }

    /* ── Model Usage ── */
    .model-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
    }
    .model-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      transition: background 0.2s;
    }
    .model-chip:hover { background: rgba(255,255,255,0.06); }
    .chip-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .chip-count {
      font-weight: 700;
      opacity: 0.8;
    }

    /* ── Task Chart ── */
    .task-chart {
      display: flex;
      height: 12px;
      border-radius: 6px;
      overflow: hidden;
      background: rgba(0,0,0,0.2);
      margin-bottom: 6px;
    }
    .task-seg {
      height: 100%;
      transition: width 0.5s ease;
    }
    .task-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .task-legend-item {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 9px;
    }
    .task-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }

    /* ── Routing Decision Log (main table) ── */
    .log-section {
      margin-top: 10px;
    }
    .log-title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .log-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.06));
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 6px;
      transition: border-color 0.2s;
    }
    .log-card:hover {
      border-color: rgba(0,210,255,0.25);
    }
    .log-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 5px;
    }
    .log-model {
      font-weight: 700;
      font-size: 12px;
    }
    .log-time {
      font-size: 9px;
      opacity: 0.4;
    }
    .log-prompt {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      line-height: 1.35;
      word-break: break-word;
    }
    .log-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 7px;
      border-radius: 10px;
      font-size: 9px;
      font-weight: 600;
      white-space: nowrap;
    }
    .pill-score {
      background: rgba(0,210,255,0.12);
      color: #00d2ff;
    }
    .pill-task {
      background: rgba(52,152,219,0.15);
      color: #5dade2;
    }
    .pill-light {
      background: rgba(46,204,113,0.15);
      color: #2ecc71;
    }
    .pill-medium {
      background: rgba(243,156,18,0.15);
      color: #f39c12;
    }
    .pill-heavy {
      background: rgba(231,76,60,0.15);
      color: #e74c3c;
    }
    .pill-utility {
      background: rgba(149,165,166,0.15);
      color: #95a5a6;
    }
    .pill-savings {
      background: rgba(46,204,113,0.15);
      color: #2ecc71;
    }
    .pill-no-savings {
      background: rgba(231,76,60,0.1);
      color: #e74c3c;
    }

    /* ── Why badge (reasoning) ── */
    .why-row {
      margin-top: 5px;
      font-size: 9px;
      opacity: 0.55;
      line-height: 1.4;
    }
    .why-row strong { opacity: 0.8; }

    /* ── Signal bars ── */
    .signal-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 3px;
      margin-top: 5px;
    }
    .signal-item {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 8px;
      opacity: 0.6;
    }
    .signal-bar-bg {
      width: 30px;
      height: 4px;
      background: rgba(255,255,255,0.06);
      border-radius: 2px;
      overflow: hidden;
    }
    .signal-bar {
      height: 100%;
      border-radius: 2px;
      background: #00d2ff;
    }

    /* ── Button ── */
    .refresh-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 7px 12px;
      border-radius: 6px;
      cursor: pointer;
      width: 100%;
      font-weight: 700;
      font-size: 11px;
      transition: background 0.2s, transform 0.1s;
      margin-bottom: 10px;
    }
    .refresh-btn:hover {
      background: var(--vscode-button-hoverBackground);
      transform: scale(1.01);
    }
    .refresh-btn:active { transform: scale(0.98); }

    /* ── Empty state ── */
    .empty-state {
      text-align: center;
      padding: 30px 10px;
      opacity: 0.4;
    }
    .empty-state .emoji { font-size: 28px; margin-bottom: 8px; }
    .empty-state p { font-size: 11px; line-height: 1.5; }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <h3>⚡ Copilot Pulse</h3>
    <div style="display:flex;align-items:center;gap:8px;">
      <span class="live-badge">● Live</span>
      <span class="query-counter" id="queryCount">0 queries</span>
    </div>
  </div>

  <!-- Hero KPIs -->
  <div class="hero-row">
    <div class="hero-card">
      <div class="hero-label">Savings Rate</div>
      <div class="hero-value color-green" id="savingsRate">0%</div>
      <div class="hero-sub" id="savingsDetail">0 of 0 cheap</div>
    </div>
    <div class="hero-card">
      <div class="hero-label">Credits Saved</div>
      <div class="hero-value color-green" id="creditsSaved">0</div>
      <div class="hero-sub" id="creditsDetail">of 0 total</div>
    </div>
    <div class="hero-card">
      <div class="hero-label">Avg Score</div>
      <div class="hero-value color-blue" id="avgScore">0.0</div>
      <div class="hero-sub">/10 complexity</div>
    </div>
  </div>

  <!-- Credit Savings Visualizer -->
  <div class="savings-viz">
    <div class="savings-viz-header">
      <span class="savings-viz-title">💰 Credit Usage vs Savings</span>
      <span class="savings-highlight" id="savingsHighlight">$0.00 saved</span>
    </div>
    <div class="savings-bar-track">
      <div class="savings-bar-fill" id="savingsBarFill" style="width: 0%;">0%</div>
    </div>
    <div class="savings-stats">
      <span id="creditsUsedLabel">Used: 0</span>
      <span id="creditsIfHeavyLabel">If all heavy: 0</span>
    </div>
  </div>

  <!-- Tier Distribution -->
  <div class="tier-section">
    <div class="section-title">📊 Tier Distribution</div>
    <div class="tier-bars">
      <div class="tier-row">
        <span class="tier-label color-green">🟢 Light</span>
        <div class="tier-bar-bg"><div class="tier-bar-fill light-fill" id="lightBar" style="width:0%"></div></div>
        <span class="tier-count" id="lightCount">0</span>
      </div>
      <div class="tier-row">
        <span class="tier-label color-orange">🟡 Medium</span>
        <div class="tier-bar-bg"><div class="tier-bar-fill medium-fill" id="mediumBar" style="width:0%"></div></div>
        <span class="tier-count" id="mediumCount">0</span>
      </div>
      <div class="tier-row">
        <span class="tier-label color-red">🔴 Heavy</span>
        <div class="tier-bar-bg"><div class="tier-bar-fill heavy-fill" id="heavyBar" style="width:0%"></div></div>
        <span class="tier-count" id="heavyCount">0</span>
      </div>
    </div>
  </div>

  <!-- Model Usage -->
  <div class="tier-section">
    <div class="section-title">🤖 Models Used</div>
    <div class="model-chips" id="modelChips">
      <span style="opacity:0.4;font-size:10px;">No models used yet</span>
    </div>
  </div>

  <!-- Task Type Distribution -->
  <div class="tier-section">
    <div class="section-title">📋 Task Type Breakdown</div>
    <div class="task-chart" id="taskChart"></div>
    <div class="task-legend" id="taskLegend"></div>
  </div>

  <button class="refresh-btn" onclick="refresh()">↻ Refresh Dashboard</button>

  <!-- Routing Decision Log -->
  <div class="log-section">
    <div class="log-title-row">
      <span class="section-title" style="margin:0;">📝 Routing Decision Log</span>
      <span style="font-size:9px;opacity:0.4;" id="logShowCount">Latest 15</span>
    </div>
    <div id="logContainer">
      <div class="empty-state">
        <div class="emoji">⚡</div>
        <p>No queries routed yet.<br>Ask <strong>@copilotpulse</strong> a question or select<br><strong>Copilot Pulse Agent</strong> from the model picker.</p>
      </div>
    </div>
  </div>

  <script>
    const vscodeApi = acquireVsCodeApi();
    const COLORS = ['#3498db','#e74c3c','#2ecc71','#f1c40f','#9b59b6','#e67e22','#1abc9c','#34495e','#e91e63','#00bcd4'];
    const MODEL_COLORS = {
      'gpt-4o-mini': '#2ecc71', 'gpt-3.5-turbo': '#27ae60', 'claude-3-haiku': '#1abc9c',
      'gpt-4o': '#f39c12', 'claude-3.5-sonnet': '#e67e22', 'mistral': '#d35400',
      'o1': '#e74c3c', 'o3-mini': '#c0392b', 'claude-3-opus': '#e91e63', 'deepseek-r1': '#9b59b6'
    };

    function refresh() { vscodeApi.postMessage({ type: 'refresh' }); }
    setInterval(refresh, 2000);

    function tierPillClass(tier) {
      const t = (tier || '').toLowerCase();
      if (t.includes('heavy')) return 'pill-heavy';
      if (t.includes('medium')) return 'pill-medium';
      if (t.includes('utility')) return 'pill-utility';
      return 'pill-light';
    }

    function modelColor(name) {
      const n = (name || '').toLowerCase();
      for (const [key, color] of Object.entries(MODEL_COLORS)) {
        if (n.includes(key)) return color;
      }
      return '#00d2ff';
    }

    function whyExplanation(m) {
      const parts = [];
      const score = (m.score || m.complexityScore || 0).toFixed(1);
      const tier = m.tier || 'Light tier';
      const task = (m.taskType || 'GENERAL').replace(/_/g, ' ');
      const model = (m.routedModel || m.model || '?').split('/').pop();
      const t = tier.toLowerCase();

      if (t.includes('light')) {
        parts.push('Simple query → routed to lightweight model to save credits & reduce latency.');
      } else if (t.includes('medium')) {
        parts.push('Moderate complexity → balanced model for quality code generation.');
      } else if (t.includes('heavy')) {
        parts.push('High complexity → premium model needed for deep reasoning & reliable tool calls.');
      } else if (t.includes('utility')) {
        parts.push('Internal Copilot request → bypassed routing (no cost impact).');
      }

      if (m.signals) {
        const sig = m.signals;
        const dominant = Object.entries(sig).sort((a,b) => b[1] - a[1])[0];
        if (dominant && dominant[1] > 3) {
          const sigNames = { keyword: 'Keyword complexity', intent: 'Task intent', code: 'Code density', context: 'Context length', vector: 'Semantic depth' };
          parts.push('Top signal: ' + (sigNames[dominant[0]] || dominant[0]) + ' (' + dominant[1] + '/9).');
        }
      }

      return parts.join(' ');
    }

    function escapeHtml(str) {
      return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type !== 'update') return;
      const s = msg.summary;
      const metrics = msg.metrics || [];

      // ── Hero KPIs ──
      document.getElementById('queryCount').innerText = s.totalCount + ' queries';
      document.getElementById('savingsRate').innerText = s.savingsPercent + '%';
      document.getElementById('savingsDetail').innerText = s.cheapCount + ' of ' + s.totalCount + ' cheap';
      document.getElementById('creditsSaved').innerText = s.creditsSaved;
      document.getElementById('creditsDetail').innerText = 'of ' + s.creditsIfAllHeavy + ' total';
      document.getElementById('avgScore').innerText = s.avgScore;
      document.getElementById('savingsHighlight').innerText = '$' + (s.totalSaved || 0).toFixed(3) + ' saved';
      document.getElementById('creditsUsedLabel').innerText = 'Used: ' + s.creditsUsed + ' credits';
      document.getElementById('creditsIfHeavyLabel').innerText = 'If all heavy: ' + s.creditsIfAllHeavy;

      // Savings bar
      const savingsPct = s.totalCount > 0 ? Math.round((parseFloat(s.creditsSaved) / parseFloat(s.creditsIfAllHeavy)) * 100) : 0;
      const barEl = document.getElementById('savingsBarFill');
      barEl.style.width = Math.max(savingsPct, 3) + '%';
      barEl.innerText = savingsPct + '%';

      // ── Tier Distribution ──
      const tc = s.tierCounts || {};
      const lt = tc['Light tier'] || 0;
      const mt = tc['Medium tier'] || 0;
      const ht = tc['Heavy tier'] || 0;
      const maxTier = Math.max(lt, mt, ht, 1);
      document.getElementById('lightBar').style.width = ((lt / maxTier) * 100) + '%';
      document.getElementById('mediumBar').style.width = ((mt / maxTier) * 100) + '%';
      document.getElementById('heavyBar').style.width = ((ht / maxTier) * 100) + '%';
      document.getElementById('lightCount').innerText = lt;
      document.getElementById('mediumCount').innerText = mt;
      document.getElementById('heavyCount').innerText = ht;

      // ── Model chips ──
      const mc = s.modelCounts || {};
      const chipEl = document.getElementById('modelChips');
      const modelEntries = Object.entries(mc).sort((a,b) => b[1] - a[1]);
      if (modelEntries.length === 0) {
        chipEl.innerHTML = '<span style="opacity:0.4;font-size:10px;">No models used yet</span>';
      } else {
        chipEl.innerHTML = modelEntries.map(([name, count]) => {
          const col = modelColor(name);
          return '<div class="model-chip"><div class="chip-dot" style="background:' + col + ';"></div>' + name + ' <span class="chip-count">×' + count + '</span></div>';
        }).join('');
      }

      // ── Task chart ──
      const taskCounts = s.taskCounts || {};
      const totalTasks = Object.values(taskCounts).reduce((a, b) => a + b, 0);
      const chartEl = document.getElementById('taskChart');
      const legendEl = document.getElementById('taskLegend');
      if (totalTasks === 0) {
        chartEl.innerHTML = '<div class="task-seg" style="width:100%;background:#333;"></div>';
        legendEl.innerHTML = '<div class="task-legend-item"><div class="task-dot" style="background:#333;"></div>None</div>';
      } else {
        let ch = '', lg = '';
        Object.entries(taskCounts).sort((a,b) => b[1] - a[1]).forEach(([type, count], idx) => {
          const pct = ((count / totalTasks) * 100).toFixed(1);
          const col = COLORS[idx % COLORS.length];
          const label = type.replace(/_/g, ' ');
          ch += '<div class="task-seg" style="width:' + pct + '%;background:' + col + ';" title="' + label + ': ' + count + '"></div>';
          lg += '<div class="task-legend-item"><div class="task-dot" style="background:' + col + ';"></div>' + label + ' ' + pct + '%</div>';
        });
        chartEl.innerHTML = ch;
        legendEl.innerHTML = lg;
      }

      // ── Routing Decision Log ──
      const container = document.getElementById('logContainer');
      if (metrics.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="emoji">⚡</div><p>No queries routed yet.<br>Ask <strong>@copilotpulse</strong> a question or select<br><strong>Copilot Pulse Agent</strong> from the model picker.</p></div>';
        document.getElementById('logShowCount').innerText = '';
        return;
      }

      // Metrics arrive newest-first (recordMetric unshifts), so the most
      // recent 15 are the FIRST 15 and need no reversing. The previous
      // slice(-15).reverse() displayed the OLDEST 15 entries instead — the
      // "Routing Decision Log" never showed recent activity once 15+ prompts
      // had been routed.
      const shown = metrics.slice(0, 15);
      document.getElementById('logShowCount').innerText = 'Latest ' + shown.length + ' of ' + metrics.length;

      container.innerHTML = shown.map(m => {
        const time = new Date(m.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        // NOTE: every value interpolated into innerHTML below must be escaped.
        // Model names in particular can originate from user settings
        // (copilotPulse.cheapModel / strongModel), and workspace-level
        // .vscode/settings.json from an untrusted repository can set those —
        // so an unescaped model name is a genuine injection vector.
        const rawModel = (m.routedModel || m.model || '?').split('/').pop();
        const model = escapeHtml(rawModel);
        const score = (m.score || m.complexityScore || 0).toFixed(1);
        const rawTier = m.tier || 'Light tier';
        const tier = escapeHtml(rawTier);
        const task = escapeHtml((m.taskType || 'GENERAL').replace(/_/g, ' '));
        const prompt = escapeHtml(m.promptSnippet || m.prompt || '');
        const savingsText = m.savings ? '✅ Saved' : '⬆️ Premium';
        const savingsClass = m.savings ? 'pill-savings' : 'pill-no-savings';
        const why = escapeHtml(whyExplanation(m));
        const sig = m.signals || {};

        let signalHtml = '';
        if (sig && Object.keys(sig).length > 0) {
          const sigEntries = [
            ['KW', sig.keyword || 0],
            ['INT', sig.intent || 0],
            ['CODE', sig.code || 0],
            ['CTX', sig.context || 0],
            ['VEC', sig.vector || 0],
          ];
          signalHtml = '<div class="signal-grid">' + sigEntries.map(([label, val]) => {
            // Clamp to a number so the inline style cannot be escaped.
            const safeVal = Number(val) || 0;
            const pct = Math.max(0, Math.min(100, Math.round((safeVal / 9) * 100)));
            return '<div class="signal-item">' + label + ' <div class="signal-bar-bg"><div class="signal-bar" style="width:' + pct + '%;"></div></div> ' + safeVal + '</div>';
          }).join('') + '</div>';
        }

        return '<div class="log-card">' +
          '<div class="log-header">' +
            '<span class="log-model" style="color:' + modelColor(rawModel) + ';">⚡ ' + model + '</span>' +
            '<span class="log-time">' + time + '</span>' +
          '</div>' +
          '<div class="log-prompt">"' + prompt + '"</div>' +
          '<div class="log-meta">' +
            '<span class="pill pill-score">Score ' + score + '/10</span>' +
            '<span class="pill ' + tierPillClass(rawTier) + '">' + tier + '</span>' +
            '<span class="pill pill-task">' + task + '</span>' +
            '<span class="pill ' + savingsClass + '">' + savingsText + '</span>' +
          '</div>' +
          '<div class="why-row"><strong>Why:</strong> ' + why + '</div>' +
          signalHtml +
        '</div>';
      }).join('');
    });
  </script>
</body>
</html>`;
  }
}
