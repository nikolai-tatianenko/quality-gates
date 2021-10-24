#!/usr/bin/env node

const program = require('commander');
const checkLighthouse = require('./src/services/lighthouse');

program
.version('1.0.0')
.description('Run Lighthouse on an array of URLs')
.arguments('<urls...>')
.action((urls) => {
  checkLighthouse(urls)
  .then((results) => {
    console.log(results);
  })
  .catch((err) => {
    console.error(err);
  });
});

// Helper options.
program.on('--help', () => {
  console.log('');
  console.log('Example call: node index.js https://www.google.com');
  console.log('  $ custom-help --help');
});
program.parse(process.argv);
