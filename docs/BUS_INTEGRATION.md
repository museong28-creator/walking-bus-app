# 전국 실시간 버스 확장: 아직 연결하지 않은 설계

## 현재 상태

현재 구현은 Overpass의 OpenStreetMap 정류장을 읽어 목적지로 고르는 기능과 직접 입력한 버스 도착 시간 비교입니다. 정류장 자체의 OSM ID는 교통 운영기관의 정류장 ID와 다르므로 그대로 실시간 API 조회에 사용할 수 없습니다.

전국 실시간 조회는 배포하지 않았고 검증되지 않았습니다. 사용할 도시·교통 데이터 제공자·승인된 키·이용 조건을 확인한 뒤 다음 단계를 진행해야 합니다.

## 권장 구성

```text
GitHub Pages (정적 UI)
        │ HTTPS /v1/stops, /v1/arrivals
        ▼
별도 서버 / Worker (키를 비밀 환경변수로 보관)
        │ 지역별 어댑터 + 캐시 + 호출량 제한
        ▼
승인된 공공데이터·지역 교통 정보 API
```

- API 키를 GitHub 파일, 번들 JavaScript, localStorage, 쿼리 문자열 설정 파일에 넣지 않습니다.
- 전국 지원은 각 제공자의 실제 커버리지를 확인한 도시부터 선언합니다. 미지원 지역을 명시합니다.
- 좌표 기준 정류장 검색은 공식 provider/region/stop ID와 방향을 반환해야 합니다.
- OSM 정류장과 공식 정류장의 매칭은 이름뿐 아니라 위치·방향·노선으로 검증해야 합니다.
- 서버에서 XML/JSON·분/초·날짜/시간대 차이를 정규화합니다.
- stale, unavailable, no_service를 구별하고 마지막 갱신 시각을 표시합니다. “정보 없음”을 “곧 도착”이나 “0분”으로 바꾸지 않습니다.
- 서버의 CORS는 실제 Pages origin으로 제한합니다. rate limit, timeout, 짧은 캐시와 에러 처리가 필요합니다.
- 위치 전송 대상과 목적을 UI에 새로 안내하고 사용자 동의를 받습니다.

## 예시 응답 계약 (구현/연결 전 설계)

```json
{
  "provider": "official-provider-id",
  "regionId": "provider-region-id",
  "stopId": "official-stop-id",
  "stopName": "정류장 이름",
  "direction": "진행 방향",
  "observedAt": "2026-11-11T00:00:00+09:00",
  "status": "fresh",
  "arrivals": [
    {
      "routeId": "provider-route-id",
      "routeName": "노선 표시명",
      "etaSeconds": 600,
      "status": "estimated"
    }
  ]
}
```

이 예시는 실제 운행 데이터가 아닙니다. 서버 구현·키 발급·실시간 연결·전국 커버리지 확인은 현재 산출물에 포함되지 않습니다.
