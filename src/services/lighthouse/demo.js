
const lighthouse = require('./lighthouse');
/**
 * Run Demo to check.
 */
function demo() {
  const urls = [
    'https://example.com',
    'https://google.com',
  ];

  lighthouse(urls);
}

demo();
