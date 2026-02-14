let ws;
let equityChart;

// AI analysis history — kept in memory, rendered via virtual scroll
const analysisHistory = [];
const MAX_HISTORY = 500;
const RENDER_BATCH = 20;
let renderedCount = 0;
let isLoadingMore = false;

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

const ACTION_MAP = {
  LONG: '做多', SHORT: '做空', CLOSE: '平仓', HOLD: '观望', ADJUST: '调整',
};
const SIDE_MAP = { long: '多', short: '空', buy: '买', sell: '卖' };
const SIDE_LABEL = { buy: '买入', sell: '卖出' };
const ACTION_CLASS = { LONG: 'log-long', SHORT: 'log-short', HOLD: 'log-hold', CLOSE: 'log-close', ADJUST: 'log-adjust' };

// ===== Mode toggle (testnet / mainnet) =====
async function refreshMode() {
  try {
    const data = await (await fetch('/api/mode')).json();
    updateModeBadge(data.testnet);
  } catch (e) { /* ignore */ }
}

function updateModeBadge(isTestnet) {
  const btn = document.getElementById('mode-toggle');
  if (isTestnet) {
    btn.innerHTML = '<span class="badge-dot"></span>测试网';
    btn.className = 'badge badge-testnet';
    btn.title = '当前: 测试网 — 点击切换到实盘';
  } else {
    btn.innerHTML = '<span class="badge-dot"></span>实盘';
    btn.className = 'badge badge-mainnet';
    btn.title = '当前: 实盘 — 点击切换到测试网';
  }
}

async function toggleMode() {
  const btn = document.getElementById('mode-toggle');
  const isCurrentlyTestnet = btn.className.includes('badge-testnet');
  const targetMode = isCurrentlyTestnet ? '实盘' : '测试网';

  const warning = isCurrentlyTestnet
    ? '确认切换到实盘？\n\n交易循环将自动停止，所有缓存状态将被清除。\n实盘模式将使用真实资金交易！'
    : '确认切换到测试网？\n\n交易循环将自动停止，所有缓存状态将被清除。';

  if (!confirm(warning)) return;

  try {
    const res = await fetch('/api/mode/toggle', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      updateModeBadge(data.testnet);
      if (data.running !== undefined) {
        const badge = document.getElementById('status-badge');
        badge.innerHTML = '<span class="badge-dot"></span>' + (data.running ? '运行中' : '已停止');
        badge.className = 'badge ' + (data.running ? 'badge-running' : 'badge-stopped');
      }
      if (data.circuit) updateCircuit(data.circuit);
      syncControlButtons(data.running, data.circuit);
      refreshAll();
    } else {
      alert(data.message || '切换失败');
    }
  } catch (e) {
    alert('切换失败: ' + e.message);
  }
}

// ===== Tab switching =====
function showPanel(name, el) {
  document.getElementById('panel-positions').style.display = name === 'positions' ? '' : 'none';
  document.getElementById('panel-trades').style.display = name === 'trades' ? '' : 'none';
  document.getElementById('panel-pos-history').style.display = name === 'pos-history' ? '' : 'none';
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  if (name === 'pos-history') refreshPositionHistory();
}

// ===== WebSocket =====
function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  const badge = document.getElementById('ws-badge');

  ws.onopen = () => {
    badge.innerHTML = '<span class="badge-dot"></span>WS: 已连接';
    badge.className = 'badge badge-running';
  };
  ws.onclose = () => {
    badge.innerHTML = '<span class="badge-dot"></span>WS: 已断开';
    badge.className = 'badge badge-stopped';
    setTimeout(initWebSocket, 3000);
  };
  ws.onerror = () => {
    badge.innerHTML = '<span class="badge-dot"></span>WS: 错误';
    badge.className = 'badge badge-stopped';
  };

  ws.onmessage = (evt) => {
    try { handleWsMessage(JSON.parse(evt.data)); } catch (e) { console.error('WS 解析错误', e); }
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'account': updateAccount(msg.data); break;
    case 'tickers': updateTickers(msg.data); break;
    case 'decision': addAnalysis(msg.data); break;
    case 'trade': refreshTrades(); refreshPositionHistory(); break;
    case 'circuit': updateCircuit(msg.data); syncControlButtons(null, msg.data); break;
    case 'pairs': updateActivePairs(msg.data); break;
  }
}

