#!/usr/bin/env node

const program = require('commander');
const checkLighthouse = require('./src/services/lighthouse');
program.version('1.0.0').
  description('Run Lighthouse on an array of URLs').
  option('-e, --example', 'run an example Lighthouse test of "google.com"').
  arguments('<urls...>').
  action((urls = []) => {
    if (!urls || !urls.length) {
      console.error('error: missing required argument \'urls\'');
      program.help();
      return;
    }
    console.log('Lighouse urls: ', urls);
    console.log('Please wait...');

    checkLighthouse(urls).then((results) => {
      console.log('Lighthouse tests complete.');
      console.log(results);
    }).catch((err) => {
      console.log('Lighthouse tests failed.');
      console.error(err);
    });
  });


// Helper options.
program.on('--help', () => {
  console.log('');
  console.log('Example call: node index.js https://www.google.com');
  console.log('  $ custom-help --help');
});
program.command('example').
  description('Run an example Lighthouse test with test of "google.com"').
  action(() => {
    const urls = ['https://www.google.com'];
    checkLighthouse(urls).then((results) => {
      console.log(results);
    }).catch((err) => {
      console.error(err);
    });
  });
program.parse(process.argv);
