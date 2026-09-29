const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('app:info');

contextBridge.exposeInMainWorld('studybridge', {
  ...info,
  focus: () => ipcRenderer.invoke('app:focus'),
  setBadge: (n) => ipcRenderer.invoke('app:badge', n),
  keepInBackground: (on) => ipcRenderer.invoke('app:background', on),
  askMedia: () => ipcRenderer.invoke('media:ask'),
  saveFile: (name, bytes) => ipcRenderer.invoke('file:save', { name, bytes }),
  saveConnector: () => ipcRenderer.invoke('connector:save'),
  openConnector: () => ipcRenderer.invoke('connector:open'),
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
