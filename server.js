'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const modEsl = require('modesl');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const session = require('express-session');

// Load env (standard .env, then fallback to the provided sample filename)
dotenv.config();
if (!process.env.FS_ESL_HOST && fs.existsSync(path.join(__dirname, '.env,examle.txt'))) {
  dotenv.config({ path: path.join(__dirname, '.env,examle.txt'), override: false });
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'esl-admin-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hours
  })
);

const runtimeConfig = {
  fsHost: process.env.FS_ESL_HOST || '127.0.0.1',
  fsPort: Number(process.env.FS_ESL_PORT || 8021),
  fsPassword: process.env.FS_ESL_PASSWORD || 'ClueCon',
  dialPrefix: process.env.FS_DIAL_PREFIX || 'sofia/gateway/public/',
  port: Number(process.env.PORT || 8080)
};

// MySQL pool
const dbConfigFromUrl = () => {
  if (!process.env.DATABASE_URL) return null;
  const u = new URL(process.env.DATABASE_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ssl: u.searchParams.get('ssl-mode') ? { rejectUnauthorized: false } : undefined
  };
};

const dbConfig =
  dbConfigFromUrl() || {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  };

let pool;
async function initDb() {
  if (!dbConfig || !dbConfig.host) {
    console.warn('Database config missing; call logging will be disabled.');
    return;
  }
  pool = mysql.createPool({ ...dbConfig, waitForConnections: true, connectionLimit: 5 });
  await pool.query(`CREATE TABLE IF NOT EXISTS call_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    to_number VARCHAR(64),
    from_number VARCHAR(64),
    audio_url TEXT,
    status VARCHAR(32),
    job_id VARCHAR(128),
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_created_at (created_at)
  )`);
}

let eslConn;
let eslReady = false;
function closeEsl() {
  if (eslConn && eslConn.socket && !eslConn.socket.destroyed) {
    try {
      eslConn.socket.end();
    } catch (_) {
      /* ignore */
    }
  }
  eslConn = null;
  eslReady = false;
}

function connectEsl() {
  closeEsl();
  eslConn = new modEsl.Connection(
    runtimeConfig.fsHost,
    Number(runtimeConfig.fsPort),
    runtimeConfig.fsPassword,
    () => {
      eslReady = true;
      console.log(`ESL connected to ${runtimeConfig.fsHost}:${runtimeConfig.fsPort}`);
      eslConn.events('plain', 'ALL');
    }
  );

  eslConn.on('error', (err) => {
    eslReady = false;
    console.error('ESL error:', err);
  });

  const handleClose = () => {
    eslReady = false;
    eslConn = null;
    console.warn('ESL connection closed; retrying in 3s');
    setTimeout(connectEsl, 3000);
  };

  eslConn.on('close', handleClose);
  eslConn.on('esl::end', handleClose);
}

connectEsl();
initDb().catch((err) => console.error('DB init failed', err));

async function logCall(entry) {
  if (!pool) return;
  const { toNumber, fromNumber, audioUrl, status, jobId, error } = entry;
  try {
    await pool.query(
      'INSERT INTO call_logs (to_number, from_number, audio_url, status, job_id, error) VALUES (?, ?, ?, ?, ?, ?)',
      [toNumber, fromNumber, audioUrl, status, jobId || null, error || null]
    );
  } catch (err) {
    console.error('Failed to log call', err);
  }
}

// Views
const requireAuth = (req, res, next) => {
  if (req.session?.auth) return next();
  return res.redirect('/login');
};

app.get('/', (_req, res) => res.redirect('/admin'));
app.get('/login', (req, res) => {
  if (req.session?.auth) return res.redirect('/admin');
  res.render('login', { error: null });
});

app.post('/login', bodyParser.urlencoded({ extended: false }), (req, res) => {
  const { username, password } = req.body || {};
  const u = process.env.ADMIN_USER || 'admin';
  const p = process.env.ADMIN_PASS || 'admin123';
  if (username === u && password === p) {
    req.session.auth = true;
    return res.redirect('/admin');
  }
  return res.render('login', { error: 'Invalid credentials' });
});

app.post('/logout', (req, res) => {
  req.session?.destroy(() => res.redirect('/login'));
});

app.get('/admin', requireAuth, (_req, res) => res.render('dashboard'));

