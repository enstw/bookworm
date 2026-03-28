import type { Book, Chapter, AppSettings, ReadingPosition } from './types';
import { detectChapters, findCurrentChapter } from './chapters';
import { loadFontList, registerFonts, applyFont } from './fonts';
import { AITextToSpeech, splitSentences } from './tts';

// We load fflate and OpenCC from CDN — declare their types
declare const fflate: {
  unzipSync: (data: Uint8Array) => Record<string, Uint8Array>;
};
declare const OpenCC: {
  Converter: (options: { from: string; to: string }) => (s: string) => string;
};

declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

// --- DOM Elements ---
const $ = (id: string) => document.getElementById(id)!;
const bookSelector = $('book-selector');
const bookListEl = $('book-list');
const settingsPanel = $('settings-panel');
const chapterPanel = $('chapter-panel');
const readerEl = $('reader') as HTMLDivElement;
const loadingOverlay = $('loading');
const loadingText = $('loading-text');
const bookTitleEl = $('book-title');
const pageInfoEl = $('page-info');
const chapterListEl = $('chapter-list');
const pageSlider = $('page-slider') as HTMLInputElement;

// Settings inputs
const fontSelect = $('font-select') as HTMLSelectElement;
const fontSizeInput = $('font-size') as HTMLInputElement;
const fontSizeLabel = $('font-size-label');
const themeSelect = $('theme-select') as HTMLSelectElement;
const ttsEndpointInput = $('tts-endpoint') as HTMLInputElement;
const ttsApiKeyInput = $('tts-api-key') as HTMLInputElement;
const ttsModelInput = $('tts-model') as HTMLInputElement;
const ttsVoiceInput = $('tts-voice') as HTMLInputElement;
const ttsSpeedInput = $('tts-speed') as HTMLInputElement;
const ttsSpeedLabel = $('tts-speed-label');

// TTS elements
const ttsBar = $('tts-bar');
const ttsPlayBtn = $('tts-play');
const ttsStatusEl = $('tts-status');

// --- App State ---
let books: Book[] = [];
let currentBook: Book | null = null;
let fullText = '';
let chapters: Chapter[] = [];
let converter: ((s: string) => string) | null = null;
let tts: AITextToSpeech | null = null;
let chromeTimer: ReturnType<typeof setTimeout> | null = null;

