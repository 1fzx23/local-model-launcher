/* Local Model Launcher — renderer logic */
let state = { config: {}, manifest: { models: [], runtimes: [] }, status: { models: {}, runtimes: {} }, running: [] };
let currentView = 'llm';
let downloads = {};   // id -> {received,total,extraFile}
let downloading = {}; // id -> true
let activeDockPort = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ------------------------------------------------------------------ flat SVG icons
const ICONS = {
  chat:     '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  image:    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  gear:     '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  search:   '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  folder:   '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.17a2 2 0 0 1 1.41.59l1.83 1.83A2 2 0 0 0 12.83 6H18"/>',
  refresh:  '<path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.36 2.64L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.36-2.64L3 16"/><path d="M3 21v-5h5"/>',
  globe:    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  panel:    '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>',
  arrowL:   '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  trash:    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  check:    '<polyline points="20 6 9 17 4 12"/>',
  layers:   '<polyline points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  stop:     '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  play:     '<polygon points="6 4 20 12 6 20 6 4"/>',
  copy:     '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
};
function svgIcon(name, cls, filled) {
  return `<svg class="ic ${cls || ''}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ------------------------------------------------------------------ utils
function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return n.toFixed(i >= 2 ? 2 : 0) + ' ' + u[i];
}
let toastTimer = null;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ------------------------------------------------------------------ render: cards
function renderCards() {
  const wrap = $('#cards');
  const q = ($('#search').value || '').toLowerCase();
  wrap.innerHTML = '';

  if (currentView === 'runtime') {
    for (const r of state.manifest.runtimes) {
      if (q && !(r.name + r.desc).toLowerCase().includes(q)) continue;
      wrap.appendChild(runtimeCard(r));
    }
    return;
  }
  const list = state.manifest.models.filter(m => m.type === (currentView === 'sd' ? 'sd' : 'llm'));
  for (const m of list) {
    if (q && !(m.name + m.desc + (m.tags || []).join('')).toLowerCase().includes(q)) continue;
    wrap.appendChild(modelCard(m));
  }
}

function modelCard(m) {
  const st = state.status.models[m.id] || {};
  const running = state.running.find(r => r.itemId === m.id);
  const dlId = 'model:' + m.id;
  const dl = downloads[dlId];

  const card = document.createElement('div');
  card.className = 'card' + (m.type === 'sd' ? ' sd' : '') + (running ? ' running' : '');

  const tags = (m.tags || []).map(t =>
    `<span class="tag${/内置|推荐/.test(t) ? ' hl' : ''}">${t}</span>`).join('');

  let ops = '';
  if (downloading[dlId]) {
    const pct = dl && dl.total ? Math.min(100, dl.received / dl.total * 100) : 0;
    const extra = dl && dl.extraFile ? `附属文件: ${dl.extraFile}` : '';
    ops = `
      <div class="progress-wrap grow">
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-text"><span>${extra || (dl ? fmtBytes(dl.received) + ' / ' + fmtBytes(dl.total) : '连接中…')}</span><span>${pct.toFixed(1)}%</span></div>
      </div>
      <button class="op-btn op-cancel" data-act="cancel" data-id="${m.id}">取消</button>`;
  } else if (running) {
    ops = `
      <button class="op-btn op-stop grow" data-act="stop" data-port="${running.port}">${svgIcon('stop')} 停止服务</button>
      <button class="op-btn op-link" data-act="focus" data-port="${running.port}" title="查看终端/网页">${svgIcon('terminal')}</button>`;
  } else if (st.installed) {
    const rtOptions = state.manifest.runtimes
      .filter(r => (m.type === 'sd') === r.exe.startsWith('sd'))
      .map(r => {
        const inst = (state.status.runtimes[r.id] || {}).installed;
        return `<option value="${r.id}" ${r.id === m.defaultRuntime ? 'selected' : ''} ${inst ? '' : 'disabled'}>${r.name}${inst ? '' : '（未安装）'}</option>`;
      }).join('');
    ops = `
      <select data-rt="${m.id}" title="选择运行环境">${rtOptions}</select>
      <button class="op-btn op-start grow" data-act="start" data-id="${m.id}">${svgIcon('play', '', true)} 启动</button>
      <button class="op-btn op-del" data-act="del" data-id="${m.id}" title="删除模型文件">${svgIcon('trash')}</button>`;
  } else {
    const srcOptions = (m.sources || []).map((s, i) => `<option value="${i}">${s.label}</option>`).join('');
    const partial = st.partial ? `（已下载 ${fmtBytes(st.partial)}，可续传）` : (st.missingExtra && st.missingExtra.length ? '（缺附属文件，点击补齐）' : '');
    ops = `
      <select data-src="${m.id}" title="选择下载源">${srcOptions}</select>
      <button class="op-btn op-down grow" data-act="download" data-id="${m.id}">${svgIcon('download')} 下载${partial}</button>
      ${m.page ? `<button class="op-btn op-link" data-act="page" data-url="${m.page}" title="打开模型主页">${svgIcon('external')}</button>` : ''}`;
  }

  card.innerHTML = `
    <div class="card-top">
      <div class="card-emoji">${m.type === 'sd' ? svgIcon('image') : svgIcon('chat')}</div>
      <div>
        <div class="card-title">${m.name}</div>
        <div class="card-size">${m.sizeText || ''}${st.installed ? ' · 已安装' : ''}${running ? ' · 端口 ' + running.port : ''}</div>
      </div>
    </div>
    <div class="card-desc">${m.desc || ''}</div>
    <div class="card-tags">${tags}</div>
    <div class="card-ops">${ops}</div>`;
  return card;
}

function runtimeCard(r) {
  const st = state.status.runtimes[r.id] || {};
  const dlId = 'runtime:' + r.id;
  const dl = downloads[dlId];
  const card = document.createElement('div');
  card.className = 'card';

  let ops = '';
  if (downloading[dlId]) {
    const pct = dl && dl.total ? Math.min(100, dl.received / dl.total * 100) : 0;
    ops = `
      <div class="progress-wrap grow">
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-text"><span>${dl && dl.extracting ? '解压中…' : (dl ? fmtBytes(dl.received) + ' / ' + fmtBytes(dl.total) : '连接中…')}</span><span>${pct.toFixed(1)}%</span></div>
      </div>
      <button class="op-btn op-cancel" data-act="cancel-rt" data-id="${r.id}">取消</button>`;
  } else if (st.installed) {
    ops = `<span class="tag hl">${svgIcon('check')} 已安装</span><span class="grow"></span>
      ${r.page ? `<button class="op-btn op-link" data-act="page" data-url="${r.page}">${svgIcon('external')} 官网</button>` : ''}`;
  } else {
    ops = `
      <button class="op-btn op-down grow" data-act="download-rt" data-id="${r.id}">${svgIcon('download')} 下载并安装</button>
      ${r.page ? `<button class="op-btn op-link" data-act="page" data-url="${r.page}">${svgIcon('external')}</button>` : ''}`;
  }

  card.innerHTML = `
    <div class="card-top">
      <div class="card-emoji">${svgIcon('gear')}</div>
      <div>
        <div class="card-title">${r.name}</div>
        <div class="card-size">${r.dir}</div>
      </div>
    </div>
    <div class="card-desc">${r.desc || ''}</div>
    <div class="card-tags">${r.gpu ? '<span class="tag">GPU</span>' : '<span class="tag">CPU</span>'}</div>
    <div class="card-ops">${ops}</div>`;
  return card;
}

// ------------------------------------------------------------------ render: running list
function renderRunning() {
  const wrap = $('#running-list');
  if (!state.running.length) { wrap.innerHTML = '<div class="rp-empty">暂无运行中的服务</div>'; return; }
  wrap.innerHTML = '';
  for (const r of state.running) {
    const div = document.createElement('div');
    div.className = 'run-item';
    let apiBox = '';
    if (r.type === 'llm' && r.status === 'running' && r.apiUrl) {
      apiBox = `
        <div class="ri-api">
          <span class="ri-api-label">API</span>
          <code class="ri-api-url">${r.apiUrl}</code>
          <button class="api-copy" data-act="copy-api" data-url="${r.apiUrl}" title="复制地址">${svgIcon('copy')}</button>
        </div>`;
    }
    div.innerHTML = `
      <div class="ri-top"><span class="dot ${r.status === 'running' ? 'green' : 'amber'}"></span>
        <span class="ri-name" title="${r.name}">${r.name}</span>
        <span class="ri-port">:${r.port}</span></div>
      ${apiBox}
      <div class="ri-ops">
        <button data-act="focus" data-port="${r.port}">终端</button>
        <button data-act="web" data-port="${r.port}">网页</button>
        <button class="stop" data-act="stop" data-port="${r.port}">停止</button>
      </div>`;
    wrap.appendChild(div);
  }
}

// ------------------------------------------------------------------ dock
const termBuffers = {}; // port -> html string
function ansiToHtml(s) {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/\x1b\[36m/g, '<span class="t-cyan">')
    .replace(/\x1b\[33m/g, '<span class="t-yellow">')
    .replace(/\x1b\[31m/g, '<span class="t-red">')
    .replace(/\x1b\[0m/g, '</span>')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n');
}
function appendTerm(port, line) {
  if (!termBuffers[port]) termBuffers[port] = '';
  termBuffers[port] += ansiToHtml(line);
  if (termBuffers[port].length > 300000) termBuffers[port] = termBuffers[port].slice(-200000);
  if (activeDockPort === port) {
    const t = $('#terminal');
    t.innerHTML = termBuffers[port];
    t.scrollTop = t.scrollHeight;
  }
}
function openDock(port, tab) {
  activeDockPort = port;
  $('#dock').classList.remove('collapsed');
  const run = state.running.find(r => r.port === port);
  $('#dock-name').textContent = run ? `${run.name}（端口 ${port}）` : `端口 ${port}`;
  $('#dock-status').className = 'dot ' + (run ? (run.status === 'running' ? 'green' : 'amber') : 'gray');
  const t = $('#terminal');
  t.innerHTML = termBuffers[port] || '<span class="t-cyan">[launcher]</span> 等待日志输出…\n';
  t.scrollTop = t.scrollHeight;
  if (run && run.url) {
    const wv = $('#webview');
    if (wv.getAttribute('src') !== run.url) wv.setAttribute('src', run.url);
    $('#web-url').value = run.url;
    $('#web-placeholder').classList.add('hidden');
  } else {
    $('#web-url').value = '';
    $('#web-placeholder').classList.remove('hidden');
  }
  switchDockTab(tab || 'term');
}
function switchDockTab(tab) {
  $$('.dock-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#pane-term').classList.toggle('hidden', tab !== 'term');
  $('#pane-web').classList.toggle('hidden', tab !== 'web');
}

// ------------------------------------------------------------------ actions
async function refreshState() {
  state = await window.api.getState();
  // enrich running with last known status/url
  renderAll();
}
function renderAll() { renderCards(); renderRunning(); }

async function doStart(id) {
  const sel = document.querySelector(`select[data-rt="${id}"]`);
  const rt = sel ? sel.value : undefined;
  const r = await window.api.startServer(id, rt);
  if (!r.ok) { toast('启动失败：' + r.reason); return; }
  toast('正在启动服务（端口 ' + r.port + '），模型加载可能需要一会儿…');
  const item = state.manifest.models.find(m => m.id === id);
  state.running = state.running.filter(x => x.port !== r.port);
  state.running.push({ port: r.port, itemId: id, name: item ? item.name : id, status: 'starting' });
  renderAll();
  openDock(r.port, 'term');
}

async function doDownload(kind, id) {
  const dlId = kind + ':' + id;
  let srcIdx = 0;
  const sel = document.querySelector(`select[data-src="${id}"]`);
  if (sel) srcIdx = parseInt(sel.value, 10) || 0;
  downloading[dlId] = true;
  downloads[dlId] = null;
  renderCards();
  const r = await window.api.downloadItem(kind, id, srcIdx);
  delete downloading[dlId];
  delete downloads[dlId];
  if (r.status) state.status = r.status;
  if (r.ok) toast('下载完成');
  else if (r.reason !== 'cancelled') toast('下载失败：' + (r.reason || '未知错误') + (r.resumable ? '（已保留进度，可续传）' : ''));
  await refreshState();
}

// ------------------------------------------------------------------ local discover
async function doScanLocal() {
  const r = await window.api.scanLocal();
  if (!r.ok) { toast('扫描失败'); return; }
  $('#discover-dir').textContent = r.dir;
  renderDiscover(r.files);
}
function renderDiscover(files) {
  const wrap = $('#discover-cards');
  wrap.innerHTML = '';
  if (!files.length) { wrap.innerHTML = '<div class="rp-empty">未在模型文件夹中找到 .gguf / .safetensors 文件</div>'; return; }
  for (const f of files) {
    const card = document.createElement('div');
    card.className = 'card' + (f.type === 'sd' ? ' sd' : '');
    const rtOptions = state.manifest.runtimes
      .filter(r => (f.type === 'sd') === r.exe.startsWith('sd'))
      .map(r => {
        const inst = (state.status.runtimes[r.id] || {}).installed;
        return `<option value="${r.id}" ${inst ? '' : 'disabled'}>${r.name}${inst ? '' : '（未安装）'}</option>`;
      }).join('');
    const running = state.running.find(x => x.itemId === 'local:' + f.file);
    let ops;
    if (running) {
      ops = `<button class="op-btn op-stop grow" data-act="stop" data-port="${running.port}">${svgIcon('stop')} 停止服务</button>`;
    } else {
      ops = `
        <select data-crt="${f.file}" title="选择运行环境">${rtOptions}</select>
        <button class="op-btn op-start grow" data-act="start-custom" data-file="${f.file}" data-type="${f.type}">${svgIcon('play', '', true)} 启动</button>`;
    }
    card.innerHTML = `
      <div class="card-top">
        <div class="card-emoji">${f.type === 'sd' ? svgIcon('image') : svgIcon('chat')}</div>
        <div>
          <div class="card-title">${f.name}${f.known ? ' <span class="tag hl">清单已有</span>' : ''}</div>
          <div class="card-size">${f.file} · ${fmtBytes(f.size)}</div>
        </div>
      </div>
      <div class="card-ops">${ops}</div>`;
    wrap.appendChild(card);
  }
}
async function doStartCustom(file, type) {
  const sel = document.querySelector(`select[data-crt="${file}"]`);
  const rt = sel ? sel.value : undefined;
  const r = await window.api.startCustom({ file, runtimeId: rt, type });
  if (!r.ok) { toast('启动失败：' + r.reason); return; }
  toast('正在启动本地模型（端口 ' + r.port + '）…');
  state.running = state.running.filter(x => x.port !== r.port);
  state.running.push({ port: r.port, itemId: 'local:' + file, name: file, status: 'starting', type });
  renderAll();
  openDock(r.port, 'term');
}

// ------------------------------------------------------------------ event wiring
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const act = btn.dataset.act;
  if (!act) return;
  switch (act) {
    case 'start': return doStart(btn.dataset.id);
    case 'stop': {
      await window.api.stopServer(parseInt(btn.dataset.port, 10));
      toast('已停止服务');
      return refreshState();
    }
    case 'download': return doDownload('model', btn.dataset.id);
    case 'download-rt': return doDownload('runtime', btn.dataset.id);
    case 'start-custom': return doStartCustom(btn.dataset.file, btn.dataset.type);
    case 'copy-api': {
      const u = btn.dataset.url;
      if (navigator.clipboard) navigator.clipboard.writeText(u).then(() => toast('已复制 API 地址')).catch(() => {});
      return;
    }
    case 'cancel': return window.api.cancelDownload('model:' + btn.dataset.id);
    case 'cancel-rt': return window.api.cancelDownload('runtime:' + btn.dataset.id);
    case 'del': {
      if (!confirm('确定删除该模型文件吗？（仅删除该 gguf/safetensors 文件本身）')) return;
      const r = await window.api.deleteModel(btn.dataset.id);
      if (r.status) state.status = r.status;
      toast(r.ok ? '已删除' : '删除失败：' + (r.reason || ''));
      return renderCards();
    }
    case 'focus': return openDock(parseInt(btn.dataset.port, 10), 'term');
    case 'web': return openDock(parseInt(btn.dataset.port, 10), 'web');
    case 'page': return window.api.openExternal(btn.dataset.url);
  }
});

// nav
$$('.nav-btn').forEach(b => b.addEventListener('click', () => {
  $$('.nav-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  currentView = b.dataset.view;
  const isSettings = currentView === 'settings';
  const isDiscover = currentView === 'discover';
  $('#view-settings').classList.toggle('hidden', !isSettings);
  $('#view-library').classList.toggle('hidden', isSettings || isDiscover);
  $('#view-discover').classList.toggle('hidden', !isDiscover);
  if (isSettings) {
    $('#set-basedir').value = state.config.baseDir || '';
    $('#set-manifest').value = state.config.manifestUrl || '';
    $('#set-apihost').value = state.config.apiHost || '127.0.0.1';
    $('#set-npredict').value = state.config.nPredict ?? 200;
    $('#set-threads').value = state.config.threads ?? 0;
    $('#manifest-ver').textContent = state.manifest.manifestVersion || '-';
  } else if (isDiscover) {
    $('#discover-dir').textContent = (state.config.baseDir || '') + '\\models';
  } else {
    $('#lib-title').textContent = { llm: '对话模型', sd: '文生图模型', runtime: '运行环境' }[currentView];
    renderCards();
  }
}));

$('#search').addEventListener('input', renderCards);
$('#btn-open-dir').addEventListener('click', () => window.api.openFolder('models'));
$('#btn-refresh-manifest').addEventListener('click', async () => {
  toast('正在检查清单更新…');
  const r = await window.api.refreshManifest();
  if (r.manifest) state.manifest = r.manifest;
  if (r.status) state.status = r.status;
  renderAll();
  toast(r.ok ? (r.updated ? '清单已更新到 v' + r.version : '已是最新版本（v' + r.version + '）') : '更新失败：' + r.reason);
});

// settings
$('#btn-pick-dir').addEventListener('click', async () => {
  const r = await window.api.pickBaseDir();
  if (r.ok) { state.config = r.config; state.status = r.status; $('#set-basedir').value = r.config.baseDir; renderAll(); toast('目录已切换'); }
});
$('#btn-scan-local').addEventListener('click', doScanLocal);
$('#btn-save-manifest').addEventListener('click', async () => {
  const r = await window.api.saveConfig({ manifestUrl: $('#set-manifest').value.trim() });
  state.config = r.config; toast('已保存 OTA 清单地址');
});
$('#btn-save-apihost').addEventListener('click', async () => {
  const r = await window.api.saveConfig({ apiHost: $('#set-apihost').value.trim() || '127.0.0.1' });
  state.config = r.config; toast('已保存，下次启动对话模型生效');
});
$('#btn-save-npredict').addEventListener('click', async () => {
  const r = await window.api.saveConfig({ nPredict: parseInt($('#set-npredict').value, 10) || 200 });
  state.config = r.config; toast('已保存');
});
$('#btn-save-threads').addEventListener('click', async () => {
  const r = await window.api.saveConfig({ threads: parseInt($('#set-threads').value, 10) || 0 });
  state.config = r.config; toast('已保存');
});

// dock
$$('.dock-tab').forEach(b => b.addEventListener('click', () => switchDockTab(b.dataset.tab)));
$('#dock-toggle').addEventListener('click', () => $('#dock').classList.toggle('collapsed'));
$('#web-reload').addEventListener('click', () => { try { $('#webview').reload(); } catch (_) {} });
$('#web-back').addEventListener('click', () => { try { $('#webview').goBack(); } catch (_) {} });
$('#web-external').addEventListener('click', () => { const u = $('#web-url').value; if (u) window.api.openExternal(u); });

// webview: 优雅处理「返回的是 API 接口 JSON / 纯文本」而非网页的情况
(() => {
  const wv = $('#webview');
  const loading = $('#web-loading');
  const fb = $('#web-fallback');
  const showFallback = (msg) => { loading.classList.add('hidden'); fb.innerHTML = msg; fb.classList.remove('hidden'); };
  wv.addEventListener('did-start-loading', () => { loading.classList.remove('hidden'); fb.classList.add('hidden'); });
  wv.addEventListener('did-stop-loading', async () => {
    loading.classList.add('hidden');
    try {
      const ct = await wv.executeJavaScript('(document.contentType||"text/html").toLowerCase()');
      if (ct && !ct.includes('text/html')) {
        const run = state.running.find(r => r.port === activeDockPort);
        const api = (run && run.apiUrl) ? run.apiUrl : `http://127.0.0.1:${activeDockPort}/v1`;
        showFallback(`这里显示的是模型服务的 <b>API 接口原始返回</b>（不是网页界面）。<br>请在左侧「运行中服务」里复制 API 地址 <code>${api}</code>，填到其它 AI 软件中调用。`);
      }
    } catch (_) { fb.classList.add('hidden'); }
  });
  wv.addEventListener('did-fail-load', () => {
    showFallback('网页加载失败：服务可能还在启动，或该运行环境不提供网页界面。可点上方「刷新」按钮重试，或复制 API 地址在其它 AI 软件中使用。');
  });
})();

