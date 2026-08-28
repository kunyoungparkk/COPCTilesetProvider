# COPCTilesetProvider — 프로젝트 개요

## 1. 한 줄 정의

정적 COPC 파일을 **사전 변환 없이** CesiumJS 지구본에 스트리밍 가시화하는 TypeScript 오픈소스 라이브러리.
`COPCTilesetProvider.fromUrl(url)` 한 줄로 로드한다.

## 2. 왜 만드는가 (기획 배경)

- 대용량 Point Cloud를 웹에 올리려면 3D Tiles 사전 타일링이 필수였다.
  → 변환 시간·스토리지 이중화·파이프라인 운영 비용이 크다.
- COPC는 파일 내부가 Octree/LoD로 정렬된 "스트리밍 가능한 LAZ"다.
  HTTP Range만 지원하는 정적 서버(S3, nginx)면 필요한 조각만 읽을 수 있다.
- 그런데 CesiumJS에는 COPC를 직접 읽는 수단이 없다. 이 간극을 잇는 "어댑터"가 본 프로젝트다.

## 3. 핵심 설계 결정 (기술 전략)

**결정 1 — 렌더러를 새로 만들지 않는다.**
Cesium3DTileset이 이미 최고 수준의 traversal·LoD·요청 우선순위·캐시·스타일·picking을 갖고 있다.
우리는 COPC 구조를 "합성 3D Tiles"로 실시간 매핑해 이 엔진을 그대로 빌려 쓴다.
자체 Octree 순회·요청 큐·GPU LRU 금지.

**결정 2 — Cesium의 `_runtimeContentCodec` 확장점을 주 경로로 쓴다.**
Cesium이 타일 bytes를 받은 뒤 콘텐츠 생성을 위임하는 내부 슬롯으로,
first-party MVT 경로가 실제로 쓰는 패턴이다. 공개 API가 아니므로:

- 모든 내부 접근을 `src/cesium-runtime/` 한 곳에 격리 (정적 검사로 강제)
- 지원 버전을 검증된 1.142.0~1.144.x로 제한 (peer dependency)
- 경계 규칙: source는 Cesium을 모른다. 검사가 실제로 보는 것은 **import
  지정자**다 — `src/cesium-runtime/` 밖의 파일이 `cesium`이나 `@cesium/engine`을
  import하면 `tests/cesium-boundary.test.ts`가 실패하고, CI가 이 스위트를 돌리므로
  머지가 막힌다. underscore 필드나 factory 접근 자체를 보는 것이 아니다:
  Cesium을 import할 수 없는 파일은 그 필드에 닿을 경로가 없으므로 import 하나를
  보는 것으로 충분하다. 이 검사가 덮지 못하는 것은 하나 — 인자로 건네받은 Cesium
  객체의 `_` 필드를 밖에서 만지는 코드다. cesium-runtime이 그런 객체를 경계 밖으로
  내보내지 않는 한 생기지 않는 경로이고, 그건 검사가 아니라 설계가 지킨다.
- 검증 현황: **범위 양 끝이 렌더로 검증됨**(1.142.0과 1.144.0, headless Chromium —
  각각 47점·20픽셀, provider 없는 대조군 0픽셀). 최초 hard gate는 1.143.0에서 통과했다.
  하한이 1.142인 것은 선택이 아니라 실측이다: 1.141에는 `_runtimeContentCodec` 슬롯
  자체가 없어 계약 테스트 4개가 깨진다. 계약은 미지수가 아니라 Cesium 소스에
  문서화돼 있고(`Cesium3DTileset.js`의 `_runtimeContentCodec` JSDoc), first-party `MVTDataProvider`가
  같은 패턴으로 콘텐츠 전체를 공급한다. 게이트는 Cesium이 파싱할 수 없는 마커 바이트를 서빙해
  point 타일 렌더·hierarchy의 external tileset 확장·음성 대조군(코덱 미설치 시 FAILED, 0픽셀)까지 확인했다.
