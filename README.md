# THEWON Forms (KT WELCOME)

- GitHub + Netlify (Functions) 기반의 단일 페이지 웹앱
- `apply_date`는 화면 미노출(hidden)이며 출력 시 자동 기입
- 카드 자동이체 시 `YY/MM` 조합(연/월 분리 입력)

## 폴더
```
.
├─ index.html
├─ netlify.toml
├─ carrier_kits/TOP/template.pdf
└─ netlify/functions/
   ├─ generate_top.js
   └─ mappings/TOP.json
```

## 로컬 미리보기
```
npm i -g netlify-cli
netlify dev
```
→ http://localhost:8888

## 좌표 매핑
`netlify/functions/mappings/TOP.json`의 좌표를 실제 PDF 양식에 맞춰 보정하면 됩니다.
