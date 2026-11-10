/*
 * Zone Clocks — a Cinnamon applet that shows several clocks for different
 * time zones side by side in the panel.
 *
 * Clocks are managed in the applet settings (right-click → Configure…):
 * each one has a name, a time zone and a color and can be added, edited,
 * removed, reordered or temporarily hidden.
 */

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;
const CinnamonDesktop = imports.gi.CinnamonDesktop;
const ByteArray = imports.byteArray;
const Gettext = imports.gettext;

const UUID = "zoneclocks@skde";
const TZDATA_FILE = "/usr/share/zoneinfo/tzdata.zi";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(str) {
    return Gettext.dgettext(UUID, str);
}

/* Well known cities that are not time zone names themselves. */
const CITY_ALIASES = {
    "beijing": "Asia/Shanghai",
    "delhi": "Asia/Kolkata",
    "new delhi": "Asia/Kolkata",
    "mumbai": "Asia/Kolkata",
    "bangalore": "Asia/Kolkata",
    "bengaluru": "Asia/Kolkata",
    "osaka": "Asia/Tokyo",
    "tel aviv": "Asia/Jerusalem",
    "san francisco": "America/Los_Angeles",
    "seattle": "America/Los_Angeles",
    "silicon valley": "America/Los_Angeles",
    "boston": "America/New_York",
    "washington": "America/New_York",
    "miami": "America/New_York",
    "nyc": "America/New_York",
    "austin": "America/Chicago",
    "dallas": "America/Chicago",
    "houston": "America/Chicago",
    "montreal": "America/Toronto",
    "rio": "America/Sao_Paulo",
    "rio de janeiro": "America/Sao_Paulo",
    "cdmx": "America/Mexico_City",
    "frankfurt": "Europe/Berlin",
    "munich": "Europe/Berlin",
    "hamburg": "Europe/Berlin",
    "milan": "Europe/Rome",
    "barcelona": "Europe/Madrid",
    "geneva": "Europe/Zurich",
    "krakow": "Europe/Warsaw",
    "st petersburg": "Europe/Moscow",
    "wellington": "Pacific/Auckland",
    "cape town": "Africa/Johannesburg",
};

function pad2(n) {
    return (n < 10 ? "0" : "") + n;
}

/* "+3", "-4", "+5:30" for an offset given in seconds. */
function offsetString(seconds) {
    let sign = seconds < 0 ? "-" : "+";
    let abs = Math.abs(Math.round(seconds));
    let h = Math.floor(abs / 3600);
    let m = Math.round((abs % 3600) / 60);
    return sign + h + (m ? ":" + pad2(m) : "");
}

/* Whole days between the calendar date of `dt` and the calendar date of `ref`. */
function dayOffset(dt, ref) {
    let a = Date.UTC(dt.get_year(), dt.get_month() - 1, dt.get_day_of_month());
    let b = Date.UTC(ref.get_year(), ref.get_month() - 1, ref.get_day_of_month());
    return Math.round((a - b) / 86400000);
}

/* Returns "#rrggbb" for any CSS color string Clutter understands, or null. */
function parseColor(str) {
    if (!str) return null;
    str = String(str).trim();
    if (!str) return null;
    try {
        let [ok, color] = Clutter.Color.from_string(str);
        if (!ok) return null;
        return "#" + [color.red, color.green, color.blue]
            .map(v => (v < 16 ? "0" : "") + v.toString(16)).join("");
    } catch (e) {
        return /^#[0-9a-f]{6}$/i.test(str) ? str : null;
    }
}

/*
 * Resolves what the user typed into a GLib.TimeZone.
 * Accepts IANA names (Europe/London), case-insensitive city names
 * ("new york", "berlin"), well known aliases and UTC offsets (UTC+3, -05:30).
 */
class ZoneIndex {
    constructor() {
        this._byKey = new Map();
        this._loaded = false;
    }

