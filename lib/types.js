/**
 * Wire-level types for upstream engines. Fields are deliberately `unknown`:
 * the mapping layer narrows them at runtime, so an upstream that lies cannot
 * smuggle a non-string into the seam (see `WebSearchSource`'s doc comment in
 * `@deepseek-ai/dsh-web` — forcing adapters to invent fields makes the seam lie).
 * @module types
 */
export {};
