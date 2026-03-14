const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL });
}

async function initDB() {
  if (!pool) { console.log('No DB, using localStorage only'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_data (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('DB ready');
  } catch(e) {
    console.error('DB init error:', e.message);
    pool = null;
  }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch(e) { resolve({}); }
    });
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

  if (req.method === 'GET' && url.startsWith('/api/data/')) {
    const key = decodeURIComponent(url.slice(10));
    if (!pool) { res.writeHead(404); res.end('null'); return; }
    try {
      const r = await pool.query('SELECT value FROM dashboard_data WHERE key=$1', [key]);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(r.rows.length > 0 ? r.rows[0].value : 'null');
    } catch(e) { res.writeHead(500); res.end('null'); }
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/data/')) {
    const key = decodeURIComponent(url.slice(10));
    if (!pool) { res.writeHead(200); res.end('{"ok":true}'); return; }
    try {
      const body = await parseBody(req);
      const value = JSON.stringify(body.value);
      await pool.query(`
        INSERT INTO dashboard_data (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()
      `, [key, value]);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end('{"ok":true}');
    } catch(e) { res.writeHead(500); res.end('{"ok":false}'); }
    return;
  }

  if (req.method === 'GET' && url === '/api/data') {
    if (!pool) { res.writeHead(200); res.end('{}'); return; }
    try {
      const r = await pool.query('SELECT key, value FROM dashboard_data');
      const obj = {};
      r.rows.forEach(row => { try { obj[row.key] = JSON.parse(row.value); } catch(e) {} });
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(obj));
    } catch(e) { res.writeHead(200); res.end('{}'); }
    return;
  }

  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(data);
  });

}).listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});
