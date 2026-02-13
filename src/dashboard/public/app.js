let ws;
let equityChart;
const decisionLog = [];

function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  const badge = document.getElementById('ws-badge');

  ws.onopen = () => { badge.textContent = 'WS: Connected'; badge.style.color = 'var(--green)'; };
  ws.onclose = () => {
    badge.textContent = 'WS: Disconnected'; badge.style.color = 'var(--red)';
    setTimeout(initWebSocket, 3000);
  };
  ws.onerror = () => { badge.textContent = 'WS: Error'; badge.style.color = 'var(--red)'; };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleWsMessage(msg);
    } catch (e) { console.error('WS parse error', e); }
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'account':
      updateAccount(msg.data);
      break;
    case 'decision':
      addDecisionLog(msg.data);
      break;
    case 'trade':
      refreshTrades();
      break;
    case 'circuit':
      updateCircuit(msg.data);
      break;
    case 'pairs':
      console.log('Active pairs:', msg.data);
      break;
  }
}

function updateAccount(data) {
  const { balance, positions, unrealizedPnl } = data;
  document.getElementById('total-balance').textContent = balance.totalBalance.toFixed(2);
  document.getElementById('avail-balance').textContent = balance.availableBalance.toFixed(2) + ' USDT';
  const pnlEl = document.getElementById('unrealized-pnl');
  pnlEl.textContent = (unrealizedPnl >= 0 ? '+' : '') + unrealizedPnl.toFixed(2) + ' USDT';
  pnlEl.className = 'stat ' + (unrealizedPnl >= 0 ? 'positive' : 'negative');
  document.getElementById('position-count').textContent = positions.length + ' positions';
  renderPositions(positions);
}

function renderPositions(positions) {
  const tbody = document.getElementById('positions-body');
  if (!positions.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted)">No positions</td></tr>';
    return;
  }
  tbody.innerHTML = positions.map(p => `
    <tr>
      <td>${p.symbol}</td>
      <td class="side-${p.side}">${p.side.toUpperCase()}</td>
      <td>${p.contracts}</td>
      <td>${p.entryPrice}</td>
      <td>${p.markPrice}</td>
      <td style="color:${p.unrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)'}">${p.unrealizedPnl.toFixed(2)}</td>
      <td>${p.leverage}x</td>
    </tr>
  `).join('');
}

function addDecisionLog(data) {
  const { decision, riskCheck } = data;
  const time = new Date().toLocaleTimeString();
  const entry = { time, ...decision, riskPassed: riskCheck.passed, riskReason: riskCheck.reason };
  decisionLog.unshift(entry);
  if (decisionLog.length > 100) decisionLog.pop();

  const container = document.getElementById('decision-log');
  container.innerHTML = decisionLog.map(d => `
    <div class="log-entry">
      <span class="time">${d.time}</span>
      <span class="action-${d.action}">${d.action}</span>
      <span>${d.symbol}</span>
      <span style="color:var(--muted)">conf: ${(d.confidence * 100).toFixed(0)}%</span>
      ${!d.riskPassed ? `<span style="color:var(--red)">[BLOCKED: ${d.riskReason}]</span>` : ''}
      <span style="color:var(--muted);font-size:11px">${d.reasoning?.slice(0, 80) || ''}</span>
    </div>
  `).join('');
}

function updateCircuit(state) {
  const el = document.getElementById('circuit-status');
  const detail = document.getElementById('circuit-detail');
  if (state.tripped || state.manualStop) {
    el.textContent = 'TRIPPED';
    el.style.color = 'var(--red)';
    detail.textContent = state.reason;
  } else {
    el.textContent = 'OK';
    el.style.color = 'var(--green)';
    detail.textContent = `Losses: ${state.consecutiveLosses}/3, API fails: ${state.consecutiveApiFailures}/5`;
  }
}

async function api(url, method = 'GET') {
  try {
    const res = await fetch(url, { method });
    const data = await res.json();
    if (data.running !== undefined) {
      const badge = document.getElementById('status-badge');
      badge.textContent = data.running ? 'RUNNING' : 'STOPPED';
      badge.className = 'status-badge ' + (data.running ? 'status-running' : 'status-stopped');
    }
    refreshAll();
    return data;
  } catch (e) { console.error('API error', e); }
}

async function refreshStatus() {
  try {
    const data = await (await fetch('/api/status')).json();
    const badge = document.getElementById('status-badge');
    badge.textContent = data.running ? 'RUNNING' : 'STOPPED';
    badge.className = 'status-badge ' + (data.running ? 'status-running' : 'status-stopped');

    if (data.balance) {
      document.getElementById('total-balance').textContent = data.balance.totalBalance.toFixed(2);
      document.getElementById('avail-balance').textContent = data.balance.availableBalance.toFixed(2) + ' USDT';
    }
    if (data.positions) {
      renderPositions(data.positions);
      const pnl = data.positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
      const pnlEl = document.getElementById('unrealized-pnl');
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' USDT';
      pnlEl.className = 'stat ' + (pnl >= 0 ? 'positive' : 'negative');
      document.getElementById('position-count').textContent = data.positions.length + ' positions';
    }
    if (data.circuit) updateCircuit(data.circuit);
  } catch (e) { console.error('Status refresh error', e); }
}

async function refreshTrades() {
  try {
    const trades = await (await fetch('/api/trades')).json();
    const tbody = document.getElementById('trades-body');
    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted)">No trades yet</td></tr>';
      return;
    }
    tbody.innerHTML = trades.slice(0, 20).map(t => `
      <tr>
        <td>${t.created_at || '--'}</td>
        <td>${t.symbol}</td>
        <td class="action-${t.action}">${t.action}</td>
        <td class="side-${t.side}">${(t.side || '').toUpperCase()}</td>
        <td>${t.amount?.toFixed(4) || '--'}</td>
        <td>${t.price?.toFixed(2) || '--'}</td>
        <td>${t.confidence ? (t.confidence * 100).toFixed(0) + '%' : '--'}</td>
      </tr>
    `).join('');
  } catch (e) { console.error('Trades refresh error', e); }
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
            label: 'Equity (USDT)',
            data: balances,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#2a2d3a' }, ticks: { color: '#8b8fa3', maxTicksLimit: 10 } },
            y: { grid: { color: '#2a2d3a' }, ticks: { color: '#8b8fa3' } },
          }
        }
      });
    } else {
      equityChart.data.labels = labels;
      equityChart.data.datasets[0].data = balances;
      equityChart.update('none');
    }
  } catch (e) { console.error('Chart refresh error', e); }
}

async function refreshDailyPnl() {
  try {
    const pnl = await (await fetch('/api/daily-pnl')).json();
    if (pnl.length > 0) {
      const today = pnl[0];
      const diff = (today.ending_balance || 0) - (today.starting_balance || 0);
      const pct = today.starting_balance > 0 ? (diff / today.starting_balance * 100) : 0;
      const el = document.getElementById('daily-pnl');
      el.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2) + ' USDT';
      el.className = 'stat ' + (diff >= 0 ? 'positive' : 'negative');
      document.getElementById('daily-pnl-pct').textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '% today';
    }
  } catch (e) { console.error('Daily PnL error', e); }
}

function refreshAll() {
  refreshStatus();
  refreshTrades();
  refreshEquityChart();
  refreshDailyPnl();
}

// Init
initWebSocket();
refreshAll();
setInterval(refreshAll, 30000);
