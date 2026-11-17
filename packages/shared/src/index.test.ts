import { expect, test } from 'vitest';
import { SHARED_PACKAGE } from './index';

test('exports its package name', () => {
  expect(SHARED_PACKAGE).toBe('@planfully/shared');
});