    _load() {
        if (this._loaded) return;
        this._loaded = true;
        let zones = [];
        let links = [];
        try {
            let [ok, bytes] = GLib.file_get_contents(TZDATA_FILE);
            if (ok) {
                for (let line of ByteArray.toString(bytes).split("\n")) {
                    let parts = line.split(/\s+/);
                    if (parts[0] === "Z" && parts[1]) zones.push(parts[1]);
                    else if (parts[0] === "L" && parts[2]) links.push(parts[2]);
                }
            }
        } catch (e) {
            global.logWarning(`${UUID}: cannot read ${TZDATA_FILE}: ${e}`);
        }
        // Canonical zones first so that they win over aliases for the same city.
        for (let name of zones) this._add(name);
        for (let name of links) this._add(name);
    }

    _add(name) {
        let full = name.toLowerCase();
        if (!this._byKey.has(full)) this._byKey.set(full, name);
        let city = full.split("/").pop().replace(/_/g, " ");
        if (!this._byKey.has(city)) this._byKey.set(city, name);
    }

    resolve(input) {
        let s = (input || "").toString().trim();
        if (!s) return null;

        // Explicit offsets: UTC+3, GMT-5:30, +03:00, -0500.
        // GLib would read "UTC+3" with the POSIX (inverted) sign, so build the
        // ISO form ourselves.
        let m = s.match(/^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
        if (m) {
            let h = parseInt(m[2], 10);
            let min = m[3] ? parseInt(m[3], 10) : 0;
            if (h <= 14 && min < 60) {
                let tz = GLib.TimeZone.new_identifier(`${m[1]}${pad2(h)}:${pad2(min)}`);
                if (tz) return { id: "UTC" + m[1] + h + (min ? ":" + pad2(min) : ""), tz };
            }
        }

        // Exact identifier (IANA name, "UTC", POSIX string...).
        let tz = GLib.TimeZone.new_identifier(s);
        if (tz) return { id: s, tz };

        // Case-insensitive name or city lookup.
        this._load();
        let key = s.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
        let name = this._byKey.get(key)
            || this._byKey.get(key.replace(/ /g, "_"))
            || CITY_ALIASES[key];
        if (name) {
            tz = GLib.TimeZone.new_identifier(name);
            if (tz) return { id: name, tz };
        }
        return null;
    }
}

/* One clock in the panel. */
class ClockItem {
    constructor(cfg, resolved, opts) {
        this.zoneText = (cfg.timezone || "").toString().trim();
        this.tz = resolved ? resolved.tz : null;
        this.zoneId = resolved ? resolved.id : null;
        this.name = (cfg.name || "").toString().trim()
            || (this.zoneId ? this.zoneId.split("/").pop().replace(/_/g, " ") : _("Clock"));
        this.color = parseColor(cfg.color);

        let colorStyle = this.color ? `color: ${this.color};` : "";
        let mode = this.color ? (opts.colorMode || "all") : "none";
        let labelProps = { y_align: Clutter.ActorAlign.CENTER, y_expand: true };

        this.actor = new St.BoxLayout({ style_class: "zoneclocks-item", vertical: opts.vertical });

        if (mode === "dot") {
            this.dot = new St.Label(Object.assign({ text: "●", style_class: "zoneclocks-dot", style: colorStyle }, labelProps));
            this.actor.add_actor(this.dot);
        }
        if (opts.showNames) {
            this.nameLabel = new St.Label(Object.assign({ text: this.name, style_class: "zoneclocks-name" }, labelProps));
            if (mode === "all" || mode === "name") this.nameLabel.set_style(colorStyle);
            this.actor.add_actor(this.nameLabel);
        }
        this.timeLabel = new St.Label(Object.assign({ text: "--:--", style_class: "zoneclocks-time" }, labelProps));
        if (mode === "all") this.timeLabel.set_style(colorStyle);
        this.actor.add_actor(this.timeLabel);
    }

