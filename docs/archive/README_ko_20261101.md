# Prometheus — 로컬 연구 프로토타입

Node.js `^20.17.0 || >=22.9.0`에서 실행합니다. `npm ci`로 고정된 공식 SAM 파서를 설치하세요. Aria CSV 회귀 시험에는 Python 3도 필요합니다.

현재 추론 모델은 사용자 승인에 따라 Standard **`muse-spark-1.3`**입니다(SRS 20.8). 실제 SAM→Spark 이미지·응시 이력·기억 호출에서 근거 있는 시나리오 3개를 확인했습니다. [v4 실호출·토큰/추정 비용](docs/evidence/reasoner-live-v4.json), [현재 Gate 판정](docs/CTO_REVIEW.md)을 참조하세요. 보존된 v3 실패가 있어 실운용 신뢰도를 통과로 주장하지 않습니다.

> **2026-11-01 정합성 정리.** 이 README의 일부 서술은 10/31 오후 이전 상태였습니다. 이후 커밋(`b726530`, `55bd193`, `e22fca9`, `241e976`, `ddd3068`, `bd1d810`, `05f950a`, `7483d45`)으로 바뀐 현재 동작은 다음과 같고, 아래 본문도 이에 맞춰 고쳤습니다. 구현·단위 시험 상태이며 어떤 Gate도 승격하지 않습니다.
>
> - **원본 웹캠 영상 로컬 기록:** 시작 시 카메라 영상 전체(얼굴 포함)를 WebM chunk로 `data/recordings/<세션 UUID>/`에 저장합니다(세션당 1GiB, 전체 5GiB 상한, Git 제외). Meta로 전송하지 않습니다. 2026-10-31 사용자 지시([DEMO_BRIEF](docs/DEMO_BRIEF_20261104.md))에 따른 변경입니다. 녹화 목록 `GET /api/recordings`와 전체 삭제 `DELETE /api/recordings`(loopback 전용, 녹화 중인 세션은 보류, 삭제·실패·보류 수 보고)를 추가했습니다. **기록 및 데이터 관리**에 확인·전체 삭제·저장 교정 삭제 버튼이 있고, 동의 문구에 로컬 녹화와 교정 프로필 저장을 고지합니다. export는 없습니다. 전체 화면 UI(`8df5486`)는 설정 패널을 숨기고 ▶ 클릭이 모든 동의를 체크하므로, ■ 옆 **데이터** 버튼이 그 위에 패널을 열어 녹화·교정 저장 고지와 **기록 및 데이터 관리**를 보여줍니다(Esc로 닫힘). ▶의 툴팁도 로컬 녹화를 알립니다.
> - **교정 단계 진단 로그:** `/api/diagnostics/calibration-stage`는 Origin이 정확히 일치하는 loopback 요청만 받아 허용된 이벤트 ID, 카메라 세션 UUID, 제한된 duration/sample count와 서버 시각을 Git 제외 대상 `data/diagnostics/calibration-stages.jsonl`에 기록합니다. 현재 로그와 회전 백업은 각각 256 KiB 이하입니다. 카메라 프레임·픽셀·좌표·원시 payload·예외 문자열은 저장하지 않습니다.
> - **교정 저장·복원:** 통과한 WebEyeTrack 적응 표본(눈 patch 픽셀, 머리 벡터, 얼굴 원점, 표적)과 선택된 affine·landmark 잔차 보정을 IndexedDB 프로필에 저장하고, 다음 시작 때 환경·런타임이 호환되면 `adapt()`에 재적용해 복원합니다. 정지로 삭제하지 않습니다.
> - **백그라운드 attention 루프:** 1초 주기 coordinator가 최신 프레임으로 SAM과 로컬 Depth Anything을 요청하고, 잠정 Spark 동의가 있으면 Spark 가설·다음 응시 후보를 요청합니다(진행 1건 + 최신 대기 1건). 현재 이 경로는 SAM 마스크를 경계 박스로 줄이고 프레임 단위 후보 ID를 쓰며, 지속 객체 ID는 아직 연결되지 않았습니다([감사 A03](docs/GATE_PROTOCOL_AUDIT_20261101.md)). **정정(2026-11-01 통합 검토):** coordinator 생성자가 `snapshot` 옵션을 저장하지 않아 이 주기 실행은 커밋 `55bd193` 이후 실제로 한 번도 시작되지 않았습니다. 이후 통합에서 라이브 경로는 실제 마스크 기반 지속 ID(`src/runtime/live-tracking.js`)로 바뀌었고, 사용자 승인(2026-11-01)에 따라 `snapshot` 저장을 고쳐 루프를 켰습니다. 시작 동의가 있고 탭이 보이며 얼굴·시선 샘플이 신선할 때만 스냅샷을 만들고, 일시정지·정지·교정 중에는 호출하지 않습니다.
> - **Depth Anything V2 Metric Hypersim Small:** `/api/depth/estimate`는 기본적으로 로컬 CPU worker를 사용합니다. 서버 운영자가 `PROMETHEUS_DEPTH_BACKEND=colab`을 설정하면 선택된 Colab GPU로 SSH 터널을 통해 가상 장면 RGB 프레임을 보냅니다. 현재 선택은 **데이터 → 기록 및 데이터 관리** 패널에 표시됩니다. [로컬 설치](docs/depth-anything-v2-local.md) · [Colab T4 설정·합성 transport 비교](docs/depth-anything-v2-colab.md) · [paired T4 결과](docs/evidence/depth-colab-transport-20261101-035955.json).
> - **Depth + gaze Colab GPU 프로필:** `scripts/colab/start-system.ps1 -Gpu T4 -RunServer`가 두 worker를 한 Colab VM에 시작하고 별도 loopback SSH 터널을 엽니다. 브라우저 캡처·JPEG 인코딩·화면 렌더링과 Node server는 로컬에 남습니다. 명시적 카메라 동의 뒤 최대 640px JPEG 카메라 프레임(최대 8 fps)은 gaze 추론을 위해 Colab으로 전달되며, Depth에는 가상 장면 RGB만 전달됩니다. [프로필 설정·데이터 흐름·정리](docs/colab-system-gpu.md).

