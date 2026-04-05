// src/fonts.ts
var SUPPORTED_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];
async function loadFontList() {
  try {
    const res = await fetch("fonts/index.json");
    if (!res.ok) return [];
    const list = await res.json();
    return list.filter((f) => SUPPORTED_EXTENSIONS.some((ext) => f.file.endsWith(ext)));
  } catch {
    return [];
  }
}
async function registerFonts(fonts) {
  for (const font of fonts) {
    const format = font.file.endsWith(".woff2") ? "woff2" : font.file.endsWith(".woff") ? "woff" : font.file.endsWith(".otf") ? "opentype" : "truetype";
    const face = new FontFace("BookwormCustom", `url(fonts/${font.file})`, {
      style: "normal",
      weight: "400",
      display: "swap"
    });
    const namedFace = new FontFace(font.name, `url(fonts/${font.file})`, {
      style: "normal",
      weight: "400",
      display: "swap"
    });
    try {
      const [loaded, namedLoaded] = await Promise.all([face.load(), namedFace.load()]);
      document.fonts.add(loaded);
      document.fonts.add(namedLoaded);
    } catch (e) {
      console.warn(`Failed to load font ${font.name}:`, e);
    }
  }
}
function applyFont(fontName) {
  const reader = document.getElementById("reader");
  if (!reader) return;
  if (fontName === "default") {
    reader.style.fontFamily = "";
  } else {
    reader.style.fontFamily = `'${fontName}', 'BookwormCustom', serif`;
  }
}

// src/tts.ts
var AITextToSpeech = class {
  constructor(settings, onStateChange) {
    this.audio = null;
    this.sentences = [];
    this.currentIndex = 0;
    this.playing = false;
    this.abortController = null;
    this.settings = settings;
    this.onStateChange = onStateChange;
  }
  updateSettings(settings) {
    this.settings = settings;
  }
  setSentences(sentences) {
    this.sentences = sentences;
    this.currentIndex = 0;
  }
  getCurrentIndex() {
    return this.currentIndex;
  }
  setCurrentIndex(index) {
    this.currentIndex = Math.max(0, Math.min(index, this.sentences.length - 1));
  }
  getCurrentSentence() {
    return this.sentences[this.currentIndex] ?? "";
  }
  async play() {
    if (!this.settings.endpoint || !this.settings.apiKey) {
      this.onStateChange("error", "\u8ACB\u5148\u5728\u8A2D\u5B9A\u4E2D\u586B\u5165 TTS API \u7AEF\u9EDE\u548C API Key");
      return;
    }
    if (this.currentIndex >= this.sentences.length) {
      this.onStateChange("stopped");
      return;
    }
    this.playing = true;
    await this.speakCurrent();
  }
  pause() {
    this.playing = false;
    if (this.audio) {
      this.audio.pause();
    }
    this.abortController?.abort();
    this.onStateChange("paused");
  }
  stop() {
    this.playing = false;
    this.currentIndex = 0;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    this.abortController?.abort();
    this.onStateChange("stopped");
  }
  next() {
    if (this.currentIndex < this.sentences.length - 1) {
      this.currentIndex++;
      if (this.playing) {
        if (this.audio) {
          this.audio.pause();
          this.audio.src = "";
        }
        this.abortController?.abort();
        this.speakCurrent();
      }
    }
  }
  prev() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      if (this.playing) {
        if (this.audio) {
          this.audio.pause();
          this.audio.src = "";
        }
        this.abortController?.abort();
        this.speakCurrent();
      }
    }
  }
  isPlaying() {
    return this.playing;
  }
  async speakCurrent() {
    const text = this.sentences[this.currentIndex];
    if (!text) {
      this.playing = false;
      this.onStateChange("stopped");
      return;
    }
    this.onStateChange("playing", text);
    try {
      this.abortController = new AbortController();
      const res = await fetch(this.settings.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.settings.apiKey}`
        },
        body: JSON.stringify({
          model: this.settings.model || "tts-1",
          input: text,
          voice: this.settings.voice || "alloy",
          speed: this.settings.speed || 1
        }),
        signal: this.abortController.signal
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`TTS API error ${res.status}: ${err}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      this.audio = new Audio(url);
      this.audio.playbackRate = 1;
      await new Promise((resolve, reject) => {
        if (!this.audio) return reject(new Error("No audio"));
        this.audio.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        this.audio.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("Audio playback error"));
        };
        this.audio.play().catch(reject);
      });
      if (this.playing) {
        this.currentIndex++;
        if (this.currentIndex < this.sentences.length) {
          await this.speakCurrent();
        } else {
          this.playing = false;
          this.onStateChange("stopped");
        }
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      console.error("TTS error:", e);
      this.playing = false;
      this.onStateChange("error", e.message);
    }
  }
};
function splitSentences(text) {
  const raw = text.split(/(?<=[。！？\n])/);
  return raw.map((s) => s.trim()).filter((s) => s.length > 0 && s.length < 500);
}

