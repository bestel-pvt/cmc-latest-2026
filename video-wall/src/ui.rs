//! Full eframe/egui application — login, config-mode wall preview
//! with layout picker + channel side-panel + click-to-assign, and
//! Start Fullscreen that spawns the real video wall in a separate
//! borderless window.

use eframe::egui::{self, Color32, RichText, Vec2};
use std::collections::HashMap;
use std::sync::mpsc;

use crate::api::{Channel, CmcClient};
use crate::config::{Config, FillMode};
use crate::layouts::{self, Layout};
use crate::wall_window::{self, WallStart};

// ------------------------------------------------------------------ brand
//
// PAK NAVY palette: crisp white background, navy-green accents. All
// chrome text renders in the deep navy-green so the interface reads
// like an official Navy dashboard rather than a "tech" dev tool.

const BRAND_ACCENT: Color32 = Color32::from_rgb(0, 82, 33);   // PAK NAVY GREEN
const BRAND_ACCENT_DARK: Color32 = Color32::from_rgb(0, 55, 22);
const BRAND_INK: Color32 = Color32::from_rgb(20, 30, 45);      // near-black on white
const BRAND_INK_SOFT: Color32 = Color32::from_rgb(90, 100, 120);
const BRAND_BG: Color32 = Color32::from_rgb(248, 250, 252);    // near-white
const BRAND_PANEL: Color32 = Color32::from_rgb(240, 244, 248);
const BRAND_LINE: Color32 = Color32::from_rgb(210, 218, 228);

// Bundled brand PNGs — compiled into the exe via include_bytes!.
const PAK_NAVY_LOGO: &[u8] = include_bytes!("../assets/pak-navy-logo.png");
const POWERED_BY_ANALYSYS: &[u8] = include_bytes!("../assets/powered-by-analysys.png");

// 32 pastel-ish palette for placeholder slot backgrounds — matches
// the Python viewer's palette so operators see the same colours.
const SLOT_COLORS: [Color32; 32] = [
    Color32::from_rgb(30, 58, 138), Color32::from_rgb(107, 33, 168),
    Color32::from_rgb(157, 23, 77), Color32::from_rgb(190, 24, 93),
    Color32::from_rgb(153, 27, 27), Color32::from_rgb(154, 52, 18),
    Color32::from_rgb(133, 77, 14), Color32::from_rgb(87, 83, 78),
    Color32::from_rgb(20, 83, 45), Color32::from_rgb(21, 94, 117),
    Color32::from_rgb(30, 64, 175), Color32::from_rgb(126, 34, 206),
    Color32::from_rgb(159, 18, 57), Color32::from_rgb(180, 83, 9),
    Color32::from_rgb(101, 163, 13), Color32::from_rgb(20, 184, 166),
    Color32::from_rgb(37, 99, 235), Color32::from_rgb(147, 51, 234),
    Color32::from_rgb(219, 39, 119), Color32::from_rgb(234, 88, 12),
    Color32::from_rgb(34, 197, 94), Color32::from_rgb(6, 182, 212),
    Color32::from_rgb(59, 130, 246), Color32::from_rgb(168, 85, 247),
    Color32::from_rgb(236, 72, 153), Color32::from_rgb(249, 115, 22),
    Color32::from_rgb(74, 222, 128), Color32::from_rgb(103, 232, 249),
    Color32::from_rgb(96, 165, 250), Color32::from_rgb(192, 132, 252),
    Color32::from_rgb(244, 114, 182), Color32::from_rgb(253, 186, 116),
];

// ------------------------------------------------------------------ state

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Screen {
    Login,
    Config,
    Fullscreen,
}

pub struct App {
    cfg: Config,
    screen: Screen,

    // Bundled brand textures — loaded once from include_bytes! at first frame.
    navy_logo_tex: Option<egui::TextureHandle>,
    analysys_tex: Option<egui::TextureHandle>,

