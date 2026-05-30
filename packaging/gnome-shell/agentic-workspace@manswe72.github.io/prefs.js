// Preferences window for the Agentic Engineering Workspace extension.
// Uses libadwaita widgets (GNOME 42+ pattern, required by the
// ES-module ExtensionPreferences API in GNOME 45+).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AgenticWorkspacePrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage({
      title: 'General',
      icon_name: 'preferences-system-symbolic',
    });
    window.add(page);

    // --- Appearance group ---------------------------------------------------
    const uiGroup = new Adw.PreferencesGroup({
      title: 'Appearance',
      description:
        'Where the server indicator lives in the GNOME Shell. ' +
        'Changes apply immediately.',
    });
    page.add(uiGroup);

    const modes = new Gtk.StringList();
    modes.append('Quick Settings tile');
    modes.append('Top-bar status icon');

    const modeRow = new Adw.ComboRow({
      title: 'UI mode',
      subtitle:
        'Quick Settings mimics Wi-Fi/Bluetooth. ' +
        'Top-bar gives a status-only icon with a popup menu.',
      model: modes,
    });
    modeRow.selected = settings.get_enum('ui-mode');
    modeRow.connect('notify::selected', () => {
      settings.set_enum('ui-mode', modeRow.selected);
    });
    uiGroup.add(modeRow);

    const showStoppedRow = new Adw.SwitchRow({
      title: 'Show indicator when stopped',
      subtitle:
        'Keep the icon visible (dimmed) while the server is off. ' +
        'Turn off to hide it entirely until the server is running.',
    });
    settings.bind('show-when-stopped', showStoppedRow, 'active',
                  /* Gio.SettingsBindFlags.DEFAULT */ 0);
    uiGroup.add(showStoppedRow);

    // --- Server group -------------------------------------------------------
    const serverGroup = new Adw.PreferencesGroup({
      title: 'Server',
      description:
        'AGENT_WORKSPACE_PORT in the GNOME session environment ' +
        'overrides this value if set.',
    });
    page.add(serverGroup);

    const portRow = new Adw.SpinRow({
      title: 'Port',
      subtitle: 'TCP port the dashboard server listens on (default 7020).',
      adjustment: new Gtk.Adjustment({
        lower: 1, upper: 65535,
        step_increment: 1, page_increment: 100,
      }),
    });
    settings.bind('port', portRow, 'value',
                  /* Gio.SettingsBindFlags.DEFAULT */ 0);
    serverGroup.add(portRow);
  }
}
