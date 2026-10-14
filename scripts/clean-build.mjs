import { lstatSync, rmSync } from 'node:fs';

// Remove only this project's generated compiler output before rebuilding.
const output = new URL('../lib/', import.meta.url);
if (lstatSync(output, { throwIfNoEntry: false })?.isSymbolicLink()) {
  throw new Error('Refusing to clean a symlinked build directory');
}
rmSync(output, { recursive: true, force: true });
