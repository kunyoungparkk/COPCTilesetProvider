import { CopcTilesetError } from './base.js';

/**
 * The server answered a Range request with a success status other than 206.
 *
 * Decision 4 rules out a 200 fallback: downloading the whole file would defeat
 * the one thing this library exists to do.
 */
export class RangeUnsupportedError extends CopcTilesetError {
  readonly code = 'range-unsupported';
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number) {
    super(
      `${url} answered a Range request with HTTP ${status} instead of 206 Partial Content. ` +
        'This library reads COPC files in pieces and never downloads them whole, so a ' +
        'server that ignores Range cannot be used. Host the file where byte ranges work ' +
        '(S3, nginx, or any static host that reports `Accept-Ranges: bytes`).',
    );
    this.url = url;
    this.status = status;
  }
}

/** The request itself was rejected — a 4xx or 5xx. */
export class RangeRequestFailedError extends CopcTilesetError {
  readonly code = 'range-request-failed';
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number) {
    super(
      `${url} returned HTTP ${status}. ` +
        (status >= 500
          ? 'The server reported a temporary failure and the request did not succeed within the configured retry budget.'
          : status === 416
            ? // The one status a range request can provoke by itself: we asked
              // past EOF, which means the file is not what we were told it was.
              'The requested bytes lie past the end of the file, so it has most ' +
              'likely been replaced or truncated since it was opened. Reload the ' +
              'tileset to read the current file.'
            : 'The request was rejected, so resending it would return the same answer. ' +
              'Check the URL, and whether the object requires credentials this library does not send.'),
    );
    this.url = url;
    this.status = status;
  }
}

/**
 * `fetch` rejected before any response arrived.
 *
 * In a browser the usual cause is CORS: a cross-origin file whose server does
 * not send `Access-Control-Allow-Origin` fails here, before status or headers
 * exist to inspect.
 */
export class RangeNetworkError extends CopcTilesetError {
  readonly code = 'range-network';
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(
      `${url} could not be reached. If the file is on another origin, the server must send ` +
        '`Access-Control-Allow-Origin` for the browser to allow the request at all. ' +
        'Otherwise the host is unreachable or the URL is wrong.',
      { cause },
    );
    this.url = url;
  }
}

/** The request outlived its deadline. */
export class RangeTimeoutError extends CopcTilesetError {
  readonly code = 'range-timeout';
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(
      `${url} did not respond within ${timeoutMs}ms. The deadline scales with request ` +
        'size; a server this slow will not stream a point cloud usefully.',
    );
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A 206 with no readable `Content-Range` delivered the wrong number of bytes.
 *
 * An unreadable header is not itself an error (Decision 4): cross-origin, the
 * browser withholds it unless the server names it in
 * `Access-Control-Expose-Headers`, and no public COPC dataset does. Such a
 * response is accepted on the length of its body instead — which makes that
 * length the whole of the verification, and this the failure when it does not
 * hold. Fatal rather than retryable, like every other verification failure:
 * a second identical request gets the same answer.
 */
export class ContentRangeUnreadableError extends CopcTilesetError {
  readonly code = 'content-range-unreadable';
  readonly url: string;
  readonly expectedBytes: number;
  readonly receivedBytes: number;

  constructor(url: string, expectedBytes: number, receivedBytes: number) {
    super(
      `${url} returned 206 with ${receivedBytes} bytes where ${expectedBytes} were asked ` +
        'for, and its Content-Range header could not be read, so nothing else can say ' +
        'what the response actually was. If the file is cross-origin, the browser hides ' +
        'that header unless the server sends ' +
        '`Access-Control-Expose-Headers: Content-Range`; sending it would turn this into ' +
        'a message naming the range the server thought it was answering.',
    );
    this.url = url;
    this.expectedBytes = expectedBytes;
    this.receivedBytes = receivedBytes;
  }
}

/** The bytes that came back are not the bytes that were asked for. */
export class ContentRangeMismatchError extends CopcTilesetError {
  readonly code = 'content-range-mismatch';
  readonly url: string;
  readonly expected: string;
  readonly received: string;

  constructor(url: string, expected: string, received: string) {
    super(
      `${url} was asked for ${expected} but answered with ${received}. The library ` +
        'reads structure at exact offsets, so a shifted or truncated response would be ' +
        'parsed as corrupt data. Check for a proxy or CDN that rewrites range requests.',
    );
    this.url = url;
    this.expected = expected;
    this.received = received;
  }
}

/**
 * A byte range that could not have come from a real descriptor.
 *
 * Decision 4 builds every request from an offset and size some earlier response
 * reported, so a zero-length or negative range is not something a server can
 * cause — it is a bug in how the descriptor was constructed. Decision 6 set the
 * precedent with the empty-node invariant: conditions our own structure makes
 * impossible fail loudly rather than being quietly tolerated.
 */
export class InvalidByteRangeError extends CopcTilesetError {
  readonly code = 'invalid-byte-range';
  readonly detail: string;

  constructor(detail: string) {
    super(
      `Invalid byte range: ${detail}. Ranges are derived from offsets and sizes a ` +
        'previous response reported, so this is a bug in how the range was built ' +
        'rather than anything a server did.',
    );
    this.detail = detail;
  }
}

/**
 * A virtual tile URI carries this provider's own token prefix, but no
 * descriptor was ever registered for it.
 *
 * Decision 4: every Range request is built from an offset and size a previous
 * response reported, never from a guess. A URI under `tokenBase` is one this
 * provider itself minted — into the synthetic tileset JSON or a hierarchy
 * page's own children — so a miss here is not something a caller or a server
 * did; it is a bug in this library's own bookkeeping (the registry entry was
 * never added, or was removed while a tile referencing it was still live).
 */
export class UnknownTileRequestError extends CopcTilesetError {
  readonly code = 'unknown-tile-request';
  readonly url: string;

  constructor(url: string) {
    super(
      `${url} names a tile this library has no descriptor for, though it carries this ` +
        "provider's own token prefix. Every such URI is minted by this library's own " +
        'tileset construction, so one with no matching registry entry is a defect in ' +
        'this library rather than anything the requested file or a caller did. Please ' +
        'open an issue with the COPC file that produced it.',
    );
    this.url = url;
  }
}
