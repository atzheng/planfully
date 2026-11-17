import { describe, expect, test } from 'vitest';
import { ApiError } from '../lib/api';
import { describeUploadError, mergeAttachments, receiptName } from './UploadButtons';

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

const att = (id: string) => ({ id, filename: id, mime: 'x/y', size: 1, kind: 'file' as const });

describe('mergeAttachments', () => {
  test('uses the current list, so an attachment that appeared mid-upload is kept', () => {
    // The sheet opened with [a]; while uploading, a sync brought in b.
    const current = [att('a'), att('b')];
    expect(mergeAttachments(current, [att('c')]).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  test('skips ids already present', () => {
    expect(mergeAttachments([att('a'), att('c')], [att('c')]).map((x) => x.id)).toEqual(['a', 'c']);
  });
});

describe('describeUploadError', () => {
  test('tells the cases apart', () => {
    expect(describeUploadError(new ApiError(413, 'x'), 'f.pdf', 'upload')).toMatch(/too large/);
    expect(describeUploadError(new ApiError(500, 'x'), 'f.pdf', 'save')).toMatch(
      /uploaded but could not be saved: the server refused it \(500\)/,
    );
    expect(describeUploadError(new TypeError('fetch'), 'f.pdf', 'upload')).toMatch(/connection/);
  });
});
