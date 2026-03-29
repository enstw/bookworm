// src/chapters.ts
var CHAPTER_PATTERNS = [
  // 第一章, 第1章, 第一百二十三章, etc.
  /^[　\s]*第[零一二三四五六七八九十百千萬万〇○０-９0-9]+[章節回卷集部篇]/,
  // 楔子, 序章, 序言, 引子, 前言 — must be standalone or followed by space/colon/title
  /^[　\s]*(楔子|序章|序言|引子|前言|引言|開篇)([　\s：:].+)?$/,
  // 尾聲, 後記, 終章, 番外 — must be standalone or followed by space/colon/title
  /^[　\s]*(尾聲|後記|終章|番外|後話|結語|完本感言|完結感言)([　\s：:].+)?$/,
  // Chapter patterns with colon/space: 第X章 XXXX or 第X章：XXXX
  /^[　\s]*第[零一二三四五六七八九十百千萬万〇○０-９0-9]+[章節回卷集部篇][　\s：:]/
];
var MIN_CHAPTER_DISTANCE = 500;
function detectChapters(text) {
  const chapters2 = [];
  const lines = text.split("\n");
  let charIndex = 0;
  let lastChapterIndex = -MIN_CHAPTER_DISTANCE;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length <= 50) {
      for (const pattern of CHAPTER_PATTERNS) {
        if (pattern.test(trimmed) && charIndex - lastChapterIndex >= MIN_CHAPTER_DISTANCE) {
          chapters2.push({
            title: trimmed,
            startIndex: charIndex
          });
          lastChapterIndex = charIndex;
          break;
        }
      }
    }
    charIndex += line.length + 1;
  }
  if (chapters2.length === 0) {
    chapters2.push({ title: "\u5168\u6587", startIndex: 0 });
  }
  return chapters2;
}

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

