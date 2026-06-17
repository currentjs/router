import assert from 'node:assert';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';

export { describe, it, before, after, beforeEach, afterEach };
export const beforeAll = before;
export const afterAll = after;

export function expect(actual: any) {
  return {
    toBe(expected: any, msg?: string) {
      assert.strictEqual(actual, expected, msg);
    },
    toEqual(expected: any, msg?: string) {
      assert.deepStrictEqual(actual, expected, msg);
    },
    toBeDefined(msg?: string) {
      assert.ok(
        actual !== undefined && actual !== null,
        msg || 'Expected value to be defined'
      );
    },
    toBeTruthy(msg?: string) {
      assert.ok(actual, msg || `Expected ${String(actual)} to be truthy`);
    },
    toBeFalsy(msg?: string) {
      assert.ok(!actual, msg || `Expected ${String(actual)} to be falsy`);
    },
    toContain(expected: string, msg?: string) {
      assert.ok(
        typeof actual === 'string' ? actual.includes(expected) : false,
        msg || `Expected "${String(actual)}" to contain "${expected}"`
      );
    },
    toMatch(pattern: RegExp, msg?: string) {
      assert.match(String(actual), pattern, msg);
    },
    toNotContain(expected: string, msg?: string) {
      assert.ok(
        !String(actual).includes(expected),
        msg || `Expected NOT to contain "${expected}"`
      );
    },
  };
}
