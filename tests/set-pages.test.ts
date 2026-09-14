import { describe, expect, it } from 'vitest';
import { numberSetPages, type DocumentPage } from '../src/core/set-pages';

const page = (document_id: string, page_index: number, text = `${document_id} page ${page_index}`): DocumentPage => ({
  document_id,
  page_index,
  text,
  readability: 1,
  headings: [],
});

describe('page numbers across a set (NOTES §43)', () => {
  it("gives a note's text and each of its pictures their own pages — no two page 0s on one key", () => {
    const set = numberSetPages(['text', 'pic1', 'pic2'], [page('pic2', 0), page('text', 0), page('pic1', 0)]);
    expect(set.pages.map((p) => [p.document_id, p.set_page])).toEqual([
      ['text', 0],
      ['pic1', 1],
      ['pic2', 2],
    ]);
    expect(set.locate(1)).toEqual({ documentId: 'pic1', pageIndex: 0 });
    expect(set.setPageOf('pic2', 0)).toBe(2);
  });

  it('numbers a set with one document exactly as before, so a stored plan still means the same pages', () => {
    const set = numberSetPages(['only'], [page('only', 0), page('only', 1), page('only', 2)]);
    expect(set.pages.map((p) => p.set_page)).toEqual([0, 1, 2]);
    expect(set.pages.map((p) => p.page_index)).toEqual([0, 1, 2]);
  });

  it('follows the order the documents were added, not the order the pages arrived', () => {
    const set = numberSetPages(['a', 'b'], [page('b', 0), page('b', 1), page('a', 0)]);
    expect(set.locate(0)).toEqual({ documentId: 'a', pageIndex: 0 });
    expect(set.locate(2)).toEqual({ documentId: 'b', pageIndex: 1 });
  });

  it('keeps a gap in one document from shifting the next', () => {
    const set = numberSetPages(['a', 'b'], [page('a', 0), page('a', 2), page('b', 0)]);
    expect(set.setPageOf('b', 0)).toBe(3);
    expect(set.locate(1)).toBeNull();
  });

  it('reads an older card saved with no document against the only document, and nothing else', () => {
    expect(numberSetPages(['a'], [page('a', 0)]).setPageOf(null, 0)).toBe(0);
    expect(numberSetPages(['a', 'b'], [page('a', 0), page('b', 0)]).setPageOf(null, 0)).toBeNull();
    expect(numberSetPages(['a'], [page('a', 0)]).setPageOf('a', null)).toBeNull();
  });

  it('does not lose a document that is missing from the order', () => {
    const set = numberSetPages(['a'], [page('a', 0), page('stray', 0)]);
    expect(set.setPageOf('stray', 0)).toBe(1);
  });
});
