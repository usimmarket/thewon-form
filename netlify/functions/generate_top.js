'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const qs = require('querystring');

/* =========================
   좌표/스케일 기본값
   - 매핑 스튜디오 proof: 1299 x 1841 (사용자 캡처 기준)
   - 좌표 단위: px, 기준: 상단(top)
   ========================= */
let PREVIEW_W = 1299;
let PREVIEW_H = 1841;
let UNITS     = 'px';     // 'px' | 'pt'
let Y_ORIGIN  = 'top';    // 'top' | 'bottom'
let NUDGE_X   = 0;        // 전체 미세 이동(오른쪽 +)
let NUDGE_Y   = 0;        // 전체 미세 이동(위 +)

/* -------- meta 에서 좌표 옵션 반영 -------- */
function applyMetaCoordinateOptions(meta = {}) {
  if (Number(meta.previewW) > 0) PREVIEW_W = Number(meta.previewW);
  if (Number(meta.previewH) > 0) PREVIEW_H = Number(meta.previewH);
  if (typeof meta.units === 'string') UNITS = meta.units.toLowerCase();
  if (typeof meta.yOrigin === 'string') Y_ORIGIN = meta.yOrigin.toLowerCase();
  if (meta.nudgeX != null) NUDGE_X = Number(meta.nudgeX) || 0;
  if (meta.nudgeY != null) NUDGE_Y = Number(meta.nudgeY) || 0;
}

/* -------- 좌표 변환 -------- */
// x: px→pt 스케일 (pt 그대로 쓰면 무변환)
function toX(page, xVal) {
  const x = Number(xVal) || 0;
  if (UNITS === 'pt') return x + NUDGE_X;
  const pageW = page.getWidth();
  const sx = pageW / PREVIEW_W;
  return (x * sx) + NUDGE_X;
}

// y: 상단 기준(px) → PDF 좌표(pt)
//  - UNITS==='pt' 이면 y 그대로(상단 기준이면 pageH - y 변환만 수행)
function toY(page, yVal) {
  const pageH = page.getHeight();
  const y = Number(yVal) || 0;

  if (UNITS === 'pt') {
    // meta.yOrigin이 'top'이면 상단기준 → PDF 좌표로 뒤집기
    return (Y_ORIGIN === 'top') ? ((pageH - y) + NUDGE_Y) : (y + NUDGE_Y);
  }
  // px → pt 스케일 + 상단 기준 뒤집기
  const sy = pageH / PREVIEW_H;
  const yPtFromTop = y * sy;
  return (pageH - yPtFromTop) + NUDGE_Y;
}

/* -------- draw helpers -------- */
function drawText(page, font, text, x, y, size = 10) {
  const t = (text == null) ? '' : String(text);
  page.drawText(t, {
    x: toX(page, x),
    y: toY(page, y),
    size,
    font,
    color: rgb(0, 0, 0),
  });
}

function drawCheck(page, x, y, size = 12, char = 'V', font) {
  page.drawText(String(char || 'V'), {
    x: toX(page, x),
    y: toY(page, y),
    size,
    font,
    color: rgb(0, 0, 0),
  });
}

function drawLine(page, x1, y1, x2, y2, w = 1) {
  page.drawLine({
    start: { x: toX(page, x1), y: toY(page, y1) },
    end:   { x: toX(page, x2), y: toY(page, y2) },
    thickness: w,
    color: rgb(0, 0, 0),
  });
}

function formatApplyDate(d) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const dd = String(d.getDate()).padStart(2, '0');
  return `신청일자 ${y}년 ${m}월 ${dd}일`;
}

