# 요구사항 추적표 — SRS v1.1 요구 ID × 구현 × 시험 × 증거

작성: 2026-11-01 KST, 기준 commit `c2cd016`. 근거: `../Prometheus_SRS_v1.1.md`, [GATE_PLAN](GATE_PLAN_20261104.md), [감사 A13·A14](GATE_PROTOCOL_AUDIT_20261101.md), [CTO_REVIEW](CTO_REVIEW.md), 소스·시험 파일 존재 여부. 이 문서는 문서 작성이며 어떤 요구나 Gate도 통과시키지 않는다.

## 읽는 법

- **구현상태(implementationStatus)**: `planned` 구현 없음, `implemented` 코드가 있으나 해당 요구 전체를 덮는 자동 시험이 없거나 일부만 구현(비고에 `부분` 표기), `tested` 요구 범위에 자동화 단위·합성 시험이 있음. `tested`는 `passed`가 아니다.
- **평가상태(evaluationStatus)**: `not_evaluated` 실제 사용자·하드웨어·공급자·주석 평가 미실시, `blocked` 외부 의존성으로 평가 불가. 이 표에는 `failed`·`passed`가 없다. mock·합성·단위 시험은 어떤 요구도 `passed`로 만들지 않는다.
- **[U]**: `docs/evidence/unit-tests-20261101-doc-consistency.txt` — 2026-11-01 `npm test` 313개 중 312 통과, 1 skip(PowerShell 7 필요 HTTPS 시험), 실패 0. 단위·주입형 시험 증거이며 실제 사용자·하드웨어 증거가 아니다. 시험 열은 `test/*.test.js`의 접두·접미를 생략했다.
- **Gate**: 담당 세부 Gate(`GATE_PLAN_20261104.md`의 G0-A…G5-D). `(+…)`는 보조 Gate. 판정 기록은 `docs/evidence/gates/<gateId>.json`.
- 증거 열의 이름은 `docs/evidence/<이름>.json`. 합성 입력으로 얻은 실호출 증거는 합성으로 표기된다(비고).

## 요약

요구 ID 127개(SCP·EYE·GEO·OBJ·PATH·EVT·MEM·INF·PRE·RT·UI·SEC·OPEN·SYNC·BUF·MAP·VALID·DEL·DATA·OPS·API 105개 + 시험 T01–T22 22개).

| 구분 | planned | implemented | tested | 합계 |
|---|---|---|---|---|
| SRS 요구(T 제외) | 1 | 40 | 64 | 105 |
| 시험 T01–T22 | 0 | 3 | 19 | 22 |
| 전체 | 1 | 43 | 83 | 127 |

평가상태: not_evaluated 123, blocked 4, failed 0, passed 0. blocked는 DATA-01, DATA-02, T13, T21(G3-C: Pilot 자료 미확보·VRS SDK 미실행).

## 2. 범위·불변 조건 (SCP)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| SCP-01 | 의도 입력은 시선·응시 시간만 사용 | `src/runtime/contracts.js`, `src/runtime/facade.js`, `server/reasoner-adapter.js` | `runtime-facade`, `reasoner-adapter` | [U] | tested | not_evaluated | G4-C | 교정·시작 클릭은 관리 조작. 음성·자연어 입력 경로 없음. |
| SCP-02 | 환경 맥락과 의도 신호를 구분 | `src/core.js`, `src/runtime/facade.js`, `src/runtime/perception.js` | `core`, `runtime-facade` | [U] | tested | not_evaluated | G4-C |  |
| SCP-03 | 게임·시선 조종·dwell 확정 UI 금지 | `index.html`, `src/app.js` | 없음 | 없음 | implemented | not_evaluated | G5-A | 금지 조건. 가상 장면은 시선과 독립. 전용 시험 없음. |
| SCP-04 | 관측·지식·가설·예측·추천 별도 타입 저장 | `src/runtime/contracts.js`, `src/memory/index.js` | `runtime`, `memory` | [U] | implemented | not_evaluated | G4-C | 부분: 관측·가설·다음 시선만 구분. 지식·추천 타입 없음. |
| SCP-05 | 생각 전사·마음 읽기 성능 주장 금지 | `index.html`, `server/reasoner-adapter.js` | 없음 | 없음 | implemented | not_evaluated | G4-C | UI 고지·프롬프트 제약. 자동 시험 없음. |
| SCP-06 | SAM·Depth·동선·기억·검색 필수 구현 | `server/sam-adapter.js`, `server/depth-provider.js`, `src/spatial/tracker.js`, `src/memory/index.js` | 없음 | `depth-u07-20261031`, `sam-live` | implemented | not_evaluated | G5-C (+G5-B) | 모듈은 존재하나 종단 통합·실측 미완(감사 A03). |
| SCP-07 | 기본 조용한 백그라운드, 외부 행동 자동 실행 금지 | `src/runtime/facade.js`, `src/runtime/background-attention.js` | `runtime-facade`, `background-attention` | [U] | tested | not_evaluated | G4-A |  |
| SCP-08 | 미래·정답·목표 채널의 예측 입력 유출 차단 | `src/core.js`, `server/reasoner-adapter.js`, `src/evaluation/ledger.js`, `src/evaluation/comparison.js` | `core`, `reasoner-adapter`, `evaluation-ledger`, `comparison` | [U] | tested | not_evaluated | G4-C (+G5-D) | T11 담당. 전체 실데이터 경로 유출 검사는 미실시. |

## 5. 캡처·교정·눈 추적 (EYE)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| EYE-01 | 권한 후 캡처, 해상도·FPS·장치 ID 기록 | `src/gaze/webcam.js`, `src/app.js` | `gaze-webcam` | [U] | implemented | not_evaluated | G1-A | 부분: width/height/frameRate만 기록. 장치 ID 미기록(요약 내보내기는 카메라 ID 제외). |
| EYE-02 | 양쪽 눈 ROI·홍채 랜드마크·눈별 유효성 | `src/gaze/webeyetrack-worker.js`, `src/gaze/index.js`, `src/gaze/eye-sphere.js` | `gaze-unit`, `webeyetrack-worker`, `eye-sphere` | [U] | tested | not_evaluated | G1-B (+G1-C,G1-D) |  |
| EYE-03 | 눈꼬리 기준 ROI 안정화 | `src/gaze/index.js` | `gaze-unit` | [U] | tested | not_evaluated | G1-B | 홍채가 아닌 눈꼬리 기준 crop(eyeCrop). |
| EYE-04 | 개인별 다점 교정·독립 검증점 | `src/gaze/index.js`, `src/gaze/calibration-profile.js`, `src/gaze/webeyetrack-adaptation.js`, `src/gaze/calibration-window.js` | `gaze-unit`, `calibration-profile`, `webeyetrack-adaptation`, `calibration-window`, `gaze-webcam` | [U] | tested | not_evaluated | G1-F (+G1-E,G0-C,G1-G) | DEMO_BRIEF: 최초 30~60초 교정·저장 재사용 목표(현재 27+27 클릭, 미충족). 반복 격자 비교는 일반화 증거 아님. GNN(G0-C/G1-G)은 SRS 외 사용자 요구로 EYE-04에 연결. |
| EYE-05 | 머리 자세는 시선 보정용으로만 사용 | `src/gaze/calibration-profile.js`, `src/gaze/webeyetrack-adaptation.js`, `server/reasoner-adapter.js` | `runtime-facade`, `reasoner-adapter` | [U] | implemented | not_evaluated | G1-F | headVector는 WebEyeTrack 보정 내부에서만 사용; 추론 입력 allowlist에 없음. |
| EYE-06 | 원본 좌표 추론, 거울 반전은 표시 단계 | `src/gaze/index.js`, `src/gaze/overlay.js` | `gaze-unit`, `gaze-uncalibrated`, `gaze-overlay` | [U] | tested | not_evaluated | G1-B |  |
| EYE-07 | 교정 후 악화 감지·재교정 안내·추론 보류 | `src/gaze/index.js`, `src/gaze/persistence.js`, `src/gaze/calibration-profile.js` | `gaze-unit`, `gaze-persistence`, `calibration-profile` | [U] | implemented | not_evaluated | G1-F | 부분: degradedReason 경로와 환경 변경 감지만. 조도·안경 반사·머리 이동 악화 자동 검출 없음. |
| EYE-08 | 유실·깜박임 invalid 기록, 마지막 시선 재사용 금지 | `src/gaze/index.js`, `src/gaze/uncalibrated.js`, `src/app.js` | `gaze-unit`, `gaze-uncalibrated`, `integration-wiring` | [U] | tested | not_evaluated | G1-B |  |
| EYE-09 | 원시 시선과 표시용 필터 결과 분리 | `src/gaze/display-filter.js` | `display-filter` | [U], `display-filter-synthetic-benchmark` | tested | not_evaluated | G1-F | 합성 궤적 벤치마크만. 실제 jitter·지연 개선 미측정. |

