// Meridian Ledger sign-in (GNOME Shell 51). Presentation only: the Ledger check itself runs in PAM / the initrd.
// Scope: login screen and lock screen only. Admin prompts (polkit) stay stock and use the password.
// Contract with PAM (plain text, so stock GNOME shows it readably when this extension is off):
//   info  "Confirm on your Ledger · code 3387 45BE 5C20" -> card with the 12-hex code (as the Ledger shows it), spinner
//   info  "Approved on Ledger"                         -> approved state
//   info  "Rejected on Ledger"                         -> rejected state
//   info  "Connect your Ledger and open the Meridian app" -> plain text (waiting for the device)
//   info  any other line containing "Ledger"           -> a failure: shown as an error instead of GDM's generic
//                                                         "Sorry, password authentication didn't work"
// Users with /etc/meridian/ledger/<user>.json sign in with the Ledger only, so the password field is not shown
// (it comes back if PAM ever asks a question). Without this extension the password field is visible but refused.
// Every hook is wrapped: on any error we log once and fall back to the stock text.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AuthPrompt from 'resource:///org/gnome/shell/gdm/authPrompt.js';
import * as UserVerifier from 'resource:///org/gnome/shell/gdm/userVerifier.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const CODE_RE = /Confirm on your Ledger.*?code\s+([0-9A-F]{4})\s?([0-9A-F]{4})\s?([0-9A-F]{4})/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const enrolled = u => !!u && USER_RE.test(u) && GLib.file_test(`/etc/meridian/ledger/${u}.json`, GLib.FileTest.IS_REGULAR);
const isProgress = m => CODE_RE.test(m) || m.startsWith('Approved on Ledger') || m.startsWith('Connect your Ledger');
const isFailure = m => m.includes('Ledger') && !isProgress(m);
// Message queue filter (per ShellUserVerifier): a Ledger failure line becomes an ERROR so it survives GDM's
// failure handling, and the generic ERROR that follows it is dropped. Returns the args to queue, or null to drop.
function filterMessage(v, args) {
    const msg = args?.message ?? '', ERROR = UserVerifier.MessageType.ERROR;
    if (!msg) return args;
    if (isFailure(msg)) { v._meridianFailed = true; return {...args, messageType: Math.max(args.messageType ?? 0, ERROR)}; }
    if (isProgress(msg)) { v._meridianFailed = false; return args; }
    if (v._meridianFailed && args.messageType === ERROR) { v._meridianFailed = false; return null; }
    return args;
}
const EASE_OUT = Clutter.AnimationMode.EASE_OUT_CUBIC;
let warned = false;
const safe = (fn, fallback) => (...a) => { try { return fn(...a); } catch (e) { if (!warned) { warned = true; console.warn(`[meridian] ${e}\n${e.stack}`); } return fallback?.(...a); } };

class LedgerCard {
    constructor(dir) {
        this.actor = new St.BoxLayout({vertical: true, style_class: 'meridian-card', x_align: Clutter.ActorAlign.CENTER, visible: false});
        this._hint = new St.Label({style_class: 'meridian-hint', text: 'Confirm on your Ledger', x_align: Clutter.ActorAlign.CENTER});
        this._chip = new St.BoxLayout({style_class: 'meridian-chip', x_align: Clutter.ActorAlign.CENTER});
        this._g = [0, 1, 2].map(() => new St.Label({style_class: 'meridian-group'}));
        this._g.forEach((g, i) => { if (i) this._chip.add_child(new St.Widget({style_class: 'meridian-divider', y_expand: true})); this._chip.add_child(g); });
        this._status = new St.BoxLayout({style_class: 'meridian-status', x_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_size: 14, icon_name: 'process-working-symbolic'});
        this._text = new St.Label({text: 'Waiting for approval', y_align: Clutter.ActorAlign.CENTER});
        this._status.add_child(this._icon); this._status.add_child(this._text);
        for (const c of [this._hint, this._chip, this._status]) this.actor.add_child(c);
        this._spin = 0;
    }
    show(groups) {
        groups.forEach((t, i) => { this._g[i].text = t; }); this._state('wait');
        if (!this.actor.visible) { this.actor.opacity = 0; this.actor.translation_y = 8; this.actor.show(); this.actor.ease({opacity: 255, translation_y: 0, duration: 300, mode: EASE_OUT}); }
        if (!this._timer) this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => { this._icon.rotation_angle_z = (this._spin += 12) % 360; return GLib.SOURCE_CONTINUE; });
        this._icon.set_pivot_point(0.5, 0.5);
    }
    _state(s) {
        this._chip.remove_style_class_name('ok'); this._status.remove_style_class_name('ok'); this._status.remove_style_class_name('bad');
        if (s === 'ok') { this._chip.add_style_class_name('ok'); this._status.add_style_class_name('ok'); this._icon.icon_name = 'object-select-symbolic'; this._text.text = 'Approved'; this._stopSpin(); }
        else if (s === 'bad') { this._status.add_style_class_name('bad'); this._icon.icon_name = 'dialog-warning-symbolic'; this._text.text = 'Rejected on Ledger'; this._stopSpin(); }
        else { this._icon.icon_name = 'process-working-symbolic'; this._text.text = 'Waiting for approval'; }
    }
    ok() { this._state('ok'); }
    bad() { this._state('bad'); }
    hide() { this._stopSpin(); this.actor.hide(); }
    _stopSpin() { if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; } this._icon.rotation_angle_z = 0; }
    destroy() { this._stopSpin(); this.actor.destroy(); }
}

