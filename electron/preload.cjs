const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('app:info');

contextBridge.exposeInMainWorld('studybridge', {
  ...info,
  focus: () => ipcRenderer.invoke('app:focus'),
  setBadge: (n) => ipcRenderer.invoke('app:badge', n),
  keepInBackground: (on) => ipcRenderer.invoke('app:background', on),
  askMedia: () => ipcRenderer.invoke('media:ask'),
  saveFile: (name, bytes) => ipcRenderer.invoke('file:save', { name, bytes }),
  webFetch: (url, as = 'bytes') => ipcRenderer.invoke('web:fetch', { url, as }),
  saveConnector: () => ipcRenderer.invoke('connector:save'),
  openConnector: () => ipcRenderer.invoke('connector:open'),
  updates: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    apply: () => ipcRenderer.invoke('update:apply'),
    ok: () => ipcRenderer.invoke('update:ok'),
    onStatus: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:status', h);
      return () => ipcRenderer.removeListener('update:status', h);
    },
  },
  lockdown: {
    enter: (attemptId) => ipcRenderer.invoke('lockdown:enter', attemptId),
    exit: () => ipcRenderer.invoke('lockdown:exit'),
    onEvent: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('lockdown:event', h);
      return () => ipcRenderer.removeListener('lockdown:event', h);
    },
  },
});