## 6. Depth와 공간 연결 (GEO)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| GEO-01 | depth_source 5종 기록 | `src/spatial/geometry.js`, `src/spatial/world.js`, `server/depth-provider.js` | `spatial`, `depth-provider` | [U], `depth-u07-20261031` | tested | not_evaluated | G0-B (+G2-B) | engine_geometry와 monocular_estimated_depth를 구분 표시. |
| GEO-02 | depth 단위·convention·유효 마스크·신뢰도·버전 | `src/spatial/geometry.js`, `src/runtime/perception.js`, `server/depth-provider.js` | `spatial`, `depth-provider`, `perception` | [U], `depth-u07-20261031` | implemented | not_evaluated | G2-B (+G0-B) | 부분: 신뢰도 필드 없음. |
| GEO-03 | RGB·마스크·Depth·pose 동일 시점 정렬, 초과 시 보류 | `src/runtime/perception.js`, `src/runtime/clock.js`, `src/spatial/world.js` | `perception`, `spatial`, `core`, `timing-calibration` | [U] | tested | not_evaluated | G2-D (+G2-B) |  |
| GEO-04 | 시선 ray를 첫 가시 표면과 교차, 빈 공간 no_hit | `src/spatial/geometry.js`, `src/spatial/world.js` | `spatial` | [U] | tested | not_evaluated | G2-C | 엔진 기하 합성 시험만. 렌더 픽셀-깊이 실측 미완. |
| GEO-05 | 보정 픽셀·깊이·camera-to-world로 공간 점 | `src/spatial/geometry.js`, `src/runtime/perception.js`, `server/depth-provider.js` | `spatial`, `depth-provider` | [U], `depth-u07-20261031` | tested | not_evaluated | G2-B (+G2-C) | 합성 영상 스모크만. |
| GEO-06 | 오차 범위가 여러 물체에 걸치면 후보 분포 유지 | `src/spatial/geometry.js`, `src/spatial/mask-association.js` | `spatial`, `mask-association` | [U] | tested | not_evaluated | G2-C |  |
| GEO-07 | 미터 스케일 없는 단안 깊이를 절대 거리로 출력 금지 | `src/spatial/geometry.js`, `server/depth-provider.js` | `spatial`, `depth-provider` | [U], `depth-u07-20261031` | tested | not_evaluated | G0-B (+G2-B) | metric 체크포인트 출력도 monocular_estimated_depth로 구분. |
| GEO-08 | 좌표계 재설정 시 map_id/version 갱신, 병합 금지 | `src/runtime/perception.js`, `src/memory/index.js`, `src/spatial/tracker.js` | `perception`, `map-correction`, `spatial`, `memory` | [U] | tested | not_evaluated | G3-B (+G2-D) |  |
| GEO-09 | 유리·반사·가림·깊이 구멍에 불확실/unavailable | `src/spatial/geometry.js`, `server/depth-provider.js` | `spatial` | [U] | implemented | not_evaluated | G2-B | 부분: 유효 마스크·unavailable만. 유리·반사 검출 없음. |

## 7. SAM 마스킹·객체·동선 (OBJ, PATH)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| OBJ-01 | SAM 3.1 어댑터, 실확인 전 연결 완료 표시 금지 | `server/sam-adapter.js`, `server.js`, `src/runtime/server-providers.js` | `sam-adapter`, `sam-route`, `server-pipeline` | [U], `sam-live`, `sam-point-pipeline-live`, `sam-scene-pipeline-live`, `perception-live`, `store-false-live` | tested | not_evaluated | G0-A (+G2-A) | 합성 이미지 실호출 증거만. |
| OBJ-02 | 시선 주변 우선 처리와 주기적 장면 탐색 병행 | `src/runtime/exploration.js`, `src/runtime/background-attention.js`, `src/runtime/background-browser.js`, `src/gaze/frozen-demo.js` | `exploration`, `background-attention`, `background-browser`, `frozen-demo`, `perception` | [U], `sam-objects-exploration-live`, `sam-objects-exploration-live-v2` | tested | not_evaluated | G2-A (+G4-A) | 일반 `objects` 프롬프트 실호출은 마스크 0개(보존). 백그라운드 경로는 마스크를 경계 박스로 축약. |
| OBJ-03 | 마스크와 의미 라벨 분리 | `server/sam-adapter.js`, `src/spatial/tracker.js` | `sam-adapter`, `tracker` | [U] | implemented | not_evaluated | G2-A | 부분: 개념 프롬프트와 마스크 분리. 별도 라벨 후보 필드 없음. |
| OBJ-04 | detection_id와 지속 object_id 구분, 재식별 | `src/spatial/tracker.js`, `src/spatial/mask-association.js` | `tracker`, `mask-association` | [U], `spatial-live` | tested | not_evaluated | G2-D (+G2-A) | 백그라운드 경로는 프레임 단위 후보 ID만 사용, 지속 ID 미연결(감사 A03). |
| OBJ-05 | 불확실 매칭은 잠정 후보, 병합 취소 가능 | `src/spatial/tracker.js`, `src/spatial/mask-association.js` | `tracker`, `mask-association`, `memory` | [U], `spatial-live` | tested | not_evaluated | G2-D |  |
| OBJ-06 | 마스크 전파는 tracker 결과로 표기하고 나이 제한 | `src/spatial/tracker.js` | `tracker` | [U] | tested | not_evaluated | G2-A (+G2-D) | 정적 carry-forward만(maxPropagationMs 200ms). |
| PATH-01 | 시선 동선: 전이·응시 시간·재응시·glimpse·위치 | `src/memory/index.js`, `src/runtime/perception.js`, `src/app.js` | `memory`, `perception`, `integration-wiring` | [U] | implemented | not_evaluated | G2-D (+G3-B) | 부분: 이벤트 원장 존재. 공간 위치 결합은 시간 정렬 보류 상태. 동선 뷰 없음. |
| PATH-02 | 시점 동선: 카메라/장비 pose 이력 | `src/app.js`, `src/spatial/world.js`, `src/aria/mps_csv.py` | `spatial`, `aria-mps` | [U] | implemented | not_evaluated | G2-D | 부분: 프레임별 pose 보존. 별도 시점 동선 레코드·표시 없음. |
| PATH-03 | 객체 동선: 시간별 위치·불확실성 | `src/spatial/tracker.js`, `src/memory/index.js` | `tracker`, `memory` | [U], `spatial-live` | implemented | not_evaluated | G2-D (+G3-B) | 부분: 관측·last_seen 이력. 불확실성 공분산 없음. |
| PATH-04 | 카메라 이동 vs 객체 이동 구분, 불가능하면 unknown | `src/runtime/perception.js`, `src/spatial/tracker.js` | `perception`, `spatial` | [U] | implemented | not_evaluated | G2-D | 부분: 이미지 경계 변화는 observation_conflict로만 기록, 실제 3D 이동 단정 안 함. |

