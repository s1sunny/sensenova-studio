const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const settings = require('./settings');
const config = require('./config');
const throttle = require('./throttle');
const api = require('./api');
const artifacts = require('./artifacts');
const requestLog = require('./requestLog');

const MODEL = 'sensenova-u1.5-lite';
const DATA_DIR = path.join(__dirname, '..', 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const MAX_COUNT = 9;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 4;

let tasks = new Map();
let pendingIds = [];
let running = 0;
let _doneListeners = [];

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]');
  load();
}

function load() {
  tasks = new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    if (Array.isArray(arr)) {
      arr.forEach((t) => {
        if (!t || !t.id) return;
        if (t.status === 'running') {
          t.status = 'pending';
          t.startedAt = null;
        }
        delete t._images;
        tasks.set(t.id, t);
      });
    }
  } catch (e) {
    tasks = new Map();
  }
  tasks.forEach((t) => {
    if (t.status === 'pending' && t.type === 'edit' && (!Array.isArray(t._images) || t._images.length === 0)) {
      t.status = 'failed';
      t.error = { type: 'invalid_request_error', code: 400, message: '改图输入图片已失效，请重新提交' };
      t.finishedAt = Math.floor(Date.now() / 1000);
    }
  });
  pendingIds = Array.from(tasks.values())
    .filter((t) => t.status === 'pending')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((t) => t.id);
  running = 0;
  return tasks;
}

function persist() {
  try {
    const arr = Array.from(tasks.values()).map((t) => {
      const copy = Object.assign({}, t);
      delete copy._images;
      return copy;
    });
    fs.writeFileSync(TASKS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error('[taskQueue] persist failed:', e && e.message);
  }
}

function genTaskId() {
  return 'tsk_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function getConcurrency() {
  const n = parseInt(settings.get('maxConcurrency'), 10);
  if (!n || n < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  if (n > MAX_CONCURRENCY) return MAX_CONCURRENCY;
  return n;
}

function addTasks(type, params, images, count) {
  if (type !== 'gen' && type !== 'edit') {
    throw { type: 'invalid_request_error', message: 'type 必须为 gen 或 edit' };
  }
  count = Math.max(1, Math.min(MAX_COUNT, parseInt(count, 10) || 1));

  const now = Math.floor(Date.now() / 1000);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = genTaskId();
    const task = {
      id,
      type,
      params: { ...params },
      _images: type === 'edit' && Array.isArray(images) ? images : [],
      status: 'pending',
      result: null,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null
    };
    tasks.set(id, task);
    pendingIds.push(id);
    ids.push(id);
  }
  persist();
  pump();
  return ids;
}

function pump() {
  const limit = getConcurrency();
  while (pendingIds.length > 0 && running < limit) {
    const id = pendingIds.shift();
    const task = tasks.get(id);
    if (!task || task.status !== 'pending') continue;

    running++;
    task.status = 'running';
    task.startedAt = Math.floor(Date.now() / 1000);
    persist();
    executeTask(task)
      .catch(() => {})
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function buildArtifact(task, result) {
  let imageBuffer = null;
  const ext = task.params.output_format || 'png';

  if (result.source === 'b64_json' && result.data) {
    imageBuffer = Buffer.from(result.data, 'base64');
  } else if (result.source === 'url' && result.data) {
    imageBuffer = await api.downloadImage(result.data);
  } else {
    throw { type: 'invalid_response', code: 500, message: 'API 返回无可落盘的图片数据' };
  }

  const meta = artifacts.save(
    task.id,
    task.type,
    {
      prompt: task.params.prompt,
      params: {
        size: task.params.size,
        watermark: task.params.watermark,
        output_format: task.params.output_format,
        response_format: task.params.response_format,
        prompt_extend: task.params.prompt_extend,
        n: 1
      },
      model: MODEL,
      source: result.source
    },
    imageBuffer,
    ext
  );

  return {
    taskId: task.id,
    imageUrl: '/api/artifacts/' + task.id + '/image',
    created: meta.created,
    meta
  };
}

async function executeTask(task) {
  const apiKey = config.get().apiKey;
  const start = Date.now();

  if (!apiKey) {
    finishTask(task, 'failed', null, {
      type: 'no_api_key',
      code: 400,
      message: '尚未配置 API Key，请到「设置」页面填写'
    });
    requestLog.add({
      taskId: task.id, type: task.type, status: 'fail',
      prompt: task.params && task.params.prompt, code: 400,
      message: '未配置 API Key', costMs: 0
    });
    return;
  }

  try {
    await throttle.throttle();
    let result;
    if (task.type === 'gen') {
      result = await api.generate({ ...task.params, apiKey });
    } else {
      result = await api.edit({ ...task.params, images: task._images || [], apiKey });
    }

    const resp = await buildArtifact(task, result);
    requestLog.add({
      taskId: task.id, type: task.type, status: 'ok',
      prompt: task.params && task.params.prompt,
      costMs: Date.now() - start
    });
    finishTask(task, 'done', resp, null);
  } catch (err) {
    requestLog.add({
      taskId: task.id, type: task.type, status: 'fail',
      prompt: task.params && task.params.prompt,
      code: (err && err.code) || 500,
      message: (err && err.message) || '生成失败',
      costMs: Date.now() - start
    });
    finishTask(task, 'failed', null, {
      type: (err && err.type) || 'api_error',
      code: (err && err.code) || 500,
      message: (err && err.message) || '生成失败'
    });
  } finally {
    delete task._images;
  }
}

function finishTask(task, status, result, error) {
  task.status = status;
  task.result = result;
  task.error = error;
  task.finishedAt = Math.floor(Date.now() / 1000);
  persist();
  notifyDone(task);
}

function notifyDone(task) {
  _doneListeners.forEach((fn) => {
    try { fn(task); } catch (e) { /* noop */ }
  });
}

function onTaskDone(callback) {
  if (typeof callback === 'function') _doneListeners.push(callback);
}

function getTask(id) {
  return tasks.get(id) || null;
}

function listTasks(opts) {
  opts = opts || {};
  let page = parseInt(opts.page, 10) || 1;
  let pageSize = parseInt(opts.pageSize, 10) || 20;
  if (page < 1) page = 1;
  if (pageSize < 1) pageSize = 20;

  let items = Array.from(tasks.values()).sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
  );

  if (opts.status) {
    const want = String(opts.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (want.length) {
      const set = new Set(want);
      items = items.filter((t) => set.has(t.status));
    }
  }

  const total = items.length;
  const start = (page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  const slim = pageItems.map(function (t) {
    const copy = Object.assign({}, t);
    delete copy._images;
    return copy;
  });

  return { total, page, pageSize, items: slim };
}

function cancelTask(id) {
  const task = tasks.get(id);
  if (!task || task.status !== 'pending') return false;
  task.status = 'canceled';
  task.finishedAt = Math.floor(Date.now() / 1000);
  pendingIds = pendingIds.filter((x) => x !== id);
  delete task._images;
  persist();
  return true;
}

function getStats() {
  const stats = { pending: 0, running: 0, done: 0, failed: 0, canceled: 0 };
  for (const t of tasks.values()) {
    if (stats[t.status] !== undefined) stats[t.status]++;
  }
  return stats;
}

function clearFinished() {
  let removed = 0;
  for (const [id, t] of tasks) {
    if (t.status === 'done' || t.status === 'failed' || t.status === 'canceled') {
      tasks.delete(id);
      removed++;
    }
  }
  persist();
  return removed;
}

module.exports = {
  init,
  addTasks,
  getTask,
  listTasks,
  cancelTask,
  getStats,
  clearFinished,
  onTaskDone
};
