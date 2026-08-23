# 취소와 hierarchy 예산 — 설계

## 1. 무엇을 닫는가

`docs/superpowers/plans/carried-forward.md`의 **cesium-runtime 섹션 두 항목**.

- 강제되지 않는 hierarchy 예산 — 항상 0을 읽는 카운터
- `src/cesium-runtime/`에 `AbortSignal`이 하나도 없는 것

두 항목 모두 "배선만 하면 된다"가 아니었고, 파고 보니 각각 그보다 앞선
사실이 있었다. 이 스펙은 그 사실들 위에 서 있다.

## 2. 측정한 것

설계 이전에 실측한 다섯 가지. 각각이 아래 결정 하나씩을 강제한다.

**(a) `resource.request`는 우리 손에 있다.** `Cesium3DTile.js`의
`requestSingleContent`가 `resource.request = request`를 `fetchArrayBuffer()`
호출 **직전에** 설정한다. 그래서 `ScheduledRangeResource.fetchArrayBuffer` 안의
`this.request`는 `tile.cancelRequests()`가 취소하는 바로 그 객체다.

**(b) 취소는 플래그일 뿐이다.** `Request.prototype.cancel`은
`this.cancelled = true` 한 줄이다. `RequestScheduler`의 `cancelFunction`은
우리에게 오지 않는다 — 우리는 스케줄러를 통째로 우회한다. 따라서 진행 중인
fetch를 끊으려면 그 `cancel` 호출 순간을 우리가 직접 잡아야 한다.

**(c) Cesium이 취소를 부르는 조건.** `Cesium3DTileset.js`가 in-flight 목록을
돌며, 타일이 아직 `LOADING`이고 한 프레임 이상 시야를 벗어났으면
`tile.cancelRequests()`를 부른다. 즉 카메라가 지나간 타일이 대상이다.

**(d) Range 읽기 중 취소는 안전하다.** `processArrayBuffer`의 첫 catch가
`request.cancelled`를 확인하고 `_contentState`를 이전 값으로 되돌린 뒤 조용히
반환한다(`Cesium3DTile.js:1228`). 끊고 reject해도 타일은 죽지 않고 나중에 다시
요청된다.

**(e) 디코드 중 취소는 안전하지 않다.** `makeContent`를 감싼 catch는
`request.cancelled`를 **보지 않는다**(`Cesium3DTile.js:1282-1291`). 곧장
`FAILED`이고, FAILED는 종단이다(이 프로젝트가 이미 확인한 사실: FAILED 타일은
`_content`가 없어 `process()`의 게이트를 통과하지 못하고, 그래서 캐시에
재진입하지 못해 `unloadTile`에 영영 닿지 않는다).

**(f) registry는 페이지를 담지 않는다.** 코덱은 페이지를 파싱해 `buildTileset`에
넘기고 그 결과의 `entries`만 registry에 옮긴다. 파싱된 페이지는 즉시 버려진다.
Autzen 루트 페이지 하나가 278개의 `TileEntry`를 만든다.

## 3. hierarchy 예산 — 없는 것을 재던 카운터를 지운다

§7의 노브는 "hierarchy 페이지 캐시 64개, 페이지당 수 KB"라고 적혀 있다.
(f)에 따라 **그런 캐시는 존재하지 않는다.** 보관되는 것은 페이지가 아니라
`TileEntry`이고, 그 단위로 세면 "64개"는 아무 의미가 없다.

그리고 entry는 버릴 수 없다. Cesium이 타일 콘텐츠를 언로드하면 traversal이
같은 URI로 다시 요청하고, 그때 registry에 entry가 없으면
`UnknownTileRequestError`가 나고 타일은 (e)의 경로로 FAILED가 된다. 안전하게
버릴 수 있는 단위는 "어떤 페이지가 추가한 entry들을, 그 페이지의 placeholder
타일이 콘텐츠를 언로드했을 때"뿐이며, 그것은 Cesium 콘텐츠 수명주기에 훅을 하나
더 박는 일이다 — 아무도 필요하다고 측정한 적 없는 문제를 위해.

그래서:

- `Budget.acquireHierarchyPage()`와 `BudgetStats.hierarchy`를 **제거한다.**
  공개 표면이 줄어드는 변경이며, 지우는 것은 어떤 경로로도 호출되지 않고
  항상 `{admitted:0, deferred:0, rejected:0, inUse:0, peak:0}`을 읽던 필드다.
- §7의 해당 행을 은퇴시키고, 표 아래에 **왜 이 노브가 존재할 수 없었는지**를
  남긴다. 값을 바꾸는 것이 아니라 노브를 없애는 것이므로 근거가 표에 남아야
  한다.
- 그 자리에 진짜 측정을 놓는다. `ProviderStats`에 두 숫자를 더한다.

```ts
export interface ProviderStats {
  readonly range: RangeStats;
  readonly budget: BudgetStats;
  readonly synthesizedAncestors: number;
  /**
   * Tile descriptors the registry currently holds, and hierarchy pages
   * expanded so far. Both only grow: a registry entry cannot be dropped
   * because Cesium re-requests an unloaded tile by the same URI.
   */
  readonly registryEntries: number;
  readonly hierarchyPagesExpanded: number;
}
```

`registryEntries`는 `entries.size`를 그대로 읽는다. `hierarchyPagesExpanded`는
`synthesizedAncestors`가 이미 쓰는 박싱된 카운터 패턴을 따른다 — 코덱이 참조로
들고 있는 객체를 증가시키고, `stats()`가 그 살아 있는 값을 읽는다.

이것이 "정직하게"의 의미다: 강제할 수 없는 예산은 예산인 척하지 않고, 실제로
자라는 것은 셀 수 있게 된다. eviction은 이 숫자가 문제라고 말할 때 짓는다 —
§7의 규칙 그대로, 조정은 측정으로만.