// --- Settings ---
function loadSettings(): AppSettings {
  const raw = localStorage.getItem('bookworm_settings');
  const defaults: AppSettings = {
    fontSize: 24,
    theme: 'light',
    font: 'default',
    tts: { endpoint: '', apiKey: '', model: 'tts-1', voice: 'alloy', speed: 1.0 },
  };
  if (!raw) return defaults;
  try {
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function saveSettings(settings: AppSettings): void {
  localStorage.setItem('bookworm_settings', JSON.stringify(settings));
}

function applySettings(settings: AppSettings): void {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--font-size', settings.fontSize + 'px');
  themeSelect.value = settings.theme;
  fontSizeInput.value = String(settings.fontSize);
  fontSizeLabel.textContent = settings.fontSize + 'px';
  fontSelect.value = settings.font;
  applyFont(settings.font);

  ttsEndpointInput.value = settings.tts.endpoint;
  ttsApiKeyInput.value = settings.tts.apiKey;
  ttsModelInput.value = settings.tts.model;
  ttsVoiceInput.value = settings.tts.voice;
  ttsSpeedInput.value = String(settings.tts.speed);
  ttsSpeedLabel.textContent = settings.tts.speed + 'x';
}

// --- Loading ---
function showLoading(msg: string): void {
  loadingText.textContent = msg;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading(): void {
  loadingOverlay.classList.add('hidden');
}

// --- Book List ---
async function loadBookList(): Promise<void> {
  try {
    const res = await fetch('books/index.json');
    books = await res.json();
  } catch {
    books = [];
  }

  bookListEl.innerHTML = '';
  if (books.length === 0) {
    bookListEl.innerHTML = '<p style="opacity:0.5">找不到書籍。請在 books/ 資料夾中新增 .zip 檔案並更新 index.json。</p>';
    return;
  }

  for (const book of books) {
    const div = document.createElement('div');
    div.className = 'book-item';
    div.textContent = converter ? converter(book.name) : book.name;
    div.onclick = () => openBook(book);
    bookListEl.appendChild(div);
  }
}

// --- Open Book ---
async function openBook(book: Book): Promise<void> {
  showLoading('正在載入書籍…');
  currentBook = book;

  try {
    // Fetch the zip
    showLoading('正在下載…');
    const res = await fetch(`books/${book.file}`);
    const buf = new Uint8Array(await res.arrayBuffer());

    // Unzip
    showLoading('正在解壓縮…');
    const files = fflate.unzipSync(buf);
    const txtFile = Object.keys(files).find(k => k.endsWith('.txt'));
    if (!txtFile) throw new Error('ZIP 中找不到 .txt 檔案');
    const raw = files[txtFile];

    // Decode GB18030
    showLoading('正在解碼文字…');
    const decoded = new TextDecoder('gb18030').decode(raw);

    // SC → TC conversion
    showLoading('正在轉換為繁體…');
    fullText = converter!(decoded);

    // Detect chapters
    showLoading('正在分析章節…');
    chapters = detectChapters(fullText);

    // Render
    renderBook();
    populateChapterList();
    bookSelector.classList.add('hidden');
    bookTitleEl.textContent = converter(book.name);
    enterReadingMode();

    // Restore reading position
    restorePosition();

    // Set up TTS sentences
    const settings = loadSettings();
    tts = new AITextToSpeech(settings.tts, handleTTSState);
    tts.setSentences(splitSentences(fullText));

    hideLoading();
  } catch (e: any) {
    hideLoading();
    alert(`載入失敗: ${e.message}`);
    console.error(e);
  }
}

// --- Render ---
function renderBook(): void {
  readerEl.textContent = fullText;
  updatePageInfo();
}

function updatePageInfo(): void {
  const el = readerEl;
  const maxScroll = el.scrollWidth - el.clientWidth;
  if (maxScroll <= 0) {
    pageInfoEl.textContent = '1 / 1';
    pageSlider.value = '0';
    pageSlider.max = '0';
    return;
  }

  // In vertical-rl, scrollLeft is negative (right-to-left)
  const scrollPos = Math.abs(el.scrollLeft);
  const pageWidth = el.clientWidth;
  const totalPages = Math.ceil(el.scrollWidth / pageWidth);
  const currentPage = Math.floor(scrollPos / pageWidth) + 1;

  pageInfoEl.textContent = `${currentPage} / ${totalPages}`;
  pageSlider.max = String(totalPages - 1);
  pageSlider.value = String(currentPage - 1);

  // Update URL hash
  savePosition();
}

// --- Navigation ---
function scrollToPage(pageIndex: number): void {
  const pageWidth = readerEl.clientWidth;
  // vertical-rl: scrollLeft goes negative
  readerEl.scrollLeft = -(pageIndex * pageWidth);
}

function nextPage(): void {
  const pageWidth = readerEl.clientWidth;
  readerEl.scrollBy({ left: -pageWidth, behavior: 'smooth' });
}

function prevPage(): void {
  const pageWidth = readerEl.clientWidth;
  readerEl.scrollBy({ left: pageWidth, behavior: 'smooth' });
}

function goToChapter(index: number): void {
  if (index < 0 || index >= chapters.length) return;
  const chapter = chapters[index];

  // Find the character position ratio and scroll to it
  const ratio = chapter.startIndex / fullText.length;
  const targetScroll = ratio * readerEl.scrollWidth;
  readerEl.scrollLeft = -targetScroll;

  chapterPanel.classList.add('hidden');
  updatePageInfo();
  highlightActiveChapter(index);
}

// --- Chapter List ---
function populateChapterList(): void {
  chapterListEl.innerHTML = '';
  chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    li.textContent = ch.title;
    li.onclick = () => goToChapter(i);
    chapterListEl.appendChild(li);
  });
}

function highlightActiveChapter(index: number): void {
  const items = chapterListEl.querySelectorAll('li');
  items.forEach((li, i) => li.classList.toggle('active', i === index));
}

// --- Position / Bookmarks ---
function savePosition(): void {
  if (!currentBook) return;
  const pos: ReadingPosition = {
    book: currentBook.file,
    chapter: 0,
    scrollLeft: readerEl.scrollLeft,
  };

  // Determine current chapter
  const scrollRatio = Math.abs(readerEl.scrollLeft) / readerEl.scrollWidth;
  const charPos = Math.floor(scrollRatio * fullText.length);
  pos.chapter = findCurrentChapter(chapters, charPos);
  highlightActiveChapter(pos.chapter);

  // Save to URL hash
  const params = new URLSearchParams();
  params.set('book', currentBook.file);
  params.set('pos', String(Math.round(readerEl.scrollLeft)));
  history.replaceState(null, '', '#' + params.toString());

  // Also save to localStorage for convenience
  localStorage.setItem('bookworm_position', JSON.stringify(pos));
}

function restorePosition(): void {
  // Try URL hash first
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const bookFile = params.get('book');
    const pos = params.get('pos');
    if (bookFile === currentBook?.file && pos) {
      readerEl.scrollLeft = parseInt(pos, 10);
      updatePageInfo();
      return;
    }
  }

  // Fallback to localStorage
  try {
    const raw = localStorage.getItem('bookworm_position');
    if (raw) {
      const pos: ReadingPosition = JSON.parse(raw);
      if (pos.book === currentBook?.file) {
        readerEl.scrollLeft = pos.scrollLeft;
        updatePageInfo();
      }
    }
  } catch { /* ignore */ }
}

