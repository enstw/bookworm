import type { AppSettings } from './types';
import { applyFont } from './fonts';

const $ = (id: string) => document.getElementById(id)!;

const DEFAULTS: AppSettings = {
  fontSize: 26,
  theme: 'sepia',
  font: 'default',
  tts: { endpoint: '', apiKey: '', model: 'tts-1', voice: 'alloy', speed: 1.0 },
};

let current: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (current) return current;
  const raw = localStorage.getItem('bookworm_settings');
  if (!raw) {
    current = { ...DEFAULTS, tts: { ...DEFAULTS.tts } };
    return current;
  }
  try {
    current = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    current = { ...DEFAULTS, tts: { ...DEFAULTS.tts } };
  }
  return current!;
}

function save(): void {
  localStorage.setItem('bookworm_settings', JSON.stringify(current));
}

export function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  getSettings()[key] = value;
  save();
}

export function applySettings(): void {
  const s = getSettings();
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.style.setProperty('--font-size', s.fontSize + 'px');

  ($('theme-select') as HTMLSelectElement).value = s.theme;
  ($('font-size') as HTMLInputElement).value = String(s.fontSize);
  $('font-size-label').textContent = s.fontSize + 'px';
  ($('font-select') as HTMLSelectElement).value = s.font;
  applyFont(s.font);

  ($('tts-endpoint') as HTMLInputElement).value = s.tts.endpoint;
  ($('tts-api-key') as HTMLInputElement).value = s.tts.apiKey;
  ($('tts-model') as HTMLInputElement).value = s.tts.model;
  ($('tts-voice') as HTMLInputElement).value = s.tts.voice;
  ($('tts-speed') as HTMLInputElement).value = String(s.tts.speed);
  $('tts-speed-label').textContent = s.tts.speed + 'x';
}
