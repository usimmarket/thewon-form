'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const qs = require('querystring');

/* =========================
   좌표 변환 기본값 (스튜디오 proof 값)
   =========================
   매핑 스튜디오 화면 우상단에 보이는 proof: W,H 를 넣어두세요.
   예) proof: 1299, 1841 → 아래 PREVIEW_W/H 를 1299, 1841 로 설정
   TOP.json의 meta.previewW/H가 있으면 그 값으로 자동 덮어씁니다.
*/
let PREVIEW_W = 1299;
let PREVIEW_H = 1841;

// 전체가 살짝 쏠릴 때 미세 보정(단위 pt). +X=오른쪽, -X=왼쪽 / +Y=위, -Y=아래
let NUDGE_X = 0;
let NUDGE_Y = 0;

/** meta.previewW/H, nudgeX/Y 로 덮어쓰기 */
function applyMetaToPreview(meta = {}) {
  const mw = Number(meta.previewW);
  const mh = Number(meta.previewH);
  const nx = Number(meta.nudgeX);
  const ny = Number(meta.nudgeY);
  if (mw > 0) PREVIEW_W = mw;
  if (mh > 0) PREVIEW_H = mh;
  if (!Number.isNaN(nx)) NUDGE_X = nx;
  if (!Number.isNaN(ny)) NUDGE_Y = ny;
}

/* ---------- 좌표 변환 유틸 ---------- */
/** 스튜디오 px 좌표(x,y) → PDF pt 좌표로 변환 (Y축 뒤집기 + 스케일 + 너지) */
function tx(page, xPx, yPx) {
  const { width, height } = page.getSize();

  // previewW/H 가 있으면 스케일, 없으면 좌표를 pt로 간주(안전)
  const sx = PREVIEW_W > 0 ? (width / PREVIEW_W) : 1;
  const sy = PREVIEW_H > 0 ? (height / PREVIEW_H) : 1;

  const x = xPx * sx + NUDGE_X;
  const y = height - (yPx * sy) + NUDGE_Y; // PDF 좌표는 하단 원점
  return { x, y };
}

/* ---------- helpers ---------- */
function drawText(page, font, text, xPx, yPx, size = 10) {
  if (text == null) text = '';
  const { x, y } = tx(page, xPx, yPx);
  page.drawText(String(text), { x, y, size, font, color: rgb(0, 0, 0) });
}

// 체크 표시(문자는 기본 'V', spot에서 char 지정 가능)
function drawCheck(page, xPx, yPx, size = 12, char = 'V', font) {
  const { x, y } = tx(page, xPx, yPx);
  page.drawText(String(char || 'V'), { x, y, size, font, color: rgb(0, 0, 0) });
}

function drawLine(page, x1Px, y1Px, x2Px, y2Px, w = 1) {
  const p1 = tx(page, x1Px, y1Px);
  const p2 = tx(page, x2Px, y2Px);
  page.drawLine({
    start: { x: p1.x, y: p1.y },
    end: { x: p2.x, y: p2.y },
    thickness: w,
    color: rgb(0, 0, 0),
  });
}