    update(now, format, showDayOffset) {
        if (!this.tz) {
            this.timeLabel.set_text("?");
            return;
        }
        let dt = now.to_timezone(this.tz);
        let text = dt.format(format);
        if (text === null) text = _("~format error~");
        if (showDayOffset) {
            let d = dayOffset(dt, now);
            if (d !== 0) text += (d > 0 ? " +" : " ") + d + "d";
        }
        this.timeLabel.set_text(text);
    }

    tooltipLine(now, format) {
        if (!this.tz) return `${this.name}: ${_("unknown time zone")} "${this.zoneText}"`;
        let dt = now.to_timezone(this.tz);
        return `${this.name}: ${dt.format(format)}  ${dt.format("%a %-d %b")}  (UTC${offsetString(dt.get_utc_offset() / 1e6)})`;
    }
}

/* One row in the popup menu with the full date and offsets of a clock. */
class ClockMenuRow extends PopupMenu.PopupBaseMenuItem {
    constructor(item) {
        super({ reactive: false });
        this.item = item;

        let left = new St.BoxLayout({ vertical: true, style_class: "zoneclocks-menu-left" });
        this.nameLabel = new St.Label({ text: item.name, style_class: "zoneclocks-menu-name" });
        if (item.color) this.nameLabel.set_style(`color: ${item.color};`);
        this.zoneLabel = new St.Label({ text: item.zoneId || item.zoneText, style_class: "zoneclocks-menu-zone" });
        left.add_actor(this.nameLabel);
        left.add_actor(this.zoneLabel);

        let right = new St.BoxLayout({ vertical: true, style_class: "zoneclocks-menu-right" });
        this.timeLabel = new St.Label({ text: "", style_class: "zoneclocks-menu-time", x_align: Clutter.ActorAlign.END });
        this.detailLabel = new St.Label({ text: "", style_class: "zoneclocks-menu-detail", x_align: Clutter.ActorAlign.END });
        right.add_actor(this.timeLabel);
        right.add_actor(this.detailLabel);

        this.addActor(left, { expand: true });
        this.addActor(right, { align: St.Align.END });
    }

    update(now, format) {
        if (!this.item.tz) {
            this.timeLabel.set_text("—");
            this.detailLabel.set_text(_("Unknown time zone"));
            return;
        }
        let dt = now.to_timezone(this.item.tz);
        this.timeLabel.set_text(dt.format(format) || "?");
        let utc = offsetString(dt.get_utc_offset() / 1e6);
        let rel = (dt.get_utc_offset() - now.get_utc_offset()) / 1e6;
        let relText = rel === 0 ? _("same as local time") : `${offsetString(rel)}h ${_("vs local")}`;
        let d = dayOffset(dt, now);
        let dayText = d === 0 ? "" : (d > 0 ? ` (${_("tomorrow")})` : ` (${_("yesterday")})`);
        this.detailLabel.set_text(`${dt.format("%A, %-d %B")}${dayText}  ·  UTC${utc}  ·  ${relText}`);
    }
}

class ZoneClocksApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this._orientation = orientation;
        this._items = [];
        this._rows = [];
        this._zones = new ZoneIndex();
        this._format = "%H:%M";
        this._menuFormat = "%H:%M:%S";

        this._box = new St.BoxLayout({ style_class: "zoneclocks-box" });
        this.actor.add_actor(this._box);

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.connect("open-state-changed", (menu, open) => {
            if (open) this._update();
        });

        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        this.settings.bind("clocks", "clocks", () => this._rebuild());
        this.settings.bind("time-format", "timeFormat", () => this._rebuild());
        this.settings.bind("show-seconds", "showSeconds", () => this._rebuild());
        this.settings.bind("show-day-offset", "showDayOffset", () => this._update());
        this.settings.bind("custom-format", "customFormat", () => this._rebuild());
        this.settings.bind("show-names", "showNames", () => this._rebuild());
        this.settings.bind("color-mode", "colorMode", () => this._rebuild());
        this.settings.bind("spacing", "spacing", () => this._rebuild());

