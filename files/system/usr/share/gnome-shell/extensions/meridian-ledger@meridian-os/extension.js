// Meridian Ledger sign-in (GNOME Shell 51). Presentation only: the Ledger check itself runs in PAM / the initrd.
// Scope: login screen and lock screen only. Admin prompts (polkit) stay stock and use the password.
// Contract with PAM (plain text, so stock GNOME shows it readably when this extension is off):
//   info  "Confirm on your Ledger · code 3387 45BE 5C20" -> the 12-hex code (as the Ledger shows it), step 2 of 3
//   info  "Approved on Ledger"                         -> approved state
//   info  "Rejected on Ledger"                         -> rejected state
//   info  "Connect your Ledger and open the Meridian app" -> step 1 of 3 (waiting for the device)
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
let warned = false;
const safe = (fn, fallback) => (...a) => { try { return fn(...a); } catch (e) { if (!warned) { warned = true; console.warn(`[meridian] ${e}\n${e.stack}`); } return fallback?.(...a); } };

// Graphite column (no card): one status line, the 12-hex code between hairlines, a 3-segment step line and a help
// line. Text swaps crossfade over 200 ms; the column fades in with an 8 px rise. No shake, no glow.
const STATUS = {
    nodev: 'Connect your Ledger and open the Meridian app',
    code: 'Confirm on your Ledger · check the code matches',
    ok: 'Approved on Ledger',
    bad: 'Rejected on Ledger',
};
class LedgerCard {
    constructor() {
        const V = Clutter.Orientation.VERTICAL, C = Clutter.ActorAlign.CENTER;
        this.actor = new St.BoxLayout({orientation: V, style_class: 'meridian-ledger', x_expand: true, visible: false});
        this._status = new St.Label({style_class: 'meridian-ledger-status', x_align: C});
        this._code = new St.Label({style_class: 'meridian-ledger-code', x_align: C, x_expand: true});
        this._codeRow = new St.Bin({style_class: 'meridian-ledger-code-row', x_expand: true, child: this._code});
        this._steps = new St.BoxLayout({style_class: 'meridian-ledger-steps', x_align: C});
        this._seg = [0, 1, 2].map(() => { const w = new St.Widget({style_class: 'meridian-ledger-seg'}); this._steps.add_child(w); return w; });
        this._help = new St.Label({style_class: 'meridian-ledger-help', x_align: C});
        for (const c of [this._status, this._codeRow, this._steps, this._help]) this.actor.add_child(c);
    }
    _text(label, text) {
        if (label.text === text) return;
        if (!label.mapped || !St.Settings.get().enable_animations) { label.text = text; return; }
        label.remove_all_transitions();
        label.ease({opacity: 0, duration: 100, mode: Clutter.AnimationMode.EASE_IN_CUBIC, onComplete: () => {
            label.text = text; label.ease({opacity: 255, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }});
    }
    // segment i: 'done' | 'on' | 'off' | 'bad'
    _set(states, status, help) {
        states.forEach((st, i) => { for (const c of ['done', 'on', 'bad']) this._seg[i].remove_style_class_name(c); if (st !== 'off') this._seg[i].add_style_class_name(st); });
        this._text(this._status, status);
        this._text(this._help, help);
    }
    _reveal() {
        if (this.actor.visible) return;
        this.actor.show();
        if (!St.Settings.get().enable_animations) return;
        this.actor.opacity = 0; this.actor.translation_y = 8;
        this.actor.ease({opacity: 255, translation_y: 0, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }
    nodev() { this._code.text = '···· ···· ····'; this._code.add_style_class_name('unknown'); this._set(['on', 'off', 'off'], STATUS.nodev, 'Step 1 of 3'); this._reveal(); }
    show(groups) { this._code.remove_style_class_name('unknown'); this._text(this._code, groups.join(' ')); this._set(['done', 'on', 'off'], STATUS.code, 'Step 2 of 3'); this._reveal(); }
    ok() { this._set(['done', 'done', 'done'], STATUS.ok, 'Signing in'); }
    bad() { this._set(['done', 'done', 'bad'], STATUS.bad, 'Try again, or use the password at the text console'); }
    hide() { this.actor.hide(); }
    destroy() { this.actor.destroy(); }
}

export default class MeridianLedger extends Extension {
    enable() {
        this._inj = new InjectionManager();
        const cards = this._cards = new Set();
        const marks = this._marks = new Set();
        // Login screen and lock screen both use AuthPrompt.setMessage for PAM info/error text.
        this._inj.overrideMethod(AuthPrompt.AuthPrompt.prototype, 'setMessage', orig => function (message, type, wiggle) {
            const r = orig.call(this, message, type, wiggle);
            safe(() => {
                if (!this._meridianCard) {
                    this._meridianCard = new LedgerCard(); cards.add(this._meridianCard);
                    this.add_child(this._meridianCard.actor);
                }
                const card = this._meridianCard, msg = message ?? '';
                const m = CODE_RE.exec(msg);
                const nodev = msg.startsWith('Connect your Ledger');
                const ledgerText = m || nodev || msg.startsWith('Approved on Ledger') || msg.startsWith('Rejected on Ledger');
                if (m) card.show([m[1], m[2], m[3]]);
                else if (nodev) card.nodev();
                else if (msg.startsWith('Approved on Ledger')) card.ok();
                else if (msg.startsWith('Rejected on Ledger')) card.bad();
                else if (msg) card.hide();
                if (this._message) this._message.opacity = ledgerText ? 0 : 255;    // stock label stays as the fallback
                // Back on the password (Ledger turned off mid-attempt): a late Ledger line must not sit under the field.
                if (this._meridianLedger === false && this._entryArea?.visible && (isProgress(msg) || isFailure(msg))) {
                    card.hide(); if (this._message) this._message.opacity = 0;
                }
            })();
            return r;
        });
        // A real PAM question (Ledger not enrolled after all): show the entry and drop the card.
        this._inj.overrideMethod(AuthPrompt.AuthPrompt.prototype, 'setQuestion', orig => function (...a) {
            safe(() => { this._meridianLedger = false; this._meridianCard?.hide(); if (this._message) this._message.opacity = 255; })();
            const ret = orig.apply(this, a);
            // A Ledger hint left over from an earlier attempt must not sit under a password field.
            safe(() => { const t = this._message?.text ?? ''; if (t && (isProgress(t) || isFailure(t))) this.setMessage(null); })();
            return ret;
        });
        // Ledger users: no password field. begin() knows the user (unlock: always the session user).
        this._inj.overrideMethod(AuthPrompt.AuthPrompt.prototype, 'begin', orig => function (params) {
            safe(() => {
                const user = params?.userName ?? (this._mode === AuthPrompt.AuthPromptMode.UNLOCK_ONLY ? GLib.get_user_name() : null);
                this._meridianLedger = enrolled(user);
                if (!this._meridianMark) {
                    this._meridianMark = new St.Icon({gicon: Gio.FileIcon.new(Gio.File.new_for_path('/usr/share/meridian/mark.svg')), icon_size: 20, style_class: 'meridian-ledger-mark', x_align: Clutter.ActorAlign.CENTER, opacity: 153});
                    this.insert_child_at_index(this._meridianMark, 0);
                    marks.add(this._meridianMark);
                }
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
        if (Main.sessionMode.isGreeter) {
            safe(() => this._greeterSurface())();
        }
    }

    // Greeter background = the Graphite wallpaper with a 35 % dim, via a style class on #lockDialogGroup.
    _greeterSurface() {
        const find = (a, depth) => {
            if (!a || depth > 6) return null;
            if (a.get_name?.() === 'lockDialogGroup') return a;
            for (const c of a.get_children?.() ?? []) { const f = find(c, depth + 1); if (f) return f; }
            return null;
        };
        const g = Main.screenShield?._lockDialogGroup ?? find(Main.layoutManager.uiGroup, 0);
        if (!g?.add_style_class_name) return;
        g.add_style_class_name('meridian-greeter');
        this._greeterGroup = g;
    }

    disable() {
        // Required in unlock-dialog mode as well: undo everything, the stock UI stays.
        this._inj?.clear(); this._inj = null;
        for (const c of this._cards ?? []) safe(() => c.destroy())();
        this._cards = null;
        for (const m of this._marks ?? []) safe(() => m.destroy())();
        this._marks = null;
        this._greeterGroup?.remove_style_class_name('meridian-greeter'); this._greeterGroup = null;
    }
}
