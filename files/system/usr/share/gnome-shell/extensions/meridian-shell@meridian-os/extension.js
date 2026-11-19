// Meridian OS shell, Graphite design (GNOME Shell 51). Tokens: /usr/share/meridian/tokens.css.
//   Desktop (user mode): no top bar; a floating left taskbar (Meridian mark = start menu, search, pinned and running
//     apps, tray = quick settings, clock = calendar and notifications); start menu on the mark button or Super;
//     quick settings laid out like Windows 11 (3 columns of tiles with the label underneath, sliders, battery footer).
//   Sign-in (gdm) and lock (unlock-dialog): the stock top bar becomes a transparent bottom bar (hostname on the left,
//     keyboard, accessibility and power on the right); the lock clock sits top-left.
// Everything goes through the stock objects (panel indicators, quick settings menu, date menu, search), so the
// backends keep working. Every hook is wrapped: on an error we log once and the stock piece stays usable. Disabling
// puts every actor back where it came from.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import GnomeDesktop from 'gi://GnomeDesktop';
import AccountsService from 'gi://AccountsService';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as UnlockDialog from 'resource:///org/gnome/shell/ui/unlockDialog.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import {Avatar} from 'resource:///org/gnome/shell/ui/userWidget.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const BAR_W = 48, INSET = 8, ICON = 28, GAP = 8;          // logical px (Dongwon's playground settings)
const EASE_IN = Clutter.AnimationMode.EASE_OUT_CUBIC;     // ~cubic-bezier(.2,0,0,1)
const MARK = '/usr/share/meridian/mark.svg';
const KEEP_AWAKE_STATE = () => GLib.build_filenamev([GLib.get_user_state_dir(), 'meridian-keepawake', 'saved']);

function imageStatus() {
    try {
        const [, raw] = GLib.file_get_contents('/usr/lib/os-release');
        const m = new TextDecoder().decode(raw).match(/^MERIDIAN_IMAGE_BUILT="?([^"\n]+)"?/m);
        if (m) return `Meridian OS · signed image built ${GLib.DateTime.new_from_iso8601(m[1].replace(/Z$/, ':00Z'), null)?.to_local().format('%-d %b %Y, %H:%M') ?? m[1]}`;
    } catch (e) {}
    return 'Meridian OS';
}

let warned = false;
const safe = (fn, fallback) => (...a) => { try { return fn(...a); } catch (e) { if (!warned) { warned = true; console.warn(`[meridian-shell] ${e}\n${e.stack}`); } return fallback?.(...a); } };
const anim = () => St.Settings.get().enable_animations;
const scale = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;
function fadeRise(actor, {delay = 0, dx = 0, dy = 8, duration = 320} = {}) {
    if (!anim()) { actor.opacity = 255; return; }
    actor.opacity = 0; actor.translation_x = dx; actor.translation_y = dy;
    actor.ease({opacity: 255, translation_x: 0, translation_y: 0, delay, duration, mode: EASE_IN});
}
function icon(name, size, cls) { return new St.Icon({icon_name: name, icon_size: size, style_class: cls ?? null}); }
function markIcon(size, cls) { return new St.Icon({gicon: Gio.FileIcon.new(Gio.File.new_for_path(MARK)), icon_size: size, style_class: cls ?? null}); }
function moveTo(actor, parent, index = -1) {
    const old = actor.get_parent();
    if (old === parent) return;
    old?.remove_child(actor);
    if (index < 0) parent.add_child(actor); else parent.insert_child_at_index(actor, index);
}

// A popover menu that opens beside the taskbar (top- or bottom-aligned with it), fading in with an 8 px slide.
function besideTaskbar(inj, menu, taskbar, alignment) {
    const bp = menu._boxPointer;
    bp._arrowSide = bp._userArrowSide = St.Side.LEFT;
    bp.add_style_class_name('meridian-popover-bar');
    inj.overrideMethod(bp, 'setPosition', orig => function (_source, _align) {
        orig.call(this, taskbar, alignment);
        this.setSourceAlignment(alignment);
    });
}

// ---------------------------------------------------------------- tooltips
class Tip {
    constructor() {
        this.actor = new St.Label({style_class: 'meridian-tip', visible: false});
        Main.layoutManager.addTopChrome(this.actor, {affectsInputRegion: false});
    }
    attach(button, textFn) {
        button.connect('notify::hover', () => {
            GLib.Source.remove(this._t ?? 0); this._t = 0;
            if (!button.hover) { this.hide(); return; }
            this._t = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { this._t = 0; safe(() => this.show(button, textFn()))(); return GLib.SOURCE_REMOVE; });
        });
        button.connect('destroy', () => this.hide());
    }
    show(button, text) {
        if (!text || !button.mapped) return;
        this.actor.text = text;
        const [x, y] = button.get_transformed_position();
        const [w, h] = button.get_transformed_size();
        const [, nh] = this.actor.get_preferred_height(-1);
        this.actor.set_position(Math.round(x + w + (INSET + 4) * scale()), Math.round(y + (h - nh) / 2));
        this.actor.show(); this.actor.remove_all_transitions(); this.actor.opacity = 0;
        this.actor.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
    hide() { if (this._t) { GLib.Source.remove(this._t); this._t = 0; } this.actor.hide(); }
    destroy() { this.hide(); this.actor.destroy(); }
}