export default class MeridianLedger extends Extension {
    enable() {
        this._inj = new InjectionManager();
        const dir = this.path; const cards = this._cards = new Set();
        // Login screen and lock screen both use AuthPrompt.setMessage for PAM info/error text.
        this._inj.overrideMethod(AuthPrompt.AuthPrompt.prototype, 'setMessage', orig => function (message, type, wiggle) {
            const r = orig.call(this, message, type, wiggle);
            safe(() => {
                if (!this._meridianCard) {
                    this._meridianCard = new LedgerCard(dir); cards.add(this._meridianCard);
                    this.add_child(this._meridianCard.actor);
                }
                const card = this._meridianCard, msg = message ?? '';
                const m = CODE_RE.exec(msg);
                const ledgerText = m || msg.startsWith('Approved on Ledger') || msg.startsWith('Rejected on Ledger');
                if (m) card.show([m[1], m[2], m[3]]);
                else if (msg.startsWith('Approved on Ledger')) card.ok();
                else if (msg.startsWith('Rejected on Ledger')) card.bad();
                else if (msg) card.hide();
                if (this._message) this._message.opacity = ledgerText ? 0 : 255;    // stock label stays as the fallback
            })();
            return r;
        });
        // A real PAM question (Ledger not enrolled after all): show the entry and drop the card.
        this._inj.overrideMethod(AuthPrompt.AuthPrompt.prototype, 'setQuestion', orig => function (...a) {
            safe(() => { this._meridianLedger = false; this._meridianCard?.hide(); if (this._message) this._message.opacity = 255; })();
            return orig.apply(this, a);
        });
        // Ledger users: no password field. begin() knows the user (unlock: always the session user).
        this._inj.overrideMethod(AuthPrompt.AuthPrompt.prototype, 'begin', orig => function (params) {
            safe(() => {
                const user = params?.userName ?? (this._mode === AuthPrompt.AuthPromptMode.UNLOCK_ONLY ? GLib.get_user_name() : null);
                this._meridianLedger = enrolled(user);
                if (this._meridianLedger) this._entryArea?.hide();
            })();
            return orig.call(this, params);
        });
        this._inj.overrideMethod(AuthPrompt.AuthPrompt.prototype, '_fadeInElement', orig => function (element) {
            if (this._meridianLedger && element === this._entryArea) return undefined;
            return orig.call(this, element);
        });
        for (const name of ['_queueMessage', '_queuePriorityMessage']) {
            this._inj.overrideMethod(UserVerifier.ShellUserVerifier.prototype, name, orig => function (args) {
                const a = safe(() => filterMessage(this, args), () => args)();
                return a ? orig.call(this, a) : undefined;
            });
        }
        if (Main.sessionMode.isGreeter) safe(() => this._handoff())();
    }

    // Boot hand-off: Plymouth's last frame is the mark + wordmark on Ink. Recreate it and dissolve into the greeter.
    _handoff() {
        if (GLib.getenv('MERIDIAN_NO_HANDOFF')) return;
        const mon = Main.layoutManager.primaryMonitor; if (!mon) return;
        const s = mon.height / 1440;                       // design grid: 1440 logical px tall
        const over = new St.Widget({style_class: 'meridian-handoff', x: mon.x, y: mon.y, width: mon.width, height: mon.height, reactive: false});
        const file = n => new Gio.FileIcon({file: Gio.File.new_for_path(`${this.path}/${n}`)});
        const sh = 196 * s, star = new St.Icon({gicon: file('star.svg'), icon_size: Math.round(sh * 100 / 94)});
        star.set_position(Math.round(mon.width / 2 - star.icon_size / 2), Math.round(612 * s - star.icon_size / 2));
        const ww = 344 * s, word = new St.Icon({gicon: file('wordmark.svg'), width: Math.round(ww), height: Math.round(ww * 44 / 392.36)});
        word.set_position(Math.round(mon.width / 2 - ww / 2), Math.round(781 * s - ww * 44 / 392.36 / 2));
        over.add_child(star); over.add_child(word);
        Main.layoutManager.addTopChrome(over);
        this._over = over;
        word.ease({opacity: 0, duration: 350, delay: 150, mode: Clutter.AnimationMode.EASE_IN_CUBIC});
        star.set_pivot_point(0.5, 0.5);
        star.ease({scale_x: 0.27, scale_y: 0.27, translation_y: (512 - 612) * s, duration: 950, delay: 300, mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC});
        over.ease({opacity: 0, duration: 450, delay: 1050, mode: EASE_OUT, onComplete: () => { over.destroy(); this._over = null; }});
    }

    disable() {
        // Required in unlock-dialog mode as well: undo everything, the stock UI stays.
        this._inj?.clear(); this._inj = null;
        for (const c of this._cards ?? []) safe(() => c.destroy())();
        this._cards = null;
        this._over?.destroy(); this._over = null;
    }
}