// src/state.ts
var state = {
  books: [],
  currentBook: null,
  zipEntries: {},
  chapters: [],
  currentChapterIndex: 0,
  tts: null
};
var decoder = new TextDecoder("utf-8");
function getChapterText(index) {
  const raw = state.zipEntries[state.chapters[index].filename];
  return decoder.decode(raw);
}

// src/settings.ts
var $ = (id) => document.getElementById(id);
var DEFAULTS = {
  fontSize: 26,
  theme: "sepia",
  font: "default",
  preloadChapters: 2,
  tts: { endpoint: "", apiKey: "", model: "tts-1", voice: "alloy", speed: 1 }
};
var current = null;
function getSettings() {
  if (current) return current;
  const raw = localStorage.getItem("bookworm_settings");
  if (!raw) {
    current = { ...DEFAULTS, tts: { ...DEFAULTS.tts } };
    return current;
  }
  try {
    current = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    current = { ...DEFAULTS, tts: { ...DEFAULTS.tts } };
  }
  return current;
}
function save() {
  localStorage.setItem("bookworm_settings", JSON.stringify(current));
}
function updateSetting(key, value) {
  getSettings()[key] = value;
  save();
}
function applySettings() {
  const s = getSettings();
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.style.setProperty("--font-size", s.fontSize + "px");
  $("theme-select").value = s.theme;
  $("font-size").value = String(s.fontSize);
  $("font-size-label").textContent = s.fontSize + "px";
  $("font-select").value = s.font;
  applyFont(s.font);
  $("preload-chapters").value = String(s.preloadChapters);
  $("preload-chapters-label").textContent = String(s.preloadChapters);
  $("tts-endpoint").value = s.tts.endpoint;
  $("tts-api-key").value = s.tts.apiKey;
  $("tts-model").value = s.tts.model;
  $("tts-voice").value = s.tts.voice;
  $("tts-speed").value = String(s.tts.speed);
  $("tts-speed-label").textContent = s.tts.speed + "x";
}

// src/ui.ts
var loadingOverlay = document.getElementById("loading");
var loadingText = document.getElementById("loading-text");
var chromeTimer = null;
function showLoading(msg) {
  loadingText.textContent = msg;
  loadingOverlay.classList.remove("hidden");
}
function hideLoading() {
  loadingOverlay.classList.add("hidden");
}
function enterReadingMode() {
  document.body.classList.add("reading-mode");
}
function exitReadingMode() {
  document.body.classList.remove("reading-mode", "chrome-visible");
  if (chromeTimer) {
    clearTimeout(chromeTimer);
    chromeTimer = null;
  }
  exitFullscreen();
}
function requestFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) {
    el.requestFullscreen().catch(() => {
    });
  }
}
function exitFullscreen() {
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {
    });
  }
}
function toggleFullscreen() {
  if (document.fullscreenElement) exitFullscreen();
  else requestFullscreen();
}
function toggleChrome() {
  const body = document.body;
  if (body.classList.contains("chrome-visible")) {
    body.classList.remove("chrome-visible");
    if (chromeTimer) {
      clearTimeout(chromeTimer);
      chromeTimer = null;
    }
  } else {
    body.classList.add("chrome-visible");
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = setTimeout(() => {
      body.classList.remove("chrome-visible");
      chromeTimer = null;
    }, 4e3);
  }
}

