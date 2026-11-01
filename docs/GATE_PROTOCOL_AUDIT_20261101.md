# Gate·비교 프로토콜 누락 감사 — 2026-11-01

대상: SRS v1.1 §15–20, `GATE_PLAN_20261104.md`, `COMPARISON_PROTOCOL.md`, 상세 구현 계획 및 현재 호출 경로. 기준 코드: `aea86df`. 이 문서는 수용 조건 보완이며 실행 결과나 Gate 통과 증거가 아니다.

## 1. 판단

Depth Anything, 양안 각 30개 이상 구면점·법선, 독립 시선 시험, 지속 추론, 신규 LLM 포함 200ms는 이미 명세에 있다. 누락은 **명세 자체**, **수치·실험 정의**, **구현 연결**, **실측 증거**를 구분해야 한다. 기존 표의 `not_evaluated`는 구현이 전혀 없다는 뜻도, 시험만 남았다는 뜻도 아니다.

| ID / 우선순위 | 현재 공백과 근거 | 추가해야 하는 수용 조건 / 담당 Gate |
|---|---|---|
| A01 / P0 | SRS §20.5의 객체 precision/coverage와 기억 Recall 목표가 세부 Gate에 직접 연결되지 않음 | 객체 연결 precision ≥90%, coverage ≥60%, 동적 3장면·주석 ≥100사건. 최소 객체 폭 ≥ 측정 p95 오차 지름의 2배 조건과 작은 객체 별도 결과. glimpse 100–500ms 50건·Recall@3 ≥80% 목표, 이동/가림/재등장 각20·기억 Recall@3 ≥90%. G2-C/D, G3-B에 원문 기준 연결 |
| A02 / P0 | T08의 공간 기억 독립 비교가 9조건에 없음. history/proactive를 공간 기억으로 볼 수 없음 | 동일 과거 관측에 대해 시간 이력만 vs 좌표·객체 상태 버전·관계·검색을 추가한 공간 기억 비교. 이동/재등장/마지막 위치 과제. G3-B/G5-D |
| A03 / P0 | `background-browser.js`는 실제 SAM mask를 bounds로 축약하고 프레임마다 후보 ID 생성 | 동일 면적·해상도 bbox crop vs 실제 foreground mask 입력 비교, 전체 장면 공통 유지. 실제 mask digest와 prompt 입력 추적. 현재 객체 밖의 다음 후보, 지속 ID, split/merge/가림/재등장 검증. G2-A/D, G4-B, G5-D |
| A04 / P0 | `comparison.js`는 제공된 예측을 채점함. 파일 hash·prompt 내용·정답 격리·실제 호출을 확인하는 생성기는 없음 | 입력 준비→실제 호출→원 응답→파싱→채점의 재현 가능한 runner와 artifact 검증. 실패·timeout·파싱 실패·예산 소진도 사전 등록 결정 분모에 유지. G5-D |
| A05 / P0 | 프로토콜은 단일 `nextTargetLabel`; 1/3/5초 정의·행동/주시 구분·선행 성공률 분모가 불완전 | 다음 응시 시작과 다음 상호작용을 별도 endpoint로 정의. horizon별 사건/무사건/유실/세션 끝 검열을 구분. 미래 사건 전에 발행·가용해진 예측만 선행 성공. G4-B/E, G5-D |
| A06 / P0 | 시선 오류/후보 누락/추론 오류가 최종 정확도 하나에 섞일 수 있음 | 독립 표적 기반 시선 품질, 후보 recall, 후보가 있을 때 추론 정확도, 종단 정확도를 함께 보고. oracle gaze/mask/depth는 원인 진단 실험으로 분리. G1-F, G2-C, G4-B |
| A07 / P1 | Depth Anything 상세 프로토콜은 존재하나 깊이 평가기·foreground 통계·실시간 LLM 연결은 없음. `src/app.js`는 깊이 표시를 별도 요청 | 동일 프레임 map/mask/카메라로 깊이·XYZ 오차 및 reasoning 이득을 각각 측정. 실제 LLM 입력 depth artifact 확인. 지연·시점 어긋남·경계/소물체 실패 포함. G0-B, G2-B/C, G5-D |
| A08 / P1 | 법선·양안·EGNN 계약은 있으나 생성 구면점의 수치 검사가 영상 정합·물리 정확도를 보장하지 않음 | 개인별 구면/회전 fit, K·왜곡·화면 물리 치수·kappa·좌표계, 재투영 오차와 독립 2D/3D 오차, 가림·평행 광선·불확실도 전파. 실제 가중치와 2D baseline→geometry→GNN ablation. G1-C/D/G |
| A09 / P1 | ‘LLM 정보 해상도’에 정량 endpoint 없음 | 객체 구별, 부분/속성, 공간 관계, 과거 상태, 다음 사건을 주석. 맞는 근거 있는 세부 주장 수와 모순 주장률을 출력 토큰/픽셀/비용 예산과 함께 측정. 답변 길이를 개선으로 세지 않음. G4-C, G5-D |
| A10 / P1 | Brier 일부 지원, ECE·coverage-risk·잘못된 준비율·유용한 캐시 적중률 미구현 | 실제 확률 출력에만 사전 고정 bin의 ECE/Brier; 자유 가설에 임의 확률 강요 안 함. 예측 실패·보류 포함 coverage-risk, 분당 잘못된 준비/중복 갱신, 정확하고 유효한 사전 준비율. G4-B/C/D |
| A11 / P1 | session bootstrap은 있으나 표본 규모·primary contrast·최소 실용 개선·비열등 한계 미정 | 파일럿에서 결정하고 최종 holdout 전에 고정. 세션/장면 수준 표본 계획, 순서 무작위화, 동일 모델 반복·온도·seed 지원 여부, 다중 비교 정책. G5-D |
| A12 / P1 | 30분·200ms는 있으나 새 유효 결과 빈도/age·deadline 누락·자원 경쟁 기준 미정 | 시선/SAM/depth/LLM별 유효 Hz, p95/max age, deadline 충족률, cold/warm, 카메라+기록+모델 동시 CPU/GPU/RAM 사용·재시작·네트워크 복구. 200ms는 캐시/신규 완료 별도. G1-A, G4-A/D/E, G5-B |
| A13 / P1 | 과거 계획의 ‘모델 없음/메모리 교정만’ 설명과 현재 부분 구현이 혼재 | 문서의 과거 기준일 명시. Gate별 implementation/evaluation 상태와 증거를 별도 기록. 코드·가중치·전처리·프로필 변경 시 영향 Gate 재시험. G5-C/D |
| A14 / P1 | T01–T22→Gate 매핑은 있으나 개별 SRS 요구 ID→구현→시험→증거 연결은 미완료 | EYE/GEO/OBJ/MEM/SYNC 등 각 요구 ID의 상태·대상 Gate·실제 증거 경로를 기록. 개정/사용자 지시로 대체된 항목도 이유를 남김. G5-C |

