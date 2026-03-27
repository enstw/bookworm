const esbuild = require('esbuild');
const { version } = require('./package.json');

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
