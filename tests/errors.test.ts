import { describe, expect, it } from 'vitest';
import {
  ContentRangeMismatchError,
  DecodeJobNotAdmittedError,
  ContentRangeUnreadableError,
  CopcTilesetError,
  CrsDefinitionUnusableError,
  InvalidByteRangeError,
  LeaseAlreadyReleasedError,
  MalformedHierarchyError,
  NotCopcError,
  PositionCountMismatchError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeRequestRejectedError,
  RangeTimeoutError,
  RangeUnsupportedError,
  UnknownTileRequestError,
  UnsupportedHeaderLayoutError,
  UnsupportedPointFormatError,
  WktNotInVlrsError,
  WorkerTaskFailedError,
  ZeroPointChunkError,
} from '../src/errors/index.js';

// Decision 6 makes these messages API: a caller who reads one should know what
// to change without opening our source. These tests pin that promise.
describe('transport errors', () => {
  it('gives every error a stable code and the base type', () => {
    const error = new RangeUnsupportedError('https://host/a.copc.laz', 200);

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.code).toBe('range-unsupported');
    expect(error.name).toBe('RangeUnsupportedError');
    expect(error.status).toBe(200);
  });

  it('explains a 200 as a server capability problem, not a retryable blip', () => {
    const message = new RangeUnsupportedError('https://host/a.copc.laz', 200).message;

    expect(message).toContain('https://host/a.copc.laz');
    expect(message).toContain('206');
    expect(message).toContain('Accept-Ranges');
  });

  it('names the exact header a cross-origin server has to expose', () => {
    const message = new ContentRangeUnreadableError('https://cdn/a.copc.laz').message;

    expect(message).toContain('Access-Control-Expose-Headers: Content-Range');
  });

  it('marks server failures (5xx) differently from client errors (4xx)', () => {
    const error5xx = new RangeRequestFailedError('https://host/a.copc.laz', 503);
    const error4xx = new RangeRequestFailedError('https://host/a.copc.laz', 404);

    expect(error5xx.code).toBe('range-request-failed');
    expect(error5xx.status).toBe(503);
    expect(error5xx.message).toContain('temporary failure');
    expect(error5xx.message).toContain('retry budget');

    expect(error4xx.code).toBe('range-request-failed');
    expect(error4xx.status).toBe(404);
    expect(error4xx.message).toContain('rejected');
    expect(error4xx.message).not.toContain('temporary');
  });

  it('preserves the network error cause for debugging', () => {
    const cause = new TypeError('CORS failed');
    const error = new RangeNetworkError('https://cdn/a.copc.laz', cause);

    expect(error.code).toBe('range-network');
    expect(error.url).toBe('https://cdn/a.copc.laz');
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('could not be reached');
  });

  it('reports timeout deadlines and scaling with request size', () => {
    const error = new RangeTimeoutError('https://host/a.copc.laz', 8000);

    expect(error.code).toBe('range-timeout');
    expect(error.timeoutMs).toBe(8000);
    expect(error.message).toContain('8000ms');
    expect(error.message).toContain('scales with request');
  });

  it('diagnoses range mismatches with expected and received', () => {
    const error = new ContentRangeMismatchError(
      'https://host/a.copc.laz',
      'bytes 0-999',
      'bytes 0-1023',
    );

    expect(error.code).toBe('content-range-mismatch');
    expect(error.expected).toBe('bytes 0-999');
    expect(error.received).toBe('bytes 0-1023');
    expect(error.message).toContain('bytes 0-999');
    expect(error.message).toContain('bytes 0-1023');
    expect(error.message).toContain('shifted or truncated');
  });
});

describe('InvalidByteRangeError', () => {
  it('blames the caller rather than the server', () => {
    const error = new InvalidByteRangeError('length 0 at offset 375');

    expect(error.code).toBe('invalid-byte-range');
    expect(error.detail).toBe('length 0 at offset 375');
    expect(error.message).toContain('length 0 at offset 375');
    // Decision 4 builds every range from what a previous response reported, so
    // this can only be our own bug — the message has to say so.
    expect(error.message).toContain('bug');
  });
});

