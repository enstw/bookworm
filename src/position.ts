import { state } from './state';

const readerEl = document.getElementById('reader') as HTMLDivElement;

export function savePosition(): void {
  if (!state.currentBook) return;

  const params = new URLSearchParams();
  params.set('book', state.currentBook.file);
  params.set('ch', String(state.currentChapterIndex));
  params.set('pos', String(Math.round(readerEl.scrollLeft)));
  history.replaceState(null, '', '#' + params.toString());

  localStorage.setItem('bookworm_position', JSON.stringify({
    book: state.currentBook.file,
    chapter: state.currentChapterIndex,
    scrollLeft: readerEl.scrollLeft,
  }));
}

/** Returns saved position if it matches the current book, or null. */
export function getSavedPosition(): { chapter: number; scrollLeft: number } | null {
  // Try URL hash first
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const bookFile = params.get('book');
    const ch = params.get('ch');
    const pos = params.get('pos');
    if (bookFile === state.currentBook?.file && ch != null) {
      return { chapter: parseInt(ch, 10), scrollLeft: pos ? parseInt(pos, 10) : 0 };
    }
  }

  // Fallback to localStorage
  try {
    const raw = localStorage.getItem('bookworm_position');
    if (raw) {
      const pos = JSON.parse(raw);
      if (pos.book === state.currentBook?.file) {
        return { chapter: pos.chapter, scrollLeft: pos.scrollLeft };
      }
    }
  } catch { /* ignore */ }

  return null;
}
