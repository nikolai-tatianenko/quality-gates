#!/usr/bin/env node

const program = require('commander');
const checkLighthouse = require('./checkLighthouse');

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

program.parse(process.argv);
