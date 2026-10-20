#!/usr/bin/env node
import http from 'node:http';

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const send = (status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  if (url.pathname === '/health') {
    send(200, { status: 'ok', service: 'chaos-demo-target' });
    return;
  }
  if (url.pathname === '/slow') {
    setTimeout(() => send(200, { status: 'ok', slow: true }), 250);
    return;
  }
  send(404, { error: 'not_found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`READY ${server.address().port}`);
});

function shutdown() {
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
