const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  refreshManifest: () => ipcRenderer.invoke('refresh-manifest'),
  startServer: (itemId, runtimeId) => ipcRenderer.invoke('start-server', { itemId, runtimeId }),
  startCustom: (opts) => ipcRenderer.invoke('start-custom', opts),
  scanLocal: () => ipcRenderer.invoke('scan-local'),
  stopServer: (port) => ipcRenderer.invoke('stop-server', { port }),
  downloadItem: (kind, id, sourceIndex) => ipcRenderer.invoke('download-item', { kind, id, sourceIndex }),
  cancelDownload: (id) => ipcRenderer.invoke('cancel-download', { id }),
  deleteModel: (id) => ipcRenderer.invoke('delete-model', { id }),
  pickBaseDir: () => ipcRenderer.invoke('pick-base-dir'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openFolder: (sub) => ipcRenderer.invoke('open-folder', sub),

  onServerLog: (cb) => ipcRenderer.on('server-log', (e, d) => cb(d)),
  onServerStatus: (cb) => ipcRenderer.on('server-status', (e, d) => cb(d)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d)),
  onManifestUpdated: (cb) => ipcRenderer.on('manifest-updated', (e, d) => cb(d))
});