// ---------------------------------------------------------------- start menu
class StartMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        super(source, 0, St.Side.LEFT);
        this.box.add_style_class_name('meridian-start');
        this.actor.hide();
        Main.uiGroup.add_child(this.actor);

        const V = Clutter.Orientation.VERTICAL;
        this._entry = new St.Entry({style_class: 'meridian-start-search', hint_text: 'Search apps, files and settings', can_focus: true, x_expand: true});
        this._entry.set_primary_icon(icon('system-search-symbolic', 16));
        this._entry.clutter_text.connect('text-changed', () => safe(() => this._filter())());
        this._entry.clutter_text.connect('activate', () => safe(() => this._activateFirst())());
        const top = new St.BoxLayout({orientation: V, style_class: 'meridian-start-body'});
        top.add_child(this._entry);

        this._pinnedHead = new St.Label({style_class: 'meridian-start-head', text: 'Pinned'});
        this._grid = new St.Widget({style_class: 'meridian-start-grid', layout_manager: new Clutter.GridLayout({column_homogeneous: true})});
        this._recentHead = new St.Label({style_class: 'meridian-start-head', text: 'Recent'});
        this._recent = new St.Widget({style_class: 'meridian-start-recent', layout_manager: new Clutter.GridLayout({column_homogeneous: true})});
        this._results = new St.BoxLayout({orientation: V, style_class: 'meridian-start-results', visible: false});
        for (const a of [this._pinnedHead, this._grid, this._recentHead, this._recent, this._results]) top.add_child(a);
        this.box.add_child(top);

        // footer: avatar + name, Lock, Power
        const foot = new St.BoxLayout({style_class: 'meridian-start-foot', x_expand: true});
        const um = AccountsService.UserManager.get_default();
        const user = um.get_user(GLib.get_user_name());
        const who = new St.BoxLayout({style_class: 'meridian-start-user', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._avatar = new Avatar(user, {iconSize: 28, styleClass: 'meridian-start-avatar'});
        this._name = new St.Label({style_class: 'meridian-start-name', y_align: Clutter.ActorAlign.CENTER});
        const setName = () => { this._avatar.update(); this._name.text = user.get_real_name() || GLib.get_user_name(); };
        user.connectObject('notify::is-loaded', setName, 'changed', setName, this);
        setName();
        who.add_child(this._avatar); who.add_child(this._name);
        foot.add_child(who);
        const sys = SystemActions.getDefault();
        const lock = new St.Button({style_class: 'meridian-start-btn', child: icon('system-lock-screen-symbolic', 16), accessible_name: 'Lock'});
        lock.connect('clicked', () => { this.close(); sys.activateLockScreen(); });
        this._power = new St.Button({style_class: 'meridian-start-btn', child: icon('system-shutdown-symbolic', 16), accessible_name: 'Power'});
        foot.add_child(lock); foot.add_child(this._power);
        this.box.add_child(foot);

        // power choices
        this._powerMenu = new PopupMenu.PopupMenu(this._power, 0.5, St.Side.BOTTOM);
        this._powerMenu.actor.add_style_class_name('meridian-power-menu');
        this._powerMenu.actor.hide();
        Main.uiGroup.add_child(this._powerMenu.actor);
        for (const [label, fn] of [['Lock', 'activateLockScreen'], ['Sign out', 'activateLogout'], ['Sleep', 'activateSuspend'], ['Restart', 'activateRestart'], ['Shut down', 'activatePowerOff']])
            this._powerMenu.addAction(label, () => { this.close(); sys[fn](); });
        this._powerManager = new PopupMenu.PopupMenuManager(this._power);
        this._powerManager.addMenu(this._powerMenu);
        this._power.connect('clicked', () => this._powerMenu.toggle());

        this.connect('open-state-changed', (m, open) => safe(() => {
            if (!open) { this._powerMenu.close(); return; }
            this._build();
            this._entry.text = '';
            this.box.translation_x = anim() ? -8 : 0;
            this.box.ease({translation_x: 0, duration: 240, mode: EASE_IN});
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { global.stage.set_key_focus(this._entry); return GLib.SOURCE_REMOVE; });
        })());
    }

    openSearch() { this.open(); }

    _tile(app) {
        const b = new St.Button({style_class: 'meridian-start-app', can_focus: true});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        box.add_child(app.create_icon_texture(34));
        const l = new St.Label({text: app.get_name(), style_class: 'meridian-start-app-label', x_align: Clutter.ActorAlign.CENTER});
        l.clutter_text.ellipsize = 3;
        box.add_child(l);
        b.set_child(box);
        b.connect('clicked', () => { this.close(); app.activate(); });
        return b;
    }

    _build() {
        this._grid.destroy_all_children();
        const gl = this._grid.layout_manager;
        const apps = AppFavorites.getAppFavorites().getFavorites();
        const sys = Shell.AppSystem.get_default();
        for (const id of ['org.gnome.Nautilus.desktop', 'org.gnome.Settings.desktop', 'org.gnome.Ptyxis.desktop', 'io.github.kolunmi.Bazaar.desktop']) {
            const a = sys.lookup_app(id);
            if (a && !apps.includes(a)) apps.push(a);
        }
        apps.slice(0, 18).forEach((app, i) => gl.attach(this._tile(app), i % 6, Math.floor(i / 6), 1, 1));
        // Recent files (the same list Files and the file chooser use)
        this._recent.destroy_all_children();
        const rl = this._recent.layout_manager;
        let items = [];
        safe(() => {
            const bf = new GLib.BookmarkFile();
            bf.load_from_file(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']));
            items = bf.get_uris().map(u => ({u, t: bf.get_modified_date_time(u)?.to_unix() ?? 0, mime: bf.get_mime_type(u)}))
                .filter(x => x.u.startsWith('file://')).sort((a, b) => b.t - a.t).slice(0, 6);
        })();
        this._recentHead.visible = this._recent.visible = items.length > 0;
        items.forEach((x, i) => {
            const f = Gio.File.new_for_uri(x.u);
            const b = new St.Button({style_class: 'meridian-start-file', can_focus: true, x_expand: true});
            const row = new St.BoxLayout({style_class: 'meridian-start-file-row'});
            row.add_child(new St.Icon({gicon: Gio.content_type_get_icon(x.mime ?? 'application/octet-stream'), icon_size: 30}));
            const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
            const n = new St.Label({text: f.get_basename() ?? x.u, style_class: 'meridian-start-file-name'});
            n.clutter_text.ellipsize = 3;
            col.add_child(n);
            col.add_child(new St.Label({text: this._ago(x.t), style_class: 'meridian-start-file-time'}));
            row.add_child(col);
            b.set_child(row);
            b.connect('clicked', () => { this.close(); Gio.AppInfo.launch_default_for_uri_async(x.u, global.create_app_launch_context(0, -1), null, null); });
            rl.attach(b, i % 2, Math.floor(i / 2), 1, 1);
        });
    }

    _ago(t) {
        const d = GLib.get_real_time() / 1e6 - t;
        if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
        if (d < 86400) return `${Math.round(d / 3600)} h ago`;
        return GLib.DateTime.new_from_unix_local(t).format('%-d %b');
    }

    _filter() {
        const q = this._entry.text.trim();
        const searching = q.length > 0;
        for (const a of [this._pinnedHead, this._grid]) a.visible = !searching;
        this._recentHead.visible = this._recent.visible = !searching && this._recent.get_n_children() > 0;
        this._results.visible = searching;
        this._results.destroy_all_children();
        if (!searching) return;
        const sys = Shell.AppSystem.get_default();
        const ids = Shell.AppSystem.search(q).flat().slice(0, 7);
        this._first = null;
        for (const id of ids) {
            const app = sys.lookup_app(id);
            if (!app) continue;
            const b = new St.Button({style_class: 'meridian-start-result', can_focus: true, x_expand: true});
            const row = new St.BoxLayout({style_class: 'meridian-start-result-row'});
            row.add_child(app.create_icon_texture(24));
            row.add_child(new St.Label({text: app.get_name(), y_align: Clutter.ActorAlign.CENTER}));
            b.set_child(row);
            b.connect('clicked', () => { this.close(); app.activate(); });
            this._results.add_child(b);
            this._first ??= () => { this.close(); app.activate(); };
        }
        // Everything else (files, settings, calculator, ...) goes to the full search in the overview.
        const all = new St.Button({style_class: 'meridian-start-result more', can_focus: true, x_expand: true});
        const row = new St.BoxLayout({style_class: 'meridian-start-result-row'});
        row.add_child(icon('system-search-symbolic', 16));
        row.add_child(new St.Label({text: `Search files and settings for "${q}"`, y_align: Clutter.ActorAlign.CENTER}));
        all.set_child(row);
        const full = () => { this.close(); Main.overview.show(); Main.overview.searchEntry.set_text(q); };
        all.connect('clicked', full);
        this._results.add_child(all);
        this._first ??= full;
    }

    _activateFirst() { this._first?.(); }

    destroy() { this._powerMenu?.destroy(); super.destroy(); }
}

