const path = require('node:path');
const {
  app: desktopApp,
  BrowserWindow,
  dialog,
  Notification,
  session,
  shell,
} = require('electron');

let apiServer;
let mainWindow;
let appUrl;
let saveDialogsConfigured = false;
let isClosingApi = false;
let apiHasClosed = false;

function openExternalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'mailto:') void shell.openExternal(url.href);
  } catch {
    // Ignora destinos que no sean URLs válidas.
  }
}

function configureSaveDialogs() {
  if (saveDialogsConfigured) return;
  saveDialogsConfigured = true;
  session.defaultSession.on('will-download', async (_event, item) => {
    const filename = path.basename(item.getFilename());
    const extension = path.extname(filename).slice(1).toLowerCase();
    const filters = extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : [];
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Guardar archivo de MagicPnP',
        defaultPath: path.join(desktopApp.getPath('downloads'), filename),
        filters,
      });
      if (result.canceled || !result.filePath) {
        item.cancel();
        return;
      }
      item.setSavePath(result.filePath);
      item.once('done', (_downloadEvent, state) => {
        if (state === 'completed' && Notification.isSupported()) {
          new Notification({
            title: 'MagicPnP',
            body: `Archivo guardado: ${path.basename(result.filePath)}`,
          }).show();
        }
      });
    } catch {
      item.cancel();
    }
  });
}

async function createWindow() {
  if (!appUrl) {
    const { register } = await import('tsx/esm/api');
    register();
    const api = await import('../apps/api/src/server.ts');
    apiServer = api.app;

    const webRoot = desktopApp.isPackaged
      ? path.join(process.resourcesPath, 'web')
      : path.resolve(__dirname, '../dist/web/browser');
    appUrl = await api.startDesktopServer(webRoot);
    configureSaveDialogs();
  }
  const appOrigin = new URL(appUrl).origin;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f4ef',
    webPreferences: {
      contextIsolation: true,
      devTools: !desktopApp.isPackaged,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== appOrigin) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  await mainWindow.loadURL(appUrl);
}

desktopApp.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('No se pudo iniciar MagicPnP', error instanceof Error ? error.message : String(error));
  desktopApp.quit();
});

desktopApp.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

desktopApp.on('window-all-closed', () => {
  if (process.platform !== 'darwin') desktopApp.quit();
});

desktopApp.on('before-quit', (event) => {
  if (!apiServer || apiHasClosed) return;
  event.preventDefault();
  if (isClosingApi) return;
  isClosingApi = true;
  void apiServer.close().finally(() => {
    apiHasClosed = true;
    desktopApp.quit();
  });
});