// src/position.ts
function savePosition(chapter, page) {
  if (!state.currentBook) return;
  const params = new URLSearchParams();
  params.set("book", state.currentBook.file);
  params.set("ch", String(chapter));
  params.set("p", String(page));
  history.replaceState(null, "", "#" + params.toString());
  localStorage.setItem("bookworm_position", JSON.stringify({
    book: state.currentBook.file,
    chapter,
    page
  }));
}
function getSavedPosition() {
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const bookFile = params.get("book");
    const ch = params.get("ch");
    const p = params.get("p");
    if (bookFile === state.currentBook?.file && ch != null) {
      return {
        chapter: parseInt(ch, 10),
        page: p != null ? parseInt(p, 10) : 0
      };
    }
  }
  try {
    const raw = localStorage.getItem("bookworm_position");
    if (raw) {
      const pos = JSON.parse(raw);
      if (pos.book === state.currentBook?.file) {
        return {
          chapter: pos.chapter ?? 0,
          page: pos.page ?? 0
        };
      }
    }
  } catch {
  }
  return null;
}

// src/navigation.ts
var $2 = (id) => document.getElementById(id);
var readerEl = $2("reader");
var pageInfoEl = $2("page-info");
var pageSlider = $2("page-slider");
var chapterListEl = $2("chapter-list");
var chapterPanel = $2("chapter-panel");
var pageW = 0;
var lineH = 0;
function fitPageToLines() {
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
function mountChapter(i) {
  const ch = state.chapters[i];
  if (ch.el) return;
  const div = document.createElement("div");
  div.className = "chapter";
  div.textContent = getChapterText(i);
  let nextSibling = null;
  for (let j = i + 1; j < state.chapters.length; j++) {
    if (state.chapters[j].el) {
      nextSibling = state.chapters[j].el;
      break;
    }
  }
  readerEl.insertBefore(div, nextSibling);
  const natural = div.offsetWidth;
  const snapped = Math.max(pageW, Math.ceil(natural / pageW) * pageW);
  div.style.width = `${snapped}px`;
  ch.el = div;
}
function unmountChapter(i) {
  const ch = state.chapters[i];
  if (!ch.el) return;
  ch.el.remove();
  ch.el = null;
}
function windowRadius() {
  return Math.max(1, getSettings().preloadChapters);
}
function refreshWindow(currentCh) {
  const r = windowRadius();
  const lo = Math.max(0, currentCh - r);
  const hi = Math.min(state.chapters.length - 1, currentCh + r);
  const curEl = state.chapters[currentCh].el;
  const scrollLeftBefore = readerEl.scrollLeft;
  const beforeOffsetLeft = curEl ? curEl.offsetLeft : 0;
  for (let i = 0; i < state.chapters.length; i++) {
    if ((i < lo || i > hi) && state.chapters[i].el) {
      unmountChapter(i);
    }
  }
  for (let i = lo; i <= hi; i++) {
    if (!state.chapters[i].el) {
      mountChapter(i);
    }
  }
  const afterEl = state.chapters[currentCh].el;
  const delta = afterEl.offsetLeft - beforeOffsetLeft;
  if (delta !== 0) {
    readerEl.scrollLeft = scrollLeftBefore - delta;
  }
}
function onChapterChanged(i) {
  highlightActiveChapter(i);
  if (state.tts) state.tts.setSentences(splitSentences(getChapterText(i)));
}
function openBookLayout(chapterIdx, pageInCh) {
  readerEl.innerHTML = "";
  for (const ch of state.chapters) ch.el = null;
  fitPageToLines();
  state.currentChapterIndex = chapterIdx;
  const r = windowRadius();
  const lo = Math.max(0, chapterIdx - r);
  const hi = Math.min(state.chapters.length - 1, chapterIdx + r);
  for (let j = lo; j <= hi; j++) mountChapter(j);
  const el = state.chapters[chapterIdx].el;
  readerEl.scrollLeft = -(el.offsetLeft + pageInCh * pageW);
  onChapterChanged(chapterIdx);
  updatePageInfo();
}
function goToChapter(i) {
  if (i < 0 || i >= state.chapters.length) return;
  openBookLayout(i, 0);
  chapterPanel.classList.add("hidden");
}
function relayout() {
  const curIdx = state.currentChapterIndex;
  const curEl = state.chapters[curIdx]?.el;
  const oldPageW = pageW || 1;
  const page = curEl ? Math.round((Math.abs(readerEl.scrollLeft) - curEl.offsetLeft) / oldPageW) : 0;
  fitPageToLines();
  for (const ch of state.chapters) {
    if (!ch.el) continue;
    ch.el.style.width = "auto";
    const natural = ch.el.offsetWidth;
    ch.el.style.width = `${Math.max(pageW, Math.ceil(natural / pageW) * pageW)}px`;
  }
  const newCurEl = state.chapters[curIdx]?.el;
  if (newCurEl) {
    readerEl.scrollLeft = -(newCurEl.offsetLeft + page * pageW);
  }
  refreshWindow(curIdx);
  updatePageInfo();
}
var lastSavedChapter = -1;
var lastSavedPage = -1;
function updatePageInfo() {
  const ch = state.chapters[state.currentChapterIndex];
  if (!ch || !ch.el || pageW <= 0) {
    pageInfoEl.textContent = "";
    pageSlider.value = "0";
    pageSlider.max = "0";
    return;
  }
  const total = state.chapters.length;
  const chPages = Math.max(1, Math.round(ch.el.offsetWidth / pageW));
  const rawPage = Math.round((Math.abs(readerEl.scrollLeft) - ch.el.offsetLeft) / pageW);
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
function nextPage() {
  if (pageW > 0) readerEl.scrollBy({ left: -pageW, behavior: "smooth" });
}
function prevPage() {
  if (pageW > 0) readerEl.scrollBy({ left: pageW, behavior: "smooth" });
}
function findChapterAtScroll() {
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
var chapterListDirty = true;
function markChapterListDirty() {
  chapterListDirty = true;
  chapterListEl.innerHTML = "";
}
function ensureChapterListPopulated() {
  if (!chapterListDirty) return;
  chapterListDirty = false;
  chapterListEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.chapters.forEach((ch, i) => {
    const li = document.createElement("li");
    li.textContent = ch.title;
    li.onclick = () => goToChapter(i);
    frag.appendChild(li);
  });
  chapterListEl.appendChild(frag);
  highlightActiveChapter(state.currentChapterIndex);
}
function highlightActiveChapter(index) {
  const items = chapterListEl.querySelectorAll("li");
  items.forEach((li, i) => li.classList.toggle("active", i === index));
}
var lastTouchEnd = 0;
function bindNavigationEvents() {
  pageSlider.oninput = () => {
    const p = parseInt(pageSlider.value, 10);
    const ch = state.chapters[state.currentChapterIndex];
    if (!ch || !ch.el) return;
    readerEl.scrollLeft = -(ch.el.offsetLeft + p * pageW);
  };
  $2("nav-prev").onclick = prevPage;
  $2("nav-next").onclick = nextPage;
  readerEl.addEventListener("scroll", () => {
    if (!state.currentBook) return;
    const ch = findChapterAtScroll();
    if (ch !== state.currentChapterIndex) {
      state.currentChapterIndex = ch;
      refreshWindow(ch);
      onChapterChanged(ch);
    }
    updatePageInfo();
  });
  const container = readerEl.parentElement;
  if (container && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      if (state.currentBook) relayout();
    });
    ro.observe(container);
  }
  document.addEventListener("keydown", (e) => {
    if (!state.currentBook) return;
    switch (e.key) {
      case "ArrowLeft":
      case "PageDown":
        nextPage();
        break;
      case "ArrowRight":
      case "PageUp":
        prevPage();
        break;
    }
  });
  let touchStartX = 0;
  let touchStartY = 0;
  readerEl.addEventListener("touchstart", (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  });
  readerEl.addEventListener("touchend", (e) => {
    lastTouchEnd = Date.now();
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const dx = endX - touchStartX;
    const dy = endY - touchStartY;
    if (Math.abs(dx) > 50) {
      if (dx > 0) nextPage();
      else prevPage();
    } else if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
      handleTapZone(endX, endY);
    }
  });
  readerEl.addEventListener("click", (e) => {
    if (Date.now() - lastTouchEnd < 300) return;
    handleTapZone(e.clientX, e.clientY);
  });
}
function handleTapZone(x, y) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (x > w / 3 && x < 2 * w / 3 && y > h / 3 && y < 2 * h / 3) {
    toggleChrome();
  } else if (y > h / 2) {
    if (x < w / 4) nextPage();
    else if (x > 3 * w / 4) prevPage();
  }
}
function resetReader() {
  readerEl.innerHTML = "";
  for (const ch of state.chapters) ch.el = null;
  lastSavedChapter = -1;
  lastSavedPage = -1;
}

