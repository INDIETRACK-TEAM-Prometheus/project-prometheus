# Prometheus — 로컬 연구 프로토타입

Node.js `^20.17.0 || >=22.9.0`에서 실행합니다. `npm ci`로 고정된 공식 SAM 파서를 설치하세요. Aria CSV 회귀 시험에는 Python 3도 필요합니다.

현재 추론 모델은 사용자 승인에 따라 Standard **`muse-spark-1.3`**입니다(SRS 20.8). 실제 SAM→Spark 이미지·응시 이력·기억 호출에서 근거 있는 시나리오 3개를 확인했습니다. [v4 실호출·토큰/추정 비용](docs/evidence/reasoner-live-v4.json), [현재 Gate 판정](docs/CTO_REVIEW.md)을 참조하세요. 보존된 v3 실패가 있어 실운용 신뢰도를 통과로 주장하지 않습니다.

카메라·유료 SAM 통합 동의를 체크하면 카메라와 교정 안내가 시작되고, 교정 중에는 가상 장면만 SAM으로 분석합니다. 독립 교정이 통과하면 같은 자동 분석이 보정된 브라우저 시선 추정점을 점 프롬프트로 사용합니다. 장면 전용 결과는 시선 대상이라고 표시하지 않으며 교정 전 시선 SAM은 실행하지 않습니다. 자동 SAM 요청은 최소 5초 간격(분당 최대 12회)이고, 각 호출의 서버 예약 추정액은 $0.0025입니다. 실제 Meta 청구액은 계정·요금에 따라 다를 수 있으며 서버 공통 provider 상한은 분당 20회 / 추정 $0.10입니다. 별도 수동 장면 진단과 개념 탐색은 추가 유료 요청을 만듭니다. 카메라 영상·눈·얼굴·원시 랜드마크는 Meta에 보내지 않습니다. 체크 해제, 정지, 일시정지, 탭 숨김 시 자동 요청을 취소합니다. 물리적 카메라/화면 시간 정렬은 미검증이어서 시선 결과는 잠정 QA입니다. **측정 요약 내보내기**는 수치만 저장합니다.

```sh
cd prometheus
npm test
npm start
```

브라우저에서 http://127.0.0.1:4173 을 엽니다. WebGL 동적 3D 장면은 시선과 관계없이 움직입니다. 통합 동의 체크와 브라우저 권한 허용 뒤 카메라가 켜집니다. 원시 눈·얼굴 영상, 랜드마크, API 키는 저장하지 않으며, SAM에는 WebGL 가상 장면 이미지만 보냅니다. 시선 시연의 좌표(교정 여부를 표시), SAM 마스크 경계, Spark 결과는 이 기기에 자동 저장되고 **잠정 시연 기록 삭제** 또는 **세션 삭제**를 누를 때까지 보존됩니다. **정지**는 카메라 트랙을 닫고 교정과 자동 분석을 취소합니다. 진단 패널은 숨길 수 있습니다.

HTTPS가 필요한 카메라·브라우저 통합 QA는 기본 HTTP 대신 선택적으로 켤 수 있습니다. PowerShell 7.2 이상에서 아래 명령을 실행하면 `localhost` DNS SAN 및 `127.0.0.1` IP SAN이 포함된 30일짜리 인증서가 `%LOCALAPPDATA%\Prometheus\https`에 생성됩니다. PEM 개인키는 서버 시작 로그에 출력하지 않으며 프로젝트/OneDrive 폴더 밖에 둡니다. 인증서 생성은 사용자 인증서 저장소나 신뢰 저장소를 변경하지 않습니다.

```powershell
pwsh -NoProfile -File scripts\new-local-https-certificate.ps1
$env:PROMETHEUS_HTTPS_CERT = Join-Path $env:LOCALAPPDATA 'Prometheus\https\localhost-cert.pem'
$env:PROMETHEUS_HTTPS_KEY = Join-Path $env:LOCALAPPDATA 'Prometheus\https\localhost-key.pem'
npm start
```

브라우저에서 `https://127.0.0.1:4173`을 엽니다. 자체 서명 인증서는 브라우저에서 신뢰되지 않으므로, 신뢰하려면 `localhost-cert.cer`의 지문을 확인한 뒤 Windows `certmgr.msc`에서 **현재 사용자 → 신뢰할 수 있는 루트 인증 기관 → 인증서**로 직접 가져오세요. 지문 확인은 PowerShell에서 다음처럼 할 수 있습니다. 인증서는 이 기기의 loopback 이름에서만 쓰고, 개인키를 공유하거나 저장소에 추가하지 마세요. 원치 않는 인증서라면 같은 인증서 관리 화면에서 해당 인증서만 제거합니다. 서버는 HTTP/HTTPS 모두 `127.0.0.1`에만 바인딩하며 환경변수가 없으면 HTTP로 시작합니다.

