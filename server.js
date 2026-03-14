const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8080;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Tabloyu oluştur
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_data (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('DB ready');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  // GET /api/data/:key
  if (req.method === 'GET' && url.startsWith('/api/data/')) {
    const key = decodeURIComponent(url.slice(10));
    try {
      const r = await pool.query('SELECT value FROM dashboard_data WHERE key=$1', [key]);
      if (r.rows.length > 0) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(r.rows[0].value);
      } else {
        res.writeHead(404); res.end('null');
      }
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // POST /api/data/:key
  if (req.method === 'POST' && url.startsWith('/api/data/')) {
    const key = decodeURIComponent(url.slice(10));
    try {
      const body = await parseBody(req);
      const value = JSON.stringify(body.value);
      await pool.query(`
        INSERT INTO dashboard_data (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()
      `, [key, value]);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end('{"ok":true}');
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // GET /api/data - tüm keyleri getir (migration için)
  if (req.method === 'GET' && url === '/api/data') {
    try {
      const r = await pool.query('SELECT key, value FROM dashboard_data');
      const obj = {};
      r.rows.forEach(row => obj[row.key] = JSON.parse(row.value));
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(obj));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // HTML dosyası
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(data);
  });

}).listen(PORT, async () => {
  await initDB();
  console.log(`Server running on port ${PORT}`);
});
