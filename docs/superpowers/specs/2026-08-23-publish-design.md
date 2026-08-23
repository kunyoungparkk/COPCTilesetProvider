# 배포물 서브프로젝트 — 설계

## 1. 목표와 완료 기준

라이브러리를 `npm pack`이 만든 tarball 하나로 소비 가능하게 만든다.

**완료 기준: `npm pack` 산출물만으로 데모가 돈다.** 소스 경로에서만 도는
상태는 미완이다. 판정은 스모크 하네스가 하며, 그 하네스가 곧 데모다.

이 서브프로젝트가 닫는 것은 `docs/superpowers/plans/carried-forward.md`의
**publish 섹션 네 항목 전부**다. 같은 파일의 cesium-runtime 섹션(hierarchy
페이지 예산·`AbortSignal`)은 범위 밖으로, 그 자리에 그대로 남는다 —
패키징과 공유하는 파일도 순서 의존도 없고, 예산 항목은 eviction policy라는
자기 설계 문제를 품고 있어 자기 스펙이 필요하다.

## 2. 범위 밖

- 실제 `npm publish`. 이번 산출물은 `npm pack`까지다. 버전은 `0.0.0`에서
  움직이지 않는다.
- 사람이 쓸 `demo/` 앱과 `npm run dev`(OVERVIEW §5). 스모크 페이지가
  데모 역할을 겸하고, 꾸며진 데모는 별도 작업이다.
- 루트 `README.md`. carried-forward가 README 소유자에게 넘긴 항목들은
  그대로 둔다. 단 §9가 적는 CSP 사실은 그 목록에 추가된다.

## 3. 무엇이 배포되는가

`files: ["dist"]`. `docs/`도 `src/`도 `fixtures/`도 나가지 않는다 —
carried-forward의 `files` 항목이 여기서 닫힌다.

| 산출물 | 무엇인가 | 외부로 남기는 것 |
|---|---|---|
| `dist/index.js` | 라이브러리 ESM | `cesium`(peer), `copc`, `proj4` |
| `dist/worker.js` | Worker realm, 자체완결 ESM | 없음 |
| `dist/types/**/*.d.ts` | 타입 선언 | — |

### 3.1 선언된 의존성 셋은 전부 external

`copc`의 `Las` 배럴은 `PointData`를 재export하고, `point-data.js`는
`import { createLazPerf } from 'laz-perf'`로 laz-perf를 정적으로 끌어온다.
laz-perf의 `main`은 node 빌드이고 그 빌드에는 `require("fs")`·`require("path")`·
`__dirname`이 들어 있으므로, 처음에는 이것이 소비자 번들러에게 넘어가는
위험으로 보였다.

**측정 결과 그렇지 않다.** laz-perf의 `package.json`은
`"browser": "lib/web/index.js"`를 선언한다. 브라우저를 대상으로 하는 번들러는
이 필드를 보고 web 빌드를 고른다 — 실측: alias를 걸었을 때와 걸지 않았을 때의
Worker 번들이 `cmp` 기준 바이트 단위로 동일했고(434,353 바이트), 양쪽 모두
`require("fs")`와 `__dirname`이 0건이었다.

그러므로 `copc`를 번들에 넣을 이유가 없다. 셋 다 external로 둔다 — `cesium`은
peer(Decision 2: 번들에 포함하지 않음), `copc`와 `proj4`는 선언된 의존성으로
소비자가 설치하고 중복 없이 공유한다. 번들에 들어가는 것은 `dist/worker.js`
쪽뿐이며, 그것은 자체완결이 목적이라 의도된 것이다.

`dependencies` 셋은 그대로 유지한다. 번들 여부와 무관하게 **타입** 때문이다:
배포되는 `.d.ts`가 `copc`의 타입을 이름으로 참조하고(`View`, `Las`, `Bounds`,
`Hierarchy`), copc 자신의 선언은 다시 `laz-perf/lib/node/laz-perf.js`의 타입을
참조한다.

## 4. Worker — 파일 하나가 두 역할

`dist/worker.js`는 `src/worker/browser.ts`에서 빌드하며 두 가지로 동시에
동작한다.

1. **import되면** `createWorkerHandler`를 그대로 재export한다.
2. **Worker 안에서 평가되면** 스스로 `self.onmessage`에 붙는다.

자기 설치는 가드 뒤에서만 일어난다: `self`가 있고 `window`가 없을 때. 메인
스레드에서 실수로 import해도 `onmessage`를 가로채지 않는다.

이 파일 하나가 세 곳에 쓰인다.

