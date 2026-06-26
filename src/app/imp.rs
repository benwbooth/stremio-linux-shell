use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use adw::{prelude::*, subclass::prelude::*};
use gtk::{
    gdk::{Key, ModifierType},
    gio,
    glib::{self, Properties, clone},
};

use crate::app::{
    config::{APP_ID, APP_NAME, URI_SCHEME},
    ipc::{
        self,
        event::{IpcEvent, IpcEventMpv},
    },
    mpris::Mpris,
    tray::Tray,
    video::Video,
    webview::WebView,
    window::Window,
};

const PRELOAD_SCRIPT: &str = include_str!("ipc/preload.js");
const CROPDETECT_FILTER: &str = "@cropdetect";
const AUTOCROP_FILTER: &str = "@autocrop";

#[derive(Clone, Copy, Default, Eq, PartialEq)]
enum CropState {
    #[default]
    None,
    Detecting,
    Cropped,
}

fn mpv_command(video: &Video, name: &str, args: &[&str]) {
    video.send_mpv_command(
        name.to_string(),
        args.iter().map(|arg| arg.to_string()).collect(),
    );
}

fn show_crop_text(video: &Video, text: &str, duration_ms: &str) {
    mpv_command(video, "show-text", &[text, duration_ms]);
}

fn remove_crop_filters(video: &Video) {
    mpv_command(video, "vf", &["remove", CROPDETECT_FILTER]);
    mpv_command(video, "vf", &["remove", AUTOCROP_FILTER]);
}

fn apply_detected_crop(video: &Video, crop_state: &Cell<CropState>) {
    if crop_state.get() != CropState::Detecting {
        return;
    }

    match video.detect_crop() {
        Some((w, h, x, y)) => {
            let (vw, vh) = video.video_dimensions();

            mpv_command(video, "vf", &["remove", CROPDETECT_FILTER]);

            if w < vw || h < vh {
                mpv_command(video, "vf", &["remove", AUTOCROP_FILTER]);
                let filter = format!("{AUTOCROP_FILTER}:lavfi=[crop=w={w}:h={h}:x={x}:y={y}]");
                mpv_command(video, "vf", &["add", &filter]);
                show_crop_text(
                    video,
                    &format!("Crop: {w}x{h}+{x}+{y} (video: {vw}x{vh})"),
                    "3000",
                );
                crop_state.set(CropState::Cropped);
            } else {
                show_crop_text(
                    video,
                    &format!("No bars detected (video: {vw}x{vh})"),
                    "3000",
                );
                crop_state.set(CropState::None);
            }
        }
        None => {
            remove_crop_filters(video);
            show_crop_text(video, "Crop: detection failed", "3000");
            crop_state.set(CropState::None);
        }
    }
}

fn toggle_crop(video: &Video, crop_state: Rc<Cell<CropState>>) {
    match crop_state.get() {
        CropState::None => {
            mpv_command(
                video,
                "vf",
                &[
                    "add",
                    "@cropdetect:lavfi=[cropdetect=limit=64:round=2:skip=2:reset=0]",
                ],
            );
            show_crop_text(video, "Detecting crop...", "2000");
            crop_state.set(CropState::Detecting);
            let crop_state = crop_state.clone();

            glib::timeout_add_local_once(
                Duration::from_secs(2),
                clone!(
                    #[weak]
                    video,
                    move || {
                        apply_detected_crop(&video, &crop_state);
                    }
                ),
            );
        }
        CropState::Detecting | CropState::Cropped => {
            remove_crop_filters(video);
            show_crop_text(video, "Crop: Off", "2000");
            crop_state.set(CropState::None);
        }
    }
}

fn is_crop_shortcut(key: Key, modifiers: ModifierType) -> bool {
    (key == Key::c || key == Key::C) && modifiers.contains(ModifierType::ALT_MASK)
}

#[derive(Properties, Default)]
#[properties(wrapper_type = super::Application)]
pub struct Application {
    #[property(get, set)]
    dev_mode: Cell<bool>,
    #[property(get, set)]
    startup_url: RefCell<String>,
    #[property(get, set)]
    decorations: Cell<bool>,
    tray: RefCell<Option<Tray>>,
    mpris: RefCell<Option<Mpris>>,
    webview: RefCell<Option<WebView>>,
    deeplink: RefCell<Option<String>>,
}

#[glib::object_subclass]
impl ObjectSubclass for Application {
    const NAME: &'static str = "Application";
    type Type = super::Application;
    type ParentType = adw::Application;
}

#[glib::derived_properties]
impl ObjectImpl for Application {}

impl ApplicationImpl for Application {
    fn startup(&self) {
        self.parent_startup();

        let app = self.obj();
        app.setup_actions();
        app.setup_accels();
    }