// ---------------------------------------------------------------- extra quick settings tiles
const KeepAwakeToggle = GObject.registerClass(
class KeepAwakeToggle extends QuickSettings.QuickToggle {
    _init() {
        super._init({title: 'Keep screen on', iconName: 'video-display-symbolic', toggleMode: false});
        const dir = Gio.File.new_for_path(GLib.path_get_dirname(KEEP_AWAKE_STATE()));
        safe(() => { dir.make_directory_with_parents(null); })();
        this._mon = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._mon.connect('changed', () => this._sync());
        this.connect('clicked', () => safe(() => Gio.Subprocess.new(['meridian-keepawake', this.checked ? 'off' : 'on'], Gio.SubprocessFlags.NONE))());
        this._sync();
    }
    _sync() { this.checked = GLib.file_test(KEEP_AWAKE_STATE(), GLib.FileTest.EXISTS); }
    destroy() { this._mon?.cancel(); super.destroy(); }
});

const A11Y = [['Screen reader', 'org.gnome.desktop.a11y.applications', 'screen-reader-enabled'],
    ['Magnifier', 'org.gnome.desktop.a11y.applications', 'screen-magnifier-enabled'],
    ['Large text', null, 'large-text'],
    ['High contrast', 'org.gnome.desktop.a11y.interface', 'high-contrast'],
    ['On-screen keyboard', 'org.gnome.desktop.a11y.applications', 'screen-keyboard-enabled']];
