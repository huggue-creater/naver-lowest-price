const http  = require('http');
const https = require('https');
const fs    = require('fs');
const url   = require('url');
const path  = require('path');
const crypto = require('crypto');

// .env 파일 로드 (상위 폴더 우선, 없으면 현재 폴더)
for (const envPath of [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')]) {
  try {
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of envLines) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
    break;
  } catch(_) {}
}

const NAVER_ID  = process.env.NAVER_ID  || '';
const NAVER_SEC = process.env.NAVER_SEC || '';

if (!NAVER_ID || !NAVER_SEC) {
  console.error('\n❌  .env 파일이 없거나 NAVER_ID / NAVER_SEC 가 비어있습니다.');
  console.error('   VsCode 폴더(상위)의 .env 를 사용하거나, 이 폴더에 .env 를 만드세요:');
  console.error('   NAVER_ID=클라이언트ID');
  console.error('   NAVER_SEC=클라이언트시크릿\n');
  process.exit(1);
}

// APP_PASSWORD가 설정되면 "공개 배포 모드": 0.0.0.0으로 바인딩하고 비밀번호 게이트를 켠다.
// 미설정 시 기존과 동일하게 로컬 전용(127.0.0.1, 무인증)으로 동작한다.
// PORT는 호스팅 플랫폼(Render 등)이 지정 — 지정돼 있으면 공개 배포로 간주해 비밀번호를 강제한다.
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const IS_CLOUD      = !!process.env.PORT;
const REQUIRE_AUTH  = IS_CLOUD || !!APP_PASSWORD;
const PORT = parseInt(process.env.PORT, 10) || 3001;
const HOST = IS_CLOUD ? '0.0.0.0' : '127.0.0.1';

if (IS_CLOUD && !APP_PASSWORD) {
  console.error('\n❌  공개 배포 환경(PORT 지정됨)인데 APP_PASSWORD가 설정되지 않았습니다.');
  console.error('   호스팅 서비스의 환경변수에 APP_PASSWORD를 추가하세요.\n');
  process.exit(1);
}

// ── 캐시: 데이터랩 일일 1,000회 쿼터 보호 (6시간 TTL, 디스크 저장) ──
const CACHE_FILE = path.join(__dirname, 'cache.json');
const CACHE_TTL  = 6 * 60 * 60 * 1000;
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(_) {}

function cacheGet(key) {
  const hit = cache[key];
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  return null;
}
function cacheSet(key, v) {
  cache[key] = { t: Date.now(), v };
  // 만료 항목 정리 후 저장
  for (const k of Object.keys(cache)) {
    if (Date.now() - cache[k].t >= CACHE_TTL) delete cache[k];
  }
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch(_) {}
}

function naverRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'openapi.naver.com',
      path: apiPath,
      method,
      headers: {
        'X-Naver-Client-Id':     NAVER_ID,
        'X-Naver-Client-Secret': NAVER_SEC,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

// ── 비밀번호 인증 (공개 배포 시에만 사용) ─────────────
// 세션은 메모리에 저장 — 서버 재시작 시 전원 로그아웃됨(무료 호스팅의 재시작 특성상 감수)
const sessions = new Map();       // token -> 만료시각(ms)
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30일
const loginAttempts = new Map();  // ip -> { count, lockedUntil }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of sessions) if (now > exp) sessions.delete(k);
  for (const [k, v] of loginAttempts) if (now > v.lockedUntil + LOGIN_LOCKOUT_MS) loginAttempts.delete(k);
}, 60 * 60 * 1000).unref();

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return xf ? xf.split(',')[0].trim() : req.socket.remoteAddress;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function hasValidSession(req) {
  const token = parseCookies(req).insight_session;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}