// --- TTS ---
function handleTTSState(state: string, info?: string): void {
  switch (state) {
    case 'playing':
      ttsPlayBtn.textContent = '⏸';
      ttsStatusEl.textContent = info ?? '播放中…';
      break;
    case 'paused':
      ttsPlayBtn.textContent = '▶';
      ttsStatusEl.textContent = '已暫停';
      break;
    case 'stopped':
      ttsPlayBtn.textContent = '▶';
      ttsStatusEl.textContent = '';
      break;
    case 'error':
      ttsPlayBtn.textContent = '▶';
      ttsStatusEl.textContent = `錯誤: ${info}`;
      break;
  }
}

// --- Reading Mode ---
function isMobile(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function enterReadingMode(): void {
  document.body.classList.add('reading-mode');
  $('scroll-spacer').style.display = 'block';
}

function exitReadingMode(): void {
  document.body.classList.remove('reading-mode', 'chrome-visible');
  $('scroll-spacer').style.display = 'none';
  window.scrollTo(0, 0);
  if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null; }
  exitFullscreen();
}

function requestFullscreen(): void {
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) {
    el.requestFullscreen().catch(() => {});
  }
}

function exitFullscreen(): void {
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    exitFullscreen();
  } else {
    requestFullscreen();
  }
}

function toggleChrome(): void {
  const body = document.body;
  if (body.classList.contains('chrome-visible')) {
    body.classList.remove('chrome-visible');
    if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null; }
  } else {
    body.classList.add('chrome-visible');
    // Auto-hide after 4 seconds
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = setTimeout(() => {
      body.classList.remove('chrome-visible');
      chromeTimer = null;
    }, 4000);
  }
}