        this._ifaceSettings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });
        this._ifaceSettingsId = this._ifaceSettings.connect("changed::clock-use-24h", () => this._rebuild());

        // WallClock fires notify::clock once a minute, or once a second when
        // its format string contains seconds. It also follows time zone changes.
        this._wallClock = new CinnamonDesktop.WallClock();
        this._wallClockId = this._wallClock.connect("notify::clock", () => this._update());

        // Refresh right after a suspend/resume cycle instead of waiting for the next tick.
        this._sleepId = Gio.DBus.system.signal_subscribe(
            "org.freedesktop.login1", "org.freedesktop.login1.Manager", "PrepareForSleep",
            "/org/freedesktop/login1", null, Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                let [sleeping] = params.deep_unpack();
                if (!sleeping) this._update();
            });

        this._rebuild();
    }

    _computeFormats() {
        let custom = (this.customFormat || "").trim();
        if (custom) {
            this._format = custom;
            this._menuFormat = custom;
            return /%[STrcXs]/.test(custom);
        }
        let use24 = this.timeFormat === "24h"
            || (this.timeFormat !== "12h" && this._ifaceSettings.get_boolean("clock-use-24h"));
        let hour = use24 ? "%H:%M" : "%-l:%M";
        let suffix = use24 ? "" : " %p";
        this._format = hour + (this.showSeconds ? ":%S" : "") + suffix;
        this._menuFormat = hour + ":%S" + suffix;
        return !!this.showSeconds;
    }

    _rebuild() {
        this._box.destroy_all_children();
        this._items = [];
        this.menu.removeAll();
        this._rows = [];

        let needSeconds = this._computeFormats();
        this._wallClock.set_format_string(needSeconds ? "%H:%M:%S" : "%H:%M");

        let vertical = this._orientation === St.Side.LEFT || this._orientation === St.Side.RIGHT;
        let spacing = Number.isFinite(this.spacing) ? this.spacing : 10;
        this._box.set_vertical(vertical);
        this._box.set_style(`spacing: ${vertical ? Math.round(spacing / 2) : spacing}px;`);

        let opts = { vertical, showNames: this.showNames, colorMode: this.colorMode };
        let configs = Array.isArray(this.clocks) ? this.clocks : [];
        for (let cfg of configs) {
            if (!cfg || cfg.enabled === false) continue;
            let item = new ClockItem(cfg, this._zones.resolve(cfg.timezone), opts);
            this._items.push(item);
            this._box.add_actor(item.actor);
            let row = new ClockMenuRow(item);
            this._rows.push(row);
            this.menu.addMenuItem(row);
        }

        if (this._items.length === 0) {
            this._box.add_actor(new St.Label({
                text: _("No clocks"),
                style_class: "zoneclocks-placeholder",
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
            }));
            let empty = new PopupMenu.PopupMenuItem(_("No clocks configured yet"), { reactive: false });
            this.menu.addMenuItem(empty);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_("Configure clocks…"), () => this.configureApplet());

        this._update();
    }

    _update() {
        let now = GLib.DateTime.new_now_local();
        let tooltip = [];
        for (let item of this._items) {
            item.update(now, this._format, this.showDayOffset);
            tooltip.push(item.tooltipLine(now, this._format));
        }
        this.set_applet_tooltip(tooltip.length ? tooltip.join("\n") : _("Zone Clocks: right-click to configure"));
        if (this.menu.isOpen) {
            for (let row of this._rows) row.update(now, this._menuFormat);
        }
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_orientation_changed(orientation) {
        this._orientation = orientation;
        this._rebuild();
    }

    on_applet_removed_from_panel() {
        if (this._wallClockId) {
            this._wallClock.disconnect(this._wallClockId);
            this._wallClockId = 0;
        }
        if (this._ifaceSettingsId) {
            this._ifaceSettings.disconnect(this._ifaceSettingsId);
            this._ifaceSettingsId = 0;
        }
        if (this._sleepId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepId);
            this._sleepId = 0;
        }
        this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ZoneClocksApplet(metadata, orientation, panelHeight, instanceId);
}