- 계약이 부과하는 구현 제약 세 가지:
  1. 합성 tileset의 content URI는 절대경로여야 한다. Blob URL 기준 상대 해석은 동작하지 않으며,
     Cesium 자신도 `getAbsoluteUri`로 절대화한다.
  2. 코덱 분기는 조기 return이라 Cesium의 콘텐츠 분류를 통째로 건너뛴다. `hasTilesetContent`·
     `hasRenderableContent`·`content.metadata`·`content.group`은 코덱이 직접 세팅해야 한다.
     hierarchy를 external tileset으로 확장할 때 이걸 빠뜨리면 서브트리가 아예 열리지 않는다.
  3. 코덱의 `disableSkipLevelOfDetail` 필드는 문서에만 있고 1.142~1.144 어디에도
     읽는 코드가 없다. 1.144가 읽는 것은 `tileset._disableSkipLevelOfDetail`이라는
     다른 필드이고, 그것마저 `preprocess3DTileContent` 뒤 — 코덱 분기가 이미 return한
     자리다.
     `skipLevelOfDetail`은 tileset 생성 옵션으로 넘긴다.
- 회귀 가드: 설치된 Cesium 소스에서 계약 문자열(예: `this._runtimeContentCodec = undefined`)의 존재를 확인하는 오프라인 정적 검사를 CI에 둔다.
  브라우저 없이, Cesium 버전이 바뀌어 이 결합이 깨지는 순간을 잡기 위함이다.
  구현: `tests/cesium-contract.test.ts` (각 단정은 Cesium 소스를 변형해 실패하는지 확인함).

**결정 3 — 무거운 일은 전부 Web Worker에서.**
LAZ 압축 해제(laz-perf WASM)·좌표 변환·PNTS 인코딩을 Worker에서 수행, 메인 스레드는 조율만 한다.
압축 입력과 PNTS 출력만 Transferable로 이동.

**결정 4 — 전송은 검증된 Range만. 왕복 수는 병합으로 줄인다.**
모든 원격 읽기는 206을 요구한다. 200 전체 파일 fallback을 제공하지 않는다(제공하면 "스트리밍" 목표 자체가 무너짐).
검증 강도는 `Content-Range`를 읽을 수 있느냐로 갈린다 — 읽을 수 있으면 시작·끝을
정확히 대조하고, 읽을 수 없으면 206이라는 사실과 본문 길이가 요청한 길이와
일치하는지로 수락한다. 후자에서 확인하지 못하는 것은 **바이트의 위치** 하나다.

- 첫 요청은 bytes 0-588. COPC는 info VLR을 offset 375에 고정하므로
  헤더와 함께 한 요청으로 읽는다. headerSize ≠ 375면 즉시 실패.
- 이후 모든 요청은 직전 응답이 알려준 위치·크기를 근거로만 만든다. 추측성
  선읽기(prefetch) 금지.
- 단, **같은 시점에 승인된 여러 노드의 chunk가 파일 안에서 인접해 있으면 하나의 Range로 병합(coalescing)해 읽는다.**
  이유: Range 요청은 건당 왕복 지연(TTFB)이 고정비라, 노드당 1요청 구조는 "요청 수 × 지연"이라는 속도 바닥이 생긴다. 상용 구현(Eptium)도 인접 노드를 병합해 읽는다.
- 병합 허용 조건: chunk 사이 빈틈(gap)이 임계값 이내, 그리고 빈틈으로 낭비되는
  바이트가 병합 구간의 상한 비율 이내일 때만. (초기값은 §7 튜닝 노브.)
  병합해도 응답 검증은 동일하며, 수신 버퍼는 노드별로 분할해 각각의 descriptor에 전달한다.
