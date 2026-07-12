/* ═══════════════════════════════════════════════════════════════
   snapshot.js — GitHub Actions용 데이터 스냅샷 생성기
   dashboard.html이 로드 시 호출하는 API 요청들을 미리 실행해
   snapshot.json 으로 저장한다. GitHub Pages(정적 모드)에서
   dashboard.html이 이 파일을 읽어 서버 없이 동작한다.

   ⚠️ CATS·날짜 계산·요청 본문 구성은 dashboard.html과 반드시
      동일해야 한다 (스냅샷 키가 일치해야 조회됨). 수정 시 함께 변경할 것.

   실행: node snapshot.js   (NAVER_ID / NAVER_SEC 환경변수 또는 ../.env)
   데이터랩 호출량: 회당 약 310회 → 하루 2회 실행 시 쿼터(1,000회) 내
   ═══════════════════════════════════════════════════════════════ */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// .env 로드 (상위 폴더 우선) — server.js와 동일
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
  console.error('❌ NAVER_ID / NAVER_SEC 가 없습니다. (.env 또는 환경변수)');
  process.exit(1);
}

/* ── dashboard.html의 CATS와 동일하게 유지할 것 ── */
const CATS = [
  { cid:'50000000', name:'패션의류',   kws:['린넨원피스','여성 카디건','와이드팬츠','냉감티셔츠','여성 슬랙스','블라우스','여성 니트','여름원피스','골프웨어','레인코트'],
    brands:['쉬즈미스','올리비아로렌','크로커다일레이디','마리끌레르','지고트','발렌시아','씨씨콜렉트','베스띠벨리'] },
  { cid:'50000001', name:'패션잡화',   kws:['여성 샌들','컴포트화','여성 운동화','크로스백','숄더백','양산','선글라스','스카프','진주목걸이','여성 모자'],
    brands:['금강제화','소다','닥스','메트로시티','루이까또즈','탠디','락포트','빈폴'] },
  { cid:'50000002', name:'화장품/미용', kws:['탄력크림','주름개선 세럼','새치커버','염색약','쿠션팩트','선크림','두피앰플','미백크림','아이크림','헤어에센스'],
    brands:['설화수','더히스토리오브후','오휘','숨37','AHC','아이오페','미샤','참존'] },
  { cid:'50000006', name:'식품',       kws:['홍삼','유산균','오메가3','루테인','콜라겐','밀크씨슬','석류즙','갈비탕','전복','장어'],
    brands:['정관장','종근당건강','락토핏','뉴트리원','비비고','풀무원','청정원','하림'] },
  { cid:'50000008', name:'생활/건강',   kws:['안마의자','목마사지기','발마사지기','마사지건','혈압계','무릎보호대','제습제','욕실화','찜질기','족욕기'],
    brands:['바디프랜드','세라젬','코지마','휴테크','오므론','필립스','브레오','파나소닉'] },
  { cid:'50000003', name:'디지털/가전', kws:['에어프라이어','무선청소기','제습기','김치냉장고','전기밥솥','선풍기','음식물처리기','인덕션','식기세척기','에어컨'],
    brands:['삼성전자','LG전자','쿠쿠','쿠첸','테팔','위닉스','다이슨','일렉트로룩스'] },
  { cid:'50000004', name:'가구/인테리어', kws:['리클라이너','라텍스매트리스','냉감패드','구스이불','호텔침구','암막커튼','소파','식탁','화장대','수납장'],
    brands:['한샘','시몬스','에이스침대','템퍼','일룸','알레르망','이브자리','소프라움'] },
  { cid:'50000007', name:'스포츠/레저', kws:['등산화','등산복','골프채','골프화','트레킹화','요가매트','아쿠아슈즈','골프백','필라테스복','등산가방'],
    brands:['노스페이스','코오롱스포츠','K2','블랙야크','아이더','네파','타이틀리스트','캘러웨이'] },
  { cid:'50000005', name:'출산/육아', kws:['유모차','카시트','기저귀','분유','아기 물티슈','유아동복','완구','아기띠','이유식','어린이 유산균'],
    brands:['스토케','콤비','하기스','보솜이','아가방','제로투세븐','리안','잉글레시나'] },
  { cid:'50000009', name:'여가/생활편의', kws:['여행패키지','반려동물 사료','강아지 유모차','캠핑 텐트','차량용 블랙박스','골프연습장 이용권','스파 이용권','상품권 세트','자동차 타이어','문화상품권'],
    brands:['하나투어','모두투어','로얄캐닌','콜맨','노르디스크','불스원','한국타이어','컬쳐랜드'] },
  { cid:'50000010', name:'면세점', kws:['면세 향수','면세 화장품 세트','명품 지갑','명품 가방','고급 시계','위스키','초콜릿 기프트','면세 선글라스','건강기능식품 면세','전자기기 면세'],
    brands:['샤넬','디올','에스티로더','조말론','랑콤','MCM','불가리','조니워커'] },
];

