'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const qs = require('querystring');

/* =========================
   좌표 변환 파라미터 (TOP.json의 meta로 제어)
   ========================= */
let META = {
  // 스튜디오 preview 이미지의 픽셀 크기 (반드시 설정)
  previewW: 1299,
  previewH: 1841,

  // 좌표 단위: 'px' 또는 'pt'
  units: 'px',

  // y 원점: 'top' 또는 'bottom' (스튜디오=top)
  yOrigin: 'top',

  // 전역 오프셋 (pt 단위, +x=오른쪽, +y=위)
  nudgeX: 0,
  nudgeY: 0,

  // 전역 스케일 미세보정(1.0=그대로)
  scaleX: 1.0,
  scaleY: 1.0,

  // 텍스트/체크의 베이스라인 보정(단위 pt, +면 위로)
  textDy: -2.0,
  checkDy: -2.0
};

function applyMeta(m = {}) {
  const readNum = (v, d) => (typeof v === 'number' && !Number.isNaN(v)) ? v : d;

  META.previewW = readNum(m.previewW, META.previewW);
  META.previewH = readNum(m.previewH, META.previewH);
  META.units    = (m.units === 'pt' || m.units === 'px') ? m.units : META.units;
  META.yOrigin  = (m.yOrigin === 'bottom') ? 'bottom' : 'top';

  META.nudgeX = readNum(m.nudgeX, META.nudgeX);
  META.nudgeY = readNum(m.nudgeY, META.nudgeY);
  META.scaleX = readNum(m.scaleX, META.scaleX);
  META.scaleY = readNum(m.scaleY, META.scaleY);

  META.textDy  = readNum(m.textDy, META.textDy);
  META.checkDy = readNum(m.checkDy, META.checkDy);
}

/* ---------- 좌표 변환 ---------- */
function pxToPtX(page, xPx) {
  const pageW = page.getWidth();
  const sx = (pageW / META.previewW) * META.scaleX;
  return xPx * sx;
}
function pxToPtY(page, yPx) {
  const pageH = page.getHeight();
  const sy = (pageH / META.previewH) * META.scaleY;
  // 스튜디오 좌표는 상단 기준 → PDF는 하단 기준
  const yFromBottom = (META.yOrigin === 'top') ? (pageH - (yPx * sy)) : (yPx * sy);
  return yFromBottom;
}
function toX(page, xVal) {
  if (META.units === 'pt') return (xVal * META.scaleX) + META.nudgeX;
  return pxToPtX(page, xVal) + META.nudgeX;
}
function toY(page, yVal) {
  const base = (META.units === 'pt')
    ? ((META.yOrigin === 'top') ? (page.getHeight() - (yVal * META.scaleY)) : (yVal * META.scaleY))
    : pxToPtY(page, yVal);
  return base + META.nudgeY;
}

// 텍스트/체크는 베이스라인 보정 적용
function toY_text(page, yVal, font, size, extraDy = 0) {
  // 폰트 실제 ascent를 쓰면 과하게 올라가는 경우가 있어, 경험값 + 사용자가 조절하는 textDy를 혼합
  const fudge = size * 0.78; // cap-height 근사
  return toY(page, yVal) - fudge + META.textDy + (extraDy || 0);
}
function toY_check(page, yVal, font, size, extraDy = 0) {
  const fudge = size * 0.78;
  return toY(page, yVal) - fudge + META.checkDy + (extraDy || 0);
}

/* ---------- helpers ---------- */
function drawText(p, f, t, x, y, s = 10) {
  if (t == null) t = '';
  p.drawText(String(t), { x: toX(p, x), y: toY_text(p, y, f, s), size: s, font: f, color: rgb(0,0,0) });
}

function drawCheck(p, x, y, size = 12, char = 'V', font) {
  p.drawText(String(char || 'V'), { x: toX(p, x), y: toY_check(p, y, font, size), size, font, color: rgb(0,0,0) });
}