const A11yToggle = GObject.registerClass(
class A11yToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        super._init({title: 'Accessibility', iconName: 'org.gnome.Settings-accessibility-symbolic', toggleMode: false});
        this.menu.setHeader('org.gnome.Settings-accessibility-symbolic', 'Accessibility');
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._items = A11Y.map(([label, schema, key]) => {
            const s = schema ? new Gio.Settings({schema_id: schema}) : this._iface;
            const get = () => key === 'large-text' ? s.get_double('text-scaling-factor') > 1.0 : s.get_boolean(key);
            const set = v => key === 'large-text' ? s.set_double('text-scaling-factor', v ? 1.25 : 1.0) : s.set_boolean(key, v);
            const item = new PopupMenu.PopupSwitchMenuItem(label, get());
            item.connect('toggled', (_i, v) => set(v));
            s.connectObject(`changed::${key === 'large-text' ? 'text-scaling-factor' : key}`, () => { item.setToggleState(get()); this._sync(); }, this);
            this.menu.addMenuItem(item);
            return get;
        });
        this.connect('clicked', () => this.menu.open());
        this._sync();
    }
    _sync() { this.checked = this._items?.some(g => g()) ?? false; }
});

const MeridianTiles = GObject.registerClass(
class MeridianTiles extends QuickSettings.SystemIndicator {
    _init() {
        super._init();
        this.quickSettingsItems.push(new KeepAwakeToggle(), new A11yToggle());
    }
    destroy() { this.quickSettingsItems.forEach(i => i.destroy()); super.destroy(); }
});