- cross-origin 소스는 서버가 `Access-Control-Expose-Headers: Content-Range`를
  보내지 않으면 브라우저가 이 헤더를 JS에 넘기지 않는다. cross-origin에서 읽히는
  것은 안전 목록(`Content-Length`·`Content-Type`·`Last-Modified` 등)뿐이고
  `Content-Range`는 거기 없다. 이 설정은 서버 몫이라 라이브러리가 고칠 수 없다.
  **처음에는 이 경우를 typed error로 즉시 거부했다. 그 규칙을 뒤집은 것은 실측이다** —
  공개 COPC 데이터셋 중 이 헤더를 노출하는 곳이 하나도 없었고(hobu-lidar의 autzen·sofi,
  raw.githubusercontent, data.entwine.io), 그래서 브라우저에서 이 라이브러리로 열 수 있는
  공개 데이터가 사실상 없었다. 헤드리스 Chromium 실측: hobu의 autzen에 cross-origin으로
  0-588을 요청하면 206에 589바이트가 오고 sha256이 `fixtures/autzen-head.bin`과
  바이트 단위로 일치한다. 응답은 완벽했고 막고 있던 것은 우리 검증뿐이었다.
- 그래서 위치를 확인하지 못하는 대신 기대는 것: 첫 요청(0-588)은 구조적으로
  자기검증한다 — LAS 헤더 파싱, headerSize = 375, 375번지 레코드가 `copc/1`,
  그 레코드가 선언한 내용 길이가 160. 넷 다 각각 다른 typed error다. 이후 오프셋은
  전부 파일 내부 hierarchy가 알려준 값이고, 틀린 청크는 laz-perf 디코드에서 깨진다.
  남는 위험은 206과 올바른 길이를 돌려주면서 엉뚱한 위치를 주는 중간 프록시 하나이며,
  이를 받아들인다. 200은 여전히 거부하므로 "조용히 전체 파일을 받는" 실패는 그대로 막힌다.
- 실패 처리: 타임아웃과 서버 일시 오류(5xx)는 잠깐 기다렸다 다시 시도한다.
  요청 자체가 잘못된 경우(4xx)와 검증에 실패한 응답은 다시 보내도 결과가
  같으므로 즉시 실패한다. 횟수와 대기 시간은 §7.

**결정 5 — 자원은 예산·lease로 관리하고 정확히 한 번 정리한다.**
Range body·decode·hierarchy 각각 상한 예산을 두고(초기값은 §7), 승인은
admitted(진행)/deferred(다음 프레임 재시도)/rejected(영구 거부) 3분법.
모든 예약은 성공·실패·취소·destroy 어느 경로로 끝나든 한 번만 반환.

**결정 6 — 합성 tileset·인코딩 규약.**
합성 3D Tiles JSON과 PNTS를 만들 때의 규약. 각 항목의 근거는 COPC 구조의 논리적 귀결이거나, 동일 과제 선행 구현이 프로덕션으로 검증한 선택이다.

- **refine = ADD.** COPC 노드는 중복 없는 샘플이라, 어느 볼륨의 전체 해상도는
  루트부터 그 노드까지 경로의 합집합이다. ADD가 이 의미론과 일치한다.
  REPLACE는 자식마다 조상 점을 다시 담아 인코딩해야 해 기각.
  (체크포인트: 언로드·캐시 거동이 이상하면 이 선택과의 상호작용이 첫 용의자)
- **geometricError = 루트의 실측 미터 span / N, 깊이마다 절반.** span은
  수평·수직 중 큰 쪽 — 수직으로 긴 데이터에서 세분이 멎지 않게. (N 초기값은 §7)
- **좌표 = 타일별 RTC_CENTER + float32 상대좌표.** ECEF 절대좌표(~6.4×10⁶ m)는
  float32 정밀도가 ~0.5m라 카메라 이동 시 지터가 생긴다. 타일 기준점(RTC_CENTER)
  상대값으로 저장하면 float32로도 mm 이하 정밀도 — 충분하다.
  (uint16 양자화는 §7의 보류 항목 — 전송량과 무관한 GPU 메모리 최적화)
