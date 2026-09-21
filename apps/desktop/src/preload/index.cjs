const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dreamyoDesktop", Object.freeze({
    getRuntimeInfo: () => ipcRenderer.invoke("desktop:get-runtime-info"),
    chooseDirectory: () => ipcRenderer.invoke("desktop:choose-directory"),
    openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
}));