    // login form
    login_password: String,
    login_error: Option<String>,
    login_in_flight: bool,
    login_rx: Option<mpsc::Receiver<LoginOutcome>>,

    // channel data (populated after login)
    channels: Vec<Channel>,
    channels_rx: Option<mpsc::Receiver<Result<Vec<Channel>, String>>>,
    selected_channel_id: Option<String>,
    status_msg: String,

    // Async-fetched logo cache. Keyed by channel id. Value holds
    // either the loaded egui texture handle (once ready) or `None`
    // when the fetch failed / hasn't landed yet. Fetches kick off on
    // first render pass; results delivered via `logo_rx`.
    logos: HashMap<String, Option<egui::TextureHandle>>,
    logo_rx: mpsc::Receiver<(String, Option<Vec<u8>>)>,
    logo_tx: mpsc::Sender<(String, Option<Vec<u8>>)>,
    logo_inflight: std::collections::HashSet<String>,

    // Handle to the running wall child process (spawned exe).
    // Poll it each frame; on exit, go back to Config screen.
    wall_child: Option<std::process::Child>,
}

enum LoginOutcome {
    Ok { token: String, channels: Vec<Channel> },
    Err(String),
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>, mut cfg: Config) -> Self {
        install_style(&cc.egui_ctx);

        // If we already have a cached token, try to load channels
        // straight into the config screen — the user shouldn't need
        // to re-login on every launch.
        let (logo_tx, logo_rx) = mpsc::channel();
        let ctx = &cc.egui_ctx;
        let navy_logo_tex = decode_static_texture(ctx, "brand-pak-navy-logo", PAK_NAVY_LOGO);
        let analysys_tex = decode_static_texture(ctx, "brand-powered-by-analysys", POWERED_BY_ANALYSYS);
        let mut me = Self {
            screen: if cfg.access_token.is_some() { Screen::Config } else { Screen::Login },
            navy_logo_tex,
            analysys_tex,
            login_password: String::new(),
            login_error: None,
            login_in_flight: false,
            login_rx: None,
            channels: Vec::new(),
            channels_rx: None,
            selected_channel_id: None,
            status_msg: String::new(),
            logos: HashMap::new(),
            logo_rx,
            logo_tx,
            logo_inflight: std::collections::HashSet::new(),
            wall_child: None,
            cfg,
        };
        if me.screen == Screen::Config {
            me.refresh_channels();
        }
        me
    }

    fn refresh_channels(&mut self) {
        let base = self.cfg.api_base.clone();
        let token = self.cfg.access_token.clone();
        let (tx, rx) = mpsc::channel();
        self.channels_rx = Some(rx);
        self.status_msg = "Refreshing channels…".to_string();
        tokio::spawn(async move {
            let mut client = match CmcClient::new(base) {
                Ok(c) => c,
                Err(e) => { let _ = tx.send(Err(format!("client: {e}"))); return; }
            };
            client.set_token(token);
            let r = client.list_channels().await.map_err(|e| e.to_string());
            let _ = tx.send(r);
        });
    }

    fn drain_channels(&mut self) {
        let mut done = false;
        if let Some(rx) = &self.channels_rx {
            if let Ok(res) = rx.try_recv() {
                done = true;
                match res {
                    Ok(list) => {
                        self.status_msg = format!("{} channels loaded", list.len());
                        self.channels = list;
                    }
                    Err(e) => {
                        // Session expired → drop token, go back to login.
                        if e.contains("Session expired") || e.contains("401") {
                            self.cfg.access_token = None;
                            let _ = self.cfg.save();
                            self.screen = Screen::Login;
                            self.login_error = Some(e);
                        } else {
                            self.status_msg = format!("Refresh failed: {e}");
                        }
                    }
                }
            }
        }
        if done { self.channels_rx = None; }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Pull any async results delivered since last frame.
        self.drain_login();
        self.drain_channels();
        self.drain_logos(ctx);

        match self.screen {
            Screen::Login => draw_login(self, ctx),
            Screen::Config => draw_config(self, ctx),
            Screen::Fullscreen => draw_fullscreen_pending(self, ctx),
        }

        // Repaint frequently while there's async work pending, else
        // let egui idle — no busy-wait in Config with nothing to do.
        if self.login_in_flight || self.channels_rx.is_some() || !self.logo_inflight.is_empty() {
            ctx.request_repaint_after(std::time::Duration::from_millis(80));
        }
    }
}