/* ── 날짜 계산: dashboard.html과 동일 ── */
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function dateRange() {
  const now = new Date();
  const back = now.getDay() === 0 ? 7 : now.getDay();
  const end = new Date(now); end.setDate(now.getDate() - back);
  const start = new Date(end); start.setDate(end.getDate() - 69);
  return { startDate: ymd(start), endDate: ymd(end) };
}
function dateRangeSeason() {
  const now = new Date();
  const back = now.getDay() === 0 ? 7 : now.getDay();
  const end = new Date(now); end.setDate(now.getDate() - back);
  const start = new Date(end); start.setDate(end.getDate() - 7 * 65 + 1);
  return { startDate: ymd(start), endDate: ymd(end) };
}
/* growthOf: dashboard.html과 동일 (브랜드 탭 상위 5개 선정에 사용) */
function growthOf(data) {
  const vals = (data || []).map(d => d.ratio);
  if (vals.length < 4) return null;
  const recent = vals.slice(-2), base = vals.slice(0, -2);
  const rAvg = recent.reduce((a,b)=>a+b,0) / recent.length;
  const bAvg = base.reduce((a,b)=>a+b,0) / base.length;
  if (bAvg < 0.5) return null;
  return (rAvg - bAvg) / bAvg * 100;
}

/* ── 스냅샷 키: dashboard.html의 snapKey()와 동일해야 함 ──
   날짜는 제외하고 기간 길이(일수)만 포함해, 스냅샷 생성 주와
   열람 주가 달라도 키가 일치하도록 한다. */
function snapKey(route, body) {
  const days = Math.round((new Date(body.endDate) - new Date(body.startDate)) / 864e5);
  const b = {};
  for (const k of Object.keys(body).sort()) if (k !== 'startDate' && k !== 'endDate') b[k] = body[k];
  return route + '|' + days + '|' + JSON.stringify(b);
}

/* ── HTTP 헬퍼 ── */
function request(opts, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function naverPost(apiPath, body) {
  const payload = JSON.stringify(body);
  return request({
    hostname: 'openapi.naver.com', path: apiPath, method: 'POST',
    headers: {
      'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SEC,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
    },
  }, payload);
}
async function naverGet(apiPath) {
  return request({
    hostname: 'openapi.naver.com', path: apiPath, method: 'GET',
    headers: { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SEC },
  });
}

const DATALAB_ROUTES = {
  'shopping/keywords':    '/v1/datalab/shopping/category/keywords',
  'shopping/keyword/age': '/v1/datalab/shopping/category/keyword/age',
  'shopping/categories':  '/v1/datalab/shopping/categories',
};

const entries = {};
let calls = 0, fails = 0;

/* 동시 4개 제한 실행기 (API 초당 호출 제한 보호) */
async function runAll(jobs, limit = 4) {
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      try { await job(); } catch (e) { fails++; console.error('  ✗', e.message); }
      await new Promise(r => setTimeout(r, 120));
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
}

function datalabJob(route, body) {
  return async () => {
    const r = await naverPost(DATALAB_ROUTES[route], body);
    calls++;
    if (r.status !== 200) { fails++; console.error(`  ✗ [${route}] ${r.status}: ${r.body.slice(0, 120)}`); return; }
    entries[snapKey(route, body)] = JSON.parse(r.body);
  };
}

/* 인기 검색어 (비공식 datalab.naver.com — 실패해도 나머지는 진행) */
async function fetchKeywordRankRaw(cid, count) {
  const now = new Date();
  const back = now.getDay() === 0 ? 7 : now.getDay();
  const end = new Date(now); end.setDate(now.getDate() - back);
  const start = new Date(end); start.setDate(end.getDate() - 27);
  const form = `cid=${cid}&timeUnit=week&startDate=${ymd(start)}&endDate=${ymd(end)}&age=40,50,60&gender=f&device=&page=1&count=${count}`;
  const r = await request({
    hostname: 'datalab.naver.com', path: '/shoppingInsight/getCategoryKeywordRank.naver', method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://datalab.naver.com/shoppingInsight/sCategory.naver',
      'Origin': 'https://datalab.naver.com',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Content-Length': Buffer.byteLength(form),
    },
  }, form);
  if (r.status !== 200) throw new Error(`keywordrank ${cid} → ${r.status}`);
  const j = JSON.parse(r.body);
  return { ranks: (j.ranks || []).map(x => ({ rank: x.rank, keyword: x.keyword })) };
}

async function shopJob(q, display) {
  const r = await naverGet(`/v1/search/shop.json?query=${encodeURIComponent(q)}&display=${display}&sort=sim`);
  if (r.status !== 200) throw new Error(`shop "${q}" → ${r.status}`);
  entries[`shop|${q}|${display}`] = JSON.parse(r.body);
}