## 8. 응시 이벤트와 경험 기억 (EVT, MEM)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| EVT-01 | fixation 시간·분산/속도 기준 설정 가능 | `src/app.js` | `integration-wiring` | [U] | implemented | not_evaluated | G3-B | 부분: app.js에 150ms 고정 분류. 분산/속도 기준·설정 UI 없음. |
| EVT-02 | seen_in_scene/briefly_crossed/fixated 구분 | `src/app.js`, `src/memory/index.js`, `src/runtime/facade.js` | `memory`, `integration-wiring` | [U] | implemented | not_evaluated | G3-B | 부분: fixated/briefly_crossed 생성. seen_in_scene은 스키마 허용만. |
| EVT-03 | 깜박임·유실 구간을 응시 시간에서 제외, 정책 버전 | `src/app.js`, `src/gaze/index.js` | `integration-wiring`, `gaze-unit` | [U] | implemented | not_evaluated | G3-B | 부분: 유실 구간 제외 시험 있음. 분할·재연결 정책 버전 기록 없음. |
| MEM-01 | 위치·외형·관계·시각·근거 프레임 연결 공간 기억 | `src/memory/index.js`, `src/runtime/perception.js` | `memory`, `perception` | [U], `perception-live` | tested | not_evaluated | G3-B |  |
| MEM-02 | 이벤트 원장 유지, 관련 이력 검색·계층 요약 | `src/memory/index.js` | `memory` | [U] | implemented | not_evaluated | G3-B | 부분: 원장·최근 20개 이력 검색. 계층 요약 없음. |
| MEM-03 | 요약 사실은 원본 event/observation ID로 추적 | `src/memory/index.js` | `memory` | [U] | tested | not_evaluated | G3-B |  |
| MEM-04 | 이동·상태 변경은 덮어쓰기 대신 버전 이력 | `src/memory/index.js`, `src/spatial/tracker.js` | `memory`, `tracker` | [U], `spatial-live` | tested | not_evaluated | G3-B |  |
| MEM-05 | 공간 관계 near/on/inside의 출처·유효 시간 | `src/memory/index.js` | `memory` | [U] | implemented | not_evaluated | G3-B | 부분: 관계 레코드·유효 구간 API만. 관계를 산출하는 로직 없음. |
| MEM-06 | 마지막 관찰·스침·재방문·관계 기반 검색 | `src/memory/index.js` | `memory` | [U] | implemented | not_evaluated | G3-B | 부분: lastSeen·glimpses·relationsAt. 재방문 검색·Recall@K 측정 도구 없음. |
| MEM-07 | 미관측 객체를 일반 지식으로 기억에 추가 금지 | `src/memory/index.js`, `src/runtime/perception.js` | `memory` | [U] | implemented | not_evaluated | G3-B | 구조적 제약(관측·근거 필수). 전용 시험 없음. |
| MEM-08 | 신뢰도·최종 관측 표시, 삭제·정정·세션 초기화 | `src/memory/index.js`, `src/memory/session.js`, `src/app.js` | `memory`, `memory-session` | [U] | implemented | not_evaluated | G3-B (+G3-A) | 부분: 삭제·정정·세션 삭제 구현. 기억 신뢰도 표시 없음. |
| MEM-09 | 관련 지식은 출처·검색시각·버전의 별도 레코드 | 없음 | 없음 | 없음 | planned | not_evaluated | G3-B | 구현 없음. |

## 9. 추론과 선제 준비 (INF, PRE)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| INF-01 | 추론 어댑터 입력: 후보·시선 이력·기억·변화·품질 | `server/reasoner-adapter.js`, `src/runtime/server-providers.js`, `src/memory/index.js` | `reasoner-adapter`, `reason-route`, `server-pipeline`, `perception` | [U], `reasoner-live-v2`, `reasoner-live-v4`, `perception-live`, `wonder-live` | tested | not_evaluated | G4-C (+G0-A) | SRS 20.8: Muse Wonder→`muse-spark-1.3`(사용자 승인). Wonder 비가용 증거 보존. |
| INF-02 | 가설·다음 시선·행동·잠재 질문·추천 분리 출력 | `server/reasoner-adapter.js`, `src/runtime/contracts.js` | `reasoner-adapter`, `runtime` | [U] | implemented | not_evaluated | G4-C (+G4-B) | 부분: scenarios+nextGaze만. 잠재 질문·추천 출력 없음. |
| INF-03 | 가설에 근거·반대 근거·마감·유효기간·보류 사유 | `src/runtime/contracts.js`, `src/runtime/facade.js`, `server/reasoner-adapter.js` | `runtime`, `runtime-facade`, `reasoner-adapter` | [U], `reasoner-live-v4` | tested | not_evaluated | G4-C | SRS 20.1 OPEN-04: 반대 근거는 있을 때만(없으면 빈 배열). |
| INF-04 | 사고 가설을 사실로 저장·단정 금지 | `server/reasoner-adapter.js`, `index.html` | `reasoner-adapter` | [U] | implemented | not_evaluated | G4-C |  |
| INF-05 | confidence는 model_score, 미보정 확률 표시 금지 | `src/runtime/contracts.js` | `runtime` | [U] | implemented | not_evaluated | G4-B | 확률·점수 필드를 표시하지 않음(optional_rank만). |
| INF-06 | 다음 시선에 outside_view/unknown, 행동 unknown 허용 | `server/reasoner-adapter.js`, `src/runtime/next-gaze.js` | `reasoner-adapter`, `provisional-next-gaze-route`, `background-attention` | [U], `next-gaze-spark-live`, `next-gaze-spark-live-v2` | tested | not_evaluated | G4-B | SRS 20.1: 행동 목록은 자유 생성. 첫 실호출 REASONER_INCOMPLETE 실패 보존. |
| INF-07 | 변화에 반응하되 최소 호출 간격·중복 억제 | `src/runtime/background-attention.js`, `server/provider-policy.js`, `src/runtime/cache.js` | `background-attention`, `provider-policy`, `frozen-demo` | [U] | tested | not_evaluated | G4-A (+G4-E) |  |
| INF-08 | 장면 텍스트·검색·기억은 데이터, 시스템 지시 아님 | `server/reasoner-adapter.js`, `src/runtime/contracts.js` | `runtime`, `reasoner-adapter` | [U] | tested | not_evaluated | G4-C | 구조적 경계. 프롬프트 주입 저항성 입증은 아님. |
| PRE-01 | 읽기 전용 기억 검색·조회·설명 초안만 사전 수행 | `src/runtime/facade.js`, `src/runtime/background-attention.js` | `runtime-facade`, `background-attention` | [U] | tested | not_evaluated | G4-C |  |
| PRE-02 | 캐시 유효성: session/map/object/evidence/관측/만료 | `src/runtime/cache.js`, `src/runtime/facade.js` | `runtime`, `core`, `background-attention` | [U] | tested | not_evaluated | G4-C (+G4-D) |  |
| PRE-03 | 객체 이동·철회·좌표계 변경 시 캐시 폐기 | `src/runtime/cache.js`, `src/runtime/perception.js`, `src/memory/index.js` | `runtime`, `perception`, `memory` | [U] | tested | not_evaluated | G4-C (+G4-D) |  |
| PRE-04 | 자동 구매·발송·로봇·계정 변경 등 외부 부작용 금지 | `src/runtime/facade.js`, `server/reasoner-adapter.js` | `runtime` | [U] | implemented | not_evaluated | G4-C | 외부 행동 능력 코드 없음(T22 시험은 blocked/범위 명시 수준). |
| PRE-05 | 기본 silent_ready, 시선 유지는 실행 동의 아님 | `src/runtime/facade.js`, `src/app.js` | `runtime-facade`, `preparation-display` | [U] | tested | not_evaluated | G4-D (+G4-C) |  |

