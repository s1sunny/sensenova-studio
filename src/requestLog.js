const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOGS_FILE = path.join(DATA_DIR, 'request_logs.json');
const MAX_LOGS = 5000;

let logs = [];

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOGS_FILE)) fs.writeFileSync(LOGS_FILE, '[]');
  load();
}

function load() {
  try {
    logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    if (!Array.isArray(logs)) logs = [];
  } catch (e) {
    logs = [];
    save();
  }
  logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return logs;
}

function save() {
  try {
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
  } catch (e) {
    /* ignore */
  }
  return logs;
}

function genLogId() {
  return (
    'req_' +
    Date.now().toString(36) +
    '_' +
    crypto.randomBytes(3).toString('hex')
  );
}

function add(entry) {
  entry = entry || {};
  logs.unshift({
    id: entry.id || genLogId(),
    taskId: entry.taskId || null,
    type: entry.type || 'gen',
    status: entry.status === 'fail' ? 'fail' : 'ok',
    prompt: String(entry.prompt || '').slice(0, 200),
    code: entry.code || null,
    message: String(entry.message || '').slice(0, 300),
    costMs: entry.costMs || 0,
    createdAt: entry.createdAt || Math.floor(Date.now() / 1000)
  });
  if (logs.length > MAX_LOGS) logs = logs.slice(0, MAX_LOGS);
  save();
  return logs[0];
}

function list(opts) {
  opts = opts || {};
  let page = parseInt(opts.page, 10) || 1;
  let pageSize = parseInt(opts.pageSize, 10) || 20;
  if (page < 1) page = 1;
  if (pageSize < 1) pageSize = 20;
  if (pageSize > 100) pageSize = 100;

  let items = logs.slice();
  if (opts.status) {
    const want = String(opts.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (want.length) {
      const set = new Set(want);
      items = items.filter((l) => set.has(l.status));
    }
  }
  if (opts.type) {
    const want = String(opts.type).split(',').map((s) => s.trim()).filter(Boolean);
    if (want.length) {
      const set = new Set(want);
      items = items.filter((l) => set.has(l.type));
    }
  }
  if (opts.search) {
    const s = String(opts.search).toLowerCase();
    items = items.filter(
      (l) =>
        String(l.id || '').toLowerCase().includes(s) ||
        String(l.taskId || '').toLowerCase().includes(s) ||
        String(l.message || '').toLowerCase().includes(s)
    );
  }

  const total = items.length;
  const start = (page - 1) * pageSize;
  return {
    total,
    page,
    pageSize,
    items: items.slice(start, start + pageSize)
  };
}

function stats() {
  let ok = 0,
    fail = 0;
  for (const l of logs) {
    if (l.status === 'fail') fail++;
    else ok++;
  }
  return { total: logs.length, ok, fail };
}

function clear() {
  const removed = logs.length;
  logs = [];
  save();
  return removed;
}

module.exports = { init, load, save, add, list, stats, clear };
