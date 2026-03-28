const esbuild = require('esbuild');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { version } = require('./package.json');
const gitHash = execSync('git rev-parse --short HEAD').toString().trim();

// Read the first .txt filename from inside a zip file
function getBookNameFromZip(zipPath) {
  const buf = fs.readFileSync(zipPath);
  // Find End of Central Directory record (signature 0x06054b50)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) return null;
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdCount = buf.readUInt16LE(eocdOffset + 8);
  // Walk central directory entries
  let offset = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const gpFlag = buf.readUInt16LE(offset + 8);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const nameBytes = buf.subarray(offset + 46, offset + 46 + nameLen);
    // Try UTF-8 first (works whether or not the flag is set), fall back to GB18030
    let name;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch {
      name = new TextDecoder('gb18030').decode(nameBytes);
    }
    if (/\.txt$/i.test(name) && !name.startsWith('__MACOSX')) {
      return name.replace(/\.txt$/i, '');
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// Auto-generate books/index.json from files in books/
const booksDir = path.join(__dirname, 'books');
const bookFiles = fs.readdirSync(booksDir)
  .filter(f => /\.(zip|txt)$/i.test(f))
  .sort();
const books = bookFiles.map(f => {
  let name = f.replace(/\.(zip|txt)$/i, '');
  if (/\.zip$/i.test(f)) {
    const innerName = getBookNameFromZip(path.join(booksDir, f));
    if (innerName) name = innerName;
  }
  return { name, file: f };
});
fs.writeFileSync(
  path.join(booksDir, 'index.json'),
  JSON.stringify(books, null, 2) + '\n'
);
console.log(`Generated books/index.json: ${books.length} book(s)`);

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
