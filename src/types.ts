export interface Book {
  name: string;
  file: string;
}

export interface Chapter {
  title: string;
  startIndex: number;
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
  tts: TTSSettings;
}

export interface ReadingPosition {
  book: string;
  chapter: number;
  scrollLeft: number;
}
