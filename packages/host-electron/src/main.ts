import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const GAME_ORIGIN = 'https://play.dragonfable.com';
/** Path under the game origin that the app serves itself. Same as Android. */
const APP_PATH = '/__dfh/';
const APP_URL = `${GAME_ORIGIN}${APP_PATH}index.html`;
const DEV_SERVER = process.env.DFH_DEV_SERVER;

/** Where user scripts live on disk. */
const scriptsDir = () => path.join(app.getPath('userData'), 'scripts');
const rendererDir = () => path.join(__dirname, '../renderer');

/**
 * Serve the renderer from a path *on the game's own origin*.
 *
 * The page lives at https://play.dragonfable.com/__dfh/, exactly as the
 * Android shell and the DF Pocket app do it. Every request the game makes is
 * then same-origin: cookies are first-party, redirects behave as they would
 * on the real site, and nothing depends on the server sending CORS headers.
 * Serving the page from an app:// origin instead made each game request
 * cross-origin, and the loader could fail to fetch its engine.
 *
 * Only paths under {@link APP_PATH} are answered locally. Everything else,
 * the game's traffic included, goes to the network untouched.
 */
function serveUnderGameOrigin(): void {
  protocol.handle('https', (request) => {
    const url = new URL(request.url);
    if (url.origin === GAME_ORIGIN && url.pathname.startsWith(APP_PATH)) {
      return serveApp(url);
    }
    return passThrough(request, url);
  });
}

/** The page the official client runs on; what the game's requests cite. */
const GAME_PAGE = `${GAME_ORIGIN}/game/`;

/**
 * Send a request on to the network as the browser would have.
 *
 * Requests fetched from the main process lose the headers a page adds
 * itself, so game requests get the Referer and, for POSTs, the Origin that
 * the official play page sends. Redirects are followed here: Chromium does
 * not follow a 3xx handed back by a protocol handler, so the page sees the
 * final response under the URL it asked for.
 */
function passThrough(request: Request, url: URL): Promise<Response> {
  const options = { bypassCustomProtocolHandlers: true };
  if (url.origin !== GAME_ORIGIN) return net.fetch(request, options);

  const headers = new Headers(request.headers);
  if (!headers.has('referer')) headers.set('Referer', GAME_PAGE);
  if (request.method !== 'GET' && request.method !== 'HEAD' && !headers.has('origin')) {
    headers.set('Origin', GAME_ORIGIN);
  }
  const init: RequestInit & { duplex?: 'half' } = { headers };
  if (request.body) init.duplex = 'half';
  return net.fetch(new Request(request, init), options);
}

function serveApp(url: URL): Promise<Response> | Response {
  // In development the Vite server serves the same path (its base is /__dfh/).
  if (DEV_SERVER) {
    return net.fetch(new URL(url.pathname + url.search, DEV_SERVER).toString(), {
      bypassCustomProtocolHandlers: true,
    });
  }

  let relative = decodeURIComponent(url.pathname.slice(APP_PATH.length)) || 'index.html';
  // Never let a path escape the bundle directory.
  relative = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const root = rendererDir();
  const file = path.join(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) {
    return new Response('Not found', { status: 404 });
  }
  return net.fetch(pathToFileURL(file).toString());
}

/**
 * Present as the Chrome that Electron is, without the Electron and app
 * tokens. Some hosts treat unfamiliar user agents as bots.
 */
function useBrowserUserAgent(): void {
  const tokens = [/\sElectron\/\S+/g, new RegExp(`\\s${escapeRegExp(app.getName())}\\/\\S+`, 'g')];
  let agent = app.userAgentFallback;
  for (const token of tokens) agent = agent.replace(token, '');
  app.userAgentFallback = agent;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  await window.loadURL(APP_URL);
  if (DEV_SERVER) window.webContents.openDevTools({ mode: 'detach' });
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

useBrowserUserAgent();

void app.whenReady().then(async () => {
  serveUnderGameOrigin();
  registerScriptIpc();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