> - **Windows Colab CLI:** 처음 한 번 `pwsh -NoProfile -File scripts\colab\setup-colab.ps1`을 실행해 고정 버전을 설치합니다. 실행 파일과 uv 도구 환경은 각각 `%USERPROFILE%\.prometheus\bin` 및 `%USERPROFILE%\.prometheus\uv-tools`에 놓이며, 설치는 로그인하거나 GPU 세션을 시작하지 않습니다. GPU 시작 스크립트는 할당된 GPU에 따라 과금되는 세션을 시작하므로 작업 뒤 대응하는 `stop-*.ps1` 명령으로 종료하세요.
> - **서버 공통 provider 상한:** 동시 1건, 최소 250ms 간격, 분당 20회, 추정 비용 분당 $1(`PROMETHEUS_PROVIDER_BUDGET_PER_MINUTE`로 변경). 이전 $0.10/분은 백그라운드 루프 도입 때 바뀌었습니다. 추정 예약액이며 청구 상한이 아닙니다.
> - **시선 정확도 시험(G1-F):** 교정 통과 후 **데이터 → 시선 정확도 시험**이 교정에 쓰지 않은 표적 9개×3회를 자동으로 보여주고(클릭 없음, 약 60초), plan hash가 고정된 보고서와 표본을 내보냅니다. 실제 사용자 결과는 아직 없습니다.
> - **회귀:** 2026-11-01 `npm test` 313개 중 312 통과, 1 skip(PowerShell 7 필요한 HTTPS 시험), 실패 0 ([기록](docs/evidence/unit-tests-20261101-doc-consistency.txt)). 녹화 삭제·데이터 버튼 추가 후 317개 중 316 통과, 1 skip, 실패 0.

