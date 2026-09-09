const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const api = require('./src/api');
const config = require('./src/config');
const throttle = require('./src/throttle');
const artifacts = require('./src/artifacts');
const settings = require('./src/settings');
const taskQueue = require('./src/taskQueue');
const requestLog = require('./src/requestLog');

const DEFAULT_PORT = 3107;

function resolvePort() {
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT, 10);
    if (p >= 1 && p <= 65535) return p;
  }
  const sp = parseInt(settings.get('port'), 10);
  if (sp >= 1024 && sp <= 65535) return sp;
  return DEFAULT_PORT;
}

const HOST = process.env.HOST || '127.0.0.1';
const MODEL = 'sensenova-u1.5-lite';
const JSON_BODY_LIMIT = '50mb';
const MAX_PROMPT_LENGTH = 4000;
const MAX_TASK_COUNT = 9;
const SIZE_RATIO_LIMIT = 3.01;

const app = express();

app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function ensureData() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  config.init();
  settings.init();
  artifacts.init();
  taskQueue.init();
  requestLog.init();
}
ensureData();

const PORT = resolvePort();

function genArtifactId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts =
    d.getFullYear().toString() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '_' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds());
  const rand = crypto.randomBytes(2).toString('hex');
  return ts + '_' + rand;
}

function isValidSize(size) {
  if (size === 'auto') return true;
  const m = /^(\d+)x(\d+)$/.exec(size || '');
  if (!m) return false;
  const w = parseInt(m[1], 10),
    h = parseInt(m[2], 10);
  if (w < 512 || w > 4096 || h < 512 || h > 4096) return false;
  if (w % 32 !== 0 || h % 32 !== 0) return false;
  const ratio = Math.max(w, h) / Math.min(w, h);
  return ratio <= SIZE_RATIO_LIMIT;
}

function fillParams(body) {
  const size = body.size || settings.get('defaultSize');
  if (!isValidSize(size)) {
    throw {
      type: 'invalid_request_error',
      code: 400,
      message: 'size 不合法：应为 auto 或 WxH（32 倍数，512-4096，比例 ≤3:1）'
    };
  }
  const prompt = String(body.prompt || '').trim();
  if (!prompt) {
    throw { type: 'invalid_request_error', code: 400, message: 'prompt 不能为空' };
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw {
      type: 'invalid_request_error',
      code: 400,
      message: 'prompt 过长（最大 ' + MAX_PROMPT_LENGTH + ' 字符）'
    };
  }
  return {
    prompt: prompt,
    size: size,
    watermark: body.watermark !== undefined ? body.watermark : settings.get('defaultWatermark'),
    output_format: body.output_format || settings.get('defaultOutputFormat'),
    response_format: body.response_format || settings.get('defaultResponseFormat'),
    prompt_extend: body.prompt_extend !== undefined ? body.prompt_extend : settings.get('defaultPromptExtend'),
    n: 1
  };
}

async function persistArtifact(mode, params, result) {
  const artifactId = genArtifactId();
  let imageBuffer = null;
  const ext = params.output_format || 'png';

  if (result.source === 'b64_json' && result.data) {
    imageBuffer = Buffer.from(result.data, 'base64');
  } else if (result.source === 'url' && result.data) {
    imageBuffer = await api.downloadImage(result.data);
  } else {
    throw { type: 'invalid_response', code: 500, message: 'API 返回无可落盘的图片数据' };
  }

  const meta = artifacts.save(
    artifactId,
    mode,
    {
      prompt: params.prompt,
      params: {
        size: params.size,
        watermark: params.watermark,
        output_format: params.output_format,
        response_format: params.response_format,
        prompt_extend: params.prompt_extend,
        n: params.n
      },
      model: MODEL,
      source: result.source
    },
    imageBuffer,
    ext
  );

  return {
    success: true,
    taskId: artifactId,
    imageUrl: '/api/artifacts/' + artifactId + '/image',
    created: meta.created,
    meta
  };
}