// ===== Realtime tickers via WebSocket =====
function updateTickers(tickers) {
  if (!Array.isArray(tickers)) return;
  tickers.forEach(t => {
    const priceEl = document.getElementById('tick-' + t.name);
    const changeEl = document.getElementById('tick-change-' + t.name);
    if (priceEl) {
      priceEl.textContent = '$' + Number(t.price).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      priceEl.className = 'ticker-price ' + (t.change >= 0 ? 'up' : 'down');
    }
    if (changeEl && t.change !== undefined) {
      const sign = t.change >= 0 ? '+' : '';
      changeEl.textContent = sign + t.change.toFixed(2) + '%';
      changeEl.className = 'ticker-change ' + (t.change >= 0 ? 'up' : 'down');
    }
  });
}

// ===== Active pairs display =====
function updateActivePairs(pairs) {
  const el = document.getElementById('active-pairs-list');
  if (!pairs || !pairs.length) { el.textContent = '--'; return; }
  el.textContent = pairs.map(s => s.replace('/USDT:USDT', '')).join(' · ');
}

// ===== Ticker bar (fallback, WebSocket is primary) =====
async function refreshTickers() {
  try {
    const tickers = await (await fetch('/api/tickers')).json();
    updateTickers(tickers);
  } catch (e) { /* ignore */ }
}

// ===== Account =====
function updateAccount(data) {
  if (!data) return;
  const { balance, positions, unrealizedPnl } = data;
  if (balance) {
    document.getElementById('total-balance').textContent = (balance.totalBalance ?? 0).toFixed(2);
    document.getElementById('avail-balance').textContent = (balance.availableBalance ?? 0).toFixed(2);
  }

  const pnl = unrealizedPnl ?? 0;
  const pnlEl = document.getElementById('unrealized-pnl');
  pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
  pnlEl.className = 'stat-value ' + (pnl >= 0 ? 'positive' : 'negative');
  const posArr = Array.isArray(positions) ? positions : [];
  document.getElementById('position-count').textContent = posArr.length + ' 个持仓';
  renderPositions(posArr);
}

function renderPositions(positions) {
  const tbody = document.getElementById('positions-body');
  if (!positions.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">暂无持仓</td></tr>';
    return;
  }
  tbody.innerHTML = positions.map(p => `
    <tr>
      <td>${escapeHtml(p.symbol)}</td>
      <td class="col-${p.side === 'long' ? 'long' : 'short'}">${escapeHtml(SIDE_MAP[p.side] || p.side)}</td>
      <td>${escapeHtml(p.contracts)}</td>
      <td>${escapeHtml(p.entryPrice)}</td>
      <td>${escapeHtml(p.markPrice)}</td>
      <td class="${(p.unrealizedPnl ?? 0) >= 0 ? 'positive' : 'negative'}">${(p.unrealizedPnl ?? 0).toFixed(2)}</td>
      <td>${escapeHtml(p.leverage)}x</td>
    </tr>
  `).join('');
}

// ===== AI Analysis History (virtual scroll) =====

function addAnalysis(data) {
  const { decision, riskCheck, aiProvider, aiModel, strategicProvider, strategicModel, tacticalThinking, strategicThinking } = data;
  const time = new Date().toLocaleTimeString();
  const entry = { time, ...decision, riskPassed: riskCheck.passed, riskReason: riskCheck.reason, tacticalThinking: tacticalThinking || '', strategicThinking: strategicThinking || '' };
  analysisHistory.unshift(entry);
  if (analysisHistory.length > MAX_HISTORY) analysisHistory.pop();

  // Update AI model badges
  if (strategicProvider || strategicModel) {
    document.getElementById('ai-model-badge').textContent = '战略AI: ' + (strategicModel || strategicProvider || '--');
  }
  if (aiProvider || aiModel) {
    document.getElementById('ai-tactical-badge').textContent = '战术AI: ' + (aiModel || aiProvider || '--');
  }

  // Update count badge
  document.getElementById('analysis-count').textContent = analysisHistory.length;

  // Re-render: reset to top, show latest
  renderedCount = 0;
  const content = document.getElementById('ai-history-content');
  content.innerHTML = '';
  renderMoreItems();

  // Scroll to top to show latest
  document.getElementById('ai-history-viewport').scrollTop = 0;
}

