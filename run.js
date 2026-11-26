'use strict';
// Run the casters from source: `node run.js` (or `npm start`), `node run.js --demo`.
// The release exe does the same thing (see tools/bootstrap.js), with the folder next to
// the exe as its home. From source, the home is this folder: voice packs go here, and the
// Casters folder (settings, log, captures) is made here.
const path = require('path');
const { version } = require('./package.json');
require('./app/main.js')
  .main({ exeDir: __dirname, version, argv: process.argv.slice(2) })
  .then((code) => process.exit(code || 0), (e) => { console.error(e); process.exit(1); });