- **기본 경로**: `dist/index.js`가 이 파일의 텍스트를 문자열로 품고 있다가
  `new Worker(URL.createObjectURL(new Blob([text], {type:'text/javascript'})), {type:'module'})`로
  Worker를 만든다. 소비자 번들러가 무엇을 하든 동작한다 — OVERVIEW §5의
  "자체완결 Worker 번들"이 뜻하는 것이 이것이다.
- **탈출구**: `exports`의 `./worker` 서브패스가 같은 파일을 가리킨다. 직접
  Worker 모듈을 짓는 소비자와, CSP가 `worker-src blob:`을 막는 환경의 답이다.
- **Node 테스트**: 지금처럼 `spawnWorker`로 주입한다.

`dist/worker.js`는 Cesium에 닿지 않는다. `tests/worker-boundary.test.ts`가
`entry.ts`에 대해 하는 import closure 검사를 `browser.ts`로 확장해, 이 사실이
주장이 아니라 검사가 되게 한다.

## 5. laz-perf — web 빌드를 소스에서 고른다

`Las.PointData.decompressChunk(compressed, meta, suppliedLazPerf?)`는 세 번째
인자로 LazPerf 인스턴스를 받는다(실측). 그래서 web 빌드 인스턴스는
번들러 마법이 아니라 **소스에서** 만들어 넘긴다: 새 모듈
`src/worker/lazperf.ts`가 `createLazPerf({ wasmBinary })`로 하나를 만들어
캐시하고, `decode.ts`가 그것을 `decompressChunk`에 넘긴다.

`laz-perf` → `laz-perf/lib/web/index.js` alias는 두 설정 모두에 건다. 두 곳의
근거가 다르다.

- **번들러 쪽은 이중 안전장치다.** §3.1이 측정한 대로 laz-perf의 `browser`
  필드가 이미 web 빌드를 고르므로 alias는 결과를 바꾸지 않는다. 그럼에도
  거는 이유는 그 필드가 우리 것이 아니기 때문이다 — 명시가 남의 패키지 필드에
  기대는 것보다 낫고, 비용은 두 줄이다.
- **Vitest 쪽은 실제로 무게를 진다.** 테스트는 Node 플랫폼에서 돌므로 alias가
  없으면 `main`, 즉 node 빌드가 해석된다. 그러면 테스트가 돌리는 laz-perf와
  배포물이 돌리는 laz-perf가 서로 다른 빌드가 된다. §6이 wasm에 대해 없애는
  그 divergence를 코드 쪽에 남겨둘 이유가 없다.

## 6. wasm — 플러그인 하나를 번들러와 Vitest가 공유한다

`build/laz-perf-wasm.mjs`가 가상 모듈 하나를 해석해
`node_modules/laz-perf/lib/web/laz-perf.wasm`(214,351 바이트)의 바이트를
`Uint8Array`로 export한다. Vitest는 Vite 기반이라 같은 플러그인 객체를 그대로
받는다.

핵심은 **하나**라는 점이다. 소스·테스트·번들이 같은 경로로 같은 바이트를
얻으므로, "소스에선 되는데 배포물에서 깨진다"는 결함군(OVERVIEW §5가 스모크를
두는 바로 그 이유)이 이 축에서는 구조적으로 생길 수 없다.

바이트는 emscripten의 `Module.wasmBinary`로 넘긴다(웹 빌드가 실제로 읽는 것을
확인함). `locateFile`도, 서빙할 `.wasm` 파일도, 소비자 쪽 미들웨어도 필요
없다 — 렌더 게이트가 미들웨어로 덮었던 문제가 여기서 닫힌다.

## 7. 공개 API 변화 — `spawnWorker`가 선택이 된다

```ts
COPCTilesetProvider.fromUrl(url)                    // 새로 가능
COPCTilesetProvider.fromUrl(url, { spawnWorker })   // 여전히 가능
```

`spawnWorker`가 없으면 §4의 Blob Worker를 만든다. 번들 Worker 텍스트가 없는
빌드(소스에서 직접 실행할 때)에서 `spawnWorker` 없이 부르면 새 typed error
`WorkerBundleMissingError`(`src/errors/provider.ts`)로 즉시 실패한다. 메시지는
Decision 6을 따라 실행 가능한 지시를 담는다: `spawnWorker`를 넘기거나
`npm run build`를 돌리라고.

`browserPort`를 `src/index.ts`에서 export한다 — `spawnWorker` 탈출구를 쓰는
소비자가 매번 다시 쓰던 열 줄이다. carried-forward의 `WorkerPort` 어댑터
항목이 이걸로 닫힌다: 기본 경로에는 어댑터가 아예 필요 없어지고, 필요한
사람에게는 패키지가 준다.