function renderAnalysisItem(entry) {
  const actionLabel = ACTION_MAP[entry.action] || entry.action;
  const conf = (entry.confidence * 100).toFixed(0);
  const riskLabel = entry.riskPassed ? '通过' : '拦截: ' + entry.riskReason;
  const riskClass = entry.riskPassed ? 'ai-risk-pass' : 'ai-risk-fail';
  const actionClass = ACTION_CLASS[entry.action] || '';

  let paramsHtml = '';
  if (entry.params) {
    paramsHtml = `<div class="ai-params"><span>仓位 ${escapeHtml(entry.params.positionSizePercent)}%</span><span>杠杆 ${escapeHtml(entry.params.leverage)}x</span><span>止损 ${escapeHtml(entry.params.stopLossPrice)}</span><span>止盈 ${escapeHtml(entry.params.takeProfitPrice)}</span></div>`;
  }

  let thinkingHtml = '';
  if (entry.strategicThinking || entry.tacticalThinking) {
    const sections = [];
    if (entry.strategicThinking) {
      sections.push(`<div class="ai-thinking-section"><div class="ai-thinking-label">战略思考</div><div class="ai-thinking-text">${escapeHtml(entry.strategicThinking)}</div></div>`);
    }
    if (entry.tacticalThinking) {
      sections.push(`<div class="ai-thinking-section"><div class="ai-thinking-label">战术思考</div><div class="ai-thinking-text">${escapeHtml(entry.tacticalThinking)}</div></div>`);
    }
    thinkingHtml = `<details class="ai-thinking"><summary class="ai-thinking-toggle">查看思考过程</summary>${sections.join('')}</details>`;
  }

  const div = document.createElement('div');
  div.className = 'ai-card';
  div.innerHTML =
    `<div class="ai-card-header">` +
      `<span class="ai-card-time">${escapeHtml(entry.time)}</span>` +
      `<span class="ai-card-symbol">${escapeHtml(entry.symbol)}</span>` +
      `<span class="${actionClass}">${escapeHtml(actionLabel)}</span>` +
      `<span class="ai-card-conf">${conf}%</span>` +
      `<span class="${riskClass}">${escapeHtml(riskLabel)}</span>` +
    `</div>` +
    `<div class="ai-reasoning">${escapeHtml(entry.reasoning || '无分析内容')}</div>` +
    paramsHtml +
    thinkingHtml;

  return div;
}

function renderMoreItems() {
  const content = document.getElementById('ai-history-content');
  const sentinel = document.getElementById('ai-history-sentinel');
  const end = Math.min(renderedCount + RENDER_BATCH, analysisHistory.length);

  const fragment = document.createDocumentFragment();
  for (let i = renderedCount; i < end; i++) {
    fragment.appendChild(renderAnalysisItem(analysisHistory[i]));
  }
  content.appendChild(fragment);
  content.appendChild(sentinel);
  renderedCount = end;
  isLoadingMore = false;
}

// IntersectionObserver for infinite scroll
function initVirtualScroll() {
  const viewport = document.getElementById('ai-history-viewport');
  const sentinel = document.getElementById('ai-history-sentinel');

  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !isLoadingMore && renderedCount < analysisHistory.length) {
      isLoadingMore = true;
      renderMoreItems();
    }
  }, { root: viewport, threshold: 0.1 });

  observer.observe(sentinel);
}

// ===== Circuit breaker =====
function updateCircuit(state) {
  const el = document.getElementById('circuit-status');
  const detail = document.getElementById('circuit-detail');
  if (state.tripped || state.manualStop) {
    el.innerHTML = '<span class="circuit-dot"></span>已触发';
    el.className = 'circuit-status negative';
    detail.textContent = state.reason;
  } else {
    el.innerHTML = '<span class="circuit-dot"></span>正常';
    el.className = 'circuit-status positive';
    detail.textContent = `连续亏损: ${state.consecutiveLosses}/3 · API失败: ${state.consecutiveApiFailures}/5`;
  }
}

// ===== Unified control button state management =====
// Single source of truth: always pass both running + circuit to get correct states.
// Cache last known values so partial updates still work.
let _lastRunning = false;
let _lastCircuit = null;

function syncControlButtons(running, circuit) {
  if (running !== undefined && running !== null) _lastRunning = running;
  if (circuit !== undefined && circuit !== null) _lastCircuit = circuit;

  const r = _lastRunning;
  const circuitTripped = _lastCircuit && (_lastCircuit.tripped || _lastCircuit.manualStop);

  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnEmergency = document.getElementById('btn-emergency');
  const btnCircuitReset = document.getElementById('btn-circuit-reset');
  const btnMode = document.getElementById('mode-toggle');

  // Start: enabled only when stopped AND circuit is normal
  if (btnStart) btnStart.disabled = r || !!circuitTripped;
  // Stop: enabled only when running
  if (btnStop) btnStop.disabled = !r;
  // Emergency: enabled only when running
  if (btnEmergency) btnEmergency.disabled = !r;
  // Circuit reset: enabled only when circuit is tripped
  if (btnCircuitReset) btnCircuitReset.disabled = !circuitTripped;
  // Mode toggle: disabled when running (must stop first)
  if (btnMode) btnMode.disabled = r;
}

