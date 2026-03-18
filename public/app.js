'use strict';

// ── State ─────────────────────────────────────────────────────────────────
const S = {
  containers: [],
  images:     [],
  networks:   [],
  volumes:    [],
  dockerInfo: null,
  hostInfo:   null,
  stats:      {},       // id → { cpu, memUsed, memLimit, memPercent }
  activeTab:  'overview',
  search:     '',
  filter:     'all',
  lastUpdated: null,
  countdown:  30,
};

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupSearch();
  setupFilters();
  document.getElementById('btn-refresh').addEventListener('click', () => fetchAll());
  fetchAll();

  // Auto-refresh countdown
  setInterval(() => {
    S.countdown--;
    if (S.countdown <= 0) { fetchAll(); return; }
    const el = document.getElementById('refresh-status');
    if (el) el.textContent = `Auto-refresh in ${S.countdown}s`;
  }, 1000);
});

// ── Tab navigation ────────────────────────────────────────────────────────
function setupTabs() {
  document.getElementById('tabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    switchTab(btn.dataset.tab);
  });
}

function switchTab(tab) {
  S.activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
}

// ── Search & filter ───────────────────────────────────────────────────────
function setupSearch() {
  document.getElementById('container-search').addEventListener('input', e => {
    S.search = e.target.value.toLowerCase();
    renderContainers();
  });
}

function setupFilters() {
  document.getElementById('container-filters').addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    S.filter = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === S.filter));
    renderContainers();
  });
}

// ── Fetch ─────────────────────────────────────────────────────────────────
async function fetchAll() {
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('spinning');
  S.countdown = 30;

  try {
    const [containers, images, networks, volumes, dockerInfo, hostInfo] = await Promise.all([
      api('/api/containers'),
      api('/api/images'),
      api('/api/networks'),
      api('/api/volumes'),
      api('/api/docker/info'),
      api('/api/host'),
    ]);

    S.containers = Array.isArray(containers) ? containers : [];
    S.images     = Array.isArray(images)     ? images     : [];
    S.networks   = Array.isArray(networks)   ? networks   : [];
    S.volumes    = Array.isArray(volumes)    ? volumes    : [];
    S.dockerInfo = dockerInfo;
    S.hostInfo   = hostInfo;
    S.lastUpdated = new Date();

    hideLoading();
    renderAll();

    // Lazily load container stats
    fetchStats();
  } catch (err) {
    console.error(err);
  } finally {
    btn.classList.remove('spinning');
    updateRefreshLabel();
  }
}

