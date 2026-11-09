// Первый шаг — сервер-посредник для GigaChat API.
// Запуск: node server.js  (нужен Node.js 18+, внешние библиотеки не нужны)
// Сервер отдаёт страницу бота и пересылает её запросы в GigaChat.
// Ключ авторизации хранится только здесь (файл .env), в браузер он не попадает.

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- настройки из .env ---------- */
function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const AUTH_KEY = (process.env.GIGACHAT_AUTH_KEY || '').trim();
const SCOPE = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
const MODEL = process.env.GIGACHAT_MODEL || 'GigaChat-2-Max';
const OAUTH_URL = process.env.GIGACHAT_OAUTH_URL || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
// Новый адрес API (с 17.07.2026) и прежний — на случай, если новый недоступен
const API_BASES = (process.env.GIGACHAT_BASE_URL || 'https://api.giga.chat/v1,https://gigachat.devices.sberbank.ru/api/v1')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || ''; // например https://my-site.ru, если страница лежит на другом домене

/* ---------- сертификат НУЦ Минцифры ---------- */
// Сертификат НЕ устанавливается в Windows: сервер просто читает файл из папки certs
// и доверяет ему только для своих запросов к GigaChat.
const certDir = path.join(__dirname, 'certs');
const CERT_URL = 'https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt';
let extraCA = [], agent;
function loadCerts() {
  extraCA = fs.existsSync(certDir)
    ? fs.readdirSync(certDir).filter(n => /\.(pem|crt|cer)$/i.test(n))
        .map(n => fs.readFileSync(path.join(certDir, n), 'utf8')).filter(t => t.includes('BEGIN CERTIFICATE'))
    : [];
  agent = new https.Agent({ ca: [...tls.rootCertificates, ...extraCA], keepAlive: true });
}
function downloadCert() {
  return new Promise(resolve => {
    https.get(CERT_URL, { timeout: 15000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      let d = ''; res.setEncoding('utf8'); res.on('data', c => (d += c));
      res.on('end', () => {
        if (!d.includes('BEGIN CERTIFICATE')) return resolve(false);
        fs.mkdirSync(certDir, { recursive: true });
        fs.writeFileSync(path.join(certDir, 'russian_trusted_root_ca.crt'), d);
        resolve(true);
      });
    }).on('error', () => resolve(false)).on('timeout', function () { this.destroy(); resolve(false); });
  });
}
loadCerts();

/* ---------- HTTPS-запрос ---------- */
function request(url, { method = 'GET', headers = {}, body = null, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, agent, timeout }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Превышено время ожидания ответа GigaChat')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function explainNetError(e) {
  const msg = String(e && e.message || e);
  if (/self[- ]signed|unable to (get|verify)|certificate/i.test(msg))
    return 'Не найден сертификат НУЦ Минцифры. Скачай russian_trusted_root_ca_pem.crt и положи в папку certs (см. README).';
  return msg;
}

/* ---------- токен доступа (живёт 30 минут) ---------- */
let token = null, tokenExp = 0;
async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExp - 60_000) return token;
  const r = await request(OAUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'RqUID': crypto.randomUUID(),
      'Authorization': 'Basic ' + AUTH_KEY,
    },
    body: 'scope=' + encodeURIComponent(SCOPE),
  });
  if (r.status !== 200) throw new Error('Не удалось получить токен GigaChat (' + r.status + '): ' + r.text.slice(0, 200));
  const j = JSON.parse(r.text);
  token = j.access_token;
  tokenExp = Number(j.expires_at) || Date.now() + 29 * 60_000;
  return token;
}

