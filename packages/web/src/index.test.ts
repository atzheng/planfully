import { expect, test } from 'vitest';
import { WEB_DEPENDS_ON } from './index';

test('imports a symbol from @planfully/shared', () => {
  expect(WEB_DEPENDS_ON).toBe('@planfully/shared');
});
