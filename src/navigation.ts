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

// --- Layout state (module-level, computed by fitPageToLines) ---

let pageW = 0;
let lineH = 0;

// --- Layout: snap page width to an integer multiple of line pitch ---
// In vertical-rl, each "line" is a vertical column whose width equals the
// computed line-height. We pin the reader's width (= one page) to
// floor(available / lineH) * lineH so every page contains whole lines.
// line-height is forced to an integer pixel value because `1.4 * 24 = 33.6`
// causes sub-pixel drift that sliced glyphs after a few pages.

export function fitPageToLines(): void {
  const container = readerEl.parentElement;
  if (!container) return;
  const available = Math.floor(container.clientWidth);
  if (available <= 0) return;
  const cs = getComputedStyle(readerEl);
  const fontSize = parseFloat(cs.fontSize);
  lineH = Math.max(1, Math.round(fontSize * 1.4));
  readerEl.style.lineHeight = `${lineH}px`;
  const linesPerPage = Math.max(1, Math.floor(available / lineH));
  pageW = linesPerPage * lineH;
  readerEl.style.width = `${pageW}px`;
}

// --- Windowed chapter mounting ---
//
// Reader DOM contains only chapters inside the active window
// [current - preload .. current + preload]. Each mounted chapter has its own
// width rounded up to an integer multiple of pageW, so the last page of a
// chapter is a whole page and the next chapter starts fresh on a page
// boundary. Chapters outside the window don't exist in DOM at all.

function mountChapter(i: number): void {
  const ch = state.chapters[i];
  if (ch.el) return;
  const div = document.createElement('div');
  div.className = 'chapter';
  div.textContent = getChapterText(i);

  // Insert in chapter-index order so DOM order == chapter order. In
  // vertical-rl, first DOM child renders at the right (scrollLeft = 0).
  let nextSibling: Element | null = null;
  for (let j = i + 1; j < state.chapters.length; j++) {
    if (state.chapters[j].el) {
      nextSibling = state.chapters[j].el;
      break;
    }
  }
  readerEl.insertBefore(div, nextSibling);

  // Measure natural block size (horizontal width in vertical-rl) and snap up.
  const natural = div.offsetWidth;
  const snapped = Math.max(pageW, Math.ceil(natural / pageW) * pageW);
  div.style.width = `${snapped}px`;

  ch.el = div;
}

function unmountChapter(i: number): void {
  const ch = state.chapters[i];
  if (!ch.el) return;
  ch.el.remove();
  ch.el = null;
}

/** How many chapters to keep mounted on each side of current. Minimum 1 so
 *  the user can always swipe across a chapter boundary without hitting an
 *  unmounted edge. */
function windowRadius(): number {
  return Math.max(1, getSettings().preloadChapters);
}

/** Rebuild the chapter window centered on currentCh, compensating scrollLeft
 *  for any DOM shift so the user's visual position doesn't jump. */
function refreshWindow(currentCh: number): void {
  const r = windowRadius();
  const lo = Math.max(0, currentCh - r);
  const hi = Math.min(state.chapters.length - 1, currentCh + r);

  // Snapshot position BEFORE any DOM mutation. Reading offsetLeft forces
  // layout; we only need one pre-mutation reading.
  const curEl = state.chapters[currentCh].el;
  const scrollLeftBefore = readerEl.scrollLeft;
  const beforeOffsetLeft = curEl ? curEl.offsetLeft : 0;

  // Unmount chapters outside window
  for (let i = 0; i < state.chapters.length; i++) {
    if ((i < lo || i > hi) && state.chapters[i].el) {
      unmountChapter(i);
    }
  }

  // Mount chapters inside window that aren't mounted yet
  for (let i = lo; i <= hi; i++) {
    if (!state.chapters[i].el) {
      mountChapter(i);
    }
  }

  // Compensate scrollLeft: if chapters were added/removed before the
  // current chapter in DOM order, the current chapter's offsetLeft shifted.
  const afterEl = state.chapters[currentCh].el!;
  const delta = afterEl.offsetLeft - beforeOffsetLeft;
  if (delta !== 0) {
    readerEl.scrollLeft = scrollLeftBefore - delta;
  }
}

// --- Chapter change notification ---

function onChapterChanged(i: number): void {
  highlightActiveChapter(i);
  if (state.tts) state.tts.setSentences(splitSentences(getChapterText(i)));
}

// --- Entry points ---

/** Initial layout when opening a book. Clears any previous state and mounts
 *  the window around the starting chapter, scrolling to the given page. */
export function openBookLayout(chapterIdx: number, pageInCh: number): void {
  readerEl.innerHTML = '';
  for (const ch of state.chapters) ch.el = null;

  fitPageToLines();

  state.currentChapterIndex = chapterIdx;
  const r = windowRadius();
  const lo = Math.max(0, chapterIdx - r);
  const hi = Math.min(state.chapters.length - 1, chapterIdx + r);
  for (let j = lo; j <= hi; j++) mountChapter(j);

  const el = state.chapters[chapterIdx].el!;
  readerEl.scrollLeft = -(el.offsetLeft + pageInCh * pageW);

  onChapterChanged(chapterIdx);
  updatePageInfo();
}

