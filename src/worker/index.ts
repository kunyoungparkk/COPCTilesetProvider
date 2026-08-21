/**
 * The Worker pipeline's public surface: `encodeNode`, the single entry point
 * `pipeline.ts`'s own doc comment describes, and the input type it takes.
 *
 * `decodeChunk`, `toRelativePositions` and `encodePnts` are not re-exported
 * here. Each is one stage `encodeNode` composes, not something a caller
 * invokes on its own: `encodeNode` is the only place that checks for a
 * zero-point view (Decision 6's empty-node invariant) before the other two
 * ever run, so a caller reaching them directly could skip that check and
 * hand `encodePnts` a chunk `toRelativePositions` never centred. Nothing
 * outside `src/worker/` imports any of the three today (only
 * `pipeline.ts` itself and this directory's own tests do), so there is no
 * caller this omission would break.
 */
export type { EncodeNodeInput } from './pipeline.js';
export { encodeNode } from './pipeline.js';
export type { DecodeHeader } from './decode.js';
