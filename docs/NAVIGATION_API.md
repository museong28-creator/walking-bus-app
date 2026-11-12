# 도보·버스 서버 연결 준비 (아직 실서비스 미연결)

## 지금 완료된 부분 / 아직 안 된 부분

- 카카오 지도 및 장소 검색은 기존 JavaScript 키로 공개 사이트에서 동작합니다.
- `server/navigation-api.mjs`는 카카오 도보 경로와 TAGO 정류소/도착정보 서버 어댑터입니다. **키 없이 합성 테스트 응답으로 검증한 준비 코드**이며, 실제 API 인증·지역 커버리지·배포는 검증하지 않았습니다.
- 이 파일은 정적 빌드에 포함되지 않습니다. GitHub Pages는 서버 코드를 실행할 수 없습니다.
- 공개 화면은 계속 기존 FOSSGIS 도보 경로 및 수동 버스 시간 입력을 사용합니다. 서버를 띄웠다고 화면이 자동 전환되지 않습니다.

## 최소 설정

1. 기존 카카오 앱에서 REST API 키를 확인합니다. JavaScript 키와 다른 키입니다. 키는 채팅, GitHub 파일, 브라우저 설정에 붙여 넣지 않고 선택한 서버 호스팅의 **Secret 환경변수**에 저장합니다.
2. 공공데이터포털에서 아래 두 서비스를 각각 활용 신청/승인하고 `Decoding` 인증키를 서버 Secret 환경변수에 저장합니다.
   - 버스정류소정보: https://www.data.go.kr/data/15098534/openapi.do
   - 버스도착정보: https://www.data.go.kr/data/15098530/openapi.do
3. 기존 HTTPS Node 22+ 호스팅을 활용하는 것이 가장 적은 변경입니다. 없다면 호스팅 계정·요금·한도·지역을 정하고 가입/비용 승인 후 배포해야 합니다. 이 작업에서는 가입이나 유료 설정을 하지 않았습니다.
4. 최초 검증할 도시와 정류장을 정합니다. GPS 근처 정류소 조회는 500m 범위이며, 서울·경기 등 모든 지역의 실시간 도착 지원을 보장하지 않습니다. `cities` 응답 및 실제 선택 정류소의 데이터를 확인합니다. 미지원 지역은 별도 지자체 API가 필요할 수 있습니다.

서버 환경변수 (값은 파일에 저장하지 않음):

| 이름 | 용도 |
|---|---|
| `KAKAO_REST_API_KEY` | 서버 전용 카카오 REST 키 |
| `TAGO_SERVICE_KEY` | TAGO **Decoding** 인증키. URL 인코딩은 코드가 한 번 수행 |
| `NAV_ALLOWED_ORIGINS` | `https://museong28-creator.github.io` (쉼표로 복수 origin 가능, 경로 없이) |
| `NAV_HOST` | 로컬 검증 기본값 `127.0.0.1`. 호스팅 연결은 해당 플랫폼 지침에 맞춤 |
| `PORT` | 기본 8788 |
| `NAV_MAX_DAILY_CALLS` | 기본 100, 1~1000; 프로세스 단위 보조 제한 |

로컬 실행: `npm run navigation-server` (키가 없으면 명확한 503 NOT_CONFIGURED 응답).
서버 실행은 API 활성화·결제·키 발급을 대신하지 않습니다.

## API 계약

모두 `POST`, `Content-Type: application/json`, 허용된 `Origin` 필요. 출발·도착 좌표는 `[위도, 경도]`. 사용자 위치는 URL 쿼리 대신 JSON body에 담습니다.

- `/v1/walk`: `{start:[37.5,127],end:[37.5005,127.0005],mode:"SHORTEST"}` → `points`, 실제 거리(m), 단계별 안내, 제공자. `BROAD_FIRST`, `ACCESSIBLE`도 허용. 넓은 길은 가로등이 많거나 안전하다는 뜻이 아닙니다.
- `/v1/stops`: `{point:[36.3,127.3]}` → 공식 `cityCode`, `id`, `point`, 이름. 최대 100개, `truncated` 표시. OSM ID를 TAGO ID로 사용하지 않습니다.
- `/v1/cities`: `{}` → 도착정보 제공기관의 도시 목록. 실제 인증 응답/지원 도시 확인 필요.
- `/v1/arrivals`: `{cityCode:"25",stopId:"DJB8001793"}` → 예상 초, 남은 정류장, `fetchedAt`, `expiresAt`, `cached`. 빈 정상 결과는 `no_data`; 운행 종료로 단정하지 않습니다.

도착 정보 캐시는 15초. `fetchedAt`은 서버 조회 시간이지 버스 위치를 기관이 관측한 시각이 아닙니다. 응답 만료는 조회 후 30초입니다. UI 연결 시 오래된 ETA를 계속 감소시키거나 확정 시간으로 표시하지 않습니다.

## 운영 전 반드시 할 일

- 호스팅에서 HTTPS 강제, 접근 제어/인증 또는 엣지 요청 제한, **영속적인 무료 호출량 한도**, provider 무료 정책 확인. CORS는 인증이 아니며 비브라우저 요청을 막지 못합니다. 현재 호출량 제한은 재시작·복수 인스턴스에서 초기화/분산되므로 과금 방지 보장이 아닙니다. 유료 초과 사용은 활성화하지 않습니다.
- 프록시는 기본 4개 동시 상위 요청, 10초 상위 timeout, 2MB 응답 상한, 2KB 요청 상한, IP별 분당 20개, 전체 상위 일일 100개 제한을 갖습니다. 리버스 프록시 뒤에서는 IP가 하나로 합쳐질 수 있습니다. `X-Forwarded-For`는 신뢰하지 않습니다.
- 로그에 요청 body/좌표, 상위 API URL/TAGO 쿼리 키, 인증 헤더를 남기지 않도록 **호스팅 및 APM 설정**도 확인합니다. 코드 자체는 이런 값을 로그하지 않습니다. 경로·사용자 GPS는 저장/캐시하지 않습니다. 캐시는 공개 정류소 ID별 도착 결과만 최대 100개, 메모리에 보관합니다.
- 실제 키로 공식 요청 성공/권한 오류/할당량/지역 데이터/장애를 검증한 후, 화면의 요청 동의 문구에 서버와 Kakao/TAGO 수신 대상을 추가하고 route/stop/arrival UI를 연결합니다. 외부 무료 경로로 몰래 fallback하지 않습니다.
- 마지막으로 iPhone 실제 보행, 목적지 변경 중 응답 취소, 30초 이상 된 도착 정보, 오프라인 상태를 시험합니다.

## 공식 근거 (2026-11-12 확인)

- https://developers.kakao.com/docs/ko/kakaomap/rest-api : `GET /v2/routing/walk`, Authorization KakaoAK, WGS84, `[x,y]` path.points.
- https://www.data.go.kr/data/15098534/openapi.do : 좌표 기반 500m 정류소 및 도시 목록.
- https://www.data.go.kr/data/15096280/standard.do : `BusSttnInfoInqireService/getCrdntPrxmtSttnList`.
- https://www.data.go.kr/data/15098530/openapi.do?recommendDataYn=Y : `ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList`.
