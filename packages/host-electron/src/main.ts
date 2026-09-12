import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const GAME_ORIGIN = 'https://play.dragonfable.com';
const DEV_SERVER = process.env.DFH_DEV_SERVER;

/** Where user scripts live on disk. */
const scriptsDir = () => path.join(app.getPath('userData'), 'scripts');

/**
 * Let Ruffle fetch the game's assets.
 *
 * The renderer is not served from the game's origin, so the browser would
 * block the SWF and its assets as cross-origin. Rather than turning off
 * web security for the whole window, add permissive CORS headers to
 * responses from the game host only.
 */
function allowGameRequests(): void {
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${GAME_ORIGIN}/*`] }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    delete headers['access-control-allow-origin'];
    delete headers['Access-Control-Allow-Origin'];
    headers['Access-Control-Allow-Origin'] = ['*'];
    callback({ responseHeaders: headers });
  });

  // The game checks the referring page; present ourselves as the game site.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${GAME_ORIGIN}/*`] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders, Referer: `${GAME_ORIGIN}/`, Origin: GAME_ORIGIN };
    callback({ requestHeaders });
  });
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#14100f',
    title: 'DragonFableHelper',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // External links open in the real browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER) {
    await window.loadURL(DEV_SERVER);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    await window.loadFile(path.join(__dirname, '../../ui/dist/index.html'));
  }
}

/** Filesystem-backed script storage, exposed to the renderer over IPC. */
function registerScriptIpc(): void {
  const safePath = (id: string): string => {
    const name = path.basename(id);
    if (!name.endsWith('.js')) throw new Error('Scripts must be .js files');
    return path.join(scriptsDir(), name);
  };

  ipcMain.handle('scripts:list', async () => {
    const dir = scriptsDir();
    await fs.mkdir(dir, { recursive: true });
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.js'));
    return Promise.all(
      names.map(async (name) => ({
        id: name,
        name: name.replace(/\.js$/, ''),
        code: await fs.readFile(path.join(dir, name), 'utf8'),
      })),
    );
  });

  ipcMain.handle('scripts:write', async (_event, id: string, code: string) => {
    await fs.mkdir(scriptsDir(), { recursive: true });
    await fs.writeFile(safePath(id), code, 'utf8');
  });

  ipcMain.handle('scripts:remove', async (_event, id: string) => {
    await fs.rm(safePath(id), { force: true });
  });

  ipcMain.handle('scripts:dir', () => scriptsDir());
}

void app.whenReady().then(async () => {
  allowGameRequests();
  registerScriptIpc();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
