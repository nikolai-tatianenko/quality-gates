import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('../tests/fixture.html', import.meta.url));
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
server.listen(4173, '127.0.0.1', () => console.log('Fixture: http://127.0.0.1:4173'));
