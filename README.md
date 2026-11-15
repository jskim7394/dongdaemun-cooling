# 동대문구 소화전 연계 쿨링 보행축 운전 현황

CRP2340 환경계획 2조 BWA3 대시보드입니다. 화면은 두 가지로 나뉩니다.

- **실시간 S-DoT**: GitHub Actions가 매시간 서울시 S-DoT API를 호출해 `data/realtime.json`을 갱신하고, 대시보드는 이 파일만 읽습니다.
- **2026년 여름 재생**: `data/replay.json`에 담긴 여름 자료를 시간대별로 재생합니다.

인증키는 GitHub Secrets에만 저장되며, 사이트 코드나 공개 파일에는 들어가지 않습니다.

## 폴더 구성

```
index.html                     대시보드
assets/app.js, style.css       화면 로직과 스타일
assets/vendor/                 Leaflet, Chart.js (외부 CDN 의존 없음)
data/segments.json             보행축 30개 구간 (유형 A~D)
data/sensors.json              동대문구 S-DoT 30대 위치
data/shades.json               그늘막 위치
data/hydrants.json             보행축 인근 소화전
data/replay.json               여름 재생 자료
data/realtime.json             Actions가 자동 갱신 (직접 수정하지 않음)
scripts/fetch_sdot.py          실시간 수집 스크립트
scripts/build_replay.py        여름 CSV → replay.json 변환
.github/workflows/fetch-sdot.yml  매시간 실행 설정
```

## 설정 순서

1. **저장소 만들기**: GitHub에서 `dongdaemun-cooling` 저장소를 Public으로 만듭니다.
2. **파일 올리기**: 이 폴더의 내용을 모두 올립니다. `.github` 폴더는 숨김 폴더라 빠지기 쉬우니, 올린 뒤 저장소에 `.github/workflows/fetch-sdot.yml`이 있는지 꼭 확인합니다.
3. **Pages 켜기**: Settings → Pages → Source를 `Deploy from a branch`, Branch를 `main` / `(root)`로 저장합니다. 몇 분 뒤 `https://<아이디>.github.io/dongdaemun-cooling/`에서 열립니다.
4. **인증키 등록**: Settings → Secrets and variables → Actions → **Secrets** 탭 → New repository secret
   - Name: `SEOUL_API_KEY`
   - Secret: 열린데이터광장에서 받은 인증키
5. **서비스명 등록**: 같은 화면의 **Variables** 탭 → New repository variable
   - Name: `SDOT_SERVICE`
   - Value: 열린데이터광장 "S-DoT 환경정보(실시간)"(OA-22833) 페이지의 Open API 탭 샘플 URL에서 `/json/` 다음에 오는 영문 서비스명
6. **쓰기 권한 허용**: Settings → Actions → General → Workflow permissions를 `Read and write permissions`로 바꿉니다.
7. **첫 실행**: Actions 탭 → `S-DoT 실시간 수집` → `Run workflow`. 로그에 `감지한 필드`와 `완료` 줄이 나오면 성공입니다. 이후에는 매시 17분에 자동으로 실행됩니다.

## 여름 재생 자료 바꾸기

현재 `replay.json`은 팀이 산출한 기상청 ASOS 기반 2일치(8월 6일, 7월 31일)입니다. S-DoT 여름 CSV(OA-15969 파일 내려받기)로 바꾸려면 저장소 폴더에서 다음을 실행하고, 바뀐 `data/replay.json`을 올립니다.

```
python scripts/build_replay.py 내려받은파일.csv --start 2026-07-01 --end 2026-08-31
```

센서별 시간 평균값을 저장하므로 지도에서 구간마다 다른 값이 표시됩니다. -30℃ 이하 단선 코드와 범위를 벗어난 습도는 자동으로 제외합니다.

## 주의

- 인증키를 코드, 커밋 메시지, 이슈, 채팅에 붙이지 마세요. 노출되면 열린데이터광장에서 재발급합니다.
- GitHub 예약 실행은 몇 분씩 늦어질 수 있고, 저장소에 60일 동안 활동이 없으면 자동으로 멈춥니다.
- 지도 구간(`segments.json`)과 보도 폭은 기존 대시보드 파일에서 옮겨온 값입니다. 실제 노선·실측값과 다르면 이 파일만 고치면 됩니다.
- 화면의 저감 효과는 추정치입니다. 증발 효율(그늘 0.34, 노출 0.27)과 주기 운전 비율(10/15)은 `assets/app.js` 맨 위에서 바꿀 수 있습니다.
