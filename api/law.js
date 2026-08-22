// 법제처 국가법령정보 Open API 프록시
//
// 브라우저에서 www.law.go.kr 을 직접 호출하면 CORS 로 막히고,
// OC 인증키도 소스에 그대로 노출된다. 이 함수가 서버 쪽에서 대신 호출한다.
//
// 호출 예시
//   목록  : /api/law?target=prec&query=부당해고&page=1&display=20
//   본문  : /api/law?target=prec&id=228234

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

  const endpoint = id ? 'lawService.do' : 'lawSearch.do';
  const params = new URLSearchParams({ OC, target, type: wantHtml ? 'HTML' : 'JSON' });
  if (id) {
    params.set('ID', id);
  } else {
    params.set('query', query);
    params.set('search', '2'); // 제목 + 본문 검색
    params.set('display', String(n));
    params.set('page', String(p));
  }

  const url = `https://www.law.go.kr/DRF/${endpoint}?${params.toString()}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        // 이 두 개가 없으면 법제처가 '사용자 정보 검증 실패'를 반환하는 경우가 있다.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://www.law.go.kr/',
        Accept: 'application/json,text/plain,*/*',
      },
    });

    const body = await upstream.text();

    if (wantHtml) {
      // 상대경로 CSS·이미지가 우리 도메인에서 깨지지 않도록 base 를 심는다.
      const withBase = body.replace(/<head([^>]*)>/i, '<head$1><base href="https://www.law.go.kr/">');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(withBase);
    }

    // 법제처는 오류 상황에서도 200 + HTML 을 돌려주는 경우가 있다.
    const looksLikeJson = body.trim().startsWith('{') || body.trim().startsWith('[');
    if (!looksLikeJson) {
      return json(res, 502, {
        error: 'upstream',
        message: '법제처에서 JSON 대신 다른 응답이 왔습니다. OC 인증키와 해당 서비스 신청 여부를 확인하세요.',
        preview: body.slice(0, 300),
      });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).send(body);
  } catch (e) {
    return json(res, 502, { error: 'network', message: '법제처에 연결하지 못했습니다.', detail: String(e) });
  }
}

function json(res, status, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).send(JSON.stringify(obj));
}
