const http  = require('http');
const https = require('https');
const fs    = require('fs');
const url   = require('url');
const path  = require('path');

const PORT = 3000;

// .env 파일 로드 (dotenv 없이)
try {
  const envLines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n');
  for (const line of envLines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch(_) {}

const NAVER_ID  = process.env.NAVER_ID  || '';
const NAVER_SEC = process.env.NAVER_SEC || '';

if (!NAVER_ID || !NAVER_SEC) {
  console.error('\n❌  .env 파일이 없거나 NAVER_ID / NAVER_SEC 가 비어있습니다.');
  console.error('   프로젝트 폴더에 .env 파일을 만들고 아래 내용을 입력하세요:');
  console.error('   NAVER_ID=여기에_클라이언트ID');
  console.error('   NAVER_SEC=여기에_클라이언트시크릿\n');
  process.exit(1);
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 리다이렉트 자동 추적 지원
function httpsGet(targetUrl, reqHeaders = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(targetUrl);
      const opts = {
        hostname: u.hostname,
        path:     u.pathname + u.search,
        headers:  reqHeaders,
      };
      https.get(opts, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          const next = new URL(res.headers.location, targetUrl).href;
          console.log(`  ↳ 리다이렉트 ${res.statusCode} → ${next.substring(0, 90)}`);
          res.resume();
          httpsGet(next, reqHeaders, redirectsLeft - 1).then(resolve).catch(reject);
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
      }).on('error', reject);
    } catch(e) { reject(e); }
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

function cleanTitle(raw) {
  return (raw || '')
    .replace(/\s*[|｜\-–]\s*(H몰|현대H몰|Hmall|HMALL|hmall|현대백화점).*$/i, '')
    .replace(/^\s*(H몰|현대H몰|Hmall|HMALL|현대백화점)\s*[|｜\-–]\s*/i, '')
    .replace(/\s*[:|：]\s*(H몰|현대H몰|Hmall).*$/i, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .trim();
}

function extractFromHtml(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{4,})["']/i)
           ?? html.match(/<meta[^>]+content=["']([^"']{4,})["'][^>]+property=["']og:title["']/i);
  if (og) { const t = cleanTitle(og[1]); if (t.length > 3) return t; }
  const title = html.match(/<title>([^<]{4,})<\/title>/i);
  if (title) { const t = cleanTitle(title[1]); if (t.length > 3) return t; }
  const jld = html.match(/"name"\s*:\s*"([^"]{5,})"/);
  if (jld) { const t = cleanTitle(jld[1]); if (t.length > 3) return t; }
  return null;
}

function extractFromJson(body) {
  try {
    const j = JSON.parse(body);
    const candidates = [
      j?.data?.slitmNm, j?.data?.goodsNm, j?.data?.prodNm, j?.data?.itemNm, j?.data?.goodsName,
      j?.result?.slitmNm, j?.result?.goodsNm, j?.result?.itemNm, j?.result?.prodNm,
      j?.slitmNm, j?.goodsNm, j?.prodNm, j?.itemNm, j?.goodsName, j?.prodName,
      j?.data?.goodsDetail?.goodsNm, j?.body?.slitmNm, j?.body?.goodsNm,
      j?.item?.name, j?.item?.goodsNm,
    ];
    for (const c of candidates) {
      if (c && typeof c === 'string' && c.trim().length > 3) return cleanTitle(c);
    }
    function findName(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 2) return null;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.length > 5 && v.length < 200) {
          const kl = k.toLowerCase();
          if (kl.endsWith('nm') || kl.includes('name') || kl.includes('title')) {
            const t = cleanTitle(v);
            if (t.length > 3 && !t.match(/^[\d\s\-\/]+$/)) return t;
          }
        } else if (typeof v === 'object') {
          const found = findName(v, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }
    return findName(j, 0);
  } catch(_) { return null; }
}

// 네이버 쇼핑 카탈로그 페이지에서 배송비 추출
async function getDeliveryFee(productId) {
  if (!productId) return null;
  try {
    const r = await httpsGet(`https://search.shopping.naver.com/catalog/${productId}`, {
      'User-Agent':      BROWSER_UA,
      'Accept':          'text/html,*/*',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer':         'https://search.shopping.naver.com/',
    });
    if (r.status !== 200 || r.body.length < 1000) return null;

    const m = r.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;

    const j = JSON.parse(m[1]);
    const state = j?.props?.pageProps?.initialState;
    if (!state) return null;

    // 여러 경로 순서대로 시도
    const checks = [
      () => state?.catalog?.lowestCatalogOfferList?.[0]?.deliveryFee,
      () => state?.catalog?.catalogLowestPrice?.deliveryFee,
      () => state?.catalog?.lowestPrice?.deliveryFee,
      () => state?.lowestPrice?.deliveryFee,
      () => state?.catalog?.offerList?.[0]?.deliveryFee,
    ];
    for (const fn of checks) {
      const v = fn();
      if (typeof v === 'number') return v;
    }
  } catch(_) {}
  return null;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── 네이버 쇼핑 API ──────────────────────────────────
  if (pathname === '/naver') {
    const q = query.query;
    if (!q) { res.writeHead(400); res.end('{}'); return; }
    const apiUrl = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(q)}&display=20&sort=asc`;
    console.log(`\n[Naver] 검색: "${q.substring(0,50)}"`);
    try {
      const r = await httpsGet(apiUrl, {
        'X-Naver-Client-Id':     NAVER_ID,
        'X-Naver-Client-Secret': NAVER_SEC,
        'User-Agent':            BROWSER_UA,
      });
      console.log(`[Naver] → ${r.status} (${r.body.length}자)`);
      if (r.status !== 200) {
        console.log(`[Naver] 오류: ${r.body.substring(0, 300)}`);
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(r.body);
        return;
      }

      const data = JSON.parse(r.body);
      const items = data.items || [];
      console.log(`[Naver] 총 ${data.total || 0}개 중 ${items.length}개 반환`);

      // 상위 5개에 배송비 병렬 조회 (카탈로그 상품만, 5초 타임아웃)
      console.log(`[배송비] 상위 5개 조회 시작...`);
      const enriched = await Promise.all(
        items.slice(0, 5).map(async item => {
          if (item.productType !== '1' || !item.productId) return item;
          const fee = await withTimeout(getDeliveryFee(item.productId), 5000);
          if (fee !== null) {
            console.log(`  [배송비] ${item.mallName}: ${fee === 0 ? '무료' : fee + '원'}`);
            return { ...item, deliveryFee: fee };
          }
          return item;
        })
      );
      data.items = [...enriched, ...items.slice(5)];

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.log(`[Naver] 오류: ${e.message}`);
      res.writeHead(502); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── H몰 상품명 조회 ───────────────────────────────────
  if (pathname === '/hmall') {
    const code = query.code;
    if (!code) { res.writeHead(400); res.end('{}'); return; }

    const hmallHeaders = {
      'User-Agent':      BROWSER_UA,
      'Accept':          'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Referer':         'https://www.hmall.com/',
      'Cache-Control':   'no-cache',
    };

    const tryUrls = [
      `https://www.hmall.com/md/pda/itemPtc?slitmCd=${code}`,
      `https://m.hmall.com/pda/pda/itemPtc?slitmCd=${code}`,
      `https://www.hmall.com/md/pda/itemPtc?ReferCode=429&slitmCd=${code}`,
    ];

    console.log(`\n[H몰] 상품코드: ${code}`);
    for (const tryUrl of tryUrls) {
      try {
        const r = await httpsGet(tryUrl, hmallHeaders);
        const label = tryUrl.replace('https://','').split('?')[0];
        console.log(`[H몰] ${label} → ${r.status} (${r.body.length}자)`);

        if (r.status === 200 && r.body.length > 30) {
          const nameJ = extractFromJson(r.body);
          if (nameJ) {
            console.log(`[H몰] 상품명(JSON): ${nameJ}`);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ name: nameJ }));
            return;
          }
          if (r.body.length > 500) {
            const nameH = extractFromHtml(r.body);
            if (nameH) {
              console.log(`[H몰] 상품명(HTML): ${nameH}`);
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ name: nameH }));
              return;
            }
            console.log(`[H몰] 파싱 실패, HTML 원본 전달`);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(r.body);
            return;
          }
          console.log(`[H몰] 응답 너무 짧음 (${r.body.length}자): ${r.body.substring(0,100)}`);
        }
      } catch (e) {
        console.log(`[H몰] 오류: ${e.message}`);
      }
    }

    console.log(`[H몰] 모든 URL 실패`);
    res.writeHead(404); res.end(JSON.stringify({ error: '상품 정보 조회 실패' }));
    return;
  }

  // ── HTML 파일 서빙 ────────────────────────────────────
  const filePath = path.join(__dirname, 'naver-lowest-price.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('naver-lowest-price.html 파일을 찾을 수 없습니다.'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log('\n✅  서버 실행 중 → http://localhost:' + PORT);
  console.log('   브라우저가 자동으로 열리지 않으면 위 주소로 접속하세요.');
  console.log('   이 창에서 H몰/Naver 요청 로그를 확인할 수 있습니다.\n');
  require('child_process').exec(`start http://localhost:${PORT}`);
});
