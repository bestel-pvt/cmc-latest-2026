//! CMC Video Wall — production application.
//!
//! Entry-point wires up the tokio runtime, the eframe (egui) chrome
//! window, and lifts everything into the App struct in `ui.rs`.
//! Real video tiles live in separate borderless winit windows that
//! GStreamer draws into via HWND overlay — see `wall_window.rs`.

// NB: keep the console attached — the eframe boot path can bail
// early on hosts with a basic-display adapter, and we want the log
// visible. Once startup is bullet-proof we'll switch back to
// `#![windows_subsystem = "windows"]` for the shipping build.

mod api;
mod config;
mod gst_pipeline;
mod layouts;
mod logo_cache;
mod tile;
mod ui;
mod wall;
mod wall_window;

use anyhow::Result;
use gstreamer as gst;

fn main() -> Result<()> {
    // Env-based logger — bump via RUST_LOG=debug when debugging.
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .init();
    log::info!("CMC-VideoWall starting");
    std::panic::set_hook(Box::new(|info| {
        eprintln!("PANIC: {info}");
        log::error!("PANIC: {info}");
    }));

    // Sub-command dispatch: `--wall <path-to-json>` runs the wall
    // process (own event loop, no eframe). Anything else launches
    // the normal UI. Splitting these keeps winit happy — its
    // `EventLoop` can only exist once per process, and eframe owns
    // one for the UI.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--wall") {
        gst::init()?;
        let json_path = args
            .iter()
            .position(|a| a == "--wall")
            .and_then(|i| args.get(i + 1))
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("--wall requires a config path"))?;
        return wall_window::run_from_json(&json_path);
    }

    // UI mode — tokio for async API/logo work, eframe for the shell.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("cmc-tokio")
        .build()?;
    let _rt_guard = rt.enter();

    gst::init()?;

    let cfg = config::Config::load();

    let mut viewport = eframe::egui::ViewportBuilder::default()
        .with_title("CMC Video Wall — Powered by Analysys")
        .with_inner_size([1280.0, 800.0])
        .with_min_inner_size([960.0, 600.0])
        .with_resizable(true);
    if let Some(icon) = load_icon() {
        viewport = viewport.with_icon(icon);
    }
    let native_options = eframe::NativeOptions {
        viewport,
        vsync: true,
        centered: true,
        ..Default::default()
    };

    eframe::run_native(
        "CMC Video Wall",
        native_options,
        Box::new(move |cc| Ok(Box::new(ui::App::new(cc, cfg)))),
    )
    .map_err(|e| anyhow::anyhow!("eframe: {e}"))?;

    Ok(())
}

/// PAK NAVY tab icon — decoded from the bundled crest PNG and
/// composited onto a solid white square so the taskbar icon reads
/// crisply regardless of the theme (the raw crest has a transparent
/// background that disappears against Windows' dark taskbar).
fn load_icon() -> Option<eframe::egui::IconData> {
    use image::{GenericImageView, Rgba};
    const BYTES: &[u8] = include_bytes!("../assets/pak-navy-logo.png");
    let src = image::load_from_memory(BYTES).ok()?;
    let (sw, sh) = src.dimensions();
    // Square canvas sized to the longer side, padded a little so
    // the crest doesn't touch the icon edge.
    let side = sw.max(sh);
    let pad = side / 12;
    let canvas_side = side + pad * 2;
    let mut canvas = image::ImageBuffer::from_pixel(
        canvas_side,
        canvas_side,
        Rgba([255u8, 255, 255, 255]),
    );
    // Paste crest centred; alpha-blend against white so we end up
    // with a clean opaque icon.
    let src_rgba = src.to_rgba8();
    let x0 = (canvas_side - sw) / 2;
    let y0 = (canvas_side - sh) / 2;
    for (x, y, px) in src_rgba.enumerate_pixels() {
        let a = px[0] as u32 * px[3] as u32 / 255;
        let b = 255 - px[3] as u32;
        let r = a + b;
        let g_ = (px[1] as u32 * px[3] as u32 / 255) + b;
        let bl = (px[2] as u32 * px[3] as u32 / 255) + b;
        canvas.put_pixel(x0 + x, y0 + y, Rgba([r as u8, g_ as u8, bl as u8, 255]));
    }
    let (w, h) = canvas.dimensions();
    Some(eframe::egui::IconData {
        rgba: canvas.into_raw(),
        width: w,
        height: h,
    })
}