function drawLine(p, x1, y1, x2, y2, w = 1) {
  p.drawLine({ start: { x: toX(p, x1), y: toY(p, y1) }, end: { x: toX(p, x2), y: toY(p, y2) }, thickness: w, color: rgb(0,0,0) });
}

function formatApplyDate(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, dd = String(d.getDate()).padStart(2,'0');
  return `신청일자 ${y}년 ${m}월 ${dd}일`;
}
function firstExisting(list) {
  for (const p of list) { try { if (p && fs.existsSync(p)) return p; } catch {} }
  return null;
}

/* ---------- 데이터 정리 ---------- */
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

/* ---------- 매핑 읽기 ---------- */
function normalizeMapping(raw) {
  if (!raw) return { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };

  // 새 형식(text/checkbox/lines) 지원
  if (raw.text || raw.checkbox || raw.lines) {
    if (!raw.meta) raw.meta = { pdf: 'template.pdf' };
    if (!raw.meta.pdf) raw.meta.pdf = 'template.pdf';
    return raw;
  }

  // 스튜디오 내보내기(fields/vmap) → 엔진 내부형으로 변환
  const out = { meta: { pdf: (raw?.meta?.pdf)||'template.pdf', ...raw.meta }, text:{}, checkbox:{}, lines:[] };
  if (raw.fields) for (const [k,v] of Object.entries(raw.fields)) {
    const key = (v.source && v.source[0]) || k;
    (out.text[key] = out.text[key] || []).push({ p:+v.page||1, x:+v.x, y:+v.y, size:+v.size||10, font:'malgun' });
  }
  if (raw.vmap) for (const [c,s] of Object.entries(raw.vmap)) {
    const comp = c.includes('.') ? c : c.replace(':','.');
    (out.checkbox[comp] = out.checkbox[comp] || []).push({ p:+s.page||1, x:+s.x, y:+s.y, size:+s.size||12 });
  }
  if (Array.isArray(raw.lines)) out.lines = raw.lines.map(l => ({
    p:+(l.p||l.page||1), x1:+(l.x1||0), y1:+(l.y1||0), x2:+(l.x2||0), y2:+(l.y2||0), w:+(l.w||l.width||1)
  }));
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
    const maybe = event.body.trim().replace(/^data=/,'');
    try { return JSON.parse(maybe); } catch { return {}; }
  }
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q.data && typeof q.data === 'string') { try { return JSON.parse(q.data); } catch {} }
    return q;
  }
  return {};
}

const hasNonAscii = (v) => /[^\x00-\x7F]/.test(String(v || ''));