카메라·유료 SAM 통합 동의를 체크하면 카메라와 교정 안내가 시작되고, 교정 중에는 가상 장면만 SAM으로 분석합니다. 독립 교정이 통과하면 같은 자동 분석이 보정된 브라우저 시선 추정점을 점 프롬프트로 사용합니다. 장면 전용 결과는 시선 대상이라고 표시하지 않으며 교정 전 시선 SAM은 실행하지 않습니다. 잠정 고정 장면 시선 탐색의 자동 SAM 요청은 최소 5초 간격(분당 최대 12회)이고, 각 호출의 서버 예약 추정액은 $0.0025입니다. 이와 별도로 백그라운드 attention 루프가 1초 주기로 SAM·Depth(및 동의 시 Spark, 호출당 예약 $0.05)를 요청합니다(2026-11-01 활성화, 위 정정 참조). 실제 Meta 청구액은 계정·요금에 따라 다를 수 있으며 서버 공통 provider 상한은 분당 20회 / 추정 $1(환경변수로 변경 가능)입니다. 별도 수동 장면 진단과 개념 탐색은 추가 유료 요청을 만듭니다. 카메라 영상·눈·얼굴·원시 랜드마크는 Meta에 보내지 않습니다. 선택형 Colab cloud 프로필은 별도 경로이며, 명시적 카메라 동의 뒤 gaze 추론을 위해 축소 JPEG 카메라 프레임을 Colab VM으로 전송합니다([데이터 흐름](docs/colab-system-gpu.md)). 체크 해제, 정지, 일시정지, 탭 숨김 시 자동 요청을 취소합니다. 물리적 카메라/화면 시간 정렬은 미검증이어서 시선 결과는 잠정 QA입니다. **측정 요약 내보내기**는 수치만 저장합니다.

```sh
cd prometheus
npm test
npm start
```

브라우저에서 http://127.0.0.1:4173 을 엽니다. WebGL 동적 3D 장면은 시선과 관계없이 움직입니다. 통합 동의 체크와 브라우저 권한 허용 뒤 카메라가 켜집니다. 카메라 원본 영상은 로컬 `data/recordings/`에만 기록되고(위 정합성 정리 참조), 원시 랜드마크와 API 키는 저장하지 않으며, SAM에는 WebGL 가상 장면 이미지만 보냅니다. 시선 시연의 좌표(교정 여부를 표시), SAM 마스크 경계, Spark 결과는 이 기기에 자동 저장되고 **잠정 시연 기록 삭제** 또는 **세션 삭제**를 누를 때까지 보존됩니다. **정지**는 카메라 트랙을 닫고 교정과 자동 분석을 취소합니다. 진단 패널은 숨길 수 있습니다.

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

**계산 범위:** 현재 gaze 추론은 매 프레임 전체 프레임을 MediaPipe Face Landmarker에 보내 얼굴 메시, head pose, face origin을 구한 뒤 WebEyeTrack의 눈 patch 모델을 실행합니다. 478점 중 눈 주변 점만 선택하는 것으로 MediaPipe 추론량은 줄지 않으며, 현재 파이프라인은 eye-only 모델로 바뀌지 않았습니다. worker는 미리보기용 전체 프레임 픽셀 복사를 눈·눈썹 crop 복사로 바꿨고, `faceLandmarker`, `prepareInput`, `blazeGaze`, `eyePreviewMs` 등의 단계 시간을 표본에 남깁니다. 이 변경은 미리보기 복사량만 줄입니다. 모델 지연을 눈 주변으로 한정하려면 ROI를 직접 초기화하고 같은 프레임의 eye/lid/iris/brow 추적 및 gaze 보정을 제공하는 별도 검증된 모델이 필요합니다.

