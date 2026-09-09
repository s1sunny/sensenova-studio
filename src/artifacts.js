const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
const INDEX_FILE = path.join(ARTIFACTS_DIR, 'index.json');
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

let index = [];

function init() {
  if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, '[]');
  load();
}

function load() {
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (!Array.isArray(index)) index = [];
  } catch (e) {
    index = [];
    saveIndex();
  }
  index.sort((a, b) => (b.created || 0) - (a.created || 0));
  return index;
}

function saveIndex() {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  return index;
}

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function safeDir(id) {
  if (!isValidId(id)) return null;
  return path.join(ARTIFACTS_DIR, id);
}

function save(taskId, type, meta, imageBuffer, ext) {
  if (!isValidId(taskId)) throw { type: 'invalid_request_error', message: '非法的图片 id' };
  const dir = path.join(ARTIFACTS_DIR, taskId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const safeExt = (ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const fullMeta = {
    id: taskId,
    type,
    prompt: meta.prompt || '',
    params: meta.params || {},
    model: meta.model || 'sensenova-u1.5-lite',
    ext: safeExt,
    created: Math.floor(Date.now() / 1000),
    usage: { from: meta.source || 'b64_json' }
  };

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(fullMeta, null, 2));
  fs.writeFileSync(path.join(dir, 'image.' + safeExt), imageBuffer);

  index.unshift(fullMeta);
  saveIndex();
  return fullMeta;
}

function list(page, pageSize, type, search) {
  page = parseInt(page, 10) || 1;
  pageSize = parseInt(pageSize, 10) || 20;
  if (page < 1) page = 1;
  if (pageSize < 1) pageSize = 20;

  let items = index.slice();
  if (type) items = items.filter((i) => i.type === type);
  if (search) {
    const s = String(search).toLowerCase();
    items = items.filter((i) => String(i.prompt || '').toLowerCase().includes(s));
  }

  const total = items.length;
  const start = (page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  return {
    total,
    page,
    pageSize,
    items: pageItems.map((i) => ({
      ...i,
      thumbnailUrl: '/api/artifacts/' + i.id + '/image',
      imageUrl: '/api/artifacts/' + i.id + '/image'
    }))
  };
}

function getMeta(id) {
  if (!isValidId(id)) return null;
  let meta = index.find((i) => i.id === id) || null;
  if (meta) return meta;
  const file = path.join(ARTIFACTS_DIR, id, 'meta.json');
  if (fs.existsSync(file)) {
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      return meta;
    } catch (e) {
      return null;
    }
  }
  return null;
}

function getFilePath(id) {
  if (!isValidId(id)) return null;
  const meta = getMeta(id);
  if (!meta) return null;
  const file = path.join(ARTIFACTS_DIR, id, 'image.' + (meta.ext || 'png'));
  if (fs.existsSync(file)) return file;
  return null;
}

function remove(id) {
  const dir = safeDir(id);
  if (!dir) return false;
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const before = index.length;
  index = index.filter((i) => i.id !== id);
  saveIndex();
  return before !== index.length;
}

module.exports = { init, load, save, list, getMeta, getFilePath, remove, saveIndex };