## 11. 비동기 처리 (RT)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| RT-01 | 캡처·추적·렌더링은 API 대기와 독립 | `src/app.js`, `src/runtime/background-browser.js`, `src/gaze/webcam.js` | `background-browser`, `background-attention`, `gaze-webcam` | [U] | tested | not_evaluated | G4-A (+G1-A) | 30분 실운영 미실시. |
| RT-02 | 분석 큐 bounded/latest-only, 드롭 수 기록 | `src/runtime/scheduler.js`, `src/runtime/background-attention.js`, `src/app.js` | `runtime`, `background-attention` | [U] | tested | not_evaluated | G4-A (+G1-A) |  |
| RT-03 | 응답 도착 시 버전 검증, stale이 현재 상태 덮어쓰기 금지 | `src/runtime/facade.js`, `src/runtime/scheduler.js`, `src/runtime/background-browser.js` | `runtime`, `runtime-facade`, `background-browser` | [U] | tested | not_evaluated | G4-A (+G4-D) |  |
| RT-04 | 타임아웃·재시도·동시·분당 비용·429 backoff·circuit breaker | `server/provider-policy.js`, `src/runtime/scheduler.js` | `provider-policy`, `server-pipeline`, `runtime` | [U] | tested | not_evaluated | G4-A (+G4-E) | 비용 한도는 추정 예약액이며 청구 상한 아님. |
| RT-05 | 종료 후 응답은 활성 상태 복구 금지, event_id 중복 방지 | `src/runtime/facade.js`, `src/runtime/perception.js`, `src/memory/index.js` | `runtime-facade`, `core`, `memory` | [U] | tested | not_evaluated | G4-A (+G3-B) |  |

## 12. Bento UI (UI)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| UI-01 | 3D 장면+RGB/SAM/Depth/시선/동선 오버레이 독립 토글 | `index.html`, `src/app.js`, `src/spatial/scene-diagnostic.js`, `src/gaze/overlay.js` | `scene-diagnostic`, `gaze-overlay` | [U] | implemented | not_evaluated | G5-A | 부분: 토글은 고정 프레임 RGB/SAM/엔진 깊이만. 동선 오버레이 없음. |
| UI-02 | 양쪽 눈 확대 크롭으로 홍채 움직임 표시 | `index.html`, `src/gaze/webeyetrack-worker.js`, `src/gaze/index.js` | `webeyetrack-worker`, `gaze-unit`, `gaze-webcam` | [U] | tested | not_evaluated | G1-B (+G5-A) |  |
| UI-03 | 관찰 근거·후보·기억·예측·추천·상태 구분 | `index.html`, `src/app.js` | `preparation-display` | [U] | implemented | not_evaluated | G5-A | 부분: 추천 표시 없음. |
| UI-04 | tracking lost 등 상태 5종 명확 표시 | `src/app.js`, `index.html` | `preparation-display`, `gaze-unit`, `startup-diagnostic` | [U] | implemented | not_evaluated | G5-A | 부분. index.html 하단 `Depth 미구현` 라벨은 Depth Anything 연결 전 문구로 남아 있음. |
| UI-05 | 진단 상세에서 근거 시각·객체 ID·Depth 출처·품질 | `src/app.js`, `index.html` | 없음 | 없음 | implemented | not_evaluated | G5-A | 부분: 일부 필드만 표시. |
| UI-06 | 관찰 모드에서 진단 패널 숨기기 | `index.html`, `src/app.js` | 없음 | 없음 | implemented | not_evaluated | G5-A | `진단 숨기기` 버튼. 전용 시험 없음. |
| UI-07 | 시작·일시정지·정지·교정·삭제, 정지 시 수집·호출 중단 | `index.html`, `src/app.js`, `src/gaze/webcam.js` | `gaze-webcam`, `local-recorder`, `recording-route`, `integration-wiring`, `background-attention` | [U] | tested | not_evaluated | G5-A (+G1-A) |  |

## 14. 개인정보·운영 (SEC)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| SEC-01 | 원시 얼굴·눈 영상 지속 저장 기본 비활성 | `server/recording-store.js`, `src/gaze/local-recorder.js`, `server.js` | `recording-store`, `recording-route`, `local-recorder` | [U] | implemented | not_evaluated | G3-A | 충돌: DEMO_BRIEF_20261104(사용자 지시)로 시작 시 원본 웹캠 영상을 로컬 WebM 기록(세션 1GiB·전체 5GiB). SRS 문구와 불일치, 사용자 지시 우선. 외부 전송 없음. |
| SEC-02 | 눈 영상은 로컬 처리, 원격 전송은 별도 동의 | `server.js`, `src/runtime/server-providers.js`, `src/gaze/webcam.js`, `index.html` | `reason-route`, `sam-route`, `perception`, `gaze-webcam` | [U] | tested | not_evaluated | G3-A | SAM에는 가상 장면 이미지만, 카메라 영상은 미전송. |
| SEC-03 | API 키는 서버 환경에만, 번들·로그·산출물 제외 | `server.js`, `server/sam-adapter.js`, `server/reasoner-adapter.js` | `sam-route`, `reasoner-adapter`, `server-pipeline` | [U], `cto-verification`, `cto-verification-20261027` | tested | not_evaluated | G0-A | 10/27·10/29 자격 값 스캔 기록이 증거. 현재 커밋 재스캔 없음. |
| SEC-04 | 사용자별 기억 분리, 삭제 시 원본·요약·색인·캐시 제거·보고 | `src/memory/index.js`, `src/memory/session.js`, `server/recording-store.js` | `memory`, `memory-session`, `recording-store` | [U] | tested | not_evaluated | G3-B (+G3-A) | 부분: 단일 사용자 세션. 벡터 색인 없음. |
| SEC-05 | 민감 성격·질병 추론 비포함, 제3자 식별 기본 비제공 | `server/reasoner-adapter.js`, `index.html` | 없음 | 없음 | implemented | not_evaluated | G4-C | 설계상 비포함(프롬프트·고지). 시험 없음. |

