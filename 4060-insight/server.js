const http  = require('http');
const https = require('https');
const fs    = require('fs');
const url   = require('url');
const path  = require('path');
const crypto = require('crypto');

const PORT = 3001;

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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

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
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

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
  if (pathname === '/api/cache/clear') {
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

}).listen(PORT, () => {
  console.log('\n✅  4060 인사이트 대시보드 실행 중 → http://localhost:' + PORT);
  console.log('   데이터랩 API 미연동 시 대시보드 상단 안내를 따라 권한을 추가하세요.\n');
  require('child_process').exec(`start http://localhost:${PORT}`);
});