async function runImageJob(req, res, mode) {
  const body = req.body || {};

  if (!body.prompt || String(body.prompt).trim() === '') {
    return res
      .status(400)
      .json({ success: false, error: { type: 'invalid_request_error', message: 'prompt 不能为空' } });
  }

  if (mode === 'edit' && (!body.images || !Array.isArray(body.images) || body.images.length === 0)) {
    return res
      .status(400)
      .json({ success: false, error: { type: 'invalid_request_error', message: '改图需要至少一张图片' } });
  }

  let params;
  try {
    params = fillParams(body);
  } catch (e) {
    return res.status(e && e.code === 400 ? 400 : 500).json({
      success: false,
      error: {
        type: (e && e.type) || 'invalid_request_error',
        code: e && e.code,
        message: (e && e.message) || '参数校验失败'
      }
    });
  }

  const apiKey = config.get().apiKey;
  if (!apiKey) {
    return res.status(400).json({
      success: false,
      error: { type: 'no_api_key', code: 400, message: '尚未配置 API Key，请到「设置」页面填写' }
    });
  }

  const doSave = body.save !== false;
  const start = Date.now();

  try {
    await throttle.throttle();
    let result;
    if (mode === 'gen') {
      result = await api.generate({ ...params, apiKey });
    } else {
      result = await api.edit({ ...params, images: body.images, apiKey });
    }

    requestLog.add({
      type: mode,
      status: 'ok',
      prompt: params.prompt,
      costMs: Date.now() - start
    });

    if (!doSave) {
      return res.json({ success: true, data: result });
    }

    const resp = await persistArtifact(mode, params, result);
    return res.json(resp);
  } catch (err) {
    requestLog.add({
      type: mode,
      status: 'fail',
      prompt: params.prompt,
      code: (err && err.code) || 500,
      message: (err && err.message) || '生成失败',
      costMs: Date.now() - start
    });
    return res.status(500).json({
      success: false,
      error: {
        type: (err && err.type) || 'api_error',
        code: (err && err.code) || 500,
        message: (err && err.message) || '生成失败'
      }
    });
  }
}

app.get('/api/config', (req, res) => {
  res.json({ success: true, data: config.publicView() });
});

app.put('/api/config', (req, res) => {
  config.set(req.body || {});
  res.json({ success: true, data: config.publicView() });
});

app.post('/api/config/test', async (req, res) => {
  const apiKey = (req.body && req.body.apiKey) || config.get().apiKey;
  if (!apiKey) {
    return res.json({ success: false, error: { type: 'invalid_request_error', message: 'apiKey 为空' } });
  }
  try {
    await api.generate({
      prompt: 'test',
      size: '1024x1024',
      n: 1,
      watermark: false,
      response_format: 'url',
      apiKey
    });
    requestLog.add({ type: 'test', status: 'ok', prompt: '(Key 连通性测试)' });
    res.json({ success: true });
  } catch (e) {
    requestLog.add({
      type: 'test',
      status: 'fail',
      prompt: '(Key 连通性测试)',
      code: e.code,
      message: e.message
    });
    res.json({
      success: false,
      error: { type: e.type || 'api_error', code: e.code, message: e.message || '测试失败' }
    });
  }
});

app.get('/api/settings', (req, res) => {
  res.json({ success: true, data: settings.load() });
});

app.put('/api/settings', (req, res) => {
  settings.set(req.body || {});
  res.json({ success: true, data: settings.load() });
});

app.get('/api/request-logs', (req, res) => {
  const data = requestLog.list({
    page: req.query.page,
    pageSize: req.query.pageSize,
    status: req.query.status,
    type: req.query.type,
    search: req.query.search
  });
  res.json({ success: true, data });
});

app.get('/api/request-logs/stats', (req, res) => {
  res.json({ success: true, data: requestLog.stats() });
});

app.delete('/api/request-logs', (req, res) => {
  const removed = requestLog.clear();
  res.json({ success: true, removed });
});

app.post('/api/tasks', (req, res) => {
  const body = req.body || {};
  const type = body.type;
  if (type !== 'gen' && type !== 'edit') {
    return res
      .status(400)
      .json({ success: false, error: { type: 'invalid_request_error', message: 'type 必须为 gen 或 edit' } });
  }
  let count = parseInt(body.count, 10) || 1;
  if (count < 1 || count > MAX_TASK_COUNT) {
    return res
      .status(400)
      .json({ success: false, error: { type: 'invalid_request_error', message: 'count 须为 1-' + MAX_TASK_COUNT } });
  }
  const params = body.params || {};
  if (!params.prompt || String(params.prompt).trim() === '') {
    return res
      .status(400)
      .json({ success: false, error: { type: 'invalid_request_error', message: 'prompt 不能为空' } });
  }
  let images = [];
  if (type === 'edit') {
    images = Array.isArray(body.images) ? body.images : [];
    if (images.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: { type: 'invalid_request_error', message: '改图需要至少一张图片' } });
    }
  }
  if (!config.hasKey()) {
    return res
      .status(400)
      .json({ success: false, error: { type: 'no_api_key', message: '尚未配置 API Key，请到「设置」页面填写' } });
  }

  let filled;
  try {
    filled = fillParams(params);
  } catch (e) {
    return res.status(e && e.code === 400 ? 400 : 500).json({
      success: false,
      error: {
        type: (e && e.type) || 'invalid_request_error',
        code: e && e.code,
        message: (e && e.message) || '参数校验失败'
      }
    });
  }
  const ids = taskQueue.addTasks(type, filled, images, count);
  res.json({ success: true, tasks: ids });
});

