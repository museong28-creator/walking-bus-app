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

## 브라우저 연결 모듈 (실제 활성화 전)

`src/navigation-client.js`는 서버 연결 후 사용할 클라이언트이며 아직 공개 화면에서 호출하지 않습니다. HTTPS origin만 받고 브라우저에는 공급자 인증키를 두지 않습니다. 정류소 식별자는 TAGO 공식 도시 코드와 정류소 ID를 함께 사용하며, 수신한 도착정보는 30초 이내의 유효 기간을 검사합니다. 화면에서도 `arrivalIsFresh()`를 사용해 시간이 지난 결과를 숨기고 재조회를 안내해야 합니다. 목적지 변경 시 AbortSignal로 이전 요청을 취소합니다.

현재 `credentials: same-origin`입니다. 별도 도메인 쿠키 인증 서버를 연결할 경우 이 설정만 변경하면 끝나는 것이 아니며, 인증·CORS·CSRF·아이폰 교차 사이트 쿠키 정책까지 검증해야 합니다. 동일 출처 인증 서버와 화면 배포가 가장 단순합니다. 서버 주소를 입력했다고 인증 문제가 해결되지는 않습니다.

클라이언트 테스트도 합성 응답 기반입니다. 실제 API 검증, 화면 연결, 호스팅 배포 완료를 의미하지 않습니다.


## 2026-11-12 보안 잠금 상태

무료 Render 서버는 생성했지만 공급자 키와 실사용 연결은 아직 활성화하지 않았습니다.
기본 실행은 `SECURITY_NOT_CONFIGURED`로 중단됩니다. 키만 환경변수에 넣어도 호출되지 않습니다.

- HTTP 서버의 `authorize(req)` 어댑터가 실제 검증된 세션만 허용해야 합니다. 기본값은 거부입니다.
- 상위 API 호출 직전 `reserveQuota({day,limit})`가 영속 저장소에서 원자적으로 전체 일일 예산을 선점해야 합니다. 기본값은 거부이고 저장소 실패도 차단합니다. 실패 요청의 예약은 되돌리지 않아 보수적으로 계산합니다.
- 이것은 **안전 잠금 및 확장 지점**이지 인증/영속 저장소를 구현하거나 연결했다는 뜻이 아닙니다. 테스트의 `async()=>true`는 합성 테스트 전용이며 운영에 복사하면 안 됩니다.
- Render 계정에는 확인 당시 Postgres/Key Value가 없습니다. 무료 웹 서비스 파일과 메모리 카운터는 재시작을 넘겨 유지되지 않습니다. 무료 Redis 계열 비영속 인스턴스나 만료형 DB도 지속 운영 해결책으로 간주하지 않습니다.
- 공개 GitHub Pages의 고정 비밀번호, 프런트엔드에 넣은 공용 토큰, Origin 검사만으로는 보호하지 않습니다. 실제 로그인과 동일 출처 배포 또는 검증된 모바일 웹 인증 설계가 필요합니다.
- 별도 영속 저장소/인증 서비스를 도입한다면 먼저 무료 한도·초과 요금 차단·계정 승인·데이터 보존을 확인해야 합니다. 현재 새 계정을 만들거나 과금 리소스를 추가하지 않았습니다.

키 입력은 인증·저장소 연결이 검증된 다음 Render 대시보드 Environment에서 직접 진행합니다. 채팅이나 공개 저장소에 키를 올리지 않습니다. TAGO 두 서비스 활용 승인과 첫 시험 도시/정류장도 필요합니다. 현재 사용자 화면은 기존 동작을 유지합니다.

## Firebase Spark 보호 어댑터 (준비 코드, 미배포)

`server/firebase-security.mjs`는 Firebase Admin SDK를 사용합니다. 정상 Google 로그인, 이메일 확인, 허용 UID, 토큰 서명/프로젝트/만료/폐기/계정 비활성화를 검증합니다. Google 이메일 문자열만으로 허용하지 않습니다. 운영 초기에는 소유자 UID만 허용합니다.

