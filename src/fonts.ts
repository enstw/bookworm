const SUPPORTED_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'];

interface FontEntry {
  name: string;
  file: string;
}

export async function loadFontList(): Promise<FontEntry[]> {
  try {
    const res = await fetch('fonts/index.json');
    if (!res.ok) return [];
    const list: { name: string; file: string }[] = await res.json();
    return list.filter(f => SUPPORTED_EXTENSIONS.some(ext => f.file.endsWith(ext)));
  } catch {
    return [];
  }
}

export async function registerFonts(fonts: FontEntry[]): Promise<void> {
  for (const font of fonts) {
    const format = font.file.endsWith('.woff2') ? 'woff2'
      : font.file.endsWith('.woff') ? 'woff'
      : font.file.endsWith('.otf') ? 'opentype'
      : 'truetype';

    const face = new FontFace('BookwormCustom', `url(fonts/${font.file})`, {
      style: 'normal',
      weight: '400',
      display: 'swap',
    });

    // Also register with the font's own name for the selector
    const namedFace = new FontFace(font.name, `url(fonts/${font.file})`, {
      style: 'normal',
      weight: '400',
      display: 'swap',
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

export function applyFont(fontName: string): void {
  const reader = document.getElementById('reader');
  if (!reader) return;

  if (fontName === 'default') {
    reader.style.fontFamily = '';
  } else {
    reader.style.fontFamily = `'${fontName}', 'BookwormCustom', serif`;
  }
}
