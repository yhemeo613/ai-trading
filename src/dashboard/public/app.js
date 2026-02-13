let ws;
let equityChart;
const decisionLog = [];

const ACTION_MAP = {
  LONG: '做多', SHORT: '做空', CLOSE: '平仓', HOLD: '观望', ADJUST: '调整',
};
const SIDE_MAP = { long: '多', short: '空' };
const SIDE_LABEL = { buy: '买入', sell: '卖出' };

// ===== Tab switching =====
function showPanel(name, el) {
  document.getElementById('panel-positions').style.display = name === 'positions' ? '' : 'none';
  document.getElementById('panel-trades').style.display = name === 'trades' ? '' : 'none';
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}

// ===== WebSocket =====
function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  const badge = document.getElementById('ws-badge');

  ws.onopen = () => { badge.textContent = 'WS: 已连接'; badge.className = 'badge badge-running'; };
  ws.onclose = () => {
    badge.textContent = 'WS: 已断开'; badge.className = 'badge badge-stopped';
    setTimeout(initWebSocket, 3000);
  };
  ws.onerror = () => { badge.textContent = 'WS: 错误'; badge.className = 'badge badge-stopped'; };

  ws.onmessage = (evt) => {
    try { handleWsMessage(JSON.parse(evt.data)); } catch (e) { console.error('WS 解析错误', e); }
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'account': updateAccount(msg.data); break;
    case 'decision': addDecisionLog(msg.data); break;
    case 'trade': refreshTrades(); break;
    case 'circuit': updateCircuit(msg.data); break;
    case 'pairs': console.log('活跃交易对:', msg.data); break;
  }
}

// ===== Ticker bar =====
async function refreshTickers() {
  try {
    const tickers = await (await fetch('/api/tickers')).json();
    if (!Array.isArray(tickers)) return;
    tickers.forEach(t => {
      const el = document.getElementById('tick-' + t.name);
      if (el) {
        el.textContent = '$' + Number(t.price).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        el.className = 'ticker-price ' + (t.change >= 0 ? 'up' : 'down');
      }
    });
  } catch (e) { /* ignore */ }
}

// ===== Account =====
function updateAccount(data) {
  const { balance, positions, unrealizedPnl } = data;
  document.getElementById('total-balance').textContent = balance.totalBalance.toFixed(2);
  document.getElementById('avail-balance').textContent = balance.availableBalance.toFixed(2);

  const pnlEl = document.getElementById('unrealized-pnl');
  pnlEl.textContent = (unrealizedPnl >= 0 ? '+' : '') + unrealizedPnl.toFixed(2);
  pnlEl.className = 'stat-value ' + (unrealizedPnl >= 0 ? 'positive' : 'negative');
  document.getElementById('position-count').textContent = positions.length + ' 个持仓';
  renderPositions(positions);
}

function renderPositions(positions) {
  const tbody = document.getElementById('positions-body');
  if (!positions.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-subtle)">暂无持仓</td></tr>';
    return;
  }
  tbody.innerHTML = positions.map(p => `
    <tr>
      <td>${p.symbol}</td>
      <td class="col-${p.side}">${SIDE_MAP[p.side] || p.side}</td>
      <td>${p.contracts}</td>
      <td>${p.entryPrice}</td>
      <td>${p.markPrice}</td>
      <td class="${p.unrealizedPnl >= 0 ? 'positive' : 'negative'}">${p.unrealizedPnl.toFixed(2)}</td>
      <td>${p.leverage}x</td>
    </tr>
  `).join('');
}

// ===== Decision log =====
const ACTION_CLASS = { LONG: 'log-long', SHORT: 'log-short', HOLD: 'log-hold', CLOSE: 'log-close', ADJUST: 'log-adjust' };

