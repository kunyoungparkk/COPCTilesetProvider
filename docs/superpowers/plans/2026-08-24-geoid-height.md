# geoid Height Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 호출자가 데이터셋 하나당 상수 `geoidHeight`(미터)를 넘겨 정표고 기준 파일의 수직 오차를 없앨 수 있게 한다.

**Architecture:** 숫자 하나를 기존 CRS 이음매에 끼운다. `createTransformFromDefinition`이 단위 환산 뒤에 그 값을 더하고, `toWgs84`/`toEcef`가 같은 내부 `project`를 쓰므로 포인트(Worker)·region bounding volume·geometricError(메인 스레드)가 함께 내려간다. 파일이 `VERT_CS`를 선언했는데 값이 없으면 로드는 하되 경고한다.

**Tech Stack:** TypeScript 7, proj4 2.21, Vitest, Node 22

**Spec:** `docs/superpowers/specs/2026-08-24-geoid-height-design.md`

## Global Constraints

- 새 의존성 금지 (OVERVIEW §5: copc.js·laz-perf·proj4 외 추가는 확인 후).
- 코드·주석·커밋 메시지·에러/경고 문구는 **영어**. 이 계획서와 스펙만 한국어.
- 주석은 *왜*를 적는다. OVERVIEW 결정을 인용할 때는 `// Decision 6: ...` 형태.
- 테스트는 `fixtures/`의 고정 파일만 쓴다. 네트워크 접근 금지.
- 각 단정은 해당 코드를 변형해 실제로 실패하는지 확인한 뒤 확정한다.
- 검증 명령: `npm run typecheck`, `npm test`.
- **기본값의 주인은 한 곳이다** — `createTransformFromDefinition(definition, geoidHeight = 0)`.
  Worker 프로토콜과 `EncodeNodeInput`은 이 값을 **선택 필드**로 나른다. 필수로 만들면
  높이와 무관한 기존 테스트 13곳이 `geoidHeight: 0`을 적게 되고, 그 잡음이 회귀 신호를
  가린다. 선택 필드가 `exactOptionalPropertyTypes`와 부딪히는 자리에서는 이 저장소가
  이미 쓰는 조건부 spread 관용구를 따른다 (`provider.ts`의 `...(options.fetch !== undefined && { fetch: options.fetch })`).

---

### Task 1: 파일의 수직 EPSG 코드 읽기

`horizontal-code.ts`의 스캔 루프는 AUTHORITY 노드를 바로 위 키워드로 키를 잡아 맵에 넣는다. `VERT_CS`는 **이미 그 맵에 들어 있고** 읽어가는 코드만 없다. 루프를 내부 함수로 빼고 리더 둘을 얹는다.

**Files:**
- Create: `src/crs/epsg-codes.ts` (`src/crs/horizontal-code.ts`를 `git mv`)
- Delete: `src/crs/horizontal-code.ts` (위 이동으로 사라짐)
- Modify: `src/crs/index.ts:13` — 재수출 경로와 `findVerticalEpsgCode` 추가
- Modify: `src/crs/resolve.ts:2` — import 경로
- Modify: `tests/import-closure.test.ts:217` — 주석 안의 경로 문자열
- Test: `tests/crs-epsg-codes.test.ts` (`tests/crs-horizontal-code.test.ts`를 `git mv`)

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `findVerticalEpsgCode(wkt: string): number | null` — `src/crs/epsg-codes.ts`에서 export하고 `src/crs/index.ts`에서 재수출. `findHorizontalEpsgCode(wkt: string): number | null`는 시그니처·동작 그대로.

- [ ] **Step 1: 파일과 테스트를 새 이름으로 옮긴다**

```bash
git mv src/crs/horizontal-code.ts src/crs/epsg-codes.ts
git mv tests/crs-horizontal-code.test.ts tests/crs-epsg-codes.test.ts
```

`tests/crs-epsg-codes.test.ts`의 import를 고친다:

```ts
import { findHorizontalEpsgCode } from '../src/crs/epsg-codes.js';
```

`src/crs/resolve.ts:2`:

```ts
import { findHorizontalEpsgCode } from './epsg-codes.js';
```

`src/crs/index.ts:13`:

