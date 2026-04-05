import { state, getChapterText } from './state';
import { savePosition } from './position';
import { splitSentences } from './tts';
import { toggleChrome } from './ui';
import { getSettings } from './settings';

const $ = (id: string) => document.getElementById(id)!;
const readerEl = $('reader') as HTMLDivElement;
const pageInfoEl = $('page-info');
const pageSlider = $('page-slider') as HTMLInputElement;
const chapterListEl = $('chapter-list');
const chapterPanel = $('chapter-panel');

// --- Layout state ---
// pageW/lineH are recomputed by fitPageToLines on every relayout.

let pageW = 0;
let lineH = 0;

// --- Ghost container ---
// Off-screen element that holds pre-measured neighbor chapters. Styled
// identically to .reader (same font, line-height, height, padding) so a
// chapter div measures the same whether it lives in the ghost or the real
// reader. Detached divs get moved into the reader on swap — no re-measure,
// zero visible delay.

let ghostEl: HTMLDivElement | null = null;
const ghostCache = new Map<number, HTMLDivElement>();

function ensureGhost(): void {
  if (ghostEl) return;
  const el = document.createElement('div');
  el.id = 'reader-ghost';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  ghostEl = el;
}

// --- Page width: snap to integer multiple of line pitch ---
// In vertical-rl, each "line" is a vertical column whose width = line-height.
// Line-height is forced to an integer pixel value because fractional values
// like 33.6 (= 1.4 * 24) cause sub-pixel drift across paginated scrolls and
// slice glyphs at page edges.

export function fitPageToLines(): void {
  const container = readerEl.parentElement;
  if (!container) return;
  const available = Math.floor(container.clientWidth);
  if (available <= 0) return;
  const cs = getComputedStyle(readerEl);
  const fontSize = parseFloat(cs.fontSize);
  lineH = Math.max(1, Math.round(fontSize * 1.4));
  const linesPerPage = Math.max(1, Math.floor(available / lineH));
  pageW = linesPerPage * lineH;

  readerEl.style.lineHeight = `${lineH}px`;
  readerEl.style.width = `${pageW}px`;
  // Ghost must match so measurement reflects real layout
  if (ghostEl) ghostEl.style.lineHeight = `${lineH}px`;
}

// --- Chapter build & cache ---

function buildChapter(i: number): HTMLDivElement {
  ensureGhost();
  const div = document.createElement('div');
  div.className = 'chapter';
  div.dataset.ch = String(i);
  div.textContent = getChapterText(i);

  // Measure in ghost so it doesn't affect the reader's current layout
  ghostEl!.appendChild(div);
  const natural = div.offsetWidth;
  const snapped = Math.max(pageW, Math.ceil(natural / pageW) * pageW);
  div.style.width = `${snapped}px`;
  return div;
}

function getChapterEl(i: number): HTMLDivElement {
  const cached = ghostCache.get(i);
  if (cached) {
    ghostCache.delete(i);
    return cached;
  }
  return buildChapter(i);
}

function evictGhostOutsideWindow(i: number): void {
  const r = getSettings().preloadChapters;
  const lo = Math.max(0, i - r);
  const hi = Math.min(state.chapters.length - 1, i + r);
  for (const [idx, div] of ghostCache) {
    if (idx < lo || idx > hi) {
      div.remove();
      ghostCache.delete(idx);
    }
  }
}

function ensureNeighborsPreloaded(i: number): void {
  const r = getSettings().preloadChapters;
  const lo = Math.max(0, i - r);
  const hi = Math.min(state.chapters.length - 1, i + r);
  for (let j = lo; j <= hi; j++) {
    if (j === i) continue;
    if (ghostCache.has(j)) continue;
    const el = buildChapter(j);
    ghostCache.set(j, el);
  }
}

/** Called from app.ts when the preload slider changes: just prune and fill
 *  the ghost cache to match the new window radius. No reader remount. */
export function refreshPreloadWindow(): void {
  if (!state.currentBook) return;
  const i = state.currentChapterIndex;
  evictGhostOutsideWindow(i);
  ensureNeighborsPreloaded(i);
}

