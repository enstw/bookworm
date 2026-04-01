const esbuild = require('esbuild');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpenCC = require('opencc-js');
const { version } = require('./package.json');
const gitHash = execSync('git rev-parse --short HEAD').toString().trim();

const converter = OpenCC.Converter({ from: 'cn', to: 'twp' });
const srcDir = path.join(__dirname, 'books-src');
const outDir = path.join(__dirname, 'books');

// Ensure output directory exists
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

// --- Chapter detection (same logic as original chapters.ts) ---
const CHAPTER_PATTERNS = [
  /^[　\s]*第[零一二三四五六七八九十百千萬万〇○０-９0-9]+[章節回卷集部篇]/,
  /^[　\s]*(楔子|序章|序言|引子|前言|引言|開篇)([　\s：:].+)?$/,
  /^[　\s]*(尾聲|後記|終章|番外|後話|結語|完本感言|完結感言)([　\s：:].+)?$/,
  /^[　\s]*第[零一二三四五六七八九十百千萬万〇○０-９0-9]+[章節回卷集部篇][　\s：:]/,
];
const MIN_CHAPTER_DISTANCE = 500;

function detectChapters(text) {
  const chapters = [];
  const lines = text.split('\n');
  let charIndex = 0;
  let lastChapterIndex = -MIN_CHAPTER_DISTANCE;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length <= 50) {
      for (const pattern of CHAPTER_PATTERNS) {
        if (pattern.test(trimmed) && (charIndex - lastChapterIndex) >= MIN_CHAPTER_DISTANCE) {
          chapters.push({ title: trimmed, startIndex: charIndex });
          lastChapterIndex = charIndex;
          break;
        }
      }
    }
    charIndex += line.length + 1;
  }

  if (chapters.length === 0) {
    chapters.push({ title: '全文', startIndex: 0 });
  }
  return chapters;
}

// Sanitize chapter title for use as filename (replace filesystem-unsafe chars)
function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '_');
}

// Convert a book zip: unzip → decode GB18030 → SC→TC → detect chapters → split → re-zip with TC name
function convertBook(srcPath, outDir) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bookworm-'));
  try {
    execSync(`unzip -o "${srcPath}" -d "${tmp}"`, { stdio: 'pipe' });

    const allFiles = fs.readdirSync(tmp);
    const txtFile = allFiles.find(f => /\.txt$/i.test(f));
    if (!txtFile) return null;

    // Book name: txt filename SC→TC
    const bookName = converter(txtFile.replace(/\.txt$/i, ''));
    const outFile = `${sanitizeFilename(bookName)}.zip`;
    const outPath = path.join(outDir, outFile);

    const raw = fs.readFileSync(path.join(tmp, txtFile));
    const decoded = new TextDecoder('gb18030').decode(raw);
    const tc = converter(decoded).replace(/\r\n/g, '\n');

    // Detect chapters and split into individual files
    const chapters = detectChapters(tc);
    const padLen = String(chapters.length).length;

    // Clean tmp for re-zipping
    for (const f of fs.readdirSync(tmp)) {
      const p = path.join(tmp, f);
      fs.rmSync(p, { recursive: true, force: true });
    }

    for (let i = 0; i < chapters.length; i++) {
      const start = chapters[i].startIndex;
      const end = i + 1 < chapters.length ? chapters[i + 1].startIndex : tc.length;
      const content = tc.slice(start, end);
      const prefix = String(i + 1).padStart(padLen, '0');
      const filename = `${prefix}_${sanitizeFilename(chapters[i].title)}.txt`;
      fs.writeFileSync(path.join(tmp, filename), content, 'utf-8');
    }

    // Zip chapter files to output
    execSync(`cd "${tmp}" && zip -j "${outPath}" *.txt`, { stdio: 'pipe' });

    return { name: bookName, file: outFile };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Convert new source books (if any) ---
if (fs.existsSync(srcDir)) {
  const srcFiles = fs.readdirSync(srcDir)
    .filter(f => /\.(zip|txt)$/i.test(f))
    .sort();

  for (const f of srcFiles) {
    const srcPath = path.join(srcDir, f);

    if (/\.zip$/i.test(f)) {
      console.log(`  ${f}: converting GB18030 SC → UTF-8 TC + splitting chapters...`);
      const result = convertBook(srcPath, outDir);
      if (result) console.log(`  ${f}: → ${result.file}`);
    } else {
      fs.copyFileSync(srcPath, path.join(outDir, f));
    }
  }
}

// --- Generate books/index.json from all zips in books/ ---
const existingZips = fs.readdirSync(outDir)
  .filter(f => /\.zip$/i.test(f))
  .sort();
const books = existingZips.map(f => ({
  name: f.replace(/\.zip$/i, ''),
  file: f,
}));
fs.writeFileSync(
  path.join(outDir, 'index.json'),
  JSON.stringify(books, null, 2) + '\n'
);
console.log(`Generated books/index.json: ${books.length} book(s)`);

// --- Compile TypeScript ---
esbuild.buildSync({
  entryPoints: ['src/app.ts'],
  bundle: true,
  outfile: 'app.js',
  format: 'esm',
  target: 'es2020',
  define: {
    '__APP_VERSION__': JSON.stringify(version),
    '__BUILD_HASH__': JSON.stringify(gitHash),
  },
});
