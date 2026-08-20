import { describe, expect, it } from 'vitest';
import {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  CopcTilesetError,
  InvalidByteRangeError,
  MalformedHierarchyError,
  NotCopcError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeTimeoutError,
  RangeUnsupportedError,
  UnsupportedHeaderLayoutError,
  WktNotInVlrsError,
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
