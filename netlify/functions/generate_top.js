'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const qs = require('querystring');

/* ===== 좌표 스케일/원점 ===== */
let PREVIEW_W = 1299;   // 스튜디오 proof W(px)
let PREVIEW_H = 1841;   // 스튜디오 proof H(px)
let UNITS = 'px';       // 'px' | 'pt'  (스튜디오에서 찍은 값이면 'px')
let Y_ORIGIN = 'top';   // 'top' | 'bottom'
let NUDGE_X = 0;        // 전체 보정(pt)
let NUDGE_Y = 0;
let SCALE_X = 1.0;      // 전체 스케일 보정
let SCALE_Y = 1.0;

function applyMeta(meta = {}) {
  // 스튜디오 미리보기 크기
  if (Number(meta.previewW) > 0) PREVIEW_W = Number(meta.previewW);
  if (Number(meta.previewH) > 0) PREVIEW_H = Number(meta.previewH);
  // 좌표 단위/원점
  if (meta.units) UNITS = String(meta.units).toLowerCase();       // 'px' | 'pt'
  if (meta.yOrigin) Y_ORIGIN = String(meta.yOrigin).toLowerCase(); // 'top' | 'bottom'
  // 보정치
  if (meta.nudgeX != null) NUDGE_X = Number(meta.nudgeX) || 0;
  if (meta.nudgeY != null) NUDGE_Y = Number(meta.nudgeY) || 0;
  if (meta.scaleX != null) SCALE_X = Number(meta.scaleX) || 1;
  if (meta.scaleY != null) SCALE_Y = Number(meta.scaleY) || 1;
}

/* ===== 좌표 변환 ===== */
function toPtX(page, x) {
  const w = page.getWidth();
  if (UNITS === 'pt') return x * SCALE_X + NUDGE_X;
  // px → pt
  const sx = (w / PREVIEW_W) * SCALE_X;
  return x * sx + NUDGE_X;
}
function toPtY(page, y) {
  const h = page.getHeight();
  if (UNITS === 'pt') {
    const base = (Y_ORIGIN === 'top') ? (h - y) : y;
    return base * SCALE_Y + NUDGE_Y;
  }
  // px → pt
  const sy = (h / PREVIEW_H) * SCALE_Y;
  const yScaled = y * sy;
  const fromTop = (Y_ORIGIN === 'top');
  return (fromTop ? (h - yScaled) : yScaled) + NUDGE_Y;
}

// ✅ 글자/체크 모두 '베이스라인' 기준으로 렌더 (줄 붙는 현상 방지)
function drawText(p, f, t, x, y, size = 10) {
  p.drawText(String(t ?? ''), { x: toPtX(p, x), y: toPtY(p, y), size, font: f, color: rgb(0,0,0) });
}
function drawCheck(p, x, y, size = 12, char = 'V', font) {
  p.drawText(String(char || 'V'), { x: toPtX(p, x), y: toPtY(p, y), size, font, color: rgb(0,0,0) });
}
function drawLine(p, x1, y1, x2, y2, w = 1) {
  p.drawLine({ start:{ x:toPtX(p,x1), y:toPtY(p,y1) }, end:{ x:toPtX(p,x2), y:toPtY(p,y2) }, thickness:w, color: rgb(0,0,0) });
}

/* ===== WRAP (2줄 자동개행, 말줄임표 없음) ===== */
const WRAP_CONFIG = {
  subscriber_name: { maxWidth: 320, lineHeight: 22, maxLines: 2 },
  autopay_holder:  { maxWidth: 320, lineHeight: 22, maxLines: 2 }
};

function widthToPt(page, w) {
  const wpt = page.getWidth();
  if (UNITS === 'pt') return (w * SCALE_X);
  const sx = (wpt / PREVIEW_W) * SCALE_X;
  return w * sx;
}
function heightToPt(page, h) {
  const hpt = page.getHeight();
  if (UNITS === 'pt') return (h * SCALE_Y);
  const sy = (hpt / PREVIEW_H) * SCALE_Y;
  return h * sy;
}