impl App {
    /// Kick off a logo fetch for one channel — no-op if already
    /// cached or already in flight.
    fn ensure_logo(&mut self, channel: &Channel) {
        if !self.logos.contains_key(&channel.id)
            && !self.logo_inflight.contains(&channel.id)
            && channel.logo_url.is_some()
        {
            self.logo_inflight.insert(channel.id.clone());
            let id = channel.id.clone();
            let base = self.cfg.api_base.clone();
            let token = self.cfg.access_token.clone();
            let tx = self.logo_tx.clone();
            let url = format!("{}/api/channels/{}/logo", base.trim_end_matches('/'), id);
            tokio::spawn(async move {
                let bytes = fetch_bytes(&url, token.as_deref()).await;
                let _ = tx.send((id, bytes));
            });
        }
    }

    fn drain_logos(&mut self, ctx: &egui::Context) {
        while let Ok((id, bytes)) = self.logo_rx.try_recv() {
            self.logo_inflight.remove(&id);
            let handle = bytes.and_then(|b| decode_to_texture(ctx, &id, &b));
            self.logos.insert(id, handle);
        }
    }
}

async fn fetch_bytes(url: &str, token: Option<&str>) -> Option<Vec<u8>> {
    let mut req = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .ok()?
        .get(url);
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let r = req.send().await.ok()?;
    if !r.status().is_success() { return None; }
    Some(r.bytes().await.ok()?.to_vec())
}

fn decode_to_texture(ctx: &egui::Context, id: &str, bytes: &[u8]) -> Option<egui::TextureHandle> {
    let img = image::load_from_memory(bytes).ok()?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let color_img =
        egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], rgba.as_raw());
    Some(ctx.load_texture(format!("logo-{id}"), color_img, egui::TextureOptions::LINEAR))
}

/// Same as decode_to_texture but for asset PNGs bundled at compile
/// time — swallows failure silently since these are known-good and
/// their loss just means we fall back to a text label.
fn decode_static_texture(ctx: &egui::Context, id: &str, bytes: &[u8]) -> Option<egui::TextureHandle> {
    decode_to_texture(ctx, id, bytes)
}

// ------------------------------------------------------------------ login

