import { describe, expect, it } from 'vitest';
import {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  CopcTilesetError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeTimeoutError,
  RangeUnsupportedError,
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
