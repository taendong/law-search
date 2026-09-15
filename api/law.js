// 법제처 국가법령정보 Open API 프록시
//
// 브라우저에서 www.law.go.kr 을 직접 호출하면 CORS 로 막히고,
// OC 인증키도 소스에 그대로 노출된다. 이 함수가 서버 쪽에서 대신 호출한다.
//
// 호출 예시
//   목록  : /api/law?target=prec&query=부당해고&page=1&display=20
//   본문  : /api/law?target=prec&id=228234
//   원문  : /api/law?target=prec&id=228234&format=html
//
// 위원회 결정문(ftc, nlrc 등)은 공식 문서상 JSON 을 지원하지 않는다.
// 그래서 JSON 이 안 오면 XML 로 다시 받아 서버에서 변환한다.

const TARGETS = new Set([
  // 판례·해석례
  'prec',    // 판례
  'detc',    // 헌재결정례
  'expc',    // 법령해석례
  'decc',    // 행정심판례
  // 법령·규칙
  'law',     // 현행법령
  'admrul',  // 행정규칙 (공정위 심사지침, 고용부 지침 등)
  // 위원회 결정문
  'nlrc',    // 노동위원회
  'ftc',     // 공정거래위원회
  'eiac',    // 고용보험심사위원회
  'iaciac',  // 산업재해보상보험재심사위원회
  'acr',     // 국민권익위원회
  'fsc',     // 금융위원회
  'sfc',     // 증권선물위원회
  'kcc',     // 방송통신위원회
  'nhrck',   // 국가인권위원회
  'ecc',     // 중앙환경분쟁조정위원회
  'oclt',    // 중앙토지수용위원회
]);

export default async function handler(req, res) {
  const OC = process.env.LAW_OC;
  if (!OC) {
    return json(res, 500, {
      error: 'config',
      message: 'LAW_OC 환경변수가 없습니다. Vercel 프로젝트 설정에서 등록한 뒤 다시 배포하세요.',
    });
  }

  const { target = 'prec', query = '', id = '', page = '1', display = '20', format = '' } = req.query;
  const wantHtml = format === 'html';

  if (!TARGETS.has(target)) {
    return json(res, 400, { error: 'target', message: `지원하지 않는 검색 대상입니다: ${target}` });
  }
  if (!id && !query.trim()) {
    return json(res, 400, { error: 'query', message: '검색어를 입력하세요.' });
  }

  const n = Math.min(Math.max(parseInt(display, 10) || 20, 1), 100);
  const p = Math.min(Math.max(parseInt(page, 10) || 1, 1), 100);

  const build = (type) => {
    const params = new URLSearchParams({ OC, target, type });
    if (id) {
      params.set('ID', id);
    } else {
      params.set('query', query);
      params.set('search', '2'); // 제목 + 본문 검색
      params.set('display', String(n));
      params.set('page', String(p));
    }
    return `https://www.law.go.kr/DRF/${id ? 'lawService.do' : 'lawSearch.do'}?${params.toString()}`;
  };

  try {
    // 원문 보기: 법제처 HTML 을 그대로 통과시킨다.
    if (wantHtml) {
      const r = await get(build('HTML'));
      const body = await r.text();
      // 상대경로 CSS·이미지가 우리 도메인에서 깨지지 않도록 base 를 심는다.
      const withBase = body.replace(/<head([^>]*)>/i, '<head$1><base href="https://www.law.go.kr/">');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(withBase);
    }

    // 1차: JSON
    const jsonRes = await get(build('JSON'));
    const jsonBody = await jsonRes.text();
    if (looksJson(jsonBody)) return sendJson(res, jsonBody);

    // 2차: XML (위원회 결정문 등 JSON 미지원 대상)
    const xmlRes = await get(build('XML'));
    const xmlBody = await xmlRes.text();
    if (looksXml(xmlBody)) {
      return sendJson(res, JSON.stringify(xmlToObj(xmlBody)));
    }

    return json(res, 502, {
      error: 'upstream',
      message: '법제처가 JSON·XML 어느 쪽도 돌려주지 않았습니다. OC 인증키와 해당 서비스 신청 여부를 확인하세요.',
      preview: stripHtml(xmlBody).slice(0, 200),
    });
  } catch (e) {
    return json(res, 502, { error: 'network', message: '법제처에 연결하지 못했습니다.', detail: String(e) });
  }
}

/* -------------------------------------------------------------- */

function get(url) {
  return fetch(url, {
    headers: {
      // 이 두 개가 없으면 법제처가 '사용자 정보 검증 실패'를 반환하는 경우가 있다.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Referer: 'https://www.law.go.kr/',
      Accept: 'application/json,text/xml,*/*',
    },
  });
}

const looksJson = (s) => /^\s*[{[]/.test(s);
const looksXml = (s) => /^\s*<\?xml|^\s*<[A-Za-z가-힣]/.test(s) && /<\/[A-Za-z가-힣]/.test(s);

function sendJson(res, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  return res.status(200).send(body);
}
function json(res, status, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).send(JSON.stringify(obj));
}
const stripHtml = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/* -------------------------------------------------------------- */
/* 최소한의 XML → 객체 변환.
   법제처 XML 은 구조가 단순하다(루트 아래 메타 필드 + 반복되는 항목 요소).
   본문 필드에는 <p>, <br> 같은 HTML 이 섞여 들어오므로 그건 텍스트로 둔다. */

const HTML_TAGS = /^(p|br|div|span|table|thead|tbody|tr|td|th|b|i|u|em|strong|font|img|a|ul|ol|li|hr|center|pre)$/i;
// 재귀 호출마다 새로 만든다. /g 정규식을 공유하면 lastIndex 가 뒤엉켜 무한 루프가 된다.
const nodeRe = () => /<([A-Za-z0-9_가-힣:.-]+)([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;

function xmlToObj(xml) {
  const clean = xml.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  return parseNodes(clean);
}

function parseNodes(s) {
  const out = {};
  const re = nodeRe();
  let m;
  while ((m = re.exec(s))) {
    const name = m[1];
    const inner = m[3] === undefined ? '' : m[3];
    const value = hasChildElements(inner) ? parseNodes(inner) : textOf(inner);
    if (out[name] === undefined) out[name] = value;
    else if (Array.isArray(out[name])) out[name].push(value);
    else out[name] = [out[name], value];
  }
  return out;
}

function hasChildElements(inner) {
  if (/^\s*<!\[CDATA\[/.test(inner)) return false; // CDATA 는 통째로 텍스트
  const m = inner.match(/<([A-Za-z0-9_가-힣:.-]+)[^>]*>/);
  if (!m) return false;
  if (HTML_TAGS.test(m[1])) return false;           // 본문에 섞인 HTML
  return new RegExp(`</${m[1]}\\s*>`).test(inner);  // 닫는 태그가 실제로 있는가
}

function textOf(inner) {
  return inner
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim();
}
