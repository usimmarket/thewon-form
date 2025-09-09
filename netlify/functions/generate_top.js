'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const qs = require('querystring');

/* =========================
   좌표/스케일 설정
   - TOP.json의 meta에서 읽어옵니다.
   - units: "px"(스튜디오 좌표) 또는 "pt"(PDF 포인트)
   - yOrigin: "top"(스튜디오처럼 위가 0) / "bottom"(PDF 기본)
   - previewW/H: 스튜디오 proof 크기(px)
   - nudgeX/Y: 최종 pt에서 미세 보정(우/하 +)
   ========================= */

const DEFAULT_META = {
  pdf: 'template.pdf',
  units: 'px',          // 스튜디오 좌표가 기본
  yOrigin: 'top',
  previewW: 1299,
  previewH: 1841,
  nudgeX: 0,
  nudgeY: 0
};

/* ---------- 좌표 변환 ---------- */
function toX(page, x, meta) {
  if (meta.units === 'px') {
    const sx = page.getWidth() / meta.previewW;
    return x * sx + meta.nudgeX;
  }
  // pt
  return x + meta.nudgeX;
}
function toY(page, y, meta) {
  if (meta.units === 'px') {
    const sy = page.getHeight() / meta.previewH;
    const yPt = y * sy;
    const yTop = (meta.yOrigin || 'top') === 'top'
      ? page.getHeight() - yPt
      : yPt;
    return yTop + meta.nudgeY;
  }
  // pt
  const yPt = y;
  const yTop = (meta.yOrigin || 'top') === 'top'
    ? page.getHeight() - yPt
    : yPt;
  return yTop + meta.nudgeY;
}
// 텍스트는 베이스라인이어서 top 기준으로 조금 올려줍니다.
function toYTop(page, y, font, size, meta) {
  const yPdf = toY(page, y, meta);
  const ascent = font ? font.ascentAtSize(size) : 0;
  return yPdf - ascent;
}

/* ---------- draw helpers ---------- */
function drawText(page, font, text, x, y, size = 10, meta) {
  if (text == null) text = '';
  page.drawText(String(text), {
    x: toX(page, x, meta),
    y: toYTop(page, y, font, size, meta),
    size,
    font,
    color: rgb(0, 0, 0)
  });
}
function drawCheck(page, x, y, size = 12, char = 'V', font, meta) {
  page.drawText(String(char || 'V'), {
    x: toX(page, x, meta),
    y: toYTop(page, y, font, size, meta),
    size,
    font,
    color: rgb(0, 0, 0)
  });
}
function drawLine(page, x1, y1, x2, y2, w = 1, meta) {
  page.drawLine({
    start: { x: toX(page, x1, meta), y: toY(page, y1, meta) },
    end:   { x: toX(page, x2, meta), y: toY(page, y2, meta) },
    thickness: w,
    color: rgb(0, 0, 0)
  });
}

/* ---------- misc ---------- */
function formatApplyDate(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, dd = String(d.getDate()).padStart(2, '0');
  return `신청일자 ${y}년 ${m}월 ${dd}일`;
}
function firstExisting(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}
const hasNonAscii = (v) => /[^\x00-\x7F]/.test(String(v || ''));

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

/* ---------- mapping normalize ----------
   - fields/vmap 형식 → text/checkbox로 변환
   - meta의 모든 속성을 보존 (중요!)
---------------------------------------- */
function normalizeMapping(raw) {
  if (!raw) return { meta: { ...DEFAULT_META }, text:{}, checkbox:{}, lines:[] };

  // 이미 text/checkbox면 보존
  if (raw.text || raw.checkbox || raw.lines) {
    return {
      meta: { ...DEFAULT_META, ...(raw.meta||{}) },
      text: raw.text || {},
      checkbox: raw.checkbox || {},
      lines: raw.lines || []
    };
  }

  const meta = { ...DEFAULT_META, ...(raw.meta || {}) };
  const out = { meta, text:{}, checkbox:{}, lines:[] };

  if (raw.fields) {
    for (const [k, v] of Object.entries(raw.fields)) {
      const key = (v.source && v.source[0]) || k;
      (out.text[key] = out.text[key] || []).push({
        p: +v.page || 1,
        x: +v.x, y: +v.y,
        size: +v.size || 10,
        font: (v.font || 'malgun')
      });
    }
  }
  if (raw.vmap) {
    for (const [comp, s] of Object.entries(raw.vmap)) {
      const key = comp.includes('.') ? comp : comp.replace(':','.');
      (out.checkbox[key] = out.checkbox[key] || []).push({
        p: +s.page || 1,
        x: +s.x, y: +s.y,
        size: +s.size || 12,
        char: s.char || 'V',
        font: s.font || 'malgun'
      });
    }
  }
  if (Array.isArray(raw.lines)) {
    out.lines = raw.lines.map(l => ({
      p:+(l.p||l.page||1),
      x1:+(l.x1||0), y1:+(l.y1||0),
      x2:+(l.x2||0), y2:+(l.y2||0),
      w:+(l.w||l.width||1)
    }));
  }
  return out;
}

