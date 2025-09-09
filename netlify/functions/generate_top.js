'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const qs = require('querystring');

/* ---------------- 공용 유틸 ---------------- */
const firstExisting = (cands) => {
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
};
const hasNonAscii = (v) => /[^\x00-\x7F]/.test(String(v || ''));

const formatApplyDate = (d) => {
  const y = d.getFullYear(), m = d.getMonth() + 1, dd = String(d.getDate()).padStart(2,'0');
  return `신청일자 ${y}년 ${m}월 ${dd}일`;
};

function parseIncoming(event) {
  const h = event.headers || {};
  const ct = (h['content-type'] || h['Content-Type'] || '').toLowerCase();

  if (event.httpMethod === 'POST') {
    if (!event.body) return {};
    // JSON
    try { return JSON.parse(event.body); } catch {}
    // x-www-form-urlencoded
    if (ct.includes('application/x-www-form-urlencoded')) {
      const p = qs.parse(event.body);
      if (p.data && typeof p.data === 'string') { try { return JSON.parse(p.data); } catch {} }
      return p;
    }
    // 기타
    const maybe = (event.body || '').trim().replace(/^data=/,'');
    try { return JSON.parse(maybe); } catch { return {}; }
  }

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q.data && typeof q.data === 'string') { try { return JSON.parse(q.data); } catch {} }
    return q;
  }

  return {};
}

/* ---------------- 매핑 변환 ---------------- */
// 매핑 스튜디오 JSON → 서버에서 쓰기 좋은 구조로 정규화
function normalizeMapping(raw) {
  if (!raw) return { meta:{ pdf:'template.pdf' }, text:{}, checkbox:{}, lines:[] };

  // 이미 서버 포맷(text/checkbox/lines)인 경우
  if (raw.text || raw.checkbox || raw.lines) {
    if (!raw.meta) raw.meta = { pdf:'template.pdf' };
    if (!raw.meta.pdf) raw.meta.pdf = 'template.pdf';
    return raw;
  }

  // 스튜디오 포맷(fields / vmap)
  const out = {
    meta: { pdf:(raw?.meta?.pdf)||'template.pdf',
            units: raw?.meta?.units,
            yOrigin: raw?.meta?.yOrigin,
            previewW: raw?.meta?.previewW,
            previewH: raw?.meta?.previewH,
            nudgeX: raw?.meta?.nudgeX||0,
            nudgeY: raw?.meta?.nudgeY||0 },
    text:{}, checkbox:{}, lines:[]
  };

  if (raw.fields) {
    for (const [k,v] of Object.entries(raw.fields)) {
      const key = (v.source && v.source[0]) || k; // form name
      (out.text[key] = out.text[key] || []).push({
        p: +(v.page||1), x:+v.x, y:+v.y, size:+(v.size||10), font: 'malgun'
      });
    }
  }
  if (raw.vmap) {
    for (const [compound, spot] of Object.entries(raw.vmap)) {
      const comp = compound.includes('.') ? compound : compound.replace(':','.');
      (out.checkbox[comp] = out.checkbox[comp] || []).push({
        p:+(spot.page||1), x:+spot.x, y:+spot.y, size:+(spot.size||12)
      });
    }
  }
  if (Array.isArray(raw.lines)) {
    out.lines = raw.lines.map(l => ({
      p:+(l.p||l.page||1), x1:+(l.x1||0), y1:+(l.y1||0), x2:+(l.x2||0), y2:+(l.y2||0), w:+(l.w||1)
    }));
  }
  return out;
}

/* ---------------- 좌표 변환 ---------------- */
// meta.units: 'pt' | 'px'  (기본: 'px')
// meta.yOrigin: 'top' | 'bottom' (기본: 'top')
// px일 때 meta.previewW/H가 필요(스튜디오 proof W,H). 없으면 페이지 크기로 추정.
function makeTransformers(meta, getPageWH) {
  const units = (meta?.units || 'px').toLowerCase();
  const yOrigin = (meta?.yOrigin || 'top').toLowerCase();
  const nudgeX = +meta?.nudgeX || 0;
  const nudgeY = +meta?.nudgeY || 0;

  return {
    x: (page, xPxOrPt) => {
      const { w:pageW } = getPageWH(page);
      if (units === 'pt') return xPxOrPt + nudgeX;
      // px → pt
      const previewW = +meta?.previewW > 0 ? +meta.previewW : pageW;
      const sx = pageW / previewW;
      return xPxOrPt * sx + nudgeX;
    },
    yText: (page, yPxOrPt, font, size) => {
      const { w:pageW, h:pageH } = getPageWH(page);
      const ascent = font ? font.ascentAtSize(size) : 0;

      if (units === 'pt') {
        const yTopPt = (yOrigin === 'top') ? (pageH - yPxOrPt) : yPxOrPt;
        return yTopPt - ascent + nudgeY;
      }

      // px → pt
      const previewW = +meta?.previewW > 0 ? +meta.previewW : pageW;
      const previewH = +meta?.previewH > 0 ? +meta.previewH : pageH;
      const sy = pageH / previewH;
      const yTopPt = (yOrigin === 'top')
        ? (pageH - (yPxOrPt * sy))
        : (yPxOrPt * sy);
      return yTopPt - ascent + nudgeY;
    },
    yLine: (page, yPxOrPt) => {
      const { w:pageW, h:pageH } = getPageWH(page);
      if (units === 'pt') {
        const yTopPt = (yOrigin === 'top') ? (pageH - yPxOrPt) : yPxOrPt;
        return yTopPt + nudgeY;
      }
      const previewW = +meta?.previewW > 0 ? +meta.previewW : pageW;
      const previewH = +meta?.previewH > 0 ? +meta.previewH : pageH;
      const sy = pageH / previewH;
      const yTopPt = (yOrigin === 'top')
        ? (pageH - (yPxOrPt * sy))
        : (yPxOrPt * sy);
      return yTopPt + nudgeY;
    }
  };
}

