// Meridian Ledger sign-in (GNOME Shell 51). Presentation only: the Ledger check itself runs in PAM / the initrd.
// Scope: login screen and lock screen only. Admin prompts (polkit) stay stock and use the password.
// Contract with PAM (plain text, so stock GNOME shows it readably when this extension is off):
//   info  "Confirm on your Ledger · code 3387 45BE 5C20" -> card with the 12-hex code (as the Ledger shows it), checklist step 2
//   info  "Approved on Ledger"                         -> approved state
//   info  "Rejected on Ledger"                         -> rejected state
//   info  "Connect your Ledger and open the Meridian app" -> card, step 1 (waiting for the device)
//   info  any other line containing "Ledger"           -> a failure: shown as an error instead of GDM's generic
//                                                         "Sorry, password authentication didn't work"
// Users with /etc/meridian/ledger/<user>.json sign in with the Ledger only, so the password field is not shown
// (it comes back if PAM ever asks a question). Without this extension the password field is visible but refused.
// Every hook is wrapped: on any error we log once and fall back to the stock text.
import GLib from 'gi://GLib';
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

// Corporate card: "Confirm sign-in on your Ledger", the 12-hex code, a 3-step checklist and a status bar.
const STEPS = ['Ledger connected', 'Code matches', 'Approved on device'];
const HINTS = ['Nano Gen5 · Meridian app', 'Compare with the device screen', 'Hold both buttons'];
class LedgerCard {
    constructor() {
        const V = Clutter.Orientation.VERTICAL;
        this.actor = new St.BoxLayout({orientation: V, style_class: 'meridian-card', x_expand: true, visible: false});
        this._hint = new St.Label({style_class: 'meridian-label', text: 'Confirm sign-in on your Ledger'});
        this._chip = new St.BoxLayout({style_class: 'meridian-code', x_expand: true});
        this._g = [0, 1, 2].map(() => new St.Label({style_class: 'meridian-group', x_expand: true, x_align: Clutter.ActorAlign.CENTER}));
        this._g.forEach(g => this._chip.add_child(g));
        const head = new St.BoxLayout({style_class: 'meridian-check-head', x_expand: true});
        head.add_child(new St.Label({style_class: 'meridian-check-title', text: 'Sign-in checklist', x_expand: true}));
        this._count = new St.Label({style_class: 'meridian-check-count', text: '1/3 complete'});
        head.add_child(this._count);
        this._list = new St.BoxLayout({orientation: V, style_class: 'meridian-check', x_expand: true});
        this._rows = STEPS.map((t, i) => {
            const row = new St.BoxLayout({style_class: 'meridian-check-row', x_expand: true});
            const mark = new St.Bin({style_class: 'meridian-mark', y_align: Clutter.ActorAlign.CENTER});
            const icon = new St.Icon({icon_size: 12, icon_name: 'object-select-symbolic', visible: false});
            mark.set_child(icon);
            row.add_child(mark);
            row.add_child(new St.Label({style_class: 'meridian-check-text', text: t, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(new St.Label({style_class: 'meridian-check-hint', text: HINTS[i], y_align: Clutter.ActorAlign.CENTER}));
            this._list.add_child(row);
            return {row, mark, icon};
        });
        this._bar = new St.Label({style_class: 'meridian-bar', text: 'Waiting for approval on Ledger', x_expand: true});
        for (const c of [this._hint, this._chip, head, this._list, this._bar]) this.actor.add_child(c);
    }
    // step i: 'done' | 'on' | 'off' | 'bad'
    _set(states, bar, barClass, count) {
        states.forEach((st, i) => {
            const r = this._rows[i];
            for (const c of ['done', 'on', 'bad']) r.mark.remove_style_class_name(c);
            if (st !== 'off') r.mark.add_style_class_name(st);
            r.icon.visible = st === 'done' || st === 'bad';
            r.icon.icon_name = st === 'bad' ? 'window-close-symbolic' : 'object-select-symbolic';
        });
        this._count.text = `${states.filter(x => x === 'done').length}/3 complete`;
        this._bar.text = bar;
        for (const c of ['ok', 'bad']) this._bar.remove_style_class_name(c);
        if (barClass) this._bar.add_style_class_name(barClass);
    }
    _reveal() { if (!this.actor.visible) { this.actor.opacity = 0; this.actor.show(); this.actor.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.LINEAR}); } }
    nodev() { this._g.forEach(g => { g.text = '····'; }); this._set(['on', 'off', 'off'], 'Connect your Ledger and open the Meridian app', null); this._reveal(); }
    show(groups) { groups.forEach((t, i) => { this._g[i].text = t; }); this._chip.remove_style_class_name('ok'); this._set(['done', 'on', 'off'], 'Waiting for approval on Ledger', null); this._reveal(); }
    ok() { this._chip.add_style_class_name('ok'); this._set(['done', 'done', 'done'], 'Approved · Signing in', 'ok'); }
    bad() { this._set(['done', 'done', 'bad'], 'Rejected on Ledger', 'bad'); }
    hide() { this.actor.hide(); }
    destroy() { this.actor.destroy(); }
}

export default class MeridianLedger extends Extension {
    enable() {
        this._inj = new InjectionManager();
        const cards = this._cards = new Set();
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

    // Greeter background = boot screen background (navy wallpaper with the corner mark), via a style class on #lockDialogGroup.
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
        this._greeterGroup?.remove_style_class_name('meridian-greeter'); this._greeterGroup = null;
    }
}
