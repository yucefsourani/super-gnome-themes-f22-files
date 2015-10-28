/* ========================================================================================================
 * dockedWorkspaces.js - dock object that holds the workspaces thumbnailsBox
 * --------------------------------------------------------------------------------------------------------
 *  CREDITS:  This code was copied from the dash-to-dock extension https://github.com/micheleg/dash-to-dock
 *  and modified to create a workspaces dock. Many thanks to michele_g for a great extension.
 *
 *  Part of this code also comes from gnome-shell-extensions:
 *  http://git.gnome.org/browse/gnome-shell-extensions/
 * ========================================================================================================
 */


const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const IconTheme = imports.gi.Gtk.IconTheme;
const Params = imports.misc.params;

const Main = imports.ui.main;
const WorkspacesView = imports.ui.workspacesView;
const WorkspaceThumbnail = imports.ui.workspaceThumbnail;
const Tweener = imports.ui.tweener;
const WorkspaceSwitcherPopup = imports.ui.workspaceSwitcherPopup;
const OverviewControls = imports.ui.overviewControls;
const Layout = imports.ui.layout;
const MessageTray = imports.ui.messageTray;

const ExtensionSystem = imports.ui.extensionSystem;
const ExtensionUtils = imports.misc.extensionUtils;
const Config = imports.misc.config;
const Me = ExtensionUtils.getCurrentExtension();
const Extension = Me.imports.extension;
const Convenience = Me.imports.convenience;
const MyWorkspaceThumbnail = Me.imports.myWorkspaceThumbnail;
const ShortcutsPanel = Me.imports.shortcutsPanel;

const DashToDock_UUID = "dash-to-dock@micxgx.gmail.com";
let DashToDockExtension = null;
let DashToDock = null;

const TRIGGER_WIDTH = 1;
const DOCK_EDGE_VISIBLE_WIDTH = 5;
const PRESSURE_TIMEOUT = 1000;

let GSFunctions = {};

/* Return the actual position reverseing left and right in rtl */
function getPosition(settings) {
    let position = settings.get_enum('dock-position');
    if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL) {
        if (position == St.Side.LEFT)
            position = St.Side.RIGHT;
        else if (position == St.Side.RIGHT)
            position = St.Side.LEFT;
    }
    return position;
}

const ThumbnailsSlider = new Lang.Class({
    Name: 'workspacestodockThumbnailsSlider',
    Extends: Clutter.Actor,

    _init: function(params) {
        this._settings = Convenience.getSettings('org.gnome.shell.extensions.workspaces-to-dock');

        /* Default local params */
        let localDefaults = {
            side: St.Side.LEFT,
            initialSlideValue: 1,
            initialSlideoutSize: TRIGGER_WIDTH
        }

        let localParams = Params.parse(params, localDefaults, true);

        if (params){
            /* Remove local params before passing the params to the parent
              constructor to avoid errors. */
            let prop;
            for (prop in localDefaults) {
                if ((prop in params))
                    delete params[prop];
            }
        }

        this.parent(params);

        this._child = null;

        // slide parameter: 1 = visible, 0 = hidden.
        this._slidex = localParams.initialSlideValue;
        this._side = localParams.side;
        this._slideoutSize = localParams.initialSlideoutSize; // minimum size when slid out
    },


    vfunc_allocate: function(box, flags) {

        this.set_allocation(box, flags);

        if (this._child == null)
            return;

        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        let [minChildWidth, minChildHeight, natChildWidth, natChildHeight] =
            this._child.get_preferred_size();

        let childWidth = natChildWidth;
        let childHeight = natChildHeight;

        let childBox = new Clutter.ActorBox();

        let slideoutSize = this._slideoutSize;

        if (this._side == St.Side.LEFT) {
            childBox.x1 = (this._slidex -1) * (childWidth - slideoutSize);
            childBox.x2 = slideoutSize + this._slidex * (childWidth - slideoutSize);
            childBox.y1 = 0;
            childBox.y2 = childBox.y1 + childHeight;
        } else if (this._side ==  St.Side.RIGHT
                 || this._side ==  St.Side.BOTTOM) {
            childBox.x1 = 0;
            childBox.x2 = childWidth;
            childBox.y1 = 0;
            childBox.y2 = childBox.y1 + childHeight;
        } else if (this._side ==  St.Side.TOP) {
            childBox.x1 = 0;
            childBox.x2 = childWidth;
            childBox.y1 = (this._slidex -1) * (childHeight - slideoutSize);
            childBox.y2 = slideoutSize + this._slidex * (childHeight - slideoutSize);
        }

        this._child.allocate(childBox, flags);
        this._child.set_clip(-childBox.x1, -childBox.y1,
                             -childBox.x1+availWidth,-childBox.y1 + availHeight);
    },

    /* Just the child width but taking into account the slided out part */
    vfunc_get_preferred_width: function(forHeight) {
        let [minWidth, natWidth ] = this._child.get_preferred_width(forHeight);
        if (this._side ==  St.Side.LEFT
          || this._side == St.Side.RIGHT) {
            minWidth = (minWidth - this._slideoutSize)*this._slidex + this._slideoutSize;
            natWidth = (natWidth - this._slideoutSize)*this._slidex + this._slideoutSize;
        }
        return [minWidth, natWidth];
    },

    /* Just the child height but taking into account the slided out part */
    vfunc_get_preferred_height: function(forWidth) {
        let [minHeight, natHeight] = this._child.get_preferred_height(forWidth);
        if (this._side ==  St.Side.TOP
          || this._side ==  St.Side.BOTTOM) {
            minHeight = (minHeight - this._slideoutSize)*this._slidex + this._slideoutSize;
            natHeight = (natHeight - this._slideoutSize)*this._slidex + this._slideoutSize;
        }
        return [minHeight, natHeight];
    },

    /* I was expecting it to be a virtual function... stil I don't understand
      how things work.
    */
    add_child: function(actor) {

        /* I'm supposed to have only on child */
        if(this._child !== null) {
            this.remove_child(actor);
        }

        this._child = actor;
        this.parent(actor);
    },

    set slidex(value) {
        this._slidex = value;
        this._child.queue_relayout();
    },

    get slidex() {
        return this._slidex;
    },

    set slideoutSize(value) {
        this._slideoutSize = value;
    }
});

