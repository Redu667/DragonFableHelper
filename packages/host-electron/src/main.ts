import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const GAME_ORIGIN = 'https://play.dragonfable.com';
const DEV_SERVER = process.env.DFH_DEV_SERVER;

/**
 * The renderer is served from its own origin rather than `file://`.
 *
 * A `file://` page has the opaque origin "null", and a server response can
 * only be read across origins with credentials if it names the requesting
 * origin exactly - "*" is rejected the moment a cookie is involved. Since the
 * game's session rides on cookies, the page needs a real origin the CORS shim
 * below can echo. Registering the scheme as standard and secure also gives
 * the page localStorage, which is where the calibrated profile lives.
 */
const APP_SCHEME = 'app';
const APP_HOST = 'dfh';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const PAGE_ORIGIN = DEV_SERVER ? new URL(DEV_SERVER).origin : APP_ORIGIN;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

/** Where user scripts live on disk. */
const scriptsDir = () => path.join(app.getPath('userData'), 'scripts');
const rendererDir = () => path.join(__dirname, '../renderer');

/** Serve the built renderer bundle at app://dfh/... */
function serveRenderer(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    // Never let a path escape the bundle directory.
    relative = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(rendererDir(), relative);
    if (!file.startsWith(rendererDir())) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

/**
 * Let Ruffle talk to the game's server from our origin.
 *
 * Responses from the game host get CORS headers naming this page's origin,
 * with credentials allowed, so the movie's cookie-bearing requests succeed
 * and their bodies are readable (which is what the network tap depends on).
 * A preflight the game server does not understand is answered here with a
 * 204 instead of whatever error it returned.
 */
function allowGameRequests(): void {
  const filter = { urls: [`${GAME_ORIGIN}/*`] };

  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    // The server sees the game's own site as the caller, as it expects.
    const requestHeaders = { ...details.requestHeaders, Referer: `${GAME_ORIGIN}/`, Origin: GAME_ORIGIN };
    callback({ requestHeaders });
  });

  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const headers: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
      if (!/^access-control-/i.test(key)) headers[key] = Array.isArray(value) ? value : [String(value)];
    }
    headers['Access-Control-Allow-Origin'] = [PAGE_ORIGIN];
    headers['Access-Control-Allow-Credentials'] = ['true'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
    headers['Access-Control-Allow-Headers'] = ['Content-Type, X-Requested-With'];
    headers['Access-Control-Expose-Headers'] = ['Content-Type, Content-Length'];

    if (details.method === 'OPTIONS') {
      callback({ responseHeaders: headers, statusLine: 'HTTP/1.1 204 No Content' });
      return;
    }
    callback({ responseHeaders: headers });
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
    await window.loadURL(`${APP_ORIGIN}/index.html`);
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
  serveRenderer();
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
