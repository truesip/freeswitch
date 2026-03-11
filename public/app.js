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

async function loadCalls() {
  try {
    const res = await fetch('/api/calls?limit=100');
    const rows = await res.json();
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
  } catch (err) {
    console.error('calls error', err);
  }
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
