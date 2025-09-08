'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const qs = require('querystring');

/* ---------- helpers ---------- */
function drawText(p, f, t, x, y, s = 10) {
  if (t == null) t = '';
  p.drawText(String(t), { x, y, size: s, font: f, color: rgb(0, 0, 0) });
}
// 기존
// function drawCheck(page, x, y, size = 12) { page.drawText("✓", { x, y, size, color: rgb(0,0,0) }); }

// 변경: 기본 문자를 'V'로, 필요하면 spot에 char/font도 줄 수 있게
function drawCheck(page, x, y, size = 12, char = "V", font) {
  page.drawText(String(char || "V"), { x, y, size, font, color: rgb(0, 0, 0) });
}

function drawLine(p, x1, y1, x2, y2, w = 1) {
  p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: w, color: rgb(0, 0, 0) });
}
function formatApplyDate(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, dd = String(d.getDate()).padStart(2, '0');
  return `신청일자 ${y}년 ${m}월 ${dd}일`;
}
function firstExisting(cands) { for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch {} } return null; }

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

const hasNonAscii = (v) => /[^\x00-\x7F]/.test(String(v || ''));

/* ---------- handler ---------- */
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

  // 빈 GET(쿼리 없음)은 템플릿으로 리다이렉트(큰 PDF 생성 회피)
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

  // GET/POST 데이터 파싱
  const payload = parseIncoming(event);
  const data = { ...(payload.data || payload || {}) };
  if (!data.apply_date) data.apply_date = formatApplyDate(new Date());
  if ((data.prev_carrier || '').toUpperCase() !== 'MVNO') data.mvno_name = '';
  normalizeAutopay(data);

  // 경로 설정
  const __fn = __dirname;                         // <repo>/netlify/functions
  const repoRoot = path.resolve(__fn, '../../');  // <repo>/
  const mappingPath = path.join(__fn, 'mappings', 'TOP.json');

  // 매핑 로딩(없어도 템플릿만 출력)
  let mapping = { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };
  try {
    if (fs.existsSync(mappingPath)) {
      const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      mapping = normalizeMapping(raw);
    }
  } catch (e) { console.warn('Mapping parse error:', e.message); }

  // 템플릿/폰트 찾기
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

  // 디버그(JSON으로 경로/크기 보기)
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
        malgunPath
      })
    };
  }

  // PDF 생성
  const pdfDoc = await PDFDocument.load(baseBytes);
  pdfDoc.registerFontkit(fontkit);

  // 기본 폰트(영문/숫자 등)
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // 이번 렌더링에서 "정말로" 말굿이 필요한지 판단
  let useMalgun = false;
  if (mapping.text) {
    for (const [key, spots] of Object.entries(mapping.text)) {
      if (!spots || !spots.length) continue;
      const val = data[key];
      if (hasNonAscii(val)) { useMalgun = true; break; }
      // 폰트가 명시적으로 'malgun'인 경우에도 필요 플래그만 세팅(실제 값에 한글 없으면 서브셋이 매우 작음)
      if (spots.some(s => (s.font || '').toLowerCase().includes('malgun'))) { useMalgun = true; break; }
    }
  }
  // 날짜를 실제로 찍는 매핑이 있고 한글 날짜 문자열이면 필요
  if (!useMalgun && mapping.text && mapping.text.apply_date && hasNonAscii(data.apply_date)) {
    useMalgun = true;
  }

  // 말굿은 필요한 경우에만 "서브셋" 임베드
  let malgun = helv;
  if (useMalgun && malgunPath) {
    try {
      malgun = await pdfDoc.embedFont(fs.readFileSync(malgunPath), { subset: true });
    } catch (e) {
      console.warn('malgun.ttf load failed:', e.message);
      useMalgun = false; // 실패 시 헬베티카로 대체
    }
  }

  // 텍스트/체크박스/라인 렌더
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
    const match = (typeof v === "boolean") ? (v && expect === "true")
                : (typeof v === "string")  ? (v.toLowerCase() === (expect||"").toLowerCase())
                : (v === expect);

    if (match) (spots || []).forEach(s => {
      const page = pdfDoc.getPage((s.p || 1) - 1);
      const font = (s.font && s.font.toLowerCase().includes("malgun")) ? malgun : helv;
      // 기본은 'V', 필요하면 TOP.json에서 spot에 { "char": "✓" }처럼 덮어쓸 수 있음
      drawCheck(page, s.x, s.y, s.size || 12, s.char || "V", font);
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
