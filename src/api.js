const https = require('https');

const BASE_HOST = 'token.sensenova.cn';
const BASE_PATH = '/v1';
const TIMEOUT_MS = 120000;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60000;

function makeError(type, code, message, extra) {
  const err = { type, code, message };
  if (extra) err.detail = extra;
  return err;
}

function rawRequest(method, pathname, headers, bodyStr) {
  return new Promise((resolve) => {
    const reqBody = bodyStr || '';
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(reqBody),
      ...headers
    };

    const req = https.request(
      {
        host: BASE_HOST,
        path: BASE_PATH + pathname,
        method,
        headers: reqHeaders,
        timeout: TIMEOUT_MS
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: buf.toString('utf8')
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(makeError('network_error', undefined, '连接商汤API失败: 请求超时'));
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 599,
        headers: {},
        body: '',
        networkError: err && err.message ? err.message : String(err)
      });
    });

    if (reqBody) req.write(reqBody);
    req.end();
  });
}

function parseImageResponse(resp) {
  const { statusCode, body } = resp;

  if (statusCode === 599) {
    const msg = resp.networkError
      ? '连接商汤API失败: ' + resp.networkError
      : '连接商汤API失败: 未知网络错误';
    throw makeError('network_error', 599, msg);
  }

  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch (e) {
    parsed = null;
  }

  if (statusCode === 429) {
    const msg = (parsed && parsed.error && parsed.error.message) || '请求过于频繁';
    throw makeError('rate_limit_error', 429, msg);
  }
  if (statusCode === 401) {
    const msg = (parsed && parsed.error && parsed.error.message) || 'API key 无效';
    throw makeError('authentication_error', 401, msg);
  }
  if (statusCode === 403) {
    const msg = (parsed && parsed.error && parsed.error.message) || '权限拒绝';
    throw makeError('permission_denied_error', 403, msg);
  }

  if (statusCode < 200 || statusCode >= 300) {
    const type =
      (parsed && parsed.error && parsed.error.type) ||
      (statusCode === 404 ? 'not_found_error' : 'api_error');
    const msg =
      (parsed && parsed.error && parsed.error.message) ||
      `HTTP ${statusCode} 请求失败`;
    throw makeError(type, statusCode, msg, parsed && parsed.error);
  }

  if (!parsed || !parsed.data || !Array.isArray(parsed.data) || parsed.data.length === 0) {
    throw makeError('invalid_response', statusCode, 'API 返回非预期响应: 缺少 data 字段');
  }
  const item = parsed.data[0];
  if (item.b64_json) {
    return { source: 'b64_json', data: item.b64_json };
  }
  if (item.url) {
    return { source: 'url', data: item.url };
  }
  throw makeError('invalid_response', statusCode, 'API 返回非预期响应: data 中无 url 或 b64_json');
}

async function generate(params) {
  const p = params || {};
  const payload = {
    model: p.model || 'sensenova-u1.5-lite',
    prompt: p.prompt,
    size: p.size || 'auto',
    n: p.n || 1,
    watermark: p.watermark !== undefined ? p.watermark : true,
    output_format: p.output_format || 'png',
    response_format: p.response_format || 'b64_json',
    prompt_extend: p.prompt_extend !== undefined ? p.prompt_extend : true
  };

  const headers = {
    Authorization: 'Bear' + 'er ' + p.apiKey
  };

  const resp = await rawRequest(
    'POST',
    '/images/generations',
    headers,
    JSON.stringify(payload)
  );
  return parseImageResponse(resp);
}

async function edit(params) {
  const p = params || {};
  const payload = {
    model: p.model || 'sensenova-u1.5-lite',
    images: p.images || [],
    prompt: p.prompt,
    n: p.n || 1,
    size: p.size || 'auto',
    response_format: p.response_format || 'b64_json',
    watermark: p.watermark !== undefined ? p.watermark : true,
    prompt_extend: p.prompt_extend !== undefined ? p.prompt_extend : true
  };

  const headers = {
    Authorization: 'Bear' + 'er ' + p.apiKey
  };

  const resp = await rawRequest(
    'POST',
    '/images/edits',
    headers,
    JSON.stringify(payload)
  );
  return parseImageResponse(resp);
}

function downloadImage(url, redirects) {
  if (redirects === undefined) redirects = 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(makeError('network_error', 599, '下载图片失败: 重定向次数过多'));
      return;
    }
    const req = https.get(url, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        resolve(downloadImage(res.headers.location, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(
          makeError(
            'network_error',
            599,
            '下载图片失败: HTTP ' + res.statusCode
          )
        );
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_IMAGE_BYTES) {
          res.destroy();
          reject(makeError('network_error', 599, '下载图片失败: 图片超过 30MB 上限'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (err) =>
        reject(makeError('network_error', 599, '下载图片失败: ' + err.message))
      );
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(makeError('network_error', 599, '下载图片失败: 超时'));
    }, DOWNLOAD_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(makeError('network_error', 599, '下载图片失败: ' + err.message));
    });
  });
}

module.exports = { generate, edit, downloadImage };
