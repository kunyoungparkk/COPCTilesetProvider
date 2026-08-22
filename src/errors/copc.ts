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
 * The file's points carry no colour.
 *
 * COPC allows point data record formats 6, 7 and 8, and only 7 and 8 have RGB
 * (`copc.js`'s own extractor for format 6 exposes no `Red`, `Green` or `Blue`).
 * This library encodes `RGB` into every PNTS tile, so a format-6 file has
 * nothing to render from — and refusing at open is the difference between one
 * error naming the file and one untyped throw per tile, inside a Worker,
 * after the globe has loaded.
 */
export class UnsupportedPointFormatError extends CopcTilesetError {
  readonly code = 'unsupported-point-format';
  readonly pointDataRecordFormat: number;

  constructor(url: string, pointDataRecordFormat: number) {
    super(
      `${url} uses point data record format ${pointDataRecordFormat}, which carries no ` +
        'colour. This library needs RGB, so only formats 7 and 8 can be rendered. ' +
        'Nothing can add colour a file does not have — if the source data has it, ' +
        're-exporting from that source is the fix, and PDAL picks a colour-carrying ' +
        'format on its own when the points it is given have colour ' +
        '(`pdal translate coloured-input.las output.copc.laz`). If the source has no ' +
        'colour either, this library cannot render it.',
    );
    this.pointDataRecordFormat = pointDataRecordFormat;
  }
}

/** The WKT record is missing from the VLR region, and may be in an EVLR. */
export class WktNotInVlrsError extends CopcTilesetError {
  readonly code = 'wkt-not-in-vlrs';
  readonly url: string;

  constructor(url: string) {
    super(
      `${url} has no WKT record among its VLRs, but does declare extended VLRs, so its ` +
        'coordinate system is probably stored there. This library reads WKT from the VLR ' +
        'region only. Re-save the file with the WKT as a regular VLR — `pdal translate` ' +
        'does this by default — or open an issue if extended VLRs matter for your data.',
    );
    this.url = url;
  }
}
