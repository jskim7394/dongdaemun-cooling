# 동대문구 소화전 연계 쿨링 보행축 운전 현황

CRP2340 환경계획 2조 BWA3 대시보드입니다.

- **실시간**: GitHub Actions가 매시간 서울시 S-DoT API와 기상청 단기예보 API를 호출해 `data/realtime.json`, `data/kma.json`을 갱신하고, 사이트는 이 파일만 읽습니다.
- **2026년 여름 재생**: `data/replay.json`(S-DoT 7~8월 센서별 시간 평균 + 기상청 서울 ASOS)을 시간대별로 재생합니다.
- **3D 비교(`3d.html`)**: 같은 시각을 왼쪽(현재, 미가동)과 오른쪽(시스템 가동)으로 나란히 보여 줍니다. 경험식 기반 시각화이며 CFD 해석이 아닙니다.

인증키는 GitHub Secrets에만 저장되며, 사이트 코드나 공개 파일에는 들어가지 않습니다.

## 폴더 구성

```
index.html                      대시보드
3d.html                         3D 비교 화면
assets/model.js                 운전 규칙·저감 산식·물 사용량 가정 (두 화면 공통)
assets/app.js, style.css        대시보드 로직과 스타일
assets/compare3d.js, .css       3D 비교 로직과 스타일
assets/vendor/                  Leaflet, Chart.js, deck.gl (외부 CDN 의존 없음)
data/segments.json              보행축 30개 구간 (유형 A / B·C 미확정 / D)
data/sensors.json               동대문구 S-DoT 30대 위치
data/shades.json                그늘막 위치
data/hydrants.json              동대문구 소화전
data/trees.json                 동대문구 가로수 (2026 서울시 가로수 위치정보)
data/buildings_near.json        보행축 260m 안 건물 (국토부 GIS건물통합정보, 3D용)
data/population.json            250m 격자 생활인구
data/boundary.json              동대문구 경계 (southkorea/seoul-maps, 지도 바깥 가림용)
data/replay.json                여름 재생 자료
data/realtime.json, kma.json    Actions가 자동 갱신 (직접 수정하지 않음)
scripts/fetch_sdot.py           S-DoT 실시간 수집
scripts/fetch_kma.py            기상청 초단기실황·초단기예보·단기예보 수집 (격자 61, 127)
.github/workflows/fetch-sdot.yml  매시간 실행 설정
```

## 설정 순서

1. **저장소 만들기**: GitHub에서 `dongdaemun-cooling` 저장소를 Public으로 만듭니다.
2. **파일 올리기**: 이 폴더의 내용을 모두 올립니다. `.github` 폴더는 숨김 폴더라 빠지기 쉬우니, 올린 뒤 저장소에 `.github/workflows/fetch-sdot.yml`이 있는지 꼭 확인합니다.
3. **Pages 켜기**: Settings → Pages → Source를 `Deploy from a branch`, Branch를 `main` / `(root)`로 저장합니다.
4. **인증키 등록**: Settings → Secrets and variables → Actions → **Secrets** 탭
   - `SEOUL_API_KEY`: 열린데이터광장 인증키
   - `KMA_API_KEY`: 공공데이터포털 기상청_단기예보 조회서비스 인증키 (Decoding 키 권장, Encoding 키도 동작)
5. **서비스명 등록**: **Variables** 탭 → `SDOT_SERVICE` = `IotVdata017`
6. **쓰기 권한 허용**: Settings → Actions → General → Workflow permissions를 `Read and write permissions`로 바꿉니다.
7. **첫 실행**: Actions 탭 → `실시간 자료 수집 (S-DoT · 기상청)` → `Run workflow`. 이후 매시 17분에 자동 실행됩니다. S-DoT과 기상청 단계는 서로 독립이라 한쪽이 실패해도 다른 쪽은 저장됩니다.

## 배경지도

OpenStreetMap 표준 타일을 씁니다. 키가 필요 없고 19단계까지 확대됩니다. 사이트를 고친 뒤에도 예전 지도가 보이면 브라우저 캐시 때문이므로 `Ctrl + Shift + R`로 새로고침합니다(스크립트 주소 끝의 `?v=` 값을 바꾸면 모든 방문자가 새 파일을 받습니다).

## 주의

- 인증키를 코드, 커밋 메시지, 이슈, 채팅에 붙이지 마세요. 노출되면 재발급합니다.
- 공개 CORS 프록시(allorigins, corsproxy 등)를 거쳐 브라우저에서 API를 직접 부르는 방식은 키가 제3자 서버와 페이지 소스에 그대로 노출되므로 쓰지 않습니다.
- GitHub 예약 실행은 몇 분씩 늦어질 수 있고, 저장소에 60일 동안 활동이 없으면 자동으로 멈춥니다.
- 보도 유효폭은 아직 실측하지 않았습니다. 그늘막이 없는 8개 구간의 B/C 구분은 로드뷰 실측 후 `segments.json`의 `seg_type`만 고치면 됩니다.
- 저감 효과와 물 사용량은 추정치입니다. 증발 효율(그늘 0.34, 노출 0.27), 주기 운전 비율(10/15), 노즐 수·분사량·살수 깊이는 `assets/model.js` 맨 위에서 바꿀 수 있고, 물 사용량 가정은 대시보드 화면에서도 조정됩니다.
- 실시간 화면은 서울시 S-DoT 자료가 3시간 넘게 늦으면 기상청 초단기실황 기온·습도를 기준으로 하고, 센서 사이의 차이만 S-DoT에서 가져옵니다. `realtime.json`의 `latest_reg`(API 등록 시각)로 지연 정도를 확인할 수 있습니다.
- 3D 화면의 플룸 모양(폭 7~8m, 높이 중심 2.2m, 풍속에 따른 이동)은 시각화를 위한 가정입니다. 구간 평균 저감폭은 대시보드와 같은 산식을 따릅니다.