- **콘텐츠 포맷 = PNTS(3D Tiles 1.0) + batch table.** 채택 근거: Worker에서
  손 인코딩이 단순하고(헤더 + feature table + 바이너리), batch table로 LAS 속성을
  노출하면 Cesium 스타일 언어와 피킹이 그대로 작동한다(피킹에는 BATCH_ID 필수).
  3D Tiles 1.1 기준 legacy임을 README에 이 근거와 함께 명시. glTF 전환은 v1 이후 로드맵.
- **빈 노드 불변식.** pointCount=0인 hierarchy 엔트리는 합성 JSON에서 content
  자체를 생략한다. 0점 PNTS는 어떤 경로로도 서빙 금지 — 0점 PNTS를 받은 타일은
  ready에 도달하지 못해 tilesLoaded가 영구 대기한다.
  우리 구조에선 분류 필터가 GPU 스타일 단계라 0점 디코드 자체가 나올 수 없다.
  나오면 정책 문제가 아니라 버그이므로 typed error로 시끄럽게 실패한다.
- **CRS = 내부 Map으로 관리. 기본 등록은 EPSG:4326 하나.** 파일 WKT에서 EPSG AUTHORITY 코드만 추출해 CRS Map에서 찾고, 변환에는 CRS Map의 proj4 정의를 쓴다.
  WKT 전문을 proj4에 직접 먹이지 않는다 — 방언에 따라 throw하거나(실측: Autzen compound),
  datum 정보 누락 시 조용히 틀리거나, 어느 쪽일지 예측할 수 없다. 등록된 정의만이
  누군가 정확성을 보증한 입력이다.
  - 확장: `registerCrs(code, proj4정의)` 정적 메서드. 등록된 정의의 정확성은
    등록자 책임. 어떤 좌표계가 들어올지 예측할 수 없으므로 부분적 기본 등록
    대신 규칙 하나로 통일한다 — "4326이 아니면 등록".
  - 미등록 코드·코드 추출 실패는 typed error로 거부한다. 에러는 API의 일부다:
    파일에서 추출한 코드와, 그 코드를 끼운 복사-실행 가능한 registerCrs
    호출문을 포함할 것. (추출 실패 시엔 파일 재작성을 안내)
  - 데모·README의 첫 예제는 registerCrs → fromUrl 순서로 작성해 이 규칙
    자체를 문서화한다. 변환 정확성 테스트는 등록 정의 → 4326 → ECEF
    파이프라인을 기준점 좌표의 PDAL 정답과 대조하는 방식으로 고정한다. (Autzen의 코드·정의는 WKT 실측으로 확정)
  - 수직: 파일의 `VERT_CS` 코드는 경고 판단에만 쓴다. 높이 보정은 `geoidHeight`
    옵션이 받은 상수 하나이고, 정확성은 등록자 책임이라는 같은 규칙을 따른다.
- **boundingVolume = WGS84 region.** 노드 큐브의 XY 변을 등간격 샘플링해
  보수적 경위도 범위를 만들고(비선형 투영의 변 중간 극값 포함), 높이는 옥트리
  큐브 값 — 완전 포함 계약 준수. ECEF box 기하 계산을 통째로 회피한다.
  카메라 프레이밍(zoomTo)은 부풀린 큐브가 아니라 헤더의 실측 extent로 별도 산출.

## 4. 데이터 흐름 (런타임)

```
사용자: fromUrl(url) ─ metadata·root hierarchy만 Range로 읽음
  → COPC Octree를 합성 3D Tiles JSON으로 변환 (Blob URL, 즉시 revoke)
  → Cesium3DTileset 생성 + codec 설치, scene.primitives에 추가

프레임마다: Cesium traversal이 필요한 타일 선택
  → 타일의 가상 URI(opaque token) → ScheduledRangeResource가 가로챔
  → registry에서 descriptor 조회 → 예산 승인 → Range fetch(206, 인접 chunk는 병합)
  → 받은 ArrayBuffer가 그대로 codec.createContent(...)로 전달됨
     · point 타일: Worker에서 LAZ→ECEF→PNTS → Cesium point content
     · hierarchy 타일: page 파싱 → external tileset으로 지연 확장
  → 이후 표시·캐시·언로드·스타일·picking은 전부 Cesium 소유
```

