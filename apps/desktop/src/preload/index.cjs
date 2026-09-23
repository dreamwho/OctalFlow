const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dreamyoDesktop", Object.freeze({
    getRuntimeInfo: () => ipcRenderer.invoke("desktop:get-runtime-info"),
    getAppearance: () => ipcRenderer.invoke("desktop:get-appearance"),
    setAppearance: (theme) => ipcRenderer.invoke("desktop:set-appearance", theme),
    chooseDirectory: () => ipcRenderer.invoke("desktop:choose-directory"),
    openDataDirectory: () => ipcRenderer.invoke("desktop:open-data-directory"),
    prepareWebAccountImport: () => ipcRenderer.invoke("desktop:prepare-web-account-import"),
    beginWebAccountImport: (token) => ipcRenderer.send("desktop:begin-web-account-import", token),
    prepareWorkspaceOperation: (kind) => ipcRenderer.invoke("desktop:prepare-workspace-operation", kind),
    beginWorkspaceOperation: (token, password) => ipcRenderer.send("desktop:begin-workspace-operation", token, password),
    getAutoBackup: () => ipcRenderer.invoke("desktop:get-auto-backup"),
    configureAutoBackup: (password, intervalDays) => ipcRenderer.invoke("desktop:configure-auto-backup", password, intervalDays),
    disableAutoBackup: () => ipcRenderer.invoke("desktop:disable-auto-backup"),
    openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
    cloudStatus: () => ipcRenderer.invoke("desktop:cloud-status"),
    cloudStart: () => ipcRenderer.invoke("desktop:cloud-start"),
    cloudFinish: () => ipcRenderer.invoke("desktop:cloud-finish"),
    cloudLogout: () => ipcRenderer.invoke("desktop:cloud-logout"),
    cloudStorage: (action, input) => ipcRenderer.invoke("desktop:cloud-storage", action, input),
}));