fn draw_login(app: &mut App, ctx: &egui::Context) {
    egui::CentralPanel::default()
        .frame(egui::Frame::default().fill(BRAND_BG).inner_margin(egui::Margin::same(24)))
        .show(ctx, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space(40.0);
                // Big PAK NAVY crest at the top of the login card.
                if let Some(tex) = &app.navy_logo_tex {
                    let sz = tex.size_vec2();
                    let scale = (160.0 / sz.y).min(160.0 / sz.x);
                    ui.add(egui::Image::new(tex).fit_to_exact_size(Vec2::new(sz.x * scale, sz.y * scale)));
                } else {
                    ui.label(RichText::new("⚓").size(80.0).color(BRAND_ACCENT));
                }
                ui.add_space(10.0);
                ui.label(RichText::new("PAK NAVY").size(28.0).strong().color(BRAND_ACCENT));
                ui.label(RichText::new("CMC · Channel Monitoring & Clipping").size(13.0).color(BRAND_INK_SOFT));
                ui.add_space(22.0);
                egui::Frame::default()
                    .fill(Color32::WHITE)
                    .stroke(egui::Stroke::new(1.0, BRAND_LINE))
                    .corner_radius(10)
                    .inner_margin(egui::Margin::same(22))
                    .shadow(egui::Shadow {
                        offset: [0, 4],
                        blur: 16,
                        spread: 0,
                        color: Color32::from_black_alpha(15),
                    })
                    .show(ui, |ui| {
                        ui.set_max_width(380.0);
                        ui.set_min_width(380.0);
                        labelled(ui, "Email");
                        ui.text_edit_singleline(&mut app.cfg.email);
                        ui.add_space(10.0);
                        labelled(ui, "Password");
                        ui.add(egui::TextEdit::singleline(&mut app.login_password).password(true));
                        ui.add_space(10.0);
                        labelled(ui, "API base URL");
                        ui.text_edit_singleline(&mut app.cfg.api_base);
                        ui.add_space(10.0);
                        labelled(ui, "Multicast NIC IP (blank = auto)");
                        ui.text_edit_singleline(&mut app.cfg.multicast_localaddr);
                        ui.add_space(16.0);
                        if let Some(err) = &app.login_error {
                            ui.colored_label(Color32::from_rgb(200, 40, 40), err);
                            ui.add_space(6.0);
                        }
                        let label = if app.login_in_flight { "Signing in…" } else { "Sign in" };
                        let sign_in = ui.add_enabled(
                            !app.login_in_flight,
                            egui::Button::new(RichText::new(label).strong().color(Color32::WHITE))
                                .fill(BRAND_ACCENT)
                                .min_size(Vec2::new(340.0, 40.0)),
                        );
                        if sign_in.clicked() && !app.login_in_flight {
                            start_login(app);
                        }
                    });
                ui.add_space(24.0);
                // "Powered by Analysys" official lockup at the foot.
                if let Some(tex) = &app.analysys_tex {
                    let sz = tex.size_vec2();
                    let scale = (28.0 / sz.y).min(1.0);
                    ui.add(egui::Image::new(tex).fit_to_exact_size(Vec2::new(sz.x * scale, sz.y * scale)));
                } else {
                    ui.label(RichText::new("Powered by Analysys").size(11.0).color(BRAND_INK_SOFT));
                }
            });
        });
}

fn labelled(ui: &mut egui::Ui, s: &str) {
    ui.label(RichText::new(s).size(11.0).color(BRAND_INK_SOFT));
}

fn start_login(app: &mut App) {
    let (tx, rx) = mpsc::channel();
    app.login_rx = Some(rx);
    app.login_in_flight = true;
    app.login_error = None;
    let email = app.cfg.email.clone();
    let password = std::mem::take(&mut app.login_password);
    let api_base = app.cfg.api_base.clone();
    tokio::spawn(async move {
        let outcome = attempt_login(&api_base, &email, &password).await;
        let _ = tx.send(outcome);
    });
}

async fn attempt_login(api_base: &str, email: &str, password: &str) -> LoginOutcome {
    let mut client = match CmcClient::new(api_base.to_string()) {
        Ok(c) => c,
        Err(e) => return LoginOutcome::Err(format!("client init: {e}")),
    };
    let token = match client.login(email, password).await {
        Ok(t) => t,
        Err(e) => return LoginOutcome::Err(format!("{e}")),
    };
    let channels = client.list_channels().await.unwrap_or_default();
    LoginOutcome::Ok { token, channels }
}

impl App {
    fn drain_login(&mut self) {
        let mut done = false;
        if let Some(rx) = &self.login_rx {
            if let Ok(o) = rx.try_recv() {
                done = true;
                self.login_in_flight = false;
                match o {
                    LoginOutcome::Ok { token, channels } => {
                        self.cfg.access_token = Some(token);
                        let _ = self.cfg.save();
                        self.channels = channels;
                        self.screen = Screen::Config;
                    }
                    LoginOutcome::Err(e) => self.login_error = Some(e),
                }
            }
        }
        if done { self.login_rx = None; }
    }
}

// ------------------------------------------------------------------ config

