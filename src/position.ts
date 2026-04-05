import { state } from './state';

export function savePosition(chapter: number, page: number): void {
  if (!state.currentBook) return;

  const params = new URLSearchParams();
  params.set('book', state.currentBook.file);
  params.set('ch', String(chapter));
  params.set('p', String(page));
  history.replaceState(null, '', '#' + params.toString());

  localStorage.setItem('bookworm_position', JSON.stringify({
    book: state.currentBook.file,
    chapter,
    page,
  }));
}

/** Returns saved {chapter, page} for the current book, or null. */
export function getSavedPosition(): { chapter: number; page: number } | null {
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const bookFile = params.get('book');
    const ch = params.get('ch');
    const p = params.get('p');
    if (bookFile === state.currentBook?.file && ch != null) {
      return {
        chapter: parseInt(ch, 10),
        page: p != null ? parseInt(p, 10) : 0,
      };
    }
  }

  try {
    const raw = localStorage.getItem('bookworm_position');
    if (raw) {
      const pos = JSON.parse(raw);
      if (pos.book === state.currentBook?.file) {
        return {
          chapter: pos.chapter ?? 0,
          page: pos.page ?? 0,
        };
      }
    }
  } catch { /* ignore */ }

  return null;
}
