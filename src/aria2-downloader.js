/*
 * aria2-downloader.js
 * Multi-connection downloader backed by aria2 (aria2c) over its JSON-RPC interface.
 *
 * Why aria2: it opens N parallel HTTP connections per file (--split / --max-connection-per-server),
 * which saturates bandwidth and ignores per-connection CDN throttling — dramatically faster than a
 * single stream. It also reports totalLength reliably even when the server sends chunked/gzipped
 * responses without a Content-Length header, so the progress bar is always accurate.
 *
 * This module has NO electron dependency (only node core + child_process) so it can be unit-tested
 * against a local loopback HTTP server. The host (main.js) wires progress to the renderer.
 *
 * Notes on file layout: we download into `destPath + '.part'` (so the existing `.part` semantics and
 * the renderer's partial/installed scanning keep working) and rename to `destPath` on completion.
 * aria2 keeps its own control file at `destPath + '.part.aria2'` for resume.
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let aria2Proc = null;
let aria2Token = null;
let aria2Port = 6800;
let aria2Ready = false;

// in-flight downloads: id -> { cancel() }
const activeMap = new Map();

// Resolve the aria2c binary location. In packaged app it lives under process.resourcesPath/aria2.
// ARIA2_BIN env override is handy for tests / custom builds.
function resolveAria2Bin() {
  if (process.env.ARIA2_BIN && fs.existsSync(process.env.ARIA2_BIN)) return process.env.ARIA2_BIN;
  const candidates = [
    path.join(process.resourcesPath || '', 'aria2', 'aria2c.exe'),
    path.join(__dirname, '..', 'resources', 'aria2', 'aria2c.exe'),
    'aria2c',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// JSON-RPC call. The secret token is always inserted as the first param.
function aria2Call(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 'lml', method,
      params: [('token:' + aria2Token), ...(params || [])],
    });
    const req = http.request({
      host: '127.0.0.1', port: aria2Port, path: '/jsonrpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message || 'aria2 error'));
          resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('aria2 rpc timeout')));
    req.write(body);
    req.end();
  });
}

function isAria2Ready() { return aria2Ready; }

// Spawn aria2c in RPC mode and wait until it answers. Returns true on success.
async function startAria2({ binPath, configDir, baseDir, port } = {}) {
  if (aria2Ready) return true;
  const bin = binPath || resolveAria2Bin();
  if (!bin) { console.error('[aria2] binary not found'); return false; }
  if (port) aria2Port = port;
  aria2Token = 'lml-' + crypto.randomBytes(8).toString('hex');
  const sessionFile = path.join(configDir || (process.env.APP_PATH || '.'), 'aria2.session');

  aria2Proc = spawn(bin, [
    '--enable-rpc',
    '--rpc-listen-all=false',
    '--rpc-listen-port=' + aria2Port,
    '--rpc-secret=' + aria2Token,
    '--continue=true',
    '--max-connection-per-server=16',
    '--split=16',
    '--min-split-size=1M',
    '--max-tries=5',
    '--retry-wait=3',
    '--timeout=30',
    '--connect-timeout=15',
    '--console-log-level=warn',
    '--dir=' + (baseDir || process.cwd()),
    '--save-session=' + sessionFile,
    '--save-session-interval=30',
    '--auto-save-interval=30',
    '--allow-overwrite=true',
    '--summary-interval=0',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });

  aria2Proc.on('exit', (code) => { aria2Proc = null; aria2Ready = false; if (code) console.warn('[aria2] exited', code); });
  aria2Proc.on('error', (e) => { aria2Proc = null; aria2Ready = false; console.error('[aria2] spawn error', e.message); });

  for (let i = 0; i < 60; i++) {
    try { await aria2Call('aria2.getVersion', []); aria2Ready = true; return true; }
    catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  console.error('[aria2] RPC did not start in time');
  try { if (aria2Proc) aria2Proc.kill(); } catch (_) {}
  aria2Proc = null;
  return false;
}

function stopAria2() {
  aria2Ready = false;
  if (aria2Proc) { try { aria2Proc.kill(); } catch (_) {} aria2Proc = null; }
}

/**
 * Download a file via aria2.
 * @param {object} o
 * @param {string} o.id            download id (used by caller to map progress/cancel)
 * @param {string[]} o.urls        ordered mirror URLs (aria2 tries them as mirrors)
 * @param {string} o.destPath      final destination (we write to destPath + '.part' meanwhile)
 * @param {function} [o.onProgress] called with {id,received,total,speed} periodically
 * @param {function} [o.onLog]     optional log callback
 * @returns {Promise<{ok:boolean, reason?:string, resumable?:boolean}>}
 */
