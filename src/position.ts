import { state } from './state';

export function savePosition(): void {
  if (!state.currentBook) return;

  const params = new URLSearchParams();
  params.set('book', state.currentBook.file);
  params.set('ch', String(state.currentChapterIndex));
  history.replaceState(null, '', '#' + params.toString());

  localStorage.setItem('bookworm_position', JSON.stringify({
    book: state.currentBook.file,
    chapter: state.currentChapterIndex,
  }));
}

/** Returns saved chapter for the current book, or null. Chapters always
 *  open at page 0 — we don't resume mid-chapter. */
export function getSavedPosition(): { chapter: number } | null {
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const bookFile = params.get('book');
    const ch = params.get('ch');
    if (bookFile === state.currentBook?.file && ch != null) {
      return { chapter: parseInt(ch, 10) };
    }
  }

  try {
    const raw = localStorage.getItem('bookworm_position');
    if (raw) {
      const pos = JSON.parse(raw);
      if (pos.book === state.currentBook?.file) {
        return { chapter: pos.chapter };
      }
    }
  } catch { /* ignore */ }

  return null;
}
