const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  defaultSize: '2048x2048',
  defaultWatermark: true,
  defaultOutputFormat: 'png',
  defaultResponseFormat: 'b64_json',
  defaultPromptExtend: true,
  port: 3107,
  maxConcurrency: 2,
  requestIntervalMs: 1000
};

let cache = null;

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }
  load();
}

function load() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    cache = { ...DEFAULT_SETTINGS, ...obj };
    delete cache.requestIntervalMinMs;
    delete cache.requestIntervalMaxMs;
  } catch (e) {
    cache = { ...DEFAULT_SETTINGS };
    save();
  }
  return cache;
}

function save() {
  if (cache === null) load();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2));
  return cache;
}

function get(key) {
  if (cache === null) load();
  return cache[key];
}

const FIELD_RULES = {
  defaultSize: { validate: () => true },
  defaultWatermark: { validate: (v) => typeof v === 'boolean' },
  defaultOutputFormat: { validate: (v) => ['png', 'jpeg', 'webp'].includes(v) },
  defaultResponseFormat: { validate: (v) => ['b64_json', 'url'].includes(v) },
  defaultPromptExtend: { validate: (v) => typeof v === 'boolean' },
  port: {
    validate: (v) => Number.isInteger(v) && v >= 1024 && v <= 65535,
    clamp: (v) => Math.max(1024, Math.min(65535, parseInt(v, 10) || 3107))
  },
  maxConcurrency: {
    validate: (v) => Number.isInteger(v) && v >= 1 && v <= 4,
    clamp: (v) => Math.max(1, Math.min(4, parseInt(v, 10) || 2))
  },
  requestIntervalMs: {
    validate: (v) => Number.isInteger(v) && v >= 0 && v <= 60000,
    clamp: (v) => Math.max(0, Math.min(60000, parseInt(v, 10) || 0))
  }
};

function set(partial) {
  if (cache === null) load();
  partial = partial || {};
  Object.keys(partial).forEach((k) => {
    const rule = FIELD_RULES[k];
    if (!rule) return;
    let v = partial[k];
    if (rule.clamp) v = rule.clamp(v);
    else if (rule.validate && !rule.validate(v)) return;
    cache[k] = v;
  });
  save();
  return cache;
}

module.exports = { init, load, save, get, set };