## 4. Range 읽기 취소

새 파일 `src/cesium-runtime/cancellation.ts`가 (a)와 (b)를 한곳에 가둔다.

```ts
/** An `AbortSignal` that fires when Cesium cancels `request`. */
export function signalForRequest(request: unknown): AbortSignal | undefined;
```

넘겨받은 `Request` **인스턴스**의 `cancel`을 감싼다 — 프로토타입이 아니라
인스턴스이므로 다른 요청은 영향받지 않는다. 감싼 사실은 심볼 프로퍼티로
표시해 두 번 감싸지 않으며, 같은 요청에 대한 두 번째 호출은 첫 번째가 만든
신호를 돌려준다. 이미 `cancelled`인 요청에는 즉시 abort된 신호를 준다.
`request`가 없거나 `cancel`이 함수가 아니면 `undefined`를 돌려주고, 호출자는
신호 없이 진행한다 — 취소가 없는 것은 정상 동작이지 오류가 아니다.

`ScheduledRangeResource.fetchArrayBuffer`가 그 신호를 얻어
`reader.read(range, signal)`에 넘긴다. `RangeReader`는 이미 신호를 받아
진행 중인 fetch의 컨트롤러와 공유하므로(`range-reader.ts`), 취소는 왕복을
실제로 끊고 byte 예산과 host 슬롯을 즉시 돌려놓는다. abort로 인한 rejection은
(d) 덕분에 Cesium이 이미 아는 상황이다.

Decision 2의 규칙대로 Cesium 내부에 대한 이 새 의존은 `src/cesium-runtime/`
바깥으로 나가지 않는다.

## 5. `fromUrl`의 세 읽기

carried-forward는 `openCopc`도 짚었지만, `fromUrl` 시점에는 Cesium 요청이 아직
존재하지 않는다. 신호의 출처가 없다. 그래서 호출자에게서 받는다.

```ts
export interface COPCTilesetProviderOptions {
  /**
   * Aborts the three reads `fromUrl` makes before it can return
   * (OVERVIEW §4). Cesium's own cancellation does not reach here — there is
   * no tile and no request yet — so this is the caller's channel, for a
   * component unmounted mid-load.
   */
  readonly signal?: AbortSignal;
}
```

`fromUrl`이 이것을 `openCopc(reader, signal)`에 넘긴다. 타일 요청에는 넘기지
않는다 — 그쪽 신호는 §4가 만든다.

## 6. 디코드 취소는 하지 않는다

(e) 때문이다. 디코드를 끊으면 워커 슬롯 하나를 아끼는 대신 타일을 영구히
죽인다. carried-forward가 지적한 낭비보다 나쁘다.

이 사실은 사라지지 않고 형태를 바꾼다.

- carried-forward의 해당 항목을 "배선이 없다"에서 **"Cesium의
  `makeContent` catch가 `request.cancelled`를 보지 않아 취소가 FAILED가 된다"**로
  다시 쓴다. 소스 위치와 함께.
- `tests/cesium-contract.test.ts`에 그 **비대칭**을 고정한다. 취소를 보는
  catch(`:1228`)와 보지 않는 catch(`:1282`)가 각각 그대로인지 확인하는 두
  단정. Cesium이 후자를 고치는 날 이 테스트가 실패하고, 그때가 디코드 취소를
  켤 수 있는 날이다.

## 7. 테스트

- **취소가 읽기를 끊는다.** `fetchArrayBuffer`가 반환한 뒤 `request.cancel()`을
  부르면 reader가 받은 신호가 abort되고, 반환된 promise가 reject되며, byte
  예산과 host 슬롯이 반환된다(`stats()`의 `inUse`가 0으로 돌아온다).
- **취소가 없으면 발화하지 않는다.** 같은 경로를 취소 없이 끝내면 신호는
  abort되지 않고 결과가 정상 반환된다.
- **두 번 감싸지 않는다.** 같은 요청으로 `signalForRequest`를 두 번 부르면
  같은 신호가 나오고, `cancel`은 한 번만 감싸진다(원래 동작인 `cancelled = true`도
  여전히 일어난다).
- **이미 취소된 요청.** `cancel()` 이후에 `signalForRequest`를 부르면 즉시
  abort된 신호가 나온다.
- **요청이 없을 때.** `request`가 `undefined`거나 `cancel`이 없으면
  `undefined`를 돌려주고 읽기는 신호 없이 정상 진행한다.
- **`fromUrl`의 신호.** 이미 abort된 신호를 넘기면 `fromUrl`이 그 이유로
  reject하고, 넘기지 않으면 지금과 동일하게 동작한다.
- **계약 테스트.** §6의 두 단정.
- **예산 API 축소.** `BudgetStats`에 `hierarchy`가 없고 `Budget`에
  `acquireHierarchyPage`가 없다는 것을, 매니페스트 테스트가 `exports`를 고정하는
  것과 같은 이유로 고정한다: 공개 표면의 변화는 발견되는 것이 아니라 결정되는
  것이다.

## 8. 범위 밖

- **eviction policy.** §3이 밝힌 대로, 측정이 필요하다고 말할 때 짓는다.
- **디코드 취소.** §6이 밝힌 대로, Cesium이 catch를 고칠 때까지.
- **coalescing과 §7의 두 Range 노브.** carried-forward의 range 섹션에 그대로
  남는다. 이 스펙은 그 파일들을 건드리지 않는다.
- **`readMany`의 취소.** 병합 읽기에는 아직 프로덕션 호출자가 없다(위 항목).
  신호를 받는 자리는 이미 있고, 그 자리에 넘길 것이 생기는 것은 coalescing이
  실제로 쓰일 때다.
