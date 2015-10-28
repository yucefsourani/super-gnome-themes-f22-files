const Lang = imports.lang;
const St = imports.gi.St;
const Main = imports.ui.main;
const Clutter = imports.gi.Clutter;
const ModalDialog = imports.ui.modalDialog;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;
const PrefsKeys = Me.imports.prefs_keys;

const HelpDialog = new Lang.Class({
    Name: 'HelpDialog',
    Extends: ModalDialog.ModalDialog,

    _init: function() {
        this.parent();

        this._dialogLayout = 
            typeof this.dialogLayout === "undefined"
            ? this._dialogLayout
            : this.dialogLayout;
        this._dialogLayout.connect('key-press-event', Lang.bind(this,
            this._on_key_press_event
        ));
        this._dialogLayout.set_style_class_name('translator-help-box');

        this._label = new St.Label({
            style_class: 'translator-help-text'
        });
        this._label.clutter_text.set_line_wrap(true);

        let markup =
            "<span size='x-large'>Shortcuts:</span>\n" +
            "<b>&lt;Super&gt;T</b> - open translator dialog.\n" +
            "<b>&lt;Super&gt;&lt;Shift&gt;T</b> - open translator dialog and " +
            "translate text from clipboard.\n" +
            "<b>&lt;Super&gt;&lt;Alt&gt;T</b> - open translator dialog and translate " +
            "from primary selection.\n<b>&lt;Ctrl&gt;&lt;Enter&gt;</b> - " +
            "Translate text.\n<b>&lt;Ctrl&gt;&lt;Shift&gt;C</b> - copy translated " +
            "text to clipboard.\n<b>&lt;Ctrl&gt;S</b> - swap languages.\n" +
            "<b>&lt;Ctrl&gt;D</b> - reset languages to default.\n" +
            "<b>&lt;Tab&gt;</b> - toggle transliteration of result text.\n" +
            "<b>&lt;Escape&gt;</b> - close dialog";
        this._label.clutter_text.set_markup(markup);

        this._close_button = this._get_close_button();

        this.contentLayout.add(this._close_button, {
            x_fill: false,
            x_align: St.Align.END,
            y_fill: false,
            y_align: St.Align.START
        });
        this.contentLayout.add(this._label, {
            x_fill: false,
            x_align: St.Align.START,
            y_fill: false,
            y_align: St.Align.END
        });
    },

    _on_key_press_event: function(object, event) {
        let symbol = event.get_key_symbol();

        if(symbol == Clutter.Escape) {
            this.close();
        }
    },

    _get_close_button: function() {
        let icon = new St.Icon({
            icon_name: Utils.ICONS.close,
            icon_size: 20,
            style: 'color: grey;'
        });

        let button = new St.Button({
            reactive: true
        });
        button.connect('clicked', Lang.bind(this, function() {
            this.close();
        }));
        button.add_actor(icon);

        return button;
    },

    _resize: function() {
        let width_percents = Utils.SETTINGS.get_int(PrefsKeys.WIDTH_PERCENTS_KEY);
        let height_percents = Utils.SETTINGS.get_int(PrefsKeys.HEIGHT_PERCENTS_KEY);
        let primary = Main.layoutManager.primaryMonitor;

        let translator_width = Math.round(primary.width / 100 * width_percents);
        let translator_height = Math.round(primary.height / 100 * height_percents);

        let help_width = Math.round(translator_width * 0.9);
        let help_height = Math.round(translator_height * 0.9);
        this._dialogLayout.set_width(help_width);
        this._dialogLayout.set_height(help_height);
    },

    close: function() {
        this.parent();
        this.destroy();
    },

    open: function() {
        this._resize()
        this.parent()
    },
});