```ts
export { findHorizontalEpsgCode, findVerticalEpsgCode } from './epsg-codes.js';
```

`tests/import-closure.test.ts:217`의 주석에서 `src/crs/horizontal-code.ts` → `src/crs/epsg-codes.ts`.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`tests/crs-epsg-codes.test.ts` 끝에 추가:

```ts
describe('findVerticalEpsgCode', () => {
  // The whole point: this is how the library learns a file measures height
  // from a geoid rather than from the ellipsoid.
  it('finds the vertical system in the real file', async () => {
    expect(findVerticalEpsgCode(await autzenWkt())).toBe(6360);
  });

  it('reads the vertical system out of a compound, whichever order it is in', () => {
    const wkt =
      'COMPD_CS["c",VERT_CS["v",AUTHORITY["EPSG","6360"]],' +
      'PROJCS["p",AUTHORITY["EPSG","2992"]]]';

    expect(findVerticalEpsgCode(wkt)).toBe(6360);
  });

  // A file with no vertical system says nothing about its heights, and the
  // caller reads that null as "no warning to give".
  it('returns null when there is no vertical system', () => {
    const wkt = 'PROJCS["x",GEOGCS["g",AUTHORITY["EPSG","4269"]],AUTHORITY["EPSG","2992"]]';

    expect(findVerticalEpsgCode(wkt)).toBeNull();
  });

  // The vertical datum sits one level below the vertical system and carries a
  // code of its own (5103 in the pinned file). Reading that one instead would
  // name a datum where the caller expects a CRS.
  it('takes the vertical system and not the vertical datum inside it', () => {
    const wkt =
      'VERT_CS["NAVD88",VERT_DATUM["d",2005,AUTHORITY["EPSG","5103"]],AUTHORITY["EPSG","6360"]]';

    expect(findVerticalEpsgCode(wkt)).toBe(6360);
  });
});
```

import 줄도 함께 고친다:

```ts
import { findHorizontalEpsgCode, findVerticalEpsgCode } from '../src/crs/epsg-codes.js';
```

- [ ] **Step 3: 실패를 확인한다**

Run: `npx vitest run tests/crs-epsg-codes.test.ts`
Expected: FAIL — `findVerticalEpsgCode is not exported by ../src/crs/epsg-codes.js`

- [ ] **Step 4: 스캔 루프를 빼고 리더 둘을 얹는다**

`src/crs/epsg-codes.ts`에서 `findHorizontalEpsgCode`의 본문 중 **루프 전체**(`const found = ...`부터 for 루프 끝까지)를 아래 내부 함수로 옮긴다. 루프 안의 기존 주석은 그대로 따라간다.

```ts
/**
 * Every EPSG code the WKT carries, keyed by the keyword its AUTHORITY node
 * sits directly inside — `PROJCS`, `GEOGCS`, `VERT_CS`, and whatever else the
 * file names.
 *
 * Keyed by parent rather than collected in order because a code's meaning is
 * its position: Autzen's WKT holds ten AUTHORITY nodes, and 2992, 4269, 6360
 * and 5103 are all in there saying different things. The horizontal reader and
 * the vertical one are two questions asked of one walk.
 */
function scanAuthorities(wkt: string): { found: Map<string, number>; sawProjected: boolean } {
  // ... 기존 루프 본문 그대로 ...
  return { found, sawProjected };
}
```

그 위에 리더 둘:

```ts
export function findHorizontalEpsgCode(wkt: string): number | null {
  const { found, sawProjected } = scanAuthorities(wkt);

  // 기존 해석 주석 세 덩어리를 그대로 유지한다.
  const projected = found.get('PROJCS');
  if (projected !== undefined) {
    return projected;
  }
  if (sawProjected) {
    return null;
  }
  return found.get('GEOGCS') ?? null;
}

/**
 * Finds the EPSG code of the file's vertical coordinate system.
 *
 * Unlike the horizontal one this answer never chooses a transform — nothing
 * here resolves a vertical CRS. It exists so `fromUrl` can tell a file that
 * measures height from a geoid apart from one that does not, and warn when the
 * caller has given it no `geoidHeight` to correct with.
 *
 * Returns `null` when the file names no vertical system, which the caller
 * reads as "nothing to warn about".
 */
export function findVerticalEpsgCode(wkt: string): number | null {
  return scanAuthorities(wkt).found.get('VERT_CS') ?? null;
}
```