fn draw_config(app: &mut App, ctx: &egui::Context) {
    // Top toolbar — white background with a thin bottom rule so it
    // reads as a proper app chrome bar, not a giant coloured band.
    egui::TopBottomPanel::top("toolbar")
        .exact_height(56.0)
        .frame(
            egui::Frame::default()
                .fill(Color32::WHITE)
                .inner_margin(egui::Margin::symmetric(14, 8))
                .stroke(egui::Stroke::new(1.0, BRAND_LINE)),
        )
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                // PAK NAVY crest on the far left, plus the wordmark.
                if let Some(tex) = &app.navy_logo_tex {
                    let sz = tex.size_vec2();
                    let scale = (36.0 / sz.y).min(1.0);
                    ui.add(egui::Image::new(tex).fit_to_exact_size(Vec2::new(sz.x * scale, sz.y * scale)));
                }
                ui.label(RichText::new("PAK NAVY").size(18.0).strong().color(BRAND_ACCENT));
                ui.label(RichText::new("│").size(16.0).color(BRAND_LINE));
                ui.label(RichText::new("Video Wall").size(14.0).color(BRAND_INK));
                ui.add_space(24.0);

                ui.label("Layout:");
                let cur_label = layouts::by_id(&app.cfg.layout).label.to_string();
                let mut new_layout: Option<String> = None;
                egui::ComboBox::from_id_salt("layout_pick")
                    .selected_text(cur_label)
                    .show_ui(ui, |ui| {
                        for l in layouts::all() {
                            if ui
                                .selectable_label(app.cfg.layout == l.id, l.label)
                                .clicked()
                            {
                                new_layout = Some(l.id.to_string());
                            }
                        }
                    });
                if let Some(id) = new_layout {
                    app.cfg.layout = id;
                    let _ = app.cfg.save();
                }

                ui.add_space(12.0);
                if ui.button("↻ Refresh").clicked() { app.refresh_channels(); }
                if ui.checkbox(&mut app.cfg.auto_fill_empty_slots, "Auto-fill empty slots").changed() {
                    let _ = app.cfg.save();
                }
                if ui.button("Logout").clicked() {
                    app.cfg.access_token = None;
                    let _ = app.cfg.save();
                    app.channels.clear();
                    app.logos.clear();
                    app.screen = Screen::Login;
                }

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    // ONLY the fullscreen button on the right — no
                    // status text here (was overlapping Logout on
                    // narrower windows). Status goes to the bottom
                    // strip below.
                    let sf = ui.add(
                        egui::Button::new(RichText::new("▶ START FULLSCREEN  (F11)").strong().color(Color32::WHITE))
                            .fill(BRAND_ACCENT)
                            .min_size(Vec2::new(240.0, 36.0)),
                    );
                    if sf.clicked() { enter_fullscreen(app); }
                });
            });
        });

    // F11 as a shortcut.
    if ctx.input(|i| i.key_pressed(egui::Key::F11)) {
        enter_fullscreen(app);
    }

    // Bottom status strip — dedicated real estate for messages so
    // they can't collide with any toolbar buttons.
    egui::TopBottomPanel::bottom("status")
        .exact_height(24.0)
        .frame(
            egui::Frame::default()
                .fill(Color32::WHITE)
                .inner_margin(egui::Margin::symmetric(14, 4))
                .stroke(egui::Stroke::new(1.0, BRAND_LINE)),
        )
        .show(ctx, |ui| {
            let msg = if app.status_msg.is_empty() {
                format!("{} channels loaded", app.channels.len())
            } else {
                app.status_msg.clone()
            };
            ui.label(RichText::new(msg).size(11.0).color(BRAND_INK_SOFT));
        });

    // Right-side channel list — logo + name + online dot, click to pick.
    let ch_snapshot: Vec<Channel> = app.channels.clone();
    for c in &ch_snapshot {
        app.ensure_logo(c);
    }
    egui::SidePanel::right("channels")
        .exact_width(280.0)
        .frame(egui::Frame::default().fill(BRAND_PANEL).inner_margin(egui::Margin::same(10)))
        .show(ctx, |ui| {
            ui.label(RichText::new("Channels").strong().color(BRAND_ACCENT));
            ui.small(RichText::new("Click a channel, then click a wall slot to place it.").color(BRAND_INK_SOFT));
            ui.separator();
            egui::ScrollArea::vertical().show(ui, |ui| {
                for c in &ch_snapshot {
                    let selected = app.selected_channel_id.as_deref() == Some(c.id.as_str());
                    let bg = if selected {
                        BRAND_ACCENT.linear_multiply(0.15)
                    } else {
                        Color32::WHITE
                    };
                    let row = egui::Frame::default()
                        .fill(bg)
                        .corner_radius(4)
                        .inner_margin(egui::Margin::symmetric(6, 4))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                // Logo (or coloured monogram fallback).
                                let logo_size = Vec2::new(32.0, 32.0);
                                if let Some(Some(tex)) = app.logos.get(&c.id) {
                                    ui.add(egui::Image::new(tex).fit_to_exact_size(logo_size).corner_radius(3.0));
                                } else {
                                    let (rect, _) = ui.allocate_exact_size(logo_size, egui::Sense::hover());
                                    let color = SLOT_COLORS[c.name.len() % SLOT_COLORS.len()];
                                    ui.painter().rect_filled(rect, 3.0, color);
                                    let initials: String = c.name.chars().take(2).collect::<String>().to_uppercase();
                                    ui.painter().text(
                                        rect.center(),
                                        egui::Align2::CENTER_CENTER,
                                        initials,
                                        egui::FontId::proportional(12.0),
                                        Color32::WHITE,
                                    );
                                }
                                ui.add_space(8.0);
                                ui.vertical(|ui| {
                                    ui.label(RichText::new(&c.name).strong().color(BRAND_INK));
                                    let dot_color = if c.online {
                                        Color32::from_rgb(60, 220, 120)
                                    } else {
                                        Color32::from_gray(120)
                                    };
                                    ui.label(
                                        RichText::new(if c.online { "● online" } else { "○ offline" })
                                            .size(10.0)
                                            .color(dot_color),
                                    );
                                });
                            });
                        });
                    let resp = row.response.interact(egui::Sense::click());
                    if resp.clicked() {
                        app.selected_channel_id = Some(c.id.clone());
                    }
                    ui.add_space(2.0);
                }
            });
        });

    // Central preview area — draws the layout as coloured tiles with
    // channel name / "Slot N" text. Native video windows overlay this
    // area in fullscreen mode; in config mode it's egui-only.
    egui::CentralPanel::default()
        .frame(egui::Frame::default().fill(BRAND_BG))
        .show(ctx, |ui| {
            let layout = layouts::by_id(&app.cfg.layout);
            let mut assigns: Vec<String> = app.cfg.layout_slots.get(&app.cfg.layout).cloned().unwrap_or_default();
            assigns.resize(layout.slot_count(), String::new());
            let painter_rect = ui.max_rect();
            let by_id: std::collections::HashMap<&str, &Channel> =
                app.channels.iter().map(|c| (c.id.as_str(), c)).collect();

            let mut clicked_slot: Option<usize> = None;
            let mut context_slot: Option<usize> = None;
            for (idx, slot) in layout.slots.iter().enumerate() {
                let x0 = painter_rect.min.x + slot.relx * painter_rect.width();
                let y0 = painter_rect.min.y + slot.rely * painter_rect.height();
                let w = slot.relwidth * painter_rect.width();
                let h = slot.relheight * painter_rect.height();
                let rect = egui::Rect::from_min_size(egui::pos2(x0, y0), egui::vec2(w, h));

                let color = SLOT_COLORS[idx % SLOT_COLORS.len()];
                ui.painter().rect_filled(rect.shrink(2.0), 4.0, color);
                ui.painter().rect_stroke(
                    rect.shrink(2.0),
                    4.0,
                    egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 30)),
                    egui::StrokeKind::Inside,
                );

                let ch = assigns.get(idx).and_then(|id| if id.is_empty() { None } else { by_id.get(id.as_str()).copied() });
                let label_text = match ch {
                    Some(c) => c.name.clone(),
                    None => format!("Slot {}", idx + 1),
                };
                // Draw channel logo above the name if we have one loaded.
                let logo_max = (rect.height() * 0.5).clamp(24.0, 128.0);
                let text_y_offset = if let Some(c) = ch {
                    if let Some(Some(tex)) = app.logos.get(&c.id) {
                        let sz = tex.size_vec2();
                        let scale = (logo_max / sz.y).min(logo_max / sz.x).min(1.0);
                        let dst = Vec2::new(sz.x * scale, sz.y * scale);
                        let logo_rect = egui::Rect::from_center_size(
                            egui::pos2(rect.center().x, rect.center().y - dst.y * 0.55),
                            dst,
                        );
                        egui::Image::new(tex)
                            .paint_at(ui, logo_rect);
                        dst.y * 0.55 + 4.0
                    } else {
                        0.0
                    }
                } else {
                    0.0
                };
                let font_size = if ch.is_some() {
                    (rect.height() * 0.08).clamp(10.0, 24.0)
                } else {
                    (rect.height() * 0.12).clamp(10.0, 44.0)
                };
                ui.painter().text(
                    egui::pos2(rect.center().x, rect.center().y + text_y_offset),
                    egui::Align2::CENTER_CENTER,
                    &label_text,
                    egui::FontId::proportional(font_size),
                    Color32::WHITE,
                );

                let click = ui.interact(rect, egui::Id::new(("slot", idx)), egui::Sense::click_and_drag());
                if click.clicked() {
                    clicked_slot = Some(idx);
                }
                if click.secondary_clicked() {
                    context_slot = Some(idx);
                }
                // Context menu on right-click — Clear / Fill mode / Restart.
                click.context_menu(|ui| {
                    if let Some(c) = ch {
                        ui.label(RichText::new(&c.name).strong());
                        ui.separator();
                        let current = app.cfg.get_fill_mode(&c.slug);
                        ui.label("Fill mode");
                        for (label, mode) in [
                            ("Stretch (fill, small distortion)", FillMode::Stretch),
                            ("Crop-fill (remove black bars)", FillMode::Crop),
                            ("Fit (letterbox, preserve aspect)", FillMode::Fit),
                        ] {
                            let selected = current == mode;
                            let marker = if selected { "✓ " } else { "   " };
                            if ui.button(format!("{marker}{label}")).clicked() {
                                app.cfg.set_fill_mode(&c.slug, mode);
                                let _ = app.cfg.save();
                                ui.close_menu();
                            }
                        }
                        ui.separator();
                    }
                    if ui.button("Clear slot").clicked() {
                        assigns[idx] = String::new();
                        save_assigns(&mut app.cfg, &layout, &assigns);
                        ui.close_menu();
                    }
                });
                let _ = context_slot;
            }

            if let Some(idx) = clicked_slot {
                if let Some(id) = &app.selected_channel_id {
                    assigns[idx] = id.clone();
                    save_assigns(&mut app.cfg, &layout, &assigns);
                } else {
                    app.status_msg = "Pick a channel from the right panel first.".to_string();
                }
            }
        });
}

