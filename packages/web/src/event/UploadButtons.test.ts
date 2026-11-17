import { describe, expect, test } from 'vitest';
import { receiptName } from './UploadButtons';

describe('receiptName', () => {
  test('drops the extension', () => {
    expect(receiptName('Dinner receipt.pdf')).toBe('Dinner receipt');
    expect(receiptName('IMG_0001.final.jpg')).toBe('IMG_0001.final');
  });
  test('keeps dotfiles and falls back when empty', () => {
    expect(receiptName('.pdf')).toBe('.pdf');
    expect(receiptName('  .jpg')).toBe('Receipt');
    expect(receiptName('')).toBe('Receipt');
  });
});