// 타이밍 공격 방지를 위해 해시 후 고정 길이로 비교
function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}
function renderLogin(error) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>4060 인사이트 대시보드</title>
<style>
  *{box-sizing:border-box} body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  form{background:#1a1d24;padding:32px 28px;border-radius:12px;width:280px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
  h1{font-size:16px;margin:0 0 20px;color:#fff;font-weight:600}
  input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #333;background:#0f1115;color:#fff;font-size:14px;margin-bottom:12px}
  button{width:100%;padding:10px;border:none;border-radius:8px;background:#4f8cff;color:#fff;font-size:14px;cursor:pointer}
  button:hover{background:#3b78e8}
  .err{color:#ff6b6b;font-size:13px;margin:-4px 0 12px}
</style></head><body>
<form method="post" action="/login">
  <h1>🔒 4060 인사이트 대시보드</h1>
  ${error ? `<div class="err">${error}</div>` : ''}
  <input type="password" name="password" placeholder="비밀번호" autofocus required>
  <button type="submit">입장</button>
</form>
</body></html>`;
}

// 대시보드는 이 서버가 같은 오리진(localhost:3001)으로 서빙하므로 CORS가 필요 없다.
// 와일드카드 CORS를 두면 사용자가 방문한 임의의 웹사이트가 브라우저에서
// 이 서버(사용자 네이버 키로 서명된 프록시)를 호출·열람할 수 있어 제거한다.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3001', 'http://127.0.0.1:3001',
]);
// 교차 사이트 요청 차단: Origin 헤더가 있고 허용 목록에 없으면 거부(CSRF/드라이브바이 방지)
// 공개 배포 시 도메인을 미리 알 수 없으므로, Host 헤더 기준 동일 오리진도 허용한다.
function isForbiddenOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return false;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return origin !== `${proto}://${req.headers.host}`;
}

// 프록시 대상 데이터랩 엔드포인트 화이트리스트
const DATALAB_ROUTES = {
  '/api/datalab/search':                 '/v1/datalab/search',
  '/api/datalab/shopping/categories':    '/v1/datalab/shopping/categories',
  '/api/datalab/shopping/keywords':      '/v1/datalab/shopping/category/keywords',
  '/api/datalab/shopping/keyword/age':   '/v1/datalab/shopping/category/keyword/age',
  '/api/datalab/shopping/keyword/gender':'/v1/datalab/shopping/category/keyword/gender',
  '/api/datalab/shopping/category/age':  '/v1/datalab/shopping/category/age',
};

http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);
  // 교차 오리진에서 온 API 호출은 거부한다(대시보드는 동일 오리진이라 정상 동작에 영향 없음).
  if (isForbiddenOrigin(req)) { send(res, 403, JSON.stringify({ error: 'cross-origin 요청은 허용되지 않습니다.' })); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── 로그인 (공개 배포 시에만 활성) ───────────────────
  if (REQUIRE_AUTH && pathname === '/login') {
    if (req.method === 'GET') { send(res, 200, renderLogin(), 'text/html; charset=utf-8'); return; }
    if (req.method === 'POST') {
      const ip = clientIp(req);
      const attempt = loginAttempts.get(ip);
      if (attempt && attempt.count >= LOGIN_MAX_ATTEMPTS && Date.now() < attempt.lockedUntil) {
        send(res, 429, renderLogin('시도 횟수를 초과했습니다. 잠시 후 다시 시도하세요.'), 'text/html; charset=utf-8');
        return;
      }
      const raw = await readBody(req);
      const password = new url.URLSearchParams(raw).get('password') || '';
      if (safeEqual(password, APP_PASSWORD)) {
        loginAttempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL);
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.writeHead(302, {
          'Location': '/',
          'Set-Cookie': `insight_session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax${secure}`,
        });
        res.end();
        return;
      }
      const count = (attempt?.count || 0) + 1;
      loginAttempts.set(ip, { count, lockedUntil: count >= LOGIN_MAX_ATTEMPTS ? Date.now() + LOGIN_LOCKOUT_MS : 0 });
      send(res, 401, renderLogin('비밀번호가 올바르지 않습니다.'), 'text/html; charset=utf-8');
      return;
    }
  }
  // 세션이 없으면 로그인 페이지로 보낸다 (API 요청은 401만 응답)
  if (REQUIRE_AUTH && !hasValidSession(req)) {
    if (pathname.startsWith('/api/')) { send(res, 401, JSON.stringify({ error: '인증이 필요합니다.' })); return; }
    res.writeHead(302, { Location: '/login' }); res.end(); return;
  }

  // ── 데이터랩 프록시 (POST, 캐시) ─────────────────────
  if (DATALAB_ROUTES[pathname] && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const key = pathname + ':' + crypto.createHash('md5').update(raw).digest('hex');
      const cached = cacheGet(key);
      if (cached) {
        console.log(`[캐시] ${pathname}`);
        send(res, 200, cached);
        return;
      }
      const r = await naverRequest('POST', DATALAB_ROUTES[pathname], JSON.parse(raw));
      console.log(`[데이터랩] ${pathname} → ${r.status}`);
      if (r.status === 200) cacheSet(key, r.body);
      send(res, r.status, r.body);
    } catch (e) {
      console.log(`[데이터랩] 오류: ${e.message}`);
      send(res, 502, JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── 네이버 쇼핑 검색 (GET, 캐시) ─────────────────────
  if (pathname === '/api/shop') {
    const q = query.query;
    if (!q) { send(res, 400, '{}'); return; }
    const display = Math.min(parseInt(query.display) || 20, 40);
    const sort = ['sim','date','asc','dsc'].includes(query.sort) ? query.sort : 'sim';
    const apiPath = `/v1/search/shop.json?query=${encodeURIComponent(q)}&display=${display}&sort=${sort}`;
    const key = 'shop:' + apiPath;
    const cached = cacheGet(key);
    if (cached) { send(res, 200, cached); return; }
    try {
      const r = await naverRequest('GET', apiPath);
      console.log(`[쇼핑검색] "${q}" → ${r.status}`);
      if (r.status === 200) cacheSet(key, r.body);
      send(res, r.status, r.body);
    } catch (e) {
      send(res, 502, JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── 네이버 쇼핑 카테고리 트리 조회 (데이터랩 공개 엔드포인트) ──
  if (pathname === '/api/category') {
    const cid = query.cid;
    if (!cid || !/^\d+$/.test(cid)) { send(res, 400, '{}'); return; }
    const key = 'cattree:' + cid;
    const cached = cacheGet(key);
    if (cached) { send(res, 200, cached); return; }
    try {
      const r = await new Promise((resolve, reject) => {
        https.get({
          hostname: 'datalab.naver.com',
          path: `/shoppingInsight/getCategory.naver?cid=${cid}`,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': 'https://datalab.naver.com/shoppingInsight/sCategory.naver',
            'Accept': 'application/json',
          },
        }, r2 => {
          const chunks = [];
          r2.on('data', c => chunks.push(c));
          r2.on('end', () => resolve({ status: r2.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
        }).on('error', reject);
      });
      let out = { name: null, children: [] };
      if (r.status === 200) {
        const j = JSON.parse(r.body);
        out = { name: j.name || null, children: (j.childList || []).map(c => ({ cid: String(c.cid), name: c.name, leaf: !!c.leaf })) };
      }
      const body = JSON.stringify(out);
      console.log(`[카테고리] ${cid} → 하위 ${out.children.length}개`);
      if (out.children.length || out.name) cacheSet(key, body);
      send(res, 200, body);
    } catch (e) {
      send(res, 502, JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── 카테고리별 인기 검색어 TOP (4060 여성, 최근 4주) ──
  if (pathname === '/api/keywordrank') {
    const cid = query.cid;
    const count = Math.min(parseInt(query.count) || 20, 100);
    if (!cid || !/^\d+$/.test(cid)) { send(res, 400, '{}'); return; }
    const key = `rank:${cid}:${count}`;
    const cached = cacheGet(key);
    if (cached) { send(res, 200, cached); return; }
    try {
      const now = new Date();
      const back = now.getDay() === 0 ? 7 : now.getDay();
      const end = new Date(now); end.setDate(now.getDate() - back);       // 지난 일요일
      const start = new Date(end); start.setDate(end.getDate() - 27);      // 최근 4주
      const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const form = `cid=${cid}&timeUnit=week&startDate=${fmt(start)}&endDate=${fmt(end)}&age=40,50,60&gender=f&device=&page=1&count=${count}`;
      const r = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: 'datalab.naver.com',
          path: '/shoppingInsight/getCategoryKeywordRank.naver',
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': 'https://datalab.naver.com/shoppingInsight/sCategory.naver',
            'Origin': 'https://datalab.naver.com',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Content-Length': Buffer.byteLength(form),
          },
        }, r2 => {
          const chunks = [];
          r2.on('data', c => chunks.push(c));
          r2.on('end', () => resolve({ status: r2.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req2.on('error', reject);
        req2.write(form);
        req2.end();
      });
      let out = { ranks: [] };
      if (r.status === 200) {
        const j = JSON.parse(r.body);
        out = { ranks: (j.ranks || []).map(x => ({ rank: x.rank, keyword: x.keyword })) };
      }
      const body = JSON.stringify(out);
      console.log(`[인기검색어] ${cid} → ${out.ranks.length}개`);
      if (out.ranks.length) cacheSet(key, body);
      send(res, 200, body);
    } catch (e) {
      send(res, 502, JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── 카탈로그 최저가 판매처 조회 ──────────────────────
  // 카탈로그 상품명을 가격 오름차순으로 재검색해, 카탈로그 최저가(lprice)와
  // 일치/근접한 개별 판매처 상품의 몰 이름을 찾는다. (공식 API만 사용)
  if (pathname === '/api/lowestmall') {
    const pid = query.productId, q = (query.q || '').trim(), lprice = parseInt(query.price) || 0;
    if (!pid || !q || !lprice) { send(res, 400, '{}'); return; }
    const key = 'lowest:' + pid;
    const cached = cacheGet(key);
    if (cached) { send(res, 200, cached); return; }
    try {
      const apiPath = `/v1/search/shop.json?query=${encodeURIComponent(q)}&display=30&sort=asc`;
      const r = await naverRequest('GET', apiPath);
      let out = { mallName: null, price: null };
      if (r.status === 200) {
        const items = (JSON.parse(r.body).items || []).filter(it => it.productType !== '1' && it.mallName);
        const qTokens = q.toLowerCase().split(/\s+/).filter(t => t.length > 1);
        const similar = it => {
          const title = it.title.replace(/<[^>]*>/g, '').toLowerCase();
          const hit = qTokens.filter(t => title.includes(t)).length;
          return qTokens.length ? hit / qTokens.length >= 0.5 : false;
        };
        // 1순위: 최저가와 사실상 같은 가격의 판매처, 2순위: 근접(+10% 이내) 최저 판매처
        const exact = items.find(it => Math.abs(+it.lprice - lprice) <= 10 && similar(it));
        const near  = items.filter(it => +it.lprice >= lprice && +it.lprice <= lprice * 1.1 && similar(it))
                           .sort((a, b) => +a.lprice - +b.lprice)[0];
        const pick = exact || near;
        if (pick) out = { mallName: pick.mallName, price: +pick.lprice };
      }
      const body = JSON.stringify(out);
      console.log(`[최저가몰] ${pid} "${q.substring(0,30)}" → ${out.mallName || '매칭 실패'}`);
      if (out.mallName) cacheSet(key, body);
      send(res, 200, body);
    } catch (e) {
      send(res, 502, JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── 캐시 비우기 (수동 새로고침용) ────────────────────
  // 상태를 바꾸므로 POST만 허용 (GET CSRF 방지). Origin 검사는 위에서 이미 수행됨.
  if (pathname === '/api/cache/clear') {
    if (req.method !== 'POST') { send(res, 405, JSON.stringify({ error: 'POST만 허용됩니다.' })); return; }
    cache = {};
    try { fs.unlinkSync(CACHE_FILE); } catch(_) {}
    console.log('[캐시] 전체 삭제');
    send(res, 200, '{"ok":true}');
    return;
  }

  // ── 대시보드 서빙 ────────────────────────────────────
  fs.readFile(path.join(__dirname, 'dashboard.html'), (err, data) => {
    if (err) { send(res, 404, 'dashboard.html 파일을 찾을 수 없습니다.', 'text/plain; charset=utf-8'); return; }
    send(res, 200, data, 'text/html; charset=utf-8');
  });

// 로컬은 루프백(127.0.0.1)에만 바인딩 — 공개 배포(PORT 지정) 시에만 0.0.0.0으로 연다.
// 공개 배포는 REQUIRE_AUTH가 강제되어 있어(위 검증) 비밀번호 없이는 접근할 수 없다.
}).listen(PORT, HOST, () => {
  console.log(`\n✅  4060 인사이트 대시보드 실행 중 → http://${IS_CLOUD ? '0.0.0.0' : 'localhost'}:${PORT}`);
  if (REQUIRE_AUTH) console.log('   🔒 비밀번호 보호 활성화됨 (최초 접속 시 /login)');
  console.log('   데이터랩 API 미연동 시 대시보드 상단 안내를 따라 권한을 추가하세요.\n');
  // 자동 시작(백그라운드) 모드나 공개 배포 환경에서는 브라우저를 띄우지 않음
  if (!process.env.NO_OPEN && !IS_CLOUD && process.platform === 'win32') require('child_process').exec(`start http://localhost:${PORT}`);
});