/* ---------- handler ---------- */
exports.handler = async (event) => {
  // CORS
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

  // 빈 GET은 템플릿 리다이렉트
  const qsParams = event.queryStringParameters || {};
  if (event.httpMethod === 'GET' && Object.keys(qsParams).length === 0) {
    return { statusCode: 302, headers: { Location: '/template.pdf', 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-store' }, body: '' };
  }

  // 입력
  const payload = parseIncoming(event);
  const data = { ...(payload.data || payload || {}) };
  if (!data.apply_date) data.apply_date = formatApplyDate(new Date());
  if ((data.prev_carrier || '').toUpperCase() !== 'MVNO') data.mvno_name = '';
  normalizeAutopay(data);

  // 경로
  const __fn = __dirname;                        // <repo>/netlify/functions
  const repoRoot = path.resolve(__fn, '../../'); // <repo>/
  const mappingPath = path.join(__fn, 'mappings', 'TOP.json');

  // 매핑 로드
  let mapping = { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };
  try {
    if (fs.existsSync(mappingPath)) {
      const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      mapping = normalizeMapping(raw);
      applyMeta(mapping.meta || {});
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
    path.join(process.cwd(), pdfRel)
  ]);
  if (!pdfPath) return { statusCode: 400, headers:{'Access-Control-Allow-Origin':'*'}, body: `Base PDF not found: ${pdfRel}` };
  const baseBytes = fs.readFileSync(pdfPath);

  const malgunPath = firstExisting([
    path.join(repoRoot, 'malgun.ttf'),
    path.join(__fn, 'malgun.ttf'),
    path.join(process.cwd(), 'malgun.ttf')
  ]);

  // 디버그
  if (event.httpMethod === 'GET' && (qsParams.debug === '1')) {
    const st = fs.existsSync(pdfPath) ? fs.statSync(pdfPath) : null;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        pdfPath, pdfSize: st ? st.size : null,
        mappingPath, mappingMeta: mapping.meta,
        malgunPath, previewWH: { previewW: META.previewW, previewH: META.previewH },
        units: META.units, yOrigin: META.yOrigin,
        nudge: { nudgeX: META.nudgeX, nudgeY: META.nudgeY },
        scale: { scaleX: META.scaleX, scaleY: META.scaleY },
        dy: { textDy: META.textDy, checkDy: META.checkDy }
      })
    };
  }

  // PDF 생성
  const pdfDoc = await PDFDocument.load(baseBytes);
  pdfDoc.registerFontkit(fontkit);
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // 한글 필요 시 말굿
  let useMalgun = false;
  if (mapping.text) {
    for (const [k, spots] of Object.entries(mapping.text)) {
      if (!spots || !spots.length) continue;
      const val = data[k];
      if (hasNonAscii(val)) { useMalgun = true; break; }
      if (spots.some(s => (s.font || '').toLowerCase().includes('malgun'))) { useMalgun = true; break; }
    }
  }
  if (!useMalgun && mapping.text && mapping.text.apply_date && hasNonAscii(data.apply_date)) useMalgun = true;

  let malgun = helv;
  if (useMalgun && malgunPath) {
    try { malgun = await pdfDoc.embedFont(fs.readFileSync(malgunPath), { subset: true }); }
    catch (e) { console.warn('malgun.ttf load failed:', e.message); }
  }

  // 렌더링
  if (mapping.text) {
    for (const [key, spots] of Object.entries(mapping.text)) {
      const val = data[key];
      (spots || []).forEach(s => {
        const page = pdfDoc.getPage((s.p || 1) - 1);
        const wantsMalgun = (s.font || '').toLowerCase().includes('malgun');
        const font = (wantsMalgun ? malgun : helv);
        drawText(page, font, val, s.x, s.y, s.size || 10);
      });
    }
  }

  if (mapping.checkbox) {
    for (const [compound, spots] of Object.entries(mapping.checkbox)) {
      const [field, expect = ''] = compound.includes('.') ? compound.split('.') : compound.split(':');
      const v = data[field];
      const match = (typeof v === 'boolean') ? (v && expect === 'true')
                  : (typeof v === 'string')  ? (v.toLowerCase() === (expect||'').toLowerCase())
                  : (v === expect);
      if (match) (spots || []).forEach(s => {
        const page = pdfDoc.getPage((s.p || 1) - 1);
        const font = (s.font && s.font.toLowerCase().includes('malgun')) ? malgun : helv;
        drawCheck(page, s.x, s.y, s.size || 12, s.char || 'V', font);
      });
    }
  }

  (mapping.lines || []).forEach(s => {
    const page = pdfDoc.getPage((s.p || 1) - 1);
    drawLine(page, s.x1, s.y1, s.x2, s.y2, s.w || 1);
  });

  const out = await pdfDoc.save();
  return {
    statusCode: 200,
    headers: {
      'Content-Type':'application/pdf',
      'Content-Disposition':'inline; filename="THE_ONE.pdf"',
      'Access-Control-Allow-Origin':'*',
      'Cache-Control':'no-store'
    },
    isBase64Encoded: true,
    body: Buffer.from(out).toString('base64')
  };
};
