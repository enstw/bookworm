const loadingOverlay = document.getElementById('loading')!;
const loadingText = document.getElementById('loading-text')!;

let chromeTimer: ReturnType<typeof setTimeout> | null = null;

export function showLoading(msg: string): void {
  loadingText.textContent = msg;
  loadingOverlay.classList.remove('hidden');
}

export function hideLoading(): void {
  loadingOverlay.classList.add('hidden');
}

export function enterReadingMode(): void {
  document.body.classList.add('reading-mode');
}

export function exitReadingMode(): void {
  document.body.classList.remove('reading-mode', 'chrome-visible');
  if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null; }
  exitFullscreen();
}

export function requestFullscreen(): void {
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) {
    el.requestFullscreen().catch(() => {});
  }
}

export function exitFullscreen(): void {
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

export function toggleFullscreen(): void {
  if (document.fullscreenElement) exitFullscreen();
  else requestFullscreen();
}

export function toggleChrome(): void {
  const body = document.body;
  if (body.classList.contains('chrome-visible')) {
    body.classList.remove('chrome-visible');
    if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null; }
  } else {
    body.classList.add('chrome-visible');
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = setTimeout(() => {
      body.classList.remove('chrome-visible');
      chromeTimer = null;
    }, 4000);
  }
}
