/**
 * Wire-level types for the SiliconFlow rerank engine. Response fields are
 * deliberately `unknown`: the mapping layer narrows them at runtime, so a
 * lying upstream cannot smuggle a non-number into the ordering.
 * @module engines/rerank/types
 */
export {};
