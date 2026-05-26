// Agentic Engineering Workspace — top-bar / Quick Settings indicator
// for the agent-workspace dashboard server.
//
// Targets GNOME Shell 45-50 (ES-module extension API). Two UI modes
// (selected in preferences):
//   - "quick-settings": a QuickMenuToggle in GNOME's Quick Settings
//     panel, plus a small status icon in the top bar (like Wi-Fi /
//     Bluetooth).
//   - "panel": a classic top-bar PanelMenu.Button with a popup menu.
//
// Running-state detection prefers /proc/net/tcp{,6} LISTEN entries on
// the configured port — this is authoritative even when the pidfile
// is stale (e.g. a failed second start clobbered a good pidfile while
// the real server is still bound).

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {
  QuickMenuToggle, SystemIndicator,
} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const DEFAULT_PORT = 8765;
const POLL_INTERVAL_SEC = 5;

// Mirror of agent_workspace._default_cache_dir() for Linux. (macOS
// and Windows paths are intentionally omitted: GNOME Shell only runs
// on Linux.)
function cacheDir() {
  const xdg = GLib.getenv('XDG_CACHE_HOME');
  if (xdg && xdg.length > 0)
    return GLib.build_filenamev([xdg, 'agent-workspace']);
  return GLib.build_filenamev([GLib.get_home_dir(), '.cache', 'agent-workspace']);
}

function effectivePort(settings) {
  const fromEnv = GLib.getenv('AGENT_WORKSPACE_PORT');
  const envN = fromEnv ? parseInt(fromEnv, 10) : NaN;
  if (Number.isFinite(envN) && envN > 0) return envN;
  const setN = settings?.get_int('port');
  if (Number.isFinite(setN) && setN > 0) return setN;
  return DEFAULT_PORT;
}

function pidfilePath(p) {
  return GLib.build_filenamev([cacheDir(), `server.${p}.pid`]);
}

function dashboardUrl(p) {
  return `http://127.0.0.1:${p}/`;
}

function readPid(path) {
  if (!GLib.file_test(path, GLib.FileTest.EXISTS))
    return null;
  try {
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok) return null;
    const text = new TextDecoder().decode(contents).trim();
    const pid = parseInt(text, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_e) {
    return null;
  }
}

function processAlive(pid) {
  if (!pid) return false;
  return GLib.file_test(`/proc/${pid}`, GLib.FileTest.IS_DIR);
}

// Authoritative "is a server bound on this port?" via /proc/net/tcp.
// Survives stale pidfiles caused by failed restarts (where Python
// died with EADDRINUSE but a previous wrapper had already overwritten
// the pidfile).
function listenersOnPort(p) {
  const portHex = p.toString(16).toUpperCase().padStart(4, '0');
  for (const procPath of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const [ok, contents] = GLib.file_get_contents(procPath);
      if (!ok) continue;
      const text = new TextDecoder().decode(contents);
      const lines = text.split('\n');
      for (let i = 1; i < lines.length; i++) {
        const fields = lines[i].trim().split(/\s+/);
        if (fields.length < 4) continue;
        const local = fields[1];   // e.g. "0100007F:223D"
        const state = fields[3];   // "0A" = LISTEN
        if (state !== '0A') continue;
        const colon = local.lastIndexOf(':');
        if (colon < 0) continue;
        if (local.slice(colon + 1) === portHex) return true;
      }
    } catch (_e) {}
  }
  return false;
}

// Fallback PID lookup for Stop when the pidfile is stale: walk
// /proc/*/cmdline looking for the agent_workspace.py invocation that
// owns this port.
function findServerPidByCmdline(targetPort) {
  let pid = null;
  let dir = null;
  try {
    dir = GLib.Dir.open('/proc', 0);
    let name;
    while ((name = dir.read_name()) !== null) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const [ok, contents] = GLib.file_get_contents(`/proc/${name}/cmdline`);
        if (!ok || contents.length === 0) continue;
        const text = new TextDecoder().decode(contents);
        if (!text.includes('agent_workspace.py')) continue;
        const args = text.split('\0').filter(s => s.length > 0);
        let p = DEFAULT_PORT;
        for (let i = 0; i < args.length; i++) {
          if ((args[i] === '--port' || args[i] === '-p') && i + 1 < args.length) {
            const n = parseInt(args[i + 1], 10);
            if (Number.isFinite(n) && n > 0) p = n;
          } else if (args[i].startsWith('--port=')) {
            const n = parseInt(args[i].slice(7), 10);
            if (Number.isFinite(n) && n > 0) p = n;
          }
        }
        if (p === targetPort) {
          pid = parseInt(name, 10);
          break;
        }
      } catch (_e) {}
    }
  } catch (_e) {
  } finally {
    try { dir?.close(); } catch (_e) {}
  }
  return pid;
}

