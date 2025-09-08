'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const qs = require('querystring');

/* =========================
   좌표 변환 옵션(매핑 meta로 제어)
   ========================= */
let PREVIEW_W = 1299;          // proof W (units:"px"일 때만 사용)
let PREVIEW_H = 1841;          // proof H (units:"px"일 때만 사용)
let UNITS     = 'pt';          // 'pt' | 'px'  (기본 pt = 스케일 안함)
let Y_ORIGIN  = 'top';         // 'top' | 'baseline'
let NUDGE_X   = 0;             // 전역 미세 보정 (pt)
let NUDGE_Y   = 0;             // 전역 미세 보정 (pt)

function applyMetaCoordinateOptions(meta = {}) {
  if (!meta) return;
  if (typeof meta.previewW === 'number') PREVIEW_W = meta.previewW;
  if (typeof meta.previewH === 'number') PREVIEW_H = meta.previewH;
  if (typeof meta.nudgeX   === 'number') NUDGE_X   = meta.nudgeX;
  if (typeof meta.nudgeY   === 'number') NUDGE_Y   = meta.nudgeY;
  if (typeof meta.units    === 'string') UNITS     = meta.units.toLowerCase();   // 'pt' | 'px'
  if (typeof meta.yOrigin  === 'string') Y_ORIGIN  = meta.yOrigin.toLowerCase(); // 'top' | 'baseline'
}

/* ---------- 좌표 변환 유틸 ---------- */
// (x,y)는 매핑 스튜디오의 숫자.
// UNITS:'pt'이면 스케일 없이 그대로, 'px'면 proof→PDF로 스케일링.
function scaleX(page, x) {
  if (UNITS === 'px') return x * (page.getWidth() / PREVIEW_W);
  return x; // pt 그대로
}
function scaleY(page, y) {
  if (UNITS === 'px') return y * (page.getHeight() / PREVIEW_H);
  return y; // pt 그대로
}
// 스튜디오는 상단 원점이므로 PDF(좌하 원점)로 뒤집고 NUDGE 적용
function toPdfX(page, x) {
  return scaleX(page, x) + NUDGE_X;
}
function toPdfY_fromTop(page, yTop) {
  const y = scaleY(page, yTop);
  return (page.getHeight() - y) + NUDGE_Y;
}
/** 텍스트 찍기용 Y:
 *  yOrigin == 'top' : y값이 "칸의 top" 기준 → 폰트 ascent만큼 내려서 베이스라인 맞춤
 *  yOrigin == 'baseline' : y값이 이미 베이스라인이면 그대로 사용
 */
function toPdfY_forText(page, y, font, size) {
  if (Y_ORIGIN === 'baseline') {
    // y가 이미 베이스라인(=PDF 좌하 원점)이라고 가정 → 좌표 뒤집지만 ascent 보정은 안함
    return toPdfY_fromTop(page, y);
  }
  // 상단 기준 y → PDF 베이스라인으로 보정
  const yTop = toPdfY_fromTop(page, y);
  const ascent = font ? font.ascentAtSize(size) : 0; // 글자 높이만큼 아래로
  return yTop - ascent;
}

/* ---------- helpers ---------- */
function drawText(p, f, t, x, y, s = 10) {
  if (t == null) t = '';
  p.drawText(String(t), {
    x: toPdfX(p, x),
    y: toPdfY_forText(p, y, f, s),
    size: s,
    font: f,
    color: rgb(0, 0, 0)
  });
}

function drawCheck(page, x, y, size = 12, char = 'V', font) {
  page.drawText(String(char || 'V'), {
    x: toPdfX(page, x),
    y: toPdfY_forText(page, y, font, size),
    size,
    font,
    color: rgb(0, 0, 0)
  });
}

function drawLine(p, x1, y1, x2, y2, w = 1) {
  p.drawLine({
    start: { x: toPdfX(p, x1), y: toPdfY_fromTop(p, y1) },
    end:   { x: toPdfX(p, x2), y: toPdfY_fromTop(p, y2) },
    thickness: w, color: rgb(0, 0, 0)
  });
}

function formatApplyDate(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, dd = String(d.getDate()).padStart(2, '0');
  return `신청일자 ${y}년 ${m}월 ${dd}일`;
}
function firstExisting(list) { for (const p of list) try { if (p && fs.existsSync(p)) return p; } catch {} return null; }

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