// ===== API =====
async function api(url, method = 'GET') {
  try {
    const res = await fetch(url, { method });
    const data = await res.json();
    // Update status badge
    if (data.running !== undefined) {
      const badge = document.getElementById('status-badge');
      badge.innerHTML = '<span class="badge-dot"></span>' + (data.running ? '运行中' : '已停止');
      badge.className = 'badge ' + (data.running ? 'badge-running' : 'badge-stopped');
    }
    // Update circuit display
    const circuitData = data.circuit;
    if (circuitData) updateCircuit(circuitData);
    // Sync all button states
    syncControlButtons(data.running, circuitData);
    // Alert on failure
    if (!data.ok && data.message) alert(data.message);
    refreshAll();
    return data;
  } catch (e) { console.error('API 错误', e); }
}

async function refreshStatus() {
  try {
    const data = await (await fetch('/api/status')).json();
    const badge = document.getElementById('status-badge');
    const running = data.running;
    badge.innerHTML = '<span class="badge-dot"></span>' + (running ? '运行中' : '已停止');
    badge.className = 'badge ' + (running ? 'badge-running' : 'badge-stopped');

    if (data.testnet !== undefined) {
      updateModeBadge(data.testnet);
    }
    if (data.balance) {
      document.getElementById('total-balance').textContent = data.balance.totalBalance.toFixed(2);
      document.getElementById('avail-balance').textContent = data.balance.availableBalance.toFixed(2);
    }
    if (data.positions) {
      renderPositions(data.positions);
      const pnl = data.positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
      const pnlEl = document.getElementById('unrealized-pnl');
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
      pnlEl.className = 'stat-value ' + (pnl >= 0 ? 'positive' : 'negative');
      document.getElementById('position-count').textContent = data.positions.length + ' 个持仓';
    }
    if (data.circuit) updateCircuit(data.circuit);
    // Sync all button states with authoritative data from /api/status
    syncControlButtons(running, data.circuit);

    // Update AI model badges
    if (data.aiConfig) {
      document.getElementById('ai-model-badge').textContent = '战略AI: ' + data.aiConfig.strategicProvider;
      document.getElementById('ai-tactical-badge').textContent = '战术AI: ' + data.aiConfig.tacticalProvider;
      document.getElementById('ai-auxiliary-badge').textContent = '辅助AI: ' + data.aiConfig.auxiliaryProvider;
    } else if (data.aiProviders && data.aiProviders.length > 0) {
      document.getElementById('ai-model-badge').textContent = '战略AI: ' + data.aiProviders[0];
      document.getElementById('ai-tactical-badge').textContent = '战术AI: ' + data.aiProviders[0];
      document.getElementById('ai-auxiliary-badge').textContent = '辅助AI: ' + data.aiProviders[0];
    }
  } catch (e) { console.error('状态刷新错误', e); }
}

async function refreshTrades() {
  try {
    const trades = await (await fetch('/api/trades')).json();
    const tbody = document.getElementById('trades-body');
    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-row">暂无交易记录</td></tr>';
      return;
    }
    tbody.innerHTML = trades.slice(0, 20).map(t => `
      <tr>
        <td>${escapeHtml(t.created_at || '--')}</td>
        <td>${escapeHtml(t.symbol)}</td>
        <td class="${t.action === 'LONG' || t.action === 'SHORT' ? (t.action === 'LONG' ? 'col-long' : 'col-short') : ''}">${escapeHtml(ACTION_MAP[t.action] || t.action)}</td>
        <td class="${t.side === 'buy' ? 'col-long' : 'col-short'}">${escapeHtml(SIDE_LABEL[t.side] || (t.side || '').toUpperCase())}</td>
        <td>${t.amount?.toFixed(4) || '--'}</td>
        <td>${t.price?.toFixed(2) || '--'}</td>
        <td>${t.confidence ? (t.confidence * 100).toFixed(0) + '%' : '--'}</td>
      </tr>
    `).join('');
  } catch (e) { console.error('交易刷新错误', e); }
}