// --- Event Binding ---
function bindEvents(): void {
  // Toolbar buttons
  $('btn-settings').onclick = () => settingsPanel.classList.toggle('hidden');
  $('close-settings').onclick = () => settingsPanel.classList.add('hidden');
  $('btn-fullscreen').onclick = () => toggleFullscreen();
  $('btn-chapters').onclick = () => chapterPanel.classList.toggle('hidden');
  $('close-chapters').onclick = () => chapterPanel.classList.add('hidden');
  $('btn-back').onclick = () => {
    tts?.stop();
    ttsBar.classList.add('hidden');
    exitReadingMode();
    bookSelector.classList.remove('hidden');
    currentBook = null;
    readerEl.textContent = '';
  };

  // Navigation
  $('nav-prev').onclick = prevPage;
  $('nav-next').onclick = nextPage;
  pageSlider.oninput = () => scrollToPage(parseInt(pageSlider.value, 10));

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (!currentBook) return;
    switch (e.key) {
      case 'ArrowLeft': case 'PageDown': nextPage(); break;
      case 'ArrowRight': case 'PageUp': prevPage(); break;
      case 'Home': readerEl.scrollLeft = 0; break;
      case 'End': readerEl.scrollLeft = -(readerEl.scrollWidth); break;
    }
  });

  // Touch swipe & center-tap – pan-y CSS allows vertical scroll (hides address bar)
  let touchStartX = 0;
  let touchStartY = 0;
  readerEl.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  });
  readerEl.addEventListener('touchend', (e) => {
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const dx = endX - touchStartX;
    const dy = endY - touchStartY;

    if (Math.abs(dx) > 50) {
      // Swipe navigation
      if (dx > 0) nextPage(); else prevPage();
    } else if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Center 1/9 toggles chrome
      if (endX > w / 3 && endX < (2 * w) / 3 && endY > h / 3 && endY < (2 * h) / 3) {
        toggleChrome();
      // Bottom half: left 1/4 = next, right 1/4 = prev
      } else if (endY > h / 2) {
        if (endX < w / 4) nextPage();
        else if (endX > (3 * w) / 4) prevPage();
      }
    }
  });

  // Desktop click — center 1/9 toggles chrome, bottom corners turn pages
  readerEl.addEventListener('click', (e) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (e.clientX > w / 3 && e.clientX < (2 * w) / 3 && e.clientY > h / 3 && e.clientY < (2 * h) / 3) {
      toggleChrome();
    } else if (e.clientY > h / 2) {
      if (e.clientX < w / 4) nextPage();
      else if (e.clientX > (3 * w) / 4) prevPage();
    }
  });

  // Scroll tracking for page info
  readerEl.addEventListener('scroll', () => updatePageInfo());

  // Settings: font size
  fontSizeInput.oninput = () => {
    const size = parseInt(fontSizeInput.value, 10);
    fontSizeLabel.textContent = size + 'px';
    document.documentElement.style.setProperty('--font-size', size + 'px');
    const settings = loadSettings();
    settings.fontSize = size;
    saveSettings(settings);
  };

  // Settings: theme
  themeSelect.onchange = () => {
    document.documentElement.dataset.theme = themeSelect.value;
    const settings = loadSettings();
    settings.theme = themeSelect.value;
    saveSettings(settings);
  };

  // Settings: font
  fontSelect.onchange = () => {
    applyFont(fontSelect.value);
    const settings = loadSettings();
    settings.font = fontSelect.value;
    saveSettings(settings);
  };

  // Settings: TTS speed label
  ttsSpeedInput.oninput = () => {
    ttsSpeedLabel.textContent = ttsSpeedInput.value + 'x';
  };

  // Settings: save TTS
  $('save-tts-settings').onclick = () => {
    const settings = loadSettings();
    settings.tts = {
      endpoint: ttsEndpointInput.value,
      apiKey: ttsApiKeyInput.value,
      model: ttsModelInput.value,
      voice: ttsVoiceInput.value,
      speed: parseFloat(ttsSpeedInput.value),
    };
    saveSettings(settings);
    tts?.updateSettings(settings.tts);
    settingsPanel.classList.add('hidden');
  };

  // TTS controls
  $('btn-tts').onclick = () => ttsBar.classList.toggle('hidden');
  ttsPlayBtn.onclick = () => {
    if (!tts) return;
    if (tts.isPlaying()) tts.pause();
    else tts.play();
  };
  $('tts-stop').onclick = () => tts?.stop();
  $('tts-next').onclick = () => tts?.next();
  $('tts-prev').onclick = () => tts?.prev();
}

// --- Init ---
async function init(): Promise<void> {
  // Show version
  $('version').textContent = `v${__APP_VERSION__} (${__BUILD_HASH__})`;

  // Load CDN scripts
  await loadScript('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');
  await loadScript('https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js');

  // Init SC → TC converter
  converter = OpenCC.Converter({ from: 'cn', to: 'twp' });

  // Apply saved settings
  const settings = loadSettings();
  applySettings(settings);

  // Load custom fonts
  const fonts = await loadFontList();
  if (fonts.length > 0) {
    await registerFonts(fonts);
    for (const f of fonts) {
      const opt = document.createElement('option');
      opt.value = f.name;
      opt.textContent = f.name;
      fontSelect.appendChild(opt);
    }
    fontSelect.value = settings.font;
    applyFont(settings.font);
  }

  // Bind events
  bindEvents();

  // Load book list
  await loadBookList();

  // If URL hash specifies a book, open it directly
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const bookFile = params.get('book');
    if (bookFile) {
      const book = books.find(b => b.file === bookFile);
      if (book) {
        openBook(book);
        return;
      }
    }
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) { resolve(); return; }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

init();
