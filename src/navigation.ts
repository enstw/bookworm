import { state, getChapterText } from './state';
import { savePosition } from './position';
import { splitSentences } from './tts';
import { toggleChrome } from './ui';

const $ = (id: string) => document.getElementById(id)!;
const readerEl = $('reader') as HTMLDivElement;
const pageInfoEl = $('page-info');
const pageSlider = $('page-slider') as HTMLInputElement;
const chapterListEl = $('chapter-list');
const chapterPanel = $('chapter-panel');

// --- Chapter rendering ---

export function renderChapter(index: number): void {
  if (index < 0 || index >= state.chapters.length) return;
  state.currentChapterIndex = index;
  const text = getChapterText(index);
  readerEl.textContent = text;
  readerEl.scrollLeft = 0;
  updatePageInfo();
  highlightActiveChapter(index);
  if (state.tts) state.tts.setSentences(splitSentences(text));
}

// --- Page info ---

export function updatePageInfo(): void {
  const maxScroll = readerEl.scrollWidth - readerEl.clientWidth;
  if (maxScroll <= 0) {
    pageInfoEl.textContent = `${state.currentChapterIndex + 1}/${state.chapters.length}  1/1`;
    pageSlider.value = '0';
    pageSlider.max = '0';
    savePosition();
    return;
  }

  const scrollPos = Math.abs(readerEl.scrollLeft);
  const pageWidth = readerEl.clientWidth;
  const totalPages = Math.ceil(readerEl.scrollWidth / pageWidth);
  const currentPage = Math.floor(scrollPos / pageWidth) + 1;

  pageInfoEl.textContent = `${state.currentChapterIndex + 1}/${state.chapters.length}  ${currentPage}/${totalPages}`;
  pageSlider.max = String(totalPages - 1);
  pageSlider.value = String(currentPage - 1);
  savePosition();
}

// --- Page navigation ---

export function scrollToPage(pageIndex: number): void {
  readerEl.scrollLeft = -(pageIndex * readerEl.clientWidth);
}

export function nextPage(): void {
  const pageWidth = readerEl.clientWidth;
  const maxScroll = readerEl.scrollWidth - readerEl.clientWidth;
  const atEnd = Math.abs(readerEl.scrollLeft) >= maxScroll - 2;
  if (atEnd && state.currentChapterIndex + 1 < state.chapters.length) {
    renderChapter(state.currentChapterIndex + 1);
  } else {
    readerEl.scrollBy({ left: -pageWidth, behavior: 'smooth' });
  }
}

export function prevPage(): void {
  const pageWidth = readerEl.clientWidth;
  const atStart = Math.abs(readerEl.scrollLeft) < 2;
  if (atStart && state.currentChapterIndex > 0) {
    renderChapter(state.currentChapterIndex - 1);
    requestAnimationFrame(() => {
      readerEl.scrollLeft = -(readerEl.scrollWidth - readerEl.clientWidth);
      updatePageInfo();
    });
  } else {
    readerEl.scrollBy({ left: pageWidth, behavior: 'smooth' });
  }
}

// --- Chapter navigation ---

export function goToChapter(index: number): void {
  if (index < 0 || index >= state.chapters.length) return;
  renderChapter(index);
  chapterPanel.classList.add('hidden');
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

// --- Unified input handling (touch + click + keyboard) ---

let lastTouchEnd = 0;

export function bindNavigationEvents(): void {
  pageSlider.oninput = () => scrollToPage(parseInt(pageSlider.value, 10));
  $('nav-prev').onclick = prevPage;
  $('nav-next').onclick = nextPage;
  readerEl.addEventListener('scroll', () => updatePageInfo());

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (!state.currentBook) return;
    switch (e.key) {
      case 'ArrowLeft': case 'PageDown': nextPage(); break;
      case 'ArrowRight': case 'PageUp': prevPage(); break;
      case 'Home': readerEl.scrollLeft = 0; break;
      case 'End': readerEl.scrollLeft = -(readerEl.scrollWidth); break;
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
  // Center 1/9 toggles chrome
  if (x > w / 3 && x < (2 * w) / 3 && y > h / 3 && y < (2 * h) / 3) {
    toggleChrome();
  // Bottom half: left 1/4 = next, right 1/4 = prev
  } else if (y > h / 2) {
    if (x < w / 4) nextPage();
    else if (x > (3 * w) / 4) prevPage();
  }
}
