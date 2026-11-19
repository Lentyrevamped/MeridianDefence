// Meridian corporate shell (GNOME Shell 51). Styling lives in stylesheet.css; this file only adds the "SECURED"
// indicator just left of the clock (a placeholder for a later build-status readout).
// Fail-safe: any error is logged once and the stock panel stays as it is.
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class MeridianShell extends Extension {
    enable() {
        try {
            const box = Main.panel?._centerBox, dm = Main.panel?.statusArea?.dateMenu;
            if (!box) return;
            const chip = new St.BoxLayout({style_class: 'meridian-secured', y_align: Clutter.ActorAlign.CENTER, reactive: false});
            chip.add_child(new St.Icon({gicon: new Gio.FileIcon({file: Gio.File.new_for_path(`${this.path}/shield.svg`)}),
                icon_size: 11, y_align: Clutter.ActorAlign.CENTER}));
            chip.add_child(new St.Label({text: 'SECURED', y_align: Clutter.ActorAlign.CENTER}));
            const kids = box.get_children(), at = dm?.container ? kids.indexOf(dm.container) : 0;
            box.insert_child_at_index(chip, Math.max(0, at));
            this._chip = chip;
        } catch (e) {
            console.warn(`[meridian-shell] ${e}`);
        }
    }

    disable() {
        // Also runs when the session switches mode (lock/unlock); the panel is rebuilt without the chip.
        this._chip?.destroy(); this._chip = null;
    }
}
