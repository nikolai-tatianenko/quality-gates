const lighthouse = require('lighthouse');
const chromeLauncher = require('chrome-launcher');
const { retryAsync, writeResultsToFile } = require('./lib/helper');

/**
 *
 * @param urls
 * @returns {AsyncGenerator<{score: {performance: number, accessibility: number, 'best-practices': number, pwa: number, seo: number}, time: number, url}, void, *>}
 */
async function* checkUrl(urls, retries = 3, retryDelay = 1000) {
  for (const url of urls) {
    try {
      console.log(`Testing URL '${url}'...`);
      const result = await retryAsync(async () => {
        const nStartTime = Date.now();
        const chrome = await chromeLauncher.launch({chromeFlags: ['--headless']});
        const options = {output: 'json', port: chrome.port};
        const runnerResult = await lighthouse(url, options);
        const nEndTime = Date.now();

        await chrome.kill();

        const {
          accessibility: accessibilityScore,
          'best-practices': bestPracticesScore,
          performance: performanceScore,
          pwa: pwaScore,
          seo: seoScore
        } = runnerResult.lhr.categories;

        return {
          url: runnerResult.lhr.finalUrl,
          time: (nEndTime - nStartTime) / 1000,
          score: {
            accessibility: accessibilityScore.score * 100,
            'best-practices': bestPracticesScore.score * 100,
            performance: performanceScore.score * 100,
            pwa: pwaScore.score * 100,
            seo: seoScore.score * 100,
          },
        };
      }, retries, retryDelay);

      yield result;
    } catch (error) {
      console.error(`Error testing URL '${url}': ${error.message}`);
    }
  }
}

/**
 *
 * @param urls
 * @returns {Promise<*[]>}
 */
async function checkLighthouse(urls, options = {}) {
  const { retries = 3, retryDelay = 1000, outputFileName = 'results.json' } = options;
  const results = [];
  const nStartTime = Date.now();

  try {
    for await (let item of checkUrl(urls, retries, retryDelay)) {
      results.push(item);
    }
  } catch (error) {
    console.error(`Error running Lighthouse tests: ${error.message}`);
  }

  const nEndTime = Date.now();

  console.log(`Results:`);
  console.dir(results);
  console.log(`Total Time: ${String((nEndTime - nStartTime) / 1000)} sec`);
  writeResultsToFile(results, outputFileName);
  return results;
}

module.exports = checkLighthouse;