async function refreshPositionHistory() {
  try {
    const positions = await (await fetch('/api/positions/history')).json();
    const tbody = document.getElementById('pos-history-body');
    if (!positions.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-row">暂无历史记录</td></tr>';
      return;
    }
    tbody.innerHTML = positions.map(p => {
      const pnlClass = p.pnl > 0 ? 'positive' : p.pnl < 0 ? 'negative' : '';
      const statusLabel = p.status === 'open' ? '持仓中' : '已平仓';
      const statusClass = p.status === 'open' ? 'col-long' : '';
      return `
        <tr>
          <td>${escapeHtml(p.opened_at || '--')}</td>
          <td>${escapeHtml(p.symbol)}</td>
          <td class="${p.side === 'buy' ? 'col-long' : 'col-short'}">${escapeHtml(SIDE_MAP[p.side] || p.side)}</td>
          <td>${p.amount?.toFixed(4) || '--'}</td>
          <td>${p.entry_price?.toFixed(2) || '--'}</td>
          <td>${p.exit_price?.toFixed(2) || '--'}</td>
          <td class="${pnlClass}">${p.pnl != null ? p.pnl.toFixed(2) : '--'}</td>
          <td class="${statusClass}">${statusLabel}</td>
        </tr>
      `;
    }).join('');
  } catch (e) { console.error('持仓历史刷新错误', e); }
}

async function refreshEquityChart() {
  try {
    const snapshots = await (await fetch('/api/snapshots')).json();
    if (!snapshots.length) return;
    const sorted = snapshots.reverse();
    const labels = sorted.map(s => s.created_at?.slice(11, 16) || '');
    const balances = sorted.map(s => s.total_balance);

    if (!equityChart) {
      const ctx = document.getElementById('equity-chart').getContext('2d');

      const gradient = ctx.createLinearGradient(0, 0, 0, 280);
      gradient.addColorStop(0, 'rgba(59, 130, 246, 0.15)');
      gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

      equityChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: '权益 (USDT)',
            data: balances,
            borderColor: '#3b82f6',
            backgroundColor: gradient,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: '#3b82f6',
            pointHoverBorderColor: '#fff',
            pointHoverBorderWidth: 2,
            borderWidth: 2,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1e293b',
              titleColor: '#94a3b8',
              bodyColor: '#e2e8f0',
              borderColor: '#334155',
              borderWidth: 1,
              padding: 10,
              titleFont: { family: "'Inter', sans-serif", size: 11 },
              bodyFont: { family: "'JetBrains Mono', monospace", size: 12, weight: '600' },
              displayColors: false,
              callbacks: { label: (ctx) => ctx.parsed.y.toFixed(2) + ' USDT' }
            }
          },
          scales: {
            x: {
              grid: { color: '#1e293b', lineWidth: 1 },
              ticks: { color: '#64748b', font: { family: "'JetBrains Mono', monospace", size: 10 }, maxTicksLimit: 10 },
              border: { color: '#334155' },
            },
            y: {
              grid: { color: '#1e293b', lineWidth: 1 },
              ticks: { color: '#64748b', font: { family: "'JetBrains Mono', monospace", size: 10 } },
              border: { color: '#334155' },
            },
          }
        }
      });
    } else {
      equityChart.data.labels = labels;
      equityChart.data.datasets[0].data = balances;
      equityChart.update('none');
    }
  } catch (e) { console.error('图表刷新错误', e); }
}

async function refreshDailyPnl() {
  try {
    const pnl = await (await fetch('/api/daily-pnl')).json();
    if (pnl.length > 0) {
      const today = pnl[0];
      const diff = (today.ending_balance || 0) - (today.starting_balance || 0);
      const pct = today.starting_balance > 0 ? (diff / today.starting_balance * 100) : 0;
      const el = document.getElementById('daily-pnl');
      el.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2);
      el.className = 'stat-value ' + (diff >= 0 ? 'positive' : 'negative');
      document.getElementById('daily-pnl-pct').textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '% 今日';
    }
  } catch (e) { console.error('日盈亏刷新错误', e); }
}

function refreshAll() {
  refreshStatus();
  refreshTrades();
  refreshEquityChart();
  refreshDailyPnl();
  refreshTickers();
  refreshMode();
}

// 初始化
initWebSocket();
initVirtualScroll();
refreshAll();
setInterval(refreshAll, 60000); // 60s fallback, WebSocket handles realtime
