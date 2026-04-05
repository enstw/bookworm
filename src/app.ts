import type { Book } from './types';
import { loadFontList, registerFonts, applyFont } from './fonts';
import { AITextToSpeech, splitSentences } from './tts';
import { state, getChapterText } from './state';
import { getSettings, updateSetting, applySettings } from './settings';
import { showLoading, hideLoading, enterReadingMode, exitReadingMode, toggleFullscreen } from './ui';
import { renderChapter, updatePageInfo, markChapterListDirty, ensureChapterListPopulated, bindNavigationEvents, relayout } from './navigation';
import { getSavedPosition } from './position';

// fflate loaded from CDN
declare const fflate: {
  unzipSync: (data: Uint8Array) => Record<string, Uint8Array>;
};
declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

const $ = (id: string) => document.getElementById(id)!;
const bookSelector = $('book-selector');
const bookListEl = $('book-list');
const settingsPanel = $('settings-panel');
const chapterPanel = $('chapter-panel');
const readerEl = $('reader') as HTMLDivElement;
const bookTitleEl = $('book-title');
const fontSelect = $('font-select') as HTMLSelectElement;
const ttsBar = $('tts-bar');
const ttsPlayBtn = $('tts-play');
const ttsStatusEl = $('tts-status');

// --- Book List ---

async function loadBookList(): Promise<void> {
  try {
    const res = await fetch('books/index.json');
    state.books = await res.json();
  } catch {
    state.books = [];
  }

  bookListEl.innerHTML = '';
  if (state.books.length === 0) {
    bookListEl.innerHTML = '<p style="opacity:0.5">找不到書籍。請在 books/ 資料夾中新增 .zip 檔案並更新 index.json。</p>';
    return;
  }

  for (const book of state.books) {
    const div = document.createElement('div');
    div.className = 'book-item';
    div.textContent = book.name;
    div.onclick = () => openBook(book);
    bookListEl.appendChild(div);
  }
}

// --- Open Book ---

async function openBook(book: Book): Promise<void> {
  showLoading('正在載入書籍…');
  state.currentBook = book;

  try {
    showLoading('正在下載…');
    const res = await fetch(`books/${book.file}`);
    const buf = new Uint8Array(await res.arrayBuffer());

    showLoading('正在解壓縮…');
    state.zipEntries = fflate.unzipSync(buf);

    const filenames = Object.keys(state.zipEntries)
      .filter(k => k.endsWith('.txt'))
      .sort();
    state.chapters = filenames.map(f => {
      const base = f.replace(/\.txt$/i, '');
      const title = base.replace(/^\d+_/, '');
      return { title, filename: f };
    });

    if (state.chapters.length === 0) throw new Error('ZIP 中找不到章節檔案');

    markChapterListDirty();
    bookSelector.classList.add('hidden');
    bookTitleEl.textContent = book.name;
    enterReadingMode();

    const saved = getSavedPosition();
    if (saved) {
      renderChapter(saved.chapter);
      readerEl.scrollLeft = saved.scrollLeft;
      updatePageInfo();
    } else {
      renderChapter(0);
    }

    const settings = getSettings();
    state.tts = new AITextToSpeech(settings.tts, handleTTSState);
    state.tts.setSentences(splitSentences(getChapterText(state.currentChapterIndex)));

    hideLoading();
  } catch (e: any) {
    hideLoading();
    alert(`載入失敗: ${e.message}`);
    console.error(e);
  }
}

// --- TTS State ---

function handleTTSState(ttsState: string, info?: string): void {
  switch (ttsState) {
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

// --- Event Binding ---

function bindEvents(): void {
  bindNavigationEvents();

  // Toolbar
  $('btn-settings').onclick = () => settingsPanel.classList.toggle('hidden');
  $('close-settings').onclick = () => settingsPanel.classList.add('hidden');
  $('btn-fullscreen').onclick = toggleFullscreen;
  $('btn-chapters').onclick = () => {
    ensureChapterListPopulated();
    chapterPanel.classList.toggle('hidden');
  };
  $('close-chapters').onclick = () => chapterPanel.classList.add('hidden');
  $('btn-back').onclick = () => {
    state.tts?.stop();
    ttsBar.classList.add('hidden');
    exitReadingMode();
    bookSelector.classList.remove('hidden');
    state.currentBook = null;
    readerEl.textContent = '';
  };

  // Settings: font size
  const fontSizeInput = $('font-size') as HTMLInputElement;
  const fontSizeLabel = $('font-size-label');
  fontSizeInput.oninput = () => {
    const size = parseInt(fontSizeInput.value, 10);
    fontSizeLabel.textContent = size + 'px';
    document.documentElement.style.setProperty('--font-size', size + 'px');
    updateSetting('fontSize', size);
    relayout();
  };

  // Settings: theme
  const themeSelect = $('theme-select') as HTMLSelectElement;
  themeSelect.onchange = () => {
    document.documentElement.dataset.theme = themeSelect.value;
    updateSetting('theme', themeSelect.value);
  };

  // Settings: font
  fontSelect.onchange = () => {
    applyFont(fontSelect.value);
    updateSetting('font', fontSelect.value);
  };

  // Settings: TTS speed label
  const ttsSpeedInput = $('tts-speed') as HTMLInputElement;
  const ttsSpeedLabel = $('tts-speed-label');
  ttsSpeedInput.oninput = () => {
    ttsSpeedLabel.textContent = ttsSpeedInput.value + 'x';
  };

  // Settings: save TTS
  $('save-tts-settings').onclick = () => {
    const ttsSettings = {
      endpoint: ($('tts-endpoint') as HTMLInputElement).value,
      apiKey: ($('tts-api-key') as HTMLInputElement).value,
      model: ($('tts-model') as HTMLInputElement).value,
      voice: ($('tts-voice') as HTMLInputElement).value,
      speed: parseFloat(ttsSpeedInput.value),
    };
    updateSetting('tts', ttsSettings);
    state.tts?.updateSettings(ttsSettings);
    settingsPanel.classList.add('hidden');
  };

  // TTS controls
  $('btn-tts').onclick = () => ttsBar.classList.toggle('hidden');
  ttsPlayBtn.onclick = () => {
    if (!state.tts) return;
    if (state.tts.isPlaying()) state.tts.pause();
    else state.tts.play();
  };
  $('tts-stop').onclick = () => state.tts?.stop();
  $('tts-next').onclick = () => state.tts?.next();
  $('tts-prev').onclick = () => state.tts?.prev();
}

// --- Init ---

async function init(): Promise<void> {
  const versionEl = $('version');
  versionEl.textContent = `v${__APP_VERSION__} (${__BUILD_HASH__})`;
  versionEl.style.cursor = 'pointer';
  versionEl.addEventListener('click', () => location.reload());

  await loadScript('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

  applySettings();
  bindEvents();
  await loadBookList();

  // Load custom fonts in background
  const settings = getSettings();
  loadFontList().then(async (fonts) => {
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
  });

  // If URL hash specifies a book, open it directly
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const bookFile = params.get('book');
    if (bookFile) {
      const book = state.books.find(b => b.file === bookFile);
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
