# Aria 검증 — SSH 없는 Kali 실행

이 폴더를 Kali 랩탑으로 USB 또는 공유 폴더를 통해 옮기고 압축을 풉니다. 원본은 Meta 공식 Gen 2 공개 샘플이며 Pilot Dataset은 아닙니다. 개인 웹캠 영상이나 Meta API 키는 포함하지 않습니다. Kali의 SDK 호환성은 아직 검증하지 않았습니다.

압축을 푼 폴더에서 실행합니다. SDK 설치 시 인터넷 연결이 필요합니다.

```bash
python3 --version
ldd --version | head -n 1
python3 -m venv .venv-aria
.venv-aria/bin/python -m pip install 'projectaria-tools==2.3.0'
.venv-aria/bin/python scripts/aria_verify_vrs.py data/aria/aria_gen2_sample_data_1.vrs --mps-csv data/aria/closed_loop_trajectory.csv --output aria-vrs-summary.json
```

`venv`가 없다는 오류가 나면 Kali의 `python3-venv` 패키지가 필요합니다. 설치가 실패하면 임의 SDK나 모델로 대체하지 말고 실패 내용을 확인합니다. 정상 검증 종료 코드도 `partial`/`blocked`일 수 있으며 원인은 JSON에 기록됩니다.

검증 후 **`aria-vrs-summary.json`만 Windows로 가져옵니다.** 이미지·음성 원본이나 개인키·비밀번호는 전달하지 않습니다. 이 결과는 샘플의 스트림·RGB 디코딩·시선·보정 유무를 확인하며, 정확도·시간 정렬·Pilot 호환·G3 통과를 자동으로 입증하지 않습니다.

`manifest.json`은 파일 hash와 크기를 기록합니다. VRS SHA-256은 `52e78d73dfc12b1d551292e0598b2babc7851c83297ebaab318686fb372f5c7f`여야 합니다. SDK 검증 스크립트도 이를 검사합니다.

공식 출처: https://www.projectaria.com/async/sample/download/?bucket=core&filename=aria_gen2_sample_data_1.vrs

SDK 플랫폼 안내: https://facebookresearch.github.io/projectaria_tools/gen2/research-tools/projectariatools/installation
