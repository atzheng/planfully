import { expect, test } from 'vitest';
import { WORKER_DEPENDS_ON } from './index';

test('imports a symbol from @planfully/shared', () => {
  expect(WORKER_DEPENDS_ON).toBe('@planfully/shared');
});
