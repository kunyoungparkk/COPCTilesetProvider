import { CopcTilesetError } from './base.js';

/**
 * A hierarchy page cannot be turned into octree nodes.
 *
 * The page is unreadable as an octree: copc.js will not parse its bytes as
 * entries at all, or they parse into entries that describe an octree no reader
 * could follow. Whichever it is, the defect is in the file rather than in the
 * request that fetched it, so no caller can fix it and nothing built from the
 * page would mean anything. Where a parser did complain, its own account is
 * carried as `cause` rather than paraphrased here.
 */
export class MalformedHierarchyError extends CopcTilesetError {
  readonly code = 'malformed-hierarchy';
  readonly url: string;
  readonly detail: string;

  constructor(url: string, detail: string, options?: ErrorOptions) {
    super(
      `${url} has a hierarchy page this library cannot read: ${detail}. The file is ` +
        'COPC-shaped, since its header and info record parsed, but this page does not ' +
        'follow the specification, so the octree it describes cannot be trusted. ' +
        'Re-writing the file with a current PDAL will produce a conformant hierarchy.',
      options,
    );
    this.url = url;
    this.detail = detail;
  }
}

/** The bytes at the start of the file are not a COPC file. */
export class NotCopcError extends CopcTilesetError {
  readonly code = 'not-copc';
  readonly url: string;
  readonly detail: string;

  constructor(url: string, detail: string, options?: ErrorOptions) {
    super(
      `${url} is not a COPC file: ${detail}. Re-writing the file with a current PDAL ` +
        'will produce a conformant one — `pdal translate input.laz output.copc.laz` — ' +
        'whether it started as a plain LAS or LAZ or as a COPC file its writer got wrong.',
      options,
    );
    this.url = url;
    this.detail = detail;
  }
}

/**
 * The LAS header is not the 375 bytes COPC fixes it at.
 *
 * Decision 4 reads the info VLR at offset 375 because the format guarantees it
 * is there. A different header length voids that guarantee, so continuing would
 * mean parsing whatever happens to sit at 375 as if it were the info record.
 */
export class UnsupportedHeaderLayoutError extends CopcTilesetError {
  readonly code = 'unsupported-header-layout';
  readonly url: string;
  readonly headerLength: number;

  constructor(url: string, headerLength: number) {
    super(
      `${url} declares a ${headerLength}-byte LAS header, but COPC fixes it at 375. ` +
        'The file is either not COPC or was written by a tool that does not follow the ' +
        'specification; re-writing it with a current PDAL will produce a conforming header.',
    );
    this.url = url;
    this.headerLength = headerLength;
  }
}

/**
 * The file's point data record format is not one COPC allows.
 *
 * COPC requires formats 6, 7 or 8, all three of which this library renders
 * (`src/worker/pnts.ts` ships colour for the two that carry it). A file
 * declaring anything else is a LAS or LAZ file rather than a COPC one, and
 * `copc.js`'s extractor has no branch for it: reaching a Worker, it would
 * throw an untyped error per tile, after the globe has loaded. Refusing at
 * open names the file and the format once instead.
 */
export class UnsupportedPointFormatError extends CopcTilesetError {
  readonly code = 'unsupported-point-format';
  readonly pointDataRecordFormat: number;

  constructor(url: string, pointDataRecordFormat: number) {
    super(
      `${url} uses point data record format ${pointDataRecordFormat}, which COPC does not ` +
        'allow. COPC requires format 6, 7 or 8, and this library renders all three. ' +
        'A file using another format is plain LAS or LAZ rather than COPC, whatever its ' +
        'name says, and has to be converted before it can be streamed ' +
        '(`pdal translate input.laz output.copc.laz`). Conversion picks a COPC-legal ' +
        'format on its own, keeping colour when the points have it.',
    );
    this.pointDataRecordFormat = pointDataRecordFormat;
  }
}

/**
 * The file has no WKT record among its VLRs, and the caller passed no `crs`,
 * so nothing says which coordinate system its points are in.
 *
 * Either the file declares no system at all, or it stores its WKT as an
 * extended VLR, which this library does not read. The two are not told apart:
 * a `crs` from the caller opens the file in both cases (Decision 6).
 */
export class WktNotInVlrsError extends CopcTilesetError {
  readonly code = 'wkt-not-in-vlrs';
  readonly url: string;

  constructor(url: string) {
    super(
      `${url} has no WKT record among its VLRs, so nothing this library reads says ` +
        'which coordinate system its points are in. If you know the system, pass its ' +
        'definition when opening the file:\n\n' +
        "    COPCTilesetProvider.fromUrl(url, { crs: '<proj4 definition>' });\n\n" +
        'Or re-write the file with a current PDAL — ' +
        '`pdal translate input.copc.laz output.copc.laz --writers.copc.a_srs=EPSG:<code>` ' +
        '— so it records the system as a regular VLR. A WKT stored only as an extended ' +
        'VLR is not read; `pdal translate` without `a_srs` moves one to a regular VLR.',
    );
    this.url = url;
  }
}
