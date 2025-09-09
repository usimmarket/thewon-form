'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const qs = require('querystring');

/* ----------------------------- 공통 유틸 ----------------------------- */
const hasNonAscii = (v) => /[^\x00-\x7F]/.test(String(v || ''));
function firstExisting(cands) { for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch {} } return null; }
function formatApplyDate(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, dd = String(d.getDate()).padStart(2, '0');
  return `신청일자 ${y}년 ${m}월 ${dd}일`;
}

/* 자동이체 보정 */
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

/* 입력 파싱 */
function parseIncoming(event) {
  const h = event.headers || {}; const ct = (h['content-type'] || h['Content-Type'] || '').toLowerCase();
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

/* 매핑 정규화: 스튜디오 내보내기를 text/checkbox 구조로 변환 */
function normalizeMapping(raw) {
  if (!raw) return { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };

  // 이미 정규 형태
  if (raw.text || raw.checkbox || raw.lines) {
    raw.meta = Object.assign({ pdf:'template.pdf' }, (raw.meta || {}));
    return raw;
  }

  const out = { meta: Object.assign({ pdf: 'template.pdf' }, (raw.meta || {})), text:{}, checkbox:{}, lines:[] };

  if (raw.fields) {
    for (const [k,v] of Object.entries(raw.fields)) {
      const key = (v.source && v.source[0]) || k;
      (out.text[key] = out.text[key] || []).push({
        p:+v.page||1, x:+v.x, y:+v.y, size:+v.size||10, font:(v.font||'malgun')
      });
    }
  }

  if (raw.vmap) {
    for (const [c,s] of Object.entries(raw.vmap)) {
      const comp = c.includes('.') ? c : c.replace(':','.');
      (out.checkbox[comp] = out.checkbox[comp] || []).push({
        p:+s.page||1, x:+s.x, y:+s.y, size:+s.size||12, char:s.char
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

/* 좌표 변환기: TOP.json meta 에 따라 변환 */
function makeTransformer(meta, page, font, size) {
  const units   = String(meta.units || 'px').toLowerCase();   // 'px' | 'pt'
  const yOrigin = String(meta.yOrigin || 'top').toLowerCase(); // 'top' | 'bottom'
  const previewW = +meta.previewW || 0;
  const previewH = +meta.previewH || 0;
  const nudgeX   = +meta.nudgeX || 0;
  const nudgeY   = +meta.nudgeY || 0;

  const pw = page.getWidth();
  const ph = page.getHeight();

  const sx = (units === 'px' && previewW) ? (pw / previewW) : 1;
  const sy = (units === 'px' && previewH) ? (ph / previewH) : 1;

  const ascentAt = (font && font.ascentAtSize) ? (sz)=>font.ascentAtSize(sz) : ()=>0;

  // x: 항상 좌측 기준
  const tx = (xPxOrPt)=> xPxOrPt * sx + nudgeX;

  // y (라인/점용): 원점 설정만 반영
  const tyRaw = (yPxOrPt)=>{
    const yScaled = yPxOrPt * sy;
    if (yOrigin === 'top') return ph - yScaled + nudgeY;
    return yScaled + nudgeY;
  };

  // y (텍스트용: 베이스라인 보정 포함)
  const tyText = (yPxOrPt, sz)=> tyRaw(yPxOrPt) - ascentAt(sz || size || 10);

  return { tx, tyRaw, tyText };
}

/* 그리기 */
function drawText(page, font, txt, x, y, size, tr) {
  page.drawText(String(txt ?? ''), {
    x: tr.tx(x),
    y: tr.tyText(y, size),
    size: size || 10,
    font,
    color: rgb(0,0,0)
  });
}
function drawCheck(page, x, y, size, char, font, tr) {
  page.drawText(String(char || 'V'), {
    x: tr.tx(x),
    y: tr.tyText(y, size),
    size: size || 12,
    font,
    color: rgb(0,0,0)
  });
}
function drawLine(page, x1, y1, x2, y2, w, tr) {
  page.drawLine({
    start: { x: tr.tx(x1), y: tr.tyRaw(y1) },
    end:   { x: tr.tx(x2), y: tr.tyRaw(y2) },
    thickness: w || 1,
    color: rgb(0,0,0)
  });
}

/* ----------------------------- 핸들러 ----------------------------- */
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

  // 빈 GET은 템플릿 반환(리디렉트)
  const qsParams = event.queryStringParameters || {};
  if (event.httpMethod === 'GET' && Object.keys(qsParams).length === 0) {
    return {
      statusCode: 302,
      headers: { Location: '/template.pdf', 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-store' },
      body: ''
    };
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

  // 매핑 로드
  let mapping = { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };
  try {
    if (fs.existsSync(mappingPath)) {
      const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      mapping = normalizeMapping(raw);
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
        pdfPath, pdfSize: st ? st.size : null,
        mappingPath, mappingMeta: mapping.meta,
        malgunPath
      })
    };
  }

  // PDF
  const pdfDoc = await PDFDocument.load(baseBytes);
  pdfDoc.registerFontkit(fontkit);
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // 말굿 필요 여부
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
    try { malgun = await pdfDoc.embedFont(fs.readFileSync(malgunPath), { subset: true }); }
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
        const tr = makeTransformer(mapping.meta || {}, page, font, s.size || 10);
        drawText(page, font, val, +s.x, +s.y, s.size || 10, tr);
      });
    }
  }

  if (mapping.checkbox) {
    for (const [compound, spots] of Object.entries(mapping.checkbox)) {
      const parts = compound.includes('.') ? compound.split('.') : compound.split(':');
      const field = parts[0], expect = parts[1] || '';
      const v = data[field];
      const match = (typeof v === "boolean") ? (v && expect === "true")
                  : (typeof v === "string")  ? (v.toLowerCase() === (expect||"").toLowerCase())
                  : (v === expect);

      if (match) (spots || []).forEach(s => {
        const page = pdfDoc.getPage((s.p || 1) - 1);
        const font = (s.font && s.font.toLowerCase().includes("malgun")) ? malgun : helv;
        const tr = makeTransformer(mapping.meta || {}, page, font, s.size || 12);
        drawCheck(page, +s.x, +s.y, s.size || 12, s.char || 'V', font, tr);
      });
    }
  }

  if (mapping.lines) {
    (mapping.lines || []).forEach(s => {
      const page = pdfDoc.getPage((s.p || 1) - 1);
      const tr = makeTransformer(mapping.meta || {}, page);
      drawLine(page, +s.x1, +s.y1, +s.x2, +s.y2, s.w || 1, tr);
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
