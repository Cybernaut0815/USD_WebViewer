import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatten, rowWindow } from '../src/tree.ts';

const node = (name: string, expanded = false, children: any[] | null = null): any => ({
  summary: { name, path: `/${name}` }, depth: 0, expanded, children,
});

test('flatten lists only rows under expanded parents', () => {
  const tree = [node('a', true, [node('a1'), node('a2', false, [node('hidden')])]), node('b')];
  assert.deepEqual(flatten(tree).map((n) => n.summary.name), ['a', 'a1', 'a2', 'b']);
});

test('rowWindow draws a bounded slice of a huge list', () => {
  const [first, count] = rowWindow(22 * 10000, 600, 50000);
  assert.equal(first, 9996);
  assert.ok(count > 27 && count < 45);
  assert.deepEqual(rowWindow(0, 600, 3), [0, 3]);
  assert.deepEqual(rowWindow(0, 600, 0), [0, 0]);
});