## 5. 기술 스택

- 언어/런타임: TypeScript 7, 브라우저 ESM, Node 24(개발·CI)
  - 하한이 24인 것은 두 가지 실측의 합이다: `node:worker_threads` Worker를 `.ts`
    엔트리로 띄우는 테스트가 플래그 없는 타입 스트리핑을 요구하고, npm의
    trusted publishing(OIDC)이 npm 11.5.1 이상을 요구한다. Node 24는 npm 11.19를
    싣고, Node 22는 npm 10을 싣는다.
  - TS 7의 `typescript` 패키지는 네이티브 컴파일러 래퍼라 JS 컴파일러 API를
    노출하지 않는다(7.0.2에서 `createProgram`·`createSourceFile` 부재 실측).
    결정 2의 경계 정적 검사를 typescript-eslint·ts-morph 위에 지을 수 없다.
    린터(Biome·oxlint)를 들이는 대신 스캐너를 직접 썼다 —
    `tests/import-closure.ts`가 import 지정자를 훑고, 경계 테스트 세 개가 그 위에
    서 있다(Cesium·CRS 레지스트리·Worker 풀). 의존성이 늘지 않고 스위트 안에서
    돌아 CI가 이미 게이트다. 대가는 그 스캐너를 우리가 유지해야 한다는 것이고,
    그래서 스캐너 자신에게도 테스트 파일이 있다.
    계약 문자열 검사는 파일 문자열 탐색이라 영향받지 않는다.
- 핵심 의존성: copc.js(COPC 파싱), laz-perf(LAZ WASM 해제), proj4(CRS).
  이 목록 외의 의존성 추가는 구현하지 말고 확인 후 진행한다.
- Cesium: peer `>=1.142.0 <1.145.0` (번들에 포함하지 않음)
- 빌드: rolldown(라이브러리+자체완결 Worker 번들), Vite(데모·테스트 앱)
  - Rollup으로 적었던 자리다. 순정 Rollup은 TypeScript를 스스로 벗지 못해
    트랜스폼 플러그인이 필요한데, `@rollup/plugin-typescript`는 바로 위 항목이
    적어둔 그 없는 JS 컴파일러 API를 요구한다. rolldown은 Rollup 호환 설정
    API를 쓰면서 oxc로 TS를 네이티브로 벗고 CJS도 스스로 처리해
    `@rollup/plugin-node-resolve`도 `-commonjs`도 필요 없다. Vite 8 자신이
    rolldown 위에 서 있어 툴체인이 갈라지지도 않는다. 의도는 그대로다 —
    라이브러리와 자체완결 Worker 번들을 만드는 진짜 번들러.
  - 선언(`.d.ts`)은 번들러가 아니라 `tsc --emitDeclarationOnly`가 뽑는다.
    `rollup-plugin-dts` 역시 없는 컴파일러 API를 요구하지만, `tsc` 자신은
    TS 7에서도 선언을 정상 생성한다(실측).
- 검증: Vitest(단위) · Playwright(브라우저 E2E) · 로컬 Range 서버(관측) · GitHub Actions CI
- 출시 절차(publish 직전 1회): `npm pack` → 빈 프로젝트에 tarball 설치 →
  패키지 이름으로 import + `fromUrl` 스모크 1회. 소스 경로에선 절대 안 깨지고
  배포물에서만 깨지는 결함(Worker 번들·WASM 파일 누락, exports 맵 오류)을 잡는
  유일한 지점이다. `npm link`로 대체 금지 — 링크는 이 결함들을 전부 통과시킨다.