// Locate the installed Agentic Workspace PWA so "Open dashboard" launches
// the standalone window instead of a normal browser tab. Matches a
// .desktop whose Name equals the manifest's name/short_name and whose
// Exec is a Chromium app-mode invocation. Returns null if not installed.
function findInstalledPwa() {
  const wanted = new Set([
    'Agentic Engineering Workspace',
    'Agentic Workspace',
  ]);
  for (const info of Gio.AppInfo.get_all()) {
    if (!(info instanceof Gio.DesktopAppInfo)) continue;
    if (!wanted.has(info.get_name() || '')) continue;
    const exec = info.get_commandline() || '';
    if (exec.includes('--app-id=') || exec.includes('--app=')) return info;
  }
  return null;
}

function spawnDetached(argv) {
  try {
    const proc = new Gio.Subprocess({
      argv,
      flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    proc.init(null);
  } catch (e) {
    logError(e, `spawn failed: ${argv.join(' ')}`);
  }
}

// Find the agent-workspace-launch helper. Prefers the PATH-installed
// copy (e.g. ~/.local/bin/agent-workspace-launch placed by setup.sh),
// then falls back to the server wrapper directly.
function findLaunchBin() {
  const home = GLib.get_home_dir();
  const candidates = [
    GLib.build_filenamev([home, '.local', 'bin', 'agent-workspace-launch']),
    GLib.build_filenamev([home, 'git', 'agent-workspace', 'bin', 'agent-workspace-launch']),
  ];
  for (const c of candidates) {
    if (GLib.file_test(c, GLib.FileTest.IS_EXECUTABLE)) return {kind: 'launch', path: c};
  }
  // Fall back to the server wrapper (no browser open)
  const serverCandidates = [
    GLib.build_filenamev([home, '.local', 'bin', 'agent-worktrees-server']),
    GLib.build_filenamev([home, 'git', 'agent-workspace', 'bin', 'agent-worktrees-server']),
  ];
  for (const c of serverCandidates) {
    if (GLib.file_test(c, GLib.FileTest.IS_EXECUTABLE)) return {kind: 'server', path: c};
  }
  return null;
}

// Shared start/stop/isRunning behaviour. UI modes wrap this.
class ServerControl {
  constructor({port}) {
    this.port = port;
    this.pidPath = pidfilePath(port);
    this.url = dashboardUrl(port);
  }

  isRunning() {
    if (processAlive(readPid(this.pidPath))) return true;
    return listenersOnPort(this.port);
  }

  start() {
    const bin = findLaunchBin();
    if (!bin) {
      Main.notify('Agentic Workspace', 'Launcher not found — is agent-workspace installed?');
      return;
    }
    if (bin.kind === 'launch') {
      spawnDetached([bin.path]);
    } else {
      spawnDetached([bin.path, '--no-open', '--port', String(this.port)]);
    }
  }

  stop(onAfter) {
    let pid = readPid(this.pidPath);
    if (!processAlive(pid)) pid = findServerPidByCmdline(this.port);
    if (!pid) {
      onAfter?.();
      return;
    }
    spawnDetached(['kill', String(pid)]);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
      let p2 = readPid(this.pidPath);
      if (!processAlive(p2)) p2 = findServerPidByCmdline(this.port);
      if (processAlive(p2)) spawnDetached(['kill', '-9', String(p2)]);
      onAfter?.();
      return GLib.SOURCE_REMOVE;
    });
  }

  openDashboard() {
    const pwa = findInstalledPwa();
    if (pwa) {
      try {
        pwa.launch([], null);
        return;
      } catch (e) {
        logError(e, 'PWA launch failed; falling back to xdg-open');
      }
    }
    spawnDetached(['xdg-open', this.url]);
  }

  copyUrl() {
    const clipboard = St.Clipboard.get_default();
    clipboard.set_text(St.ClipboardType.CLIPBOARD, this.url);
    Main.notify('Agentic Workspace', `Copied ${this.url}`);
  }
}