async function api(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function fetchStats() {
  const running = S.containers.filter(c => c.State === 'running');
  await Promise.allSettled(running.map(async c => {
    try {
      const raw = await api(`/api/containers/${c.Id}/stats`);
      S.stats[c.Id] = calcStats(raw);
      updateStatsDOM(c.Id);
    } catch { /* skip */ }
  }));
}

function calcStats(raw) {
  // CPU
  const cpuDelta    = (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) - (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta    = (raw.cpu_stats?.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
  const numCpus     = raw.cpu_stats?.online_cpus || raw.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cpu         = sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * numCpus * 1000) / 10 : 0;

  // Memory (handle cgroup v1 and v2)
  const usage       = raw.memory_stats?.usage ?? 0;
  const cache       = raw.memory_stats?.stats?.cache ?? raw.memory_stats?.stats?.inactive_file ?? 0;
  const memUsed     = Math.max(0, usage - cache);
  const memLimit    = raw.memory_stats?.limit ?? 0;
  const memPercent  = memLimit > 0 ? Math.round((memUsed / memLimit) * 1000) / 10 : 0;

  return { cpu, memUsed, memLimit, memPercent };
}

// ── Render all ────────────────────────────────────────────────────────────
function renderAll() {
  updateBadges();
  renderOverview();
  renderContainers();
  renderImages();
  renderNetworks();
  renderVolumes();
}

function updateBadges() {
  set('badge-containers', S.containers.length);
  set('badge-images',     S.images.length);
  set('badge-networks',   S.networks.length);
  set('badge-volumes',    S.volumes.length);
}

// ── Overview ──────────────────────────────────────────────────────────────
function renderOverview() {
  const running  = S.containers.filter(c => c.State === 'running').length;
  const stopped  = S.containers.filter(c => c.State !== 'running').length;

  // Summary stat cards
  html('summary-cards', [
    statCard('Containers', S.containers.length, `${running} running · ${stopped} stopped`, '📦',
             'linear-gradient(90deg,#388bfd,#22d3ee)'),
    statCard('Images',     S.images.length,     `${S.images.length} available`, '🖼',
             'linear-gradient(90deg,#8b5cf6,#c084fc)'),
    statCard('Networks',   S.networks.length,   `${S.networks.length} defined`, '🌐',
             'linear-gradient(90deg,#22d3ee,#4ade80)'),
    statCard('Volumes',    S.volumes.length,     `${S.volumes.length} defined`, '💾',
             'linear-gradient(90deg,#fbbf24,#fb923c)'),
  ].join(''));

  // Host card
  html('host-card', renderHostCard());

  // Docker info card
  html('docker-card', renderDockerCard());

  // Network interfaces
  html('network-card', renderNetworkInterfacesCard());
}

function statCard(label, value, sub, icon, grad) {
  return `<div class="stat-card" style="--accent-grad:${grad}">
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div>
    <div class="stat-sub">${sub}</div>
    <div class="stat-icon">${icon}</div>
  </div>`;
}

function renderHostCard() {
  const h = S.hostInfo;
  if (!h) return `<div class="card"><div class="card-title">Host Machine</div><div class="error-msg">Host info unavailable</div></div>`;

  const cpuPct  = h.cpuUsage ?? 0;
  const mem     = h.memory;
  const memPct  = mem ? Math.round((mem.used / mem.total) * 1000) / 10 : 0;
  const swapPct = mem && mem.swapTotal > 0 ? Math.round((mem.swapUsed / mem.swapTotal) * 1000) / 10 : 0;
  const uptime  = h.uptime ? fmtUptime(h.uptime) : 'N/A';
  const load    = h.loadAvg ? `${h.loadAvg.one} · ${h.loadAvg.five} · ${h.loadAvg.fifteen}` : 'N/A';

  return `<div class="card">
    <div class="card-header">
      <div class="card-title">🖥 Host Machine</div>
      <span class="badge badge-blue mono" style="font-size:0.7rem">${esc(h.hostname || 'unknown')}</span>
    </div>

    <div style="margin-bottom:0.75rem">
      <div class="detail-label">Operating System</div>
      <div class="detail-value">${esc(h.os?.name || 'Unknown')}
        ${h.os?.homeUrl ? `<a href="${esc(h.os.homeUrl)}" target="_blank" class="info-link" style="margin-left:0.5rem;font-size:0.72rem">
          ${linkIcon()} OS Info</a>` : ''}
      </div>
      <div class="detail-value mono" style="font-size:0.78rem;margin-top:0.2rem;color:var(--muted)">Kernel ${esc(h.kernel || 'N/A')}</div>
    </div>

    ${h.cpu ? `<div style="margin-bottom:0.75rem">
      <div class="detail-label">CPU &mdash; ${esc(h.cpu.model)}</div>
      <div class="detail-value" style="font-size:0.8rem">
        ${h.cpu.logical} threads · ${h.cpu.physical} cores
        ${h.cpu.mhz ? `· ${Math.round(h.cpu.mhz)} MHz` : ''}
        ${h.cpu.cache ? `· ${esc(h.cpu.cache)} cache` : ''}
      </div>
    </div>` : ''}

    <div class="host-metrics">
      <div class="metric">
        <div class="metric-name">CPU Usage</div>
        <div class="metric-val">${cpuPct}%</div>
        <div class="progress-wrap"><div class="progress-bar cpu-bar" style="width:${Math.min(cpuPct,100)}%"></div></div>
      </div>
      ${mem ? `<div class="metric">
        <div class="metric-name">Memory</div>
        <div class="metric-val">${fmtBytes(mem.used)}<span style="font-size:0.8rem;font-weight:400;color:var(--text2)"> / ${fmtBytes(mem.total)}</span></div>
        <div class="metric-sub">${memPct}% used · ${fmtBytes(mem.cached)} cached</div>
        <div class="progress-wrap"><div class="progress-bar mem-bar" style="width:${Math.min(memPct,100)}%"></div></div>
      </div>
      ${mem.swapTotal > 0 ? `<div class="metric">
        <div class="metric-name">Swap</div>
        <div class="metric-val">${fmtBytes(mem.swapUsed)}<span style="font-size:0.8rem;font-weight:400;color:var(--text2)"> / ${fmtBytes(mem.swapTotal)}</span></div>
        <div class="metric-sub">${swapPct}% used</div>
        <div class="progress-wrap"><div class="progress-bar swap-bar" style="width:${Math.min(swapPct,100)}%"></div></div>
      </div>` : ''}
      <div class="metric">
        <div class="metric-name">Uptime</div>
        <div class="metric-val" style="font-size:0.95rem">${uptime}</div>
      </div>
      <div class="metric">
        <div class="metric-name">Load Avg (1/5/15m)</div>
        <div class="metric-val" style="font-size:0.85rem;font-family:monospace">${load}</div>
      </div>` : ''}
    </div>
  </div>`;
}

function renderDockerCard() {
  const d = S.dockerInfo;
  if (!d) return `<div class="card"><div class="card-title">Docker Engine</div><div class="error-msg">Docker info unavailable</div></div>`;

  const rows = [
    ['Version',        d.ServerVersion],
    ['API Version',    d.ApiVersion],
    ['OS / Arch',      `${d.OperatingSystem || d.OSType} / ${d.Architecture}`],
    ['Kernel',         d.KernelVersion],
    ['Storage Driver', d.Driver],
    ['Logging Driver', d.LoggingDriver],
    ['Cgroup Driver',  d.CgroupDriver],
    ['Root Dir',       d.DockerRootDir],
    ['Registry',       d.IndexServerAddress],
    ['Experimental',   d.ExperimentalBuild ? 'Yes' : 'No'],
  ].filter(([, v]) => v);

  const swarmState = d.Swarm?.LocalNodeState || 'inactive';

  return `<div class="card">
    <div class="card-header">
      <div class="card-title">🐋 Docker Engine</div>
      <a href="https://docs.docker.com/engine/release-notes/" target="_blank" class="info-link">
        ${linkIcon()} Release Notes
      </a>
    </div>

    <div class="host-metrics" style="margin-bottom:0.75rem">
      <div class="metric">
        <div class="metric-name">Running</div>
        <div class="metric-val" style="color:var(--green)">${d.ContainersRunning ?? 0}</div>
      </div>
      <div class="metric">
        <div class="metric-name">Stopped</div>
        <div class="metric-val" style="color:var(--muted)">${d.ContainersStopped ?? 0}</div>
      </div>
      <div class="metric">
        <div class="metric-name">Paused</div>
        <div class="metric-val" style="color:var(--purple)">${d.ContainersPaused ?? 0}</div>
      </div>
      <div class="metric">
        <div class="metric-name">Swarm</div>
        <div class="metric-val" style="font-size:0.85rem;text-transform:capitalize">${swarmState}</div>
      </div>
    </div>

    <div class="nv-rows">
      ${rows.map(([k,v]) => `<div class="nv-row">
        <span class="nv-key">${esc(k)}</span>
        <span class="nv-val">${esc(String(v))}</span>
      </div>`).join('')}
    </div>
  </div>`;
}

function renderNetworkInterfacesCard() {
  const ifaces = S.hostInfo?.network;
  if (!ifaces || ifaces.length === 0) return '';

  return `<div class="card">
    <div class="card-header">
      <div class="card-title">📡 Network Interfaces (Host)</div>
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
        <thead>
          <tr style="color:var(--muted);text-align:left;border-bottom:1px solid var(--border)">
            <th style="padding:0.4rem 0.75rem">Interface</th>
            <th style="padding:0.4rem 0.75rem">RX Bytes</th>
            <th style="padding:0.4rem 0.75rem">RX Packets</th>
            <th style="padding:0.4rem 0.75rem">TX Bytes</th>
            <th style="padding:0.4rem 0.75rem">TX Packets</th>
            <th style="padding:0.4rem 0.75rem">Errors</th>
          </tr>
        </thead>
        <tbody>
          ${ifaces.map(i => `<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
            <td style="padding:0.45rem 0.75rem;font-weight:700;color:var(--cyan)">${esc(i.name)}</td>
            <td style="padding:0.45rem 0.75rem;font-family:monospace">${fmtBytes(i.rxBytes)}</td>
            <td style="padding:0.45rem 0.75rem;font-family:monospace">${i.rxPackets.toLocaleString()}</td>
            <td style="padding:0.45rem 0.75rem;font-family:monospace">${fmtBytes(i.txBytes)}</td>
            <td style="padding:0.45rem 0.75rem;font-family:monospace">${i.txPackets.toLocaleString()}</td>
            <td style="padding:0.45rem 0.75rem;font-family:monospace;color:${(i.rxErrors+i.txErrors)>0?'var(--red)':'var(--muted)'}">
              ${i.rxErrors + i.txErrors}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

// ── Containers ────────────────────────────────────────────────────────────
function renderContainers() {
  let list = S.containers;

  if (S.filter === 'running') list = list.filter(c => c.State === 'running');
  if (S.filter === 'stopped') list = list.filter(c => c.State !== 'running');

  if (S.search) {
    list = list.filter(c => {
      const name = (c.Names?.[0] || '').toLowerCase();
      const img  = (c.Image || '').toLowerCase();
      return name.includes(S.search) || img.includes(S.search);
    });
  }

  if (list.length === 0) {
    html('containers-list', '<div class="empty">No containers match your filter.</div>');
    return;
  }

  // Group by compose project; standalone containers go under null key
  const groups = new Map();
  for (const c of list) {
    const labels  = c.inspect?.Config?.Labels || c.Labels || {};
    const project = labels['com.docker.compose.project'] || null;
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(c);
  }

  // Sort: compose stacks first (alphabetically), then standalone last
  const sorted = [...groups.entries()].sort(([a], [b]) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });

  const parts = sorted.map(([project, containers]) => {
    const runningCount = containers.filter(c => c.State === 'running').length;
    const header = project
      ? `<div class="stack-header">
           <div class="stack-header-left">
             <span class="stack-icon">⬡</span>
             <span class="stack-name">${esc(project)}</span>
             <span class="badge badge-gray">${containers.length} service${containers.length !== 1 ? 's' : ''}</span>
           </div>
           <span class="badge ${runningCount === containers.length ? 'badge-running' : runningCount === 0 ? 'badge-exited' : 'badge-blue'}">
             ${runningCount}/${containers.length} running
           </span>
         </div>`
      : `<div class="stack-header stack-header-standalone">
           <div class="stack-header-left">
             <span class="stack-icon">◻</span>
             <span class="stack-name" style="color:var(--text2)">Standalone</span>
             <span class="badge badge-gray">${containers.length}</span>
           </div>
         </div>`;

    return `<div class="stack-group">${header}<div class="stack-body">${containers.map(containerCard).join('')}</div></div>`;
  });

  html('containers-list', parts.join(''));

  // Wire toggle expand
  document.querySelectorAll('.cc-header').forEach(el => {
    el.addEventListener('click', () => {
      el.closest('.container-card').classList.toggle('open');
    });
  });
}

function containerCard(c) {
  const name       = (c.Names?.[0] || c.Id.slice(0,12)).replace(/^\//, '');
  const state      = c.State || 'unknown';
  const status     = c.Status || state;
  const image      = c.Image || '<none>';
  const inspect    = c.inspect;
  const created    = c.Created ? timeAgo(new Date(c.Created * 1000)) : 'N/A';
  const startedAt  = inspect?.State?.StartedAt;
  const exitCode   = inspect?.State?.ExitCode ?? null;
  const restart    = inspect?.HostConfig?.RestartPolicy;
  const labels     = inspect?.Config?.Labels || c.Labels || {};
  const env        = inspect?.Config?.Env || [];

  // OCI labels
  const ociTitle   = labels['org.opencontainers.image.title'];
  const ociDesc    = labels['org.opencontainers.image.description'];
  const ociVersion = labels['org.opencontainers.image.version'];
  const ociUrl     = labels['org.opencontainers.image.url'] || labels['org.opencontainers.image.source'];
  const ociDocs    = labels['org.opencontainers.image.documentation'];
  const ociVendor  = labels['org.opencontainers.image.vendor'];

  const link       = ociUrl || ociDocs || getImageLink(image)?.url;
  const linkLabel  = ociUrl ? 'Project Site' : ociDocs ? 'Docs' : (getImageLink(image)?.label || 'More Info');

  // Ports
  const ports = (c.Ports || [])
    .filter(p => p.PublicPort)
    .map(p => `${p.IP ? p.IP + ':' : ''}${p.PublicPort}→${p.PrivatePort}/${p.Type}`)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Networks
  const nets = Object.keys(c.NetworkSettings?.Networks || {});

  // Mounts
  const mounts = (c.Mounts || []).map(m => ({
    type: m.Type,
    src: m.Source || m.Name || '',
    dst: m.Destination,
    rw: m.RW,
  }));

  // Filtered env (hide secrets)
  const sensitiveKeys = /password|secret|token|key|api_key|auth|credential/i;
  const safeEnv = env.filter(e => !sensitiveKeys.test(e.split('=')[0])).slice(0, 15);

  // Stats placeholder
  const statsHtml = state === 'running'
    ? `<div class="stats-loading" id="stats-${c.Id}">Loading resource stats…</div>`
    : '';

  const stateClass = state === 'exited' || state === 'dead' ? 'exited' : state;

  return `<div class="container-card" id="cc-${c.Id}">
    <div class="cc-header">
      <div class="status-dot ${stateClass}"></div>
      <div style="flex:1;min-width:0">
        <div class="cc-name">${esc(ociTitle || name)}</div>
        <div class="cc-image">${esc(image)}</div>
      </div>
      <div class="cc-right">
        ${link ? `<a href="${esc(link)}" target="_blank" class="info-link" onclick="event.stopPropagation()">
          ${linkIcon()} ${esc(linkLabel)}
        </a>` : ''}
        <span class="badge badge-${stateClass}">${esc(status)}</span>
        <span class="chevron">›</span>
      </div>
    </div>

    <div class="cc-body">
      <div class="cc-body-inner">

        ${statsHtml}

        ${ociDesc ? `<div style="margin-bottom:0.75rem;color:var(--text2);font-size:0.85rem;font-style:italic">${esc(ociDesc)}</div>` : ''}

        <div class="detail-grid">

          <div class="detail-section">
            <div class="detail-label">Container ID</div>
            <div class="detail-value"><code>${c.Id.slice(0,12)}</code></div>
          </div>

          <div class="detail-section">
            <div class="detail-label">Full Name</div>
            <div class="detail-value"><code>${esc(name)}</code></div>
          </div>

          <div class="detail-section">
            <div class="detail-label">Created</div>
            <div class="detail-value">${created}</div>
          </div>

          ${startedAt && state === 'running' ? `<div class="detail-section">
            <div class="detail-label">Running Since</div>
            <div class="detail-value">${timeAgo(new Date(startedAt))}</div>
          </div>` : ''}

          ${exitCode !== null && state !== 'running' ? `<div class="detail-section">
            <div class="detail-label">Exit Code</div>
            <div class="detail-value" style="color:${exitCode===0?'var(--green)':'var(--red)'}">${exitCode}</div>
          </div>` : ''}

          ${restart?.Name ? `<div class="detail-section">
            <div class="detail-label">Restart Policy</div>
            <div class="detail-value">${esc(restart.Name)}${restart.MaximumRetryCount > 0 ? ` (max ${restart.MaximumRetryCount})` : ''}</div>
          </div>` : ''}

          ${ociVersion ? `<div class="detail-section">
            <div class="detail-label">Version</div>
            <div class="detail-value">${esc(ociVersion)}</div>
          </div>` : ''}

          ${ociVendor ? `<div class="detail-section">
            <div class="detail-label">Vendor</div>
            <div class="detail-value">${esc(ociVendor)}</div>
          </div>` : ''}

        </div>

        ${ports.length ? `<div class="divider"></div>
        <div class="detail-label">Port Mappings</div>
        <div style="margin-top:0.3rem">
          ${ports.map(p => `<span class="detail-value port-map">${esc(p)}</span>`).join('')}
        </div>` : ''}

        ${nets.length ? `<div class="divider"></div>
        <div class="detail-label">Networks</div>
        <div style="margin-top:0.3rem;display:flex;flex-direction:column;gap:0.25rem">
          ${nets.map(n => `<div><span class="detail-value tag">${esc(n)}</span></div>`).join('')}
        </div>` : ''}

        ${mounts.length ? `<div class="divider"></div>
        <div class="detail-label">Volumes / Mounts</div>
        <div style="margin-top:0.4rem;font-size:0.8rem">
          ${mounts.map(m => `<div style="margin-bottom:0.3rem;color:var(--text2)">
            <span class="badge badge-gray" style="margin-right:0.3rem">${esc(m.type)}</span>
            <span class="mono" style="color:var(--muted)">${esc(m.src || 'anonymous')}</span>
            <span style="color:var(--muted)"> → </span>
            <span class="mono">${esc(m.dst)}</span>
            ${!m.rw ? `<span style="color:var(--amber);margin-left:0.3rem;font-size:0.72rem">ro</span>` : ''}
          </div>`).join('')}
        </div>` : ''}

        ${safeEnv.length ? `<div class="divider"></div>
        <div class="detail-label">Environment Variables</div>
        <div style="margin-top:0.4rem;display:flex;flex-wrap:wrap;gap:0.25rem">
          ${safeEnv.map(e => `<code style="font-size:0.75rem;background:rgba(0,0,0,0.3);padding:0.1rem 0.4rem;border-radius:4px;color:var(--text2)">${esc(e)}</code>`).join('')}
          ${env.length > 15 ? `<span style="font-size:0.75rem;color:var(--muted)">+${env.length-15} more</span>` : ''}
        </div>` : ''}

        ${(() => {
          const internalPrefixes = ['com.docker.compose.', 'org.opencontainers.image.', 'com.docker.swarm.'];
          const userLabels = Object.entries(labels).filter(([k]) => !internalPrefixes.some(p => k.startsWith(p)));
          if (!userLabels.length) return '';
          return `<div class="divider"></div>
          <div class="detail-label">Labels</div>
          <div class="label-table">
            ${userLabels.map(([k, v]) => `<div class="label-row">
              <span class="label-key mono">${esc(k)}</span>
              <span class="label-val">${esc(v)}</span>
            </div>`).join('')}
          </div>`;
        })()}

        ${link ? `<div class="divider"></div>
        <div>
          <a href="${esc(link)}" target="_blank" class="info-link">
            ${linkIcon()} View ${esc(linkLabel)}
          </a>
          ${ociDocs && link !== ociDocs ? `<a href="${esc(ociDocs)}" target="_blank" class="info-link" style="margin-left:0.5rem">
            ${linkIcon()} Documentation
          </a>` : ''}
        </div>` : ''}

      </div>
    </div>
  </div>`;
}

function updateStatsDOM(id) {
  const st = S.stats[id];
  const el = document.getElementById(`stats-${id}`);
  if (!el || !st) return;

  el.textContent = '';
  el.appendChild(resourceRow('CPU', `${st.cpu}%`,                          Math.min(st.cpu, 100),        'cpu'));
  el.appendChild(resourceRow('MEM', `${fmtBytes(st.memUsed)} / ${fmtBytes(st.memLimit)}`, Math.min(st.memPercent, 100), 'mem'));
}

function resourceRow(label, valText, pct, cls) {
  const row = document.createElement('div');
  row.className = 'resource-row';

  const lbl = document.createElement('span');
  lbl.className = 'resource-label';
  lbl.textContent = label;

  const wrap = document.createElement('div');
  wrap.className = 'resource-bar-wrap';
  const bar = document.createElement('div');
  bar.className = `resource-bar ${cls}`;
  bar.style.width = `${pct}%`;
  wrap.appendChild(bar);

  const val = document.createElement('span');
  val.className = 'resource-val';
  val.textContent = valText;

  row.appendChild(lbl);
  row.appendChild(wrap);
  row.appendChild(val);
  return row;
}

// ── Images ────────────────────────────────────────────────────────────────
function renderImages() {
  if (!S.images.length) { html('images-list', '<div class="empty">No images found.</div>'); return; }

  // Build a map of image ID → container(s) that use it
  const usedBy = {};
  for (const c of S.containers) {
    const id = c.ImageID || '';
    if (!usedBy[id]) usedBy[id] = [];
    usedBy[id].push((c.Names?.[0] || c.Id.slice(0,8)).replace(/^\//, ''));
  }

  html('images-list', S.images.map(img => {
    const tags  = img.RepoTags?.filter(t => t !== '<none>:<none>') || [];
    const name  = tags[0]?.split(':')[0] || '<none>';
    const tag   = tags[0]?.split(':')[1] || 'latest';
    const size  = fmtBytes(img.Size);
    const link  = getImageLink(tags[0]);
    const users = usedBy[img.Id] || [];

    return `<div class="image-card">
      <div>
        <div class="image-name">${esc(name)}<span class="image-tag">${esc(tag)}</span>
          ${tags.length > 1 ? `<span style="color:var(--muted);font-size:0.75rem"> +${tags.length-1} tags</span>` : ''}
        </div>
        <div class="image-meta">
          <span class="image-id">${img.Id.replace('sha256:','').slice(0,12)}</span>
          · ${size}
          · ${timeAgo(new Date(img.Created * 1000))}
          ${users.length ? `· Used by: ${users.map(u => `<span style="color:var(--cyan)">${esc(u)}</span>`).join(', ')}` : '· <span style="color:var(--muted)">unused</span>'}
        </div>
      </div>
      <div style="display:flex;gap:0.5rem;flex-shrink:0">
        ${link ? `<a href="${esc(link.url)}" target="_blank" class="info-link">${linkIcon()} ${esc(link.label)}</a>` : ''}
      </div>
    </div>`;
  }).join(''));
}

// ── Networks ──────────────────────────────────────────────────────────────
function renderNetworks() {
  if (!S.networks.length) { html('networks-list', '<div class="empty">No networks found.</div>'); return; }

  html('networks-list', S.networks.map(n => {
    const containers = Object.entries(n.Containers || {});
    const ipam = n.IPAM?.Config?.[0];
    return `<div class="nv-card">
      <div class="flex-between" style="margin-bottom:0.6rem">
        <div class="nv-name">${esc(n.Name)}</div>
        <span class="badge badge-blue">${esc(n.Driver)}</span>
      </div>
      <div class="nv-rows">
        <div class="nv-row"><span class="nv-key">ID</span><span class="nv-val">${n.Id.slice(0,12)}</span></div>
        <div class="nv-row"><span class="nv-key">Scope</span><span class="nv-val">${esc(n.Scope)}</span></div>
        ${ipam?.Subnet  ? `<div class="nv-row"><span class="nv-key">Subnet</span><span class="nv-val">${esc(ipam.Subnet)}</span></div>` : ''}
        ${ipam?.Gateway ? `<div class="nv-row"><span class="nv-key">Gateway</span><span class="nv-val">${esc(ipam.Gateway)}</span></div>` : ''}
        <div class="nv-row"><span class="nv-key">Internal</span><span class="nv-val">${n.Internal ? 'Yes' : 'No'}</span></div>
        <div class="nv-row"><span class="nv-key">IPv6</span><span class="nv-val">${n.EnableIPv6 ? 'Yes' : 'No'}</span></div>
        ${n.Created ? `<div class="nv-row"><span class="nv-key">Created</span><span class="nv-val">${timeAgo(new Date(n.Created))}</span></div>` : ''}
      </div>
      ${containers.length ? `<div style="margin-top:0.6rem">
        <div class="detail-label">Connected Containers</div>
        <div style="margin-top:0.3rem;display:flex;flex-wrap:wrap;gap:0.25rem">
          ${containers.map(([, v]) => `<span class="detail-value tag">${esc(v.Name || 'unknown')}</span>`).join('')}
        </div>
      </div>` : ''}
    </div>`;
  }).join(''));
}

// ── Volumes ───────────────────────────────────────────────────────────────
function renderVolumes() {
  if (!S.volumes.length) { html('volumes-list', '<div class="empty">No volumes found.</div>'); return; }

  // Map volume → containers using it
  const volUsage = {};
  for (const c of S.containers) {
    for (const m of c.Mounts || []) {
      if (m.Type === 'volume' && m.Name) {
        if (!volUsage[m.Name]) volUsage[m.Name] = [];
        volUsage[m.Name].push((c.Names?.[0] || c.Id.slice(0,8)).replace(/^\//, ''));
      }
    }
  }

  html('volumes-list', S.volumes.map(v => {
    const users = volUsage[v.Name] || [];
    return `<div class="nv-card">
      <div class="flex-between" style="margin-bottom:0.6rem">
        <div class="nv-name">${esc(v.Name)}</div>
        <span class="badge badge-blue">${esc(v.Driver)}</span>
      </div>
      <div class="nv-rows">
        <div class="nv-row"><span class="nv-key">Mountpoint</span><span class="nv-val">${esc(v.Mountpoint)}</span></div>
        ${v.Scope ? `<div class="nv-row"><span class="nv-key">Scope</span><span class="nv-val">${esc(v.Scope)}</span></div>` : ''}
        ${v.CreatedAt ? `<div class="nv-row"><span class="nv-key">Created</span><span class="nv-val">${timeAgo(new Date(v.CreatedAt))}</span></div>` : ''}
        ${users.length ? `<div class="nv-row"><span class="nv-key">Used by</span><span class="nv-val" style="color:var(--cyan)">${users.map(esc).join(', ')}</span></div>` :
          `<div class="nv-row"><span class="nv-key">Used by</span><span class="nv-val" style="color:var(--muted)">unused</span></div>`}
      </div>
      ${Object.keys(v.Labels || {}).length ? `<div style="margin-top:0.6rem">
        <div class="detail-label">Labels</div>
        <div style="margin-top:0.3rem">
          ${Object.entries(v.Labels).map(([k,val]) =>
            `<div class="nv-row"><span class="nv-key">${esc(k)}</span><span class="nv-val">${esc(val)}</span></div>`
          ).join('')}
        </div>
      </div>` : ''}
    </div>`;
  }).join(''));
}

// ── Image link helper ─────────────────────────────────────────────────────
function getImageLink(imageName) {
  if (!imageName || imageName.startsWith('<none>')) return null;
  const name = imageName.split(':')[0];

  if (name.startsWith('ghcr.io/')) {
    const parts = name.replace('ghcr.io/', '').split('/');
    if (parts.length >= 2)
      return { url: `https://github.com/${parts[0]}/${parts[1]}`, label: 'GitHub' };
  }
  if (name.startsWith('quay.io/'))
    return { url: `https://quay.io/repository/${name.replace('quay.io/','')}`, label: 'Quay.io' };

  if (name.startsWith('lscr.io/linuxserver/'))
    return { url: `https://docs.linuxserver.io/images/docker-${name.replace('lscr.io/linuxserver/','')}`, label: 'LinuxServer Docs' };

  if (name.startsWith('registry.k8s.io/') || name.startsWith('k8s.gcr.io/') || name.startsWith('gcr.io/'))
    return null;

  // DockerHub (no dot in first segment = no custom registry)
  if (!name.includes('.')) {
    const parts = name.split('/');
    if (parts.length === 1)
      return { url: `https://hub.docker.com/_/${parts[0]}`, label: 'Docker Hub' };
    if (parts.length === 2)
      return { url: `https://hub.docker.com/r/${parts[0]}/${parts[1]}`, label: 'Docker Hub' };
  }
  return null;
}

// ── Utilities ─────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (!n || n === 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${Math.round(n * 10) / 10} ${units[i]}`;
}

function fmtUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(' ') || '<1m';
}

function timeAgo(date) {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return date.toLocaleDateString();
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function html(id, markup) {
  const el = document.getElementById(id);
  if (!el) return;
  const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
  el.replaceChildren(...doc.body.childNodes);
}

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function linkIcon() {
  return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
}

function hideLoading() {
  const el = document.getElementById('loading');
  if (el) el.classList.add('hidden');
  setTimeout(() => { if (el) el.style.display = 'none'; }, 400);
}

function updateRefreshLabel() {
  const el = document.getElementById('refresh-status');
  if (!el) return;
  if (S.lastUpdated) {
    el.textContent = `Updated ${S.lastUpdated.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}`;
  }
}