`findHorizontalEpsgCode`의 doc comment에서 마지막 문장을 고친다 — 이제 거짓이다:

```
- * OVERVIEW §6 keeps heights ellipsoidal, so the vertical system is never
- * consulted.
+ * The vertical system is a separate question, asked by `findVerticalEpsgCode`
+ * off the same walk.
```

- [ ] **Step 5: 통과와 무회귀를 확인한다**

Run: `npx vitest run tests/crs-epsg-codes.test.ts tests/import-closure.test.ts && npm run typecheck`
Expected: PASS — 새 단정 4개 + `findHorizontalEpsgCode`의 기존 단정 전부.

- [ ] **Step 6: 변형으로 단정을 확정한다**

`findVerticalEpsgCode`가 `found.get('VERT_DATUM')`를 읽도록 잠깐 바꾸고 테스트를 돌려 "vertical datum" 케이스가 실패하는지 본다. 확인 후 되돌린다.

- [ ] **Step 7: 커밋**

```bash
git add -A src/crs tests/crs-epsg-codes.test.ts tests/import-closure.test.ts
git commit -m "refactor(crs): read the vertical EPSG code off the same WKT walk"
```

---

### Task 2: transform이 geoid 높이를 받는다

**Files:**
- Modify: `src/crs/transform.ts` — `createTransformFromDefinition` 시그니처와 `project`
- Test: `tests/crs-transform.test.ts`