// ---------------------------------------------------------------- taskbar
class Taskbar {
    constructor(ext) {
        this._ext = ext;
        this._inj = new InjectionManager();
        this._tip = new Tip();
        const V = Clutter.Orientation.VERTICAL;

        // Work area: an invisible strut down the left edge, 8 + 48 + 8 px, so maximised windows start at x = 64.
        this._strut = new St.Widget({name: 'meridianTaskbarStrut', reactive: false, opacity: 0});
        Main.layoutManager.addChrome(this._strut, {affectsStruts: true, affectsInputRegion: false, trackFullscreen: true});

        this.actor = new St.BoxLayout({name: 'meridianTaskbar', orientation: V, reactive: true, style_class: 'meridian-taskbar'});
        Main.layoutManager.addChrome(this.actor, {affectsStruts: false, trackFullscreen: true});
        safe(() => {
            const blur = new Shell.BlurEffect({name: 'meridian-blur', mode: Shell.BlurMode.BACKGROUND, brightness: 1.0});
            this.actor.add_effect(blur);
            this._blur = blur;
            this.actor.add_style_class_name('blurred');
        })();

        // start + search
        this._mark = this._button(markIcon(20), 'Start', 'meridian-tb-mark');
        this._search = this._button(icon('system-search-symbolic', 18), 'Search', 'meridian-tb-search');
        this.actor.add_child(this._mark); this.actor.add_child(this._search);
        this.actor.add_child(new St.Widget({style_class: 'meridian-tb-divider', x_align: Clutter.ActorAlign.CENTER}));

        this._apps = new St.BoxLayout({orientation: V, style_class: 'meridian-tb-apps'});
        this.actor.add_child(this._apps);
        this.actor.add_child(new St.Widget({y_expand: true}));

        // tray (the stock quick settings indicator, stacked) + clock
        this._tray = new St.BoxLayout({orientation: V, style_class: 'meridian-tb-tray', x_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._tray);
        this.actor.add_child(new St.Widget({style_class: 'meridian-tb-divider', x_align: Clutter.ActorAlign.CENTER}));
        this._clockBtn = new St.Button({style_class: 'meridian-tb-clock', can_focus: true, x_expand: true});
        const cb = new St.BoxLayout({orientation: V, x_align: Clutter.ActorAlign.CENTER});
        this._time = new St.Label({style_class: 'meridian-tb-time', x_align: Clutter.ActorAlign.CENTER});
        this._date = new St.Label({style_class: 'meridian-tb-date', x_align: Clutter.ActorAlign.CENTER});
        cb.add_child(this._time); cb.add_child(this._date);
        this._clockBtn.set_child(cb);
        this.actor.add_child(this._clockBtn);
        this._wall = new GnomeDesktop.WallClock();
        this._wall.connectObject('notify::clock', () => this._syncClock(), this);
        this._syncClock();
        // Build status lives in the tooltip (the image build stamp from os-release; a placeholder for live build status).
        this._tip.attach(this._clockBtn, () => `${GLib.DateTime.new_now_local().format('%A, %-d %B %Y')}\n${imageStatus()}`);

        // menus
        this._startMenu = new StartMenu(this._mark);
        besideTaskbar(this._inj, this._startMenu, this.actor, 0);
        this._menus = new PopupMenu.PopupMenuManager(this.actor);
        this._menus.addMenu(this._startMenu);
        this._mark.connect('clicked', () => this._startMenu.toggle());
        this._search.connect('clicked', () => this._startMenu.toggle());

        const qs = Main.panel.statusArea.quickSettings;
        this._qs = qs;
        if (qs?.menu) besideTaskbar(this._inj, qs.menu, this.actor, 1);
        const dm = Main.panel.statusArea.dateMenu;
        if (dm?.menu) besideTaskbar(this._inj, dm.menu, this.actor, 1);
        this._clockBtn.connect('clicked', () => dm?.menu?.toggle());

        // Super opens the start menu (the overview stays on the top-left hot corner)
        safe(() => {
            this._overlayBlocked = GObject.signal_handlers_block_matched(global.display, {signalId: 'overlay-key'});
            global.display.connectObject('overlay-key', () => safe(() => this._startMenu.toggle())(), this);
        })();

        // apps
        const favs = AppFavorites.getAppFavorites();
        favs.connectObject('changed', () => this._queueApps(), this);
        Shell.AppSystem.get_default().connectObject('app-state-changed', () => this._queueApps(), 'installed-changed', () => this._queueApps(), this);
        Shell.WindowTracker.get_default().connectObject('notify::focus-app', () => this._syncFocus(), this);
        global.display.connectObject('notify::focus-window', () => this._syncFocus(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._place(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor', () => this._place(), this);
        Main.overview.connectObject('showing', () => this._startMenu.close(), this);

        this._stealIndicators();
        Main.sessionMode.connectObject('updated', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { safe(() => this._stealIndicators())(); return GLib.SOURCE_REMOVE; }), this);
        this._buildApps();
        this._place();
        // desktop entrance: the taskbar fades in with an 8 px rise after 120 ms
        fadeRise(this.actor, {delay: 120, dy: 8});
    }

    _button(child, tip, cls) {
        const b = new St.Button({style_class: `meridian-tb-btn ${cls ?? ''}`, can_focus: true, child, x_align: Clutter.ActorAlign.CENTER, accessible_name: tip});
        this._tip.attach(b, () => tip);
        return b;
    }

    _place() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m) return;
        const s = scale();
        this._strut.set_position(m.x, m.y);
        this._strut.set_size((INSET + BAR_W + INSET) * s, m.height);
        this.actor.set_position(m.x + INSET * s, m.y + INSET * s);
        this.actor.set_size(BAR_W * s, m.height - 2 * INSET * s);
        this._blur?.set({radius: 24 * s});
    }

    _syncClock() {
        const now = GLib.DateTime.new_now_local();
        this._time.text = now.format('%H:%M');
        this._date.text = now.format('%-d %b');
    }

    // The stock quick settings indicator (network, volume, battery, ...) moves into the tray, stacked vertically.
    // The panel takes indicators back when the session mode changes, so this runs again after every change.
    _stealIndicators() {
        if (!Main.sessionMode.hasWindows || Main.sessionMode.isLocked) return;
        const qs = this._qs;
        if (!qs?.container) return;
        if (!this._qsHome) this._qsHome = qs.container.get_parent();
        moveTo(qs.container, this._tray);
        const box = qs._indicators;
        if (box && box.orientation !== Clutter.Orientation.VERTICAL) { box.orientation = Clutter.Orientation.VERTICAL; this._qsFlipped = box; }
    }

    _restoreIndicators() {
        const qs = this._qs;
        if (this._qsFlipped) { this._qsFlipped.orientation = Clutter.Orientation.HORIZONTAL; this._qsFlipped = null; }
        if (qs?.container && this._qsHome && qs.container.get_parent() === this._tray) moveTo(qs.container, this._qsHome);
        Main.panel._updatePanel?.();
    }

    _queueApps() {
        if (this._appsIdle) return;
        this._appsIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this._appsIdle = 0; safe(() => this._buildApps())(); return GLib.SOURCE_REMOVE; });
    }

    _appList() {
        const favs = AppFavorites.getAppFavorites().getFavorites();
        const running = Shell.AppSystem.get_default().get_running().filter(a => !favs.includes(a));
        return [...favs, ...running];
    }

    _buildApps() {
        const list = this._appList();
        const key = list.map(a => a.get_id()).join('|');
        if (key !== this._key) {
            this._key = key;
            this._apps.destroy_all_children();
            this._btns = new Map();
            for (const app of list) {
                const b = new St.Button({style_class: 'meridian-tb-btn meridian-tb-app', can_focus: true, x_align: Clutter.ActorAlign.CENTER, accessible_name: app.get_name(), button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE});
                const w = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
                const ic = app.create_icon_texture(ICON);
                ic.x_align = ic.y_align = Clutter.ActorAlign.CENTER;
                const mark = new St.Widget({style_class: 'meridian-tb-marker', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER, translation_x: -4 * scale()});
                w.add_child(ic); w.add_child(mark);
                b.set_child(w);
                b.connect('clicked', (_b, btn) => safe(() => this._click(app, btn, b))());
                this._tip.attach(b, () => app.get_name());
                this._apps.add_child(b);
                this._btns.set(app, {b, mark});
            }
        }
        this._syncFocus();
    }

    _syncFocus() {
        const focus = Shell.WindowTracker.get_default().focus_app;
        for (const [app, {b, mark}] of this._btns ?? []) {
            const running = app.state !== Shell.AppState.STOPPED;
            const focused = running && app === focus;
            mark.visible = running;
            b[focused ? 'add_style_class_name' : 'remove_style_class_name']('focused');
            mark[focused ? 'add_style_class_name' : 'remove_style_class_name']('focused');
        }
    }

    _click(app, button, actor) {
        if (button === 3) { this._appMenu(app, actor); return; }
        if (button === 2 || app.state === Shell.AppState.STOPPED) { if (button === 2 && app.can_open_new_window()) app.open_new_window(-1); else app.activate(); return; }
        const wins = app.get_windows().filter(w => !w.skip_taskbar);
        const focus = global.display.focus_window;
        if (wins.length === 1 && focus === wins[0]) { wins[0].minimize(); return; }
        if (wins.length > 1 && wins.includes(focus)) {
            // cycle through the app's windows, least recently used last
            const next = wins[(wins.indexOf(focus) + 1) % wins.length];
            Main.activateWindow(next); return;
        }
        app.activate();
    }

    _appMenu(app, actor) {
        this._ctx?.destroy();
        const menu = new AppMenu(actor, St.Side.LEFT, {favoritesSection: true, showSingleWindows: true});
        menu.setApp(app);
        menu.actor.add_style_class_name('meridian-popover');
        Main.uiGroup.add_child(menu.actor);
        this._menus.addMenu(menu);
        menu.connect('open-state-changed', (_m, open) => { if (!open) GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { if (this._ctx === menu) { menu.destroy(); this._ctx = null; } return GLib.SOURCE_REMOVE; }); });
        this._ctx = menu;
        menu.open();
    }

    destroy() {
        if (this._appsIdle) GLib.Source.remove(this._appsIdle);
        global.display.disconnectObject(this);
        if (this._overlayBlocked) GObject.signal_handlers_unblock_matched(global.display, {signalId: 'overlay-key'});
        for (const o of [AppFavorites.getAppFavorites(), Shell.AppSystem.get_default(), Shell.WindowTracker.get_default(), Main.layoutManager, Main.overview, Main.sessionMode, St.ThemeContext.get_for_stage(global.stage), this._wall]) o?.disconnectObject(this);
        this._inj.clear();
        for (const m of [this._qs?.menu, Main.panel.statusArea.dateMenu?.menu]) {
            const bp = m?._boxPointer;
            if (bp) { bp._arrowSide = bp._userArrowSide = St.Side.TOP; bp.remove_style_class_name('meridian-popover-bar'); }
        }
        this._restoreIndicators();
        this._ctx?.destroy();
        this._startMenu?.destroy();
        this._tip.destroy();
        Main.layoutManager.removeChrome(this.actor); this.actor.destroy();
        Main.layoutManager.removeChrome(this._strut); this._strut.destroy();
    }
}