function aria2Download({ id, urls, destPath, onProgress, onLog }) {
  return new Promise((resolve) => {
    const partPath = destPath + '.part';
    const dir = path.dirname(partPath);
    const out = path.basename(partPath);
    const ctrlPath = partPath + '.aria2';
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

    // If a stale .part from the OLD single-stream downloader exists (no aria2 control file),
    // drop it so aria2 starts clean instead of corrupting a mismatched partial.
    if (fs.existsSync(partPath) && !fs.existsSync(ctrlPath)) {
      try { fs.unlinkSync(partPath); } catch (_) {}
    }

    let settled = false;
    const state = { cancelled: false, gid: null };
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const log = (m) => { if (onLog) onLog(m); };

    (async () => {
      let gid;
      try {
        gid = await aria2Call('aria2.addUri', [[...urls], {
          dir, out,
          'max-connection-per-server': '16',
          split: '16',
          'min-split-size': '1M',
          continue: 'true',
          'allow-overwrite': 'true',
          'summary-interval': '0',
        }]);
        state.gid = gid;
        log('aria2 gid=' + gid);
      } catch (e) { activeMap.delete(id); return finish({ ok: false, reason: e.message, resumable: true }); }

      while (!settled) {
        if (state.cancelled) {
          try { await aria2Call('aria2.forceRemove', [gid]); } catch (_) {}
          activeMap.delete(id);
          return finish({ ok: false, reason: 'cancelled', resumable: true });
        }
        let st;
        try {
          st = await aria2Call('aria2.tellStatus', [gid, ['totalLength', 'completedLength', 'downloadSpeed', 'connections', 'status', 'errorMessage']]);
        } catch (e) {
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        const total = parseInt(st.totalLength || '0', 10) || 0;
        const received = parseInt(st.completedLength || '0', 10) || 0;
        const speed = parseInt(st.downloadSpeed || '0', 10) || 0;

        if (st.status === 'active' || st.status === 'waiting' || st.status === 'paused') {
          if (onProgress) onProgress({ id, received, total, speed });
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        if (st.status === 'complete') {
          try {
            if (fs.existsSync(partPath)) fs.renameSync(partPath, destPath);
            try { if (fs.existsSync(ctrlPath)) fs.unlinkSync(ctrlPath); } catch (_) {}
            if (onProgress) onProgress({ id, received: total, total, speed: 0, done: true });
            activeMap.delete(id);
            return finish({ ok: true });
          } catch (e) { activeMap.delete(id); return finish({ ok: false, reason: e.message }); }
        }
        if (st.status === 'error' || st.status === 'removed') {
          activeMap.delete(id);
          return finish({ ok: false, reason: st.errorMessage || '下载失败', resumable: true });
        }
        await new Promise(r => setTimeout(r, 300));
      }
    })();
    // expose cancellation handle for the caller
    activeMap.set(id, { cancel: () => { state.cancelled = true; } });
  });
}

// Request cancellation of an in-flight aria2 download (mirrors the old activeDownloads API).
async function cancelAria2Download(id) {
  const h = activeMap.get(id);
  if (h) { h.cancel(); return; }
}

module.exports = {
  resolveAria2Bin,
  isAria2Ready,
  startAria2,
  stopAria2,
  aria2Download,
  cancelAria2Download,
  aria2Call,
};
