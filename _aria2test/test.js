/*
 * Local loopback test for src/aria2-downloader.js
 * Serves a file over http://127.0.0.1 with Content-Length + Range support,
 * then drives a real aria2c.exe to download it and verifies the full path.
 * No external network needed.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mod = require('../src/aria2-downloader.js');

const BIN = path.resolve(__dirname, '..', 'resources/aria2/aria2c.exe');
const PORT = 6999;
const TMP = path.join(__dirname, '_aria2test');
fs.mkdirSync(TMP, { recursive: true });

// build a deterministic ~4MB payload
const SIZE = 4 * 1024 * 1024;
const payload = crypto.randomBytes(SIZE);
const shaOrig = crypto.createHash('sha256').update(payload).digest('hex');
console.log('payload bytes=%d sha256=%s', payload.length, shaOrig.slice(0, 12));

const server = http.createServer((req, res) => {
  const range = req.headers['range'];
  let start = 0, end = SIZE - 1;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    start = parseInt(m[1], 10);
    end = m[2] ? parseInt(m[2], 10) : SIZE - 1;
    if (end >= SIZE) end = SIZE - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'application/octet-stream',
    });
  } else {
    res.writeHead(200, {
      'Content-Length': SIZE,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    });
  }
  // throttle: ~32KB per 12ms (~2.7 MB/s) so the transfer spans multiple polls
  // and aria2 actually reports a positive downloadSpeed.
  let pos = start;
  const CHUNK = 32 * 1024, DELAY = 12;
  const tick = () => {
    if (pos > end) { res.end(); return; }
    const slice = payload.slice(pos, Math.min(pos + CHUNK, end + 1));
    pos += slice.length;
    res.write(slice);
    if (pos <= end) setTimeout(tick, DELAY); else res.end();
  };
  tick();
});

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); } console.log('ok -', msg); }

(async () => {
  process.env.ARIA2_BIN = BIN;
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log('local server on', PORT);

  const ready = await mod.startAria2({ configDir: TMP, baseDir: TMP, port: 6800 });
  assert(ready === true, 'aria2 RPC started');
  assert(mod.resolveAria2Bin() === BIN, 'binary resolved via ARIA2_BIN');

  const dest = path.join(TMP, 'out.bin');
  const part = dest + '.part';
  let last = null;
  const progressSeen = [];
  const r1 = await mod.aria2Download({
    id: 'test:1',
    urls: [`http://127.0.0.1:${PORT}/bigfile`],
    destPath: dest,
    onProgress: (p) => { last = p; progressSeen.push(p); },
  });
  assert(r1.ok === true, 'download ok');
  assert(fs.existsSync(dest) && !fs.existsSync(part), 'renamed .part -> dest, no leftover part');
  const dl = fs.readFileSync(dest);
  const shaDl = crypto.createHash('sha256').update(dl).digest('hex');
  assert(shaDl === shaOrig, 'downloaded bytes identical to source (sha256 match)');
  const hadTotal = progressSeen.some(p => p.total > 0);
  const hadSpeed = progressSeen.some(p => p.speed > 0);
  assert(hadTotal, 'progress reported total > 0 (accurate bar)');
  assert(hadSpeed, 'progress reported speed > 0');
  console.log('progress samples:', progressSeen.length, 'last=', JSON.stringify(last));

  // ---- resume test: cancel mid-flight on a fresh download ----
  const dest2 = path.join(TMP, 'out2.bin');
  const part2 = dest2 + '.part';
  let cancelled = false;
  // start, then cancel after a short delay
  const p2 = mod.aria2Download({
    id: 'test:2', urls: [`http://127.0.0.1:${PORT}/bigfile`], destPath: dest2,
    onProgress: () => {},
  });
  setTimeout(() => { mod.cancelAria2Download('test:2'); }, 300);
  const r2 = await p2;
  assert(r2.ok === false && r2.reason === 'cancelled', 'cancel mid-download returns cancelled');
  assert(fs.existsSync(part2), 'partial .part remains after cancel (resumable)');
  const partialSize = fs.statSync(part2).size;
  assert(partialSize > 0 && partialSize < SIZE, 'partial file is incomplete but non-empty');
  console.log('partial size after cancel:', partialSize, '/', SIZE);

  mod.stopAria2();
  server.close();
  console.log('\nALL TESTS PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; try { mod.stopAria2(); server.close(); } catch (_) {} });