// ---------------------------------------------------------------- quick settings, Windows 11 layout
// 3 columns of 96x48 tiles with the label under each tile; split tiles (Wi-Fi, Bluetooth) keep the chevron half;
// sliders span the row; the stock system row (battery, settings, lock, power) moves to the bottom as the footer.
class QuickSettingsLayout {
    constructor(inj) {
        this._inj = inj;
        this._qs = Main.panel.statusArea.quickSettings;
        this._done = new Map();
        const menu = this._qs?.menu;
        if (!menu?._grid) return;
        this._menu = menu;
        this._grid = menu._grid;
        this._oldCols = this._grid.layout_manager.nColumns;
        this._grid.layout_manager.nColumns = 3;
        menu.box.add_style_class_name('meridian-qs');
        this._grid.connectObject('child-added', () => this._queue(), this);
        menu.connectObject('open-state-changed', (_m, open) => { if (open) safe(() => this._apply())(); }, this);
        this._apply();
    }
    _queue() {
        if (this._idle) return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this._idle = 0; safe(() => this._apply())(); return GLib.SOURCE_REMOVE; });
    }
    _apply() {
        const lm = this._grid.layout_manager;
        let system = null;
        for (const c of this._grid.get_children()) {
            if (this._done.has(c) || !(c instanceof Clutter.Actor)) continue;
            if (c instanceof QuickSettings.QuickToggle || c instanceof QuickSettings.QuickMenuToggle) { this._tile(c); continue; }
            const span = safe(() => lm.get_child_meta(this._grid, c)?.column_span ?? 1, () => 1)();
            if (span >= 2) {
                this._done.set(c, {span});
                lm.child_set_property(this._grid, c, 'column-span', 3);
                c.add_style_class_name('meridian-qs-wide');
                if (c.constructor?.name?.includes('System') || c.has_style_class_name?.('quick-settings-system-item')) system = c;
            }
        }
        // stock system row -> footer (last row)
        system ??= this._grid.get_children().find(c => c.has_style_class_name?.('quick-settings-system-item'));
        if (system && this._grid.get_last_child() !== system) {
            this._grid.set_child_above_sibling(system, null);
            system.add_style_class_name('meridian-qs-footer');
        }
    }
    _tile(t) {
        const split = t instanceof QuickSettings.QuickMenuToggle;
        const box = t._box;
        if (!box) return;
        const label = new St.Label({style_class: 'meridian-qs-label', x_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = 3;
        const sync = () => { label.text = (t.subtitle && /wi-?fi|wireless/i.test(t.title ?? '') ? t.subtitle : t.title) ?? ''; };
        t.connectObject('notify::title', sync, 'notify::subtitle', sync, this);
        sync();
        const wrap = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'meridian-qs-cell', x_expand: true});
        t.set_child(null);
        wrap.add_child(box);
        wrap.add_child(label);
        t.set_child(wrap);
        box.add_style_class_name('meridian-qs-tile');
        t.add_style_class_name(split ? 'meridian-qs-split' : 'meridian-qs-plain');
        // hide the stock title/subtitle column (the label underneath replaces it)
        const titles = [];
        const inner = split ? box.get_first_child() : t;
        const titleBox = inner?._title?.get_parent();
        if (titleBox) { titleBox.hide(); titles.push(titleBox); }
        if (inner?._icon) { inner._icon.x_expand = true; inner._icon.x_align = Clutter.ActorAlign.CENTER; }
        this._done.set(t, {wrap, box, label, titles});
    }
    destroy() {
        if (this._idle) GLib.Source.remove(this._idle);
        this._grid?.disconnectObject(this); this._menu?.disconnectObject(this);
        for (const [c, d] of this._done) safe(() => {
            if (d.wrap) {
                c.disconnectObject(this);
                d.wrap.remove_child(d.box); c.set_child(d.box); d.wrap.destroy();
                d.box.remove_style_class_name('meridian-qs-tile');
                c.remove_style_class_name('meridian-qs-split'); c.remove_style_class_name('meridian-qs-plain');
                d.titles.forEach(x => x.show());
            } else if (d.span) {
                this._grid.layout_manager.child_set_property(this._grid, c, 'column-span', d.span);
                c.remove_style_class_name('meridian-qs-wide'); c.remove_style_class_name('meridian-qs-footer');
            }
        })();
        this._done.clear();
        if (this._grid && this._oldCols) this._grid.layout_manager.nColumns = this._oldCols;
        this._menu?.box.remove_style_class_name('meridian-qs');
    }
}