(async () => {
  const r10 = dateRange();
  const r65 = dateRangeSeason();
  console.log(`▶ 스냅샷 생성 시작 (10주: ${r10.startDate}~${r10.endDate} / 65주: ${r65.startDate}~${r65.endDate})`);

  /* ① 베스트(10주) + ①-2 시즌(65주): 큐레이션 키워드 풀 트렌드 */
  const trendJobs = [];
  for (const range of [r10, r65]) {
    for (const cat of CATS) {
      for (const pool of [cat.kws, cat.brands || []]) {
        for (let i = 0; i < pool.length; i += 5) {
          const chunk = pool.slice(i, i + 5);
          trendJobs.push(datalabJob('shopping/keywords', {
            startDate: range.startDate, endDate: range.endDate, timeUnit:'week', category: cat.cid,
            keyword: chunk.map(k => ({ name: k, param: [k] })),
            gender: 'f', ages: ['40','50','60'],
          }));
        }
      }
    }
  }
  console.log(`  키워드 트렌드 ${trendJobs.length}건 조회...`);
  await runAll(trendJobs);

  /* 타겟 적합도: 키워드별 클릭 연령 구성 (10주) */
  const fitJobs = [];
  for (const cat of CATS) {
    for (const kw of [...cat.kws, ...(cat.brands || [])]) {
      fitJobs.push(datalabJob('shopping/keyword/age', {
        startDate: r10.startDate, endDate: r10.endDate, timeUnit:'week', category: cat.cid, keyword: kw,
      }));
    }
  }
  console.log(`  연령 구성 ${fitJobs.length}건 조회...`);
  await runAll(fitJobs);

  /* ② 카테고리 트렌드: 대분류 (3개씩 청크 — dashboard와 동일) */
  const catJobs = [];
  for (let i = 0; i < CATS.length; i += 3) {
    const chunk = CATS.slice(i, i + 3);
    catJobs.push(datalabJob('shopping/categories', {
      startDate: r10.startDate, endDate: r10.endDate, timeUnit:'week',
      category: chunk.map(c => ({ name: c.name, param: [c.cid] })),
      gender: 'f', ages: ['40','50','60'],
    }));
  }
  console.log(`  카테고리 트렌드 ${catJobs.length}건 조회...`);
  await runAll(catJobs);

  /* ④ 브랜드/상품 추천: 대분류별 인기 검색어 10개 → 트렌드 → 상위 5개 쇼핑 검색
     (dashboard의 loadBrandNode와 동일한 선정 로직) */
  for (const cat of CATS) {
    try {
      const rankData = await fetchKeywordRankRaw(cat.cid, 10);
      if (!rankData.ranks.length) continue;
      entries[`rank|${cat.cid}|10`] = rankData;
      const ranked = rankData.ranks.map(x => x.keyword);

      const brandTrendBodies = [];
      for (let i = 0; i < ranked.length; i += 5) {
        const chunk = ranked.slice(i, i + 5);
        brandTrendBodies.push({
          startDate: r10.startDate, endDate: r10.endDate, timeUnit:'week', category: cat.cid,
          keyword: chunk.map(k => ({ name: k, param: [k] })),
          gender: 'f', ages: ['40','50','60'],
        });
      }
      await runAll(brandTrendBodies.map(b => datalabJob('shopping/keywords', b)), 2);

      const growthMap = new Map();
      for (const b of brandTrendBodies) {
        const j = entries[snapKey('shopping/keywords', b)];
        (j?.results || []).forEach(r => growthMap.set(r.title, growthOf(r.data)));
      }
      const kws = [...ranked].sort((a, b) => (growthMap.get(b) ?? -999) - (growthMap.get(a) ?? -999)).slice(0, 5);
      await runAll(kws.map(k => () => shopJob(k, 20)), 3);
      console.log(`  브랜드 집계 [${cat.name}] 완료 (상위: ${kws.join(', ')})`);
    } catch (e) {
      console.error(`  ✗ 브랜드 집계 [${cat.name}] 실패: ${e.message}`);
    }
  }

  const out = {
    meta: { generatedAt: new Date().toISOString(), range10: r10, range65: r65 },
    entries,
  };
  const file = path.join(__dirname, 'snapshot.json');
  fs.writeFileSync(file, JSON.stringify(out));
  const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
  console.log(`\n✅ snapshot.json 저장 완료 — 항목 ${Object.keys(entries).length}개, ${mb}MB, 데이터랩 호출 ${calls}회, 실패 ${fails}회`);
  if (!Object.keys(entries).length) { console.error('❌ 수집된 데이터가 없습니다.'); process.exit(1); }
})();
