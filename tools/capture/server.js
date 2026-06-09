'use strict';
// Local HTTP server that serves the extension's fixture pages and the writer
// demo, so the extension's content scripts run on a real http:// origin (not
// file://) and the fixture HTML loads with its original relative assets intact.
const http = require('http');
const fs   = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ttf':  'font/ttf',
  '.woff2':'font/woff2',
  '.otf':  'font/otf',
};

const PROJECT_ROOT  = path.resolve(__dirname, '../..');
const FIXTURES_DIR  = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'pages');
const CAPTURE_DIR   = __dirname;

function serve(port = 7331) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let filePath;

    if (url.pathname === '/writer-demo') {
      filePath = path.join(CAPTURE_DIR, 'writer-demo.html');
    } else {
      // /fixture/241627 → tests/fixtures/pages/241627.html
      const m = url.pathname.match(/^\/fixture\/(\d+)/);
      if (m) {
        filePath = path.join(FIXTURES_DIR, `${m[1]}.html`);
      } else {
        // Fallback: serve from project root (for extension resources referenced
        // by relative paths inside fixture HTML files — unlikely, but safe).
        filePath = path.join(PROJECT_ROOT, url.pathname.slice(1));
      }
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end(`Not found: ${url.pathname}`);
        return;
      }
      const ext  = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[server] fixture server on http://localhost:${port}`);
      resolve({ server, port, base: `http://localhost:${port}` });
    });
    server.on('error', reject);
  });
}

module.exports = { serve };