## 20.1–20.4 보완 계약 (OPEN, SYNC, BUF, MAP, VALID, DEL, DATA)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| OPEN-01 | 얕고 열린 복수 행동 시나리오(사용자 확정) | `server/reasoner-adapter.js`, `src/runtime/contracts.js`, `src/runtime/facade.js` | `runtime`, `reasoner-adapter`, `runtime-facade` | [U], `reasoner-live-v2`, `reasoner-live-v4`, `perception-live` | tested | not_evaluated | G4-C | 합성 입력·소수 표본. 실제 행동 정확도 주장 불가. |
| OPEN-02 | 의미 해석·의도 추론을 직렬 게이트로 강제하지 않음 | `server/reasoner-adapter.js`, `src/runtime/server-providers.js` | `server-pipeline`, `reasoner-adapter` | [U] | tested | not_evaluated | G4-C | Spark 한 호출이 장면 해석+시나리오. Wonder→Spark 대체(20.8). |
| OPEN-03 | 최대 5개 짧은 시나리오, 0개 허용, 필드 계약 | `src/runtime/contracts.js`, `server/reasoner-adapter.js` | `runtime`, `reasoner-adapter` | [U], `reasoner-live` | tested | not_evaluated | G4-C |  |
| OPEN-04 | 병렬 후보, 의도 확정 금지, 새 관측으로 갱신 | `server/reasoner-adapter.js`, `src/runtime/background-attention.js` | `background-attention`, `reasoner-adapter` | [U] | implemented | not_evaluated | G4-C | 갱신 품질은 blind review 필요(G4-C). |
| SYNC-01 | 5종 시각 구분, display_uncertainty_ms 기록 | `src/app.js`, `src/runtime/clock.js`, `src/spatial/world.js` | `app-perception-wiring`, `timing-calibration`, `runtime`, `core` | [U] | tested | not_evaluated | G2-D | 미측정 표시 불확실성은 null로 보존. |
| SYNC-02 | 소스 클록 offset·drift·jump, 예산 초과 시 보류 | `src/runtime/clock.js`, `src/app.js` | `timing-calibration`, `runtime`, `core` | [U] | tested | not_evaluated | G2-D | SRS 20.2: 50ms는 총 정렬 오차 예산. 실제 광학 측정 기록 없음. |
| SYNC-03 | 캡처 당시 frame에 연결, pose 보간 제한 | `src/app.js`, `src/spatial/world.js`, `src/runtime/perception.js` | `app-perception-wiring`, `spatial`, `perception` | [U] | tested | not_evaluated | G2-D | pose 보간은 구현하지 않음(규정 준수). |
| BUF-01 | latest-only 큐와 증거 ring 분리, 10초/128MiB | `src/core.js`, `src/memory/index.js`, `src/runtime/scheduler.js` | `core`, `memory`, `app-perception-wiring` | [U] | tested | not_evaluated | G2-D | 압축·해상도 변경 기록은 확인하지 못함. |
| BUF-02 | 시선 이벤트 시 프레임·시선·pose·depth 참조 pin | `src/memory/index.js`, `src/core.js`, `src/app.js` | `memory`, `core`, `app-perception-wiring` | [U] | tested | not_evaluated | G2-D (+G3-B) | pin 대상은 프레임·시선 중심. 실제 100–500ms 이벤트 50건 미시험. |
| BUF-03 | pin 한도 100건/256MiB/60초, evidence_evicted 기록 | `src/memory/index.js`, `src/core.js` | `memory`, `core` | [U] | tested | not_evaluated | G2-D (+G3-B) |  |
| BUF-04 | 늦은 분석은 observed_at 유지, revision·supersedes로 정정 | `src/memory/index.js`, `src/spatial/tracker.js`, `src/runtime/perception.js` | `memory`, `perception`, `tracker` | [U] | tested | not_evaluated | G3-B |  |
| MAP-01 | gaze_hit_point/object_anchor/object_extent 분리 | `src/spatial/tracker.js`, `src/spatial/geometry.js` | `spatial`, `tracker` | [U] | implemented | not_evaluated | G3-B | SRS 20.3: point_world 대체. 부분: object_anchor_world는 항상 null, extent 없음. |
| MAP-02 | map correction과 object motion 분리 | `src/runtime/perception.js`, `src/memory/index.js` | `map-correction`, `perception`, `spatial`, `memory` | [U] | tested | not_evaluated | G3-B (+G2-D) |  |
| MAP-03 | 관계 유효 시간, 가림·시야 밖 구분, last_seen | `src/memory/index.js`, `src/spatial/tracker.js` | `memory`, `tracker` | [U] | implemented | not_evaluated | G3-B | 부분: visibilityState는 visible/unknown만. occluded/out_of_view 구분 없음. |
| MAP-04 | identity_status와 병합·분리 lineage, 취소 시 복구 | `src/spatial/tracker.js`, `src/memory/index.js` | `tracker`, `memory`, `mask-association` | [U], `spatial-live` | tested | not_evaluated | G3-B (+G2-D) |  |
| VALID-01 | context_version이 아닌 dependency_set으로 유효성 판단 | `src/runtime/cache.js`, `src/core.js`, `src/runtime/perception.js` | `runtime`, `core`, `perception`, `background-attention` | [U] | tested | not_evaluated | G4-C (+G4-D) |  |
| VALID-02 | 관련 이동·철회·정체 변경·좌표 변환 실패 시 무효화 | `src/runtime/cache.js`, `src/runtime/perception.js`, `src/memory/index.js` | `perception`, `memory`, `runtime` | [U] | tested | not_evaluated | G4-C (+G3-B) |  |
| DEL-01 | 진단 패널 표시 범위, silent_ready, 자동 알림 금지 | `src/app.js`, `src/runtime/facade.js`, `index.html` | `preparation-display`, `runtime-facade` | [U] | tested | not_evaluated | G5-A (+G4-D) |  |
| DATA-01 | causal_status(online_causal/offline_assisted/unknown) 기록 | `src/memory/index.js`, `src/aria/mps_csv.py`, `src/runtime/perception.js` | `aria-mps`, `memory`, `core` | [U], `aria-sample` | tested | blocked | G3-C | 샘플 MPS CSV만 offline_assisted로 검증. Pilot 데이터 미확보로 G3-C blocked. |
| DATA-02 | 엄격한 온라인 평가는 causal 검증 입력만 사용 | `src/core.js`, `src/memory/index.js`, `src/evaluation/comparison.js` | `core`, `memory`, `comparison` | [U] | tested | blocked | G3-C (+G5-D) | G3-C blocked 때문에 blocked 표기. 합성 시험은 통과. |