`src/index.ts`의 Worker 관련 주석은 이번에 다시 참이 된다. 지금 그 주석은
"번들러에 기대는 것이지 이 패키지에 기대는 것이 아니다"라고 적혀 있고,
`./worker`가 생기는 순간 그 문장은 철회되어야 한다.

## 8. exports 맵과 테스트 루프

```json
"exports": {
  ".":            { "types": "./dist/types/index.d.ts",         "import": "./dist/index.js" },
  "./worker":     { "types": "./dist/types/worker/browser.d.ts", "import": "./dist/worker.js" },
  "./package.json": "./package.json"
},
"types": "./dist/types/index.d.ts",
"files": ["dist"]
```

선언은 `tsconfig.build.json`(`src`만, `emitDeclarationOnly`)으로 뽑는다. TS 7이
선언을 정상 생성하는 것을 확인했으므로 `rollup-plugin-dts`는 필요 없다 —
그 플러그인이 요구하는 JS 컴파일러 API를 TS 7이 노출하지 않는다는 OVERVIEW §5의
제약을 피해 간다.

**단위 테스트 루프는 지금 속도를 유지한다.** `tests/package-root-api.test.ts`는
패키지 이름으로 import하는데, `exports`가 `dist/`를 가리키면 빌드에 의존하게
되고 `test:watch`는 stale dist를 보게 된다. 그래서 Vitest에 alias를 걸어 그
import가 `src/index.ts`로 가게 한다. 대신 그 파일의 주석이 지금 하는 주장 —
"소비자가 쓰는 바로 그 import" — 은 참이 아니게 되므로 철회하고, 배포면을
단언하는 것은 스모크라고 명시한다.

## 9. 스모크 하네스가 판사다

`smoke/run.mjs`가 순서대로 한다.

1. `npm pack` → tarball
2. tarball의 파일 목록을 단언: `dist/`만 있고 `docs/`·`src/`·`fixtures/`가 없다
3. 임시 디렉터리에 `npm init` 후 **tarball과 `cesium@1.143.0`을 설치**
4. 설치된 산출물에 정적 단언:
   - `dist/index.js`에 `require("fs")`·`__dirname`이 없다 (§3.1이 지킨 것)
   - `dist/worker.js`에 Cesium 표지가 없다 (§4가 지킨 것)
   - `dist/worker.js`가 wasm을 담고 있다 (크기 하한, §6이 지킨 것)
5. 패키지 이름으로 import하는 페이지를 그 디렉터리에 쓰고 **Vite로 빌드** —
   진짜 번들러가 우리 패키지를 소화하는지까지 여기서 걸린다
6. Playwright가 빌드 산출물을 로드하고 판정:
   - `pointsLength === 47`, content state READY, 켜진 픽셀 > 0
   - **음성 대조군**: 같은 씬·같은 프레임 수에 provider만 없을 때 0픽셀

픽스처는 렌더 게이트가 만든 2,719바이트 단일 타일 COPC를
`fixtures/`의 고정 조각들로 다시 조립해 쓰고, Range 전용 로컬 서버로
서빙한다(Decision 4: 206만, 200 fallback 없음).

**스모크는 CI가 아니라 로컬 스크립트다.** OVERVIEW §5가 "publish 직전 1회"로
규정하고 CLAUDE.md가 "CI는 네트워크를 건드리지 않는다"로 규정한다 — 3단계가
네트워크를 쓰므로 둘 다 같은 답을 가리킨다. `npm test`는 지금처럼 오프라인으로
남는다. `npm run smoke`로 사람이 돌린다.

## 10. 파일 구조

**새로 만드는 것**

- `rolldown.config.mjs` — 두 설정의 배열(§11 참조). Worker가 먼저 빌드되고,
  라이브러리 설정의 플러그인이 그 결과 텍스트를 디스크에서 읽어 문자열로
  주입한다. 배열 설정은 순차 실행되므로 이 순서가 보장된다.
- `build/laz-perf-wasm.mjs` — §6의 공유 플러그인
- `tsconfig.build.json` — `src`만, `emitDeclarationOnly`
- `src/worker/browser.ts` — §4의 두 역할 모듈
- `src/worker/lazperf.ts` — web 빌드 인스턴스 생성·캐시
- `src/cesium-runtime/spawn.ts` — Blob Worker 기본 경로와 `browserPort`
- `smoke/run.mjs`, `smoke/app/`, `smoke/smoke.spec.mjs` — §9
- `smoke/README.md` — 무엇을 판정하고 무엇을 판정하지 않는지

**고치는 것**

- `package.json` — `exports`·`types`·`files`·`scripts.build`·`scripts.smoke`,
  devDependencies 다섯 개
