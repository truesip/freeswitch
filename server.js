'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const AriClient = require('ari-client');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

// Load env (standard .env, then fallback to the provided sample filename)
dotenv.config();
if (!process.env.ARI_HOST && fs.existsSync(path.join(__dirname, '.env,examle.txt'))) {
  dotenv.config({ path: path.join(__dirname, '.env,examle.txt'), override: false });
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

const runtimeConfig = {
  ariHost: process.env.ARI_HOST || '127.0.0.1',
  ariPort: Number(process.env.ARI_PORT || 8088),
  ariUser: process.env.ARI_USER || 'ariuser',
  ariPassword: process.env.ARI_PASSWORD || 'aripass',
  ariApp: process.env.ARI_APP || 'dialer',
  dialPrefix: process.env.PJSIP_PREFIX || 'PJSIP/',
  webhookUrl: process.env.WEBHOOK_URL || '',
  port: Number(process.env.PORT || 8080)
};
if (!process.env.ARI_HOST) {
  console.warn('Warning: ARI_HOST not set; defaulting to 127.0.0.1:8088 (likely to fail in production).');
}

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
    ring_time DATETIME NULL,
    answer_time DATETIME NULL,
    hangup_time DATETIME NULL,
    duration_sec INT NULL,
    amd_status VARCHAR(64) NULL,
    webhook_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_created_at (created_at)
  )`);
  const alters = [
    "ALTER TABLE call_logs ADD COLUMN ring_time DATETIME NULL",
    "ALTER TABLE call_logs ADD COLUMN answer_time DATETIME NULL",
    "ALTER TABLE call_logs ADD COLUMN hangup_time DATETIME NULL",
    "ALTER TABLE call_logs ADD COLUMN duration_sec INT NULL",
    "ALTER TABLE call_logs ADD COLUMN amd_status VARCHAR(64) NULL",
    "ALTER TABLE call_logs ADD COLUMN webhook_url TEXT"
  ];
  for (const sql of alters) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.warn('Schema alter warning:', e.message);
    }
  }
}

// Session store (must come after dbConfig definition)
let sessionStore = null;
const sessionOpts = {
  secret: process.env.SESSION_SECRET || 'esl-admin-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hours
};
if (dbConfig && dbConfig.host) {
  const storeOptions = {
    host: dbConfig.host,
    port: dbConfig.port || 3306,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    clearExpired: true,
    checkExpirationInterval: 1000 * 60 * 10,
    expiration: 1000 * 60 * 60 * 8,
    createDatabaseTable: true
  };
  sessionStore = new MySQLStore(storeOptions);
  sessionOpts.store = sessionStore;
} else {
  console.warn('Warning: using in-memory session store; set DB env for production.');
}
app.use(session(sessionOpts));

let ari = null;
let ariReady = false;
const callCache = new Map(); // uuid -> {ring, answer}

async function connectAri() {
  ariReady = false;
  try {
    const url = `http://${runtimeConfig.ariHost}:${runtimeConfig.ariPort}`;
    ari = await AriClient.connect(url, runtimeConfig.ariUser, runtimeConfig.ariPassword);

    ari.on('StasisStart', (event) => {
      const chan = event.channel;
      const channelId =
        event?.channel?.id ||
        event?.channel?.channel_id ||
        event?.channel?.name ||
        (typeof event?.channel === 'string' ? event.channel : null);
      if (!channelId) {
        console.error('StasisStart missing channel id', JSON.stringify(event, null, 2));
        return;
      }
      const uuid = channelId;
      const now = new Date();
      callCache.set(uuid, { ...(callCache.get(uuid) || {}), answer: now });
      updateCallStatus(uuid, { status: 'answered', answer_time: now }).catch(console.error);
      // Ensure channel is answered before playback
      ari.channels
        .answer(channelId)
        .catch((err) => console.error('answer error', err?.message || err));
      fetchCallByUuid(uuid)
        .then((row) => sendWebhook({ event: 'answered', uuid, ...row, timestamp: now }))
        .catch(console.error);
      const audio = (event.args && event.args[0]) || chan?.variables?.audio_url;
      if (audio) {
        ari.channels
          .play(channelId, { media: audio })
          .catch((err) => console.error('play error', err?.message || err));
      }
    });

    ari.on('ChannelStateChange', (event) => {
      const chan = event.channel;
      if (chan.state === 'Ringing') {
        const now = new Date();
        callCache.set(chan.id, { ...(callCache.get(chan.id) || {}), ring: now });
        updateCallStatus(chan.id, { status: 'ringing', ring_time: now }).catch(console.error);
        fetchCallByUuid(chan.id)
          .then((row) => sendWebhook({ event: 'ringing', uuid: chan.id, ...row, timestamp: now }))
          .catch(console.error);
      }
    });

    ari.on('ChannelDestroyed', (event) => {
      const chan = event.channel;
      const now = new Date();
      const cache = callCache.get(chan.id) || {};
      const duration =
        cache.answer && now ? Math.max(0, Math.round((now.getTime() - cache.answer.getTime()) / 1000)) : null;
      updateCallStatus(chan.id, { status: 'hangup', hangup_time: now, duration_sec: duration }).catch(console.error);
      fetchCallByUuid(chan.id)
        .then((row) =>
          sendWebhook({ event: 'hangup', uuid: chan.id, duration, amdStatus: row?.amd_status, ...row, timestamp: now })
        )
        .catch(console.error);
      callCache.delete(chan.id);
    });

    ariReady = true;
    console.log(`ARI connected to ${runtimeConfig.ariHost}:${runtimeConfig.ariPort}`);
    ari.start(runtimeConfig.ariApp);
  } catch (err) {
    console.error('ARI connect error:', err.message || err);
    setTimeout(connectAri, 3000);
  }
}

