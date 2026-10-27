import { parentPort, workerData } from 'node:worker_threads';
import lighthouse from 'lighthouse';
import { message } from '../../../protocol/src/index.js';
try {
  const { url, port } = workerData as { url: string; port: number };
  const result = await lighthouse(url, {
    port, logLevel: 'silent', output: 'json',
    onlyCategories: ['performance', 'accessibility', 'seo', 'best-practices'],
  });
  if (!result) throw new Error('Lighthouse returned no result');
  parentPort!.postMessage({ raw: result.lhr });
} catch (error) { parentPort!.postMessage({ error: message(error) }); }