/** Jump to a specific chapter via chapter list. Tears down the current
 *  window and rebuilds around the target at page 0. */
export function goToChapter(i: number): void {
  if (i < 0 || i >= state.chapters.length) return;
  openBookLayout(i, 0);
  chapterPanel.classList.add('hidden');
}

/** Called on font-size change, viewport resize, or font load. pageW/lineH
 *  may have changed, so all mounted chapter widths are stale. Re-measure
 *  and preserve the user's current {chapter, page} position. */
export function relayout(): void {
  const curIdx = state.currentChapterIndex;
  const curEl = state.chapters[curIdx]?.el;
  const oldPageW = pageW || 1;
  const page = curEl
    ? Math.round((Math.abs(readerEl.scrollLeft) - curEl.offsetLeft) / oldPageW)
    : 0;

  fitPageToLines();

  // Re-measure each mounted chapter against the new pageW/lineH.
  for (const ch of state.chapters) {
    if (!ch.el) continue;
    ch.el.style.width = 'auto';
    const natural = ch.el.offsetWidth;
    ch.el.style.width = `${Math.max(pageW, Math.ceil(natural / pageW) * pageW)}px`;
  }

  const newCurEl = state.chapters[curIdx]?.el;
  if (newCurEl) {
    readerEl.scrollLeft = -(newCurEl.offsetLeft + page * pageW);
  }

  // Apply any window-radius change (e.g. user just moved the preload slider).
  refreshWindow(curIdx);

  updatePageInfo();
}

// --- Page info & persistence ---

let lastSavedChapter = -1;
let lastSavedPage = -1;

export function updatePageInfo(): void {
  const ch = state.chapters[state.currentChapterIndex];
  if (!ch || !ch.el || pageW <= 0) {
    pageInfoEl.textContent = '';
    pageSlider.value = '0';
    pageSlider.max = '0';
    return;
  }
  const total = state.chapters.length;
  const chPages = Math.max(1, Math.round(ch.el.offsetWidth / pageW));
  const rawPage = Math.round((Math.abs(readerEl.scrollLeft) - ch.el.offsetLeft) / pageW);
  const page = Math.max(0, Math.min(chPages - 1, rawPage));

  pageInfoEl.textContent = `${state.currentChapterIndex + 1}/${total}  ${page + 1}/${chPages}`;
  pageSlider.max = String(chPages - 1);
  pageSlider.value = String(page);

  // Persist only on actual page change to avoid hammering history.replaceState
  if (state.currentChapterIndex !== lastSavedChapter || page !== lastSavedPage) {
    lastSavedChapter = state.currentChapterIndex;
    lastSavedPage = page;
    savePosition(state.currentChapterIndex, page);
  }
}

// --- Page navigation ---

export function nextPage(): void {
  // vertical-rl: "next page" advances to the left (more negative scrollLeft)
  if (pageW > 0) readerEl.scrollBy({ left: -pageW, behavior: 'smooth' });
}

export function prevPage(): void {
  if (pageW > 0) readerEl.scrollBy({ left: pageW, behavior: 'smooth' });
}

// --- Current-chapter detection from scrollLeft ---

function findChapterAtScroll(): number {
  const x = Math.abs(readerEl.scrollLeft);
  const r = windowRadius();
  const cur = state.currentChapterIndex;
  const lo = Math.max(0, cur - r);
  const hi = Math.min(state.chapters.length - 1, cur + r);
  for (let i = lo; i <= hi; i++) {
    const el = state.chapters[i].el;
    if (!el) continue;
    const left = el.offsetLeft;
    if (x >= left && x < left + el.offsetWidth) return i;
  }
  return cur;
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
    const ch = state.chapters[state.currentChapterIndex];
    if (!ch || !ch.el) return;
    readerEl.scrollLeft = -(ch.el.offsetLeft + p * pageW);
  };
  $('nav-prev').onclick = prevPage;
  $('nav-next').onclick = nextPage;

  // Scroll listener: detect chapter boundary crossings, refresh window,
  // update page info. refreshWindow preserves the user's visual position so
  // the scroll correction it issues doesn't cause re-entry loops.
  readerEl.addEventListener('scroll', () => {
    if (!state.currentBook) return;
    const ch = findChapterAtScroll();
    if (ch !== state.currentChapterIndex) {
      state.currentChapterIndex = ch;
      refreshWindow(ch);
      onChapterChanged(ch);
    }
    updatePageInfo();
  });

  // Resize observer: viewport / rotation / font changes require full relayout
  const container = readerEl.parentElement;
  if (container && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (state.currentBook) relayout();
    });
    ro.observe(container);
  }

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (!state.currentBook) return;
    switch (e.key) {
      case 'ArrowLeft': case 'PageDown': nextPage(); break;
      case 'ArrowRight': case 'PageUp': prevPage(); break;
    }
  });

  // Touch swipe & tap
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

  // Desktop click — skip if touch just fired
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

// --- Reset (book close) ---

export function resetReader(): void {
  readerEl.innerHTML = '';
  for (const ch of state.chapters) ch.el = null;
  lastSavedChapter = -1;
  lastSavedPage = -1;
}
