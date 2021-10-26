const lighthouse = require('lighthouse');
const chromeLauncher = require('chrome-launcher');

/**
 * Wraps an async function in a retry loop that retries it until it succeeds or the maximum number of retries is reached.
 *
 * @param fn - The async function to wrap.
 * @param retries - The maximum number of retries. Defaults to 3.
 * @param retryDelay - The delay (in milliseconds) between retries. Defaults to 1000.
 * @returns The result of the function if it succeeds.
 * @throws An error if the function fails after the maximum number of retries is reached.
 */
async function retryAsync(fn, retries = 3, retryDelay = 1000) {
  let retryCount = 0;
  let success = false;

  while (!success && retryCount <= retries) {
    try {
      const result = await fn();
      success = true;
      return result;
    } catch (error) {
      retryCount++;
      console.error(`Error (retry ${retryCount} of ${retries}): ${error}`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }

  throw new Error(`Failed after ${retries} retries`);
}

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

        return {
          url: runnerResult.lhr.finalUrl,
          'time': (nEndTime - nStartTime) / 1000,
          'score': {
            'accessibility': runnerResult.lhr.categories.accessibility.score * 100,
            'best-practices': runnerResult.lhr.categories['best-practices'].score * 100,
            'performance': runnerResult.lhr.categories.performance.score * 100,
            'pwa': runnerResult.lhr.categories.pwa.score * 100,
            'seo': runnerResult.lhr.categories.seo.score * 100,
          },
        };
      }, retries, retryDelay);

      yield result;
    } catch (error) {
      console.error(`Error testing URL '${url}': ${error}`);
    }
  }
}


/**
 *
 * @param urls
 * @returns {Promise<*[]>}
 */
async function checkLighthouse(urls) {
  const results = [];
  const nStartTime = Date.now();

  try {
    for await (let item of checkUrl(urls)) {
      results.push(item);
    }
  } catch (error) {
    console.error(`Error running Lighthouse tests: ${error}`);
  }

  const nEndTime = Date.now();
  console.log(`Results: ${results}`);
  console.log(`Total Time: ${String((nEndTime - nStartTime) / 1000)} sec`);
  return results;
}

module.exports = checkLighthouse;