// ===========================================================================
// Mode 1 — classic PanelMenu.Button with a popup menu.
// ===========================================================================
const PanelIndicator = GObject.registerClass(
class PanelIndicator extends PanelMenu.Button {
  _init(extensionPath, control, showWhenStopped) {
    super._init(0.0, 'Agentic Engineering Workspace', false);
    this._control = control;
    this._showWhenStopped = showWhenStopped;

    const iconPath = GLib.build_filenamev([
      extensionPath, 'icons', 'agentic-symbolic.svg',
    ]);
    this._icon = new St.Icon({
      gicon: Gio.icon_new_for_string(iconPath),
      style_class: 'system-status-icon agentic-icon',
    });
    this.add_child(this._icon);

    this._statusItem = new PopupMenu.PopupMenuItem('Checking…', {
      reactive: false, can_focus: false,
    });
    this._statusItem.label.x_expand = true;
    this.menu.addMenuItem(this._statusItem);

    this._urlItem = new PopupMenu.PopupMenuItem('', {
      reactive: false, can_focus: false,
    });
    this._urlItem.label.style = 'color: rgba(255,255,255,0.55); font-size: 0.85em;';
    this.menu.addMenuItem(this._urlItem);

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._startItem = new PopupMenu.PopupMenuItem('Start server');
    this._startItem.connect('activate', () => this._control.start());
    this.menu.addMenuItem(this._startItem);

    this._stopItem = new PopupMenu.PopupMenuItem('Stop server');
    this._stopItem.connect('activate',
        () => this._control.stop(() => this._refresh()));
    this.menu.addMenuItem(this._stopItem);

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._openItem = new PopupMenu.PopupMenuItem('Open dashboard');
    this._openItem.connect('activate', () => this._control.openDashboard());
    this.menu.addMenuItem(this._openItem);

    this._copyItem = new PopupMenu.PopupMenuItem('Copy URL');
    this._copyItem.connect('activate', () => this._control.copyUrl());
    this.menu.addMenuItem(this._copyItem);

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
    this._refreshItem.connect('activate', () => this._refresh());
    this.menu.addMenuItem(this._refreshItem);

    this.menu.connect('open-state-changed', (_menu, open) => {
      if (open) this._refresh();
    });

    this._refresh();
    this._timerId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SEC,
      () => { this._refresh(); return GLib.SOURCE_CONTINUE; });
  }

  setShowWhenStopped(value) {
    this._showWhenStopped = !!value;
    this._refresh();
  }

  destroy() {
    if (this._timerId) {
      GLib.source_remove(this._timerId);
      this._timerId = null;
    }
    super.destroy();
  }

  _refresh() {
    const running = this._control.isRunning();
    if (running) {
      this._statusItem.label.text = '● Running';
      this._statusItem.label.style = 'color: #3fb950; font-weight: 600;';
      this._icon.opacity = 255;
      this.visible = true;
      this._startItem.setSensitive(false);
      this._stopItem.setSensitive(true);
      this._openItem.setSensitive(true);
    } else {
      this._statusItem.label.text = '○ Stopped';
      this._statusItem.label.style = 'color: #f85149; font-weight: 600;';
      this._icon.opacity = 110;
      this.visible = this._showWhenStopped;
      this._startItem.setSensitive(true);
      this._stopItem.setSensitive(false);
      this._openItem.setSensitive(false);
    }
    this._urlItem.label.text = this._control.url;
  }
});