- `src/worker/decode.ts` — `decompressChunk`에 인스턴스를 넘긴다
- `src/cesium-runtime/provider.ts` — `spawnWorker`를 선택으로
- `src/errors/provider.ts` — `WorkerBundleMissingError`
- `src/index.ts` — `browserPort` export, Worker 주석 갱신
- `vitest.config.ts` — laz-perf alias, 패키지 이름 alias, wasm 플러그인
- `tests/package-root-api.test.ts` — 주석의 주장 철회
- `tests/worker-boundary.test.ts` — `browser.ts`까지 검사
- `src/worker/README.md`, `docs/superpowers/plans/carried-forward.md`
- `OVERVIEW.md` §5 — 빌드 줄을 §11의 근거와 함께 갱신
- `tsconfig.json` — WebWorker lib 관련 주석. 그 주석은 "worker 번들이 도착하면
  `src/worker/`가 자기 설정을 갖는다"고 약속하지만, §4의 자기 설치 가드는
  다섯 줄짜리 구조적 타입으로 충분해 두 번째 프로그램을 만들지 않는다.
  약속을 지키지 않기로 했으면 주석이 그렇게 말해야 한다.

## 11. 번들러와 의존성

**번들러는 `rolldown`이다.** OVERVIEW §5는 Rollup이라 적었고, 그 의도 —
"라이브러리 + 자체완결 Worker 번들을 만드는 진짜 번들러" — 는 그대로
지켜진다. 이름이 바뀌는 이유는 측정이다.

순정 `rollup`은 TypeScript를 스스로 벗기지 못해 트랜스폼 플러그인이 필요한데,
`@rollup/plugin-typescript`는 TS 7이 노출하지 않는 JS 컴파일러 API를 요구한다
(OVERVIEW §5가 이미 기록한 제약이다). 남는 길은 `esbuild`를 새로 들이거나
Node의 experimental `module.stripTypeScriptTypes`에 기대는 것뿐이다.

rolldown은 Rollup 호환 설정 API를 쓰면서 oxc로 TS를 네이티브로 벗고 CJS도
스스로 처리한다. 실측: `src/worker/entry.ts`를 입력으로 434,353바이트 번들이
75ms에 나왔고, TS는 제거됐으며 CJS인 laz-perf가 해석됐고 `require("fs")`와
`__dirname`은 0건이었다. `@rollup/plugin-node-resolve`도
`@rollup/plugin-commonjs`도 필요 없다. Vite 8 자신이 rolldown 위에 서 있으므로
툴체인이 둘로 갈라지지도 않는다.

**OVERVIEW §5의 빌드 줄을 이 근거와 함께 갱신하는 것이 이 서브프로젝트의
산출물에 포함된다.** 근거 없이 헌법을 바꾸지 않되, 측정으로 틀렸음이 드러난
줄을 그대로 두지도 않는다.

devDependencies에 셋을 더한다: `rolldown`, `vite`, `@playwright/test`.
(`rolldown`은 지금 vite의 전이 의존성으로 설치돼 있을 뿐이므로 명시적으로
선언한다 — 전이 의존성에 기대는 빌드는 다음 `npm install`에 깨진다.)
**런타임 의존성은 늘지 않는다** — copc.js·laz-perf·proj4 그대로다.

## 12. 남는 위험과 이 설계가 하지 않는 것

- **CSP.** Blob Worker는 `worker-src blob:`을 막는 환경에서 죽는다. 고칠 수
  있는 것이 아니라 알려야 하는 것이다. `./worker` 서브패스와 `spawnWorker`가
  그 경우의 답이고, README 소유자에게 넘길 사실 목록에 이것을 추가한다.
- **`dist/index.js` 크기.** `copc`를 넣고 Worker 텍스트를 문자열로 품으므로
  메인 번들이 커진다. 얼마나 커지는지는 빌드해 봐야 안다 — 구현 중 실측해
  스모크 README에 기록한다. 임의의 상한을 미리 정하지 않는다.
- **소비자 번들러가 `browser` 필드를 존중하지 않는 경우.** `copc`가 external
  이므로 laz-perf 해석은 소비자 번들러의 몫이고, §3.1의 안전은 laz-perf의
  `browser` 필드에 달려 있다. 그 필드를 무시하는 도구는 node 빌드를 끌어와
  `require("fs")`에서 깨진다. 우리가 고칠 수 있는 것이 아니라 알려야 하는
  것이므로, README 소유자에게 넘길 사실 목록에 추가한다. §9의 스모크는 Vite로
  빌드하므로 이 경로를 재지 못한다.
- **한 브라우저.** 판정은 headless Chromium에서만 이뤄진다. Firefox·Safari의
  module worker와 CSP 거동은 측정되지 않는다.
- **cesium-runtime 두 항목은 그대로 열려 있다.** §1이 밝힌 대로다.