    fn activate(&self) {
        self.parent_activate();

        let app = self.obj();

        if let Some(window) = app.active_window() {
            window.present();
            return;
        }

        let tray = Tray::default();
        let video = Video::default();
        let mpris = Mpris::default();

        let startup_url = self.startup_url.borrow();
        let dev_mode = self.dev_mode.get();

        let webview = WebView::default();
        webview.load_uri(&startup_url);
        webview.inject_script(PRELOAD_SCRIPT);
        webview.dev_mode(dev_mode);

        let window = Window::new(&app);
        window.set_property("decorations", self.decorations.get());
        window.set_underlay(&video);
        window.set_overlay(&webview);

        let crop_state = Rc::new(Cell::new(CropState::None));
        let crop_action = gio::SimpleAction::new("toggle-crop", None);
        crop_action.connect_activate(clone!(
            #[weak]
            video,
            #[strong]
            crop_state,
            move |_, _| {
                toggle_crop(&video, crop_state.clone());
            }
        ));
        window.add_action(&crop_action);
        app.set_accels_for_action("win.toggle-crop", &["<Alt>c", "<Control><Alt>c"]);

        let crop_key_controller = gtk::EventControllerKey::new();
        crop_key_controller.set_propagation_phase(gtk::PropagationPhase::Capture);
        crop_key_controller.connect_key_pressed(clone!(
            #[weak]
            video,
            #[strong]
            crop_state,
            #[upgrade_or]
            glib::Propagation::Proceed,
            move |_, key, _, modifiers| {
                if is_crop_shortcut(key, modifiers) {
                    toggle_crop(&video, crop_state.clone());
                    glib::Propagation::Stop
                } else {
                    glib::Propagation::Proceed
                }
            }
        ));
        window.add_controller(crop_key_controller);

        video.connect_playback_started(clone!(
            #[weak]
            window,
            move || {
                window.disable_idling();
            }
        ));

        video.connect_playback_ended(clone!(
            #[weak]
            window,
            move || {
                window.enable_idling();
            }
        ));

        video.connect_mpv_property_change(clone!(
            #[weak]
            webview,
            move |name, value| {
                let message = ipc::create_response(IpcEvent::Mpv(IpcEventMpv::Change((
                    name.to_string(),
                    value,
                ))));

                webview.send(&message);
            }
        ));

        let deeplink = self.deeplink.clone();
        webview.connect_ipc(clone!(
            #[weak]
            app,
            #[weak]
            window,
            #[weak]
            video,
            #[weak]
            mpris,
            move |webview: WebView, message: &str| {
                if let Ok(event) = ipc::parse_request(message) {
                    match event {
                        IpcEvent::Init => {
                            let message = ipc::create_response(IpcEvent::Init);
                            webview.send(&message);
                        }
                        IpcEvent::Ready => {
                            if let Some(ref uri) = *deeplink.borrow() {
                                let message =
                                    ipc::create_response(IpcEvent::OpenMedia(uri.to_string()));
                                webview.send(&message);
                            }
                        }
                        IpcEvent::Fullscreen(state) => {
                            window.set_fullscreen(state);

                            let message = ipc::create_response(IpcEvent::Fullscreen(state));
                            webview.send(&message);
                        }
                        IpcEvent::MediaStatus(status) => {
                            mpris.set_status(status);
                        }
                        IpcEvent::MediaMetadata((title, artist, artwork)) => {
                            mpris.set_metadata(title, artist, artwork);
                        }
                        IpcEvent::Quit => {
                            app.quit();
                        }
                        IpcEvent::ToggleCrop => {
                            toggle_crop(&video, crop_state.clone());
                        }
                        IpcEvent::Mpv(event) => match event {
                            IpcEventMpv::Observe(name) => video.observe_mpv_property(name),
                            IpcEventMpv::Command((name, args)) => {
                                video.send_mpv_command(name, args)
                            }
                            IpcEventMpv::Set((name, value)) => video.set_mpv_property(name, value),
                            _ => {}
                        },
                        _ => {}
                    }
                }
            }
        ));

        webview.connect_fullscreen(clone!(
            #[weak]
            window,
            move |fullscreen: bool| {
                window.set_fullscreen(fullscreen);
            }
        ));

        webview.connect_open_external(clone!(
            #[weak]
            window,
            move |uri| {
                window.open_uri(uri);
            }
        ));

        window.connect_visibility(clone!(
            #[weak]
            webview,
            #[weak]
            tray,
            move |state| {
                let message = ipc::create_response(IpcEvent::Visibility(state));
                webview.send(&message);

                tray.update(state);
            }
        ));
        tray.connect_show(clone!(
            #[weak]
            window,
            move || {
                window.set_visible(true);
            }
        ));

        tray.connect_hide(clone!(
            #[weak]
            window,
            move || {
                window.set_visible(false);
            }
        ));

        tray.connect_quit(clone!(
            #[weak]
            app,
            move || {
                app.quit();
            }
        ));

        mpris.connect_status(clone!(
            #[weak]
            webview,
            move |paused| {
                let message = ipc::create_response(IpcEvent::MediaStatus(paused));
                webview.send(&message);
            }
        ));

        mpris.connect_raise(clone!(
            #[weak]
            window,
            move || {
                window.activate();
            }
        ));

        mpris.start(APP_ID, APP_NAME);

        *self.tray.borrow_mut() = Some(tray);
        *self.mpris.borrow_mut() = Some(mpris);
        *self.webview.borrow_mut() = Some(webview);

        window.present();
    }

    fn open(&self, files: &[gtk::gio::File], hint: &str) {
        self.parent_open(files, hint);

        if let Some(file) = files.first() {
            let uri = file.uri().to_string();
            if uri.starts_with(URI_SCHEME) {
                let mut deeplink = self.deeplink.borrow_mut();
                *deeplink = Some(uri.clone());

                if let Some(ref webview) = *self.webview.borrow() {
                    let message = ipc::create_response(IpcEvent::OpenMedia(uri));
                    webview.send(&message);
                }
            }
        }

        self.activate();
    }
}

impl GtkApplicationImpl for Application {}
impl AdwApplicationImpl for Application {}
