/**
 * Wire-level types for the Zhihu OpenAPI. Response fields are deliberately
 * `unknown`: the mapping layer narrows them at runtime, so an upstream that
 * lies cannot smuggle a non-string into the seam.
 * @module engines/zhihu/types
 */
export {};
