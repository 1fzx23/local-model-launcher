/*
 * Local Model Launcher - Electron main process
 * - Spawns llama-server / sd-server as child processes, streams logs to renderer
 * - Downloads models & runtimes (resume supported) from ModelScope / GitHub / HF
 * - OTA-updatable catalog: remote manifest.json overrides the built-in one
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const aria2 = require('./aria2-downloader');

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------
// Portable exe: keep config next to the executable when possible, else userData
function getConfigDir() {
  try {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR; // set by electron-builder portable
    if (portableDir && fs.existsSync(portableDir)) return portableDir;
  } catch (_) {}
  return app.getPath('userData');
}

const DEFAULT_CONFIG = {
  manifestUrl: 'https://raw.githubusercontent.com/1fzx23/model-launcher-manifest/main/manifest.json',
  nPredict: 200,
  threads: 0,            // 0 = auto
  apiHost: '127.0.0.1'   // LLM API 监听地址：127.0.0.1 仅本机，0.0.0.0 含局域网
};

let config = { ...DEFAULT_CONFIG };
let configPath = null;

function loadConfig() {
  configPath = path.join(getConfigDir(), 'launcher-config.json');
  let loaded = {};
  try {
    if (fs.existsSync(configPath)) loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) { console.error('config load failed:', e); }
  // baseDir 默认放在 exe 同级 model-data，便于"只拷贝一个 exe"即可在别的电脑使用
  const defaultBase = path.join(getConfigDir(), 'model-data');
  config = { baseDir: defaultBase, ...DEFAULT_CONFIG, ...loaded };
}
function saveConfig() {
  try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) {}
}

function modelsDir() { return path.join(config.baseDir, 'models'); }

// ---------------------------------------------------------------------------
// Manifest (built-in + OTA remote override)
// ---------------------------------------------------------------------------
const BUILTIN_MANIFEST_PATH = path.join(__dirname, 'manifest.json');
let manifest = null;

function loadBuiltinManifest() {
  manifest = JSON.parse(fs.readFileSync(BUILTIN_MANIFEST_PATH, 'utf8'));
  // cached OTA manifest overrides builtin if newer version
  try {
    const cached = path.join(getConfigDir(), 'manifest-ota.json');
    if (fs.existsSync(cached)) {
      const remote = JSON.parse(fs.readFileSync(cached, 'utf8'));
      if ((remote.manifestVersion || 0) > (manifest.manifestVersion || 0)) manifest = remote;
    }
  } catch (_) {}
}

function fetchRemoteManifest() {
  return new Promise((resolve) => {
    if (!config.manifestUrl || config.manifestUrl.includes('YOUR_NAME')) return resolve({ ok: false, reason: 'manifest URL 未配置' });
    // 将 raw.githubusercontent.com 链接转换为 GitHub API 拉取，规避 raw CDN 缓存导致 OTA 长时间拿不到新版
    let url = config.manifestUrl;
    let fromApi = false;
    const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)$/);
    if (m) {
      fromApi = true;
      url = `https://api.github.com/repos/${m[1]}/${m[2]}/contents/${m[4]}?ref=${m[3]}`;
    }
    httpGetFollow(url, (res) => {
      if (res.statusCode !== 200) return resolve({ ok: false, reason: 'HTTP ' + res.statusCode });
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try {
          let remote;
          if (fromApi) {
            const j = JSON.parse(body);
            remote = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
          } else {
            remote = JSON.parse(body);
          }
          if ((remote.manifestVersion || 0) > (manifest.manifestVersion || 0)) {
            fs.writeFileSync(path.join(getConfigDir(), 'manifest-ota.json'), JSON.stringify(remote, null, 2));
            manifest = remote;
            resolve({ ok: true, updated: true, version: remote.manifestVersion });
          } else {
            resolve({ ok: true, updated: false, version: manifest.manifestVersion });
          }
        } catch (e) { resolve({ ok: false, reason: '解析失败: ' + e.message }); }
      });
    }, () => resolve({ ok: false, reason: '网络请求失败' }));
  });
}

// ---------------------------------------------------------------------------
// HTTP helper with redirect support
// ---------------------------------------------------------------------------
function httpGetFollow(url, onResponse, onError, headers = {}, depth = 0, onRequest = null) {
  if (depth > 8) { onError(new Error('too many redirects')); return null; }
  const mod = url.startsWith('https') ? https : http;
  const req = mod.get(url, { headers: { 'User-Agent': 'LocalModelLauncher/1.0', ...headers } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume(); // drain the redirect response body so the socket can be reused
      const next = new URL(res.headers.location, url).toString();
      httpGetFollow(next, onResponse, onError, headers, depth + 1, onRequest);
    } else {
      onResponse(res);
    }
  });
  req.on('error', onError);
  req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
  // keep the caller's `state.req` pointed at the *current* (possibly redirected) request,
  // otherwise cancelling would destroy an already-finished redirect request and do nothing.
  if (onRequest) onRequest(req);
  return req;
}

// ---------------------------------------------------------------------------
// Downloader with resume (.part files)
// ---------------------------------------------------------------------------
const activeDownloads = new Map(); // id -> { cancelled }

function sendToWin(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function downloadFile(id, url, destPath) {
  return new Promise((resolve) => {
    const partPath = destPath + '.part';
    let startByte = 0;
    try { if (fs.existsSync(partPath)) startByte = fs.statSync(partPath).size; } catch (_) {}

    const state = { cancelled: false, req: null };
    activeDownloads.set(id, state);

    // Guard so we only ever resolve once, and so a cancel that arrives as a
    // destroy() error can't be misreported as a generic failure (which would
    // make download-item fall through to the NEXT source and keep downloading).
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeDownloads.delete(id);
      resolve(result);
    };
    const onErr = (err) => {
      if (state.cancelled) return finish({ ok: false, reason: 'cancelled', resumable: true });
      finish({ ok: false, reason: err.message, resumable: true });
    };

    const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : {};
    state.req = httpGetFollow(url, (res) => {
      if (res.statusCode === 416) { // range not satisfiable -> restart from scratch
        try { fs.unlinkSync(partPath); } catch (_) {}
        startByte = 0;
        return finish(downloadFile(id, url, destPath));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        return finish({ ok: false, reason: 'HTTP ' + res.statusCode });
      }
      if (res.statusCode === 200) startByte = 0; // server ignored range -> full download

      const total = startByte + (parseInt(res.headers['content-length'] || '0', 10) || 0);
      let received = startByte;
      let lastEmit = 0;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const ws = fs.createWriteStream(partPath, { flags: startByte > 0 ? 'a' : 'w' });

      const abort = () => { try { ws.destroy(); } catch (_) {} try { res.destroy(); } catch (_) {} };

      res.on('data', (chunk) => {
        if (state.cancelled) { abort(); return finish({ ok: false, reason: 'cancelled', resumable: true }); }
        received += chunk.length;
        ws.write(chunk);
        const now = Date.now();
        if (now - lastEmit > 300) {
          lastEmit = now;
          sendToWin('download-progress', { id, received, total });
        }
      });
      res.on('end', () => {
        ws.end(() => {
          if (state.cancelled) return finish({ ok: false, reason: 'cancelled', resumable: true });
          try {
            fs.renameSync(partPath, destPath);
            invalidateStatusCache();
            sendToWin('download-progress', { id, received, total, done: true });
            finish({ ok: true });
          } catch (e) { finish({ ok: false, reason: e.message }); }
        });
      });
      res.on('error', onErr);
    }, onErr, headers, 0, (req) => { state.req = req; });
  });
}

// Extract zip using PowerShell (no extra deps)
function extractZip(zipPath, destDir) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`]);
    let err = '';
    ps.stderr.on('data', (d) => err += d);
    ps.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, reason: err || ('exit ' + code) }));
  });
}

// ---------------------------------------------------------------------------
// Server process management
// ---------------------------------------------------------------------------
let runningServers = new Map(); // port -> { proc, item }

function stopServer(port) {
  const entry = runningServers.get(port);
  if (!entry) return;
  try {
    spawn('taskkill', ['/PID', String(entry.proc.pid), '/T', '/F']);
  } catch (_) { try { entry.proc.kill(); } catch (__) {} }
  runningServers.delete(port);
  sendToWin('server-status', { port, status: 'stopped', itemId: entry.item.id });
}

function stopAllServers() { [...runningServers.keys()].forEach(stopServer); }

// Readiness probe.
//
// A naive "did we get any HTTP response?" check fires far too early: llama-server
// binds the port while the model is still loading and answers `/` with 503
// "Loading model". Announcing `running` at that point makes the UI open the
// embedded webview onto a 503 error page, which reads as "网页打不开" — and
// because the page *did* load (just with the wrong content), `did-fail-load`
// never fires, so the renderer's retry logic never kicks in either.
//
// So: treat only a real page response as ready, and treat an explicit
// "still loading" signal as "keep waiting".
function probeHttp(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: 2000, headers: { 'Accept': 'text/html' } },
      (res) => {
        const status = res.statusCode || 0;
        // Drain so the socket can be reused / process can exit cleanly.
        res.resume();
        if (status === 503 || status === 502 || status === 504) {
          resolve({ ready: false, loading: true, status });
          return;
        }
        // 2xx/3xx/401/403/404 all mean the HTTP server itself is up and
        // answering. A 404 on `/` still beats reporting ready for a dead port.
        resolve({ ready: status < 500, loading: false, status });
      }
    );
    req.on('error', () => resolve({ ready: false, loading: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ready: false, loading: false, status: 0 }); });
  });
}

function waitForServer(port, { timeoutMs = 300000, isAlive = () => true } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = async () => {
      if (!isAlive()) return resolve(false); // 进程已退出，立即停止等待（避免“假死”一直转圈）
      const { ready } = await probeHttp(port);
      if (ready) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, ready ? 1200 : 800);
    };
    tick();
  });
}

// Shared launcher: spawns a child process and tracks it, streaming logs & status.
async function launchAndTrack({ item, runtime, args, port, type }) {
  const runtimeDir = path.join(config.baseDir, runtime.dir);
  const exePath = path.join(runtimeDir, runtime.exe);
  if (!fs.existsSync(exePath)) return { ok: false, reason: '运行环境未安装: ' + runtime.name + '（请先下载）' };

  // one server per port
  if (runningServers.has(port)) stopServer(port);

  sendToWin('server-log', { port, line: `\x1b[36m[launcher]\x1b[0m 启动: ${runtime.exe} ${args.join(' ')}\r\n` });

  const proc = spawn(exePath, args, { cwd: runtimeDir, windowsHide: true });
  runningServers.set(port, { proc, item, type });
  sendToWin('server-status', { port, status: 'starting', itemId: item.id, name: item.name, type });

  const pipe = (stream) => stream.on('data', (d) => {
    sendToWin('server-log', { port, line: d.toString().replace(/\n/g, '\r\n') });
  });
  pipe(proc.stdout); pipe(proc.stderr);

  proc.on('close', (code) => {
    if (runningServers.get(port) && runningServers.get(port).proc === proc) {
      runningServers.delete(port);
      sendToWin('server-log', { port, line: `\x1b[33m[launcher]\x1b[0m 进程退出，代码 ${code}\r\n` });
      sendToWin('server-status', { port, status: 'stopped', itemId: item.id });
    }
  });

  // Wait until HTTP is up, then tell renderer to load the web UI.
  // SYCL / GPU 后端首次启动（内核 JIT 编译 + 模型加载）可能耗时数分钟，
  // 故按运行环境给足超时；进程退出则立即放弃，避免“假死”一直转圈。
  const timeoutMs = runtime.id === 'sycl' ? 600000
    : (runtime.gpu ? 300000 : 180000);
  const isAlive = () => runningServers.get(port) && runningServers.get(port).proc === proc;
  const hbTick = () => { if (isAlive()) sendToWin('server-log', { port, line: `\x1b[36m[launcher]\x1b[0m 模型仍在加载，请稍候…\r\n` }); };
  const hbFast = setTimeout(hbTick, 8000);      // 首次 8s 提示，避免长时间无反馈
  const hb = setInterval(hbTick, 30000);
  waitForServer(port, { timeoutMs, isAlive }).then((up) => {
    clearTimeout(hbFast); clearInterval(hb);
    if (!isAlive()) return; // 进程已退出，不再发 running
    if (up) {
      const apiUrl = type === 'llm' ? `http://${config.apiHost || '127.0.0.1'}:${port}/v1` : null;
      sendToWin('server-status', {
        port, status: 'running', itemId: item.id,
        url: `http://127.0.0.1:${port}/`, name: item.name, type, apiUrl
      });
    } else {
      sendToWin('server-log', { port, line: `\x1b[31m[launcher]\x1b[0m 等待服务超时（模型可能仍在加载）\r\n` });
    }
  });

  return { ok: true, port };
}

// Translate the "advanced options" (config.advanced) into llama-server launch flags.
// Only non-default values are emitted, so the launcher stays out of the way unless configured.
function pushAdvancedLLMArgs(args) {
  const a = config.advanced;
  if (!a) return;
  if (a.ctxSize) args.push('-c', String(a.ctxSize));
  if (a.batchSize) args.push('-b', String(a.batchSize));
  if (a.flashAttn && a.flashAttn !== 'auto') args.push('-fa', a.flashAttn);
  if (a.mlock) args.push('--mlock');
  if (a.noMmap) args.push('--no-mmap');
  if (a.reasoningBudget != null && a.reasoningBudget !== '') args.push('--reasoning-budget', String(a.reasoningBudget));
  if (a.parallel && Number(a.parallel) > 0) args.push('-np', String(a.parallel));
  if (a.contBatching === false) args.push('--no-cont-batching');
  if (a.apiKey) args.push('--api-key', a.apiKey);
  if (a.lookupCacheStatic) args.push('-lcs', a.lookupCacheStatic);
  if (a.lookupCacheDynamic) args.push('-lcd', a.lookupCacheDynamic);
}

async function startServer(item, runtimeId) {
  const port = item.port || 8080;

  const runtime = manifest.runtimes.find(r => r.id === (runtimeId || item.defaultRuntime));
  if (!runtime) return { ok: false, reason: '未找到运行环境: ' + runtimeId };

  const modelPath = path.join(modelsDir(), item.file);
  if (!fs.existsSync(modelPath)) return { ok: false, reason: '模型文件不存在: ' + item.file };

  // Check companion files (VAE / text encoders for SD3.5, FLUX, etc.)
  if (item.extraFiles) {
    for (const ef of item.extraFiles) {
      if (!fs.existsSync(path.join(modelsDir(), ef.file))) {
        return { ok: false, reason: '缺少附属文件: ' + ef.file + '（请点击下载，会自动补齐全部附属文件）' };
      }
    }
  }

  // Template placeholder expansion for custom args
  const expand = (s) => String(s)
    .replaceAll('{PORT}', String(port))
    .replaceAll('{MODEL}', modelPath)
    .replaceAll('{MODELS}', modelsDir());

  // Build args. IMPORTANT: for sd-server, -m must be the LAST flag before model path.
  let args = [];
  if (Array.isArray(item.args)) {
    // fully custom arg template (e.g. FLUX uses --diffusion-model instead of -m)
    args = item.args.map(expand);
  } else if (item.type === 'sd') {
    args = ['--listen-port', String(port)];
    if (item.extraArgs) args.push(...item.extraArgs.map(expand));
    args.push('-m', modelPath);
  } else {
    args = ['--port', String(port), '-n', String(config.nPredict || 200)];
    if (runtime.gpu) {
      if (config.advanced && config.advanced.gpuLayers) args.push('-ngl', String(config.advanced.gpuLayers));
      else args.push('-ngl', '99');
    }
    if (config.threads > 0) args.push('-t', String(config.threads));
    if (config.apiHost) args.push('--host', config.apiHost);
    // Multimodal: attach the vision projector (--mmproj) when the model declares one.
    if (item.mmproj) {
      const mp = path.join(modelsDir(), item.mmproj);
      if (!fs.existsSync(mp)) return { ok: false, reason: '缺少多模态投影文件: ' + item.mmproj + '（请先下载以补齐附属文件）' };
      args.push('--mmproj', mp);
    }
    pushAdvancedLLMArgs(args);
    args.push('-m', modelPath);
  }

  return launchAndTrack({ item, runtime, args, port, type: item.type });
}

// Launch a locally-discovered model file (not necessarily in the manifest)
async function startCustom({ file, runtimeId, type }) {
  const port = type === 'sd' ? 8081 : 8080;
  const runtime = manifest.runtimes.find(r => r.id === runtimeId);
  if (!runtime) return { ok: false, reason: '未找到运行环境: ' + runtimeId };

  const modelPath = path.join(modelsDir(), file);
  if (!fs.existsSync(modelPath)) return { ok: false, reason: '模型文件不存在: ' + file };

  const item = { id: 'local:' + file, name: path.basename(file) };
  let args = [];
  if (type === 'sd') {
    args = ['--listen-port', String(port), '-m', modelPath];
  } else {
    args = ['--port', String(port), '-n', String(config.nPredict || 200)];
    if (runtime.gpu) {
      if (config.advanced && config.advanced.gpuLayers) args.push('-ngl', String(config.advanced.gpuLayers));
      else args.push('-ngl', '99');
    }
    if (config.threads > 0) args.push('-t', String(config.threads));
    if (config.apiHost) args.push('--host', config.apiHost);
    pushAdvancedLLMArgs(args);
    args.push('-m', modelPath);
  }
  return launchAndTrack({ item, runtime, args, port, type: type || 'llm' });
}

// ---------------------------------------------------------------------------
// Local status scanning
// ---------------------------------------------------------------------------

// Caches for scanStatus(). The models dir can hold thousands of .gguf files and
// a cold scan does several thousand sync syscalls per model (exists + open +
// read + stat), which is what used to stall the first paint: get-state awaits
// this synchronously, so the window stayed blank until it finished.
//
// We only memoise existence/size per (path, mtime+size of the containing dir).
// Any create/delete/download-finish calls invalidateStatusCache() so the UI
// still updates immediately after an action.
let _existsCache = new Map();
let _dirStampCache = new Map();

function _dirStamp(dir) {
  // Cheap fingerprint of a directory's contents. If mtime/size changed, cached
  // entries under it are considered stale.
  try {
    const st = fs.statSync(dir);
    return st.mtimeMs + ':' + st.size;
  } catch (_) { return 'missing'; }
}

function invalidateStatusCache() {
  _existsCache.clear();
  _dirStampCache.clear();
}

function existsCached(p) {
  const dir = path.dirname(p);
  const stamp = _dirStamp(dir);
  const prev = _dirStampCache.get(dir);
  if (prev !== stamp) {
    // Directory changed: drop every cached entry that lived under it.
    for (const k of Array.from(_existsCache.keys())) {
      if (path.dirname(k) === dir) _existsCache.delete(k);
    }
    _dirStampCache.set(dir, stamp);
  }
  if (_existsCache.has(p)) return _existsCache.get(p);
  let ok = false, size = 0;
  try { const st = fs.statSync(p); ok = st.isFile(); size = st.size; } catch (_) { ok = false; }
  _existsCache.set(p, ok ? size : -1);
  return ok ? size : -1;
}

function scanStatus() {
  const status = { models: {}, runtimes: {}, baseDirExists: fs.existsSync(config.baseDir) };
  for (const m of manifest.models) {
    const p = path.join(modelsDir(), m.file);
    const part = p + '.part';
    const size = existsCached(p);
    if (size >= 0) {
      const missingExtra = (m.extraFiles || []).concat(m.mmproj ? [{ file: m.mmproj }] : [])
        .filter(ef => existsCached(path.join(modelsDir(), ef.file)) < 0).map(ef => ef.file);
      // Integrity guard: a model file that exists but isn't a valid GGUF (e.g. a truncated /
      // corrupt / 0xFF-filled leftover from an interrupted download) must NOT be reported as
      // "installed" — otherwise the launcher tries to load it and fails. Flag it corrupt so the
      // UI offers a re-download instead of a broken "启动" button.
      // Cache the magic check too: the file has not changed size, so re-reading the
      // header on every scan is wasted I/O.
      const pkey = p + '::magic';
      let corrupt = _existsCache.get(pkey);
      if (corrupt === undefined) {
        try {
          const fd = fs.openSync(p, 'r');
          const head = Buffer.alloc(4);
          corrupt = (fs.readSync(fd, head, 0, 4, 0) === 4) ? head.toString('latin1') !== 'GGUF' : false;
          fs.closeSync(fd);
        } catch (_) { corrupt = false; }
        _existsCache.set(pkey, corrupt);
      }
      status.models[m.id] = { installed: !corrupt && missingExtra.length === 0, size, missingExtra, corrupt };
    } else {
      const psize = existsCached(part);
      status.models[m.id] = psize >= 0
        ? { installed: false, partial: psize }
        : { installed: false };
    }
  }
  for (const r of manifest.runtimes) {
    status.runtimes[r.id] = { installed: existsCached(path.join(config.baseDir, r.dir, r.exe)) >= 0 };
  }
  return status;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('get-state', () => ({
    config, manifest, status: scanStatus(),
    running: [...runningServers.entries()].map(([port, e]) => ({
      port, itemId: e.item.id, name: e.item.name, type: e.type, status: 'running',
      url: `http://127.0.0.1:${port}/`,
      apiUrl: e.type === 'llm' ? `http://${config.apiHost || '127.0.0.1'}:${port}/v1` : null
    }))
  }));

  ipcMain.handle('save-config', (e, patch) => {
    config = { ...config, ...patch };
    saveConfig();
    return { ok: true, config };
  });

  ipcMain.handle('refresh-manifest', async () => {
    const r = await fetchRemoteManifest();
    return { ...r, manifest, status: scanStatus() };
  });

  ipcMain.handle('start-server', (e, { itemId, runtimeId }) => {
    const item = manifest.models.find(m => m.id === itemId);
    if (!item) return { ok: false, reason: 'unknown item' };
    return startServer(item, runtimeId);
  });

  ipcMain.handle('start-custom', (e, opts) => startCustom(opts || {}));

  // Scan the local model folder for .gguf / .safetensors files not necessarily in the manifest
  ipcMain.handle('scan-local', () => {
    const root = modelsDir();
    const found = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const en of entries) {
        const fp = path.join(dir, en.name);
        if (en.isDirectory()) { walk(fp); continue; }
        if (/\.(gguf|safetensors)$/i.test(en.name)) {
          const rel = path.relative(modelsDir(), fp).split(path.sep).join('/');
          const type = en.name.toLowerCase().endsWith('.gguf') ? 'llm' : 'sd';
          found.push({ file: rel, name: en.name, size: fs.statSync(fp).size, type });
        }
      }
    };
    if (fs.existsSync(root)) walk(root);
    const known = new Set(manifest.models.map(m => m.file));
    found.forEach(f => { f.known = known.has(f.file); });
    return { ok: true, dir: root, files: found };
  });

  ipcMain.handle('stop-server', (e, { port }) => { stopServer(port); return { ok: true }; });

  ipcMain.handle('download-item', async (e, { kind, id, sourceIndex }) => {
    let entry, dest;
    if (kind === 'model') {
      entry = manifest.models.find(m => m.id === id);
      if (!entry) return { ok: false, reason: 'unknown model' };
      dest = path.join(modelsDir(), entry.file);
    } else {
      entry = manifest.runtimes.find(r => r.id === id);
      if (!entry) return { ok: false, reason: 'unknown runtime' };
      dest = path.join(config.baseDir, '_downloads', entry.id + '.zip');
    }
    // only keep real (non-placeholder) sources; "OTA:" prefixed URLs are manual-only
    const sources = (entry.sources || []).filter(s => s && s.url && !s.url.startsWith('OTA'));
    if (!sources.length) {
      return { ok: false, reason: '该条目暂无可用的自动下载地址，请到模型/官网主页手动下载后放入模型目录' };
    }
    // preferred source first, then the rest (aria2 uses them as mirrors; fallback tries in order)
    const order = [];
    const startIdx = (Number.isInteger(sourceIndex) && sources[sourceIndex]) ? sourceIndex : 0;
    order.push(startIdx);
    for (let i = 0; i < sources.length; i++) if (i !== startIdx) order.push(i);
    const urls = order.map(i => sources[i].url);
    const dlId = kind + ':' + id;

    sendToWin('download-progress', { id: dlId, sourceLabel: sources[startIdx].label || ('源' + (startIdx + 1)), tryingSource: true });

    let result;
    if (aria2.isAria2Ready()) {
      // multi-connection download; aria2 handles mirror failover internally
      result = await aria2.aria2Download({
        id: dlId, urls,
        destPath: dest,
        onProgress: (p) => sendToWin('download-progress', p),
      });
    } else {
      // fallback: single-stream downloader, try each source in order
      let lastReason = '未知错误';
      for (const idx of order) {
        const source = sources[idx];
        if (idx !== startIdx) { try { fs.unlinkSync(dest + '.part'); } catch (_) {} }
        sendToWin('download-progress', { id: dlId, sourceLabel: source.label || ('源' + (idx + 1)), tryingSource: true });
        result = await downloadFile(dlId, source.url, dest);
        if (result.ok) break;
        lastReason = result.reason || lastReason;
        if (result.reason === 'cancelled') { result = { ok: false, reason: 'cancelled', resumable: true }; break; }
      }
      if (!result) result = { ok: false, reason: '所有下载源均失败（最后错误: ' + lastReason + '）' };
    }

    if (result.ok) {
      // Companion files (VAE / text encoders): download whatever is still missing
      if (kind === 'model' && entry.extraFiles) {
        for (const ef of entry.extraFiles) {
          const efDest = path.join(modelsDir(), ef.file);
          if (fs.existsSync(efDest)) continue;
          const efSrc = (ef.sources || []).find(s => s && s.url && !s.url.startsWith('OTA'));
          if (!efSrc) continue;
          sendToWin('download-progress', { id: dlId, extraFile: ef.file });
          const r = aria2.isAria2Ready()
            ? await aria2.aria2Download({ id: dlId, urls: [efSrc.url], destPath: efDest, onProgress: (p) => sendToWin('download-progress', p) })
            : await downloadFile(dlId, efSrc.url, efDest);
          if (!r.ok) invalidateStatusCache();
      return { ok: false, reason: '附属文件下载失败(' + ef.file + '): ' + r.reason, status: scanStatus() };
        }
      }
      if (kind === 'runtime') {
        sendToWin('download-progress', { id: dlId, extracting: true });
        const ex = await extractZip(dest, path.join(config.baseDir, entry.dir));
        try { fs.unlinkSync(dest); } catch (_) {}
        if (!ex.ok) return { ok: false, reason: '解压失败: ' + ex.reason };
        // some zips contain a nested folder; flatten if exe not at root
        const exeAt = path.join(config.baseDir, entry.dir, entry.exe);
        if (!fs.existsSync(exeAt)) {
          const root = path.join(config.baseDir, entry.dir);
          for (const sub of fs.readdirSync(root)) {
            const cand = path.join(root, sub, entry.exe);
            if (fs.existsSync(cand)) {
              for (const f of fs.readdirSync(path.join(root, sub))) {
                fs.renameSync(path.join(root, sub, f), path.join(root, f));
              }
              fs.rmdirSync(path.join(root, sub));
              break;
            }
          }
        }
      }
      invalidateStatusCache();
      return { ...result, status: scanStatus() };
    }
    if (result.reason === 'cancelled') return { ok: false, reason: 'cancelled', resumable: true };
    return { ok: false, reason: result.reason || '下载失败' };
  });

  ipcMain.handle('cancel-download', (e, { id }) => {
    aria2.cancelAria2Download(id); // no-op if not an aria2 download
    const st = activeDownloads.get(id);
    if (st) { st.cancelled = true; if (st.req) try { st.req.destroy(); } catch (_) {} }
    return { ok: true };
  });

  ipcMain.handle('delete-model', (e, { id }) => {
    const m = manifest.models.find(x => x.id === id);
    if (!m) return { ok: false };
    // never touch anything outside models dir; only exact file
    const p = path.join(modelsDir(), m.file);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (err) { return { ok: false, reason: err.message }; }
    try { if (fs.existsSync(p + '.part')) fs.unlinkSync(p + '.part'); } catch (_) {}
    try { if (fs.existsSync(p + '.part.aria2')) fs.unlinkSync(p + '.part.aria2'); } catch (_) {}
    invalidateStatusCache();
    return { ok: true, status: scanStatus() };
  });

  ipcMain.handle('pick-base-dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    config.baseDir = r.filePaths[0];
    saveConfig();
    invalidateStatusCache();
    return { ok: true, config, status: scanStatus() };
  });

  ipcMain.handle('open-external', (e, url) => { shell.openExternal(url); return { ok: true }; });
  ipcMain.handle('open-folder', (e, sub) => {
    const p = sub ? path.join(config.baseDir, sub) : config.baseDir;
    if (fs.existsSync(p)) shell.openPath(p);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: '本地 AI 模型启动器',
    show: false,               // show explicitly once the first paint lands (below)
    // Trims startup work: no devtools menu item, no background throttling while
    // the window is hidden, and no Chromium backgrounding. None of this affects
    // a model launcher, and each one is measurable in first-paint latency.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  // Paint the shell as soon as the DOM is ready instead of waiting for every
  // subresource (fonts, images). The model list is filled in right after via
  // refreshState(); the user sees the UI immediately either way, but a few
  // hundred ms earlier.
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  loadConfig();
  loadBuiltinManifest();
  registerIpc();
  createWindow();
  // 启动期非关键任务延迟到首屏渲染与首次模型扫描之后，避免子进程拉起 / 网络请求
  // 与首帧绘制、scanStatus 抢磁盘与 CPU，从而让窗口尽快可用。
  setTimeout(() => {
    // start aria2 RPC downloader (multi-connection, accurate progress). Non-fatal if it fails:
    // the single-stream fallback in download-item still works.
    aria2.startAria2({ configDir: getConfigDir(), baseDir: config.baseDir })
      .then((ok) => console.log('[aria2] ready=' + ok))
      .catch((e) => console.error('[aria2] start failed:', e.message));
    // silent OTA check on startup
    fetchRemoteManifest().then((r) => { if (r.updated) sendToWin('manifest-updated', { version: r.version }); });
  }, 400);
});

app.on('window-all-closed', () => { stopAllServers(); aria2.stopAria2(); app.quit(); });
app.on('before-quit', () => { stopAllServers(); aria2.stopAria2(); });