// ---------------------------------------------------------------- extension
export default class MeridianShell extends Extension {
    enable() {
        this._inj = new InjectionManager();
        // Overview: workspace previews with the window radius (5 px) instead of GNOME's large rounding.
        const WB = Workspace.WorkspaceBackground?.prototype;
        if (WB?._updateBorderRadius) {
            this._inj.overrideMethod(WB, '_updateBorderRadius', orig => function (...a) {
                orig.apply(this, a);
                safe(() => { const c = this._bgManager?.backgroundActor?.content; if (c) c.rounded_clip_radius = 5 * scale(); })();
            });
        }
        this._lockClock();
        Main.sessionMode.connectObject('updated', () => safe(() => this._sync())(), this);
        Main.layoutManager.connectObject('startup-complete', () => safe(() => this._sync())(),
            'monitors-changed', () => safe(() => this._placePanel())(), this);
        Main.layoutManager.panelBox.connectObject('notify::height', () => safe(() => this._placePanel())(), this);
        safe(() => this._sync())();
    }

    // user mode: taskbar; gdm / unlock-dialog: bottom bar
    _sync() {
        const desktop = Main.sessionMode.currentMode === 'user' || (Main.sessionMode.parentMode === 'user' && !Main.sessionMode.isLocked);
        if (desktop) this._desktopOn(); else this._desktopOff();
        this._placePanel();
        this._hostname(!desktop);
    }

    _desktopOn() {
        if (this._taskbar) return;
        const pb = Main.layoutManager.panelBox;
        // stop the panel reserving space and hide it (it stays alive: its indicators and menus are reused)
        Main.layoutManager.untrackChrome(pb);
        Main.layoutManager.trackChrome(pb, {affectsStruts: false, trackFullscreen: false, affectsInputRegion: true});
        pb.hide();
        this._panelHidden = true;
        this._tiles = new MeridianTiles();
        Main.panel.statusArea.quickSettings?.addExternalIndicator?.(this._tiles);
        this._taskbar = new Taskbar(this);
        this._qsLayout = new QuickSettingsLayout(this._inj);
        this._banner = Main.messageTray.bannerAlignment;
        Main.messageTray.bannerAlignment = Clutter.ActorAlign.END;
    }