function splitToLinesNoEllipsis(text, font, size, maxWidthPt) {
  const width = t => font.widthOfTextAtSize(t, size);
  const tokens = String(text ?? '').split(/(\s+)/); // keep spaces
  const lines = [];
  let line = '';
  for (const tk of tokens) {
    if (width(line + tk) <= maxWidthPt) {
      line += tk;
    } else {
      if (tk.trim() === '') {
        lines.push(line);
        line = '';
        continue;
      }
      if (width(tk) > maxWidthPt) {
        for (const ch of [...tk]) {
          if (width(line + ch) <= maxWidthPt) {
            line += ch;
          } else {
            lines.push(line);
            line = ch;
          }
        }
      } else {
        lines.push(line);
        line = tk;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function layoutWrappedNoEllipsis(text, font, baseSize, maxWidthPt, maxLines) {
  // 폰트 크기 축소 없이 2줄 래핑만 수행 (지시사항에 따라 단순 처리)
  const lines = splitToLinesNoEllipsis(text, font, baseSize, maxWidthPt);
  if (lines.length > maxLines) return lines.slice(0, maxLines);
  return lines;
}

function drawWrapped2Lines(page, font, text, x, y, size, key) {
  const cfg = WRAP_CONFIG[key];
  if (!cfg) {
    // fallback: single line
    drawText(page, font, text, x, y, size);
    return;
  }
  const ptX = toPtX(page, x);
  const ptY0 = toPtY(page, y);
  const maxWidthPt = widthToPt(page, cfg.maxWidth);
  const lineHeightPt = heightToPt(page, cfg.lineHeight);
  const lines = layoutWrappedNoEllipsis(text, font, size, maxWidthPt, cfg.maxLines || 2);
  for (let i = 0; i < lines.length; i++) {
    const yy = ptY0 - i * lineHeightPt;
    page.drawText(String(lines[i] ?? ''), { x: ptX, y: yy, size, font, color: rgb(0,0,0) });
  }
}



function formatApplyDate(d) {
  const y = d.getFullYear(), m = d.getMonth()+1, dd = String(d.getDate()).padStart(2,'0');
  return `신청일자 ${y}년 ${m}월 ${dd}일`;
}
function firstExisting(list) { for (const p of list) try { if (p && fs.existsSync(p)) return p; } catch {} return null; }

function normalizeAutopay(d) {
  const m = (d.autopay_method || '').toLowerCase();
  if (m === 'card') {
    const yy = (d.card_exp_year || '').toString().slice(-2);
    const mm = (d.card_exp_month || '').toString().padStart(2,'0');
    if (yy && mm) d.autopay_exp = `${yy}/${mm}`;
    ['bank_name','bank_account'].forEach(k=>d[k]='');
  } else if (m === 'bank') {
    ['card_company','card_number','card_exp_year','card_exp_month','card_name'].forEach(k=>d[k]='');
    d.autopay_exp = d.autopay_exp || '';
  }
  if (!d.autopay_org)    d.autopay_org    = (m==='card') ? (d.card_company||'') : (d.bank_name || d.card_company || '');
  if (!d.autopay_number) d.autopay_number = (m==='card') ? (d.card_number||'') : (d.bank_account || d.card_number || '');
  if (!d.autopay_holder) d.autopay_holder = (d.card_name || d.holder || d.autopay_holder || '');
  return d;
}

/* 매핑 포맷 통일: fields/vmap → text/checkbox */
function normalizeMapping(raw) {
  if (!raw) return { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };
  const out = { meta:{ pdf: (raw.meta?.pdf) || 'template.pdf',
                       units: raw.meta?.units,
                       yOrigin: raw.meta?.yOrigin,
                       previewW: raw.meta?.previewW,
                       previewH: raw.meta?.previewH,
                       nudgeX: raw.meta?.nudgeX, nudgeY: raw.meta?.nudgeY,
                       scaleX: raw.meta?.scaleX, scaleY: raw.meta?.scaleY
                     },
                text:{}, checkbox:{}, lines:[] };

  if (raw.text || raw.checkbox || raw.lines) {
    return { ...out, ...raw, meta:{ ...out.meta, ...(raw.meta||{}) } };
  }

  if (raw.fields) {
    for (const [k,v] of Object.entries(raw.fields)) {
      const key = (v.source && v.source[0]) || k;
      (out.text[key] = out.text[key] || []).push({
        p:+v.page||1, x:+v.x, y:+v.y, size:+v.size||10, font:(v.font || 'malgun')
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
      p:+(l.p||l.page||1), x1:+(l.x1||0), y1:+(l.y1||0), x2:+(l.x2||0), y2:+(l.y2||0), w:+(l.w||1)
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

const hasNonAscii = v => /[^\x00-\x7F]/.test(String(v||''));

/* ===== Netlify Function ===== */
exports.handler = async (event) => {
  // CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode:200, headers:{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'Content-Type',
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS'
    }, body:'' };
  }

  // 빈 GET → 템플릿 바로 보여주기
  const qsParams = event.queryStringParameters || {};
  if (event.httpMethod === 'GET' && Object.keys(qsParams).length === 0) {
    return { statusCode:302, headers:{
      'Location':'/template.pdf',
      'Access-Control-Allow-Origin':'*',
      'Cache-Control':'no-store'
    }, body:'' };
  }

  // 데이터
  const payload = parseIncoming(event);
  const data = { ...(payload.data || payload || {}) };
  if (!data.apply_date) data.apply_date = formatApplyDate(new Date());
  if ((data.prev_carrier || '').toUpperCase() !== 'MVNO') data.mvno_name = '';
  normalizeAutopay(data);

  // FreeT 방식 호환: print 필드가 있으면 우선 사용(25자 줄바꿈 등)
  if (data.subscriber_name_print) data.subscriber_name = data.subscriber_name_print;
  if (data.autopay_holder_print) data.autopay_holder = data.autopay_holder_print;

  // 예금주명 비어있으면 가입자명으로 자동 채움(입력폼 누락 대비)
  if (!data.autopay_holder && data.subscriber_name) data.autopay_holder = data.subscriber_name;


  // 경로
  const __fn = __dirname;                        // <repo>/netlify/functions
  const repoRoot = path.resolve(__fn, '../../'); // <repo>/
  const mappingPath = path.join(__fn, 'mappings', 'TOP.json');

  // 매핑
  let mapping = { meta:{pdf:'template.pdf'}, text:{}, checkbox:{}, lines:[] };
  try {
    const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf-8')); // JSON 주석 금지
    mapping = normalizeMapping(raw);
  } catch (e) {
    return { statusCode:400, headers:{'Access-Control-Allow-Origin':'*'}, body:`Invalid TOP.json: ${e.message}` };
  }
  applyMeta(mapping.meta || {});

  // 템플릿 & 폰트
  const pdfRel = (mapping.meta && mapping.meta.pdf) || 'template.pdf';
  const pdfPath = firstExisting([
    path.join(repoRoot, pdfRel),
    path.join(__fn, pdfRel),
    path.join(repoRoot, 'template.pdf'),
    path.join(process.cwd(), pdfRel)
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
  if (event.httpMethod === 'GET' && (qsParams.debug === '1')) {
    const st = fs.statSync(pdfPath);
    return {
      statusCode:200,
      headers:{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' },
      body: JSON.stringify({
        pdfPath, pdfSize:st.size, mappingPath,
        mappingMeta: mapping.meta, malgunPath,
        previewWH:{ PREVIEW_W, PREVIEW_H },
        units: UNITS, yOrigin: Y_ORIGIN,
        nudge:{ nudgeX:NUDGE_X, nudgeY:NUDGE_Y },
        scale:{ scaleX:SCALE_X, scaleY:SCALE_Y }
      })
    };
  }

  // PDF 생성
  const pdfDoc = await PDFDocument.load(baseBytes);
  pdfDoc.registerFontkit(fontkit);
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // 말굿 필요한지 판단해서 서브셋 임베드
  let useMalgun = false;
  for (const [k, spots] of Object.entries(mapping.text || {})) {
    if (!spots || !spots.length) continue;
    if (hasNonAscii(data[k])) { useMalgun = true; break; }
    if (spots.some(s => (s.font||'').toLowerCase().includes('malgun'))) { useMalgun = true; break; }
  }
  if (!useMalgun && mapping.text?.apply_date && hasNonAscii(data.apply_date)) useMalgun = true;

  let malgun = helv;
  if (useMalgun && malgunPath) {
    try { malgun = await pdfDoc.embedFont(fs.readFileSync(malgunPath), { subset:true }); }
    catch(e) { /* 실패해도 helv 사용 */ }
  }

  // 렌더링
  for (const [key, spots] of Object.entries(mapping.text || {})) {
    const v = data[key];
    (spots||[]).forEach(s => {
      const page = pdfDoc.getPage((s.p||1)-1);
      const wantsMalgun = (s.font||'').toLowerCase().includes('malgun');
      const font = (wantsMalgun && malgun) ? malgun : helv;
      if (key === 'subscriber_name' || key === 'autopay_holder') {
        drawWrapped2Lines(page, font, v, s.x, s.y, s.size||10, key);
      } else {
        drawText(page, font, v, s.x, s.y, s.size||10);
      }
    });
  }

  for (const [comp, spots] of Object.entries(mapping.checkbox || {})) {
    const [field, expect=''] = comp.includes('.') ? comp.split('.') : comp.split(':');
    const v = data[field];
    const match = (typeof v === 'boolean') ? (v && expect === 'true')
                : (typeof v === 'string')  ? (v.toLowerCase() === String(expect).toLowerCase())
                : (v === expect);
    if (match) (spots||[]).forEach(s => {
      const page = pdfDoc.getPage((s.p||1)-1);
      const font = (s.font && s.font.toLowerCase().includes('malgun')) ? malgun : helv;
      drawCheck(page, s.x, s.y, s.size||12, s.char || 'V', font);
    });
  }

  (mapping.lines || []).forEach(s => {
    const page = pdfDoc.getPage((s.p||1)-1);
    drawLine(page, s.x1, s.y1, s.x2, s.y2, s.w||1);
  });

  const out = await pdfDoc.save();
  return {
    statusCode:200,
    headers:{
      'Content-Type':'application/pdf',
      'Content-Disposition':'inline; filename="THE_ONE.pdf"',
      'Access-Control-Allow-Origin':'*',
      'Cache-Control':'no-store'
    },
    isBase64Encoded:true,
    body: Buffer.from(out).toString('base64')
  };
};
