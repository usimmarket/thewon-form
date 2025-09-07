// netlify/functions/generate_top.js
'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

/* -------------------- helpers -------------------- */
function drawText(page, font, text, x, y, size = 10) {
  if (text == null) text = '';
  page.drawText(String(text), { x, y, size, font, color: rgb(0, 0, 0) });
}
function drawCheck(page, x, y, size = 12) {
  page.drawText('✓', { x, y, size, color: rgb(0, 0, 0) });
}
function drawLine(page, x1, y1, x2, y2, width = 1) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: width, color: rgb(0, 0, 0) });
}
function formatApplyDate(d) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = String(d.getDate()).padStart(2, '0');
  return `신청일자 ${y}년 ${m}월 ${day}일`;
}
function normalizeAutopay(data) {
  const method = (data.autopay_method || '').toLowerCase();
  if (method === 'card') {
    const yy = (data.card_exp_year || '').toString().slice(-2);
    const mm = (data.card_exp_month || '').toString().padStart(2, '0');
    if (yy && mm) data.autopay_exp = `${yy}/${mm}`;
    ['bank_name', 'bank_account'].forEach((k) => (data[k] = ''));
  } else if (method === 'bank') {
    ['card_company', 'card_number', 'card_exp_year', 'card_exp_month', 'card_name'].forEach((k) => (data[k] = ''));
    data.autopay_exp = data.autopay_exp || '';
  } else {
    const exp = (data.autopay_exp || '').trim();
    const looksCard = !!exp;
    if (looksCard) ['bank_name', 'bank_account'].forEach((k) => (data[k] = ''));
    else ['card_company', 'card_number', 'card_exp_year', 'card_exp_month', 'card_name'].forEach((k) => (data[k] = ''));
  }
  if (!data.autopay_org) data.autopay_org = method === 'card' ? data.card_company || '' : data.bank_name || data.card_company || '';
  if (!data.autopay_number) data.autopay_number = method === 'card' ? data.card_number || '' : data.bank_account || data.card_number || '';
  if (!data.autopay_holder) data.autopay_holder = data.card_name || data.holder || data.autopay_holder || '';
  return data;
}

function firstExistingPath(candidates) {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

/* -------------------- handler -------------------- */
exports.handler = async (event) => {
  // CORS & preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const body = event.body ? JSON.parse(event.body) : {};
    const dataIn = body.data || body || {};
    const data = { ...dataIn };

    // repo root = <repo>/   (functions 폴더는 <repo>/netlify/functions)
    const __dirnameFn = __dirname;
    const repoRoot = path.resolve(__dirnameFn, '../../');

    // 1) mapping
    const mappingPath = path.join(__dirnameFn, 'mappings', 'TOP.json');
    if (!fs.existsSync(mappingPath)) {
      console.error('Mapping not found:', mappingPath);
      return { statusCode: 500, body: 'Mapping file not found' };
    }
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));

    // 2) template.pdf (여러 후보 경로 순차 확인)
    const pdfRel = (mapping.meta && mapping.meta.pdf) || 'template.pdf';
    const pdfPath = firstExistingPath([
      path.join(repoRoot, pdfRel),
      path.join(__dirnameFn, pdfRel),
      path.join(repoRoot, 'template.pdf'),
      path.join(__dirnameFn, '../../template.pdf'),
      path.join(process.cwd(), pdfRel),
    ]);
    if (!pdfPath) {
      console.error('Base PDF not found. Tried:', { repoRoot, pdfRel });
      return { statusCode: 400, body: `Base PDF not found: ${pdfRel}` };
    }
    const baseBytes = fs.readFileSync(pdfPath);

    // 3) 폰트
    const malgunPath = firstExistingPath([
      path.join(repoRoot, 'malgun.ttf'),
      path.join(__dirnameFn, 'malgun.ttf'),
      path.join(process.cwd(), 'malgun.ttf'),
    ]);
    if (!malgunPath) console.warn('malgun.ttf not found — will fallback to Helvetica');

    // 데이터 정규화
    if (!data.apply_date) data.apply_date = formatApplyDate(new Date());
    if ((data.prev_carrier || '').toUpperCase() !== 'MVNO') data.mvno_name = '';
    normalizeAutopay(data);

    // PDF 채우기
    const pdfDoc = await PDFDocument.load(baseBytes);
    pdfDoc.registerFontkit(fontkit);

    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    let malgun = helvetica;
    if (malgunPath) {
      try {
        malgun = await pdfDoc.embedFont(fs.readFileSync(malgunPath));
      } catch (e) {
        console.warn('Failed to load malgun.ttf, fallback to Helvetica:', e?.message || e);
      }
    }

    if (mapping.text) {
      for (const [key, spots] of Object.entries(mapping.text)) {
        const val = data[key];
        (spots || []).forEach((s) => {
          const isMalgun = s.font && s.font.toLowerCase().includes('malgun');
          const page = pdfDoc.getPage((s.p || 1) - 1);
          drawText(page, isMalgun ? malgun : helvetica, val, s.x, s.y, s.size || 10);
        });
      }
    }

    if (mapping.checkbox) {
      for (const [compound, spots] of Object.entries(mapping.checkbox)) {
        const [field, expect] = compound.split('.');
        const v = data[field];
        const match =
          typeof v === 'boolean'
            ? v && expect === 'true'
            : typeof v === 'string'
            ? v.toLowerCase() === (expect || '').toLowerCase()
            : v === expect;
        if (match) (spots || []).forEach((s) => drawCheck(pdfDoc.getPage((s.p || 1) - 1), s.x, s.y, s.size || 12));
      }
    }

    if (mapping.lines) {
      (mapping.lines || []).forEach((s) => {
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
        'Cache-Control': 'no-store',
      },
      isBase64Encoded: true,
      body: Buffer.from(out).toString('base64'),
    };
  } catch (e) {
    console.error('generate_top error:', e);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: 'Error: ' + (e?.message || e),
    };
  }
};