/* ---------- payload ---------- */
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

/* =========================
   Netlify Handler
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

  // 빈 GET(쿼리 없음) → 템플릿 직접 보기(대용량 생성 방지)
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

  // 입력 파싱
  const payload = parseIncoming(event);
  const data = { ...(payload.data || payload || {}) };
  if (!data.apply_date) data.apply_date = formatApplyDate(new Date());
  if ((data.prev_carrier || '').toUpperCase() !== 'MVNO') data.mvno_name = '';
  normalizeAutopay(data);

  // 경로
  const __fn = __dirname;                         // <repo>/netlify/functions
  const repoRoot = path.resolve(__fn, '../../');  // <repo>/
  const mappingPath = path.join(__fn, 'mappings', 'TOP.json');

  // 매핑 로드
  let mapping = { meta:{...DEFAULT_META}, text:{}, checkbox:{}, lines:[] };
  try {
    if (fs.existsSync(mappingPath)) {
      const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      mapping = normalizeMapping(raw);
    }
  } catch (e) { console.warn('Mapping parse error:', e.message); }

  // 템플릿/폰트
  const pdfRel = (mapping.meta && mapping.meta.pdf) || 'template.pdf';
  const pdfPath = firstExisting([
    path.join(repoRoot, pdfRel),
    path.join(__fn, pdfRel),
    path.join(repoRoot, 'template.pdf'),
    path.join(__fn, '../../template.pdf'),
    path.join(process.cwd(), pdfRel)
  ]);
  if (!pdfPath) {
    return { statusCode: 400, headers:{'Access-Control-Allow-Origin':'*'}, body: `Base PDF not found: ${pdfRel}` };
  }
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
        pdfPath,
        pdfSize: st ? st.size : null,
        mappingPath,
        mappingMeta: mapping.meta,
        malgunPath,
        units: mapping.meta.units,
        yOrigin: mapping.meta.yOrigin
      })
    };
  }

  // PDF 생성
  const pdfDoc = await PDFDocument.load(baseBytes);
  pdfDoc.registerFontkit(fontkit);

  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // 말굿 사용 여부
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

  const meta = mapping.meta || DEFAULT_META;

  // 텍스트
  if (mapping.text) {
    for (const [key, spots] of Object.entries(mapping.text)) {
      const val = data[key];
      (spots || []).forEach(s => {
        const page = pdfDoc.getPage((s.p || 1) - 1);
        const wantsMalgun = (s.font || '').toLowerCase().includes('malgun');
        const font = (wantsMalgun && useMalgun) ? malgun : helv;
        drawText(page, font, val, s.x, s.y, s.size || 10, meta);
      });
    }
  }

  // 체크
  if (mapping.checkbox) {
    for (const [compound, spots] of Object.entries(mapping.checkbox)) {
      const [field, expectRaw=''] = compound.includes('.') ? compound.split('.') : compound.split(':');
      const v = data[field];
      const expect = String(expectRaw).toLowerCase();

      const match = (typeof v === "boolean") ? (v && expect === "true")
                  : (typeof v === "string")  ? (v.toLowerCase() === expect)
                  : (String(v).toLowerCase() === expect);

      if (match) (spots || []).forEach(s => {
        const page = pdfDoc.getPage((s.p || 1) - 1);
        const font = (s.font && s.font.toLowerCase().includes("malgun")) ? malgun : helv;
        drawCheck(page, s.x, s.y, s.size || 12, s.char || "V", font, meta);
      });
    }
  }

  // 라인
  if (mapping.lines) {
    (mapping.lines || []).forEach(s => {
      const page = pdfDoc.getPage((s.p || 1) - 1);
      drawLine(page, s.x1, s.y1, s.x2, s.y2, s.w || 1, meta);
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