function drawText(p, f, t, x, y, s, tx, ty) {
  p.drawText(String(t ?? ''), { x: tx(p, x), y: ty(p, y, f, s), size: s, font: f, color: rgb(0,0,0) });
}
function drawCheck(p, x, y, size, char, font, tx, ty) {
  p.drawText(String(char || 'V'), { x: tx(p, x), y: ty(p, y, font, size), size, font, color: rgb(0,0,0) });
}
function drawLine(p, x1, y1, x2, y2, w, tx, tyLine) {
  p.drawLine({
    start: { x: tx(p, x1), y: tyLine(p, y1) },
    end:   { x: tx(p, x2), y: tyLine(p, y2) },
    thickness: w, color: rgb(0,0,0)
  });
}

/* ---------------- 자동이체 필드 보정 ---------------- */
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
    const looksCard = !!(d.autopay_exp || '').trim();
    if (looksCard) ['bank_name','bank_account'].forEach(k => d[k] = '');
    else ['card_company','card_number','card_exp_year','card_exp_month','card_name'].forEach(k => d[k] = '');
  }
  if (!d.autopay_org)    d.autopay_org    = (m === 'card') ? (d.card_company || '') : (d.bank_name || d.card_company || '');
  if (!d.autopay_number) d.autopay_number = (m === 'card') ? (d.card_number || '') : (d.bank_account || d.card_number || '');
  if (!d.autopay_holder) d.autopay_holder = (d.card_name || d.holder || d.autopay_holder || '');
  return d;
}

/* ---------------- Netlify handler ---------------- */
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

  // 빈 GET(쿼리 없음)은 템플릿으로 리다이렉트(직접 열기용)
  const qsParams = event.queryStringParameters || {};
  if (event.httpMethod === 'GET' && Object.keys(qsParams).length === 0) {
    return {
      statusCode: 302,
      headers: { Location: '/template.pdf', 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-store' },
      body: ''
    };
  }

  try {
    // 입력 수집
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
      }
    } catch (e) {
      // 매핑 실패 시라도 기본 템플릿만 출력 가능하도록
      console.warn('Mapping parse error:', e.message);
    }

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

    // 디버그
    if (event.httpMethod === 'GET' && (qsParams.debug === '1')) {
      const st = fs.statSync(pdfPath);
      return {
        statusCode: 200,
        headers: { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' },
        body: JSON.stringify({
          pdfPath, pdfSize: st?.size ?? null,
          mappingPath,
          mappingMeta: mapping.meta,
          malgunPath,
          units: mapping.meta?.units || 'px',
          yOrigin: mapping.meta?.yOrigin || 'top',
          nudge: { nudgeX: mapping.meta?.nudgeX||0, nudgeY: mapping.meta?.nudgeY||0 }
        })
      };
    }

    // PDF 작성 시작
    const pdfDoc = await PDFDocument.load(baseBytes);
    pdfDoc.registerFontkit(fontkit);

    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

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

    // 좌표 변환기
    const getPageWH = (page) => ({ w: page.getWidth(), h: page.getHeight() });
    const T = makeTransformers(mapping.meta || {}, getPageWH);

    // 텍스트
    if (mapping.text) {
      for (const [key, spots] of Object.entries(mapping.text)) {
        const val = data[key];
        (spots || []).forEach(s => {
          const page = pdfDoc.getPage((s.p || 1) - 1);
          const wantsMalgun = (s.font || '').toLowerCase().includes('malgun');
          const font = (wantsMalgun && useMalgun) ? malgun : helv;
          drawText(page, font, val, +s.x, +s.y, +s.size || 10, T.x, T.yText);
        });
      }
    }
    // 체크박스
    if (mapping.checkbox) {
      for (const [compound, spots] of Object.entries(mapping.checkbox)) {
        const parts = compound.includes('.') ? compound.split('.') : compound.split(':');
        const field = parts[0], expect = (parts[1] || '').toString();
        const v = data[field];
        const match =
          (typeof v === 'boolean') ? (v && (expect === 'true')) :
          (typeof v === 'string')  ? (v.toLowerCase() === expect.toLowerCase()) :
          (v === expect);

        if (match) (spots || []).forEach(s => {
          const page = pdfDoc.getPage((s.p || 1) - 1);
          const font = (s.font && s.font.toLowerCase().includes('malgun')) ? malgun : helv;
          drawCheck(page, +s.x, +s.y, +s.size || 12, s.char || 'V', font, T.x, T.yText);
        });
      }
    }
    // 라인
    if (mapping.lines) {
      (mapping.lines || []).forEach(s => {
        const page = pdfDoc.getPage((s.p || 1) - 1);
        drawLine(page, +s.x1, +s.y1, +s.x2, +s.y2, +s.w || 1, T.x, T.yLine);
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
    // 실패 내용을 그대로 보여줘서 프론트에서 확인 가능하게
    return {
      statusCode: 500,
      headers: { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' },
      body: JSON.stringify({ error: 'pdf-generate-failed', message: e.message, stack: String(e.stack||'') })
    };
  }
};