```powershell
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $env:LOCALAPPDATA 'Prometheus\https\localhost-cert.cer'))
$cert.Thumbprint
```

## 웹캠 자산과 교정

`webeyetrack@0.0.2`와 공식 WebEyeTrack gaze model은 로컬 설치·제공됩니다. 기존 Face Landmarker의 WASM 실행 파일과 `face_landmarker.task`는 계속 `vendor/`에 준비해야 합니다. 공식 [Web 가이드](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js)에서 호환 자산의 라이선스와 출처를 확인하고, 아래 이름으로 배치하세요: `vision_bundle.mjs`, `vision_wasm_internal.js`, `vision_wasm_internal.wasm`, `vision_wasm_nosimd_internal.js`, `vision_wasm_nosimd_internal.wasm`, `face_landmarker.task`. WebEyeTrack 모델은 `vendor/webeyetrack-model/`에 포함되고 local server의 `/web/` 경로로만 로드됩니다. 런타임은 외부 CDN을 요청하지 않습니다. 상세한 출처, 해시, 라이선스, 제약은 [WebEyeTrack 통합 기록](docs/webeyetrack-integration.md)을 참조하세요. 모델이나 MediaPipe 자산이 빠지면 카메라를 열기 전에 시작이 실패합니다. 브라우저는 `requestVideoFrameCallback`을 지원해야 합니다.

사용자가 카메라를 시작한 뒤 **교정 / 검증 다시 시작**을 누르면 WebEyeTrack 공식 `adapt()`가 27개 표적 응시로 개인화를 수행하고, 별도 27개 표본에서 기준 WebEyeTrack 추정치를 평가합니다. 클릭은 관리 조작이지 의도 입력이 아닙니다. 유효율 80% 이상, 화면 대각선 대비 p95 오차 5% 이하여야 해당 세션에서 추정이 활성화됩니다. upstream에는 교정 저장/복원 API가 없으므로 카메라 정지나 페이지 새로고침 뒤 다시 교정해야 합니다. 기존 수제 교정 저장값은 덮어쓰지 않으며 새 엔진에서는 사용하지 않습니다. 좌우 눈 preview는 현재 카메라 프레임에서 로컬로 그립니다. 영상, crop, raw landmarks는 API로 보내거나 저장하지 않습니다. 교정과 카메라 품질은 실제 사용자·기기에서 QA가 더 필요하며 검증 표본은 제품 정확도나 일반화를 보장하지 않습니다.

현재 MediaPipe iris/upper-lid landmark residual은 선택 후보입니다. 기준 WebEyeTrack 평가 27점은 기존 게이트에 그대로 사용하고, 잔차 후보는 같은 3×3 표적을 두 번 반복한 18회에 적합한 뒤 세 번째 반복 9회에서 기준 추정과 비교합니다. 이 반복 표본은 공간적으로 독립된 정확도나 일반화 평가가 아닙니다. 자세한 한계는 [WebEyeTrack 통합 기록](docs/webeyetrack-integration.md)을 참조하세요.

## 현재 한계와 게이트

2026-10-27: 서버 측 `POST /api/sam/segment`를 구현하고 Meta `sam-3.1` 실제 호출을 합성 장면으로 검증했습니다. 256×256 장면의 빨간 사각형 1개, IoU **0.999375**, HTTP 왕복 **1,916ms**(단일 표본)입니다. 키는 서버 환경변수에서만 읽습니다. [계약·실행 방법](docs/sam-api-contract.md), [실호출 증거](docs/evidence/sam-live.json)를 참조하세요. 잠정 gaze-point SAM 자동 루프는 UI·요청 경로만 연결했으며 실제 브라우저·기기 사용자 검증은 미완입니다.

