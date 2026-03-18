const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express(); // nosemgrep: express-check-csurf-middleware-usage
const PORT = process.env.PORT || 3000;
const DOCKER_HOST = process.env.DOCKER_HOST || 'tcp://socket-proxy:2375';
const dockerBaseUrl = DOCKER_HOST.replace('tcp://', 'http://');

const docker = axios.create({
  baseURL: dockerBaseUrl,
  timeout: 30000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── CSRF protection ─────────────────────────────────────────────────────────
// All mutating state lives in the Docker daemon, not this app, so there are no
// POST/PUT/DELETE routes. Nevertheless, block cross-origin reads of the API by
// validating the Origin (or Referer) header on every /api request.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin || req.headers.referer;
  // Requests with no Origin/Referer come from the same page (same-origin fetch
  // without CORS), which is safe to allow.
  if (!origin) return next();

  try {
    const requestHost = new URL(origin).host;
    const serverHost  = req.headers.host;
    if (requestHost !== serverHost) {
      return res.status(403).json({ error: 'Forbidden: cross-origin request rejected' });
    }
  } catch {
    return res.status(403).json({ error: 'Forbidden: invalid origin' });
  }
  next();
});

// ─── /proc helpers ──────────────────────────────────────────────────────────

function readProc(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function parseCpuInfo() {
  const content = readProc('/host/proc/cpuinfo');
  if (!content) return null;

  const procs = [];
  let cur = {};
  for (const line of content.split('\n')) {
    if (line.trim() === '') {
      if (Object.keys(cur).length) { procs.push(cur); cur = {}; }
    } else {
      const idx = line.indexOf(':');
      if (idx !== -1) cur[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  const physicalCores = new Set(procs.map(p => `${p['physical id']}-${p['core id']}`)).size;
  return {
    model: procs[0]?.['model name'] || 'Unknown',
    logical: procs.length,
    physical: physicalCores || procs.length,
    mhz: procs[0]?.['cpu MHz'] ? parseFloat(procs[0]['cpu MHz']) : null,
    cache: procs[0]?.['cache size'] || null,
    vendor: procs[0]?.['vendor_id'] || null,
    architecture: procs[0]?.['flags']?.includes('lm') ? 'x86_64' : 'x86',
  };
}

function parseMemInfo() {
  const content = readProc('/host/proc/meminfo');
  if (!content) return null;

  const mem = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = parseInt(m[2]) * 1024;
  }

  return {
    total: mem.MemTotal || 0,
    available: mem.MemAvailable || 0,
    used: (mem.MemTotal || 0) - (mem.MemAvailable || 0),
    free: mem.MemFree || 0,
    cached: mem.Cached || 0,
    buffers: mem.Buffers || 0,
    swapTotal: mem.SwapTotal || 0,
    swapFree: mem.SwapFree || 0,
    swapUsed: (mem.SwapTotal || 0) - (mem.SwapFree || 0),
  };
}

function parseUptime() {
  const content = readProc('/host/proc/uptime');
  if (!content) return null;
  return parseFloat(content.split(' ')[0]);
}

function parseLoadAvg() {
  const content = readProc('/host/proc/loadavg');
  if (!content) return null;
  const [one, five, fifteen, procs] = content.trim().split(' ');
  return { one: parseFloat(one), five: parseFloat(five), fifteen: parseFloat(fifteen), processes: procs };
}

function parseKernelVersion() {
  const content = readProc('/host/proc/version');
  if (!content) return null;
  const m = content.match(/Linux version (\S+)/);
  return m ? m[1] : null;
}

function parseOsRelease() {
  const content = readProc('/host/etc/os-release');
  if (!content) return null;
  const info = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^(\w+)="?([^"]*)"?/);
    if (m) info[m[1]] = m[2];
  }
  return {
    name: info.PRETTY_NAME || info.NAME || 'Unknown',
    id: info.ID || '',
    version: info.VERSION || info.VERSION_ID || '',
    homeUrl: info.HOME_URL || '',
  };
}

function parseNetworkInterfaces() {
  const content = readProc('/host/proc/net/dev');
  if (!content) return null;

  const interfaces = [];
  for (const line of content.split('\n').slice(2)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 17) continue;
    const name = parts[0].replace(':', '');
    if (/^(lo|veth|br-|docker)/.test(name)) continue;
    interfaces.push({
      name,
      rxBytes: parseInt(parts[1]),
      rxPackets: parseInt(parts[2]),
      rxErrors: parseInt(parts[3]),
      txBytes: parseInt(parts[9]),
      txPackets: parseInt(parts[10]),
      txErrors: parseInt(parts[11]),
    });
  }
  return interfaces;
}

// ─── CPU usage sampling ──────────────────────────────────────────────────────

function readCpuStats() {
  const content = readProc('/host/proc/stat');
  if (!content) return null;
  const line = content.split('\n').find(l => l.startsWith('cpu '));
  if (!line) return null;
  const vals = line.split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = vals;
  return { user, nice, system, idle: idle + iowait, total: vals.reduce((a, b) => a + b, 0) };
}

let prevCpuSample = readCpuStats();
let currCpuSample = readCpuStats();

setInterval(() => {
  prevCpuSample = currCpuSample;
  currCpuSample = readCpuStats();
}, 3000);

function getCpuUsage() {
  if (!prevCpuSample || !currCpuSample) return null;
  const totalDelta = currCpuSample.total - prevCpuSample.total;
  const idleDelta = currCpuSample.idle - prevCpuSample.idle;
  if (totalDelta === 0) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/api/host', (req, res) => {
  res.json({
    hostname: os.hostname(),
    cpu: parseCpuInfo(),
    cpuUsage: getCpuUsage(),
    memory: parseMemInfo(),
    uptime: parseUptime(),
    loadAvg: parseLoadAvg(),
    kernel: parseKernelVersion(),
    os: parseOsRelease(),
    network: parseNetworkInterfaces(),
  });
});

app.get('/api/docker/info', async (req, res) => {
  try {
    const { data } = await docker.get('/info');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Docker daemon unreachable', detail: err.message });
  }
});

app.get('/api/containers', async (req, res) => {
  try {
    const { data: list } = await docker.get('/containers/json?all=true');

    const detailed = await Promise.allSettled(
      list.map(c => docker.get(`/containers/${c.Id}/json`).then(r => ({ ...c, inspect: r.data })))
    );

    res.json(detailed.map((r, i) => r.status === 'fulfilled' ? r.value : list[i]));
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get('/api/containers/:id/stats', async (req, res) => {
  try {
    const { data } = await docker.get(`/containers/${req.params.id}/stats?stream=false`);
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get('/api/images', async (req, res) => {
  try {
    const { data } = await docker.get('/images/json');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get('/api/networks', async (req, res) => {
  try {
    const { data } = await docker.get('/networks');
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get('/api/volumes', async (req, res) => {
  try {
    const { data } = await docker.get('/volumes');
    res.json(data.Volumes || []);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Docker Dashboard → http://localhost:${PORT}`));
