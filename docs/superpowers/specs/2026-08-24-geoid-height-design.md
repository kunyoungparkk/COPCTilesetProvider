# geoid 높이 보정 — 설계

## 1. 무엇을 여는가

OVERVIEW §6이 v1 비목표로 못 박은 항목 하나: **정표고(geoid) 보정**.

지금 라이브러리는 파일의 모든 Z를 타원체고(HAE)로 간주한다. 정표고 기준
데이터는 그만큼 어긋난 자리에 렌더된다. 데모에서 눈으로 확인됐고, 이 스펙은
그 어긋남을 호출자가 없앨 수 있는 최소 수단을 연다.

여는 범위는 **상수 오프셋 하나**다. 격자 기반 보정, 자동 조회, 수직 단위 정밀화는
열지 않는다(§8).

## 2. 측정한 것

설계 이전에 실측한 네 가지. 각각이 아래 결정 하나씩을 강제한다.

**(a) proj4js는 수직 변환을 못 한다.** 설치된 proj4 2.21의 `lib/` 어디에도
`geoidgrids`·`vgridshift`·`vunits`가 없다. PROJ 본체(C)는 격자 파일로 이걸
처리하지만 JS 포트에는 그 코드가 없다. → 보정은 우리가 직접 더하는 수밖에 없다.

**(b) 파일이 자기 수직계를 EPSG 코드로 선언한다.** 고정 Autzen WKT는 `COMPD_CS`이고
수평(`PROJCS`, EPSG:2992) 옆에 이것이 있다:

```
VERT_CS["NAVD88 height (ftUS)",
  VERT_DATUM["North American Vertical Datum 1988",2005,AUTHORITY["EPSG","5103"]],
  UNIT["US survey foot",0.304800609601219,AUTHORITY["EPSG","9003"]],
  AUTHORITY["EPSG","6360"]]
```

→ "이 파일의 Z는 geoid 기준"이라는 사실을 파일에서 읽어낼 수 있다. 경고를 띄울
근거가 추측이 아니라 파일 자신이 된다.

**(c) 그 코드를 읽는 스캐너가 이미 있다.** `findHorizontalEpsgCode`의 루프는
AUTHORITY 노드를 **바로 위 키워드로 키를 잡아** `found` 맵에 넣는다. `VERT_CS`도
이미 그 맵에 들어가 있고, 읽어가는 코드만 없다. → 새 스캐너를 쓰지 않는다.

**(d) 오차의 크기.** Autzen 지점(44.0587, −123.0687)의 NGS geoid 높이는
**−23.333 m**. 파일 헤더의 최저 Z는 406.14 ft = 123.8 m. 즉 라이브러리는 이 지면을
123.8 m HAE에 놓지만 실제 타원체고는 100.5 m다. 어긋남은 정확히 geoid 분리량이고,
전 지구적으로 이 값은 약 −107 m ~ +85 m 범위다. → 무시할 수 있는 양이 아니다.

## 3. 결정

**결정 A — 데이터셋당 상수 하나.** N은 코드가 아니라 **위치의 함수**다. 같은
NAVD88이라도 오리건과 플로리다의 N이 다르다. 따라서 `registerCrs`처럼 EPSG
코드에 값을 매다는 형태는 형태만 닮고 의미가 틀리다. 값이 유효한 범위는 파일
하나이므로 `fromUrl`의 옵션으로 받는다.

수 km 규모 데이터셋에서 N의 변화는 수 cm다. 대륙 규모 파일에서는 부정확하고,
그건 이 결정이 받아들인 한계다(§8).

**결정 B — 옵션 이름은 `geoidHeight`, 단위는 미터, 라이브러리가 더한다.**
`h = H + N`이고 옵션이 곧 N이다. 사용자가 값을 얻는 NGS API의 응답 필드명이
말 그대로 `geoidHeight`이고 값도 `-23.333`이라, 조회 결과를 부호 고민 없이 그대로
옮길 수 있다. Z가 피트인 파일이어도 이 값은 항상 미터다 — 단위 환산 **뒤에**
더해지기 때문이다.