- 라이선스: MIT (서드파티 고지 별도 관리)

## 6. 범위 밖 (v1 비목표)

- COPC 생성·편집, 일반 LAS/LAZ 지원
- 백엔드·Service Worker·영구 변환 산출물
- 정확한 전역 point budget
- **정표고(geoid) 보정의 자동화** — 파일 하나당 상수 오프셋(`geoidHeight`)은 호출자가
  넘길 수 있다. 자동으로 구하지는 않는다: geoid 격자를 읽거나 조회 서비스를 부르는 것은
  v1 비목표다(proj4js에 수직 격자 지원이 없다 — 실측). 오프셋을 안 주면 높이는
  타원체고(HAE)로 취급되고, 파일이 수직계를 선언했다면 경고한다. 상수 하나이므로
  유효한 것은 분리량이 변하지 않는 범위 안에서다.
- Cesium 1.141 이하 — 비목표가 아니라 불가능하다. `_runtimeContentCodec` 슬롯이
  1.142에서 들어왔고, 그 이전 버전에서는 Decision 2의 메커니즘이 존재하지 않는다(실측).
- WebGL1, 2D/Columbus View

## 7. 튜닝 노브 — 초기값과 개선 여지

방향 결정은 §3에서 끝났다. 여기 항목들은 **값만 열려 있다**: 아래 초기값으로
구현을 시작하고, 조정은 고정 환경(동일 viewport·network·camera path)의 측정으로만
한다. 감각적 조정 금지. 값을 바꾸면 이 표를 갱신한다.