function firstExisting(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

/* -------- 데이터 정규화 -------- */
function normalizeAutopay(d) {
  const m = (d.autopay_method || '').toLowerCase();
  if (m === 'card') {
    const yy = (d.card_exp_year || '').toString().slice(-2);
    const mm = (d.card_exp_month || '').toString().padStart(2, '0');
    if (yy && mm) d.autopay_exp = `${yy}/${mm}`;
    ['bank_name','bank_account'].forEach(k => d[k] = '');
  } else if (m === 'bank') {
    ['card_company','card_number','card_exp_year','card_exp_month','card_name'].forEach(k => d[k] = '');
    d.autopay_exp = d.autopay_exp || '';
  } else {
    const exp = (d.autopay_exp || '').trim();
    const looksCard = !!exp;
    if (looksCard) ['bank_name','bank_account'].forEach(k => d[k] = '');
    else ['card_company','card_number','card_exp_year','card_exp_month','card_name'].forEach(k => d[k] = '');
  }
  if (!d.autopay_org)    d.autopay_org    = (m === 'card') ? (d.card_company || '') : (d.bank_name || d.card_company || '');
  if (!d.autopay_number) d.autopay_number = (m === 'card') ? (d.card_number || '') : (d.bank_account || d.card_number || '');
  if (!d.autopay_holder) d.autopay_holder = (d.card_name || d.holder || d.autopay_holder || '');
  return d;
}

/* -------- 매핑(normalize) : meta를 100% 유지 -------- */
function normalizeMapping(raw) {
  if (!raw) return { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[], fixed_flags:{} };

  // 이미 text/checkbox 형태면 그대로
  if (raw.text || raw.checkbox || raw.lines) {
    if (!raw.meta) raw.meta = { pdf: 'template.pdf' };
    if (!raw.meta.pdf) raw.meta.pdf = 'template.pdf';
    return raw;
  }

  const out = {
    meta: { ...(raw.meta || { pdf: 'template.pdf' }) },
    text: {},
    checkbox: {},
    lines: [],
    fixed_flags: raw.fixed_flags || {}
  };

  // fields → text
  if (raw.fields) {
    for (const [k, v] of Object.entries(raw.fields)) {
      const key = (v.source && v.source[0]) || k;
      (out.text[key] = out.text[key] || []).push({
        p: +v.page || 1, x: +v.x, y: +v.y, size: +v.size || 10, font: 'malgun'
      });
    }
  }

  // vmap → checkbox
  if (raw.vmap) {
    for (const [compound, s] of Object.entries(raw.vmap)) {
      const comp = compound.includes('.') ? compound : compound.replace(':','.');
      (out.checkbox[comp] = out.checkbox[comp] || []).push({
        p:+s.page||1, x:+s.x, y:+s.y, size:+s.size||12
      });
    }
  }

  if (Array.isArray(raw.lines)) {
    out.lines = raw.lines.map(l => ({
      p:+(l.p||l.page||1), x1:+(l.x1||0), y1:+(l.y1||0), x2:+(l.x2||0), y2:+(l.y2||0), w:+(l.w||l.width||1)
    }));
  }

  return out;
}

/* -------- 입력 파싱 -------- */
function parseIncoming(event) {
  const h  = event.headers || {};
  const ct = (h['content-type'] || h['Content-Type'] || '').toLowerCase();

  if (event.httpMethod === 'POST') {
    if (!event.body) return {};
    try { return JSON.parse(event.body); } catch {}
    if (ct.includes('application/x-www-form-urlencoded')) {
      const p = qs.parse(event.body);
      if (p.data && typeof p.data === 'string') { try { return JSON.parse(p.data); } catch {} }
      return p;
    }
    const maybe = (event.body || '').trim().replace(/^data=/, '');
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

/* =========================
   Netlify Function Handler
   ========================= */
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin':'*',
        'Access-Control-Allow-Headers':'Content-Type',
        'Access-Control-Allow-Methods':'GET, POST, OPTIONS'
      },
      body: ''
    };
  }

  // 빈 GET → 템플릿으로 리다이렉트(대형 PDF 생성 회피)
  const qsParams = event.queryStringParameters || {};
  if (event.httpMethod === 'GET' && Object.keys(qsParams).length === 0) {
    return {
      statusCode: 302,
      headers: {
        Location: '/template.pdf',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      },
      body: ''
    };
  }

  // 데이터 준비
  const payload = parseIncoming(event);
  const data = { ...(payload.data || payload || {}) };
  if (!data.apply_date) data.apply_date = formatApplyDate(new Date());
  if ((data.prev_carrier || '').toUpperCase() !== 'MVNO') data.mvno_name = '';
  normalizeAutopay(data);

  // 경로
  const __fn     = __dirname;                        // <repo>/netlify/functions
  const repoRoot = path.resolve(__fn, '../../');     // <repo>/
  const mappingPath = path.join(__fn, 'mappings', 'TOP.json');

  // 매핑 로딩
  let mapping = { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[], fixed_flags:{} };
  try {
    if (fs.existsSync(mappingPath)) {
      const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      mapping = normalizeMapping(raw);
      applyMetaCoordinateOptions(mapping.meta || {});
    }
  } catch (e) {
    console.warn('Mapping parse error:', e.message);
  }

  // 템플릿/폰트
  const pdfRel  = (mapping.meta && mapping.meta.pdf) || 'template.pdf';
  const pdfPath = firstExisting([
    path.join(repoRoot, pdfRel),
    path.join(__fn, pdfRel),
    path.join(repoRoot, 'template.pdf'),
    path.join(__fn, '../../template.pdf'),
    path.join(process.cwd(), pdfRel),
  ]);
  if (!pdfPath) {
    return { statusCode: 400, headers:{'Access-Control-Allow-Origin':'*'}, body:`Base PDF not found: ${pdfRel}` };
  }
  const baseBytes = fs.readFileSync(pdfPath);

  const malgunPath = firstExisting([
    path.join(repoRoot, 'malgun.ttf'),
    path.join(__fn, 'malgun.ttf'),
    path.join(process.cwd(), 'malgun.ttf')
  ]);

  // debug=1 : 현 설정 확인
  if (event.httpMethod === 'GET' && qsParams.debug === '1') {
    const st = fs.existsSync(pdfPath) ? fs.statSync(pdfPath) : null;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        pdfPath, pdfSize: st ? st.size : null,
        mappingPath, mappingMeta: mapping.meta,
        malgunPath,
        previewWH: { PREVIEW_W, PREVIEW_H },
        units: UNITS, yOrigin: Y_ORIGIN,
        nudge: { NUDGE_X, NUDGE_Y }
      })
    };
  }

  // PDF 생성
  const pdfDoc = await PDFDocument.load(baseBytes);
  pdfDoc.registerFontkit(fontkit);

  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // 한글 필요한지 판단 → 말굿 서브셋 임베드
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

  let malgun = helv;
  if (useMalgun && malgunPath) {
    try {
      malgun = await pdfDoc.embedFont(fs.readFileSync(malgunPath), { subset: true });
    } catch (e) {
      console.warn('malgun.ttf load failed:', e.message);
      useMalgun = false;
    }
  }

  // 텍스트
  if (mapping.text) {
    for (const [key, spots] of Object.entries(mapping.text)) {
      const val = data[key];
      (spots || []).forEach(s => {
        const page = pdfDoc.getPage((s.p || 1) - 1);
        const wantsMalgun = (s.font || '').toLowerCase().includes('malgun');
        const font = (wantsMalgun && useMalgun) ? malgun : helv;
        drawText(page, font, val, s.x, s.y, s.size || 10);
      });
    }
  }

  // 체크박스 (문자 기본 V)
  function canon(str) { return String(str || '').toLowerCase().replace(/\s+/g,''); }
  if (mapping.checkbox) {
    for (const [compound, spots] of Object.entries(mapping.checkbox)) {
      const parts  = compound.includes('.') ? compound.split('.') : compound.split(':');
      const field  = parts[0];
      const expect = parts[1] || '';
      const v = data[field];

      const match = (typeof v === 'boolean')
        ? (v && canon(expect) === 'true')
        : (canon(v) === canon(expect));

      if (match) (spots || []).forEach(s => {
        const page = pdfDoc.getPage((s.p || 1) - 1);
        const font = (s.font && s.font.toLowerCase().includes('malgun')) ? malgun : helv;
        drawCheck(page, s.x, s.y, s.size || 12, s.char || 'V', font);
      });
    }
  }

  // 고정 플래그(있으면)
  if (mapping.fixed_flags && mapping.fixed_flags.intl_roaming_block) {
    mapping.fixed_flags.intl_roaming_block.forEach(s => {
      const page = pdfDoc.getPage((s.p || s.page || 1) - 1);
      drawCheck(page, s.x, s.y, s.size || 12, s.char || 'V', malgun);
    });
  }

  // 라인
  if (mapping.lines) {
    (mapping.lines || []).forEach(s => {
      const page = pdfDoc.getPage((s.p || 1) - 1);
      drawLine(page, s.x1, s.y1, s.x2, s.y2, s.w || 1);
    });
  }

  const out = await pdfDoc.save();
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="THE_ONE.pdf"',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    },
    isBase64Encoded: true,
    body: Buffer.from(out).toString('base64')
  };
};