// --- Chapter swap (the one place that changes what's visible) ---

/** Swap the active chapter. `page` is the page index to land on; pass -1 for
 *  the last page (used when paging backward across a chapter boundary). */
function showChapter(i: number, page: number): void {
  if (i < 0 || i >= state.chapters.length) return;

  // Stash the currently-visible chapter back into the ghost cache
  const current = readerEl.firstElementChild as HTMLDivElement | null;
  if (current && current.dataset.ch) {
    const oldIdx = parseInt(current.dataset.ch, 10);
    current.remove();
    ghostCache.set(oldIdx, current);
    ensureGhost();
    ghostEl!.appendChild(current);
  }

  // Bring in (or build) the target chapter
  const el = getChapterEl(i);
  readerEl.appendChild(el);
  state.currentChapterIndex = i;

  // Scroll to target page within the chapter
  const maxPage = Math.max(0, Math.round(el.offsetWidth / pageW) - 1);
  const targetPage = page < 0 ? maxPage : Math.min(Math.max(0, page), maxPage);
  readerEl.scrollLeft = -(targetPage * pageW);

  // Keep the ghost cache in sync with the window
  evictGhostOutsideWindow(i);
  ensureNeighborsPreloaded(i);

  onChapterChanged(i);
  updatePageInfo();
}

function onChapterChanged(i: number): void {
  highlightActiveChapter(i);
  if (state.tts) state.tts.setSentences(splitSentences(getChapterText(i)));
}

// --- Entry points ---

export function openBookLayout(chapterIdx: number, pageInCh: number): void {
  resetReader();
  ensureGhost();
  fitPageToLines();
  showChapter(chapterIdx, pageInCh);
}

export function goToChapter(i: number): void {
  if (i < 0 || i >= state.chapters.length) return;
  showChapter(i, 0);
  chapterPanel.classList.add('hidden');
}

/** Full relayout: font-size change, viewport resize, or font load. pageW and
 *  lineH may have changed, so every cached chapter's width is stale. */
export function relayout(): void {
  if (!state.currentBook) return;

  const curEl = readerEl.firstElementChild as HTMLDivElement | null;
  const oldPageW = pageW || 1;
  const oldPage = curEl
    ? Math.round(Math.abs(readerEl.scrollLeft) / oldPageW)
    : 0;

  fitPageToLines();

  // Invalidate ghost cache wholesale — everything inside was measured at
  // the old pageW/lineH.
  if (ghostEl) ghostEl.innerHTML = '';
  ghostCache.clear();

  if (curEl) {
    curEl.style.width = 'auto';
    const natural = curEl.offsetWidth;
    curEl.style.width = `${Math.max(pageW, Math.ceil(natural / pageW) * pageW)}px`;
    const maxPage = Math.max(0, Math.round(curEl.offsetWidth / pageW) - 1);
    const page = Math.min(oldPage, maxPage);
    readerEl.scrollLeft = -(page * pageW);
  }

  ensureNeighborsPreloaded(state.currentChapterIndex);
  updatePageInfo();
}

// --- Page info & persistence ---

let lastSavedChapter = -1;
let lastSavedPage = -1;

export function updatePageInfo(): void {
  const curEl = readerEl.firstElementChild as HTMLDivElement | null;
  if (!curEl || pageW <= 0) {
    pageInfoEl.textContent = '';
    pageSlider.value = '0';
    pageSlider.max = '0';
    return;
  }
  const total = state.chapters.length;
  const chPages = Math.max(1, Math.round(curEl.offsetWidth / pageW));
  const rawPage = Math.round(Math.abs(readerEl.scrollLeft) / pageW);
  const page = Math.max(0, Math.min(chPages - 1, rawPage));

  pageInfoEl.textContent = `${state.currentChapterIndex + 1}/${total}  ${page + 1}/${chPages}`;
  pageSlider.max = String(chPages - 1);
  pageSlider.value = String(page);

  if (state.currentChapterIndex !== lastSavedChapter || page !== lastSavedPage) {
    lastSavedChapter = state.currentChapterIndex;
    lastSavedPage = page;
    savePosition(state.currentChapterIndex, page);
  }
}