function formatApplyDate(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, dd = String(d.getDate()).padStart(2, '0');
  return `신청일자 ${y}년 ${m}월 ${dd}일`;
}
function firstExisting(cands) {
  for (const p of cands) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function normalizeAutopay(d) {
  const m = (d.autopay_method || '').toLowerCase();
  if (m === 'card') {
    const yy = (d.card_exp_year || '').toString().slice(-2);
    const mm = (d.card_exp_month || '').toString().padStart(2, '0');
    if (yy && mm) d.autopay_exp = `${yy}/${mm}`;
    ['bank_name', 'bank_account'].forEach(k => d[k] = '');
  } else if (m === 'bank') {
    ['card_company', 'card_number', 'card_exp_year', 'card_exp_month', 'card_name'].forEach(k => d[k] = '');
    d.autopay_exp = d.autopay_exp || '';
  } else {
    const exp = (d.autopay_exp || '').trim();
    const looksCard = !!exp;
    if (looksCard) ['bank_name', 'bank_account'].forEach(k => d[k] = '');
    else ['card_company', 'card_number', 'card_exp_year', 'card_exp_month', 'card_name'].forEach(k => d[k] = '');
  }
  if (!d.autopay_org)    d.autopay_org    = (m === 'card') ? (d.card_company || '') : (d.bank_name || d.card_company || '');
  if (!d.autopay_number) d.autopay_number = (m === 'card') ? (d.card_number || '') : (d.bank_account || d.card_number || '');
  if (!d.autopay_holder) d.autopay_holder = (d.card_name || d.holder || d.autopay_holder || '');
  return d;
}

/** 🔧 메타 전체 보존 버전 (previewW/H, nudgeX/Y 포함) */
function normalizeMapping(raw) {
  if (!raw) return { meta: { pdf: 'template.pdf' }, text: {}, checkbox: {}, lines: [] };

  // 이미 내부 구조(text/checkbox/lines)인 경우: meta 전체 보존
  if (raw.text || raw.checkbox || raw.lines) {
    const meta = { pdf: 'template.pdf', ...(raw.meta || {}) };
    if (!meta.pdf) meta.pdf = 'template.pdf';
    return { ...raw, meta };
  }

  // 스튜디오 원본(fields/vmap) → 내부 구조 변환 + meta 전체 보존
  const meta = { pdf: 'template.pdf', ...(raw.meta || {}) };
  const out = { meta, text: {}, checkbox: {}, lines: [] };

  if (raw.fields) {
    for (const [k, v] of Object.entries(raw.fields)) {
      const key = (v.source && v.source[0]) || k;
      (out.text[key] = out.text[key] || []).push({
        p: +v.page || 1,
        x: +v.x, y: +v.y,
        size: +v.size || 10,
        font: (v.font || 'malgun'),
      });
    }
  }

  if (raw.vmap) {
    for (const [comp, s] of Object.entries(raw.vmap)) {
      const key = comp.includes('.') ? comp : comp.replace(':', '.');
      (out.checkbox[key] = out.checkbox[key] || []).push({
        p: +s.page || 1,
        x: +s.x, y: +s.y,
        size: +s.size || 12,
        char: s.char || 'V',
        font: s.font || '',
      });
    }
  }

  if (Array.isArray(raw.lines)) {
    out.lines = raw.lines.map(l => ({
      p: +(l.p || l.page || 1),
      x1: +(l.x1 || 0), y1: +(l.y1 || 0),
      x2: +(l.x2 || 0), y2: +(l.y2 || 0),
      w: +(l.w || l.width || 1),
    }));
  }

  return out;
}

function parseIncoming(event) {
  const h = event.headers || {};
  const ct = (h['content-type'] || h['Content-Type'] || '').toLowerCase();

  if (event.httpMethod === 'POST') {
    if (!event.body) return {};
    try { return JSON.parse(event.body); } catch {}
    if (ct.includes('application/x-www-form-urlencoded')) {
      const p = qs.parse(event.body);
      if (p.data && typeof p.data === 'string') { try { return JSON.parse(p.data); } catch {} }
      return p;
    }
    const maybe = event.body.trim().replace(/^data=/, '');
    try { return JSON.parse(maybe); } catch { return {}; }
  }

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q.data && typeof q.data === 'string') { try { return JSON.parse(q.data); } catch {} }
    return q;
  }

  return {};
}

const hasNonAscii = v => /[^\x00-\x7F]/.test(String(v || ''));