describe('RangeRequestFailedError on 416', () => {
  it('names the one cause a range request has for 416', () => {
    const message = new RangeRequestFailedError('https://host/a.copc.laz', 416).message;

    expect(message).toContain('past the end');
    // The generic 4xx advice about credentials would send the reader the wrong way.
    expect(message).not.toContain('credentials');
  });

  it('still gives the generic advice for other 4xx', () => {
    expect(new RangeRequestFailedError('https://host/a.copc.laz', 403).message).toContain(
      'credentials',
    );
  });
});

describe('MalformedHierarchyError', () => {
  it('blames the file rather than the request that fetched it', () => {
    const detail = 'its entry "1--2-3-4" is not addressed depth-x-y-z';
    const error = new MalformedHierarchyError('https://host/a.copc.laz', detail);

    expect(error.code).toBe('malformed-hierarchy');
    expect(error.name).toBe('MalformedHierarchyError');
    expect(error.detail).toBe(detail);
    expect(error.message).toContain('https://host/a.copc.laz');
    // Nothing a caller can pass fixes a non-conformant octree, so the message
    // has to name the one action that does: re-writing the file.
    expect(error.message).toContain('PDAL');
  });
});

describe('NotCopcError', () => {
  it('names the file, the defect, and the command that produces a COPC file', () => {
    const error = new NotCopcError(
      'https://host/plain.laz',
      'the record at byte 375 is LASF_Projection/2112, not copc/1',
    );

    expect(error.code).toBe('not-copc');
    expect(error.name).toBe('NotCopcError');
    expect(error.detail).toBe('the record at byte 375 is LASF_Projection/2112, not copc/1');
    expect(error.message).toContain('https://host/plain.laz');
    expect(error.message).toContain('not copc/1');
    // The one action that turns this file into one we can read.
    expect(error.message).toContain('pdal translate');
  });

  it('forwards the parser complaint that explains the defect', () => {
    const cause = new Error('Cannot convert bigint to number: 18446744073709551615');
    const error = new NotCopcError('https://host/a.copc.laz', 'its info record failed', { cause });

    // copc.js reports these as bare Errors, so dropping the cause discards the
    // only account of what was actually wrong with the bytes.
    expect(error.cause).toBe(cause);
  });
});

describe('UnsupportedHeaderLayoutError', () => {
  it('contrasts the length the file declares with the one COPC fixes', () => {
    const error = new UnsupportedHeaderLayoutError('https://host/las14.laz', 227);

    expect(error.code).toBe('unsupported-header-layout');
    expect(error.name).toBe('UnsupportedHeaderLayoutError');
    expect(error.headerLength).toBe(227);
    expect(error.message).toContain('https://host/las14.laz');
    expect(error.message).toContain('227');
    expect(error.message).toContain('375');
    // No option a caller can pass makes a 227-byte header readable.
    expect(error.message).toContain('PDAL');
  });
});

describe('UnsupportedPointFormatError', () => {
  it('gives every error a stable code and the base type', () => {
    const error = new UnsupportedPointFormatError('https://host/a.copc.laz', 6);

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.code).toBe('unsupported-point-format');
    expect(error.name).toBe('UnsupportedPointFormatError');
    expect(error.pointDataRecordFormat).toBe(6);
  });

  it('names the file, the format, and the fix', () => {
    const message = new UnsupportedPointFormatError('https://host/a.copc.laz', 6).message;

    expect(message).toContain('https://host/a.copc.laz');
    expect(message).toContain('format 6');
    expect(message).toContain('colour');
    // The one action that turns this file into one we can read.
    expect(message).toContain('pdal translate');
  });
});