**Interfaces:**
- Consumes: Task 1은 필요 없음 (독립)
- Produces: `createTransformFromDefinition(definition: string, geoidHeight?: number): CrsTransform`. 두 번째 인자의 기본값은 `0`이며, **이 기본값이 프로젝트 전체에서 유일한 주인**이다. 적용 순서는 `z * metresPerZ + geoidHeight` — 단위 환산 뒤.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/crs-transform.test.ts`에 추가. 파일 위쪽의 `OREGON`, `FOOT`, `metresApart`, `autzenWkt`를 그대로 쓴다.

```ts
describe('geoid height', () => {
  // Autzen's own Z is NAVD88 orthometric, and NGS puts the geoid 23.333 m
  // below the ellipsoid there. Given that number the transform has to lower
  // the point by exactly it — no more, and along the local vertical rather
  // than along any axis.
  const AUTZEN_GEOID_HEIGHT = -23.333;
  // The file header's own offset point, which is inside the data.
  const POINT = { x: 637290.75, y: 851209.9, z: 406.14 };

  it('moves a point by the geoid height it is given', async () => {
    registerCrs(2992, OREGON);
    const definition = resolveCrsDefinition(await autzenWkt());

    const plain = createTransformFromDefinition(definition);
    const corrected = createTransformFromDefinition(definition, AUTZEN_GEOID_HEIGHT);

    const a = plain.toEcef(POINT.x, POINT.y, POINT.z);
    const b = corrected.toEcef(POINT.x, POINT.y, POINT.z);

    expect(metresApart(a, b)).toBeCloseTo(Math.abs(AUTZEN_GEOID_HEIGHT), 6);
    // Direction, not just magnitude: a negative geoid height brings the point
    // closer to the centre of the earth.
    expect(Math.hypot(...b)).toBeLessThan(Math.hypot(...a));
  });

  it('adds the geoid height after the linear unit, not before it', async () => {
    registerCrs(2992, OREGON);
    const definition = resolveCrsDefinition(await autzenWkt());

    const [, , plainHeight] = createTransformFromDefinition(definition).toWgs84(
      POINT.x, POINT.y, POINT.z,
    );
    const [, , correctedHeight] = createTransformFromDefinition(
      definition,
      AUTZEN_GEOID_HEIGHT,
    ).toWgs84(POINT.x, POINT.y, POINT.z);

    // The file is in feet. Were the offset added before the scale it would
    // arrive multiplied by 0.3048 — 7.1 m instead of 23.333 m.
    expect(plainHeight).toBeCloseTo(POINT.z * FOOT, 9);
    expect(correctedHeight).toBeCloseTo(POINT.z * FOOT + AUTZEN_GEOID_HEIGHT, 9);
  });

  // Every existing caller passes one argument. This is the guard that says so.
  it('changes nothing when it is not given', async () => {
    registerCrs(2992, OREGON);
    const definition = resolveCrsDefinition(await autzenWkt());

    expect(createTransformFromDefinition(definition).toEcef(POINT.x, POINT.y, POINT.z)).toEqual(
      createTransformFromDefinition(definition, 0).toEcef(POINT.x, POINT.y, POINT.z),
    );
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/crs-transform.test.ts`
Expected: FAIL — 두 번째 인자가 무시되어 `metresApart`가 0, `toBeCloseTo(23.333)`가 깨진다.

- [ ] **Step 3: 최소 구현**

`src/crs/transform.ts`:

```ts
export function createTransformFromDefinition(
  definition: string,
  geoidHeight = 0,
): CrsTransform {
  rejectUnusableDefinition(definition);

  const toWgs84Projection = proj4(definition, WGS84);
  const metresPerZ = metresPerUnit(definition);

  const project = (x: number, y: number, z: number): [number, number, number] => {
    const [longitude, latitude] = toWgs84Projection.forward([x, y]);
    return [longitude, latitude, z * metresPerZ + geoidHeight];
  };
```

doc comment에 문단 하나를 잇는다:

```
 * `geoidHeight` is the geoid's separation from the ellipsoid at this file's
 * location, in metres — `h = H + N`, so it is added, and the caller's number is
 * N as geodesy publishes it. It lands after the linear unit because it is a
 * datum offset and not a unit: a file in feet still takes its correction in
 * metres. Zero, the default, is the ellipsoidal-height assumption every caller
 * had before the option existed. Its accuracy is the caller's to vouch for,
 * the way a registered definition's is (Decision 6), and one constant is only
 * right over an extent small enough that N does not vary across it.
```

`CrsTransform.toEcef`의 doc comment에서 OVERVIEW §6을 "ellipsoidal heights"라고 인용한 문장을 고친다:

```
- * as `x` and `y`, which is a v1 limitation of its own alongside OVERVIEW §6's
- * ellipsoidal heights: a file measuring height in a unit its horizontal
- * system does not use comes out vertically scaled.
+ * as `x` and `y`: a file measuring height in a unit its horizontal system does
+ * not use comes out vertically scaled. That is a v1 limitation of its own, and
+ * distinct from the datum offset `geoidHeight` corrects.
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run tests/crs-transform.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 변형으로 단정을 확정한다**

`z * metresPerZ + geoidHeight`를 `(z + geoidHeight) * metresPerZ`로 잠깐 바꾸고 "after the linear unit" 테스트가 실패하는지 본다. 확인 후 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add src/crs/transform.ts tests/crs-transform.test.ts
git commit -m "feat(crs): let a transform carry a geoid height"
```

---

### Task 3: Worker 경계까지 배선

메인 스레드와 Worker가 **같은** transform을 만들어야 한다. 한쪽만 보정되면 포인트와 bounding volume이 어긋나 Decision 6의 완전 포함 계약이 깨진다.

**Files:**
- Modify: `src/worker/protocol.ts:15` — `init` 메시지
- Modify: `src/worker/pool.ts:39-45, 179, 241` — 옵션과 post
- Modify: `src/worker/entry.ts:20-38, 54-59` — 보관과 전달
- Modify: `src/worker/pipeline.ts:14-19, 65` — 입력과 transform 생성
- Test: `tests/worker-pipeline.test.ts`, `tests/worker-entry.test.ts`

**Interfaces:**
- Consumes: `createTransformFromDefinition(definition, geoidHeight?)` (Task 2)
- Produces:
  - `ToWorker` init: `{ kind: 'init'; id: number; definition: string; geoidHeight?: number }`
  - `WorkerPoolOptions.geoidHeight?: number`
  - `EncodeNodeInput.geoidHeight?: number`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/worker-pipeline.test.ts` — 기존 `encodeNode` 호출과 같은 fixture를 쓴다:

```ts
it('carries the geoid height into the positions it encodes', async () => {
  const plain = await encodeNode({ compressed, header, pointCount, definition });
  const lowered = await encodeNode({
    compressed,
    header,
    pointCount,
    definition,
    geoidHeight: -23.333,
  });

  // PNTS RTC_CENTER is the midpoint of the transformed points' ECEF box, so a
  // vertical datum shift moves it and nothing else about the tile changes.
  expect(rtcCenterOf(lowered)).not.toEqual(rtcCenterOf(plain));
  expect(Math.hypot(...rtcCenterOf(lowered))).toBeLessThan(Math.hypot(...rtcCenterOf(plain)));
  expect(lowered.byteLength).toBe(plain.byteLength);
});
```

같은 파일 위쪽에 헬퍼를 둔다. PNTS는 28바이트 헤더 뒤에 feature table JSON이 오고, `RTC_CENTER`는 그 JSON 안의 세 숫자다:

```ts
/** The RTC_CENTER a PNTS buffer declares, read out of its feature table JSON. */
function rtcCenterOf(pnts: ArrayBuffer): [number, number, number] {
  const view = new DataView(pnts);
  const jsonLength = view.getUint32(12, true);
  const json = new TextDecoder().decode(new Uint8Array(pnts, 28, jsonLength));
  return JSON.parse(json).RTC_CENTER;
}
```

`tests/worker-entry.test.ts` — init에 실린 값이 encode까지 살아남는지. 이 파일이 이미 가진
`loadNode()`, `collector()`, `fixture()`, `createWorkerHandler`를 쓴다. **`encodePnts`를 모킹하는
describe 블록 밖에** 새 describe로 둘 것 — 이 단정은 실제로 인코딩된 바이트를 비교한다.

```ts
describe('createWorkerHandler carries the geoid height', () => {
  /** Runs one init/encode pair and returns the pnts bytes it replied with. */
  const encodeWith = async (geoidHeight?: number): Promise<Uint8Array> => {
    const { header, pointCount, definition } = await loadNode();
    const { sent, post } = collector();
    const handler = createWorkerHandler(post);

    await handler({
      kind: 'init',
      id: 1,
      definition,
      ...(geoidHeight !== undefined && { geoidHeight }),
    });
    await handler({
      kind: 'encode',
      id: 2,
      compressed: fixture('autzen-node-5-16-3-1.bin').buffer as ArrayBuffer,
      header,
      pointCount,
    });

    const reply = sent[1];
    if (reply?.kind !== 'done') {
      throw new Error(`expected a done reply, got ${JSON.stringify(reply)}`);
    }
    return new Uint8Array(reply.pnts);
  };

  // The height rides one init message and has to outlive it: every encode
  // afterwards builds its own transform, and a handler that stored the
  // definition but dropped the height would still answer done — with points
  // in the wrong place.
  it('applies an init geoid height to a later encode', async () => {
    const plain = await encodeWith();
    const lowered = await encodeWith(-23.333);

    expect(lowered.byteLength).toBe(plain.byteLength);
    expect(lowered).not.toEqual(plain);
  });

  it('encodes identically when no height is given', async () => {
    expect(await encodeWith()).toEqual(await encodeWith(0));
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/worker-pipeline.test.ts tests/worker-entry.test.ts`
Expected: FAIL — 타입 에러(알 수 없는 속성 `geoidHeight`) 또는 두 결과가 동일.

- [ ] **Step 3: 프로토콜과 파이프라인을 잇는다**

`src/worker/protocol.ts`:

```ts
export type ToWorker =
  | {
      readonly kind: 'init';
      readonly id: number;
      readonly definition: string;
      /**
       * OVERVIEW §6's geoid offset, in metres. Optional on the wire so the
       * default has one owner — `createTransformFromDefinition` — rather than
       * one per hop.
       */
      readonly geoidHeight?: number;
    }
  | { /* encode: 그대로 */ };
```

`src/worker/pipeline.ts`:

```ts
export interface EncodeNodeInput {
  compressed: Uint8Array;
  header: DecodeHeader;
  pointCount: number;
  definition: string;
  geoidHeight?: number;
}
```

```ts
  const transform = createTransformFromDefinition(input.definition, input.geoidHeight);
```

`src/worker/entry.ts` — `definition` 옆에 함께 보관한다:

```ts
  let definition: string | undefined;
  let geoidHeight: number | undefined;
```

init 분기:

```ts
        createTransformFromDefinition(message.definition, message.geoidHeight);
        definition = message.definition;
        geoidHeight = message.geoidHeight;
```

encode 분기 — `exactOptionalPropertyTypes` 때문에 조건부 spread를 쓴다:

```ts
      const pnts = await encodeNode({
        compressed: new Uint8Array(message.compressed),
        header: message.header,
        pointCount: message.pointCount,
        definition,
        ...(geoidHeight !== undefined && { geoidHeight }),
      });
```

`src/worker/pool.ts` — 옵션에 더하고, 같은 관용구로 싣는다:

```ts
export interface WorkerPoolOptions {
  readonly spawn: () => WorkerPort;
  readonly definition: string;
  /** Fixed for the pool's whole lifetime, like `definition`: it rides the one `init` message each slot gets. */
  readonly geoidHeight?: number;
  readonly budget: Budget;
  readonly size?: number;
}
```

```ts
  const { spawn, definition, geoidHeight, budget } = options;
```

```ts
      port.post(
        { kind: 'init', id: initId, definition, ...(geoidHeight !== undefined && { geoidHeight }) },
        [],
      );
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS — 새 단정과 기존 스위트 전부. 기존 13개 호출부는 손대지 않는다.

- [ ] **Step 5: 변형으로 단정을 확정한다**

`entry.ts`의 encode 분기에서 `geoidHeight` spread를 지우고 worker-entry 테스트가 실패하는지 본다. 확인 후 되돌린다. (init만 배선하고 encode를 빠뜨리는 것이 이 태스크의 가장 그럴듯한 실수다.)

- [ ] **Step 6: 커밋**

```bash
git add src/worker tests/worker-pipeline.test.ts tests/worker-entry.test.ts
git commit -m "feat(worker): carry the geoid height across the realm boundary"
```

---

### Task 4: 공개 옵션과 경고

**Files:**
- Modify: `src/cesium-runtime/provider.ts:47-...` (옵션), `:307-308` (transform), `:378-383` (pool)
- Test: `tests/cesium-provider.test.ts`

**Interfaces:**
- Consumes: `findVerticalEpsgCode` (Task 1), `createTransformFromDefinition(definition, geoidHeight?)` (Task 2), `WorkerPoolOptions.geoidHeight` (Task 3)
- Produces: `COPCTilesetProviderOptions.geoidHeight?: number` — 공개 API

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/cesium-provider.test.ts`. 이 파일의 기존 `spawnWorker`/`fetch` 페이크와 `autzenFetchWithWkt(wkt)`를 그대로 쓴다.

```ts
describe('geoidHeight', () => {
  it('hands the same geoid height to both realms', async () => {
    const createPool = vi.spyOn(poolModule, 'createWorkerPool');
    const { fetch } = autzenFetch();

    const provider = await COPCTilesetProvider.fromUrl(FILE_URL, {
      spawnWorker,
      fetch,
      geoidHeight: -23.333,
    });

    // The Worker's half.
    expect(createPool.mock.calls[0]?.[0]?.geoidHeight).toBe(-23.333);
    // The main thread's half: the tileset's own root sits lower by that much
    // than the same file loaded without it.
    expect(provider.tileset.root.boundingVolume).toBeDefined();
    createPool.mockRestore();
  });

  // Decision 6's stance, applied to the vertical: a file that says its heights
  // are geoid-referenced and a caller who said nothing is a mismatch worth
  // naming — but not worth refusing, since the caller may not know N.
  it('warns when the file declares a vertical system and no height was given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetch } = autzenFetch();

    await COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    // The message is API: it names the code it found and the call to paste.
    expect(message).toContain('EPSG:6360');
    expect(message).toContain('geoidHeight');
    warn.mockRestore();
  });

  it('stays quiet when the caller gave a height', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetch } = autzenFetch();

    await COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch, geoidHeight: -23.333 });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // A file with no vertical system has said nothing about its heights, so
  // there is nothing to correct and nothing to warn about.
  it('stays quiet when the file declares no vertical system', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wkt = 'PROJCS["Oregon",GEOGCS["NAD83",AUTHORITY["EPSG","4269"]],AUTHORITY["EPSG","2992"]]';

    await COPCTilesetProvider.fromUrl(FILE_URL, {
      spawnWorker,
      fetch: autzenFetchWithWkt(wkt).fetch,
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

`autzenFetch()`는 이 파일이 기본 fetch 페이크를 만드는 기존 이름에 맞춘다 — 구현자는 `tests/cesium-provider.test.ts:141` 주변의 형태를 따를 것.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/cesium-provider.test.ts`
Expected: FAIL — `geoidHeight`가 옵션 타입에 없고, `console.warn`이 호출되지 않는다.

- [ ] **Step 3: 옵션과 경고를 구현한다**

`COPCTilesetProviderOptions`에 추가:

```ts
  /**
   * The geoid's separation from the WGS84 ellipsoid at this file's location,
   * in metres, added to every height — `h = H + N`, so this is N as geodesy
   * publishes it (negative across North America). Omit it for a file whose Z
   * is already ellipsoidal.
   *
   * One constant, so it is right only over an extent small enough that the
   * separation does not vary across it — a survey site, not a continent. Its
   * accuracy is the caller's to vouch for, the way a registered CRS
   * definition's is (Decision 6).
   */
  readonly geoidHeight?: number;
```

`fromUrl` 안, `:307` 자리:

```ts
    const definition = resolveCrsDefinition(file.wkt);
    const transform = createTransformFromDefinition(definition, options.geoidHeight);

    warnIfHeightsAreUncorrected(file.wkt, options.geoidHeight, file.header, transform);
```

pool 생성부(`:378`)에 조건부 spread로 싣는다:

```ts
    const workerPool = createWorkerPool({
      spawn: options.spawnWorker ?? spawnBundledWorker,
      definition,
      ...(options.geoidHeight !== undefined && { geoidHeight: options.geoidHeight }),
      budget,
      size: workerPoolSize,
    });
```

같은 파일 아래쪽에 모듈 수준 함수 하나:

```ts
/**
 * Says so, once, when a file measures height from a geoid and the caller gave
 * nothing to correct it with.
 *
 * A warning rather than a typed error, which is where this parts company with
 * Decision 6's treatment of an unregistered horizontal CRS. The asymmetry is
 * deliberate: an unresolvable horizontal system leaves the points nowhere at
 * all, while an uncorrected height leaves them somewhere wrong by a knowable
 * amount — and refusing the file would strand a caller who does not know N.
 *
 * The message follows the same rule the errors do: it names what was found and
 * the call to paste. The centre comes from the header so the caller has the
 * coordinates to look N up with, and no particular service is named — which
 * one is right depends on the country the data is in.
 */
function warnIfHeightsAreUncorrected(
  wkt: string | undefined,
  geoidHeight: number | undefined,
  // The same slice `measureRootGeometricError` takes, for the same reason:
  // the extent is all this needs, and naming it says so.
  header: Pick<Las.Header, 'min' | 'max'>,
  transform: CrsTransform,
): void {
  if (geoidHeight !== undefined || wkt === undefined) {
    return;
  }
  const code = findVerticalEpsgCode(wkt);
  if (code === null) {
    return;
  }

  const centreX = ((header.min[0] ?? 0) + (header.max[0] ?? 0)) / 2;
  const centreY = ((header.min[1] ?? 0) + (header.max[1] ?? 0)) / 2;
  const [longitude, latitude] = transform.toWgs84(centreX, centreY, 0);

  console.warn(
    `copc-tileset-provider: this file declares vertical CRS EPSG:${code}, which measures ` +
      `height from a geoid, but no geoidHeight was given. Its points will be off by the geoid ` +
      `separation at this location (worldwide, roughly -107 m to +85 m). Look up the geoid ` +
      `height N at this dataset's centre (${latitude.toFixed(4)}, ${longitude.toFixed(4)}) and ` +
      `pass it in metres:\n\n  COPCTilesetProvider.fromUrl(url, { geoidHeight: N })\n\n` +
      `A file whose heights are already ellipsoidal silences this with geoidHeight: 0.`,
  );
}
```

`findVerticalEpsgCode`와 `CrsTransform` 타입을 `../crs/index.js`에서, `Las` 타입을 `copc`에서 import한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 변형으로 단정을 확정한다**

`warnIfHeightsAreUncorrected`의 `if (code === null) return;`를 지우고 "declares no vertical system" 테스트가 실패하는지 본다. 확인 후 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add src/cesium-runtime/provider.ts tests/cesium-provider.test.ts
git commit -m "feat(provider): accept a geoidHeight, and say so when one is missing"
```

---

### Task 5: 문서 — **사용자 확인 체크포인트**

OVERVIEW는 프로젝트 헌법이다. 이 태스크는 **문구를 먼저 제시하고 승인을 받은 뒤** 적용한다.

**Files:**
- Modify: `OVERVIEW.md` §6의 geoid 항목, §3 Decision 6의 CRS 항목
- Modify: `README.md:162-165`
- Modify: `examples/main.js`, `examples/README.md` (데모에 `geoidHeight: -23.333` 적용)

- [ ] **Step 1: OVERVIEW §6 문구를 제시하고 승인받는다**

제안:

```
- 정표고(geoid) 보정의 자동화 — 파일 하나당 상수 오프셋(`geoidHeight`)은 호출자가
  넘길 수 있다. 자동으로 구하지는 않는다: geoid 격자를 읽거나 조회 서비스를 부르는
  것은 v1 비목표다. 오프셋을 안 주면 높이는 타원체고(HAE)로 취급되고, 파일이
  수직계를 선언했다면 경고한다. 상수 하나이므로 그 값이 유효한 것은 분리량이
  변하지 않는 범위 안에서다.
```

Decision 6의 CRS 항목에 한 줄:

```
  - 수직: 파일의 `VERT_CS` 코드는 경고 판단에만 쓴다. 높이 보정은 `geoidHeight`
    옵션이 받은 상수 하나이고, 정확성은 등록자 책임이라는 같은 규칙을 따른다.
```

- [ ] **Step 2: 승인된 문구를 적용한다**

- [ ] **Step 3: README.md:162 문단을 잇는다**

```markdown
**Heights are ellipsoidal.** Every Z is treated as height above the WGS84
ellipsoid (HAE). Data stored as orthometric height — above a geoid — will sit at
a visible vertical offset unless you correct it. Pass the geoid separation at
your dataset's location, in metres:

```js
await COPCTilesetProvider.fromUrl(url, { geoidHeight: -23.333 });
```

That is one constant for the whole file, so it holds over an extent where the
separation does not vary — a survey site, not a continent. Grid-based
correction is out of scope for v1, as it is for the implementations this
library follows. A file that declares a vertical CRS and gets no `geoidHeight`
loads anyway, with a console warning naming the code it found.
```

- [ ] **Step 4: 데모에 적용한다**

`examples/main.js`의 `showCopc`:

```js
  const provider = await COPCTilesetProvider.fromUrl(url, {
    // Autzen's Z is NAVD88 orthometric; NGS puts the geoid 23.333 m below the
    // ellipsoid here. Without this the points float that far over the terrain.
    geoidHeight: AUTZEN_GEOID_HEIGHT,
  });
```

파일 위쪽에:

```js
// Geoid height at Autzen (44.0587, -123.0687), from NOAA's NGS geoid service.
// The value belongs to this dataset's location, not to the library.
const AUTZEN_GEOID_HEIGHT = -23.333;
```

`examples/README.md`에 한 문단을 더해, 이 값이 어디서 왔고 왜 데이터셋마다 다른지 적는다.

- [ ] **Step 5: 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS

배포 후 데모를 열어 포인트가 지형에 얹혔는지 눈으로 본다. §2에서 계산한 잔차는 0이 되어야 한다 — 남으면 그 차이가 다음 단서다.

- [ ] **Step 6: 커밋**

```bash
git add OVERVIEW.md README.md examples/
git commit -m "docs: geoid height is a caller-supplied constant, not a non-goal"
```

---

## 실행 순서와 의존

Task 1과 Task 2는 서로 독립이라 순서를 바꿔도 된다. Task 3은 Task 2를, Task 4는 1·2·3 전부를 필요로 한다. Task 5는 마지막이고 사용자 승인이 걸려 있다.