fn save_assigns(cfg: &mut Config, layout: &Layout, assigns: &[String]) {
    cfg.layout_slots.insert(layout.id.to_string(), assigns.to_vec());
    let _ = cfg.save();
}

// ------------------------------------------------------------------ fullscreen

fn enter_fullscreen(app: &mut App) {
    if app.wall_child.is_some() {
        return; // already up
    }
    let start = WallStart::from_cfg(&app.cfg, app.channels.clone());
    match wall_window::spawn_child(&start) {
        Ok(child) => {
            app.wall_child = Some(child);
            app.screen = Screen::Fullscreen;
            app.status_msg = "Fullscreen running (Esc / F11 in wall window to exit)".to_string();
        }
        Err(e) => {
            app.status_msg = format!("Failed to spawn wall: {e}");
        }
    }
}

fn draw_fullscreen_pending(app: &mut App, ctx: &egui::Context) {
    // Poll child process each frame — when it exits (user pressed
    // Esc / F11 or closed the window), come back to Config.
    let child_exited = if let Some(child) = app.wall_child.as_mut() {
        matches!(child.try_wait(), Ok(Some(_)))
    } else {
        false
    };
    if child_exited {
        app.wall_child = None;
        app.screen = Screen::Config;
        app.status_msg = "Wall closed".to_string();
    }

    egui::CentralPanel::default()
        .frame(egui::Frame::default().fill(BRAND_BG))
        .show(ctx, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space(80.0);
                if let Some(tex) = &app.navy_logo_tex {
                    let sz = tex.size_vec2();
                    let s = (120.0 / sz.y).min(120.0 / sz.x);
                    ui.add(egui::Image::new(tex).fit_to_exact_size(Vec2::new(sz.x * s, sz.y * s)));
                    ui.add_space(12.0);
                }
                ui.label(RichText::new("▶ Wall running").size(28.0).color(BRAND_ACCENT));
                ui.add_space(8.0);
                ui.label(
                    RichText::new("Press Esc or F11 in the wall window to return.")
                        .color(BRAND_INK_SOFT),
                );
                ui.add_space(24.0);
                if ui
                    .add(
                        egui::Button::new(RichText::new("Exit fullscreen").strong().color(Color32::WHITE))
                            .fill(BRAND_ACCENT)
                            .min_size(Vec2::new(220.0, 36.0)),
                    )
                    .clicked()
                {
                    if let Some(child) = app.wall_child.as_mut() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    app.wall_child = None;
                    app.screen = Screen::Config;
                }
            });
        });
    ctx.request_repaint_after(std::time::Duration::from_millis(300));
}

