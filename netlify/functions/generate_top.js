'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const qs = require('querystring');

/* ---------- helpers ---------- */
function drawText(page, font, text, x, y, size = 10) {
  if (text == null) text = '';
  page.drawText(String(text), { x, y, size, font, color: rgb(0, 0, 0) });
}
function drawCheck(page, x, y, size = 12) { page.drawText('✓', { x, y, size, color: rgb(0, 0, 0) }); }
function drawLine(page, x1, y1, x2, y2, width = 1) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: width, color: rgb(0, 0, 0) });
}
function formatApplyDate(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, dd = String(d.getDate()).padStart(2, '0');
  return `신청일자 ${y}년 ${m}월 ${dd}일`;
}
function firstExistingPath(cands) { for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch {} } return null; }

function normalizeAutopay(data){
  const method = (data.autopay_method||'').toLowerCase();
  if (method === 'card') {
    const yy = (data.card_exp_year||'').toString().slice(-2);
    const mm = (data.card_exp_month||'').toString().padStart(2,'0');
    if (yy && mm) data.autopay_exp = `${yy}/${mm}`;
    ['bank_name','bank_account'].forEach(k=>data[k]='');
  } else if (method === 'bank') {
    ['card_company','card_number','card_exp_year','card_exp_month','card_name'].forEach(k=>data[k]='');
    data.autopay_exp = data.autopay_exp || '';
  } else {
    const exp = (data.autopay_exp||'').trim();
    const looksCard = !!exp;
    if (looksCard) ['bank_name','bank_account'].forEach(k=>data[k]='');
    else ['card_company','card_number','card_exp_year','card_exp_month','card_name'].forEach(k=>data[k]='');
  }
  if (!data.autopay_org)    data.autopay_org    = (method==='card') ? (data.card_company||'') : (data.bank_name||data.card_company||'');
  if (!data.autopay_number) data.autopay_number = (method==='card') ? (data.card_number ||'') : (data.bank_account||data.card_number||'');
  if (!data.autopay_holder) data.autopay_holder = (data.card_name || data.holder || data.autopay_holder || '');
  return data;
}

