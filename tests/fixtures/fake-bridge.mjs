// A stand-in for `qualitygate bridge` used by the desktop launcher tests. argv[2] selects a behaviour.
import { createServer } from 'node:http';
const mode = process.argv[2];
if (mode === 'exit') process.exit(3);
if (mode === 'silent') setInterval(() => {}, 1000);
else if (mode === 'dead-port') { console.log('QualityGate bridge: http://127.0.0.1:1\nPairing code: AAAA-BBBB'); setInterval(() => {}, 1000); }
else {
  if (mode === 'stubborn') process.on('SIGTERM', () => {});
  const server = createServer((req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.origin !== 'tauri://localhost') return reply(403, { error: 'origin' });
    if (req.url === '/v1/ping') return reply(200, { name: mode === 'wrong-name' ? 'other' : 'qualitygate-bridge' });
    if (req.url === '/v1/pair') return mode === 'bad-pair' ? reply(401, { error: 'Invalid pairing code' }) : mode === 'no-token' ? reply(200, {}) : reply(200, { token: 'secret-token' });
    if (req.headers.authorization !== 'Bearer secret-token') return reply(401, { error: 'Unauthorized' });
    if (req.method === 'DELETE') return mode === 'revoke-fails' ? reply(500, { error: 'boom' }) : reply(200, { revoked: true });
    if (req.url === '/v1/runs/latest') return reply(200, { runId: 'r1', decision: 'PASS', exitCode: 0 });
    reply(404, { error: 'Not found' });
  });
  server.listen(0, '127.0.0.1', () => console.log(`QualityGate bridge: http://127.0.0.1:${server.address().port}\nPairing code: ${mode === 'bad-code' ? 'nope' : 'K7QM-4TXD'} (single use)`));
}