describe('CrsDefinitionUnusableError', () => {
  it('gives every error a stable code and the base type', () => {
    const error = new CrsDefinitionUnusableError('+proj=lcc +nadgrids=@missing.gsb', 'grid-shift');

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.code).toBe('crs-definition-unusable');
    expect(error.name).toBe('CrsDefinitionUnusableError');
    expect(error.reason).toBe('grid-shift');
    expect(error.definition).toBe('+proj=lcc +nadgrids=@missing.gsb');
  });

  it('tells a grid-shift definition to stand on its own', () => {
    const message = new CrsDefinitionUnusableError(
      '+proj=lcc +nadgrids=@missing.gsb',
      'grid-shift',
    ).message;

    expect(message).toContain('+proj=lcc +nadgrids=@missing.gsb');
    expect(message).toContain('+nadgrids');
    expect(message).toContain('Replace');
  });

  it('tells an alias to be expanded into parameters', () => {
    const message = new CrsDefinitionUnusableError('EPSG:9999', 'alias').message;

    expect(message).toContain('EPSG:9999');
    expect(message).toContain('Expand');
  });

  it('hands over a runnable registerCrs call for a bare EPSG code, like its sibling', () => {
    const message = new CrsDefinitionUnusableError('EPSG:2992', 'alias').message;

    // Decision 6: the extracted code, inside a runnable call — the same
    // pattern CrsNotRegisteredError's own test pins.
    expect(message).toContain('registerCrs(2992,');
    expect(message).toContain('epsg.io/2992');
  });

  it('falls back to prose for a name with no code to extract', () => {
    const message = new CrsDefinitionUnusableError('GOOGLE', 'alias').message;

    expect(message).not.toContain('registerCrs(');
  });

  it('falls back to prose for an EPSG code buried in a longer string', () => {
    // Not the exact `EPSG:<code>` shape the extraction requires, so there is
    // no single code to hand back a call for.
    const message = new CrsDefinitionUnusableError('EPSG:2992 +units=ft', 'alias').message;

    expect(message).not.toContain('registerCrs(');
  });

  it("gives missing-projection its own reason, not alias's", () => {
    const error = new CrsDefinitionUnusableError('+lat_0=41.75 +datum=NAD83', 'missing-projection');

    expect(error.reason).toBe('missing-projection');
  });

  it('tells a missing-projection definition what is actually wrong with it', () => {
    // Not an alias, and nothing to do with proj4's built-in table or version
    // drift — the message must say so, not reuse the alias wording.
    const message = new CrsDefinitionUnusableError(
      '+lat_0=41.75 +datum=NAD83',
      'missing-projection',
    ).message;

    expect(message).toContain('+lat_0=41.75 +datum=NAD83');
    expect(message).toContain('+proj=');
    expect(message).not.toContain('proj4.defs');
    expect(message).not.toContain('alias');
  });
});

describe('ZeroPointChunkError', () => {
  it('gives every error a stable code and the base type', () => {
    const error = new ZeroPointChunkError();

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.code).toBe('zero-point-chunk');
    expect(error.name).toBe('ZeroPointChunkError');
  });

  it('names the Decision 6 defect and both possible sources, without claiming to tell them apart', () => {
    const message = new ZeroPointChunkError().message;

    expect(message).toContain('zero points');
    expect(message).toContain('Decision 6');
    expect(message).toContain('zero-point');
    // Two possible sources named, and neither one picked over the other —
    // src/worker/pipeline.ts's own guard cannot tell a lying hierarchy page
    // apart from this library asking decodeChunk for zero points itself.
    expect(message).toContain("this library's tileset construction");
    expect(message).toContain("the file's hierarchy page");
    expect(message).toContain('nothing at this layer can tell which');
  });
});

describe('PositionCountMismatchError', () => {
  it('gives every error a stable code and the base type', () => {
    const error = new PositionCountMismatchError(47, 30);

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.code).toBe('position-count-mismatch');
    expect(error.name).toBe('PositionCountMismatchError');
  });

  it('names both counts, the expected component count, and how to fix it', () => {
    const message = new PositionCountMismatchError(47, 30).message;

    expect(message).toContain('47');
    expect(message).toContain('141'); // 47 * 3
    expect(message).toContain('30');
    expect(message).toContain('toRelativePositions(view, transform)');
  });
});

describe('WorkerTaskFailedError', () => {
  it('gives every error a stable code and the base type', () => {
    const error = new WorkerTaskFailedError('RangeError', 'Array buffer allocation failed');

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.code).toBe('worker-task-failed');
    expect(error.name).toBe('WorkerTaskFailedError');
  });

  it('names the original error rather than paraphrasing it', () => {
    const message = new WorkerTaskFailedError('RangeError', 'Array buffer allocation failed').message;

    expect(message).toContain('RangeError');
    expect(message).toContain('Array buffer allocation failed');
    expect(message).toContain('Worker');
  });
});