## 20.6 운영·저장·API (OPS, API)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| OPS-01 | 원시 얼굴/눈 저장 기본 off, 증거 세션 1GiB·종료 삭제, 보존 동의 | `src/memory/index.js`, `src/memory/session.js`, `server/recording-store.js` | `memory`, `memory-session`, `recording-store` | [U] | implemented | not_evaluated | G3-A (+G3-B) | 충돌: 원시 영상 로컬 기록은 SEC-01과 동일(사용자 지시). 부분: 증거·보존 동의는 구현. |
| OPS-02 | 장기 보존 총 2GiB, 삭제 전파, 증거 없는 요약 unverified | `src/memory/index.js` | `memory`, `memory-session` | [U] | implemented | not_evaluated | G3-B | 부분: 레코드 10,000·스냅샷 1GiB 한도. 총 2GiB 한도·unverified 표기 없음. |
| OPS-03 | 원자 저장·체크포인트·idempotency 복구, 외부 호출 중복 확인 | `src/memory/session.js`, `src/memory/index.js`, `src/runtime/provider-journal.js` | `memory-session`, `memory`, `provider-journal` | [U] | tested | not_evaluated | G3-B | 주입형 저장소 시험. 실제 브라우저 강제 종료 복구 미시험. |
| OPS-04 | 병합 취소·근거 삭제·정정을 요약·색인·캐시에 전파 | `src/memory/index.js`, `src/runtime/perception.js` | `memory`, `tracker-memory`, `perception` | [U] | implemented | not_evaluated | G3-B | 부분: 요약·캐시 전파 구현. 색인 없음, 부분 실패 이력은 제한적. |
| API-01 | G0 통합 명세: 모델·endpoint·schema·제한·비용·보존·라이선스 | `docs/sam-api-contract.md`, `docs/reasoner-api-contract.md`, `docs/g0-contract-audit.md` | 없음 | `cto-verification` | implemented | not_evaluated | G0-A | 문서. 계정 보존·SAM 고유 제한·라이선스 적용은 TBD로 남음. |
| API-02 | SAM·추론 모델 실요청 샘플·오류·지연 표본 | `server/sam-adapter.js`, `server/reasoner-adapter.js` | `sam-adapter`, `reasoner-adapter` | [U], `sam-live`, `reasoner-live-v2`, `reasoner-live-v3`, `reasoner-live-v4`, `perception-live` | tested | not_evaluated | G0-A | SRS 20.8: Wonder→`muse-spark-1.3`. 합성 입력·표본 소수. v3(502) 실패 보존. |
| API-03 | mock은 실연동 아님, 대체 모델은 사용자 승인 | `src/runtime/contracts.js`, `src/runtime/facade.js` | `runtime`, `runtime-facade` | [U], `wonder-live` | tested | not_evaluated | G0-A | Spark 대체는 2026-10-27 사용자 승인(SRS 20.8). |

## 15, 20.5 수용 시험 (T01–T22)

