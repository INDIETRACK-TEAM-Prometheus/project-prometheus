# Gate 판정 기록 (`docs/evidence/gates/`)

세부 Gate G0-A … G5-D 26개마다 `<gateId>.json` 하나가 있다. 형식은 [GATE_PLAN_20261104.md](../../GATE_PLAN_20261104.md)의 판정 JSON 계약이며 요구 ID별 상태는 [REQUIREMENT_TRACE.md](../../REQUIREMENT_TRACE.md)에 있다. 현재 기록은 2026-11-01 문서 작성이며 어떤 Gate도 `passed`가 아니다. 판정 시험을 실행한 기록이 아니므로 `startedAtUtc`·`finishedAtUtc`·`metrics`는 비어 있다.

## 필드

정확히 아래 19개 필드만 허용한다(추가 필드는 검증기가 거부).

| 필드 | 규칙 |
|---|---|
| `gateId` | `G0-A`…`G5-G`. 파일명은 `<gateId>.json` |
| `requirementIds` | SRS 요구 ID 또는 T01–T22. 비어 있으면 안 됨 |
| `status` | `evaluationStatus`와 항상 같은 값 |
| `implementationStatus` | `planned` → `implemented` → `tested`. 구현 진행 상태이며 통과가 아님 |
| `evaluationStatus` | `not_evaluated` 미실행, `blocked` 외부 의존성, `failed` 실행 실패, `passed` |
| `commit` | 시험한 소스의 git 짧은 hash(소문자 hex 7–40자). 작업 트리는 clean이어야 한다 |
| `testKind` | 아래 표 |
| `environment`, `modelVersions` | 객체. OS·Node/Python·장치·해상도, 모델 ID·버전·체크포인트 hash 등 |
| `profileHash` | 교정 프로필·설정의 hash. 해당 없으면 `null` |
| `startedAtUtc`, `finishedAtUtc` | 판정 시험의 UTC(`...Z`). 둘 다 `null`이거나 둘 다 채움 |
| `metrics` | 실측값 객체. 없으면 `{}` |
| `thresholds`, `thresholdVersion` | 시험 전에 고정한 기준과 그 버전. 기준이 없으면 `{}`와 `null`(둘은 함께 비거나 함께 채움) |
| `evidencePaths` | 저장소에 실제 존재하는 파일의 저장소 루트 상대 경로만. 존재하지 않는 경로는 어떤 상태에서도 오류 |
| `failures` | 실패·미완료 사례 전부(성공만 고르지 않는다) |
| `limitations` | 범위·합성 여부·미측정 항목·동결 필요 사항 |
| `reviewer` | 판정자. 확정 전에는 `pending_cto` |

### `testKind`

- 통과 불가 계열(mock·단위·합성): `not_run`, `unit`, `synthetic`, `synthetic_model_smoke`, `synthetic_live_provider`. 합성 입력으로 실제 공급자를 호출한 기록(`synthetic_live_provider`)도 여기에 속한다.
- 통과 가능 계열: `real_provider`(실제 장면·계정·공급자 확인), `real_camera`, `real_user`, `real_hardware`, `public_dataset`, `mixed_real`.

## 실제 시험이 끝난 뒤 기록을 갱신하는 방법

1. **시험 전 고정.** 소스를 커밋하고 작업 트리를 clean으로 둔다. 기준값(threshold)과 표본 계획을 정해 `thresholds`·`thresholdVersion`을 먼저 커밋한다. 결과를 본 뒤 통과를 위해 기준·표적·분모를 바꾸지 않는다. 바꿔야 하면 이유를 `limitations`에 적고 새 `thresholdVersion`으로 새 시험을 실행한다. SRS 20.5 수치와 `GATE_PLAN`의 제안값은 초기 기본값이다. `{}`/`null`로 남은 Gate는 최종 holdout 전에 반드시 먼저 채워야 한다.
2. **실행하고 증거 저장.** 비식별 manifest·수치·명령·환경·hash·secret 제거 공급자 요약을 `docs/evidence/` 아래(예: `docs/evidence/demo-20261104/`)에 저장한다. 원본 영상·랜드마크·교정 원본은 Git 제외 로컬 폴더에 두고 manifest의 hash로만 참조한다. API 키나 환경 전체 dump는 넣지 않는다.
3. **기록 수정.**
   - `commit`, `testKind`(실제 입력이면 통과 가능 계열), `environment`, `modelVersions`, `profileHash`, `startedAtUtc`, `finishedAtUtc`를 실행 값으로 채운다.
   - `metrics`에 측정값(p50/p95·유효율·실패 수·드롭률·결과 age·비용 등)을 넣고 `evidencePaths`에 방금 생성한 파일 경로를 추가한다.
   - 실패·timeout·파싱 실패·예산 소진은 `failures`에 남긴다. 이전 합성 증거는 지우지 말고 `limitations`에 합성이라고 구분한다.
   - `implementationStatus`는 `tested`(자동 시험이 해당 범위를 덮을 때), `evaluationStatus`·`status`는 `passed`/`failed`/`blocked` 중 실제 결과로 같이 바꾼다.
   - `passed`로 바꾸려면 `testKind`가 통과 가능 계열이고, `implementationStatus`가 `tested`이며, `metrics`·`thresholds`·`thresholdVersion`·`evidencePaths`가 비어 있지 않고(경로는 모두 존재), 시각 둘이 있으며, `reviewer`가 `pending_cto`가 아닌 실제 판정자여야 한다. `blocked`는 이유를 `limitations`나 `failures`에, `failed`는 `failures`에 반드시 적는다.
4. **검증.** 다음을 실행해 통과해야 한다.
   ```sh
   node scripts/validate-gate-records.mjs
   node --test test/gate-records.test.js
   npm test
   ```
5. **연동 문서 갱신.** [REQUIREMENT_TRACE.md](../../REQUIREMENT_TRACE.md)의 해당 요구 행(구현·시험·증거·평가상태)과 [CTO_REVIEW.md](../../CTO_REVIEW.md) 판정 요약을 같은 변경에서 고친다. 코드·가중치·전처리·프로필이 바뀌면 영향받는 Gate를 다시 시험하고 기존 `passed`를 되돌린다.

## 사람·하드웨어가 필요한 Gate

사용자 교정·실제 웹캠(G1-A/B/E/F, G5-A/B), 광학 시간 측정(G2-D), 사람 주석·blind review(G2-A/D, G4-B/C, G5-D), 공개 Aria 자료(G3-C), 계정 확인이 필요한 공급자 조건(G0-A)은 `real_user`·`real_hardware`·`public_dataset`·`real_provider` 실제 증거 없이 `passed`가 될 수 없다. 사용자 1인 결과는 개인 파일럿이며 일반화 근거가 아니다. 현재 `blocked`는 G0-C·G1-G(공개 GNN 가중치 미확인)와 G3-C(Pilot 자료 미확보, VRS SDK 미실행)이다.