3D 장면의 현재 geometry depth와 raycast는 합성 데이터입니다. 장면은 카메라가 켜진 동안 최대 약 5Hz로 렌더된 RGBA 프레임을 복사하여 최근 10초/128MiB 한도에서 메모리에 보관합니다. 이 복사본은 정확한 렌더 프레임을 보존하지만 실제 화면 발광 시각은 측정되지 않아 `presentTsEstimateMs`와 표시 불확실성은 null입니다. 웹캠의 `captureTime`도 브라우저 추정이며 clock offset, drift, 총 정렬 오차가 측정되지 않아 시선-장면 결합과 이를 이용한 기억 기록은 보류합니다. 화면 기반 scene-only SAM 탐색은 별도 동의로 가능하며 시선을 사용하지 않습니다. [측정 준비 및 정렬 재개 조건](docs/browser-timing-calibration.md)을 참조하세요. 정렬 및 증거를 주입한 통합 테스트는 실제 카메라·화면 시간 정렬의 검증이 아닙니다. 객체 추적 및 세 동선의 실제 통합, Aria 로더, Muse Wonder 실제 호출은 아직 없습니다. 외부 행동은 실행하지 않으며 의미 해석을 별도 직렬 단계로 강제하지 않습니다.

광학 장비 없이 로컬 QA를 할 수 있도록 카메라 시작 후 자동 SAM 분석을 연결했습니다. 독립 교정이 진행되는 동안 자동 분석은 시선점 없는 장면 전용 SAM이며, 교정 통과 뒤에는 현재 고정된 WebGL 프레임에서 1.5초 동안 최근 브라우저 `captureTime` 추정 표본을 모아 유효한 보정 시선점만 SAM 점 프롬프트로 전송합니다. 두 모드는 하나의 완료 기준 5초 간격 스케줄러를 공유하므로 요청이 겹치지 않습니다. 시선 표본은 캡처→처리 지연 250ms 이하, 처리 후 100ms 이하로 제한됩니다. 이는 소프트웨어 표본 신선도 제한일 뿐 물리적 카메라/표시 시간 오차는 계속 미측정입니다. 장면 마스크와 잠정 시선점은 같은 프레임에 표시하며, 장면 전용 마스크에는 시선 주장을 붙이지 않습니다. 이 흐름은 UI·point prompt·mask 연결의 잠정 시험이며 온라인 인과, T15 또는 Gate 통과를 뜻하지 않습니다. 정지, 동의 철회, 일시정지, 탭 숨김, 재교정은 대기 표본과 결과를 비우고 요청을 취소합니다.

동기화 작업을 수행하는 운영자는 같은 페이지/카메라 세션에서 **장면 분석 설정 → 광학 시간 측정 기록**을 열고 카메라 라벨을 입력한 뒤 manifest 템플릿을 내보낼 수 있습니다. 외부 포토다이오드와 시간코드 로그에서 fit/독립 holdout 쌍을 채우고 원본 로그와 manifest를 다시 불러와 SHA-256 일치와 시간 모델을 확인합니다. 가져온 프로필은 현재 탭·카메라 세션에만 적용됩니다. 세로 상/중/하 표시 위치, 50ms 예산, drift/jump guard와 정확한 보존 프레임이 모두 확인돼야 런타임 시선 연결이 후보가 됩니다. 실제 광학 로그는 이 저장소에 없고 T15는 실행하지 않았으므로 이 기능은 Gate 통과를 주장하지 않습니다. 이 측정 기반 런타임 시선 SAM은 준비된 프레임 버튼을 직접 눌러야 시작되며, 광학 시간 측정 설정만으로 원격 요청을 보내지 않습니다.

| 게이트 | 상태 | 남은 주요 검증 |
|---|---|---|
| G0 | not_passed | SAM 및 승인된 Spark 실호출 확인. 공급자 전체 제한·계정 계약 조건 확인 미완. |
| G1 | blocked | 웹캠 모델 자산 설치 및 실제 장치·교정·크롭·정확도 독립 검증. |
| G2 | blocked | SAM 합성 이미지 검증만 passed. 객체 추적, 동기화된 Depth/raycast와 세 동선 연결 필요. |
| G3 | not_evaluated | 기억 서비스 기초는 구현·테스트했으나 실제 정렬 입력, 완전한 공간 기억 및 Aria 로더 미검증. |
| G4 | not_passed | 실제 Spark 열린 시나리오 확인. 실제 정렬된 시선/공간 기억 라이브 통합은 미검증. |
| G5 | not_evaluated | T01–T22 실제 입력 및 파일럿 평가 미실시. |

테스트는 단위와 주입된 통합 시나리오이며 게이트 통과를 뜻하지 않습니다. 상세 구현·한계는 `docs/`와 상위 `Prometheus_SRS_v1.1.md` 제20절을 참조하세요.
