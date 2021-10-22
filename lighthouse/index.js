const fs = require('fs');
const lighthouse = require('lighthouse');
const chromeLauncher = require('chrome-launcher');

const urls = [
  'https://example.com',
  'https://google.com'
];

async function* checkUrl(urls) {
  for (const url of urls) {
    const nStartTime = Date.now();
    const chrome = await chromeLauncher.launch({chromeFlags: ['--headless']});
    // logLevel: 'info',
    const options = {output: 'json',  port: chrome.port};
    const runnerResult = await lighthouse(url, options);

    // `.report` is the HTML report as a string
    //const reportHtml = runnerResult.report;
    //fs.writeFileSync('lhreport.html', reportHtml);

    // `.lhr` is the Lighthouse Result as a JS object

    // Get timeout
    const nEndTime = Date.now();
    yield {
      url: runnerResult.lhr.finalUrl,
      'time': (nEndTime - nStartTime)/1000,
      'score': {
        'accessibility':runnerResult.lhr.categories.accessibility.score * 100,
        'best-practices':runnerResult.lhr.categories['best-practices'].score * 100,
        'performance':runnerResult.lhr.categories.performance.score * 100,
        'pwa':runnerResult.lhr.categories.pwa.score * 100,
        'seo':runnerResult.lhr.categories.seo.score * 100
      }
    };
    await chrome.kill();
  }
}

async function checkLighthouse(urls) {
  const results = [],
        nStartTime = Date.now();

  for await (let item of checkUrl(urls)) {
    results.push(item);
  }

  const nEndTime = Date.now();
  console.log(results, 'Total Time: ' + String((nEndTime - nStartTime)/1000) + ' sec');
};

checkLighthouse(urls);

//export default checkLighthouse;