/** 매핑(JSON) → 내부 통합 형태 */
function normalizeMapping(raw) {
  if (!raw) return { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };

  // 이미 통합 구조(text/checkbox/lines)면 그대로
  if (raw.text || raw.checkbox || raw.lines) {
    if (!raw.meta) raw.meta = { pdf:'template.pdf' };
    if (!raw.meta.pdf) raw.meta.pdf = 'template.pdf';
    return raw;
  }

  // 스튜디오 export(fields/vmap/lines) → 통합 구조로 변환
  const out = { meta:{ pdf:(raw?.meta?.pdf)||'template.pdf', ...raw.meta }, text:{}, checkbox:{}, lines:[] };

  // fields → text
  if (raw.fields) {
    for (const [k,v] of Object.entries(raw.fields)) {
      const key = (v.source && v.source[0]) || k;
      (out.text[key] = out.text[key] || []).push({
        p:+v.page||1, x:+v.x, y:+v.y, size:+v.size||10, font:'malgun'
      });
    }
  }

  // vmap → checkbox (키는 "field:expected" 또는 "field.expected")
  if (raw.vmap) {
    for (const [c,s] of Object.entries(raw.vmap)) {
      const comp = c.includes('.') ? c : c.replace(':','.');
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

/* ---------- 입력 파싱 ---------- */
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
    const maybe = (event.body||'').trim().replace(/^data=/,'');
    try { return JSON.parse(maybe); } catch { return {}; }
  }

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q.data && typeof q.data === 'string') { try { return JSON.parse(q.data); } catch {} }
    return q;
  }
  return {};
}

const hasNonAscii = v => /[^\x00-\x7F]/.test(String(v||''));

/* ---------- handler ---------- */
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers:{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'Content-Type',
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS'
    }, body:'' };
  }

  // 빈 GET → 템플릿으로 리다이렉트
  const qsParams = event.queryStringParameters || {};
  if (event.httpMethod === 'GET' && Object.keys(qsParams).length === 0) {
    return { statusCode:302, headers:{
      Location:'/template.pdf',
      'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'
    }, body:'' };
  }

  // 데이터
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
  let mapping = { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };
  try {
    if (fs.existsSync(mappingPath)) {
      const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      mapping = normalizeMapping(raw);
      applyMetaCoordinateOptions(mapping.meta || {});
    }
  } catch (e) { console.warn('Mapping parse error:', e.message); }

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
    return { statusCode:400, headers:{'Access-Control-Allow-Origin':'*'}, body:`Base PDF not found: ${pdfRel}` };
  }
  const baseBytes = fs.readFileSync(pdfPath);

  const malgunPath = firstExisting([
    path.join(repoRoot, 'malgun.ttf'),
    path.join(__fn, 'malgun.ttf'),
    path.join(process.cwd(), 'malgun.ttf')
  ]);

  // 디버그
  if (event.httpMethod === 'GET' && qsParams.debug === '1') {
    const st = fs.existsSync(pdfPath) ? fs.statSync(pdfPath) : null;
    return {
      statusCode: 200,
      headers: { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' },
      body: JSON.stringify({
        pdfPath, pdfSize: st ? st.size : null,
        mappingPath, mappingMeta: mapping.meta,
        malgunPath,
        previewWH:{ PREVIEW_W, PREVIEW_H },
        units: UNITS, yOrigin: Y_ORIGIN,
        nudge:{ NUDGE_X, NUDGE_Y }
      })
    };
  }

  // PDF 생성
  const pdfDoc = await PDFDocument.load(baseBytes);
  pdfDoc.registerFontkit(fontkit);

  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // 말굿 필요한지 판단
  let useMalgun = false;
  if (mapping.text) {
    for (const [key, spots] of Object.entries(mapping.text)) {
      if (!spots || !spots.length) continue;
      const val = data[key];
      if (hasNonAscii(val)) { useMalgun = true; break; }
      if (spots.some(s => (s.font||'').toLowerCase().includes('malgun'))) { useMalgun = true; break; }
    }
  }
  if (!useMalgun && mapping.text && mapping.text.apply_date && hasNonAscii(data.apply_date)) {
    useMalgun = true;
  }

  let malgun = helv;
  if (useMalgun && malgunPath) {
    try { malgun = await pdfDoc.embedFont(fs.readFileSync(malgunPath), { subset:true }); }
    catch (e) { console.warn('malgun.ttf load failed:', e.message); useMalgun = false; }
  }

  // 렌더링
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

  if (mapping.checkbox) {
    for (const [compound, spots] of Object.entries(mapping.checkbox)) {
      const parts = compound.includes('.') ? compound.split('.') : compound.split(':');
      const field = parts[0], expect = parts[1] || '';
      const v = data[field];
      const match =
        (typeof v === 'boolean') ? (v && expect === 'true')
      : (typeof v === 'string')  ? (v.toLowerCase() === (expect||'').toLowerCase())
      : (v === expect);

      if (match) (spots || []).forEach(s => {
        const page = pdfDoc.getPage((s.p || 1) - 1);
        const font = (s.font && s.font.toLowerCase().includes('malgun')) ? malgun : helv;
        drawCheck(page, s.x, s.y, s.size || 12, s.char || 'V', font);
      });
    }
  }

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
