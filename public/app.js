const navButtons = document.querySelectorAll('.sidebar nav button');
const views = document.querySelectorAll('.view');

navButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    navButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.target;
    views.forEach((v) => v.classList.toggle('active', v.id === target));
  });
});

let chart;
let callsPage = 1;
const callsPageSize = 10;
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    document.getElementById('stat-total').textContent = data.totals?.total ?? '-';
    document.getElementById('stat-placed').textContent = data.totals?.placed ?? '-';
    document.getElementById('stat-failed').textContent = data.totals?.failed ?? '-';
    document.getElementById('stat-today').textContent = data.totals?.today ?? '-';
    document.getElementById('stat-concurrent').textContent = data.concurrent ?? '-';

    const labels = (data.last7 || []).map((d) => new Date(d.day).toLocaleDateString());
    const counts = (data.last7 || []).map((d) => d.count);
    const ctx = document.getElementById('chart-calls').getContext('2d');
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Calls',
            data: counts,
            backgroundColor: '#22d3ee'
          }
        ]
      },
      options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } } }
    });
  } catch (err) {
    console.error('stats error', err);
  }
}

async function loadCalls(page = callsPage) {
  try {
    callsPage = page;
    const params = new URLSearchParams({ page: callsPage, limit: callsPageSize });
    const res = await fetch(`/api/calls?${params.toString()}`);
    const payload = await res.json();
    const rows = Array.isArray(payload) ? payload : payload.data || [];
    const total = Array.isArray(payload) ? rows.length : payload.total ?? rows.length;
    const pages = Array.isArray(payload)
      ? Math.max(1, Math.ceil(rows.length / callsPageSize))
      : payload.pages || Math.max(1, Math.ceil((payload.total || rows.length) / callsPageSize));
    const tbody = document.getElementById('calls-body');
    tbody.innerHTML = '';
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(r.createdAt).toLocaleString()}</td>
        <td>${r.fromNumber || ''}</td>
        <td>${r.toNumber || ''}</td>
        <td><span class="status-pill ${r.status === 'placed' ? 'ok' : 'err'}">${r.status}</span></td>
        <td>${r.durationSec ?? ''}</td>
        <td>${r.amdStatus ?? ''}</td>
        <td>${r.jobId || r.error || ''}</td>
      `;
      tbody.appendChild(tr);
    });
    updatePagination(total, pages);
  } catch (err) {
    console.error('calls error', err);
  }
}
function updatePagination(total, pages) {
  const info = document.getElementById('calls-page-info');
  const prev = document.getElementById('calls-prev');
  const next = document.getElementById('calls-next');
  if (!info || !prev || !next) return;
  info.textContent = `Page ${callsPage} of ${pages || 1}${total ? ` (${total} total)` : ''}`;
  prev.disabled = callsPage <= 1;
  next.disabled = callsPage >= (pages || 1);
}

const serverForm = document.getElementById('server-form');
serverForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(serverForm);
  const payload = Object.fromEntries(formData.entries());
  const msg = document.getElementById('server-msg');
  msg.textContent = 'Saving...';
  try {
    const res = await fetch('/api/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      msg.textContent = `Saved. Reconnecting to ${data.ariHost || payload.ariHost}...`;
    } else {
      msg.textContent = data.error || 'Save failed';
    }
  } catch (err) {
    msg.textContent = 'Save failed';
  }
});

function tick() {
  loadStats();
  loadCalls();
}
tick();
setInterval(tick, 10000);

document.getElementById('calls-prev')?.addEventListener('click', () => {
  if (callsPage > 1) loadCalls(callsPage - 1);
});
document.getElementById('calls-next')?.addEventListener('click', () => {
  loadCalls(callsPage + 1);
});
