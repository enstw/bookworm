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

// --- Chapter detection (same logic as src/chapters.ts) ---
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

// Convert a book zip: unzip → decode GB18030 → SC→TC → detect chapters → split → re-zip
function convertBook(srcPath, outPath) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bookworm-'));
  try {
    execSync(`unzip -o "${srcPath}" -d "${tmp}"`, { stdio: 'pipe' });

    const allFiles = fs.readdirSync(tmp);
    const txtFile = allFiles.find(f => /\.txt$/i.test(f));
    if (!txtFile) return null;

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

    // Book name from original txt filename, converted to TC
    return converter(txtFile.replace(/\.txt$/i, ''));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Read book name from a processed zip (TC name from first chapter file)
function getBookNameFromZip(zipPath, srcZipPath) {
  // Derive name from source txt filename
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bookworm-name-'));
  try {
    execSync(`unzip -o "${srcZipPath}" -d "${tmp}"`, { stdio: 'pipe' });
    const txtFile = fs.readdirSync(tmp).find(f => /\.txt$/i.test(f));
    return txtFile ? converter(txtFile.replace(/\.txt$/i, '')) : null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Main build ---
const srcFiles = fs.readdirSync(srcDir)
  .filter(f => /\.(zip|txt)$/i.test(f))
  .sort();

// Step 1: Convert source books → output directory
const books = [];
for (const f of srcFiles) {
  const srcPath = path.join(srcDir, f);
  const outPath = path.join(outDir, f);

  if (/\.zip$/i.test(f)) {
    // Skip if output already exists and is newer than source
    if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= fs.statSync(srcPath).mtimeMs) {
      const name = getBookNameFromZip(outPath, srcPath);
      console.log(`  ${f}: up to date, skipping`);
      books.push({ name: name || f.replace(/\.zip$/i, ''), file: f });
    } else {
      console.log(`  ${f}: converting GB18030 SC → UTF-8 TC + splitting chapters...`);
      const name = convertBook(srcPath, outPath);
      console.log(`  ${f}: done`);
      books.push({ name: name || f.replace(/\.zip$/i, ''), file: f });
    }
  } else {
    // Plain .txt — just copy
    fs.copyFileSync(srcPath, outPath);
    books.push({ name: f.replace(/\.txt$/i, ''), file: f });
  }
}

// Step 2: Generate books/index.json
fs.writeFileSync(
  path.join(outDir, 'index.json'),
  JSON.stringify(books, null, 2) + '\n'
);
console.log(`Generated books/index.json: ${books.length} book(s)`);

// Step 3: Compile TypeScript
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