| ID | 요구 요약 | 구현 | 시험 | 증거 | 구현상태 | 평가상태 | Gate | 비고 |
|---|---|---|---|---|---|---|---|---|
| T01 | 독립 표적 좌표 오차·반전·창 변경 (EYE-04/06) | `src/gaze/index.js`, `src/gaze/overlay.js`, `src/gaze/persistence.js` | `gaze-unit`, `gaze-overlay`, `gaze-persistence`, `calibration-profile` | [U] | tested | not_evaluated | G1-F (+G1-E,G5-A) | DEMO_BRIEF: 평소 작업 거리(1.5m 고정 아님). 실사용자 9점×3회 미실시. |
| T02 | 알려진 3D 표면 투영/역투영 (GEO-02/04/05) | `src/spatial/geometry.js`, `src/spatial/world.js` | `spatial` | [U] | tested | not_evaluated | G2-B (+G1-D,G2-C,G0-B) | 엔진 단위 시험만. 렌더 픽셀-깊이 일치 미실측. |
| T03 | SAM 실호출 증거와 수동 라벨 IoU (OBJ-01/06) | `server/sam-adapter.js`, `src/spatial/tracker.js` | `sam-adapter`, `sam-route`, `tracker` | [U], `sam-live`, `sam-point-pipeline-live`, `sam-scene-pipeline-live` | tested | not_evaluated | G2-A | 합성 1장 IoU 증거만. 동적 장면·수동 라벨 평가 미실시. |
| T04 | 유사 객체·가림·재등장 ID switch (OBJ-04/05) | `src/spatial/tracker.js`, `src/spatial/mask-association.js` | `tracker`, `mask-association` | [U], `spatial-live` | tested | not_evaluated | G2-D (+G2-A) | 합성 4프레임 SAM 시퀀스만. |
| T05 | 스침·응시·유실 구분, 원장→근거 프레임 (EVT/MEM) | `src/memory/index.js`, `src/app.js` | `memory`, `integration-wiring` | [U] | tested | not_evaluated | G3-B |  |
| T06 | 객체 이동 후 과거 위치 보존 (MEM-04/PATH) | `src/memory/index.js`, `src/spatial/tracker.js` | `memory`, `tracker` | [U], `spatial-live` | tested | not_evaluated | G3-B |  |
| T07 | 마지막 관찰·스친 대상 검색 Recall@K (MEM-06) | `src/memory/index.js` | `memory` | [U] | implemented | not_evaluated | G3-B | Recall@K·시간/위치 오차 산출 도구 없음. |
| T08 | 장면만/현재 응시/전체 이력/공간 기억 비교 (INF) | `src/evaluation/comparison.js`, `src/evaluation/ledger.js`, `src/evaluation/runner.js`, `scripts/evaluate-comparison.mjs` | `comparison`, `evaluation-ledger`, `evaluation-runner` | [U] | tested | not_evaluated | G5-D (+G4-B,G4-C,G5-C) | 채점기 v1(9조건)만. 독립 공간 기억 조건 없음(감사 A02). 실제 비교 결과 없음. |
| T09 | 응답 역순·중복·타임아웃, stale 덮어쓰기 0 (RT) | `src/runtime/scheduler.js`, `src/runtime/facade.js`, `src/runtime/background-attention.js` | `runtime`, `runtime-facade`, `background-attention` | [U] | tested | not_evaluated | G4-A | 주입 시험. 30분·실제 API 미실시. |
| T10 | 객체 이동/삭제/map 변경 시 의존 캐시 무효화 100% (PRE) | `src/runtime/cache.js`, `src/runtime/perception.js` | `runtime`, `perception`, `core` | [U] | tested | not_evaluated | G4-C (+G4-A,G4-D) |  |
| T11 | 미래·정답·목표 채널 차단 자동 검사 (SCP-08) | `src/core.js`, `server/reasoner-adapter.js`, `src/evaluation/ledger.js` | `core`, `reasoner-adapter`, `evaluation-ledger`, `comparison` | [U] | tested | not_evaluated | G4-C (+G3-A,G3-B,G5-A) |  |
| T12 | 동의 거부·정지·삭제 후 캡처/전송/잔존 참조 (SEC) | `src/gaze/webcam.js`, `src/memory/session.js`, `server/recording-store.js` | `gaze-webcam`, `memory-session`, `recording-store`, `recording-route` | [U] | tested | not_evaluated | G3-A (+G4-C,G3-B,G5-A) | 실제 브라우저 권한·삭제 실기 미실시. |
| T13 | Aria 영상·시선·Depth·pose 정렬, 누락 필드 유지 (ARIA) | `src/aria/mps_csv.py`, `scripts/aria_verify_vrs.py`, `scripts/aria_verify_sample.py` | `aria-mps`, `test/aria-vrs-test.py` | [U], `aria-sample`, `docs/aria-linux-validation.md`, `artifacts/aria-kali-handoff.json` | implemented | blocked | G3-C | 공식 샘플 MPS CSV 변환만 검증. VRS SDK 실행 불가(sdk_unavailable)·Pilot 데이터 미확보. DEMO_BRIEF: Aria 장비는 필요 조건 아님. |
| T14 | 교정→관찰→SAM/Depth→기억→재등장 검색→예측→갱신 종단 | `src/app.js`, `src/runtime/background-browser.js` | 없음 | 없음 | implemented | not_evaluated | G5-B | 종단 시험 도구 없음. 구성 모듈만 존재. |
| T15 | clock drift·표시 지연 주입 시 보정 또는 보류 (SYNC) | `src/runtime/clock.js`, `src/app.js` | `timing-calibration`, `runtime`, `core` | [U] | tested | not_evaluated | G2-D | 합성 시계 시험. 광학 측정 없음. |
| T16 | 짧은 이벤트 pin, 원시각 유지, 퇴거 사유 (BUF) | `src/memory/index.js`, `src/core.js` | `memory`, `core`, `app-perception-wiring` | [U] | tested | not_evaluated | G2-D (+G3-B) |  |
| T17 | 지도 보정 가짜 이동 0건, 병합 취소 복구 (MAP) | `src/runtime/perception.js`, `src/spatial/tracker.js`, `src/memory/index.js` | `map-correction`, `memory`, `tracker`, `perception`, `spatial` | [U] | tested | not_evaluated | G3-B (+G4-C) |  |
| T18 | 무관 프레임 캐시 유지와 관련 변경 무효화 (VALID) | `src/runtime/cache.js`, `src/runtime/perception.js` | `runtime`, `perception`, `core`, `background-attention` | [U] | tested | not_evaluated | G4-C (+G3-B) |  |
| T19 | 자유 복수 시나리오·새 관측 갱신 (OPEN) | `server/reasoner-adapter.js`, `src/runtime/contracts.js` | `runtime`, `reasoner-adapter` | [U], `reasoner-live-v2`, `reasoner-live-v4`, `perception-live` | tested | not_evaluated | G4-C | Wonder→Spark(20.8). 독립 2인 blind review 필요(G4-C). |
| T20 | 강제 종료/재개 중복 이벤트 0, 삭제 근거의 파생 참조 0 (OPS) | `src/memory/session.js`, `src/runtime/provider-journal.js`, `src/memory/index.js` | `memory`, `memory-session`, `provider-journal` | [U] | tested | not_evaluated | G3-B (+G3-A,G3-C) | 주입형 저장소. 실제 IndexedDB 강제 종료 미시험. |
| T21 | causal/offline-assisted 분리, 미확인 산출물 온라인 사용 0 (DATA) | `src/core.js`, `src/memory/index.js`, `src/aria/mps_csv.py` | `core`, `memory`, `aria-mps` | [U], `aria-sample` | tested | blocked | G3-C (+G3-A,G3-B) | G3-C blocked(자료 미확보). |
| T22 | 실제 API 검증 또는 blocked, 진단 표시·외부 행동 미실행 (API/DEL) | `src/runtime/contracts.js`, `src/runtime/facade.js`, `server/sam-adapter.js`, `server/reasoner-adapter.js` | `runtime`, `runtime-facade`, `preparation-display`, `sam-adapter`, `reasoner-adapter` | [U], `sam-live`, `reasoner-live-v4`, `wonder-live` | tested | not_evaluated | G0-A (+G0-B,G0-C,G5-A,G5-C) | Wonder는 blocked(WONDER_MODEL_UNAVAILABLE)로 보존, Spark로 대체(20.8). |

## 대체·충돌·사용자 지시 기록

| 항목 | 내용 | 영향 요구/Gate |
|---|---|---|
| Wonder→Spark (SRS 20.8, 2026-10-27 사용자 승인) | 추론 백엔드를 Standard `muse-spark-1.3`으로 변경. Wonder는 `muse-wonder-1.0` 비가용(`wonder-live.json`, `WONDER_MODEL_UNAVAILABLE`)이며 접근이 확인됐다고 표시하지 않는다. SAM은 `sam-3.1` 유지. 모델 변경만으로 Gate 통과 불가 | INF-01, OPEN-02, API-02, API-03, T19, T22, G0-A, G4-A…E |
| 원본 영상 로컬 저장 vs SEC-01/OPS-01 | `DEMO_BRIEF_20261104`(2026-10-31 사용자 지시)가 로컬 학습·분석용 원본 저장을 허용. 현재 시작 시 웹캠 영상을 `data/recordings/`에 WebM chunk로 기록(세션 1GiB·전체 5GiB, Git 제외, 외부 전송 없음). SRS 문구(기본 비활성)와 불일치하며 사용자 지시를 따름. 동의 문구·삭제 UI 있음, export 없음 | SEC-01, OPS-01, SEC-02, G3-A, T12 |
| 20.1 OPEN-04 | INF-03 반대 근거는 있을 때만(없으면 빈 배열), INF-06 행동 목록은 자유 생성 결과 | INF-03, INF-06, T19 |
| 20.2 SYNC-02 | 50ms는 도착 시간차가 아닌 총 정렬 오차 예산 | SYNC-02, GEO-03, T15, G2-D |
| 20.3 MAP-01 | point_world를 gaze_hit_point_world / object_anchor_world / object_extent로 분리. anchor·extent는 아직 null/없음 | MAP-01, G3-B |
| 20.5 | G5 시험 범위가 T01–T22로 확대. 수치는 초기 공학 기본값이며 실행 전 설정 버전 동결 | G1-F, G2-C/D, G3-B, G5-C |
| DEMO_BRIEF 거리 조건 | 이전 1.5m ±0.5m 고정 폐기, 평소 노트북 작업 거리 | EYE-04, T01 |
| DEMO_BRIEF Aria | Aria 장비 없음·필요 조건 아님. 공개 자료 replay는 G3-C 별도 | T13, DATA-01/02, G3-C |
| DEMO_BRIEF 200ms | LLM 열린 추론 포함 200ms 이하 반응은 사용자 목표이며 SRS 수치가 아님. 달성 증거 없음 | G4-D, G4-E |
| 기존 258개 회귀 수치 | GATE_PLAN의 258은 원본 기록 없는 작성 당시 수치. 2026-11-01 재실행 313개 중 312 통과, 1 skip | [U] |
| 감사 A13 | 과거 문서의 "모델 없음/메모리 교정만"은 과거 기준일 서술. 이 표가 구현·평가 상태를 분리 기록 | 전체 |

