/**
 * HTTP layer. Deliberately dependency-free: node:http serves both the JSON API
 * and the static UI, so `npm install` is not a prerequisite for running this.
 *
 * Routes
 *   GET  /api/state          filtered/sorted board  (query params below)
 *   GET  /api/config         books, markets, thresholds, risk policy
 *   GET  /api/quota          upstream credit usage
 *   GET  /api/alerts         recent alerts
 *   GET  /api/history/:key   sample series for one line (sparkline / audit)
 *   GET  /api/events         Server-Sent Events: updates + alerts, live
 *   POST /api/refresh        force an upstream refresh (still quota-guarded)
 *   POST /api/estimate       set or clear your own probability for a selection
 *   POST /api/parlay/quote   parlay maths for a set of legs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, SPORTS, MARKETS, BOOK_TITLES, SHARP_BOOKS, PUBLIC_BOOKS, ROOT } from './config.js';
import { Scanner } from './scanner.js';
import { quoteParlay } from '../shared/parlay.js';

const scanner = new Scanner();

const STATIC_ROOTS = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Connected SSE clients. */
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

scanner.on('update', (snapshot) =>
  broadcast('update', {
    sport: snapshot.sport,
    fetchedAt: snapshot.fetchedAt,
    gameCount: snapshot.games.length,
    stale: Boolean(snapshot.stale),
    error: snapshot.error || null,
  }),
);
scanner.on('alerts', (alerts) => broadcast('alerts', alerts));
scanner.on('error', (err) => console.error('[scanner]', err.message));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    console.error('[server]', err);
    sendJson(res, 500, { error: err.message });
  }
});

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, scanner.view(parseViewParams(url.searchParams)));
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, {
      mode: scanner.mode,
      sports: SPORTS,
      markets: MARKETS,
      books: config.books.map((key) => ({
        key,
        title: BOOK_TITLES[key] || key,
        sharp: SHARP_BOOKS.includes(key),
        public: PUBLIC_BOOKS.includes(key),
      })),
      thresholds: config.thresholds,
      risk: config.risk,
      uiRefreshMs: config.uiRefreshMs,
      fetchIntervalMs: config.fetchIntervalMs,
      lookaheadDays: config.lookaheadDays,
      devigMethod: config.devigMethod,
      apiKeyConfigured: Boolean(config.apiKey),
    });
  }

  if (req.method === 'GET' && pathname === '/api/quota') {
    return sendJson(res, 200, scanner.client.snapshot());
  }

  if (req.method === 'GET' && pathname === '/api/alerts') {
    const limit = Number(url.searchParams.get('limit')) || 50;
    return sendJson(res, 200, { alerts: scanner.alerts.list(limit) });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/history/')) {
    const key = decodeURIComponent(pathname.slice('/api/history/'.length));
    const entry = scanner.history.get(key);
    if (!entry) return sendJson(res, 404, { error: 'No history for that line yet' });
    return sendJson(res, 200, entry);
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    return openEventStream(req, res);
  }

  if (req.method === 'POST' && pathname === '/api/refresh') {
    const body = await readJson(req);
    const sport = body.sport && SPORTS[body.sport] ? body.sport : null;
    const blocked = scanner.demo ? null : scanner.client.blockedReason();
    if (blocked) return sendJson(res, 429, { error: blocked, quota: scanner.client.snapshot() });

    if (sport) await scanner.refresh(sport, { force: true });
    else await scanner.refreshAll({ force: true });
    return sendJson(res, 200, scanner.view(parseViewParams(url.searchParams, sport || 'nfl')));
  }

  if (req.method === 'POST' && pathname === '/api/estimate') {
    const body = await readJson(req);
    if (!body.selKey) return sendJson(res, 400, { error: 'selKey is required' });
    try {
      const stored = scanner.setEstimate(body.selKey, body.probability ?? null);
      return sendJson(res, 200, { selKey: body.selKey, probability: stored });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/parlay/quote') {
    const body = await readJson(req);
    return sendJson(res, 200, quoteParlay({
      legs: Array.isArray(body.legs) ? body.legs : [],
      stake: Number(body.stake) || 0,
      bankroll: Number(body.bankroll) || config.risk.bankroll,
      kellyMultiplier: config.risk.kellyMultiplier,
      softCapPct: config.risk.softCapPct,
      hardCapPct: config.risk.hardCapPct,
    }));
  }

  return sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
}

/** Translate query params into Scanner.view() options. */
function parseViewParams(params, sportOverride = null) {
  const csv = (name) => {
    const raw = params.get(name);
    return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;
  };
  const numParam = (name) => {
    // Number(null) is 0, so an absent param would otherwise read as a real
    // threshold of 0% and quietly hide every non-positive-edge selection.
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const sport = sportOverride || params.get('sport') || 'nfl';
  return {
    sport: SPORTS[sport] ? sport : 'nfl',
    markets: csv('markets'),
    books: csv('books'),
    minEdgePct: numParam('minEdge'),
    highValueOnly: params.get('highValueOnly') === '1' || params.get('highValueOnly') === 'true',
    liveOnly: params.get('liveOnly') === '1' || params.get('liveOnly') === 'true',
    sort: params.get('sort') || 'edge',
    search: params.get('q') || '',
  };
}

function openEventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ mode: scanner.mode })}\n\n`);
  sseClients.add(res);

  // Comment frames keep proxies from closing an idle stream.
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* cleaned up on close */
    }
  }, 25_000);
  keepAlive.unref?.();

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  for (const { prefix, dir } of STATIC_ROOTS) {
    if (!pathname.startsWith(prefix)) continue;
    const relative = pathname.slice(prefix.length);
    const filePath = path.join(dir, relative);
    // Path traversal guard: the resolved file must stay inside its root.
    if (!filePath.startsWith(dir + path.sep) && filePath !== dir) continue;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;

    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // Nothing this API accepts is large; refuse anything that looks like abuse.
      if (raw.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/**
 * Was this module run directly, rather than imported by a test?
 *
 * `pathToFileURL` is the only correct way to ask. Pasting a path after
 * "file://" happens to work on macOS and Linux, where an absolute path already
 * starts with the slash the URL needs -- and fails everywhere else: on Windows
 * a path is "C:\dir\server.js", which needs a third slash, forward slashes and
 * a drive-letter form, so the comparison never matched and the server exited
 * silently without listening. It also breaks on any platform when a folder name
 * contains a space or other character a URL has to percent-encode.
 */
export function isEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(path.resolve(argv1)).href;
  } catch {
    return false;
  }
}

export { server, scanner };

/** Only start listening when run directly, so tests can import the app. */
if (isEntryPoint(import.meta.url)) {
  scanner.start();
  server.listen(config.port, config.host, () => {
    const where = `http://${config.host}:${config.port}`;
    console.log(`\n  Line Value Research  ->  ${where}`);
    console.log(`  mode: ${scanner.mode}${scanner.demo ? '  (no ODDS_API_KEY — serving simulated lines)' : ''}`);
    if (!scanner.demo) {
      console.log(`  upstream fetch every ${Math.round(config.fetchIntervalMs / 1000)}s`
        + ` (~${scanner.client.creditCost()} credits per sport per call)`);
    }
    console.log(`  UI refresh every ${Math.round(config.uiRefreshMs / 1000)}s\n`);
  });

  const shutdown = () => {
    scanner.stop();
    scanner.history.save();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
