const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronApp', {
  isDesktop: true,
  minimize: () => ipcRenderer.invoke('win:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('win:close'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('win:toggleAlwaysOnTop'),
  getWindowState: () => ipcRenderer.invoke('win:getState'),
  notifyUnread: (payload) => ipcRenderer.invoke('win:notifyUnread', payload),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),
  captureScreen: () => ipcRenderer.invoke('win:captureScreen'),
  captureDesktopPreview: (opts) => ipcRenderer.invoke('win:captureDesktopPreview', opts),
  onTriggerScreenCapture: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('win:triggerScreenCapture', handler);
    return () => ipcRenderer.removeListener('win:triggerScreenCapture', handler);
  },
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file?.path || '';
    }
  },
  onWindowStateChange: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('win:state', handler);
    return () => ipcRenderer.removeListener('win:state', handler);
  },
});