사용자가 카메라를 시작한 뒤 **교정 / 검증 다시 시작**을 누르면 WebEyeTrack 공식 `adapt()`가 27개 표적 응시로 개인화를 수행하고, 별도 27개 표본에서 기준 WebEyeTrack 추정치를 평가합니다. 클릭은 관리 조작이지 의도 입력이 아닙니다. 유효율 80% 이상, 화면 대각선 대비 p95 오차 5% 이하여야 해당 세션에서 추정이 활성화됩니다. upstream에는 교정 저장/복원 API가 없으므로, 앱은 통과한 적응 표본을 IndexedDB 프로필로 저장하고 다음 시작 때 같은 표본을 `adapt()`에 다시 적용해 복원합니다. 환경·런타임이 맞지 않거나 손상되면 복원을 보류하고 표시합니다. 복원 뒤 독립 정확도 재검증(G1-E/F)은 아직 수행하지 않았습니다. 기존 수제 교정 저장값은 덮어쓰지 않으며 새 엔진에서는 사용하지 않습니다. 좌우 눈 preview에는 같은 추론 프레임의 실제 MediaPipe 눈 윤곽·눈꺼풀·홍채·눈썹 랜드마크를 로컬로 겹쳐 표시합니다. 이는 동공 검출이 아닙니다. 임시 미리보기 이미지는 표시 후 닫고 샘플·로그·저장 데이터에는 넣지 않습니다. 영상, crop, raw landmarks는 API로 보내지 않습니다. 로컬에는 원본 영상 녹화와 교정 프로필의 눈 patch가 저장됩니다. 교정과 카메라 품질은 실제 사용자·기기에서 QA가 더 필요하며 검증 표본은 제품 정확도나 일반화를 보장하지 않습니다.

현재 MediaPipe iris/upper-lid landmark residual은 선택 후보입니다. 기준 WebEyeTrack 평가 27점은 기존 게이트에 그대로 사용하고, 잔차 후보는 같은 3×3 표적을 두 번 반복한 18회에 적합한 뒤 세 번째 반복 9회에서 기준 추정과 비교합니다. 이 반복 표본은 공간적으로 독립된 정확도나 일반화 평가가 아닙니다. 자세한 한계는 [WebEyeTrack 통합 기록](docs/webeyetrack-integration.md)을 참조하세요.

## 현재 한계와 게이트

2026-10-27: 서버 측 `POST /api/sam/segment`를 구현하고 Meta `sam-3.1` 실제 호출을 합성 장면으로 검증했습니다. 256×256 장면의 빨간 사각형 1개, IoU **0.999375**, HTTP 왕복 **1,916ms**(단일 표본)입니다. 키는 서버 환경변수에서만 읽습니다. [계약·실행 방법](docs/sam-api-contract.md), [실호출 증거](docs/evidence/sam-live.json)를 참조하세요. 잠정 gaze-point SAM 자동 루프는 UI·요청 경로만 연결했으며 실제 브라우저·기기 사용자 검증은 미완입니다.

3D 장면의 현재 geometry depth와 raycast는 합성 데이터입니다. 장면은 카메라가 켜진 동안 최대 약 5Hz로 렌더된 RGBA 프레임을 복사하여 최근 10초/128MiB 한도에서 메모리에 보관합니다. 이 복사본은 정확한 렌더 프레임을 보존하지만 실제 화면 발광 시각은 측정되지 않아 `presentTsEstimateMs`와 표시 불확실성은 null입니다. 웹캠의 `captureTime`도 브라우저 추정이며 clock offset, drift, 총 정렬 오차가 측정되지 않아 시선-장면 결합과 이를 이용한 기억 기록은 보류합니다. 화면 기반 scene-only SAM 탐색은 별도 동의로 가능하며 시선을 사용하지 않습니다. [측정 준비 및 정렬 재개 조건](docs/browser-timing-calibration.md)을 참조하세요. 정렬 및 증거를 주입한 통합 테스트는 실제 카메라·화면 시간 정렬의 검증이 아닙니다. 마스크 기반 로컬 추적(`spatial/tracker.js`, `munkres` 전역 할당)과 공식 MPS CSV 변환기는 있으나, 백그라운드 경로의 지속 ID 연결, 세 동선의 실제 통합, VRS/Pilot replay는 아직 없습니다. Muse Wonder는 비가용이며 승인된 Spark로 대체했습니다. 외부 행동은 실행하지 않으며 의미 해석을 별도 직렬 단계로 강제하지 않습니다.