// src/app.ts
var $3 = (id) => document.getElementById(id);
var bookSelector = $3("book-selector");
var bookListEl = $3("book-list");
var settingsPanel = $3("settings-panel");
var chapterPanel2 = $3("chapter-panel");
var bookTitleEl = $3("book-title");
var fontSelect = $3("font-select");
var ttsBar = $3("tts-bar");
var ttsPlayBtn = $3("tts-play");
var ttsStatusEl = $3("tts-status");
async function loadBookList() {
  try {
    const res = await fetch("books/index.json");
    state.books = await res.json();
  } catch {
    state.books = [];
  }
  bookListEl.innerHTML = "";
  if (state.books.length === 0) {
    bookListEl.innerHTML = '<p style="opacity:0.5">\u627E\u4E0D\u5230\u66F8\u7C4D\u3002\u8ACB\u5728 books/ \u8CC7\u6599\u593E\u4E2D\u65B0\u589E .zip \u6A94\u6848\u4E26\u66F4\u65B0 index.json\u3002</p>';
    return;
  }
  for (const book of state.books) {
    const div = document.createElement("div");
    div.className = "book-item";
    div.textContent = book.name;
    div.onclick = () => openBook(book);
    bookListEl.appendChild(div);
  }
}
async function openBook(book) {
  showLoading("\u6B63\u5728\u8F09\u5165\u66F8\u7C4D\u2026");
  state.currentBook = book;
  try {
    showLoading("\u6B63\u5728\u4E0B\u8F09\u2026");
    const res = await fetch(`books/${book.file}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    showLoading("\u6B63\u5728\u89E3\u58D3\u7E2E\u2026");
    state.zipEntries = fflate.unzipSync(buf);
    const filenames = Object.keys(state.zipEntries).filter((k) => k.endsWith(".txt")).sort();
    state.chapters = filenames.map((f) => {
      const base = f.replace(/\.txt$/i, "");
      const title = base.replace(/^\d+_/, "");
      return { title, filename: f, el: null };
    });
    if (state.chapters.length === 0) throw new Error("ZIP \u4E2D\u627E\u4E0D\u5230\u7AE0\u7BC0\u6A94\u6848");
    markChapterListDirty();
    bookSelector.classList.add("hidden");
    bookTitleEl.textContent = book.name;
    enterReadingMode();
    const saved = getSavedPosition();
    openBookLayout(saved?.chapter ?? 0, saved?.page ?? 0);
    const settings = getSettings();
    state.tts = new AITextToSpeech(settings.tts, handleTTSState);
    state.tts.setSentences(splitSentences(getChapterText(state.currentChapterIndex)));
    hideLoading();
  } catch (e) {
    hideLoading();
    alert(`\u8F09\u5165\u5931\u6557: ${e.message}`);
    console.error(e);
  }
}
function handleTTSState(ttsState, info) {
  switch (ttsState) {
    case "playing":
      ttsPlayBtn.textContent = "\u23F8";
      ttsStatusEl.textContent = info ?? "\u64AD\u653E\u4E2D\u2026";
      break;
    case "paused":
      ttsPlayBtn.textContent = "\u25B6";
      ttsStatusEl.textContent = "\u5DF2\u66AB\u505C";
      break;
    case "stopped":
      ttsPlayBtn.textContent = "\u25B6";
      ttsStatusEl.textContent = "";
      break;
    case "error":
      ttsPlayBtn.textContent = "\u25B6";
      ttsStatusEl.textContent = `\u932F\u8AA4: ${info}`;
      break;
  }
}
function bindEvents() {
  bindNavigationEvents();
  $3("btn-settings").onclick = () => settingsPanel.classList.toggle("hidden");
  $3("close-settings").onclick = () => settingsPanel.classList.add("hidden");
  $3("btn-fullscreen").onclick = toggleFullscreen;
  $3("btn-chapters").onclick = () => {
    ensureChapterListPopulated();
    chapterPanel2.classList.toggle("hidden");
  };
  $3("close-chapters").onclick = () => chapterPanel2.classList.add("hidden");
  $3("btn-back").onclick = () => {
    state.tts?.stop();
    ttsBar.classList.add("hidden");
    exitReadingMode();
    bookSelector.classList.remove("hidden");
    state.currentBook = null;
    resetReader();
  };
  const fontSizeInput = $3("font-size");
  const fontSizeLabel = $3("font-size-label");
  fontSizeInput.oninput = () => {
    const size = parseInt(fontSizeInput.value, 10);
    fontSizeLabel.textContent = size + "px";
    document.documentElement.style.setProperty("--font-size", size + "px");
    updateSetting("fontSize", size);
    relayout();
  };
  const preloadInput = $3("preload-chapters");
  const preloadLabel = $3("preload-chapters-label");
  preloadInput.oninput = () => {
    const n = parseInt(preloadInput.value, 10);
    preloadLabel.textContent = String(n);
    updateSetting("preloadChapters", n);
    relayout();
  };
  const themeSelect = $3("theme-select");
  themeSelect.onchange = () => {
    document.documentElement.dataset.theme = themeSelect.value;
    updateSetting("theme", themeSelect.value);
  };
  fontSelect.onchange = () => {
    applyFont(fontSelect.value);
    updateSetting("font", fontSelect.value);
  };
  const ttsSpeedInput = $3("tts-speed");
  const ttsSpeedLabel = $3("tts-speed-label");
  ttsSpeedInput.oninput = () => {
    ttsSpeedLabel.textContent = ttsSpeedInput.value + "x";
  };
  $3("save-tts-settings").onclick = () => {
    const ttsSettings = {
      endpoint: $3("tts-endpoint").value,
      apiKey: $3("tts-api-key").value,
      model: $3("tts-model").value,
      voice: $3("tts-voice").value,
      speed: parseFloat(ttsSpeedInput.value)
    };
    updateSetting("tts", ttsSettings);
    state.tts?.updateSettings(ttsSettings);
    settingsPanel.classList.add("hidden");
  };
  $3("btn-tts").onclick = () => ttsBar.classList.toggle("hidden");
  ttsPlayBtn.onclick = () => {
    if (!state.tts) return;
    if (state.tts.isPlaying()) state.tts.pause();
    else state.tts.play();
  };
  $3("tts-stop").onclick = () => state.tts?.stop();
  $3("tts-next").onclick = () => state.tts?.next();
  $3("tts-prev").onclick = () => state.tts?.prev();
}
async function init() {
  const versionEl = $3("version");
  versionEl.textContent = `v${"1.2.8"} (${"a28275b"})`;
  versionEl.style.cursor = "pointer";
  versionEl.addEventListener("click", async () => {
    versionEl.textContent = "\u66F4\u65B0\u4E2D\u2026";
    try {
      await Promise.all([
        fetch("index.html", { cache: "reload" }),
        fetch("app.js", { cache: "reload" }),
        fetch("style.css", { cache: "reload" })
      ]);
    } catch {
    }
    location.reload();
  });
  await loadScript("https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js");
  applySettings();
  bindEvents();
  await loadBookList();
  const settings = getSettings();
  loadFontList().then(async (fonts) => {
    if (fonts.length > 0) {
      await registerFonts(fonts);
      for (const f of fonts) {
        const opt = document.createElement("option");
        opt.value = f.name;
        opt.textContent = f.name;
        fontSelect.appendChild(opt);
      }
      fontSelect.value = settings.font;
      applyFont(settings.font);
    }
  });
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const bookFile = params.get("book");
    if (bookFile) {
      const book = state.books.find((b) => b.file === bookFile);
      if (book) {
        openBook(book);
        return;
      }
    }
  }
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
}
init();
