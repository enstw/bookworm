import type { Book, Chapter } from './types';
import type { AITextToSpeech } from './tts';

export const state = {
  books: [] as Book[],
  currentBook: null as Book | null,
  zipEntries: {} as Record<string, Uint8Array>,
  chapters: [] as Chapter[],
  currentChapterIndex: 0,
  tts: null as AITextToSpeech | null,
};

const decoder = new TextDecoder('utf-8');

export function getChapterText(index: number): string {
  const raw = state.zipEntries[state.chapters[index].filename];
  return decoder.decode(raw);
}