광학 장비 없이 로컬 QA를 할 수 있도록 카메라 시작 후 자동 SAM 분석을 연결했습니다. 독립 교정이 진행되는 동안 자동 분석은 시선점 없는 장면 전용 SAM이며, 교정 통과 뒤에는 현재 고정된 WebGL 프레임에서 1.5초 동안 최근 브라우저 `captureTime` 추정 표본을 모아 유효한 보정 시선점만 SAM 점 프롬프트로 전송합니다. 두 모드는 하나의 완료 기준 5초 간격 스케줄러를 공유하므로 요청이 겹치지 않습니다. 시선 표본은 캡처→처리 지연 250ms 이하, 처리 후 100ms 이하로 제한됩니다. 이는 소프트웨어 표본 신선도 제한일 뿐 물리적 카메라/표시 시간 오차는 계속 미측정입니다. 장면 마스크와 잠정 시선점은 같은 프레임에 표시하며, 장면 전용 마스크에는 시선 주장을 붙이지 않습니다. 이 흐름은 UI·point prompt·mask 연결의 잠정 시험이며 온라인 인과, T15 또는 Gate 통과를 뜻하지 않습니다. 정지, 동의 철회, 일시정지, 탭 숨김, 재교정은 대기 표본과 결과를 비우고 요청을 취소합니다.

동기화 작업을 수행하는 운영자는 같은 페이지/카메라 세션에서 **장면 분석 설정 → 광학 시간 측정 기록**을 열고 카메라 라벨을 입력한 뒤 manifest 템플릿을 내보낼 수 있습니다. 외부 포토다이오드와 시간코드 로그에서 fit/독립 holdout 쌍을 채우고 원본 로그와 manifest를 다시 불러와 SHA-256 일치와 시간 모델을 확인합니다. 가져온 프로필은 현재 탭·카메라 세션에만 적용됩니다. 세로 상/중/하 표시 위치, 50ms 예산, drift/jump guard와 정확한 보존 프레임이 모두 확인돼야 런타임 시선 연결이 후보가 됩니다. 실제 광학 로그는 이 저장소에 없고 T15는 실행하지 않았으므로 이 기능은 Gate 통과를 주장하지 않습니다. 이 측정 기반 런타임 시선 SAM은 준비된 프레임 버튼을 직접 눌러야 시작되며, 광학 시간 측정 설정만으로 원격 요청을 보내지 않습니다.

아래 상태는 [CTO_REVIEW](docs/CTO_REVIEW.md)의 현재 판정을 따릅니다. 세부 Gate(G0-A–G5-D)는 [GATE_PLAN](docs/GATE_PLAN_20261104.md)에서 모두 not_evaluated이며, 남은 수용 조건은 [Gate·프로토콜 감사](docs/GATE_PROTOCOL_AUDIT_20261101.md)를 함께 봅니다.

| 게이트 | 상태 | 남은 주요 검증 |
|---|---|---|
| G0 | not_passed | SAM 및 승인된 Spark 실호출 확인. 공급자 전체 제한·계정 보존/계약 조건 확인 미완. Depth Anything(G0-B)·GNN(G0-C) 미평가. |
| G1 | not_passed | 웹캠 자산·교정 저장/복원은 구현. 실제 사용자 독립 표적 검증·30분 운용 미수신. |
| G2 | not_passed | SAM 합성 4프레임·tracker/Depth 단위 연결 확인. 실제 렌더 시험, 광학 시간 정렬, 3장면/100주석, 세 동선 종단 미완. |
| G3 | not_passed | MPS CSV·관측 정정/삭제 연결 확인. VRS·Pilot replay, 검색 평가, 브라우저 강제종료 복구 미완. |
| G4 | not_passed | Spark 복수 시나리오 확인. 실제 정렬된 시선/기억의 라이브 갱신·무효화 검증 미완. |
| G5 | not_evaluated | T01–T22 실수용·30분 운용·사용자/장면 분리 비교 평가 미완. |

테스트는 단위와 주입된 통합 시나리오이며 게이트 통과를 뜻하지 않습니다. 상세 구현·한계는 `docs/`와 상위 `Prometheus_SRS_v1.1.md` 제20절을 참조하세요.