정확성은 등록자 책임이라는 Decision 6의 태도를 그대로 잇는다. 값이 오면 판단하지
않고 적용한다.

**결정 C — 미지정은 거부가 아니라 경고.** 파일이 `VERT_CS`를 선언했는데 옵션이
없으면 로드는 그대로 하고 `console.warn`을 한 번 낸다.

typed error(Decision 6의 수평 CRS 방식)는 일관되지만 breaking change이고, N을
모르는 사람이 파일을 아예 못 열게 만든다. 조용한 통과는 지금 동작이지만 23 m
오차를 모른 채 쓰게 한다. 경고는 둘 사이이고, 이 라이브러리가 콘솔에 쓰는
**첫 사례**라는 점을 대가로 치른다.

## 4. 설계

숫자 하나를 기존 CRS 이음매에 끼운다. 새 모듈도, 새 에러 클래스도 없다.

| 파일 | 변경 |
|---|---|
| `src/crs/horizontal-code.ts` → `epsg-codes.ts` | 스캔 루프를 내부 `scanAuthorities(wkt)`로 빼고, 그 위에 `findHorizontalEpsgCode`와 신규 `findVerticalEpsgCode` 두 얇은 리더를 얹는다 |
| `src/crs/transform.ts` | `createTransformFromDefinition(definition, geoidHeight = 0)`. `project`가 `z * metresPerZ + geoidHeight`를 반환 |
| `src/worker/protocol.ts` | `init` 메시지에 `geoidHeight: number` 추가 |
| `src/worker/entry.ts` | 검증용 `createTransformFromDefinition` 호출에 넘기고, `definition` 옆에 함께 보관해 `encodeNode`로 전달 |
| `src/worker/pipeline.ts` | `EncodeNodeInput`에 `geoidHeight: number` 추가 — `encodeNode`가 호출마다 자기 transform을 만들기 때문 |
| `src/cesium-runtime/provider.ts` | `COPCTilesetProviderOptions.geoidHeight?: number`, 두 realm에 전달, 미지정 시 경고 |

