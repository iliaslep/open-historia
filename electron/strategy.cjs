// Isolated Windows/local strategy shell. No upstream auto-updater or payload loader.
const { app, BrowserWindow, dialog, shell, safeStorage, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
process.env.NODE_USE_ENV_PROXY ||= '1';

app.setName('Open Historia Strategy');
app.setPath('userData', path.join(app.getPath('appData'), 'Open Historia Strategy'));
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
const root = path.join(__dirname, '..');
const dataRoot = app.getPath('userData');
let window;
let server;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    app.setAppUserModelId('io.openhistoria.strategy.local');
    fs.mkdirSync(dataRoot, { recursive: true });
    window = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600, title: 'Open Historia Strategy',
      backgroundColor: '#111c29', autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="background:#111c29;color:#e5edf7;font:18px system-ui;padding:60px"><h1>Open Historia Strategy</h1><p>Подготовка карты при первом запуске. Сохранения остаются на вашем компьютере.</p><pre id="progress" style="white-space:pre-wrap">Проверка файлов…</pre></body>'));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'map-assets.json'), 'utf8'));
    const complete = () => manifest.assets.every((asset) => {
      try {
        const file = path.join(dataRoot, asset.path);
        if (fs.statSync(file).size !== asset.bytes) return false;
        return createHash('sha256').update(fs.readFileSync(file)).digest('hex') === asset.sha256;
      } catch { return false; }
    });
    while (!complete()) {
      const script = path.join(root.replace(/app\.asar$/, 'app.asar.unpacked'), 'scripts', 'fetch-map-assets.mjs');
      const child = spawn(process.execPath, [script], { cwd: dataRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_USE_ENV_PROXY: '1' }, windowsHide: true });
      let progress = '';
      const update = (chunk) => {
        progress = (progress + chunk.toString()).slice(-3000);
        if (!window.isDestroyed()) window.webContents.executeJavaScript(`document.getElementById('progress').textContent=${JSON.stringify(progress)}`).catch(() => {});
      };
      child.stdout.on('data', update); child.stderr.on('data', update);
      await once(child, 'exit');
      if (!complete()) {
        const result = await dialog.showMessageBox(window, { type: 'error', title: 'Карта не загружена', message: 'Для первой загрузки карты требуется Интернет. Контрольные суммы файлов проверяются автоматически.', buttons: ['Повторить', 'Закрыть'] });
        if (result.response === 1) { app.quit(); return; }
      }
    }
    process.env.OH_DATA_DIR = path.join(dataRoot, 'server', 'data');
    process.env.OH_ASSETS_DIR = path.join(dataRoot, 'public', 'assets');
    process.env.OH_HOST = '127.0.0.1';
    process.env.OH_VISIT_COUNT = '0';
    process.env.PORT = '0';
    const { configureChatGPTProtection, configureChatGPTTransport } = await import(pathToFileURL(path.join(root, 'server', 'chatgptPlan.js')).href);
    configureChatGPTTransport((input, options) => net.fetch(input, options));
    configureChatGPTProtection({
      seal: (text) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище Windows недоступно.');
        return safeStorage.encryptString(text);
      },
      open: (bytes) => safeStorage.decryptString(bytes),
    });
    ({ httpServer: server } = await import(pathToFileURL(path.join(root, 'server', 'server.js')).href));
    if (!server.listening) await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const external = (url) => { try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch { /* refuse invalid links */ } };
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) { event.preventDefault(); external(url); }
    });
    window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    await window.loadURL(origin + '/?strategy=1');
  }).catch((error) => { dialog.showErrorBox('Не удалось запустить игру', String(error.message)); app.quit(); });
  app.on('window-all-closed', () => { server?.close(); app.quit(); });
}