| 노브 | 초기값 | 유래 · 조정 방향 |
|---|---|---|
| Range 병합 gap 임계 | 256KB | 선행 실측(타 데이터셋) 유래. 관측 Range 서버가 기록하는 요청 수·전송량으로 재측정 |
| Range 병합 낭비 상한 | 2% | 위와 한 쌍. 실제 낭비율은 통계로 항상 노출 |
| Range 병합 span 상한 | 4MiB | 위 둘은 병합이 **낭비하는 양**만 묶고 **커지는 정도**는 묶지 않는다 — COPC는 청크를 맞붙여 쓰므로 연속 구간은 gap 0·낭비 0으로 얼마든지 병합된다(실측: 핀 파일의 청크 간극 277개가 전부 0, 즉 81MB 포인트 영역 전체가 gap·낭비 기준으로는 합법적인 한 덩어리). 그 유일한 제동장치가 이 값이다. 단일 range가 이보다 커도 읽는다 — span을 이 이상 **키우지** 않을 뿐이라 그런 range는 혼자 한 그룹이 된다. 초기값은 아래 동시 상한 18과 짝: 핀 파일의 청크가 ~190KB이므로 한 프레임 분량이 대략 이 크기다. 조정은 RTT 대 대역폭의 저울 — 크게 잡으면 왕복은 줄고 첫 타일이 늦다 |
| Range 재시도 | 최대 2회, 대기 0.5s → 2s | 타임아웃·5xx만 대상. 4xx는 다시 보내도 같은 답이라 즉시 실패 |
| Range 타임아웃 | 8s + 요청 1MB당 2s 추가 | 병합으로 요청이 커지면 시간도 그만큼 더 받게 — 큰 요청이 작은-요청용 시한에 걸려 죽는 것 방지 |
| geometricError 루트 상수 N | 16 | 키우면 로드량↓ 화질↓. maximumScreenSpaceError와 한 쌍으로 튜닝 |
| maximumScreenSpaceError 기본값 (공개 옵션) | 16 | Cesium 표준 노브. 선행 구현 기본값은 8 — 데모에서 비교 |
| 호스트당 동시 요청 상한 | 18 (6에서 상향) | **이 값이 세는 것은 연결이 아니라 승인된 타일 읽기다** — 승인은 타일마다, 병합은 그 뒤에 일어나므로 실제 연결 수는 언제나 이 값 이하다. 6은 "HTTP/1.1 브라우저 연결 천장"에서 왔는데, 우리가 빌려 쓰는 엔진이 그 전제를 더는 따르지 않는다: Cesium의 `RequestScheduler.maximumRequestsPerServer` 기본값이 **18**이고, 공개 문서가 `throttleByServer`에 대해 *"HTTP/1 서버는 6–8, **HTTP/2 서버는 무제한**"*이라고 적으며 `requestsByServer`의 HTTP/2 스트리밍 예시로도 18을 쓴다. COPC가 실제로 놓이는 곳(S3·CDN·Pages)은 사실상 전부 HTTP/2다. 브라우저 실측은 아니지만 감도 아니다 — 같은 문제를 브라우저용으로 더 오래 다룬 엔진이 고른 값이다. 6이 병목이었다는 근거는 핀 파일 실측(공간 순서 선택, 청크 노드 278개): 병합 계수가 6에서 1.05배·18에서 1.17배지만, **정작 크게 움직이는 것은 왕복 파동 수다 — 44.0 → 13.2**. 즉 여기서 얻는 것의 대부분은 병합이 아니라 동시성이고, 병합은 그 위의 승수다. 진짜 실측은 관측 Range 서버가 생긴 뒤 같은 카메라 경로로 잰다 |
| Worker 풀 크기 | 4 | 선행 실측상 디코드는 비병목(전체 시간의 <1%) — 확대 이득 낮음. (PNTS 파이프라인 실측, 50k점·단일 머신·웜, 워커 세 단계 전부를 분모로: decode 0.90µs/점 31.3%, positions 1.77µs/점 61.4%, encode 0.21µs/점 7.3%. 디코드는 <1%가 아니라 31%지만 병목도 아니다 — 지배적인 것은 positions이고, 그 안은 proj4 forward + ECEF 변환이다. 따라서 여기서 얻을 것은 풀 확대가 아니라 배치 변환 API다. 값은 그대로 둠: 실측한 것은 한 머신의 단계별 한계비용이지 워커 풀이 아님 — 풀 실측 전까지 4를 유지) |
| 예산 상한: Range 동시 body | 32MB | 임의 시작점. 첫 프로파일링에서 재설정 |
| 예산 상한: decode 동시 작업 | 풀 크기 × 2 | 임의 시작점. Worker 큐 깊이 관측으로 조정 |
| region 변당 샘플 수 k | 5 | 노드 큐브 XY 둘레를 변마다 k점 샘플링(고유 둘레점 4(k−1)개). 투영 곡률은 노드마다 실측해 부풀리므로 k는 정확도가 아니라 비용·여유의 저울. 큰 페이지에서 빌드 시간 측정해 조정 |
| POSITION_QUANTIZED (uint16 양자화) | 미적용 | 전송은 LAZ라 전송량 무관 — GPU 메모리 절반 최적화. 평가 후 도입 후보 |

**은퇴한 노브 — hierarchy 페이지 캐시(초기값 64개).** 값을 조정한 것이 아니라
노브 자체를 없앴다. 재는 대상이 존재하지 않았기 때문이다: 코덱은 페이지를
파싱해 `TileEntry`만 꺼내 쓰고 페이지 자체는 즉시 버린다. 남는 것은 페이지가
아니라 entry이고(Autzen 루트 페이지 하나가 278개), 그 entry는 버릴 수도 없다 —
Cesium은 언로드한 타일을 같은 URI로 다시 요청하므로, 없는 entry는 그 타일을
되돌릴 수 없게 실패시킨다. 그래서 강제할 수 없는 상한 대신 실제 성장을
`stats()`의 `registryEntries`와 `hierarchyPagesExpanded`로 노출한다. eviction
정책은 이 숫자들이 필요하다고 말할 때 짓는다.