    _desktopOff() {
        if (!this._taskbar && !this._panelHidden) return;
        safe(() => this._qsLayout?.destroy())(); this._qsLayout = null;
        safe(() => this._taskbar?.destroy())(); this._taskbar = null;
        safe(() => this._tiles?.destroy())(); this._tiles = null;
        if (this._banner !== undefined) { Main.messageTray.bannerAlignment = this._banner; this._banner = undefined; }
        if (this._panelHidden) {
            const pb = Main.layoutManager.panelBox;
            Main.layoutManager.untrackChrome(pb);
            Main.layoutManager.trackChrome(pb, {affectsStruts: true, trackFullscreen: true, affectsInputRegion: true});
            pb.show();
            this._panelHidden = false;
        }
    }

    // sign-in and lock: the stock bar moves to the bottom edge (transparent via the stylesheet)
    _placePanel() {
        const pb = Main.layoutManager.panelBox, m = Main.layoutManager.primaryMonitor;
        if (!m || this._taskbar) { if (pb.translation_y > 0) pb.translation_y = 0; Main.panel.remove_style_class_name('meridian-bottom'); return; }
        if (Main.layoutManager._startingUp) return;
        pb.translation_y = Math.max(0, m.height - pb.height);
        Main.panel.add_style_class_name('meridian-bottom');
    }

    _hostname(on) {
        if (on && !this._host) {
            this._host = new St.Label({text: GLib.get_host_name(), style_class: 'meridian-hostname', y_align: Clutter.ActorAlign.CENTER});
            Main.panel._leftBox.insert_child_at_index(this._host, 0);
        } else if (!on && this._host) { this._host.destroy(); this._host = null; }
    }

    // Lock: the clock and date sit top-left; the hint moves to the bottom-left with the Meridian wording.
    _lockClock() {
        const UD = UnlockDialog.UnlockDialog?.prototype;
        if (!UD) return;
        const self = this;
        this._inj.overrideMethod(UD, '_setTransitionProgress', orig => function (p) {
            orig.call(this, p);
            safe(() => self._hookLock(this))();
        });
        const SS = Main.screenShield?.constructor?.prototype;
        if (SS?._ensureUnlockDialog) {
            this._inj.overrideMethod(SS, '_ensureUnlockDialog', orig => function (...a) {
                const r = orig.apply(this, a);
                safe(() => self._hookLock(this._dialog))();
                return r;
            });
        }
    }

    _hookLock(dialog) {
        const clock = dialog?._clock;
        if (!clock || clock._meridianHooked) return;
        clock._meridianHooked = true;
        const relayout = () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { safe(() => this._layoutLock(dialog))(); return GLib.SOURCE_REMOVE; });
        for (const a of [clock, clock._time, clock._date, clock._hint, dialog]) a?.connectObject('notify::allocation', relayout, this);
        relayout();
    }

    _layoutLock(dialog) {
        const clock = dialog._clock;
        if (!clock) return;
        const s = scale();
        if (!clock._meridian) {
            clock._meridian = true;
            clock.add_style_class_name('meridian-lock-clock');
            for (const l of [clock._time, clock._date]) if (l) l.x_align = Clutter.ActorAlign.START;
            const hint = clock._hint;
            if (hint) {
                hint.text = 'Press any key or connect your Ledger to unlock';
                hint.connectObject('notify::text', () => { if (hint.text !== 'Press any key or connect your Ledger to unlock') hint.text = 'Press any key or connect your Ledger to unlock'; }, this);
            }
        }
        // translate (no relayout): time/date to (48, 40), hint to (48, bottom - 40)
        const [dx] = dialog.get_transformed_position();
        const t = clock._time, d = clock._date, h = clock._hint;
        const place = (a, x, y) => {
            if (!a?.has_allocation()) return;
            const [ax, ay] = a.get_transformed_position();
            a.translation_x += Math.round(x - ax); a.translation_y += Math.round(y - ay);
        };
        const [, dyy] = dialog.get_transformed_position();
        place(t, dx + 48 * s, dyy + 40 * s);
        if (t && d) place(d, dx + 48 * s, dyy + 40 * s + t.height + 4 * s);
        if (h) place(h, dx + 48 * s, dyy + dialog.height - 40 * s - h.height);
    }

    disable() {
        // Runs in unlock-dialog mode too (session-modes include it): undo everything, the stock shell stays.
        Main.sessionMode.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        this._desktopOff();
        this._hostname(false);
        const pb = Main.layoutManager.panelBox; pb.translation_y = 0; Main.panel.remove_style_class_name('meridian-bottom');
        this._inj?.clear(); this._inj = null;
    }
}