// --- Page navigation ---
// Within a chapter, scrollBy handles pagination. At chapter boundaries we
// swap the chapter div outright — no cross-chapter animation.

export function nextPage(): void {
  if (pageW <= 0) return;
  const maxScroll = readerEl.scrollWidth - readerEl.clientWidth;
  const atEnd = Math.abs(readerEl.scrollLeft) >= maxScroll - 2;
  if (atEnd) {
    if (state.currentChapterIndex + 1 < state.chapters.length) {
      showChapter(state.currentChapterIndex + 1, 0);
    }
  } else {
    readerEl.scrollBy({ left: -pageW, behavior: 'smooth' });
  }
}

export function prevPage(): void {
  if (pageW <= 0) return;
  const atStart = Math.abs(readerEl.scrollLeft) < 2;
  if (atStart) {
    if (state.currentChapterIndex > 0) {
      showChapter(state.currentChapterIndex - 1, -1);
    }
  } else {
    readerEl.scrollBy({ left: pageW, behavior: 'smooth' });
  }
}

// --- Chapter list UI ---

let chapterListDirty = true;

export function markChapterListDirty(): void {
  chapterListDirty = true;
  chapterListEl.innerHTML = '';
}

export function ensureChapterListPopulated(): void {
  if (!chapterListDirty) return;
  chapterListDirty = false;
  chapterListEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    li.textContent = ch.title;
    li.onclick = () => goToChapter(i);
    frag.appendChild(li);
  });
  chapterListEl.appendChild(frag);
  highlightActiveChapter(state.currentChapterIndex);
}

function highlightActiveChapter(index: number): void {
  const items = chapterListEl.querySelectorAll('li');
  items.forEach((li, i) => li.classList.toggle('active', i === index));
}

// --- Input handling (touch + click + keyboard) ---

let lastTouchEnd = 0;

export function bindNavigationEvents(): void {
  pageSlider.oninput = () => {
    const p = parseInt(pageSlider.value, 10);
    if (pageW > 0) readerEl.scrollLeft = -(p * pageW);
  };
  $('nav-prev').onclick = prevPage;
  $('nav-next').onclick = nextPage;

  // Within-chapter scrolling just updates page info; chapter boundaries are
  // crossed explicitly via nextPage/prevPage/goToChapter, not by scrolling.
  readerEl.addEventListener('scroll', () => {
    if (!state.currentBook) return;
    updatePageInfo();
  });

  // Viewport / rotation / font-load triggers full relayout
  const container = readerEl.parentElement;
  if (container && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => relayout());
    ro.observe(container);
  }

  document.addEventListener('keydown', (e) => {
    if (!state.currentBook) return;
    switch (e.key) {
      case 'ArrowLeft': case 'PageDown': nextPage(); break;
      case 'ArrowRight': case 'PageUp': prevPage(); break;
    }
  });

  let touchStartX = 0;
  let touchStartY = 0;
  readerEl.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  });
  readerEl.addEventListener('touchend', (e) => {
    lastTouchEnd = Date.now();
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const dx = endX - touchStartX;
    const dy = endY - touchStartY;

    if (Math.abs(dx) > 50) {
      if (dx > 0) nextPage(); else prevPage();
    } else if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
      handleTapZone(endX, endY);
    }
  });

  readerEl.addEventListener('click', (e) => {
    if (Date.now() - lastTouchEnd < 300) return;
    handleTapZone(e.clientX, e.clientY);
  });
}

function handleTapZone(x: number, y: number): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (x > w / 3 && x < (2 * w) / 3 && y > h / 3 && y < (2 * h) / 3) {
    toggleChrome();
  } else if (y > h / 2) {
    if (x < w / 4) nextPage();
    else if (x > (3 * w) / 4) prevPage();
  }
}

// --- Reset ---

export function resetReader(): void {
  readerEl.innerHTML = '';
  if (ghostEl) ghostEl.innerHTML = '';
  ghostCache.clear();
  lastSavedChapter = -1;
  lastSavedPage = -1;
}
