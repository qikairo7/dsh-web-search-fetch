/**
 * Fixture loading. JSON is read and parsed explicitly (no import attributes),
 * so the same files work under any runner and TS config.
 * @module test/helpers/fixtures
 */
import { readFileSync } from 'node:fs';

export function readFixtureText(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

export function readFixtureJson<T = unknown>(name: string): T {
  return JSON.parse(readFixtureText(name)) as T;
}