function addDecisionLog(data) {
  const { decision, riskCheck } = data;
  const time = new Date().toLocaleTimeString();
  const entry = { time, ...decision, riskPassed: riskCheck.passed, riskReason: riskCheck.reason };
  decisionLog.unshift(entry);
  if (decisionLog.length > 100) decisionLog.pop();

  // Update AI analysis panel with full reasoning
  const analysisEl = document.getElementById('ai-analysis');
  const actionLabel = ACTION_MAP[decision.action] || decision.action;
  const conf = (decision.confidence * 100).toFixed(0);
  const riskLabel = riskCheck.passed ? '✓ 风控通过' : '✗ 风控拦截: ' + riskCheck.reason;
  analysisEl.innerHTML =
    `<div style="color:var(--text);font-weight:700;margin-bottom:4px">[${time}] ${decision.symbol} → <span class="${ACTION_CLASS[decision.action] || ''}">${actionLabel}</span> (${conf}%)</div>` +
    `<div style="margin-bottom:6px;color:${riskCheck.passed ? 'var(--positive)' : 'var(--negative)'};font-size:11px">${riskLabel}</div>` +
    `<div style="color:var(--text)">${decision.reasoning || '无分析内容'}</div>` +
    (decision.params ? `<div style="margin-top:6px;color:var(--text-subtle);font-size:11px">仓位: ${decision.params.positionSizePercent}% · 杠杆: ${decision.params.leverage}x · 止损: ${decision.params.stopLossPrice} · 止盈: ${decision.params.takeProfitPrice}</div>` : '');

  // Update log stream
  const container = document.getElementById('decision-log');
  container.innerHTML = decisionLog.map(d => `
    <div class="log-item">
      <span class="log-time">${d.time}</span>
      <span class="${ACTION_CLASS[d.action] || ''}">${ACTION_MAP[d.action] || d.action}</span>
      <span>${d.symbol}</span>
      <span style="color:var(--text-subtle)">${(d.confidence * 100).toFixed(0)}%</span>
      ${!d.riskPassed ? `<span class="log-blocked">[拦截: ${d.riskReason}]</span>` : ''}
      <span class="log-reason">${d.reasoning?.slice(0, 60) || ''}</span>
    </div>
  `).join('');
}

// ===== Circuit breaker =====
function updateCircuit(state) {
  const el = document.getElementById('circuit-status');
  const detail = document.getElementById('circuit-detail');
  if (state.tripped || state.manualStop) {
    el.textContent = '已触发';
    el.className = 'circuit-status negative';
    detail.textContent = state.reason;
  } else {
    el.textContent = '正常';
    el.className = 'circuit-status positive';
    detail.textContent = `连续亏损: ${state.consecutiveLosses}/3 · API失败: ${state.consecutiveApiFailures}/5`;
  }
}

// ===== API =====
async function api(url, method = 'GET') {
  try {
    const res = await fetch(url, { method });
    const data = await res.json();
    if (data.running !== undefined) {
      const badge = document.getElementById('status-badge');
      badge.textContent = data.running ? '运行中' : '已停止';
      badge.className = 'badge ' + (data.running ? 'badge-running' : 'badge-stopped');
    }
    refreshAll();
    return data;
  } catch (e) { console.error('API 错误', e); }
}

async function refreshStatus() {
  try {
    const data = await (await fetch('/api/status')).json();
    const badge = document.getElementById('status-badge');
    badge.textContent = data.running ? '运行中' : '已停止';
    badge.className = 'badge ' + (data.running ? 'badge-running' : 'badge-stopped');

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
  } catch (e) { console.error('状态刷新错误', e); }
}

async function refreshTrades() {
  try {
    const trades = await (await fetch('/api/trades')).json();
    const tbody = document.getElementById('trades-body');
    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-subtle)">暂无交易记录</td></tr>';
      return;
    }
    tbody.innerHTML = trades.slice(0, 20).map(t => `
      <tr>
        <td>${t.created_at || '--'}</td>
        <td>${t.symbol}</td>
        <td class="${t.action === 'LONG' || t.action === 'SHORT' ? (t.action === 'LONG' ? 'col-long' : 'col-short') : ''}">${ACTION_MAP[t.action] || t.action}</td>
        <td class="${t.side === 'buy' ? 'col-long' : 'col-short'}">${SIDE_LABEL[t.side] || (t.side || '').toUpperCase()}</td>
        <td>${t.amount?.toFixed(4) || '--'}</td>
        <td>${t.price?.toFixed(2) || '--'}</td>
        <td>${t.confidence ? (t.confidence * 100).toFixed(0) + '%' : '--'}</td>
      </tr>
    `).join('');
  } catch (e) { console.error('交易刷新错误', e); }
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
      equityChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: '权益 (USDT)',
            data: balances,
            borderColor: '#000000',
            backgroundColor: 'rgba(0, 0, 0, 0.03)',
            fill: true,
            tension: 0.1,
            pointRadius: 0,
            borderWidth: 2,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: {
              grid: { color: '#e0e0e0', lineWidth: 1 },
              ticks: { color: '#666', font: { family: "'IBM Plex Mono', monospace", size: 10 }, maxTicksLimit: 10 },
              border: { color: '#000' },
            },
            y: {
              grid: { color: '#e0e0e0', lineWidth: 1 },
              ticks: { color: '#666', font: { family: "'IBM Plex Mono', monospace", size: 10 } },
              border: { color: '#000' },
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
}

// 初始化
initWebSocket();
refreshAll();
setInterval(refreshAll, 30000);