/** KT 레거시 → 신규 매핑 스키마 정규화 */
function normalizeMapping(raw) {
  if (!raw) return { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };
  if (raw.text || raw.checkbox || raw.lines) {
    if (!raw.meta) raw.meta = { pdf: 'template.pdf' };
    if (!raw.meta.pdf) raw.meta.pdf = 'template.pdf';
    return raw;
  }
  const out = { meta:{ pdf:(raw?.meta?.pdf)||'template.pdf' }, text:{}, checkbox:{}, lines:[] };
  if (raw.fields) for (const [k,v] of Object.entries(raw.fields)) {
    const key = (v.source && v.source[0]) || k;
    (out.text[key] = out.text[key] || []).push({ p:+v.page||1, x:+v.x, y:+v.y, size:+v.size||10, font:'malgun' });
  }
  if (raw.vmap) for (const [compound, s] of Object.entries(raw.vmap)) {
    const comp = compound.includes('.') ? compound : compound.replace(':','.');
    (out.checkbox[comp] = out.checkbox[comp] || []).push({ p:+s.page||1, x:+s.x, y:+s.y, size:+s.size||12 });
  }
  if (Array.isArray(raw.lines)) out.lines = raw.lines.map(l => ({
    p:+(l.p||l.page||1), x1:+(l.x1||0), y1:+(l.y1||0), x2:+(l.x2||0), y2:+(l.y2||0), w:+(l.w||l.width||1)
  }));
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    }};
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    /* --- 요청 본문을 형식에 상관없이 파싱(JSON, form-urlencoded, text) --- */
    const headers = event.headers || {};
    const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    let payload = {};
    if (event.body) {
      try {
        payload = JSON.parse(event.body);
      } catch {
        if (ct.includes('application/x-www-form-urlencoded')) {
          payload = qs.parse(event.body);
          // form-data 안에 data=... 형태 지원
          if (payload.data && typeof payload.data === 'string') {
            try { payload = JSON.parse(payload.data); } catch {}
          }
        } else {
          // text/plain 등: data=... 또는 그냥 JSON 흉내
          const maybe = event.body.trim().replace(/^data=/,'');
          try { payload = JSON.parse(maybe); } catch { payload = {}; }
        }
      }
    }
    const dataIn = payload.data || payload || {};
    const data = { ...dataIn };
    if (!data.apply_date) data.apply_date = formatApplyDate(new Date());
    if ((data.prev_carrier||'').toUpperCase() !== 'MVNO') data.mvno_name = '';
    normalizeAutopay(data);

    /* --- 경로 해석 --- */
    const __dirnameFn = __dirname;                  // <repo>/netlify/functions
    const repoRoot    = path.resolve(__dirnameFn, '../../'); // <repo>/
    const mappingPath = path.join(__dirnameFn, 'mappings', 'TOP.json');

    // 매핑
    let mapping = { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };
    if (fs.existsSync(mappingPath)) {
      try { mapping = normalizeMapping(JSON.parse(fs.readFileSync(mappingPath,'utf-8'))); }
      catch (e) { console.warn('Mapping parse error:', e.message); }
    }

    // 템플릿 PDF
    const pdfRel  = (mapping.meta && mapping.meta.pdf) || 'template.pdf';
    const pdfPath = firstExistingPath([
      path.join(repoRoot, pdfRel),
      path.join(__dirnameFn, pdfRel),
      path.join(repoRoot, 'template.pdf'),
      path.join(__dirnameFn, '../../template.pdf'),
      path.join(process.cwd(), pdfRel)
    ]);
    if (!pdfPath) {
      return { statusCode: 400, headers:{'Access-Control-Allow-Origin':'*'}, body: `Base PDF not found: ${pdfRel}` };
    }
    const baseBytes = fs.readFileSync(pdfPath);

    // 폰트
    const malgunPath = firstExistingPath([
      path.join(repoRoot, 'malgun.ttf'),
      path.join(__dirnameFn, 'malgun.ttf'),
      path.join(process.cwd(), 'malgun.ttf')
    ]);

    /* --- PDF 생성 --- */
    const pdfDoc = await PDFDocument.load(baseBytes);
    pdfDoc.registerFontkit(fontkit);
    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
    let malgun = helv;
    if (malgunPath) {
      try { malgun = await pdfDoc.embedFont(fs.readFileSync(malgunPath)); }
      catch (e) { console.warn('malgun.ttf load failed:', e.message); }
    }

    // 매핑이 비어있어도 템플릿 그대로 출력되도록
    if (mapping.text) {
      for (const [key, spots] of Object.entries(mapping.text)) {
        const val = data[key];
        (spots||[]).forEach(s => {
          const page = pdfDoc.getPage((s.p||1)-1);
          const font = s.font && s.font.toLowerCase().includes('malgun') ? malgun : helv;
          drawText(page, font, val, s.x, s.y, s.size||10);
        });
      }
    }
    if (mapping.checkbox) {
      for (const [compound, spots] of Object.entries(mapping.checkbox)) {
        const [field, expect] = compound.includes('.') ? compound.split('.') : compound.split(':');
        const v = data[field];
        const match = typeof v === 'boolean' ? (v && expect==='true') :
                      typeof v === 'string'  ? (v.toLowerCase() === (expect||'').toLowerCase()) :
                      (v === expect);
        if (match) (spots||[]).forEach(s => drawCheck(pdfDoc.getPage((s.p||1)-1), s.x, s.y, s.size||12));
      }
    }
    if (mapping.lines) {
      (mapping.lines||[]).forEach(s => {
        const page = pdfDoc.getPage((s.p||1)-1);
        drawLine(page, s.x1, s.y1, s.x2, s.y2, s.w||1);
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
  } catch (e) {
    console.error('generate_top error:', e);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: 'Error: ' + (e?.message || e)
    };
  }
};