/* ---------- handler ---------- */
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
      body: '',
    };
  }

  // 빈 GET(쿼리 없음)은 템플릿으로 리다이렉트(큰 PDF 생성 회피)
  const qsParams = event.queryStringParameters || {};
  if (event.httpMethod === 'GET' && Object.keys(qsParams).length === 0) {
    return {
      statusCode: 302,
      headers: {
        Location: '/template.pdf',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  }

  // 입력 데이터 파싱/정규화
  const payload = parseIncoming(event);
  const data = { ...(payload.data || payload || {}) };
  if (!data.apply_date) data.apply_date = formatApplyDate(new Date());
  if ((data.prev_carrier || '').toUpperCase() !== 'MVNO') data.mvno_name = '';
  normalizeAutopay(data);

  // 경로
  const __fn = __dirname;                         // <repo>/netlify/functions
  const repoRoot = path.resolve(__fn, '../../');  // <repo>/
  const mappingPath = path.join(__fn, 'mappings', 'TOP.json');

  // 매핑 로딩
  let mapping = { meta: { pdf: 'template.pdf' }, text: {}, checkbox: {}, lines: [] };
  try {
    if (fs.existsSync(mappingPath)) {
      const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      mapping = normalizeMapping(raw);
      // meta 의 previewW/H, nudgeX/Y 를 좌표 변환에 반영
      applyMetaToPreview(mapping.meta || {});
    }
  } catch (e) {
    console.warn('Mapping parse error:', e.message);
  }

  // 템플릿/폰트 찾기
  const pdfRel  = (mapping.meta && mapping.meta.pdf) || 'template.pdf';
  const pdfPath = firstExisting([
    path.join(repoRoot, pdfRel),
    path.join(__fn, pdfRel),
    path.join(repoRoot, 'template.pdf'),
    path.join(__fn, '../../template.pdf'),
    path.join(process.cwd(), pdfRel),
  ]);
  if (!pdfPath) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: `Base PDF not found: ${pdfRel}`,
    };
  }
  const baseBytes = fs.readFileSync(pdfPath);

  const malgunPath = firstExisting([
    path.join(repoRoot, 'malgun.ttf'),
    path.join(__fn, 'malgun.ttf'),
    path.join(process.cwd(), 'malgun.ttf'),
  ]);

  // 디버그(JSON)
  if (event.httpMethod === 'GET' && (qsParams.debug === '1')) {
    const st = fs.existsSync(pdfPath) ? fs.statSync(pdfPath) : null;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        pdfPath,
        pdfSize: st ? st.size : null,
        mappingPath,
        mappingMeta: mapping.meta,         // 이제 previewW/H, nudgeX/Y 보존됨
        malgunPath,
        previewWH: { PREVIEW_W, PREVIEW_H },
        nudge: { NUDGE_X, NUDGE_Y },
      }),
    };
  }

  // PDF 생성
  const pdfDoc = await PDFDocument.load(baseBytes);
  pdfDoc.registerFontkit(fontkit);

  // 기본 폰트(영문/숫자 등)
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // 말굿 사용 판단
  let useMalgun = false;
  if (mapping.text) {
    for (const [key, spots] of Object.entries(mapping.text)) {
      if (!spots || !spots.length) continue;
      const val = data[key];
      if (hasNonAscii(val)) { useMalgun = true; break; }
      if (spots.some(s => (s.font || '').toLowerCase().includes('malgun'))) { useMalgun = true; break; }
    }
  }
  if (!useMalgun && mapping.text && mapping.text.apply_date && hasNonAscii(data.apply_date)) {
    useMalgun = true;
  }

  // 말굿은 필요한 경우에만 서브셋 임베드
  let malgun = helv;
  if (useMalgun && malgunPath) {
    try {
      malgun = await pdfDoc.embedFont(fs.readFileSync(malgunPath), { subset: true });
    } catch (e) {
      console.warn('malgun.ttf load failed:', e.message);
      useMalgun = false; // 실패 시 헬베티카로 대체
    }
  }

  // 렌더링
  // 텍스트
  for (const [key, spots] of Object.entries(mapping.text || {})) {
    const val = data[key];
    (spots || []).forEach(s => {
      const page = pdfDoc.getPage((s.p || 1) - 1);
      const wantsMalgun = (s.font || '').toLowerCase().includes('malgun');
      const font = (wantsMalgun && useMalgun) ? malgun : helv;
      drawText(page, font, val, s.x, s.y, s.size || 10);
    });
  }

  // 체크
  for (const [compound, spots] of Object.entries(mapping.checkbox || {})) {
    const [field, expectRaw = ''] = compound.includes('.') ? compound.split('.') : compound.split(':');
    const expect = String(expectRaw);
    const v = data[field];

    const match =
      (typeof v === 'boolean') ? (v && expect.toLowerCase() === 'true') :
      (typeof v === 'string')  ? (v.toLowerCase() === expect.toLowerCase()) :
      (v === expect);

    if (match) (spots || []).forEach(s => {
      const page = pdfDoc.getPage((s.p || 1) - 1);
      const font = (s.font && s.font.toLowerCase().includes('malgun')) ? malgun : helv;
      drawCheck(page, s.x, s.y, s.size || 12, s.char || 'V', font);
    });
  }

  // 라인
  (mapping.lines || []).forEach(s => {
    const page = pdfDoc.getPage((s.p || 1) - 1);
    drawLine(page, s.x1, s.y1, s.x2, s.y2, s.w || 1);
  });

  const out = await pdfDoc.save();
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="THE_ONE.pdf"',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
    isBase64Encoded: true,
    body: Buffer.from(out).toString('base64'),
  };
};