const DockedWorkspaces = new Lang.Class({
    Name: 'workspacestodockDockedWorkspaces',

    _init: function() {
        this._gsCurrentVersion = Config.PACKAGE_VERSION.split('.');
        this._settings = Convenience.getSettings('org.gnome.shell.extensions.workspaces-to-dock');
        this._signalHandler = new Convenience.globalSignalHandler();

        // temporarily disable redisplay until initialized (prevents connected signals from trying to update dock visibility)
        this._disableRedisplay = true;
        this._refreshThumbnailsOnRegionUpdate = true;

        // set RTL value
        this._rtl = Clutter.get_default_text_direction() == Clutter.TextDirection.RTL;

        // Load settings
        this._bindSettingsChanges();

        // Set position of dock
        this._position = getPosition(this._settings);
        this._isHorizontal = (this._position == St.Side.TOP ||
                              this._position == St.Side.BOTTOM);

        // Authohide current status. Not to be confused with autohide enable/disagle global (g)settings
        // Initially set to null - will be set during first enable/disable autohide
        this._autohideStatus = null;

        // initialize animation status object
        this._animStatus = new AnimationStatus(true);

        // initialize popup menu flag
        this._popupMenuShowing = false;

        // initialize colors with generic values
        this._defaultBackground = {red:0, green:0, blue:0};
        this._customBackground = {red:0, green:0, blue:0};
        this._cssStylesheet = null;

        // Initialize pressure barrier variables
        this._canUsePressure = false;
        this._pressureSensed = false;
        this._pressureBarrier = null;
        this._barrier = null;
        this._messageTrayShowing = false;
        this._removeBarrierTimeoutId = 0;

        // Override Gnome Shell functions
        this._overrideGnomeShellFunctions();

        // Create a new thumbnailsbox object
        this._thumbnailsBox = new MyWorkspaceThumbnail.myThumbnailsBox(this);
        if (this._gsCurrentVersion[1] == 10 && this._gsCurrentVersion[2] && this._gsCurrentVersion[2] == 0) {
            this._thumbnailsBoxBackground = this._thumbnailsBox._background;
        } else {
            this._thumbnailsBoxBackground = this._thumbnailsBox.actor;
        }

        this._shortcutsPanel = new ShortcutsPanel.ShortcutsPanel(this);

        // Create the main dock container, turn on track hover, add hoverChange signal
        let positionStyleClass = ['top', 'right', 'bottom', 'left'];
        let styleClass = positionStyleClass[this._position];
        if (this._settings.get_boolean('dock-fixed'))
            styleClass += " fixed";

        let shortcutsPanelOrientation = this._settings.get_enum('shortcuts-panel-orientation');
        if (shortcutsPanelOrientation == 1) {
            styleClass += " inside";
        }

        if (this._settings.get_boolean('extend-height') && this._settings.get_double('top-margin') == 0) {
            styleClass += " fullheight";
        }

        this._dock = new St.BoxLayout({
            name: 'workspacestodockContainer',
            reactive: true,
            track_hover: true,
            style_class: styleClass
        });
        this._dock.connect("notify::hover", Lang.bind(this, this._hoverChanged));
        this._dock.connect("scroll-event", Lang.bind(this, this._onScrollEvent));
        this._dock.connect("button-release-event", Lang.bind(this, this._onDockClicked));

        // Create the wrapper container
        let align;
        if (this._isHorizontal) {
            align = St.Align.MIDDLE;
        } else {
            if (this._position == St.Side.LEFT) {
                align = St.Align.START;
            } else {
                align = St.Align.END;
            }
        }

        this.actor = new St.Bin({ name: 'workspacestodockContainerWrapper',reactive: false,
            // style_class:positionStyleClass[this._position],
            x_align: align,
            y_align: align
        });
        this.actor._delegate = this;
        this._realizeId = this.actor.connect("realize", Lang.bind(this, this._initialize));

        // Put dock on the primary monitor
        this._monitor = Main.layoutManager.primaryMonitor;

        // Connect global signals
        this._signalHandler.push(
            [
                this._thumbnailsBoxBackground,
                'notify::width',
                Lang.bind(this, this._thumbnailsBoxResized)
            ],
            [
                Main.layoutManager,
                'monitors-changed',
                Lang.bind(this, this._onMonitorsChanged)
            ],
            [
                St.ThemeContext.get_for_stage(global.stage),
                'changed',
                Lang.bind(this, this._onThemeChanged)
            ],
            [
                IconTheme.get_default(),
                'changed',
                Lang.bind(this, this._onIconsChanged)
            ],
            [
                ExtensionSystem._signals,
                'extension-state-changed',
                Lang.bind(this, this._onExtensionSystemStateChanged)
            ],
            [
                Main.overview.viewSelector,
                'notify::y',
                Lang.bind(this, this._updateYPosition)
            ],
            [
                global.screen,
                'in-fullscreen-changed',
                Lang.bind(this, this._updateBarrier)
            ]
        );

        // Bind keyboard shortcuts
        if (this._settings.get_boolean('toggle-dock-with-keyboard-shortcut'))
            this._bindDockKeyboardShortcut();

        // Connect DashToDock hover signal if the extension is already loaded and enabled
        this._hoveringDash = false;
        DashToDockExtension = ExtensionUtils.extensions[DashToDock_UUID];
        if (DashToDockExtension) {
            if (DashToDockExtension.state == ExtensionSystem.ExtensionState.ENABLED) {
                DashToDock = DashToDockExtension.imports.extension;
                if (DashToDock && DashToDock.dock) {
                    var keys = DashToDock.dock._settings.list_keys();
                    if (keys.indexOf('dock-position') > -1) {
                        DashToDockExtension.hasDockPositionKey = true;
                    }
                    // Connect DashToDock hover signal
                    this._signalHandler.pushWithLabel(
                        'DashToDockHoverSignal',
                        [
                            DashToDock.dock._box,
                            'notify::hover',
                            Lang.bind(this, this._onDashToDockHoverChanged)
                        ],
                        [
                            DashToDock.dock._box,
                            'leave-event',
                            Lang.bind(this, this._onDashToDockLeave)
                        ],
                        [
                            DashToDock.dock,
                            'showing',
                            Lang.bind(this, this._onDashToDockShowing)
                        ],
                        [
                            DashToDock.dock,
                            'hiding',
                            Lang.bind(this, this._onDashToDockHiding)
                        ]
                    );
                }
            }
        }

        // This is the sliding actor whose allocation is to be tracked for input regions
        let slideoutSize = TRIGGER_WIDTH;
        if (this._settings.get_boolean('dock-edge-visible')) {
            slideoutSize = TRIGGER_WIDTH + DOCK_EDGE_VISIBLE_WIDTH;
        }
        this._slider = new ThumbnailsSlider({side: this._position, initialSlideoutSize: slideoutSize});

        // Create trigger spacer
        this._triggerSpacer = new St.Label({
                            name: 'workspacestodockTriggerSpacer',
                            text: ''
                        });
        this._triggerSpacer.width = TRIGGER_WIDTH;
        if (this._settings.get_boolean('dock-fixed'))
            this._triggerSpacer.width = 0;

        // Add spacer, workspaces, and shortcuts panel to dock container based on dock position
        // and shortcuts panel orientation
        if (this._position == St.Side.RIGHT) {
            this._dock.add_actor(this._triggerSpacer);
        }
        if ((this._position == St.Side.LEFT && shortcutsPanelOrientation == 0) ||
            (this._position == St.Side.RIGHT && shortcutsPanelOrientation == 1)) {
            this._dock.add_actor(this._shortcutsPanel.actor);
            this._dock.add_actor(this._thumbnailsBox.actor);
        } else {
            this._dock.add_actor(this._thumbnailsBox.actor);
            this._dock.add_actor(this._shortcutsPanel.actor);
        }
        if (this._position == St.Side.LEFT) {
            this._dock.add_actor(this._triggerSpacer);
        }

        // Add dock to slider and main container actor and then to the Chrome.
        this._slider.add_child(this._dock);
        this.actor.set_child(this._slider);

        //Hide the dock whilst setting positions
        //this.actor.hide(); but I need to access its width, so I use opacity
        this.actor.set_opacity(0);

        // Since the actor is not a topLevel child and its parent is now not added to the Chrome,
        // the allocation change of the parent container (slide in and slideout) doesn't trigger
        // anymore an update of the input regions. Force the update manually.
        this.actor.connect('notify::allocation',
                                              Lang.bind(Main.layoutManager, Main.layoutManager._queueUpdateRegions));

        // Add aligning container without tracking it for input region (old affectsinputRegion: false that was removed).
        // The public method trackChrome requires the actor to be child of a tracked actor. Since I don't want the parent
        // to be tracked I use the private internal _trackActor instead.
        Main.uiGroup.add_child(this.actor);
        Main.layoutManager._trackActor(this._slider, {trackFullscreen: true});

        // Place the dock in the approprite overview controls group
        if (this._position ==  St.Side.LEFT)
            Main.overview._controls._group.insert_child_at_index(this.actor, this._rtl? -1:0); // insert at first
        else if (this._position ==  St.Side.RIGHT)
            Main.overview._controls._group.insert_child_at_index(this.actor, this._rtl? 0:-1); // insert at last
        else if (this._position ==  St.Side.TOP)
            Main.overview._overview.insert_child_at_index(this.actor, 0);
        else if (this._position ==  St.Side.BOTTOM)
            Main.overview._overview.insert_child_at_index(this.actor, -1);

        if (this._settings.get_boolean('dock-fixed')) {
            Main.layoutManager._trackActor(this.actor, {affectsStruts: true});
            // Force region update to update workspace area
            Main.layoutManager._queueUpdateRegions();
        }

        // pretend this._slider is isToplevel child so that fullscreen is actually tracked
        let index = Main.layoutManager._findActor(this._slider);
        Main.layoutManager._trackedActors[index].isToplevel = true ;
    },

    _initialize: function() {
        if(this._realizeId > 0){
            this.actor.disconnect(this._realizeId);
            this._realizeId = 0;
        }

        // Show the thumbnailsBox.  We need it to calculate the width of the dock.
        this._thumbnailsBox._createThumbnails();

        // Set shortcuts panel visibility
        if (this._settings.get_boolean('show-shortcuts-panel')) {
            this._shortcutsPanel.actor.show();
        } else {
            this._shortcutsPanel.actor.hide();
        }

        // Set initial position and opacity
        this._resetPosition();
        this.actor.set_opacity(255);

        this._disableRedisplay = false;

        // Now that the dock is on the stage and custom themes are loaded
        // retrieve background color and set background opacity
        this._updateBackgroundOpacity();

        // Setup pressure barrier (GS38+ only)
        this._updatePressureBarrier();
        this._updateBarrier();

        // NOTE: GS3.14+ thumbnailsBox width signal triggers ealier so now we need this.
        this._redisplay();
    },

    destroy: function() {
        // Destroy thumbnailsBox & global signals
        this._thumbnailsBox._destroyThumbnails();

        this._shortcutsPanel.destroy();

        // Disconnect global signals
        this._signalHandler.disconnect();

        // Disconnect GSettings signals
        this._settings.run_dispose();

        // Unbind keyboard shortcuts
        this._unbindDockKeyboardShortcut();

        // Remove existing barrier
        this._removeBarrier();
        if (this._pressureBarrier) {
            this._pressureBarrier.destroy();
            this._pressureBarrier = null;
        }

        // Destroy main clutter actor: this should be sufficient
        // From clutter documentation:
        // If the actor is inside a container, the actor will be removed.
        // When you destroy a container, its children will be destroyed as well.
        this.actor.destroy();

        // Restore normal Gnome Shell functions
        this._restoreGnomeShellFunctions();
    },

    // function called during init to override gnome shell 3.4/3.6/3.8
    _overrideGnomeShellFunctions: function() {
        let self = this;

        // Force normal workspaces to be always zoomed
        // GS38 moved things to the overviewControls thumbnailsSlider
        GSFunctions['ThumbnailsSlider_getAlwaysZoomOut'] = OverviewControls.ThumbnailsSlider.prototype._getAlwaysZoomOut;
        OverviewControls.ThumbnailsSlider.prototype._getAlwaysZoomOut = function() {
            let alwaysZoomOut = true;
            return alwaysZoomOut;
        };

        if (this._position == St.Side.LEFT) {
            // Hide normal dash
            Main.overview._controls.dash.actor.hide();
        }

        // Hide normal workspaces thumbnailsBox
        Main.overview._controls._thumbnailsSlider.actor.opacity = 0;

        // Set MAX_THUMBNAIL_SCALE to custom value
        GSFunctions['WorkspaceThumbnail_MAX_THUMBNAIL_SCALE'] = WorkspaceThumbnail.MAX_THUMBNAIL_SCALE;
        if (this._settings.get_boolean('customize-thumbnail')) {
            WorkspaceThumbnail.MAX_THUMBNAIL_SCALE = this._settings.get_double('thumbnail-size');
        };

        // Extend LayoutManager _updateRegions function to destroy/create workspace thumbnails when completed.
        // NOTE1: needed because 'monitors-changed' signal doesn't wait for queued regions to update.
        // We need to wait so that the screen workspace workarea is adjusted before creating workspace thumbnails.
        // Otherwise when we move the primary workspace to another monitor, the workspace thumbnails won't adjust for the top panel.
        // NOTE2: also needed when dock-fixed is enabled/disabled to adjust for workspace area change
        GSFunctions['LayoutManager_updateRegions'] = Layout.LayoutManager.prototype._updateRegions;
        Layout.LayoutManager.prototype._updateRegions = function() {
            let workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            let ret = GSFunctions['LayoutManager_updateRegions'].call(this);
            // SANITY CHECK:
            if (self._refreshThumbnailsOnRegionUpdate) {
                self._refreshThumbnailsOnRegionUpdate = false;
                self._refreshThumbnails();
            } else {
                if (self._workAreaWidth) {
                    let tolerance = workArea.width * .01;
                    if (self._workAreaWidth < workArea.width-tolerance || self._workAreaWidth > workArea.width+tolerance) {
                        self._refreshThumbnails();
                    }
                } else {
                    self._refreshThumbnails();
                }
            }
            return ret;

        };

        // Override geometry calculations of activities overview to use workspaces-to-dock instead of the default thumbnailsbox.
        // NOTE: This is needed for when the dock is positioned on a secondary monitor and also for when the shortcuts panel is visible
        // causing the dock to be wider than normal.
        GSFunctions['WorkspacesDisplay_updateWorkspacesActualGeometry'] = WorkspacesView.WorkspacesDisplay.prototype._updateWorkspacesActualGeometry;
        WorkspacesView.WorkspacesDisplay.prototype._updateWorkspacesActualGeometry = function() {
            if (!this._workspacesViews.length)
                return;

            let [x, y] = this.actor.get_transformed_position();
            let allocation = this.actor.allocation;
            let width = allocation.x2 - allocation.x1;
            let height = allocation.y2 - allocation.y1;

            let spacing = Main.overview._controls.actor.get_theme_node().get_length('spacing');
            let monitors = Main.layoutManager.monitors;
            for (let i = 0; i < monitors.length; i++) {
                let geometry = { x: monitors[i].x, y: monitors[i].y, width: monitors[i].width, height: monitors[i].height };

                // Adjust width for dash
                let dashWidth = 0;
                let dashHeight = 0;
                let dashMonitorIndex;
                if (DashToDock && DashToDock.dock) {
                    dashMonitorIndex = DashToDock.dock._settings.get_int('preferred-monitor');
                    if (dashMonitorIndex < 0 || dashMonitorIndex >= Main.layoutManager.monitors.length) {
                        dashMonitorIndex = this._primaryIndex;
                    }
                    if (i == dashMonitorIndex) {
                        if (DashToDockExtension.hasDockPositionKey)  {
                            if (DashToDock.dock._position == St.Side.LEFT ||
                                DashToDock.dock._position == St.Side.RIGHT) {
                                    dashWidth = DashToDock.dock._box.width + spacing;
                            }
                            if (DashToDock.dock._position == St.Side.TOP ||
                                DashToDock.dock._position == St.Side.BOTTOM) {
                                    dashHeight = DashToDock.dock._box.height + spacing;
                            }
                        } else {
                            dashWidth = DashToDock.dock._box.width + spacing;
                        }
                    }
                } else {
                    if (i == this._primaryIndex) {
                        dashWidth = Main.overview._controls._dashSlider.getVisibleWidth() + spacing;
                    }
                }

                // Adjust width for workspaces thumbnails
                let thumbnailsWidth = 0;
                let thumbnailsHeight = 0;
                let thumbnailsMonitorIndex = self._settings.get_int('preferred-monitor');
                if (thumbnailsMonitorIndex < 0 || thumbnailsMonitorIndex >= Main.layoutManager.monitors.length) {
                    thumbnailsMonitorIndex = this._primaryIndex;
                }
                if (i == thumbnailsMonitorIndex) {
                    if (self._position == St.Side.LEFT ||
                        self._position == St.Side.RIGHT) {
                            thumbnailsWidth = self.actor.get_width() + spacing;
                    }
                    if (self._position == St.Side.TOP ||
                        self._position == St.Side.BOTTOM) {
                            thumbnailsHeight = self.actor.get_height() + spacing;
                    }
                }

                // Adjust x and width for workspacesView geometry
                let controlsWidth = dashWidth + thumbnailsWidth;
                if (DashToDock && DashToDock.dock && DashToDockExtension.hasDockPositionKey) {
                    // What if dash and thumbnailsbox are both on the same side?
                    if (DashToDock.dock._position == St.Side.LEFT &&
                        self._position == St.Side.LEFT) {
                            controlsWidth = Math.max(dashWidth, thumbnailsWidth);
                            geometry.x += controlsWidth;
                    } else {
                        if (DashToDock.dock._position == St.Side.LEFT) {
                            geometry.x += dashWidth;
                        }
                        if (self._position == St.Side.LEFT) {
                            geometry.x += thumbnailsWidth;
                        }
                    }
                    if (DashToDock.dock._position == St.Side.RIGHT &&
                        self._position == St.Side.RIGHT) {
                            controlsWidth = Math.max(dashWidth, thumbnailsWidth);
                    }
                } else {
                    if (this.actor.get_text_direction() == Clutter.TextDirection.LTR) {
                        if (self._position == St.Side.LEFT) {
                            controlsWidth = Math.max(dashWidth, thumbnailsWidth);
                            geometry.x += controlsWidth;
                        } else {
                            geometry.x += dashWidth;
                        }
                    } else {
                        if (self._position == St.Side.RIGHT) {
                            controlsWidth = Math.max(dashWidth, thumbnailsWidth);
                        } else {
                            geometry.x += thumbnailsWidth;
                        }
                    }
                }
                geometry.width -= controlsWidth;

                // Adjust y and height for workspacesView geometry for primary monitor (top panel, etc.)
                // NOTE: if dashSpacer or thumbnailsBox are located at TOP or BOTTOM positions, they
                // already affect the allocation of the overview controls box so there is no need
                // to adjust for them here. We only have to be concerned with height if it's not the
                // primary monitor.
                if (i == this._primaryIndex) {
                    geometry.y = y;
                    geometry.height = height;
                } else {
                    // What if dash and thumbnailsBox are not on the primary monitor?
                    let controlsHeight = dashHeight + thumbnailsHeight;
                    if (DashToDock && DashToDock.dock && DashToDockExtension.hasDockPositionKey) {
                        if (DashToDock.dock._position == St.Side.TOP &&
                            self._position == St.Side.TOP) {
                                controlsHeight = Math.max(dashHeight, thumbnailsHeight);
                                geometry.y += controlsHeight;
                        } else {
                            if (DashToDock.dock._position == St.Side.TOP) {
                                geometry.y += dashHeight;
                            }
                            if (self._position == St.Side.TOP) {
                                geometry.y += thumbnailsHeight;
                            }
                        }
                        if (DashToDock.dock._position == St.Side.BOTTOM &&
                            self._position == St.Side.BOTTOM) {
                                controlsHeight = Math.max(dashHeight, thumbnailsHeight);
                        }
                    } else {
                        if (self._position == St.Side.TOP) {
                            geometry.y += thumbnailsHeight;
                        }
                    }
                    geometry.height -= controlsHeight;
                }

                this._workspacesViews[i].setMyActualGeometry(geometry);
            }
        };

        // This override is needed to prevent calls from updateWorkspacesActualGeometry bound to the workspacesDisplay object
        // without destroying and recreating Main.overview.viewSelector._workspacesDisplay.
        // We replace this function with a new setMyActualGeometry function (see below)
        // TODO: This is very hackish. We need to find a better way to accomplish this
        GSFunctions['WorkspacesViewBase_setActualGeometry'] = WorkspacesView.WorkspacesViewBase.prototype.setActualGeometry;
        WorkspacesView.WorkspacesViewBase.prototype.setActualGeometry = function(geom) {
            //GSFunctions['WorkspacesView_setActualGeometry'].call(this, geom);
            return;
        };

        // This additional function replaces the WorkspacesView setActualGeometry function above.
        // TODO: This is very hackish. We need to find a better way to accomplish this
        WorkspacesView.WorkspacesViewBase.prototype.setMyActualGeometry = function(geom) {
            this._actualGeometry = geom;
            this._syncActualGeometry();
        };

        this._overrideComplete = true;
    },

    // function called during destroy to restore gnome shell 3.4/3.6/3.8
    _restoreGnomeShellFunctions: function() {
        // Restore normal workspaces to previous zoom setting
        OverviewControls.ThumbnailsSlider.prototype._getAlwaysZoomOut = GSFunctions['ThumbnailsSlider_getAlwaysZoomOut'];

        if (this._position == St.Side.LEFT &&
            (!DashToDock || !DashToDock.dock)) {
                // Show normal dash (if no dash-to-dock)
                Main.overview._controls.dash.actor.show();
        }

        // Show normal workspaces thumbnailsBox
        Main.overview._controls._thumbnailsSlider.actor.opacity = 255;

        // Restore MAX_THUMBNAIL_SCALE to default value
        WorkspaceThumbnail.MAX_THUMBNAIL_SCALE = GSFunctions['WorkspaceThumbnail_MAX_THUMBNAIL_SCALE'];

        // Restore normal LayoutManager _updateRegions function
        // Layout.LayoutManager.prototype._queueUpdateRegions = GSFunctions['LayoutManager_queueUpdateRegions'];
        Layout.LayoutManager.prototype._updateRegions = GSFunctions['LayoutManager_updateRegions'];

        // Restore normal WorkspacesDisplay _updateworksapgesActualGeometray function
        WorkspacesView.WorkspacesDisplay.prototype._updateWorkspacesActualGeometry = GSFunctions['WorkspacesDisplay_updateWorkspacesActualGeometry'];

        // Restore normal WorkspacesView _setActualGeometry function
        WorkspacesView.WorkspacesViewBase.prototype.setActualGeometry = GSFunctions['WorkspacesViewBase_setActualGeometry'];
        WorkspacesView.WorkspacesViewBase.prototype.setMyActualGeometry = null;
    },

    // handler for when thumbnailsBox is resized
    _thumbnailsBoxResized: function() {
        this._updateSize();
        this._redisplay();
    },

    // handler for when dock y position is updated
    _updateYPosition: function() {
        this._updateSize();
    },

    // handler for when dock height is updated
    _updateHeight: function() {
        this._updateSize();
    },

    // handler to bind settings when preferences changed
    _bindSettingsChanges: function() {
        this._settings.connect('changed::opaque-background', Lang.bind(this, function() {
            this._updateBackgroundOpacity();
        }));

        this._settings.connect('changed::background-opacity', Lang.bind(this, function() {
            this._updateBackgroundOpacity();
        }));

        this._settings.connect('changed::opaque-background-always', Lang.bind(this, function() {
            this._updateBackgroundOpacity();
        }));

        this._settings.connect('changed::autohide', Lang.bind(this, function() {
            this.emit('box-changed');
            this._updateBarrier();
        }));

        this._settings.connect('changed::preferred-monitor', Lang.bind(this, function() {
            this._resetPosition();
            this._redisplay();
        }));

        this._settings.connect('changed::show-shortcuts-panel', Lang.bind(this, function() {
            if (this._settings.get_boolean('show-shortcuts-panel')) {
                this._shortcutsPanel.actor.show();
            } else {
                this._shortcutsPanel.actor.hide();
            }
            this._updateSize();
            this._redisplay();
        }));

        this._settings.connect('changed::shortcuts-panel-icon-size', Lang.bind(this, function() {
            this._shortcutsPanel.refresh();
            this._updateSize();
            this._redisplay();
        }));

        this._settings.connect('changed::dock-edge-visible', Lang.bind(this, function() {
            let slideoutSize = TRIGGER_WIDTH;
            if (this._settings.get_boolean('dock-edge-visible')) {
                slideoutSize = TRIGGER_WIDTH + DOCK_EDGE_VISIBLE_WIDTH;
            }
            this._slider.slideoutSize = slideoutSize;
            if (this._autohideStatus) {
                this._animateIn(this._settings.get_double('animation-time'), 0);
                this._animateOut(this._settings.get_double('animation-time'), 0);
            }
        }));

        this._settings.connect('changed::require-pressure-to-show', Lang.bind(this, this._updateBarrier));
        this._settings.connect('changed::pressure-threshold', Lang.bind(this, function() {
            this._updatePressureBarrier();
            this._updateBarrier();
        }));

        this._settings.connect('changed::customize-thumbnail', Lang.bind(this, function() {
            // Set Gnome Shell's workspace thumbnail size so that overview mode layout doesn't overlap dock
            if (this._settings.get_boolean('customize-thumbnail')) {
                WorkspaceThumbnail.MAX_THUMBNAIL_SCALE = this._settings.get_double('thumbnail-size');
            } else {
                WorkspaceThumbnail.MAX_THUMBNAIL_SCALE = GSFunctions['WorkspaceThumbnail_MAX_THUMBNAIL_SCALE'];
            }
            // hide and show thumbnailsBox to resize thumbnails
            this._refreshThumbnails();
        }));

        this._settings.connect('changed::thumbnail-size', Lang.bind(this, function() {
            // Set Gnome Shell's workspace thumbnail size so that overview mode layout doesn't overlap dock
            if (this._settings.get_boolean('customize-thumbnail')) {
                WorkspaceThumbnail.MAX_THUMBNAIL_SCALE = this._settings.get_double('thumbnail-size');
            } else {
                WorkspaceThumbnail.MAX_THUMBNAIL_SCALE = GSFunctions['WorkspaceThumbnail_MAX_THUMBNAIL_SCALE'];
            }
            // hide and show thumbnailsBox to resize thumbnails
            this._refreshThumbnails();
        }));

        this._settings.connect('changed::workspace-captions', Lang.bind(this, function() {
            // hide and show thumbnailsBox to reset workspace apps in caption
            this._refreshThumbnails();
        }));
        this._settings.connect('changed::workspace-caption-height', Lang.bind(this, function() {
            // hide and show thumbnailsBox to reset workspace apps in caption
            this._refreshThumbnails();
        }));
        this._settings.connect('changed::workspace-caption-items', Lang.bind(this, function() {
            // hide and show thumbnailsBox to reset workspace apps in caption
            this._refreshThumbnails();
        }));
        this._settings.connect('changed::workspace-caption-windowcount-image', Lang.bind(this, function() {
            // hide and show thumbnailsBox to reset workspace apps in caption
            this._refreshThumbnails();
        }));
        this._settings.connect('changed::workspace-caption-taskbar-icon-size', Lang.bind(this, function() {
            // hide and show thumbnailsBox to reset workspace apps in caption
            this._refreshThumbnails();
        }));

        this._settings.connect('changed::extend-height', Lang.bind(this, function() {
            // Add or remove addtional style class when workspace is fixed and set to full height
            if (this._settings.get_boolean('extend-height') && this._settings.get_double('top-margin') == 0) {
                this._dock.add_style_class_name('fullheight');
            } else {
                this._dock.remove_style_class_name('fullheight');
            }
            this._updateSize();
        }));
        this._settings.connect('changed::top-margin', Lang.bind(this, function() {
            // Add or remove addtional style class when workspace is fixed and set to full height
            if (this._settings.get_boolean('extend-height') && this._settings.get_double('top-margin') == 0) {
                this._dock.add_style_class_name('fullheight');
            } else {
                this._dock.remove_style_class_name('fullheight');
            }
            this._updateSize();
        }));
        this._settings.connect('changed::bottom-margin', Lang.bind(this, function() {
            // Add or remove addtional style class when workspace is fixed and set to full height
            if (this._settings.get_boolean('extend-height') && this._settings.get_double('top-margin') == 0) {
                this._dock.add_style_class_name('fullheight');
            } else {
                this._dock.remove_style_class_name('fullheight');
            }
            this._updateSize();
        }));

        this._settings.connect('changed::toggle-dock-with-keyboard-shortcut', Lang.bind(this, function(){
            if (this._settings.get_boolean('toggle-dock-with-keyboard-shortcut'))
                this._bindDockKeyboardShortcut();
            else
                this._unbindDockKeyboardShortcut();
        }));
    },

    _updatePressureBarrier: function() {
        let self = this;
        this._canUsePressure = global.display.supports_extended_barriers();
        let pressureThreshold = this._settings.get_double('pressure-threshold');

        // Remove existing pressure barrier
        if (this._pressureBarrier) {
            this._pressureBarrier.destroy();
            this._pressureBarrier = null;
        }

        // Create new pressure barrier based on pressure threshold setting
        if (this._canUsePressure) {
            this._pressureBarrier = new Layout.PressureBarrier(pressureThreshold, PRESSURE_TIMEOUT,
                                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
            this._pressureBarrier.connect('trigger', function(barrier){
                self._onPressureSensed();
            });
        }
    },

    _bindDockKeyboardShortcut: function() {
        Main.wm.addKeybinding('dock-keyboard-shortcut', this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            Lang.bind(this, function() {
                if (this._autohideStatus && (this._animStatus.hidden() || this._animStatus.hiding())) {
                    this._show();
                } else {
                    this._hide();
                }
            })
        );
    },

    _unbindDockKeyboardShortcut: function() {
        Main.wm.removeKeybinding('dock-keyboard-shortcut');
    },

    // handler for mouse hover events
    _hoverChanged: function() {
        if (this._canUsePressure && this._settings.get_boolean('require-pressure-to-show') && this._barrier) {
            if (this._pressureSensed == false) {
                return;
            }
        }

        if (this._settings.get_boolean('require-click-to-show')) {
            // check if metaWin is maximized
            let activeWorkspace = global.screen.get_active_workspace();
            let maximized = false;
            let windows = global.get_window_actors();
            for (let i = windows.length-1; i >= 0; i--) {
                let metaWin = windows[i].get_meta_window();
                if (metaWin.get_workspace() == activeWorkspace) {
                    if (metaWin.appears_focused && metaWin.maximized_horizontally) {
                        maximized = true;
                        break;
                    }
                }
            }
            // set hovering flag if maximized
            // used by the _onDockClicked function (hover+click)
            if (maximized) {
                if (this._dock.hover) {
                    this._hovering = true;
                    return;
                } else {
                    this._hovering = false;
                }
            } else {
                this._hovering = false;
            }
        }

        //Skip if dock is not in autohide mode for instance because it is shown by intellihide
        if (this._settings.get_boolean('autohide') && this._autohideStatus) {
            if (this._dock.hover) {
                this._show();
            } else {
                this._hide();
            }
        }
    },

    // handler for mouse click events - works in conjuction with hover event to show dock for maxmized windows
    _onDockClicked: function() {
        if (this._settings.get_boolean('require-click-to-show')) {
            if (this._hovering) {
                //Skip if dock is not in autohide mode for instance because it is shown by intellihide
                if (this._settings.get_boolean('autohide') && this._autohideStatus) {
                    if (this._dock.hover) {
                        this._show();
                    } else {
                        this._hide();
                    }
                }
                this._hovering = false;
            }
        }
    },

    // handler for mouse pressure sensed (GS38+ only)
    _onPressureSensed: function() {
        this._pressureSensed = true;
        this._hoverChanged();
    },

    _onDashToDockShowing: function() {
        //Skip if dock is not in dashtodock hover mode
        if (this._settings.get_boolean('dashtodock-hover') && DashToDock && DashToDock.dock) {
            if (Main.overview.visible == false) {
                if (DashToDock.dock._box.hover) {
                    this._hoveringDash = true;
                    this._show();
                }
            }
        }
    },

    _onDashToDockHiding: function() {
        //Skip if dock is not in dashtodock hover mode
        if (this._settings.get_boolean('dashtodock-hover') && DashToDock && DashToDock.dock) {
            this._hoveringDash = false;
            this._hide();
        }
    },

    _onDashToDockLeave: function() {
        // NOTE: Causing workspaces-to-dock to hide when switching workspaces in Gnome 3.14.
        // Remove until a workaround can be found.
        // this._hoveringDash = false;
    },

    // handler for DashToDock hover events
    _onDashToDockHoverChanged: function() {
        //Skip if dock is not in dashtodock hover mode
        if (this._settings.get_boolean('dashtodock-hover') && DashToDock && DashToDock.dock) {
            if (DashToDock.dock._box.hover) {
                if (Main.overview.visible == false) {
                    this._hoveringDash = true;
                    this._show();
                }
            } else {
                this._hoveringDash = false;
                this._hide();
            }
        }
    },

    // handler for extensionSystem state changes
    _onExtensionSystemStateChanged: function(source, extension) {
        // Only looking for DashToDock state changes
        if (extension.uuid == DashToDock_UUID) {
            DashToDockExtension = extension;
            if (DashToDockExtension.state == ExtensionSystem.ExtensionState.ENABLED) {
                DashToDock = DashToDockExtension.imports.extension;
                if (DashToDock && DashToDock.dock) {
                    var keys = DashToDock.dock._settings.list_keys();
                    if (keys.indexOf('dock-position') > -1) {
                        DashToDockExtension.hasDockPositionKey = true;
                    }
                    // Connect DashToDock hover signal
                    this._signalHandler.pushWithLabel(
                        'DashToDockHoverSignal',
                        [
                            DashToDock.dock._box,
                            'notify::hover',
                            Lang.bind(this, this._onDashToDockHoverChanged)
                        ],
                        [
                            DashToDock.dock._box,
                            'leave-event',
                            Lang.bind(this, this._onDashToDockLeave)
                        ],
                        [
                            DashToDock.dock,
                            'showing',
                            Lang.bind(this, this._onDashToDockShowing)
                        ],
                        [
                            DashToDock.dock,
                            'hiding',
                            Lang.bind(this, this._onDashToDockHiding)
                        ]
                    );
                }
            } else if (extension.state == ExtensionSystem.ExtensionState.DISABLED || extension.state == ExtensionSystem.ExtensionState.UNINSTALLED) {
                DashToDock = null;
                this._signalHandler.disconnectWithLabel('DashToDockHoverSignal');
                this._hoveringDash = false;
            }
        }
    },

    // handler for mouse scroll events
    // Switches workspace by scrolling over the dock
    // This comes from desktop-scroller@obsidien.github.com
    _onScrollEvent: function (actor, event) {
        if (this._settings.get_boolean('disable-scroll') && this._autohideStatus && (this._animStatus.hidden() || this._animStatus.hiding()))
            return Clutter.EVENT_STOP;

        let activeWs = global.screen.get_active_workspace();
        let direction;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            direction = Meta.MotionDirection.UP;
            break;
        case Clutter.ScrollDirection.DOWN:
            direction = Meta.MotionDirection.DOWN;
            break;
        }

        if (direction) {
            let ws = activeWs.get_neighbor(direction);

            if (Main.wm._workspaceSwitcherPopup == null)
                Main.wm._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();

            // Set the workspaceSwitcherPopup actor to non reactive,
            // to prevent it from grabbing focus away from the dock
            Main.wm._workspaceSwitcherPopup.actor.reactive = false;
            Main.wm._workspaceSwitcherPopup.connect('destroy', function() {
                Main.wm._workspaceSwitcherPopup = null;
            });

            // Do not show wokspaceSwitcher in overview
            if (!Main.overview.visible)
                Main.wm._workspaceSwitcherPopup.display(direction, ws.index());

            Main.wm.actionMoveWorkspace(ws);
        }

        return Clutter.EVENT_STOP;
    },

    // autohide function to show dock
    _show: function() {
        let anim = this._animStatus;

        if (this._autohideStatus && (anim.hidden() || anim.hiding())) {
            let delay;
            // If the dock is hidden, wait this._settings.get_double('show-delay') before showing it;
            // otherwise show it immediately.
            if (anim.hidden()) {
                delay = this._settings.get_double('show-delay');
            } else if (anim.hiding()) {
                // suppress all potential queued hiding animations (always give priority to show)
                this._removeAnimations();
                delay = 0;
            }

            this._animateIn(this._settings.get_double('animation-time'), delay);
        }
    },

    // autohide function to hide dock
    _hide: function() {
        let anim = this._animStatus;

        // If no hiding animation is running or queued
        if (!this._hoveringDash && this._autohideStatus && (anim.showing() || anim.shown())) {
            let delay;

            // If a show is queued but still not started (i.e the mouse was
            // over the screen  border but then went away, i.e not a sufficient
            // amount of time is passeed to trigger the dock showing) remove it.
            if (anim.showing()) {
                if (anim.running) {
                    // If a show already started, let it finish; queue hide without removing the show.
                    // to obtain this I increase the delay to avoid the overlap and interference
                    // between the animations
                    delay = this._settings.get_double('hide-delay') + 2 * this._settings.get_double('animation-time') + this._settings.get_double('show-delay');
                } else {
                    this._removeAnimations();
                    delay = 0;
                }
            } else if (anim.shown()) {
                delay = this._settings.get_double('hide-delay');
            }

            this._animateOut(this._settings.get_double('animation-time'), delay);
        }
    },

    setPopupMenuFlag: function(showing) {
        this._popupMenuShowing = showing;
        if (!showing) {
            if (this.actor.hover == true) {
                this.actor.sync_hover();
            } else {
                this._hide();
            }
        }
    },

    // autohide function to animate the show dock process
    _animateIn: function(time, delay) {
        this._animStatus.queue(true);
        Tweener.addTween(this._slider, {
            slidex: 1,
            time: time,
            delay: delay,
            transition: 'easeOutQuad',
            onStart: Lang.bind(this, function() {
                this._animStatus.start();
            }),
            onOverwrite: Lang.bind(this, function() {
                this._animStatus.clear();
            }),
            onComplete: Lang.bind(this, function() {
                this._animStatus.end();

                // Remove barrier so that mouse pointer is released and can access monitors on other side of dock
                // NOTE: Delay needed to keep mouse from moving past dock and re-hiding dock immediately. This
                // gives users an opportunity to hover over the dock
                if (this._removeBarrierTimeoutId > 0) {
                    Mainloop.source_remove(this._removeBarrierTimeoutId);
                }
                this._removeBarrierTimeoutId = Mainloop.timeout_add(100, Lang.bind(this, this._removeBarrier));

            })
        });
    },

    // autohide function to animate the hide dock process
    _animateOut: function(time, delay) {
        if (this._popupMenuShowing)
            return;

        this._animStatus.queue(false);
        Tweener.addTween(this._slider, {
            slidex: 0,
            time: time,
            delay: delay,
            transition: 'easeOutQuad',
            onStart: Lang.bind(this, function() {
                this._animStatus.start();
            }),
            onOverwrite: Lang.bind(this, function() {
                this._animStatus.clear();
            }),
            onComplete: Lang.bind(this, function() {
                this._animStatus.end();
                this._updateBarrier();
            })
        });
    },

    // autohide function to remove show-hide animations
    _removeAnimations: function() {
        Tweener.removeTweens(this._slider);
        this._animStatus.clearAll();
    },

    // autohide function to fade out opaque background
    _fadeOutBackground: function(time, delay) {
        // CSS time is in ms
        this._thumbnailsBoxBackground.set_style('transition-duration:' + time*1000 + ';' +
            'transition-delay:' + delay*1000 + ';' +
            'background-color:' + this._defaultBackground);

        this._shortcutsPanel.actor.set_style('transition-duration:' + time*1000 + ';' +
            'transition-delay:' + delay*1000 + ';' +
            'background-color:' + this._defaultBackground);
    },

    // autohide function to fade in opaque background
    _fadeInBackground: function(time, delay) {
        // CSS time is in ms
        this._thumbnailsBoxBackground.set_style('transition-duration:' + time*1000 + ';' +
            'transition-delay:' + delay*1000 + ';' +
            'background-color:' + this._customBackground);

        this._shortcutsPanel.actor.set_style('transition-duration:' + time*1000 + ';' +
            'transition-delay:' + delay*1000 + ';' +
            'background-color:' + this._customBackground);
    },

    // This function handles hiding the dock when dock is in stationary-fixed
    // position but overlapped by gnome panel menus or meta popup windows
    fadeOutDock: function(time, delay, metaOverlap) {
        if (Main.layoutManager._inOverview) {
            // Hide fixed dock when in overviewmode applications view
            this.actor.opacity = 0;
        }

        // Make thumbnail windowclones non-reactive
        // NOTE: Need this for when in overviewmode applications view and dock is in fixed mode.
        // Fixed dock has opacity set to 0 but is still reactive.
        this.actor.reactive = false;
        this._dock.reactive = false;
        this._shortcutsPanel.setReactiveState(false);
        this._thumbnailsBox.actor.reactive = false;
        for (let i = 0; i < this._thumbnailsBox._thumbnails.length; i++) {
            let thumbnail = this._thumbnailsBox._thumbnails[i];
            thumbnail.setCaptionReactiveState(false);
            thumbnail.setWindowClonesReactiveState(false);
        }
    },

    // This function handles showing the dock when dock is stationary-fixed
    // position but overlapped by gnome panel menus or meta popup windows
    fadeInDock: function(time, delay) {
        this.actor.opacity = 255;

        // Return thumbnail windowclones to reactive state
        this.actor.reactive = true;
        this._dock.reactive = true;
        this._shortcutsPanel.setReactiveState(true);
        this._thumbnailsBox.actor.reactive = true;
        for (let i = 0; i < this._thumbnailsBox._thumbnails.length; i++) {
            let thumbnail = this._thumbnailsBox._thumbnails[i];
            thumbnail.setCaptionReactiveState(true);
            thumbnail.setWindowClonesReactiveState(true);
        }

        if (!this._workAreaHeight || !this._workAreaWidth) {
            this._refreshThumbnailsOnRegionUpdate = true;
            Main.layoutManager._queueUpdateRegions();
        }
    },

    // retrieve default background color
    _getBackgroundColor: function() {
        // Remove custom style
        let oldStyle = this._thumbnailsBoxBackground.get_style();
        this._thumbnailsBoxBackground.set_style(null);

        // Prevent shell crash if the actor is not on the stage
        // It happens enabling/disabling repeatedly the extension
        if (!this._thumbnailsBoxBackground.get_stage())
            return null;

        let themeNode = this._thumbnailsBoxBackground.get_theme_node();
        this._thumbnailsBoxBackground.set_style(oldStyle);

        let backgroundColor = themeNode.get_background_color();
        return backgroundColor;
    },

    // update background opacity based on preferences
    _updateBackgroundOpacity: function() {
        let backgroundColor = this._getBackgroundColor();

        if (backgroundColor) {
            let newAlpha = this._settings.get_double('background-opacity');
            this._defaultBackground = "rgba(" + backgroundColor.red + "," + backgroundColor.green + "," + backgroundColor.blue + "," + Math.round(backgroundColor.alpha/2.55)/100 + ")";
            this._customBackground = "rgba(" + backgroundColor.red + "," + backgroundColor.green + "," + backgroundColor.blue + "," + newAlpha + ")";

            if (this._settings.get_boolean('opaque-background') && (this._autohideStatus || this._settings.get_boolean('opaque-background-always'))) {
                this._fadeInBackground(this._settings.get_double('animation-time'), 0);
            } else if (!this._settings.get_boolean('opaque-background') || (!this._autohideStatus && !this._settings.get_boolean('opaque-background-always'))) {
                this._fadeOutBackground(this._settings.get_double('animation-time'), 0);
            }
        }
    },

    // handler for theme changes
    _onThemeChanged: function() {
        this._changeStylesheet();
        if (!this._disableRedisplay)
            this._updateBackgroundOpacity();
    },

    // function to change stylesheets
    _changeStylesheet: function() {
        // Get css filename
        let filename = "workspaces-to-dock.css";

        // Get new theme stylesheet
        let themeStylesheet = Main._defaultCssStylesheet;
        if (Main._cssStylesheet != null)
            themeStylesheet = Main._cssStylesheet;

        // Get theme directory
        let themeDirectory = themeStylesheet.get_path() ? GLib.path_get_dirname(themeStylesheet.get_path()) : "";

        // Test for workspacesToDock stylesheet
        let newStylesheet = null;
        if (themeDirectory != "")
            newStylesheet = Gio.file_new_for_path(themeDirectory + '/extensions/workspaces-to-dock/' + filename);

        if (!newStylesheet || !newStylesheet.query_exists(null)) {
            let defaultStylesheet = Gio.File.new_for_path(Me.path + "/themes/default/" + filename);
            if (defaultStylesheet.query_exists(null)) {
                newStylesheet = defaultStylesheet;
            } else {
                throw new Error(_("No Workspaces-To-Dock stylesheet found") + " (extension.js).");
            }
        }

        if (Extension.workspacesToDockStylesheet && Extension.workspacesToDockStylesheet.equal(newStylesheet)) {
            return false;
        }

        // Change workspacesToDock stylesheet by updating theme
        let themeContext = St.ThemeContext.get_for_stage(global.stage);
        if (!themeContext)
            return false;

        let theme = themeContext.get_theme();
        if (!theme)
            return false;

        let customStylesheets = theme.get_custom_stylesheets();
        if (!customStylesheets)
            return false;

        let previousStylesheet = Extension.workspacesToDockStylesheet;
        Extension.workspacesToDockStylesheet = newStylesheet;

        // let newTheme = new St.Theme ({ application_stylesheet: themeStylesheet,
        //                               default_stylesheet: Main._defaultCssStylesheet });

        let newTheme = new St.Theme ({ application_stylesheet: themeStylesheet });

        for (let i = 0; i < customStylesheets.length; i++) {
            if (!customStylesheets[i].equal(previousStylesheet)) {
                newTheme.load_stylesheet(customStylesheets[i]);
            }
        }

        newTheme.load_stylesheet(Extension.workspacesToDockStylesheet);

        themeContext.set_theme (newTheme);

        if (!this._disableRedisplay) {
            this._refreshThumbnails();
        }

        return true;
    },

    // handler for icon changes
    _onIconsChanged: function() {
        if (this._disableRedisplay)
            return

        this._refreshThumbnails();
    },

    // resdiplay dock called if size-position changed due to dock resizing
    _redisplay: function() {
        if (this._disableRedisplay)
            return


        // Initial display of dock .. sets autohideStatus
        if (this._autohideStatus == null) {
            if (this._settings.get_boolean('dock-fixed')) {
                this._autohideStatus = false;
                this.fadeInDock(this._settings.get_double('animation-time'), 0);
            } else {
                // Initial animation is out .. intellihide will animate in if its needed
                this._removeAnimations();
                this._animateOut(0, 0);
                this._autohideStatus = true;
            }
        } else {
            // Redisplay dock by animating back in .. necessary if thumbnailsBox size changed
            // even if dock is fixed
            if (this._autohideStatus == false) {
                // had to comment out because GS3.4 fixed-dock isn't fully faded in yet when redisplay occurs again
                //this._removeAnimations();
                this._animateIn(this._settings.get_double('animation-time'), 0);
                this._autohideStatus = false;
            }
        }

        this._updateBackgroundOpacity();
        this._updateBarrier();
    },

    // update the dock size and position
    _updateSize: function() {
        this._shortcutsPanelWidth = this._settings.get_boolean('show-shortcuts-panel') ? this._shortcutsPanel.actor.width : 0;

        // check if the dock is on the primary monitor
        let primary = false;
        if (this._monitor.x == Main.layoutManager.primaryMonitor.x && this._monitor.y == Main.layoutManager.primaryMonitor.y)
            primary = true;


        let x, y, width, height, anchorPoint;
        if (this._isHorizontal) {
            // Get x position and width
            if (this._settings.get_boolean('extend-height')) {
                let leftMargin = Math.floor(this._settings.get_double('top-margin') * this._monitor.width);
                let rightMargin = Math.floor(this._settings.get_double('bottom-margin') * this._monitor.width);
                x = this._monitor.x + leftMargin;
                width = this._monitor.width - leftMargin - rightMargin;
            } else {
                width = this._monitor.width * .7;
                x = this._monitor.x + (width * .5);
            }

            // Get y position, height, and anchorpoint
            if (this._position == St.Side.TOP) {
                y =  this._monitor.y;
                anchorPoint = Clutter.Gravity.NORTH_WEST;
            } else {
                y =  this._monitor.y + this._monitor.height;
                anchorPoint = Clutter.Gravity.SOUTH_WEST;
            }

        } else {
            // Get x position, width, and anchorpoint
            width = this._thumbnailsBox.actor.width + this._shortcutsPanelWidth;
            if (this._position == St.Side.LEFT) {
                x = this._monitor.x;
                anchorPoint = Clutter.Gravity.NORTH_WEST;
            } else {
                x = this._monitor.x + this._monitor.width;
                anchorPoint = Clutter.Gravity.NORTH_EAST;
            }

            // Get y position and height
            if (this._settings.get_boolean('extend-height')) {
                let topMargin = Math.floor(this._settings.get_double('top-margin') * this._monitor.height);
                let bottomMargin = Math.floor(this._settings.get_double('bottom-margin') * this._monitor.height);
                if (primary) {
                    // ISSUE: Botton Panel extension moves the panel to the bottom
                    // Check if top panel has been moved using anchor point
                    let [pbAnchorX,pbAnchorY] = Main.layoutManager.panelBox.get_anchor_point();
                    if (pbAnchorY < 0) {
                        y = this._monitor.y + topMargin;
                    } else {
                        y = this._monitor.y + Main.layoutManager.panelBox.height + topMargin;
                    }
                    height = this._monitor.height - Main.layoutManager.panelBox.height - topMargin - bottomMargin;
                } else {
                    y = this._monitor.y + topMargin;
                    height = this._monitor.height - topMargin - bottomMargin;
                }
            } else {
                let controlsTop = 45;
                y = this._monitor.y + Main.panel.actor.height + controlsTop + Main.overview._searchEntryBin.height;
                height = this._monitor.height - (y + Main.overview._searchEntryBin.height);
            }
        }

        this.yPosition = y;

        //// skip updating if size is same
        //if ((this.actor.y == y) && (this.actor.width == this._thumbnailsBox.actor.width + this._shortcutsPanelWidth) && (this.actor.height == height)) {
            //return;
        //}

        // Update position of wrapper actor (used to detect window overlaps)
        this.actor.set_position(x, y);

        // Update size of wrapper actor and _dock inside the slider
        this.actor.set_size(width + this._triggerSpacer.width, height); // This is the whole dock wrapper
        this._dock.set_size(width + this._triggerSpacer.width, height); // This is the actual dock inside the slider that we check for mouse hover

        // Set anchor points
        this.actor.move_anchor_point_from_gravity(anchorPoint);

        // Set height of thumbnailsBox actor to match
        this._thumbnailsBox.actor.height = height;
    },

    // 'Hard' reset dock positon: called on start and when monitor changes
    _resetPosition: function() {
        this._monitor = this._getMonitor();

        this._updateSize();

        this._updateBackgroundOpacity();
        this._updateBarrier();
    },

    _onMonitorsChanged: function() {
        this._resetPosition();
        this._redisplay();
        this._refreshThumbnailsOnRegionUpdate = true;
        Main.layoutManager._queueUpdateRegions();
    },

    _refreshThumbnails: function() {
        let workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        this._workAreaWidth = workArea.width;
        this._workAreaHeight = workArea.height;
        if (this._thumbnailsBox) {
            this._thumbnailsBox._destroyThumbnails();
            this._thumbnailsBox._createThumbnails();
        }

        // NOTE: restarting Gnome Shell with the dock height extended leaves the top of the dock hidden
        // under the shell's top bar. Resetting the position after a thumbnail refresh (during Region Updates)
        // fixes this issue.
        this._resetPosition();
    },

    // Retrieve the preferred monitor
    _getMonitor: function() {
        let monitorIndex = this._settings.get_int('preferred-monitor');
        let monitor;

        if (monitorIndex > 0 && monitorIndex < Main.layoutManager.monitors.length) {
            monitor = Main.layoutManager.monitors[monitorIndex];
        } else {
            monitor = Main.layoutManager.primaryMonitor;
        }

        return monitor;
    },

    // Remove pressure barrier (GS38+ only)
    _removeBarrier: function() {
        if (this._barrier) {
            if (this._pressureBarrier) {
                this._pressureBarrier.removeBarrier(this._barrier);
            }
            this._barrier.destroy();
            this._barrier = null;
        }

        // Remove barrier timeout
        if (this._removeBarrierTimeoutId > 0)
            Mainloop.source_remove(this._removeBarrierTimeoutId);

        this._removeBarrierTimeoutId = 0;
        return false;
    },

    // Update pressure barrier size (GS38+ only)
    _updateBarrier: function() {
        // Remove existing barrier
        this._removeBarrier();

        // Manually reset pressure barrier
        // This is necessary because we remove the pressure barrier when it is triggered to show the dock
        if (this._pressureBarrier) {
            this._pressureBarrier._reset();
            this._pressureBarrier._isTriggered = false;
        }

        // Create new barrier
        // Note: dock in fixed possition doesn't use pressure barrier
        if (this.actor.visible && this._canUsePressure && this._settings.get_boolean('autohide')
                    && this._autohideStatus && this._settings.get_boolean('require-pressure-to-show')
                    && !this._settings.get_boolean('dock-fixed') && !this._messageTrayShowing) {

            let x1, x2, y1, y2, direction;
            if(this._position==St.Side.LEFT){
                x1 = this._monitor.x;
                x2 = this._monitor.x;
                y1 = this.actor.y;
                y2 = this.actor.y + this.actor.height;
                direction = Meta.BarrierDirection.POSITIVE_X;
            } else if(this._position==St.Side.RIGHT) {
                x1 = this._monitor.x + this._monitor.width;
                x2 = this._monitor.x + this._monitor.width;
                y1 = this.actor.y;
                y2 = this.actor.y + this.actor.height;
                direction = Meta.BarrierDirection.NEGATIVE_X;
            } else if(this._position==St.Side.TOP) {
                x1 = this.actor.x;
                x2 = this.actor.x + this.actor.width;
                y1 = this._monitor.y;
                y2 = this._monitor.y;
                direction = Meta.BarrierDirection.POSITIVE_Y;
            } else if (this._position==St.Side.BOTTOM) {
                x1 = this.actor.x;
                x2 = this.actor.x + this.actor.width;
                y1 = this._monitor.y + this._monitor.height;
                y2 = this._monitor.y + this._monitor.height;
                direction = Meta.BarrierDirection.NEGATIVE_Y;
            }

            this._barrier = new Meta.Barrier({display: global.display,
                                x1: x1, x2: x2,
                                y1: y1, y2: y2,
                                directions: direction});

            if (this._pressureBarrier) {
                this._pressureBarrier.addBarrier(this._barrier);
            }
        }

        // Reset pressureSensed flag
        this._pressureSensed = false;
    },

    // Disable autohide effect, thus show workspaces
    disableAutoHide: function() {
        if (this._autohideStatus == true) {
            this._autohideStatus = false;

            this._removeAnimations();
            this._animateIn(this._settings.get_double('animation-time'), 0);

            if (this._settings.get_boolean('opaque-background') && !this._settings.get_boolean('opaque-background-always'))
                this._fadeOutBackground(this._settings.get_double('animation-time'), 0);

        }
    },

    // Enable autohide effect, hide workspaces
    enableAutoHide: function() {

        this._autohideStatus = true;

        let delay = 0; // immediately fadein background if hide is blocked by mouseover, otherwise start fadein when dock is already hidden.
        this._removeAnimations();

        if (this._dock.hover == true) {
            this._dock.sync_hover();
        }

        if (!((this._hoveringDash && !Main.overview.visible) || this._dock.hover) || !this._settings.get_boolean('autohide')) {
            this._animateOut(this._settings.get_double('animation-time'), 0);
            delay = this._settings.get_double('animation-time');
        } else {
            delay = 0;
        }

        if (this._settings.get_boolean('opaque-background') && !this._settings.get_boolean('opaque-background-always')) {
            this._fadeInBackground(this._settings.get_double('animation-time'), delay);
        }
    }

});
Signals.addSignalMethods(DockedWorkspaces.prototype);

