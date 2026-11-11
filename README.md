# 엄마 항암 수첩

가족이 Claude 없이 여는 항암 기록 수첩. Cloudflare Pages + Pages Functions + D1.

- `public/` — 화면 (빌드 출력 디렉터리)
- `functions/api/[[path]].js` — 저장·로그인·캡처 인식 API

## Cloudflare 설정 (처음 한 번)
1. Pages 프로젝트: 이 저장소 연결, 빌드 명령 없음, 빌드 출력 디렉터리 `public`
2. D1 데이터베이스 만들기 → Pages 설정 → 바인딩 → D1, 변수 이름 `DB`
3. Pages 설정 → 변수 및 비밀: `FAMILY_PASSWORD`(가족 비밀번호), `ANTHROPIC_API_KEY`(캡처 자동 인식) — 둘 다 "암호화(비밀)"로
4. 다시 배포
