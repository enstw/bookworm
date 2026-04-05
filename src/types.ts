export interface Book {
  name: string;
  file: string;
}

export interface Chapter {
  title: string;
  filename: string;
}

export interface TTSSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  voice: string;
  speed: number;
}

export interface AppSettings {
  fontSize: number;
  theme: string;
  font: string;
  /** How many chapters to keep mounted on each side of the current chapter. */
  preloadChapters: number;
  tts: TTSSettings;
}

export interface ReadingPosition {
  book: string;
  chapter: number;
  page: number;
}
