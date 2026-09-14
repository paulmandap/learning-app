/**
 * Page numbers across every document in a set (NOTES §43).
 *
 * Pure. Each document numbers its own pages from 0, and the card-maker keyed
 * pages by that number alone — so in a set with two documents both page 0s
 * landed on one key, and a card's citation was checked against whichever of
 * them came last (found in NOTES §37.11 and left, because nothing the owner
 * used made such a set often). A note with pictures makes exactly that set: its
 * text is one document and each picture is another.
 *
 * So the card-maker works in SET page numbers — each document's pages after
 * the one before, in the order the documents were added — and every card is
 * written back with its own document and that document's own page number. The
 * first document keeps its numbers, so a set with one document is numbered
 * exactly as it always was, and a plan already stored for it still means the
 * same pages.
 */

export interface DocumentPage {
  document_id: string;
  page_index: number;
  text: string;
  readability: number;
  headings: string[];
}

export interface SetPage extends DocumentPage {
  /** This page's number across the whole set. */
  set_page: number;
}

export interface SetPages {
  pages: SetPage[];
  /**
   * The set page for a document's own page, or null when it is not in the set.
   * A card saved with no document (older rows) is read against the set's only
   * document when there is exactly one.
   */
  setPageOf(documentId: string | null | undefined, pageIndex: number | null | undefined): number | null;
  /** The document, and its own page number, behind a set page. */
  locate(setPage: number): { documentId: string; pageIndex: number } | null;
}

/**
 * Number a set's pages across its documents.
 *
 * `documentOrder` is the order documents were added (`listDocuments` returns
 * oldest first). A document with pages but missing from the order goes last,
 * rather than vanishing. A document is given as many numbers as its highest
 * page, so a page missing from the middle of one never shifts the next.
 */
export function numberSetPages(documentOrder: readonly string[], pages: readonly DocumentPage[]): SetPages {
  const listed = new Set(documentOrder);
  const order = [...documentOrder, ...new Set(pages.map((p) => p.document_id).filter((id) => !listed.has(id)))];

  const out: SetPage[] = [];
  const bySource = new Map<string, number>();
  const bySetPage = new Map<number, { documentId: string; pageIndex: number }>();
  const withPages: string[] = [];
  let offset = 0;

  for (const documentId of order) {
    const own = pages.filter((p) => p.document_id === documentId).sort((a, b) => a.page_index - b.page_index);
    if (own.length === 0) continue;
    withPages.push(documentId);
    for (const page of own) {
      const set_page = offset + page.page_index;
      out.push({ ...page, set_page });
      bySource.set(`${documentId}:${page.page_index}`, set_page);
      bySetPage.set(set_page, { documentId, pageIndex: page.page_index });
    }
    offset += own[own.length - 1]!.page_index + 1;
  }

  return {
    pages: out,
    setPageOf(documentId, pageIndex) {
      if (pageIndex === null || pageIndex === undefined) return null;
      const doc = documentId ?? (withPages.length === 1 ? withPages[0] : undefined);
      return doc === undefined ? null : (bySource.get(`${doc}:${pageIndex}`) ?? null);
    },
    locate(setPage) {
      return bySetPage.get(setPage) ?? null;
    },
  };
}
