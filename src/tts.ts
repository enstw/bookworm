import type { TTSSettings } from './types';

type TTSCallback = (state: 'playing' | 'paused' | 'stopped' | 'error', info?: string) => void;

export class AITextToSpeech {
  private settings: TTSSettings;
  private audio: HTMLAudioElement | null = null;
  private sentences: string[] = [];
  private currentIndex = 0;
  private playing = false;
  private onStateChange: TTSCallback;
  private abortController: AbortController | null = null;

  constructor(settings: TTSSettings, onStateChange: TTSCallback) {
    this.settings = settings;
    this.onStateChange = onStateChange;
  }

  updateSettings(settings: TTSSettings): void {
    this.settings = settings;
  }

  setSentences(sentences: string[]): void {
    this.sentences = sentences;
    this.currentIndex = 0;
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  setCurrentIndex(index: number): void {
    this.currentIndex = Math.max(0, Math.min(index, this.sentences.length - 1));
  }

  getCurrentSentence(): string {
    return this.sentences[this.currentIndex] ?? '';
  }

  async play(): Promise<void> {
    if (!this.settings.endpoint || !this.settings.apiKey) {
      this.onStateChange('error', '請先在設定中填入 TTS API 端點和 API Key');
      return;
    }

    if (this.currentIndex >= this.sentences.length) {
      this.onStateChange('stopped');
      return;
    }

    this.playing = true;
    await this.speakCurrent();
  }

  pause(): void {
    this.playing = false;
    if (this.audio) {
      this.audio.pause();
    }
    this.abortController?.abort();
    this.onStateChange('paused');
  }

  stop(): void {
    this.playing = false;
    this.currentIndex = 0;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    this.abortController?.abort();
    this.onStateChange('stopped');
  }

  next(): void {
    if (this.currentIndex < this.sentences.length - 1) {
      this.currentIndex++;
      if (this.playing) {
        if (this.audio) { this.audio.pause(); this.audio.src = ''; }
        this.abortController?.abort();
        this.speakCurrent();
      }
    }
  }

  prev(): void {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      if (this.playing) {
        if (this.audio) { this.audio.pause(); this.audio.src = ''; }
        this.abortController?.abort();
        this.speakCurrent();
      }
    }
  }

  isPlaying(): boolean {
    return this.playing;
  }

  private async speakCurrent(): Promise<void> {
    const text = this.sentences[this.currentIndex];
    if (!text) {
      this.playing = false;
      this.onStateChange('stopped');
      return;
    }

    this.onStateChange('playing', text);

    try {
      this.abortController = new AbortController();

      const res = await fetch(this.settings.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.settings.apiKey}`,
        },
        body: JSON.stringify({
          model: this.settings.model || 'tts-1',
          input: text,
          voice: this.settings.voice || 'alloy',
          speed: this.settings.speed || 1.0,
        }),
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`TTS API error ${res.status}: ${err}`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      this.audio = new Audio(url);
      this.audio.playbackRate = 1.0; // speed is handled by the API

      await new Promise<void>((resolve, reject) => {
        if (!this.audio) return reject(new Error('No audio'));

        this.audio.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        this.audio.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Audio playback error'));
        };

        this.audio.play().catch(reject);
      });

      // Auto-advance to next sentence
      if (this.playing) {
        this.currentIndex++;
        if (this.currentIndex < this.sentences.length) {
          await this.speakCurrent();
        } else {
          this.playing = false;
          this.onStateChange('stopped');
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      console.error('TTS error:', e);
      this.playing = false;
      this.onStateChange('error', e.message);
    }
  }
}

// Split text into sentences for TTS
export function splitSentences(text: string): string[] {
  // Split on Chinese sentence-ending punctuation and newlines
  const raw = text.split(/(?<=[。！？\n])/);
  return raw
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length < 500);
}
