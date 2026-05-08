# Make Real PNG

AI 이미지 배경 제거 웹서비스 MVP입니다. 사용자가 JPG/PNG/WebP 이미지를 업로드하면 파일 검증, 처리 옵션 선택, 단계별 mock AI 처리, 결과 비교, 다운로드, QR 모바일 저장까지 전체 사용자 흐름을 확인할 수 있습니다.

## 주요 기능

- 랜딩 페이지와 드래그 앤 드롭 업로드 영역
- JPG, PNG, WebP 형식 및 10MB 이하 용량 검증
- 단일 이미지 중심 처리, 다중 이미지 업로드/ZIP 확장을 고려한 UI
- 배경 제거 옵션 상태 관리
  - 기본 배경 제거
  - 인물 우선 모드
  - 제품/사물 우선 모드
  - 가장자리 부드럽게
  - 여백 자동 정리
  - 원본 크기 유지
- `removeBackground(file, options)`로 분리된 mock 배경 제거 로직
- 업로드 중 → AI 분석 중 → 배경 제거 중 → 결과 생성 중 단계별 로딩 화면
- 원본/결과 비교 슬라이더와 투명/흰색/검은색 배경 미리보기
- 간단 편집 mock UI
- PNG, WebP, JPG, ZIP 다운로드
- QR코드 생성 및 `/mobile-download/:id` 모바일 다운로드 페이지
- 파일 오류, AI 처리 실패, 네트워크 오류 메시지 UI 구조
- 완료 상태 패널

## 기술 스택

- React
- TypeScript
- TypeScript 컴파일러
- Tailwind CSS
- 브라우저 History API 기반 SPA 라우팅
- Tailwind CSS Browser CDN
- QR Server API 기반 QR 이미지 생성

## 실행 방법

```bash
npm run dev
```

프로덕션 빌드 확인:

```bash
npm run build
```

## 라우팅

- `/` : 랜딩, 업로드, 파일 검증, 처리 옵션 선택
- `/result` : 결과 확인, 비교, 편집 mock, 다운로드, QR코드 생성
- `/mobile-download/:id` : QR코드로 접근하는 모바일 저장 안내 페이지

## mock 배경 제거 구조

핵심 로직은 `src/app.tsx` 상단에 함수 단위로 분리되어 있습니다. 실제 제품화 시 `src/lib/background.ts` 같은 별도 서비스 모듈로 쉽게 이동할 수 있는 형태입니다.

- `validateFile(file)` : 형식과 용량 검증
- `removeBackground(file, options, onStageChange)` : 3~4초 단계별 mock 처리 후 결과 URL 반환
- `generateDownloadBlob(imageUrl, format)` : canvas 기반 PNG/WebP/JPG blob 생성
- `generateQRCode(downloadUrl)` : 모바일 다운로드 URL을 QR 이미지 URL로 변환
- `resetFlow()` : 플로우 초기화 상태 헬퍼

> TODO: 실제 서비스에서는 `removeBackground` 내부에서 AI 배경 제거 API를 호출하고, QR 링크는 blob/sessionStorage 대신 서버 저장 URL로 교체해야 합니다.

## MVP 제한 사항

- 실제 AI 배경 제거 품질은 구현하지 않고 원본 이미지를 결과 이미지로 재사용합니다.
- 결과 데이터는 브라우저 `sessionStorage`와 blob URL 기반이라 새 브라우저/기기 간 실제 공유는 제한됩니다.
- 실제 QR 모바일 저장을 운영하려면 서버 업로드, 만료 URL, 접근 제어와 자체 QR 생성 인프라가 필요합니다.

## 유저 플로우 Mermaid

자세한 Mermaid 문서는 [`docs/user-flow.md`](docs/user-flow.md)를 참고하세요.