describe('RangeRequestRejectedError', () => {
  it('gives every error a stable code and the base type', () => {
    const error = new RangeRequestRejectedError('copc://a1b2c3/n/0-0-0-0', 'over-capacity');

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.code).toBe('range-request-rejected');
    expect(error.name).toBe('RangeRequestRejectedError');
    expect(error.url).toBe('copc://a1b2c3/n/0-0-0-0');
    expect(error.reason).toBe('over-capacity');
  });

  it('tells over-capacity apart from destroyed', () => {
    const overCapacity = new RangeRequestRejectedError('copc://a/n/0-0-0-0', 'over-capacity').message;
    const destroyed = new RangeRequestRejectedError('copc://a/n/0-0-0-0', 'destroyed').message;

    expect(overCapacity).toContain('larger than');
    // `createBudget` is not exported and `COPCTilesetProviderOptions` exposes
    // no budget limit, so advice naming either is advice the caller who reads
    // this message has no way to act on.
    expect(overCapacity).not.toContain('createBudget');
    expect(overCapacity).toContain('Rewrite it with fewer points per node');
    expect(overCapacity).not.toContain('destroyed');
    expect(destroyed).toContain('destroyed');
    expect(destroyed).not.toContain('larger than');
  });
});

describe('UnknownTileRequestError', () => {
  it('gives every error a stable code and the base type', () => {
    const error = new UnknownTileRequestError('copc://a1b2c3/n/9-9-9-9');

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.code).toBe('unknown-tile-request');
    expect(error.name).toBe('UnknownTileRequestError');
    expect(error.url).toBe('copc://a1b2c3/n/9-9-9-9');
  });

  it('blames this library rather than the caller or the file', () => {
    const message = new UnknownTileRequestError('copc://a1b2c3/n/9-9-9-9').message;

    expect(message).toContain('copc://a1b2c3/n/9-9-9-9');
    expect(message).toContain('defect in this library');
  });
});

describe('WktNotInVlrsError', () => {
  it('says where the WKT probably is and how to move it', () => {
    const error = new WktNotInVlrsError('https://host/evlr.copc.laz');

    expect(error.code).toBe('wkt-not-in-vlrs');
    expect(error.name).toBe('WktNotInVlrsError');
    expect(error.url).toBe('https://host/evlr.copc.laz');
    expect(error.message).toContain('https://host/evlr.copc.laz');
    expect(error.message).toContain('extended VLR');
    // Two ways forward, and the message has to offer both.
    expect(error.message).toContain('pdal translate');
    expect(error.message).toContain('open an issue');
  });
});

// Both of these had a stable `code` and no message assertion anywhere. The
// wire map's source scan proves a code exists and is mapped to its own class;
// it says nothing about what the message says, and Decision 6 makes messages
// part of the API too.
describe('LeaseAlreadyReleasedError', () => {
  it('names the three acquire calls and blames the caller, not the budget', () => {
    const error = new LeaseAlreadyReleasedError();

    expect(error.code).toBe('lease-already-released');
    expect(error.name).toBe('LeaseAlreadyReleasedError');
    // A double release is unrecoverable by design, so the message has to say
    // whose bug it is rather than suggest a retry.
    expect(error.message).toContain('acquireRangeRequest');
    expect(error.message).toContain('acquireDecodeJob');
    expect(error.message).toContain('acquireHierarchyPage');
    expect(error.message).toContain('exactly once');
    expect(error.message).toContain('bug in the caller');
  });
});

describe('DecodeJobNotAdmittedError', () => {
  it('tells a destroyed pool apart from one whose budget is too small to ever fit', () => {
    const destroyed = new DecodeJobNotAdmittedError('destroyed');
    const overCapacity = new DecodeJobNotAdmittedError('over-capacity');

    expect(destroyed.code).toBe('decode-job-not-admitted');
    expect(destroyed.name).toBe('DecodeJobNotAdmittedError');
    expect(destroyed.reason).toBe('destroyed');
    expect(overCapacity.reason).toBe('over-capacity');

    // The two reasons need different messages because they need different
    // reactions: nothing brings a destroyed provider back, while an
    // over-capacity budget names the two knobs that fix it.
    expect(destroyed.message).toContain('destroyed');
    expect(destroyed.message).toContain('will not');
    // Names the knob a caller actually holds — `createBudget` and
    // `createWorkerPool` are internal — and says plainly that the state is
    // unreachable for any real pool size, so a reader who hits it looks for a
    // zero capacity rather than for a number to raise.
    expect(overCapacity.message).toContain('workerPoolSize');
    expect(overCapacity.message).toContain('zero');
    expect(overCapacity.message).not.toContain('createBudget');
    expect(overCapacity.message).not.toContain('createWorkerPool');
  });
});