// ------------------------------------------------------------------ style

fn install_style(ctx: &egui::Context) {
    // Light PAK NAVY theme — white surfaces, navy-green accents,
    // near-black ink. All widgets inherit these colors so we don't
    // have to override per-widget everywhere.
    let mut style = (*ctx.style()).clone();
    style.visuals = egui::Visuals::light();
    style.visuals.override_text_color = Some(BRAND_INK);
    style.visuals.window_fill = BRAND_BG;
    style.visuals.panel_fill = BRAND_BG;
    style.visuals.extreme_bg_color = Color32::WHITE;
    style.visuals.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, BRAND_LINE);
    style.visuals.widgets.inactive.bg_fill = Color32::WHITE;
    style.visuals.widgets.inactive.weak_bg_fill = Color32::WHITE;
    style.visuals.widgets.inactive.bg_stroke = egui::Stroke::new(1.0, BRAND_LINE);
    style.visuals.widgets.hovered.bg_fill = BRAND_ACCENT.linear_multiply(0.12);
    style.visuals.widgets.hovered.bg_stroke = egui::Stroke::new(1.0, BRAND_ACCENT);
    style.visuals.widgets.active.bg_fill = BRAND_ACCENT_DARK;
    style.visuals.widgets.active.bg_stroke = egui::Stroke::new(1.0, BRAND_ACCENT_DARK);
    style.visuals.selection.bg_fill = BRAND_ACCENT;
    style.visuals.selection.stroke = egui::Stroke::new(1.0, BRAND_ACCENT_DARK);
    style.visuals.hyperlink_color = BRAND_ACCENT;
    style.spacing.item_spacing = egui::vec2(8.0, 6.0);
    style.spacing.button_padding = egui::vec2(12.0, 8.0);
    ctx.set_style(style);
}
