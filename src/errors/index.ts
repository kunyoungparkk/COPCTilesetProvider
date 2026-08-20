export { CopcTilesetError } from './base.js';
export {
  MalformedHierarchyError,
  NotCopcError,
  UnsupportedHeaderLayoutError,
  WktNotInVlrsError,
} from './copc.js';
export { CrsCodeNotFoundError, CrsNotRegisteredError } from './crs.js';
export {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  InvalidByteRangeError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeTimeoutError,
  RangeUnsupportedError,
} from './range.js';