// dock resizer
(() => {
  const dock = $('#dock');
  const rz = $('#dock-resizer');
  let dragging = false;
  rz.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = window.innerWidth - e.clientX;
    dock.style.width = Math.max(380, Math.min(window.innerWidth * .72, w)) + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
})();

// ------------------------------------------------------------------ ipc listeners
window.api.onServerLog((d) => appendTerm(d.port, d.line));
window.api.onServerStatus((d) => {
  if (d.status === 'stopped') {
    state.running = state.running.filter(r => r.port !== d.port);
    if (activeDockPort === d.port) { $('#dock-status').className = 'dot gray'; }
  } else {
    let run = state.running.find(r => r.port === d.port);
    if (!run) { run = { port: d.port, itemId: d.itemId, name: d.name || d.itemId }; state.running.push(run); }
    run.status = d.status;
    if (d.type) run.type = d.type;
    if (d.url) run.url = d.url;
    if (d.apiUrl) run.apiUrl = d.apiUrl;
    if (d.status === 'running' && d.url) {
      toast((d.name || '服务') + ' 已就绪，网页界面已加载');
      if (activeDockPort === d.port || activeDockPort === null) openDock(d.port, 'web');
    }
  }
  renderAll();
});
window.api.onDownloadProgress((d) => {
  downloads[d.id] = { ...(downloads[d.id] || {}), ...d };
  if (downloading[d.id]) {
    // lightweight update: re-render only progress bars
    renderCards();
  }
});
window.api.onManifestUpdated((d) => {
  $('#ota-badge').classList.remove('hidden');
  refreshState();
});

// init
refreshState();
