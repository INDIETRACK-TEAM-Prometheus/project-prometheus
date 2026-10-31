# 오픈소스 채택 및 교체 결정 — 2026-11-01

사용자 요청: 동일 조건 비교 실험으로 품질 개선을 평가하고 부족한 모듈을 교체한다. 구현 담당 모델은 사용자 확인을 거친 GPT-6-Luna max다 (`gpt-5.6-luna`는 사용 가능 목록에 없음).

| 부분 | 결정 | 근거/한계 |
|---|---|---|
| 객체 대응 | pinned `munkres@2.1.1`의 전역 최적 할당 + 실제 SAM mask IoU를 선택 | greedy 단일 대응보다 전체 비용을 최소화할 수 있다. 모호한 경우 보류하며 실제 ID-switch 개선은 별도 데이터로 검증한다. ByteTrack을 설치했다고 주장하지 않는다. |
| 시선 안정화 | 현재 인과적 One-Euro 구현을 원 저자의 재귀식과 대조해 수정 | 고정 시선 jitter와 빠른 전환 lag를 함께 측정한다. 합성 benchmark는 실제 웹캠 오차 증거가 아니다. |
| 화면 좌표 교정 | 현재 개인별 affine 모델의 범위·선택 검증 보완 | 관측하지 않은 feature 영역에 무제한 외삽하지 않는다. 교정 정확도는 독립 실제 표적으로 시험한다. |
| 시선 기본 모델 | WebEyeTrack 유지, 새 pretrained 모델은 비교 대상으로 분리 | 현재 browser 경로와 재사용 가능. 논문 benchmark만으로 교체하지 않는다. 모델 provenance/이용 조건과 로컬 성능 재확인 필요. |
| metric 깊이 | 설치된 Depth Anything V2 Metric Hypersim Small 유지 | 실제 CPU smoke 존재. 엔진 기하와 구분, 실제 정확도/가속 성능은 미검증. |
| 시선 조건 LLM | GazeQwen을 외부 비교 후보로 선정, 서비스 기본 Spark는 유지 | 공개 checkpoint 경로 존재. V-JEPA+Qwen2.5-VL-7B 실행 자원과 별도 GPU 실측 필요. 동일 모델 ablation과 다른 모델 비교를 혼합하지 않는다. |
| temporal EGNN | 실제 가중치·학습·평가 준비 전 활성화 보류 | 구면점 30개 생성은 학습된 GNN이 아니다. Colab에서 모델 학습/재현 가능성을 검증한다. |

## Colab 설치 확인

공식 `google-colab-cli==0.7.5`를 `uv tool install google-colab-cli --python ...Python312/python.exe`로 사용자 도구 환경에 설치했다. `colab version`, `colab --help`, `colab status` 실행 확인. `status` 결과는 `No active sessions`다. 이는 계정 인증·GPU 할당·학습 실행 성공 증거가 아니다.

실행 파일: `C:\Users\ngoch\.local\bin\colab.exe`. 공식 README는 Linux/macOS만 지원한다고 안내한다. 이 Windows PC에서는 위 기본 명령까지 동작했으며 원격 세션은 별도 검증한다. 인증 토큰·META_API_KEY를 소스/로그/노트북에 복사하지 않는다. 현재 로컬 보관 원본 얼굴/눈 영상의 Colab 업로드는 수행하지 않았다.

## 참고

- https://github.com/havelessbemore/munkres (MIT, 정확한 설치 패키지 license 포함)
- https://github.com/ifzhang/ByteTrack (설계 비교용; 현재 채택 패키지가 아님)
- https://gery.casiez.net/1euro/ (원 저자의 One-Euro 구현/논문)
- https://github.com/RedForestAI/WebEyeTrack
- https://github.com/phamtrongthang123/gazeqwen
- https://github.com/daeunni/StreamGaze (평가 문제 구성 참고)
- https://github.com/googlecolab/google-colab-cli

이 문서는 선택 근거이며 사용자 실제 성능 향상 판정서가 아니다. 비교 프로토콜·고정 입력·holdout 결과가 확보된 항목만 quality Gate를 갱신한다.
