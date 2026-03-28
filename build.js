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

// Convert a book zip: unzip → decode GB18030 → SC→TC → normalize CRLF → re-encode UTF-8 → re-zip
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

    // Convert filename SC→TC too
    const tcName = converter(txtFile);
    fs.writeFileSync(path.join(tmp, tcName), tc, 'utf-8');
    if (tcName !== txtFile) fs.unlinkSync(path.join(tmp, txtFile));

    // Zip to output path
    execSync(`cd "${tmp}" && zip -j "${outPath}" "${tcName}"`, { stdio: 'pipe' });
    return tcName.replace(/\.txt$/i, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Read the first .txt filename from a UTF-8 zip
function getBookNameFromZip(zipPath) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bookworm-name-'));
  try {
    execSync(`unzip -o "${zipPath}" -d "${tmp}"`, { stdio: 'pipe' });
    const txtFile = fs.readdirSync(tmp).find(f => /\.txt$/i.test(f));
    return txtFile ? txtFile.replace(/\.txt$/i, '') : null;
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
      const name = getBookNameFromZip(outPath);
      console.log(`  ${f}: up to date, skipping`);
      books.push({ name: name || f.replace(/\.zip$/i, ''), file: f });
    } else {
      console.log(`  ${f}: converting GB18030 SC → UTF-8 TC...`);
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
