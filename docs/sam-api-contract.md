# SAM 3.1 서버 계약 — 2026-10-27 KST

SRS v1.1 OBJ-01, API-01–03, T03/T22의 제한된 구현 기록이다. 합성 이미지 호출 검증은 웹캠·Depth·추적·Wonder 또는 제품 Gate 통과가 아니다.

## 공급자 계약과 근거

| 항목 | 확인 내용 |
|---|---|
| 공급자 / 요청 모델 | Meta / `sam-3.1` |
| Endpoint / 인증 | `POST https://api.meta.ai/v1/responses`, 서버 환경변수 `META_API_KEY`의 Bearer 인증 |
| 요청 | 단일 user message의 `input_text`와 `input_image.image_url`; 이미지 data URL; non-streaming; `store: false` 요청 (공급자 실호출 미검증) |
| 응답 | Responses output의 `output_text` 특수 토큰을 공식 `@meta-sam/parser`로 파싱·마스크 디코딩 |
| 좌표 | 원본 픽셀; 공식 파서의 half-open bounds를 유지 |
| 마스크 / confidence | `mask_encoding=one_bit`, `include_confidence="true"`; 점수는 보정 확률이 아님 |
| 지원 범위 | 이 어댑터는 PNG/JPEG 이미지; 동영상·Files API·객체 추적은 미구현 |
| 공급자 공시 가격 | 이미지 1,000건당 USD 2.50; 실제 청구액은 확인하지 않음 |
| 공급자 공시 rate | 팀별 3,000 RPM; 계정별 실제 할당량은 미확인 |
| 이미지 크기 상한 | 공급자 전체 상한 TBD. 로컬 제한은 구현과 별도이며 공급자 SLA가 아님 |
| 보존 / 배포 조건 | 계정 보존 설정·서비스 계약 적용 확인은 TBD/blocked. 파서 패키지 LICENSE는 SAM License 표기; 배포 승인 판정은 하지 않음 |

공식 근거: [SAM 개요](https://dev.meta.ai/docs/sam/overview), [프롬프트·미디어](https://dev.meta.ai/docs/sam/segmenting), [파서](https://dev.meta.ai/docs/sam/client-libraries), [wire 규격](https://github.com/meta-models/meta-sam/blob/main/protocol/sam3.md), [가격·rate](https://dev.meta.ai/docs/pricing-rate-limits). 2026-10-27 확인. 공시값은 계정의 권한·청구·보존 조건이 검증됐다는 뜻이 아니다.

## 로컬 호출과 비밀 경계

`POST /api/sam/segment`는 `{frame:{frameId,observedAt}, imageDataUrl, prompt}`를 받는다. 프레임 ID·관측 시각은 로컬 provenance이며 모델에는 이미지와 프롬프트만 전송한다. 프롬프트는 개발자가 지정하는 분할 개념이며 사용자 의도 신호가 아니다. 임의 URL 프록시는 제공하지 않는다.

키는 Node 서버 프로세스 환경에만 주입한다. Windows 사용자 환경변수를 설정한 후 기존 셸을 사용한다면 아래처럼 메모리에서 상속시키고 자식 프로세스 종료 뒤 제거한다. 값을 출력하거나 파일에 쓰지 않는다.

```powershell
$env:META_API_KEY = [Environment]::GetEnvironmentVariable('META_API_KEY', 'User')
try { node scripts/verify-sam-live.js } finally { Remove-Item Env:META_API_KEY -ErrorAction SilentlyContinue }
```

서버는 loopback·Host·Origin을 검사하고 요청 크기·동시 실행을 제한한다. 정적 allowlist는 서버 코드·환경변수·node_modules·검증 증거를 제공하지 않는다. upstream 오류 본문·헤더·키를 로깅하거나 클라이언트로 반환하지 않는다. 앱의 명시적 원격 처리 동의와 검증된 시간 정렬이 별도로 필요하다. `store: false`는 서버 측 응답 저장 옵션이며 보존 기간 또는 Zero Data Retention을 보증하지 않는다. 기존 호출의 저장 여부나 삭제 완료를 의미하지 않는다.

로컬 상한: 요청 JSON 8MiB, upstream 응답 16MiB, 한 번에 2개 요청, 30초 timeout, 100개 마스크, 디코딩 crop 총 4096² 픽셀 및 원본 각 축 4096픽셀. 자동 재시도는 없으며 실패는 고정 오류로 반환한다. 공유 provider 정책은 동시 실행·최소 간격·호출 수·추정 비용을 제한하고 429/네트워크 실패에 backoff 회로를 적용한다. 이는 계정 실제 할당량이나 지출 상한 보증이 아니다. crop의 `width/height`와 원본의 `sourceWidth/sourceHeight`를 구분하고 half-open `bounds`에 투영한다.

## 증거

`fixtures/sam-synthetic.png`는 코드가 만든 색 도형 장면이다. 정답 마스크는 평가 스크립트에만 있으며 공급자 요청에는 포함하지 않는다. 실행 전 IoU ≥0.8, 256×256 binary mask, 최소 1개 검출, 응답 모델 일치 기준을 고정한다. `docs/evidence/sam-live.json`에는 실행 시각, 입력 SHA-256, 기준, 지연, 정규화 응답 및 측정 결과를 남긴다. 주입형 테스트 결과와 실호출 결과를 구분한다.

실행 결과: 2026-10-27 14:52 KST, HTTP 200, `sam-3.1`, crop 80×80 마스크 1개, 전체 원본에 투영한 IoU 0.999375. 왕복 1,916ms / 공급자 호출·파싱 1,868ms. 단일 표본이다. 원본 크기 기준을 crop 자체 크기로 오인하지 않는다. 키 값이 소스·증거 파일에 포함되지 않았음을 메모리 비교로 확인했다(검사 결과만 출력).

## 공급자 정책 확인 (2026-10-28)

[Meta Responses 문서](https://dev.meta.ai/docs/protocols/responses)는 기본 `store: true`를 설명한다. 현재 어댑터는 `store: false`를 명시하나 SAM에 대한 실제 수용 여부와 과거 요청의 저장 상태는 미확인이다. [Standard 서비스 약관 §4.4–5.1](https://dev.meta.ai/legal/terms-of-service)은 Standard 요청을 모델 학습에 사용하지 않는다고 명시하면서 별도 보존 목적을 규정한다. [ZDR](https://dev.meta.ai/help/policies-and-privacy/zero-data-retention)은 별도 자격과 활성화가 필요하며 확인되지 않았다. 계정·모델별 실제 보존 기간과 적용 약관은 TBD다. 로컬 8 MiB JSON 상한은 공급자 SAM 이미지 상한이 아니다.
