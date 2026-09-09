const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let cache = null;

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  load();
}

function load() {
  let fileCfg = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
    }
  } catch (e) {
    fileCfg = {};
  }
  cache = {
    apiKey: process.env.SENSNOVA_API_KEY || fileCfg.apiKey || '',
    updatedAt: fileCfg.updatedAt || null
  };
  return cache;
}

function save() {
  if (cache === null) load();
  cache.updatedAt = Math.floor(Date.now() / 1000);
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ apiKey: cache.apiKey, updatedAt: cache.updatedAt }, null, 2)
  );
  return cache;
}

function get() {
  if (cache === null) load();
  return cache;
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

function publicView() {
  const c = get();
  return {
    hasKey: !!c.apiKey,
    keyMasked: maskKey(c.apiKey),
    updatedAt: c.updatedAt
  };
}

function set(partial) {
  if (cache === null) load();
  partial = partial || {};
  if (typeof partial.apiKey === 'string' && partial.apiKey.trim() !== '') {
    cache.apiKey = partial.apiKey.trim();
  }
  save();
  return publicView();
}

function hasKey() {
  return !!get().apiKey;
}

module.exports = { init, get, set, publicView, hasKey, maskKey };
