const settings = require('./settings');

let gateChain = Promise.resolve();

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const interval = parseInt(settings.get('requestIntervalMs'), 10) || 0;
  if (interval <= 0) return;

  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const prev = gateChain;
  gateChain = prev.then(() => gate);
  await prev;
  try {
    await sleepMs(interval);
  } finally {
    release();
  }
}

module.exports = { throttle };