## 구현이 전혀 없는 요구

- **MEM-09** — 관련 지식은 출처·검색시각·버전의 별도 레코드.
- 소스에 GNN·EGNN 코드가 없다. 따라서 Gate G0-C(GNN 준비)와 G1-G(temporal GNN)는 구현 없음이며 `blocked`(공개 가중치 미확인). 이들은 SRS v1.1 요구가 아니라 사용자·구현 계획 요구이다.
- 종단 시험 도구가 없는 요구: T14(G5-B), T07의 Recall@K 산출, G4-E 단계별 200ms 계측기.

## 핵심 기능 일부만 구현된 요구 (비고 `부분`)

- SCP-04: 관측·가설·다음 시선만 구분. 지식·추천 타입 없음.
- EYE-01: width/height/frameRate만 기록. 장치 ID 미기록(요약 내보내기는 카메라 ID 제외).
- EYE-07: degradedReason 경로와 환경 변경 감지만. 조도·안경 반사·머리 이동 악화 자동 검출 없음.
- GEO-02: 신뢰도 필드 없음.
- GEO-09: 유효 마스크·unavailable만. 유리·반사 검출 없음.
- OBJ-03: 개념 프롬프트와 마스크 분리. 별도 라벨 후보 필드 없음.
- PATH-01: 이벤트 원장 존재. 공간 위치 결합은 시간 정렬 보류 상태. 동선 뷰 없음.
- PATH-02: 프레임별 pose 보존. 별도 시점 동선 레코드·표시 없음.
- PATH-03: 관측·last_seen 이력. 불확실성 공분산 없음.
- PATH-04: 이미지 경계 변화는 observation_conflict로만 기록, 실제 3D 이동 단정 안 함.
- EVT-01: app.js에 150ms 고정 분류. 분산/속도 기준·설정 UI 없음.
- EVT-02: fixated/briefly_crossed 생성. seen_in_scene은 스키마 허용만.
- EVT-03: 유실 구간 제외 시험 있음. 분할·재연결 정책 버전 기록 없음.
- MEM-02: 원장·최근 20개 이력 검색. 계층 요약 없음.
- MEM-05: 관계 레코드·유효 구간 API만. 관계를 산출하는 로직 없음.
- MEM-06: lastSeen·glimpses·relationsAt. 재방문 검색·Recall@K 측정 도구 없음.
- MEM-08: 삭제·정정·세션 삭제 구현. 기억 신뢰도 표시 없음.
- INF-02: scenarios+nextGaze만. 잠재 질문·추천 출력 없음.
- UI-01: 토글은 고정 프레임 RGB/SAM/엔진 깊이만. 동선 오버레이 없음.
- UI-03: 추천 표시 없음.
- UI-04: 부분. index.html 하단 `Depth 미구현` 라벨은 Depth Anything 연결 전 문구로 남아 있음.
- UI-05: 일부 필드만 표시.
- SEC-04: 단일 사용자 세션. 벡터 색인 없음.
- MAP-01: object_anchor_world는 항상 null, extent 없음.
- MAP-03: visibilityState는 visible/unknown만. occluded/out_of_view 구분 없음.
- OPS-01: 증거·보존 동의는 구현.
- OPS-02: 레코드 10,000·스냅샷 1GiB 한도. 총 2GiB 한도·unverified 표기 없음.
- OPS-04: 요약·캐시 전파 구현. 색인 없음, 부분 실패 이력은 제한적.

## 작성 중 미커밋 파일 (상태 판정 제외)

2026-11-01 작성 시점에 다른 엔지니어가 추가·수정 중인 미커밋 파일(25개 신규, 8개 수정)은 커밋 및 CTO 검토 전이므로 위 구현상태 판정에 반영하지 않았다. 판정은 커밋된 소스 기준이다. 커밋되면 관련 Gate(G1-C/D/E/F, G2-A/B/C/D, G4-A, G5-D) 기록과 이 표를 갱신해야 한다.

신규(??): `docs/depth-evaluation.md`, `docs/gaze-accuracy-protocol.md`, `docs/live-attention-path.md`, `scripts/evaluate-comparison-v2.mjs`, `scripts/evaluate-depth.mjs`, `scripts/generate-comparison.mjs`, `src/evaluation/comparison-v2.js`, `src/evaluation/depth-metrics.js`, `src/evaluation/generator.js`, `src/evaluation/manifest.js`, `src/gaze/accuracy-protocol.js`, `src/gaze/accuracy-report.js`, `src/gaze/eye-fit.js`, `src/runtime/live-tracking.js`, `src/spatial/depth-artifact.js`, `src/spatial/world-depth-export.js`, `test/accuracy-protocol.test.js`, `test/accuracy-report.test.js`, `test/comparison-generator.test.js`, `test/depth-artifact.test.js`, `test/depth-metrics.test.js`, `test/evaluation-manifest.test.js`, `test/eye-fit.test.js`, `test/live-tracking.test.js`, `test/world-depth-export.test.js`

수정(M): `src/gaze/binocular-screen.js`, `src/gaze/eye-sphere.js`, `src/runtime/background-attention.js`, `src/runtime/background-browser.js`, `test/background-attention.test.js`, `test/background-browser.test.js`, `test/binocular-screen.test.js`, `test/eye-sphere.test.js`

## 실제 사람/하드웨어 증거가 필요한 요구

아래 요구는 합성·단위 시험으로는 평가할 수 없으며 실제 증거 전까지 `not_evaluated`(또는 `blocked`)로 남는다.

- **U — 실사용자·실제 웹캠/브라우저 조작** (41): SCP-06, EYE-01, EYE-02, EYE-03, EYE-04, EYE-05, EYE-06, EYE-07, EYE-08, EYE-09, PATH-01, EVT-01, EVT-02, EVT-03, MEM-06, INF-06, RT-01, RT-02, UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, SEC-01, SEC-02, SEC-04, BUF-02, OPS-01, OPS-03, T01, T05, T07, T08, T09, T12, T14, T16, T20, T22
- **A — 사람 주석·독립 blind review** (12): SCP-05, OBJ-03, OBJ-04, OBJ-05, OBJ-06, PATH-03, MEM-06, T03, T04, T07, T08, T19
- **H — 광학·장비 측정(포토다이오드/시간코드, 가속 하드웨어)** (5): SYNC-01, SYNC-02, SYNC-03, T14, T15
- **D — 외부 공개자료(Aria Pilot/VRS 등) 확보·실행** (4): DATA-01, DATA-02, T13, T21
- **P — 실제 공급자 호출·계정 확인** (20): OBJ-01, OBJ-02, OBJ-03, INF-01, INF-02, INF-03, INF-06, RT-04, SEC-03, OPEN-01, OPEN-02, OPEN-03, OPEN-04, API-01, API-02, T03, T08, T14, T19, T22

- 위 분류에 없는 요구(56): 합성 엔진·주입 시험으로 일차 검증이 가능한 항목이지만 평가상태는 모두 not_evaluated이다.

모든 Gate 판정 기록의 `reviewer`는 `pending_cto`이다. 실제 시험 후 판정 기록 갱신 방법은 [`evidence/gates/README.md`](evidence/gates/README.md).
