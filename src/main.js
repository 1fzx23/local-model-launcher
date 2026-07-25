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
    httpGetFollow(config.manifestUrl, (res) => {
      if (res.statusCode !== 200) return resolve({ ok: false, reason: 'HTTP ' + res.statusCode });
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try {
          const remote = JSON.parse(body);
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
function httpGetFollow(url, onResponse, onError, headers = {}, depth = 0) {
  if (depth > 8) { onError(new Error('too many redirects')); return null; }
  const mod = url.startsWith('https') ? https : http;
  const req = mod.get(url, { headers: { 'User-Agent': 'LocalModelLauncher/1.0', ...headers } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, url).toString();
      httpGetFollow(next, onResponse, onError, headers, depth + 1);
    } else {
      onResponse(res);
    }
  });
  req.on('error', onError);
  req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
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

    const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : {};
    state.req = httpGetFollow(url, (res) => {
      if (res.statusCode === 416) { // range not satisfiable -> restart
        try { fs.unlinkSync(partPath); } catch (_) {}
        startByte = 0;
        activeDownloads.delete(id);
        return resolve(downloadFile(id, url, destPath));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        activeDownloads.delete(id);
        return resolve({ ok: false, reason: 'HTTP ' + res.statusCode });
      }
      if (res.statusCode === 200) startByte = 0; // server ignored range

      const total = startByte + (parseInt(res.headers['content-length'] || '0', 10) || 0);
      let received = startByte;
      let lastEmit = 0;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const ws = fs.createWriteStream(partPath, { flags: startByte > 0 ? 'a' : 'w' });

      res.on('data', (chunk) => {
        if (state.cancelled) { res.destroy(); ws.close(); return; }
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
          activeDownloads.delete(id);
          if (state.cancelled) return resolve({ ok: false, reason: 'cancelled', resumable: true });
          try {
            fs.renameSync(partPath, destPath);
            sendToWin('download-progress', { id, received, total, done: true });
            resolve({ ok: true });
          } catch (e) { resolve({ ok: false, reason: e.message }); }
        });
      });
      res.on('error', (e) => {
        ws.close();
        activeDownloads.delete(id);
        resolve({ ok: false, reason: e.message, resumable: true });
      });
    }, (err) => {
      activeDownloads.delete(id);
      resolve({ ok: false, reason: err.message, resumable: true });
    }, headers);
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

function waitForServer(port, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume(); resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(tick, 1200);
      });
      req.on('timeout', () => { req.destroy(); if (Date.now() - started > timeoutMs) resolve(false); else setTimeout(tick, 1200); });
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

  // Wait until HTTP is up, then tell renderer to load the web UI
  waitForServer(port).then((up) => {
    if (runningServers.get(port) && runningServers.get(port).proc === proc) {
      if (up) {
        const apiUrl = type === 'llm' ? `http://${config.apiHost || '127.0.0.1'}:${port}/v1` : null;
        sendToWin('server-status', {
          port, status: 'running', itemId: item.id,
          url: `http://127.0.0.1:${port}/`, name: item.name, type, apiUrl
        });
      } else {
        sendToWin('server-log', { port, line: `\x1b[31m[launcher]\x1b[0m 等待服务超时（模型可能仍在加载）\r\n` });
      }
    }
  });

  return { ok: true, port };
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
    if (runtime.gpu) args.push('-ngl', '99');
    if (config.threads > 0) args.push('-t', String(config.threads));
    if (config.apiHost) args.push('--host', config.apiHost);
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
    if (runtime.gpu) args.push('-ngl', '99');
    if (config.threads > 0) args.push('-t', String(config.threads));
    if (config.apiHost) args.push('--host', config.apiHost);
    args.push('-m', modelPath);
  }
  return launchAndTrack({ item, runtime, args, port, type: type || 'llm' });
}

// ---------------------------------------------------------------------------
// Local status scanning
// ---------------------------------------------------------------------------
function scanStatus() {
  const status = { models: {}, runtimes: {}, baseDirExists: fs.existsSync(config.baseDir) };
  for (const m of manifest.models) {
    const p = path.join(modelsDir(), m.file);
    const part = p + '.part';
    if (fs.existsSync(p)) {
      const missingExtra = (m.extraFiles || []).filter(ef => !fs.existsSync(path.join(modelsDir(), ef.file))).map(ef => ef.file);
      status.models[m.id] = { installed: missingExtra.length === 0, size: fs.statSync(p).size, missingExtra };
    } else if (fs.existsSync(part)) {
      status.models[m.id] = { installed: false, partial: fs.statSync(part).size };
    } else {
      status.models[m.id] = { installed: false };
    }
  }
  for (const r of manifest.runtimes) {
    status.runtimes[r.id] = { installed: fs.existsSync(path.join(config.baseDir, r.dir, r.exe)) };
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
    const source = entry.sources[sourceIndex || 0];
    if (!source || !source.url || source.url.startsWith('OTA')) {
      return { ok: false, reason: '该条目的下载地址待 OTA 清单更新，请在设置中刷新在线清单，或在官网页面手动下载' };
    }
    const result = await downloadFile(kind + ':' + id, source.url, dest);
    // Companion files (VAE / text encoders): download whatever is still missing
    if (result.ok && kind === 'model' && entry.extraFiles) {
      for (const ef of entry.extraFiles) {
        const efDest = path.join(modelsDir(), ef.file);
        if (fs.existsSync(efDest)) continue;
        const efSrc = ef.sources && ef.sources[0];
        if (!efSrc || !efSrc.url || efSrc.url.startsWith('OTA')) continue;
        sendToWin('download-progress', { id: kind + ':' + id, extraFile: ef.file });
        const r = await downloadFile(kind + ':' + id, efSrc.url, efDest);
        if (!r.ok) return { ok: false, reason: '附属文件下载失败(' + ef.file + '): ' + r.reason, status: scanStatus() };
      }
    }
    if (result.ok && kind === 'runtime') {
      sendToWin('download-progress', { id: kind + ':' + id, extracting: true });
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
    return { ...result, status: scanStatus() };
  });

  ipcMain.handle('cancel-download', (e, { id }) => {
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
    return { ok: true, status: scanStatus() };
  });

  ipcMain.handle('pick-base-dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    config.baseDir = r.filePaths[0];
    saveConfig();
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  loadConfig();
  loadBuiltinManifest();
  registerIpc();
  createWindow();
  // silent OTA check on startup
  fetchRemoteManifest().then((r) => { if (r.updated) sendToWin('manifest-updated', { version: r.version }); });
});

app.on('window-all-closed', () => { stopAllServers(); app.quit(); });
app.on('before-quit', stopAllServers);