## 2. 기술 기준점의 역할

2026-11-01 공식 자료 확인. 발표 점수를 이 장치의 수용 수치로 복사하지 않는다. 비교 시 URL, 조회일, 코드 commit, 가중치 hash, 라이선스, 입력·라벨·평가 split을 고정한다.

| 기준점 | 차용할 평가 관점 | 비교에서 지켜야 할 범위 |
|---|---|---|
| [StreamGaze](https://github.com/daeunni/StreamGaze) | 과거 기억·현재 객체/속성·미래/선행 과제 | 공개 benchmark 재현과 우리의 개인 웹캠 종단 시험을 별도로 보고. 데이터셋 점수가 웹캠 성능은 아님 |
| [GazeQwen](https://github.com/phamtrongthang123/gazeqwen) | 시선 조건 video QA 모델 baseline | 동일 정보·질의·시간 범위에서 외부 모델 비교. Qwen 계열과 Spark 차이를 SAM 효과로 해석하지 않음 |
| [EMC-Gaze](https://arxiv.org/html/2603.12388) | 눈 중심 landmark graph, 세션 교정, 독립 세션 평가 | 저자 모델 재현/실제 학습 가중치와 우리 구면 모델을 구별. 합성 법선만으로 논문 성능 달성 주장 불가 |
| [Depth Anything V2 metric](https://github.com/DepthAnything/Depth-Anything-V2/tree/main/metric_depth) | metric checkpoint와 깊이 출력 계약 | 상대 깊이/엔진 깊이와 구별. 깊이 오차와 attention 추론 이득을 별도 평가 |

최신 논문 후보 목록 자체는 SOTA 우월성 증거가 아니다. 비교 모델의 동일 조건 실행이 없으면 결과는 ‘자체 baseline 대비’로만 보고한다.

## 3. 시험 전에 고정할 계약

아래는 추가 요구이며 아직 실행·채점 구현이 완료되지 않았다. `comparison` v1은 정확히 9조건과 기존 필드만 받는다. 추가 실험은 별도 versioned sidecar/report 또는 검증된 schema v2로 구현하고, v1 지원으로 표기하지 않는다.

### 입력·인과성·정답

- 모든 조건은 동일 사전 등록 decision ID와 관측 cutoff를 사용한다. RGB, gaze, mask, depth, history, memory의 원 artifact를 재해시하고 실제 prompt에 들어간 내용·변환 버전을 검증한다. 식별자는 중립 ID로 두고 정답 객체 이름·미래 scene graph·목표 스크립트가 모델에 누출되지 않게 한다.
- 원 예측은 미래 라벨 생성/결합 전에 append-only 원장에 `issued/available/rendered` 시각과 hash로 보존한다. 사후 주석은 별도 권한/경로에서 결합한다. timestamp 필드만 적었다고 인과성이 증명되는 것은 아니다.
- 다음 응시: fixation의 최소 지속시간, 경계 처리, 현재 객체 유지/이탈, horizon 내 첫 전환인지 horizon 시점 대상인지 하나로 고정한다. 1/3/5초 결과를 섞지 않는다. gaze ground truth를 평가 대상 추정기의 출력으로 만들지 않는다. 독립 센서 없는 자유 관찰의 실제 응시 정답은 unavailable로 남기고 알려진 표적 과제와 구분한다.
- 다음 행동: 사용자 입력/독립 영상 주석으로 확인되는 사건만 정답으로 삼는다. ‘물체를 봄’을 ‘집음’의 정답으로 쓰지 않는다. 무사건은 유실과 별도 범주, 세션 말미 검열은 사전 규칙으로 제외 수를 보고한다.
- 선행 성공률 분모는 모든 적격 사건/결정이다. 정답이 맞은 응답만의 lead time과 별도로 deadline 이전 정확도·coverage를 보고한다. 이미 일어난 사건 뒤에 도착한 정답은 선행 성공 0이다.

### 효과 분리

- SAM 실험: scene 공통 + 동일 crop의 bbox vs foreground mask, 경계만 제공 vs 실제 마스크, 실제 SAM vs oracle mask를 각각 구분한다. 모든 조건의 이미지 크기·출력 예산·질의는 고정하고 실제 토큰 사용도 보고한다.
- 공간 기억: 전체 시간 이력 조건에 좌표/관계/객체 버전 검색만 추가한다. 현재 장면에서 보이지 않는 객체·이동 전후 위치를 포함한다. 같은 과거 정보·조회 cutoff를 사용한다.
- depth/history/proactive 세 요소의 상호작용을 주장하려면 기존 5개 조합에 depth+history, depth+proactive, history+proactive를 더한 2³ 실험이 필요하다. 기존 9조건만으로 상호작용을 추정했다고 보고하지 않는다.
- gaze baseline은 현재 객체 유지, 과거 전환 빈도/Markov 등의 단순 causal 예측을 포함한다. 현재 객체를 그대로 답한 예측도 사전 정의에 따라 평가하되, 새 객체 전환에서 별도 성능을 보고한다.
- 상시 추론의 효과는 같은 정보·모델·허용 비용에서 reactive와 proactive를 비교한다. 준비 비용·폐기 비용까지 합산하고 prepare hit, useful hit, wrong preparation, 실제 관측→표시 시간을 기록한다.
- 열린 가설 품질 통과에는 기존 프로토콜의 독립 2인 blind review 원본과 사전 동결한 품질 기준이 필요하다. 구조화 응답/근거 ID 존재만 확인한 경우 기능 시험으로 제한한다. 1인 평가만 있으면 독립 품질 비교는 `not_assessed`로 유지한다.
- 안구/시선: 중앙뿐 아니라 가장자리, raw/보정/필터 출력 각각의 축별 gain·offset·jitter·전환 lag·유효율, 좁은 눈 개방/깜박임/조명/안경/일상 거리 조건을 기록한다. 1인 결과를 인종 집단 성능으로 일반화하지 않는다. 새로고침·다음 세션 복원 후 독립 표적 평가를 반복한다.

### 수용 수치·통계

SRS §20.5 수치는 그대로 적용한다. 추가 항목은 임의의 최신 논문 숫자로 채우지 않고 개발 파일럿에서 동결한다. 새 실험 manifest에는 최소한 `primaryEndpoint, primaryContrast, practicalDelta, noninferiorityMargins, coverageFloor, deadlineMs, maxResultAgeMs, samplePlan, stoppingRule, exclusionRules, multiplicityPolicy, annotationPolicy, thresholdVersion`을 채운다. 이는 sidecar 계약이며 기존 v1 필드가 아니다.

고정이 필요한 수치: depth MAE/AbsRel/valid coverage, gaze gain/jitter/lag, 후보 recall·ID switch, 다음 대상 최소 개선, 근거 없는 주장 허용 한계, 유효 갱신 Hz/age, 자원 상한, ECE bin과 최소 표본. 설정 미완료이면 실행 준비 미완료이며, 결과를 본 뒤 완화해 passed로 바꾸지 않는다.

개선 주장에는 사전 지정 주 endpoint의 paired 효과와 세션 단위 95% 구간을 제시한다. practicalDelta를 넘는 하한, 사전 비열등 한계 및 coverage를 함께 만족하는지 판정한다. 검정력이 부족하면 ‘개선 미입증’으로 기록한다. 여러 확인적 비교에는 사전 지정 다중 비교 보정, 나머지는 탐색적으로 표시한다. 최소 2세션이라는 bootstrap 계산 조건은 충분한 실험 규모가 아니다. 긴 세션의 프레임 수를 독립 표본 수로 세지 않는다.

### 시간·geometry·운영

- SRS의 총 정렬 예산 50ms 제안은 capture/render/presentation/clock 불확실도를 포함한다. callback timestamp만으로 물리 정렬 통과 불가. gaze 오차와 정렬 오차가 mask 경계 hit 및 XYZ에 미치는 영향을 주입 시험한다.
- 양안 closest-ray 거리/수렴각과 depth 불확실도를 보고한다. 노트북 거리에서 거의 평행한 광선으로 얻은 불안정 depth를 평균만 내어 정상으로 만들지 않는다. 검출 불가·모델 prior·실측을 구분한다.
- foreground/background 탭·기기 sleep·camera track 종료·worker crash·429/timeout·모델 지연·저장 quota 및 crash recovery를 종단으로 시험한다. 탭 제한 중 무조건 동일 Hz를 주장하지 말고 상태와 재개 누락을 기록한다.
- 로컬 원본 기록은 얼굴 영상 외 눈 crop/landmark/프로필/표적/추론 연결을 검증한다. export/delete가 원본·색인·캐시·파생 참조에 반영되는지 확인한다. 기존 Start 통합 승인과 원본 로컬 저장 승인을 유지한다.

## 4. 처리 순서와 판정

1. P0: SRS 수치/공간 기억 매핑, 실험 manifest와 정답 정의, 실제 예측 생성·원장·검증기.
2. P0: live 경로의 실제 mask·지속 후보 ID와 gaze/candidate/reasoning 오류 분리, 선행 deadline 평가.
3. P1: Depth Anything map/통계/LLM 연결과 품질 평가, 양안 fitting·GNN 검증, 정보 해상도·통계·운영 계측.
4. 같은 commit/model/profile의 실제 카메라·공급자·30분 증거를 Gate에 연결한다.

이번 감사는 문서와 소스 경로 대조 및 공식 자료 확인이다. 실제 카메라, provider, GPU, 사용자 holdout을 새로 실행하지 않았으며 어떤 Gate도 승격하지 않는다.