// ===========================================================================
// Mode 2 — QuickMenuToggle inside Quick Settings, with a small status
// icon in the top bar (the "SystemIndicator" pattern, GNOME 44+).
// ===========================================================================
const ServerQuickToggle = GObject.registerClass(
class ServerQuickToggle extends QuickMenuToggle {
  _init(extensionPath, control) {
    super._init({
      title: 'Agentic Workspace',
      toggleMode: true,
    });
    this._control = control;
    this._suppressClicks = false;

    const iconPath = GLib.build_filenamev([
      extensionPath, 'icons', 'agentic-symbolic.svg',
    ]);
    this.gicon = Gio.icon_new_for_string(iconPath);

    this.menu.setHeader(this.gicon, 'Agentic Workspace', this._control.url);

    this._openItem = this.menu.addAction('Open dashboard',
        () => this._control.openDashboard());
    this.menu.addAction('Copy URL', () => this._control.copyUrl());
    this.menu.addAction('Refresh status', () => this._refresh());

    this.connect('clicked', () => this._onClicked());

    this._refresh();
    this._timerId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SEC,
      () => { this._refresh(); return GLib.SOURCE_CONTINUE; });
  }

  destroy() {
    if (this._timerId) {
      GLib.source_remove(this._timerId);
      this._timerId = null;
    }
    super.destroy();
  }

  _onClicked() {
    // toggleMode flipped `checked` before this signal fires; act on
    // the new state. _refresh() then reconciles back to reality after
    // the start/stop has had a moment to take effect.
    if (this._suppressClicks) return;
    if (this.checked) this._control.start();
    else this._control.stop(() => this._refresh());
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
      this._refresh();
      return GLib.SOURCE_REMOVE;
    });
  }

  _refresh() {
    const running = this._control.isRunning();
    if (this.checked !== running) {
      this._suppressClicks = true;
      this.checked = running;
      this._suppressClicks = false;
    }
    this.subtitle = running ? this._control.url : 'Stopped';
    this._openItem.visible = running;
  }
});

const ServerSystemIndicator = GObject.registerClass(
class ServerSystemIndicator extends SystemIndicator {
  _init(extensionPath, control, showWhenStopped) {
    super._init();
    this._control = control;

    const iconPath = GLib.build_filenamev([
      extensionPath, 'icons', 'agentic-symbolic.svg',
    ]);
    this._statusIcon = this._addIndicator();
    this._statusIcon.gicon = Gio.icon_new_for_string(iconPath);

    this._toggle = new ServerQuickToggle(extensionPath, control);
    this.quickSettingsItems.push(this._toggle);

    this._showWhenStopped = !!showWhenStopped;
    this._toggle.connect('notify::checked', () => this._reflectIcon());
    this._reflectIcon();
  }

  setShowWhenStopped(value) {
    this._showWhenStopped = !!value;
    this._reflectIcon();
  }

  _reflectIcon() {
    const running = this._toggle.checked;
    if (running) {
      this._statusIcon.visible = true;
      this._statusIcon.opacity = 255;
    } else if (this._showWhenStopped) {
      this._statusIcon.visible = true;
      this._statusIcon.opacity = 110;
    } else {
      this._statusIcon.visible = false;
    }
  }
});

// ===========================================================================
// Extension entry point. Reads ui-mode + port from settings and
// rebuilds when either changes.
// ===========================================================================
export default class AgenticWorkspaceExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._build();
    this._modeChangedId = this._settings.connect(
      'changed::ui-mode', () => this._rebuild());
    this._portChangedId = this._settings.connect(
      'changed::port', () => this._rebuild());
    this._showStoppedId = this._settings.connect(
      'changed::show-when-stopped', () => this._applyShowWhenStopped());
  }

  disable() {
    if (this._settings) {
      this._settings.disconnect(this._modeChangedId);
      this._settings.disconnect(this._portChangedId);
      this._settings.disconnect(this._showStoppedId);
    }
    this._teardown();
    this._settings = null;
  }

  _build() {
    const port = effectivePort(this._settings);
    const mode = this._settings.get_string('ui-mode');
    const showStopped = this._settings.get_boolean('show-when-stopped');
    const control = new ServerControl({port});

    if (mode === 'panel') {
      this._panel = new PanelIndicator(this.path, control, showStopped);
      Main.panel.addToStatusArea(this.uuid, this._panel);
    } else {
      this._quick = new ServerSystemIndicator(this.path, control, showStopped);
      Main.panel.statusArea.quickSettings.addExternalIndicator(this._quick);
    }
  }

  _teardown() {
    if (this._quick) {
      this._quick.quickSettingsItems.forEach(item => item.destroy());
      this._quick.destroy();
      this._quick = null;
    }
    if (this._panel) {
      this._panel.destroy();
      this._panel = null;
    }
  }

  _rebuild() {
    this._teardown();
    this._build();
  }

  _applyShowWhenStopped() {
    const v = this._settings.get_boolean('show-when-stopped');
    this._panel?.setShowWhenStopped(v);
    this._quick?.setShowWhenStopped(v);
  }
}