**파일 이름을 바꾸는 이유.** 지금 이름과 doc comment("OVERVIEW §6 keeps heights
ellipsoidal, so the vertical system is never consulted")가 둘 다 거짓이 된다.
개명이 건드리는 곳은 넷이다 — `src/crs/index.ts`의 재수출, `src/crs/resolve.ts`의
import, `tests/crs-horizontal-code.test.ts`(파일명 포함), 그리고 경로를 문자열로
언급하는 `tests/import-closure.test.ts:217`의 주석. 신규 `findVerticalEpsgCode`도
같은 배럴에서 재수출한다.

**한 줄로 끝나는 이유.** `toWgs84`와 `toEcef`가 같은 `project`를 쓰고,
포인트(Worker)·region bounding volume·`measureRootGeometricError`(메인 스레드)가
모두 그 transform을 통과한다. 오프셋을 `project` 안에 넣으면 셋이 함께 내려간다.
한쪽만 내려가면 bounding volume이 실제 포인트를 담지 못해 §3 Decision 6의 완전
포함 계약이 깨지므로, 이 위치가 유일하게 맞는 자리다.

## 5. 데이터 흐름

모양은 바뀌지 않는다. 메인 스레드가 WKT에서 코드를 읽고, **문자열 하나와 숫자
하나**가 Worker로 건너가 양쪽이 동일한 transform을 만든다.

```
fromUrl(url, { geoidHeight })
  → WKT → findHorizontalEpsgCode → registry → definition (string)
        → findVerticalEpsgCode  → 경고 판단에만 사용
  → createTransformFromDefinition(definition, geoidHeight)   [메인: region·GE]
  → post { kind: 'init', definition, geoidHeight }           [Worker: 포인트]
```

Decision 3의 realm 경계는 그대로다 — 넘어가는 것은 여전히 직렬화 가능한 값뿐이고,
registry는 메인 스레드에 남는다. 콜백을 옵션으로 받지 않는 이유가 이것이다:
함수는 이 경계를 넘지 못한다.

## 6. 경고 문구

에러 메시지가 API의 일부라는 규칙(CLAUDE.md)을 경고에도 적용한다 — 검출한 코드와
붙여넣을 호출문을 담는다. 헤더에서 데이터셋 중심 좌표를 알 수 있으므로 조회할
지점도 같이 준다. 특정 국가 서비스를 지목하지는 않는다.

```
copc-tileset-provider: this file declares vertical CRS EPSG:6360, which measures
height from a geoid, but no geoidHeight was given. Its points will be off by the
geoid separation at this location (worldwide, roughly -107 m to +85 m). Look up
the geoid height N at this dataset's centre (44.0587, -123.0687) and pass it in
metres:

  COPCTilesetProvider.fromUrl(url, { geoidHeight: N })
```

`fromUrl` 한 번에 한 번만 낸다.

**받아들인 오검출.** 타원체고를 `VERT_CS`로 선언한 파일도 경고를 받는다. 어떤
수직 코드가 geoid 기준인지 열거하는 표는 유지 불가능하므로, 규칙은 "수직계를
선언했고 오프셋이 없으면 경고" 하나로 둔다. 해당 사용자의 답은
`geoidHeight: 0`이고, 문서에 그렇게 적는다.

## 7. 검증

- `findVerticalEpsgCode` — 고정 Autzen WKT에서 6360, `VERT_CS` 없는 WKT에서 `null`.
  개명 후에도 `findHorizontalEpsgCode`의 기존 단정이 전부 그대로 통과할 것.
- transform — `geoidHeight: -23.333`을 준 `toEcef` 결과가 안 준 결과보다 국소
  연직 방향으로 정확히 23.333 m 아래일 것. 기존 PDAL 기준점 테스트에 붙인다.
- 기본값 — 옵션 없는 `createTransformFromDefinition`이 지금과 비트 단위로 같은 값을
  낼 것(회귀 가드).
- Worker 경계 — `init`에 실린 숫자가 Worker의 transform까지 도달할 것.
- 경고 — `VERT_CS`가 있고 옵션이 없을 때 한 번 뜨고, 옵션이 있으면 안 뜨고,
  `VERT_CS`가 없으면 안 뜰 것.

각 단정은 해당 코드를 변형해 실제로 실패하는지 확인한 뒤 확정한다(CLAUDE.md).

## 8. 범위 밖

- **격자 기반 보정.** EGM96 등 전 지구 격자를 읽어 위치마다 N을 구하는 것. 광역
  데이터셋의 정답이지만 격자 포맷·보간·Worker 전송·번들 크기가 전부 새로 생긴다.
  상수 오프셋으로 부족하다는 실제 요구가 생기면 그때 짓는다.
- **자동 조회.** N을 네트워크에서 가져오는 것. Decision 4의 "추측성 읽기 금지"와
  정면으로 어긋나고, 정적 서버만 있으면 된다는 전제도 깬다.
- **수직 단위 정밀화.** 현재 Z는 **수평** 정의의 `to_meter`로 환산된다. 고정
  파일에서 수평은 국제피트(0.3048), 수직은 US 측량피트(0.304800609601219)로
  2 ppm 다르다 — 124 m에서 0.25 mm. `transform.ts`가 이미 이 사실을 주석으로
  적어두고 있고, 이 스펙은 그 자리를 바꾸지 않는다.

## 9. 따라오는 문서 변경

이 변경은 명시된 비목표를 바꾸므로 문서가 같이 움직인다. 둘 다 문구를 따로
확인받는다.

- **OVERVIEW §6** — geoid 항목을 "비목표"에서 "호출자가 상수 오프셋으로 보정할 수
  있고, 격자 기반 보정은 여전히 비목표"로 다시 쓴다. §3 Decision 6의 CRS 항목에
  `geoidHeight`를 한 줄 추가할지도 함께 판단한다.
- **README.md:162** — "Heights are ellipsoidal" 문단에 `geoidHeight` 사용법과
  값을 어디서 얻는지를 잇는다.
