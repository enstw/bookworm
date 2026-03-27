const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { version } = require('./package.json');

// Auto-generate books/index.json from files in books/
const booksDir = path.join(__dirname, 'books');
const bookFiles = fs.readdirSync(booksDir)
  .filter(f => /\.(zip|txt)$/i.test(f))
  .sort();
const books = bookFiles.map(f => ({
  name: f.replace(/\.(zip|txt)$/i, ''),
  file: f,
}));
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
  },
});