app.get('/api/tasks', (req, res) => {
  const data = taskQueue.listTasks({
    status: req.query.status,
    page: req.query.page,
    pageSize: req.query.pageSize
  });
  res.json({ success: true, data });
});

app.get('/api/tasks/stats', (req, res) => {
  res.json({ success: true, data: taskQueue.getStats() });
});

app.delete('/api/tasks/finished', (req, res) => {
  const removed = taskQueue.clearFinished();
  res.json({ success: true, removed });
});

app.get('/api/tasks/:id', (req, res) => {
  const task = taskQueue.getTask(req.params.id);
  if (!task) {
    return res
      .status(404)
      .json({ success: false, error: { type: 'not_found_error', message: '任务不存在' } });
  }
  const copy = Object.assign({}, task);
  delete copy._images;
  res.json({ success: true, data: copy });
});

app.post('/api/tasks/:id/cancel', (req, res) => {
  const ok = taskQueue.cancelTask(req.params.id);
  if (!ok) {
    return res
      .status(400)
      .json({ success: false, error: { type: 'invalid_request_error', message: '仅排队中的任务可取消' } });
  }
  res.json({ success: true });
});

app.get('/api/artifacts', (req, res) => {
  const { page, pageSize, type, search } = req.query;
  const data = artifacts.list(page, pageSize, type, search);
  res.json({ success: true, data });
});

app.get('/api/artifacts/:id/meta', (req, res) => {
  const meta = artifacts.getMeta(req.params.id);
  if (!meta) {
    return res
      .status(404)
      .json({ success: false, error: { type: 'not_found_error', message: '图片不存在' } });
  }
  res.json({ success: true, data: meta });
});

app.get('/api/artifacts/:id/image', (req, res) => {
  const filePath = artifacts.getFilePath(req.params.id);
  if (!filePath) {
    return res
      .status(404)
      .json({ success: false, error: { type: 'not_found_error', message: '图片不存在' } });
  }
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const ct =
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp'
    }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
});

app.delete('/api/artifacts/:id', (req, res) => {
  const ok = artifacts.remove(req.params.id);
  if (!ok) {
    return res
      .status(404)
      .json({ success: false, error: { type: 'not_found_error', message: '图片不存在' } });
  }
  res.json({ success: true });
});

app.delete('/api/artifacts', (req, res) => {
  const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) {
    return res
      .status(400)
      .json({ success: false, error: { type: 'invalid_request_error', message: 'ids 不能为空' } });
  }
  let removed = 0;
  const notFound = [];
  ids.forEach((id) => {
    if (artifacts.remove(id)) removed++;
    else notFound.push(id);
  });
  res.json({ success: true, removed, notFound });
});

app.post('/api/generate', async (req, res) => {
  try {
    await runImageJob(req, res, 'gen');
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: { type: 'server_error', message: String(err && err.message) }
      });
    }
  }
});

app.post('/api/edit', async (req, res) => {
  try {
    await runImageJob(req, res, 'edit');
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: { type: 'server_error', message: String(err && err.message) }
      });
    }
  }
});

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  res.status(500).json({
    success: false,
    error: { type: 'server_error', message: String(err && err.message) || '服务器内部错误' }
  });
});

app.listen(PORT, HOST, () => {
  console.log('[sensenova-studio] 生图工作台已启动: http://' + HOST + ':' + PORT);
  if (!config.hasKey()) {
    console.log('[sensenova-studio] 提示：尚未配置 API Key，请打开页面「设置」填写，或设置环境变量 SENSENOVA_API_KEY');
  }
});

module.exports = app;
