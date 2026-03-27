import type { Chapter } from './types';

// Patterns for detecting chapter headings in Chinese novels
const CHAPTER_PATTERNS: RegExp[] = [
  // 第一章, 第1章, 第一百二十三章, etc.
  /^[　\s]*第[零一二三四五六七八九十百千萬万〇○０-９0-9]+[章節回卷集部篇]/,
  // 楔子, 序章, 序言, 引子, 前言
  /^[　\s]*(楔子|序章|序言|引子|前言|引言|開篇)/,
  // 尾聲, 後記, 終章, 番外
  /^[　\s]*(尾聲|後記|终章|終章|番外|後話|結語|完本感言|完結感言)/,
  // Chapter patterns with colon/space: 第X章 XXXX or 第X章：XXXX
  /^[　\s]*第[零一二三四五六七八九十百千萬万〇○０-９0-9]+[章節回卷集部篇][　\s：:]/,
];

// Minimum distance between chapters (in characters) to avoid false positives
const MIN_CHAPTER_DISTANCE = 500;

export function detectChapters(text: string): Chapter[] {
  const chapters: Chapter[] = [];
  const lines = text.split('\n');
  let charIndex = 0;
  let lastChapterIndex = -MIN_CHAPTER_DISTANCE;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length > 0 && trimmed.length <= 50) {
      for (const pattern of CHAPTER_PATTERNS) {
        if (pattern.test(trimmed) && (charIndex - lastChapterIndex) >= MIN_CHAPTER_DISTANCE) {
          chapters.push({
            title: trimmed,
            startIndex: charIndex,
          });
          lastChapterIndex = charIndex;
          break;
        }
      }
    }

    charIndex += line.length + 1; // +1 for the newline
  }

  // If no chapters detected, treat the whole text as one chapter
  if (chapters.length === 0) {
    chapters.push({ title: '全文', startIndex: 0 });
  }

  return chapters;
}

export function findCurrentChapter(chapters: Chapter[], charPosition: number): number {
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (charPosition >= chapters[i].startIndex) return i;
  }
  return 0;
}