/* ---------- запрос к модели ---------- */
let goodBase = null;
async function chat(messages) {
  const payload = JSON.stringify({ model: MODEL, messages, temperature: 0.7, max_tokens: 1200 });
  const bases = goodBase ? [goodBase, ...API_BASES.filter(b => b !== goodBase)] : API_BASES;
  let lastErr;
  for (const base of bases) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r;
      try {
        r = await request(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': 'Bearer ' + (await getToken(attempt > 0 && lastErr === 401)) },
          body: payload,
        });
      } catch (e) { lastErr = e; break; } // сетевая ошибка — пробуем другой адрес
      if (r.status === 200) { goodBase = base; return JSON.parse(r.text); }
      if (r.status === 401) { lastErr = 401; continue; }                       // токен протух — обновим
      if (r.status === 429) { lastErr = 429; await sleep(2000 * (attempt + 1)); continue; } // один поток — подождём
      if (r.status === 404) { lastErr = new Error('404 на ' + base); break; }  // старый/новый адрес не подходит
      throw new Error('GigaChat ответил ' + r.status + ': ' + r.text.slice(0, 300));
    }
  }
  if (lastErr === 429) throw new Error('GigaChat занят (бесплатный режим обрабатывает один запрос за раз). Попробуй ещё раз через минуту.');
  if (lastErr === 401) throw new Error('GigaChat отклонил ключ авторизации. Проверь GIGACHAT_AUTH_KEY в .env.');
  throw new Error(explainNetError(lastErr));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Бесплатный режим для физлиц — один поток, поэтому ставим запросы в очередь
let queue = Promise.resolve();
function enqueue(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

/* ---------- простая защита от злоупотреблений ---------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 60_000, max = 20;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}
function validMessages(m) {
  if (!Array.isArray(m) || !m.length || m.length > 40) return false;
  let total = 0;
  for (const x of m) {
    if (!x || !['system', 'user', 'assistant'].includes(x.role) || typeof x.content !== 'string') return false;
    total += x.content.length;
  }
  return total <= 80_000;
}

/* ---------- HTTP-сервер ---------- */
function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function cors(req) {
  if (!ALLOW_ORIGIN) return {};
  return { 'Access-Control-Allow-Origin': ALLOW_ORIGIN, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ch = cors(req);
  if (req.method === 'OPTIONS') return send(res, 204, '', ch);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try { return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')); }
    catch (e) { return send(res, 404, 'Положи index.html в папку public'); }
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, provider: 'gigachat', model: MODEL, keySet: !!AUTH_KEY, certs: extraCA.length }, ch);
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    if (!AUTH_KEY) return send(res, 500, { error: 'На сервере не задан GIGACHAT_AUTH_KEY (файл .env).' }, ch);
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return send(res, 429, { error: 'Слишком много сообщений подряд. Подожди минуту.' }, ch);
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 300_000) req.destroy(); });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'Неверный JSON' }, ch); }
      if (!validMessages(body.messages)) return send(res, 400, { error: 'Неверный формат сообщений' }, ch);
      try {
        const out = await enqueue(() => chat(body.messages));
        send(res, 200, { choices: [{ message: { content: out.choices?.[0]?.message?.content || '' } }], usage: out.usage || null }, ch);
      } catch (e) {
        console.error('[gigachat]', e.message);
        send(res, 502, { error: e.message }, ch);
      }
    });
    return;
  }
  send(res, 404, { error: 'Не найдено' }, ch);
});

(async () => {
  if (!extraCA.length) {
    console.log('  Скачиваю сертификат Минцифры для GigaChat (в систему он не устанавливается)…');
    if (await downloadCert()) { loadCerts(); console.log('  Сертификат сохранён в папку certs.'); }
  }
  server.listen(PORT, () => {
  console.log(`\n  Первый шаг запущен: http://localhost:${PORT}\n`);
  if (!AUTH_KEY) console.log('  ⚠ Не задан GIGACHAT_AUTH_KEY — создай файл .env по образцу .env.example');
  if (!extraCA.length) console.log('  ⚠ Сертификат скачать не удалось. Открой в браузере ссылку из certs/README.txt и положи скачанный файл в папку certs (устанавливать не нужно).');
  console.log(`  Модель: ${MODEL}\n`);
  });
})();
