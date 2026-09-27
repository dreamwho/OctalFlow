const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dolaDesktop", Object.freeze({
  call: (action, payload) => ipcRenderer.invoke("dola:call", action, payload),
  browserBounds: (bounds) => ipcRenderer.send("dola:browser-bounds", bounds),
  onTask: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("dola:task", handler);
    return () => ipcRenderer.removeListener("dola:task", handler);
  },
}));