/*
 * Store animation status in a perhaps overcomplicated way.
 * status is true for visible, false for hidden
 */
const AnimationStatus = new Lang.Class({
    Name: 'workspacestodockAnimationStatus',

    _init: function(initialStatus) {
        this.status = initialStatus;
        this.nextStatus = [];
        this.queued = false;
        this.running = false;
    },

    queue: function(nextStatus) {
        this.nextStatus.push(nextStatus);
        this.queued = true;
    },

    start: function() {
        if (this.nextStatus.length == 1) {
            this.queued = false;
        }
        this.running = true;
    },

    end: function() {
        if (this.nextStatus.length == 1) {
            this.queued = false; // in the case end is called and start was not
        }
        this.running = false;
        this.status = this.nextStatus.shift();
    },

    clear: function() {
        if (this.nextStatus.length == 1) {
            this.queued = false;
            this.running = false;
        }

        this.nextStatus.splice(0, 1);
    },

    clearAll: function() {
        this.queued = false;
        this.running = false;
        this.nextStatus.splice(0, this.nextStatus.length);
    },

    // Return true if a showing animation is running or queued
    showing: function() {
        if ((this.running == true || this.queued == true) && this.nextStatus[0] == true)
            return true;
        else
            return false;
    },

    shown: function() {
        if (this.status == true && !(this.queued || this.running))
            return true;
        else
            return false;
    },

    // Return true if an hiding animation is running or queued
    hiding: function() {
        if ((this.running == true || this.queued == true) && this.nextStatus[0] == false)
            return true;
        else
            return false;
    },

    hidden: function() {
        if (this.status == false && !(this.queued || this.running))
            return true;
        else
            return false;
    }
});