// src/app.ts
var $ = (id) => document.getElementById(id);
var bookSelector = $("book-selector");
var bookListEl = $("book-list");
var settingsPanel = $("settings-panel");
var chapterPanel = $("chapter-panel");
var readerEl = $("reader");
var loadingOverlay = $("loading");
var loadingText = $("loading-text");
var bookTitleEl = $("book-title");
var pageInfoEl = $("page-info");
var chapterListEl = $("chapter-list");
var pageSlider = $("page-slider");
var fontSelect = $("font-select");
var fontSizeInput = $("font-size");
var fontSizeLabel = $("font-size-label");
var themeSelect = $("theme-select");
var ttsEndpointInput = $("tts-endpoint");
var ttsApiKeyInput = $("tts-api-key");
var ttsModelInput = $("tts-model");
var ttsVoiceInput = $("tts-voice");
var ttsSpeedInput = $("tts-speed");
var ttsSpeedLabel = $("tts-speed-label");
var ttsBar = $("tts-bar");
var ttsPlayBtn = $("tts-play");
var ttsStatusEl = $("tts-status");
var books = [];
var currentBook = null;
var fullText = "";
var chapters = [];
var currentChapterIndex = 0;
var tts = null;
var chromeTimer = null;
function loadSettings() {
  const raw = localStorage.getItem("bookworm_settings");
  const defaults = {
    fontSize: 24,
    theme: "light",
    font: "default",
    tts: { endpoint: "", apiKey: "", model: "tts-1", voice: "alloy", speed: 1 }
  };
  if (!raw) return defaults;
  try {
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}
function saveSettings(settings) {
  localStorage.setItem("bookworm_settings", JSON.stringify(settings));
}
function applySettings(settings) {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty("--font-size", settings.fontSize + "px");
  themeSelect.value = settings.theme;
  fontSizeInput.value = String(settings.fontSize);
  fontSizeLabel.textContent = settings.fontSize + "px";
  fontSelect.value = settings.font;
  applyFont(settings.font);
  ttsEndpointInput.value = settings.tts.endpoint;
  ttsApiKeyInput.value = settings.tts.apiKey;
  ttsModelInput.value = settings.tts.model;
  ttsVoiceInput.value = settings.tts.voice;
  ttsSpeedInput.value = String(settings.tts.speed);
  ttsSpeedLabel.textContent = settings.tts.speed + "x";
}
function showLoading(msg) {
  loadingText.textContent = msg;
  loadingOverlay.classList.remove("hidden");
}
function hideLoading() {
  loadingOverlay.classList.add("hidden");
}
async function loadBookList() {
  try {
    const res = await fetch("books/index.json");
    books = await res.json();
  } catch {
    books = [];
  }
  bookListEl.innerHTML = "";
  if (books.length === 0) {
    bookListEl.innerHTML = '<p style="opacity:0.5">\u627E\u4E0D\u5230\u66F8\u7C4D\u3002\u8ACB\u5728 books/ \u8CC7\u6599\u593E\u4E2D\u65B0\u589E .zip \u6A94\u6848\u4E26\u66F4\u65B0 index.json\u3002</p>';
    return;
  }
  for (const book of books) {
    const div = document.createElement("div");
    div.className = "book-item";
    div.textContent = book.name;
    div.onclick = () => openBook(book);
    bookListEl.appendChild(div);
  }
}
async function openBook(book) {
  showLoading("\u6B63\u5728\u8F09\u5165\u66F8\u7C4D\u2026");
  currentBook = book;
  try {
    showLoading("\u6B63\u5728\u4E0B\u8F09\u2026");
    const res = await fetch(`books/${book.file}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    showLoading("\u6B63\u5728\u89E3\u58D3\u7E2E\u2026");
    const files = fflate.unzipSync(buf);
    const txtFile = Object.keys(files).find((k) => k.endsWith(".txt"));
    if (!txtFile) throw new Error("ZIP \u4E2D\u627E\u4E0D\u5230 .txt \u6A94\u6848");
    const raw = files[txtFile];
    showLoading("\u6B63\u5728\u89E3\u78BC\u6587\u5B57\u2026");
    fullText = new TextDecoder("utf-8").decode(raw);
    showLoading("\u6B63\u5728\u5206\u6790\u7AE0\u7BC0\u2026");
    chapters = detectChapters(fullText);
    populateChapterList();
    bookSelector.classList.add("hidden");
    bookTitleEl.textContent = book.name;
    enterReadingMode();
    if (!restorePosition()) {
      renderChapter(0);
    }
    const settings = loadSettings();
    tts = new AITextToSpeech(settings.tts, handleTTSState);
    tts.setSentences(splitSentences(getChapterText(currentChapterIndex)));
    hideLoading();
  } catch (e) {
    hideLoading();
    alert(`\u8F09\u5165\u5931\u6557: ${e.message}`);
    console.error(e);
  }
}
function getChapterText(index) {
  const start = chapters[index].startIndex;
  const end = index + 1 < chapters.length ? chapters[index + 1].startIndex : fullText.length;
  return fullText.slice(start, end);
}
function renderChapter(index) {
  if (index < 0 || index >= chapters.length) return;
  currentChapterIndex = index;
  const text = getChapterText(index);
  readerEl.textContent = text;
  readerEl.scrollLeft = 0;
  updatePageInfo();
  highlightActiveChapter(index);
  if (tts) tts.setSentences(splitSentences(text));
}
function updatePageInfo() {
  const el = readerEl;
  const maxScroll = el.scrollWidth - el.clientWidth;
  if (maxScroll <= 0) {
    pageInfoEl.textContent = `${currentChapterIndex + 1}/${chapters.length}  1/1`;
    pageSlider.value = "0";
    pageSlider.max = "0";
    savePosition();
    return;
  }
  const scrollPos = Math.abs(el.scrollLeft);
  const pageWidth = el.clientWidth;
  const totalPages = Math.ceil(el.scrollWidth / pageWidth);
  const currentPage = Math.floor(scrollPos / pageWidth) + 1;
  pageInfoEl.textContent = `${currentChapterIndex + 1}/${chapters.length}  ${currentPage}/${totalPages}`;
  pageSlider.max = String(totalPages - 1);
  pageSlider.value = String(currentPage - 1);
  savePosition();
}
function scrollToPage(pageIndex) {
  const pageWidth = readerEl.clientWidth;
  readerEl.scrollLeft = -(pageIndex * pageWidth);
}
function nextPage() {
  const pageWidth = readerEl.clientWidth;
  const maxScroll = readerEl.scrollWidth - readerEl.clientWidth;
  const atEnd = Math.abs(readerEl.scrollLeft) >= maxScroll - 2;
  if (atEnd && currentChapterIndex + 1 < chapters.length) {
    renderChapter(currentChapterIndex + 1);
  } else {
    readerEl.scrollBy({ left: -pageWidth, behavior: "smooth" });
  }
}
function prevPage() {
  const pageWidth = readerEl.clientWidth;
  const atStart = Math.abs(readerEl.scrollLeft) < 2;
  if (atStart && currentChapterIndex > 0) {
    renderChapter(currentChapterIndex - 1);
    requestAnimationFrame(() => {
      readerEl.scrollLeft = -(readerEl.scrollWidth - readerEl.clientWidth);
      updatePageInfo();
    });
  } else {
    readerEl.scrollBy({ left: pageWidth, behavior: "smooth" });
  }
}
function goToChapter(index) {
  if (index < 0 || index >= chapters.length) return;
  renderChapter(index);
  chapterPanel.classList.add("hidden");
}
function populateChapterList() {
  chapterListEl.innerHTML = "";
  chapters.forEach((ch, i) => {
    const li = document.createElement("li");
    li.textContent = ch.title;
    li.onclick = () => goToChapter(i);
    chapterListEl.appendChild(li);
  });
}
function highlightActiveChapter(index) {
  const items = chapterListEl.querySelectorAll("li");
  items.forEach((li, i) => li.classList.toggle("active", i === index));
}
function savePosition() {
  if (!currentBook) return;
  const pos = {
    book: currentBook.file,
    chapter: currentChapterIndex,
    scrollLeft: readerEl.scrollLeft
  };
  const params = new URLSearchParams();
  params.set("book", currentBook.file);
  params.set("ch", String(currentChapterIndex));
  params.set("pos", String(Math.round(readerEl.scrollLeft)));
  history.replaceState(null, "", "#" + params.toString());
  localStorage.setItem("bookworm_position", JSON.stringify(pos));
}
function restorePosition() {
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const bookFile = params.get("book");
    const ch = params.get("ch");
    const pos = params.get("pos");
    if (bookFile === currentBook?.file && ch != null) {
      renderChapter(parseInt(ch, 10));
      if (pos) readerEl.scrollLeft = parseInt(pos, 10);
      updatePageInfo();
      return true;
    }
  }
  try {
    const raw = localStorage.getItem("bookworm_position");
    if (raw) {
      const pos = JSON.parse(raw);
      if (pos.book === currentBook?.file) {
        renderChapter(pos.chapter);
        readerEl.scrollLeft = pos.scrollLeft;
        updatePageInfo();
        return true;
      }
    }
  } catch {
  }
  return false;
}
function handleTTSState(state, info) {
  switch (state) {
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
  if (document.fullscreenElement) {
    exitFullscreen();
  } else {
    requestFullscreen();
  }
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
function bindEvents() {
  $("btn-settings").onclick = () => settingsPanel.classList.toggle("hidden");
  $("close-settings").onclick = () => settingsPanel.classList.add("hidden");
  $("btn-fullscreen").onclick = () => toggleFullscreen();
  $("btn-chapters").onclick = () => chapterPanel.classList.toggle("hidden");
  $("close-chapters").onclick = () => chapterPanel.classList.add("hidden");
  $("btn-back").onclick = () => {
    tts?.stop();
    ttsBar.classList.add("hidden");
    exitReadingMode();
    bookSelector.classList.remove("hidden");
    currentBook = null;
    readerEl.textContent = "";
  };
  $("nav-prev").onclick = prevPage;
  $("nav-next").onclick = nextPage;
  pageSlider.oninput = () => scrollToPage(parseInt(pageSlider.value, 10));
  document.addEventListener("keydown", (e) => {
    if (!currentBook) return;
    switch (e.key) {
      case "ArrowLeft":
      case "PageDown":
        nextPage();
        break;
      case "ArrowRight":
      case "PageUp":
        prevPage();
        break;
      case "Home":
        readerEl.scrollLeft = 0;
        break;
      case "End":
        readerEl.scrollLeft = -readerEl.scrollWidth;
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
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const dx = endX - touchStartX;
    const dy = endY - touchStartY;
    if (Math.abs(dx) > 50) {
      if (dx > 0) nextPage();
      else prevPage();
    } else if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (endX > w / 3 && endX < 2 * w / 3 && endY > h / 3 && endY < 2 * h / 3) {
        toggleChrome();
      } else if (endY > h / 2) {
        if (endX < w / 4) nextPage();
        else if (endX > 3 * w / 4) prevPage();
      }
    }
  });
  readerEl.addEventListener("click", (e) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (e.clientX > w / 3 && e.clientX < 2 * w / 3 && e.clientY > h / 3 && e.clientY < 2 * h / 3) {
      toggleChrome();
    } else if (e.clientY > h / 2) {
      if (e.clientX < w / 4) nextPage();
      else if (e.clientX > 3 * w / 4) prevPage();
    }
  });
  readerEl.addEventListener("scroll", () => updatePageInfo());
  fontSizeInput.oninput = () => {
    const size = parseInt(fontSizeInput.value, 10);
    fontSizeLabel.textContent = size + "px";
    document.documentElement.style.setProperty("--font-size", size + "px");
    const settings = loadSettings();
    settings.fontSize = size;
    saveSettings(settings);
  };
  themeSelect.onchange = () => {
    document.documentElement.dataset.theme = themeSelect.value;
    const settings = loadSettings();
    settings.theme = themeSelect.value;
    saveSettings(settings);
  };
  fontSelect.onchange = () => {
    applyFont(fontSelect.value);
    const settings = loadSettings();
    settings.font = fontSelect.value;
    saveSettings(settings);
  };
  ttsSpeedInput.oninput = () => {
    ttsSpeedLabel.textContent = ttsSpeedInput.value + "x";
  };
  $("save-tts-settings").onclick = () => {
    const settings = loadSettings();
    settings.tts = {
      endpoint: ttsEndpointInput.value,
      apiKey: ttsApiKeyInput.value,
      model: ttsModelInput.value,
      voice: ttsVoiceInput.value,
      speed: parseFloat(ttsSpeedInput.value)
    };
    saveSettings(settings);
    tts?.updateSettings(settings.tts);
    settingsPanel.classList.add("hidden");
  };
  $("btn-tts").onclick = () => ttsBar.classList.toggle("hidden");
  ttsPlayBtn.onclick = () => {
    if (!tts) return;
    if (tts.isPlaying()) tts.pause();
    else tts.play();
  };
  $("tts-stop").onclick = () => tts?.stop();
  $("tts-next").onclick = () => tts?.next();
  $("tts-prev").onclick = () => tts?.prev();
}
async function init() {
  const versionEl = $("version");
  versionEl.textContent = `v${"1.1.29"} (${"bf7b2c0"})`;
  versionEl.style.cursor = "pointer";
  versionEl.addEventListener("click", () => location.reload());
  await loadScript("https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js");
  const settings = loadSettings();
  applySettings(settings);
  const fonts = await loadFontList();
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
  bindEvents();
  await loadBookList();
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const bookFile = params.get("book");
    if (bookFile) {
      const book = books.find((b) => b.file === bookFile);
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