connectAri();
initDb().catch((err) => console.error('DB init failed', err));

async function logCall(entry) {
  if (!pool) return;
  const { toNumber, fromNumber, audioUrl, status, jobId, error } = entry;
  try {
    await pool.query(
      'INSERT INTO call_logs (to_number, from_number, audio_url, status, job_id, error, webhook_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [toNumber, fromNumber, audioUrl, status, jobId || null, error || null, runtimeConfig.webhookUrl || null]
    );
  } catch (err) {
    console.error('Failed to log call', err);
  }
}

async function updateCallStatus(uuid, fields) {
  if (!pool || !uuid || !Object.keys(fields).length) return;
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k}=?`);
    vals.push(v);
  }
  vals.push(uuid);
  await pool.query(`UPDATE call_logs SET ${sets.join(', ')} WHERE job_id LIKE ?`, vals);
}

async function fetchCallByUuid(uuid) {
  if (!pool || !uuid) return null;
  const [rows] = await pool.query(
    'SELECT to_number as toNumber, from_number as fromNumber, job_id as jobId, audio_url as audioUrl, ring_time, answer_time, hangup_time, duration_sec, amd_status, status FROM call_logs WHERE job_id LIKE ? LIMIT 1',
    [uuid]
  );
  return rows[0] || null;
}

async function sendWebhook(payload) {
  if (!runtimeConfig.webhookUrl) return;
  try {
    await fetch(runtimeConfig.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('Webhook send failed', err.message);
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
  if (!ari || !ariReady) {
    return res.status(503).json({ error: 'ARI not connected' });
  }

  const endpoint = `${runtimeConfig.dialPrefix}${toNumber}`;
  ari.channels
    .originate({
      endpoint,
      callerId: fromNumber,
      app: runtimeConfig.ariApp,
      appArgs: audioUrl,
      variables: { audio_url: audioUrl }
    })
    .then(async (channel) => {
      const uuid = channel.id;
      await logCall({
        toNumber,
        fromNumber,
        audioUrl,
        status: 'placed',
        jobId: uuid,
        error: null
      });
      res.json({ status: 'placed', job: uuid });
    })
    .catch(async (err) => {
      await logCall({
        toNumber,
        fromNumber,
        audioUrl,
        status: 'error',
        jobId: null,
        error: err.message || String(err)
      });
      res.status(500).json({ status: 'error', detail: err.message || String(err) });
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
            status, job_id as jobId, error, duration_sec as durationSec, amd_status as amdStatus,
            created_at as createdAt
     FROM call_logs
     ORDER BY created_at DESC
     LIMIT ?`,
    [limit]
  );
  res.json(rows);
});

// API: server config update
app.post('/api/server', requireAuth, async (req, res) => {
  const { ariHost, ariPort, ariUser, ariPassword, ariApp, dialPrefix, webhookUrl } = req.body || {};
  if (!ariHost || !ariPort || !ariUser || !ariPassword || !dialPrefix || !ariApp) {
    return res.status(400).json({ error: 'ariHost, ariPort, ariUser, ariPassword, ariApp, dialPrefix required' });
  }
  runtimeConfig.ariHost = ariHost;
  runtimeConfig.ariPort = Number(ariPort);
  runtimeConfig.ariUser = ariUser;
  runtimeConfig.ariPassword = ariPassword;
  runtimeConfig.ariApp = ariApp;
  runtimeConfig.dialPrefix = dialPrefix;
  runtimeConfig.webhookUrl = webhookUrl || '';
  connectAri();

  const envOut = [
    `PORT=${runtimeConfig.port}`,
    `ARI_HOST=${runtimeConfig.ariHost}`,
    `ARI_PORT=${runtimeConfig.ariPort}`,
    `ARI_USER=${runtimeConfig.ariUser}`,
    `ARI_PASSWORD=${runtimeConfig.ariPassword}`,
    `ARI_APP=${runtimeConfig.ariApp}`,
    `PJSIP_PREFIX=${runtimeConfig.dialPrefix}`,
    `WEBHOOK_URL=${runtimeConfig.webhookUrl}`,
    process.env.DATABASE_URL ? `DATABASE_URL=${process.env.DATABASE_URL}` : null,
    process.env.DB_HOST ? `DB_HOST=${process.env.DB_HOST}` : null,
    process.env.DB_PORT ? `DB_PORT=${process.env.DB_PORT}` : null,
    process.env.DB_USER ? `DB_USER=${process.env.DB_USER}` : null,
    process.env.DB_PASSWORD ? `DB_PASSWORD=${process.env.DB_PASSWORD}` : null,
    process.env.DB_NAME ? `DB_NAME=${process.env.DB_NAME}` : null
  ]
    .filter(Boolean)
    .join('\\n');
  const envPath = path.join(__dirname, '.env');
  fs.writeFileSync(envPath, envOut, 'utf8');
  res.json({ saved: true, ariHost, webhookUrl: runtimeConfig.webhookUrl });
});

app.get('/health', (_req, res) => {
  const connected = !!(ari && ariReady);
  res.json({ ok: true, ariConnected: connected, dbConnected: !!pool });
});

app.listen(runtimeConfig.port, () => {
  console.log(`HTTP server listening on ${runtimeConfig.port}`);
});