Firestore `navigationQuota` 컬렉션에서 전체 하루 한도와 사용자 하루/분당 한도를 **한 트랜잭션**으로 선점합니다. 하루는 UTC 기준이며 실패한 제공기관 호출도 사용량에 포함됩니다. 기본 전체 하루 100, 사용자 하루 30, 사용자 분당 6입니다. 문서는 날짜와 카운터, UID의 SHA-256 식별값만 담습니다. 경로/위치/이메일/토큰은 저장하지 않습니다. 메모리 제한은 보조용으로 유지합니다. 저장소 오류·손상·타임아웃은 요청을 막으며 무료 초과 과금을 활성화하지 않습니다.

아래 환경변수는 **Render 서버 전용**입니다. `NAV_FIREBASE_SERVICE_ACCOUNT_JSON`은 비밀 환경변수로 직접 입력하고 저장소나 채팅에 붙여 넣지 않습니다.

| 이름 | 값/용도 |
|---|---|
| `NAV_FIREBASE_PROJECT_ID` | `myeotbun-georeum` |
| `NAV_FIRESTORE_DATABASE_ID` | `(default)` |
| `NAV_ALLOWED_FIREBASE_UIDS` | 실제 소유자가 Google 로그인한 뒤 확인한 UID. 처음에는 소유자만 |
| `NAV_FIREBASE_SERVICE_ACCOUNT_JSON` | 전용 최소권한 서비스 계정 JSON (비밀) |
| `NAV_PER_USER_DAILY_CALLS` | 기본 `30` |
| `NAV_PER_USER_MINUTE_CALLS` | 기본 `6` |

최소권한 전용 계정은 프로젝트 맞춤 역할 `NavigationQuotaRuntime`에 `datastore.databases.get`, `datastore.entities.get`, `datastore.entities.create`, `datastore.entities.update`, `firebaseauth.users.get` 다섯 권한만 부여합니다. 이 권한은 트랜잭션 시작/롤백, 정해진 문서 읽기·생성·갱신, 토큰 폐기/사용자 상태 조회에 사용합니다. 문서 삭제·목록 조회, 사용자 변경, 설정·IAM 관리 권한은 포함하지 않습니다. Firebase Admin SDK는 보안 규칙을 우회하므로 IAM 권한은 프로젝트 내 해당 API에 적용되며 특정 컬렉션만으로 자동 제한되지 않습니다. Owner/Editor, IAM 관리, 키 관리 권한은 런타임에 부여하지 않습니다. 보안 규칙으로 Admin SDK의 IAM 권한이 줄어들지는 않습니다. 선택 프로젝트만 담는 전용 프로젝트인지도 확인합니다. 서비스 계정 생성/권한 부여/키 발급은 별도 승인이 필요한 보안 설정으로 취급합니다.

`server/firestore.rules`는 모든 브라우저 직접 읽기/쓰기를 거부하는 규칙 초안입니다. 파일을 추가했다고 Firebase에 배포되는 것은 아닙니다. 실제 콘솔 규칙과 IAM을 확인해야 합니다. Cloud Functions/Blaze/결제 계정은 사용하지 않습니다.

실사용 전 확인 순서:
1. Google Auth와 앱 도메인 설정, Firestore Spark 데이터베이스, 실제 default-deny 규칙.
2. 소유자의 실제 로그인 후 UID 확보. 브라우저는 Firebase SDK가 발급한 단기 ID 토큰을 HTTPS Authorization Bearer로 보냅니다. 공통 하드코딩 토큰이나 장기 서비스 계정 키는 금지.
3. 최소권한 전용 서버 자격증명을 안전하게 Render에 설정. Firebase 브라우저 config는 이 자격증명을 대신하지 않습니다.
4. 공급자 키 없이 로그인/미로그인/폐기 토큰/다른 UID 차단을 검증. 실제 Firestore 동시 예약과 프로세스 재시작 후 한도 유지를 검증.
5. 그다음 공급자 키를 안전하게 설정하고 TAGO 지원 도시·정류장, 실제 도보 응답을 검증.

현재 테스트는 합성 Auth/트랜잭션 어댑터 기반입니다. 실제 Firebase 인증, IAM, Firestore 동시성 또는 재시작 검증을 통과했다는 뜻이 아닙니다. 로그인 UI/브라우저 토큰 전송도 별도 연결해야 합니다.