// API: place call
app.post('/call', (req, res) => {
  const { toNumber, fromNumber, audioUrl } = req.body || {};
  if (!toNumber || !fromNumber || !audioUrl) {
    return res.status(400).json({ error: 'toNumber, fromNumber, and audioUrl are required' });
  }
  const sockOk = eslConn && eslConn.socket && !eslConn.socket.destroyed;
  if (!eslConn || !eslReady || !sockOk) {
    return res.status(503).json({ error: 'ESL not connected' });
  }

  const dialString =
    `{origination_caller_id_number=${fromNumber},ignore_early_media=true,hangup_after_bridge=true}` +
    `${runtimeConfig.dialPrefix}${toNumber}`;
  const appString = `&playback(${audioUrl})`;

  eslConn.api(`originate ${dialString} ${appString}`, async (reply) => {
    const body = reply && reply.getBody ? reply.getBody() : '';
    const success = body.startsWith('+OK');
    await logCall({
      toNumber,
      fromNumber,
      audioUrl,
      status: success ? 'placed' : 'error',
      jobId: body.trim(),
      error: success ? null : body.trim()
    });
    if (success) {
      return res.json({ status: 'placed', job: body.trim() });
    }
    return res.status(500).json({ status: 'error', detail: body.trim() });
  });
});

// API: stats for dashboard
app.get('/api/stats', requireAuth, async (_req, res) => {
  if (!pool) return res.json({ dbConnected: false });
  const [[totals]] = await pool.query(
    `SELECT
      COUNT(*) as total,
      SUM(status='placed') as placed,
      SUM(status='error') as failed,
      SUM(CASE WHEN DATE(created_at)=CURDATE() THEN 1 ELSE 0 END) as today
    FROM call_logs`
  );
  const [concurrentRows] = await pool.query(
    `SELECT COUNT(*) as concurrent FROM call_logs WHERE status='placed' AND created_at >= (NOW() - INTERVAL 120 SECOND)`
  );
  const [last7] = await pool.query(
    `SELECT DATE(created_at) as day, COUNT(*) as cnt
     FROM call_logs
     WHERE created_at >= (CURDATE() - INTERVAL 6 DAY)
     GROUP BY day ORDER BY day`
  );
  res.json({
    dbConnected: true,
    totals,
    concurrent: concurrentRows[0]?.concurrent || 0,
    last7: last7.map((r) => ({ day: r.day, count: r.cnt }))
  });
});

// API: recent calls
app.get('/api/calls', requireAuth, async (req, res) => {
  if (!pool) return res.json([]);
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const [rows] = await pool.query(
    `SELECT id, to_number as toNumber, from_number as fromNumber, audio_url as audioUrl,
            status, job_id as jobId, error, created_at as createdAt
     FROM call_logs
     ORDER BY created_at DESC
     LIMIT ?`,
    [limit]
  );
  res.json(rows);
});

// API: server config update
app.post('/api/server', requireAuth, async (req, res) => {
  const { fsHost, fsPort, fsPassword, dialPrefix } = req.body || {};
  if (!fsHost || !fsPort || !fsPassword || !dialPrefix) {
    return res.status(400).json({ error: 'fsHost, fsPort, fsPassword, dialPrefix required' });
  }
  runtimeConfig.fsHost = fsHost;
  runtimeConfig.fsPort = Number(fsPort);
  runtimeConfig.fsPassword = fsPassword;
  runtimeConfig.dialPrefix = dialPrefix;
  connectEsl();

  // persist to env file for future runs
  const envOut = [
    `PORT=${runtimeConfig.port}`,
    `FS_ESL_HOST=${runtimeConfig.fsHost}`,
    `FS_ESL_PORT=${runtimeConfig.fsPort}`,
    `FS_ESL_PASSWORD=${runtimeConfig.fsPassword}`,
    `FS_DIAL_PREFIX=${runtimeConfig.dialPrefix}`,
    process.env.DATABASE_URL ? `DATABASE_URL=${process.env.DATABASE_URL}` : null,
    process.env.DB_HOST ? `DB_HOST=${process.env.DB_HOST}` : null,
    process.env.DB_PORT ? `DB_PORT=${process.env.DB_PORT}` : null,
    process.env.DB_USER ? `DB_USER=${process.env.DB_USER}` : null,
    process.env.DB_PASSWORD ? `DB_PASSWORD=${process.env.DB_PASSWORD}` : null,
    process.env.DB_NAME ? `DB_NAME=${process.env.DB_NAME}` : null
  ]
    .filter(Boolean)
    .join('\n');
  const envPath = path.join(__dirname, '.env');
  fs.writeFileSync(envPath, envOut, 'utf8');
  res.json({ saved: true, fsHost });
});

app.get('/health', (_req, res) => {
  const connected = !!(eslConn && eslReady && eslConn.socket && !eslConn.socket.destroyed);
  res.json({ ok: true, eslConnected: connected, dbConnected: !!pool });
});

app.listen(runtimeConfig.port, () => {
  console.log(`HTTP server listening on ${runtimeConfig.port}`);
});
