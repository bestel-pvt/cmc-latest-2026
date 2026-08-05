//! GStreamer pipeline construction.
//!
//! One helper per source type. Each returns a `parse_launch`-friendly
//! DSL string with a `d3d11videosink name=vsink` at the tail — the
//! caller attaches its HWND via `VideoOverlay::set_window_handle` after
//! parsing.
//!
//! Why not build elements by hand? For 32 pipelines, `parse_launch`
//! is dramatically faster to iterate on (edit the string, rebuild)
//! and produces identical graphs. We can migrate to manual assembly
//! if we need finer control later (dynamic pipeline rewrites, etc.).

use anyhow::{anyhow, Result};

/// A parsed multicast UDP source. VLC-style URIs like
/// `udp://@239.1.1.5:1111?localaddr=10.51.80.202` are decomposed into
/// the pieces GStreamer's `udpsrc` element expects.
#[derive(Debug, Clone)]
pub struct UdpSource {
    pub address: String,           // e.g. "239.1.1.5"
    pub port: u16,                 // e.g. 1111
    pub bind_address: Option<String>, // NIC IPv4 to bind IGMP join to
}

impl UdpSource {
    /// Parse a URL in either the raw GStreamer form (`udp://239.1.1.5:1111`)
    /// or the VLC form we inherit from the Python viewer / satellite
    /// config (`udp://@239.1.1.5:1111?localaddr=10.51.80.202`).
    pub fn parse(url: &str) -> Result<Self> {
        let s = url.trim();
        // Strip the scheme and optional VLC "@" listener marker.
        let after_scheme = s
            .strip_prefix("udp://")
            .or_else(|| s.strip_prefix("rtp://"))
            .ok_or_else(|| anyhow!("unsupported URL scheme: {s}"))?;
        let stripped = after_scheme.strip_prefix('@').unwrap_or(after_scheme);
        // Split off query string (`?localaddr=…`) — we only handle
        // that one query key today, but the loop keeps us open to more.
        let (host_port, query) = match stripped.split_once('?') {
            Some((hp, q)) => (hp, Some(q)),
            None => (stripped, None),
        };
        let (address, port_str) = host_port
            .rsplit_once(':')
            .ok_or_else(|| anyhow!("missing port in URL: {s}"))?;
        let port: u16 = port_str
            .parse()
            .map_err(|e| anyhow!("bad port in URL {s}: {e}"))?;

        let mut bind_address = None;
        if let Some(q) = query {
            for kv in q.split('&') {
                if let Some((k, v)) = kv.split_once('=') {
                    if k.eq_ignore_ascii_case("localaddr") && !v.is_empty() {
                        bind_address = Some(v.to_string());
                    }
                }
            }
        }
        Ok(UdpSource { address: address.to_string(), port, bind_address })
    }
}

/// Preferred pipeline for a UDP MPEG-TS source on Windows with a
/// D3D11-capable GPU. If any of the d3d11 elements are missing at
/// runtime (older driver, no GPU) the caller should retry with
/// `udp_ts_swdec`.
///
/// `sync=false` on the sink is deliberate — the wall shows live news,
/// small A/V drift is invisible (no audio at all in this viewer) and
/// removing the clock-sync stage keeps each tile independent from the
/// pipeline clock, avoiding cascading stalls when one tile hiccups.
pub fn udp_ts_d3d11(src: &UdpSource) -> String {
    let bind = src
        .bind_address
        .as_ref()
        .map(|a| format!(" multicast-iface={a}"))
        .unwrap_or_default();
    format!(
        "udpsrc address={addr} port={port}{bind} caps=\"video/mpegts,systemstream=(boolean)true\" \
             buffer-size=2097152 \
         ! tsdemux \
         ! h264parse config-interval=-1 \
         ! d3d11h264dec \
         ! d3d11convert \
         ! d3d11videosink name=vsink sync=false",
        addr = src.address,
        port = src.port,
    )
}

/// Software-decode fallback. `deinterlace method=1` (linear) is cheap
/// enough to keep in the software path for the interlaced Pakistani
/// broadcasters (1080i) that lose all text legibility otherwise.
///
/// Sink is `d3d11videosink` — the renderer works on ANY host with
/// even the Microsoft Basic Display Adapter (verified on the CMC
/// server via RDP). Only the DECODER path changes here: we use
/// `avdec_h264` (libav software decode) instead of `d3d11h264dec`
/// so this pipeline builds on hosts that lack a GPU video interface.
pub fn udp_ts_swdec(src: &UdpSource) -> String {
    let bind = src
        .bind_address
        .as_ref()
        .map(|a| format!(" multicast-iface={a}"))
        .unwrap_or_default();
    // Perf-tuned software decode:
    //   * `max-threads=4`     — parallel H.264 slice decode; on the
    //                            server this drops per-tile CPU by
    //                            roughly 3× vs single-threaded.
    //   * `skip-frame=0` / `lowres=0` — explicit "no quality shortcuts".
    //   * `deinterlace mode=interlaced` — only ENGAGES deinterlace when
    //                            the source is actually flagged
    //                            interlaced; progressive channels pass
    //                            straight through with zero CPU cost.
    //   * `videoconvert` (not videoconvertscale) — d3d11videosink does
    //                            its own colour convert + scale on GPU
    //                            paths, so we only need format hand-off.
    //   * `queue max-size-buffers=6 leaky=downstream` between decode
    //                            and sink → decoder never blocks on
    //                            vout, and vout never accumulates a
    //                            long backlog if the CPU slips.
    // `h264parse` re-frames tsdemux's byte-stream output into the
    // `stream-format=avc` chunks avdec_h264 wants — mandatory, cannot
    // skip. Its "broken NAL will be dropped" warnings are noisy but
    // non-fatal: they refer to non-conformant SEI messages Pakistani
    // channels ship (custom ad markers). The Slice drops similarly
    // happen only on damaged frames the decoder couldn't render anyway.
    // Perf-tuned software path, with room to absorb the noisy H.264
    // streams Pakistani broadcasters ship (custom SEI + occasional
    // broken slices). Key knobs:
    //   * `buffer-size=8388608` — 8 MB socket buffer to survive
    //     multicast bursts without packet drops at OS level.
    //   * `queue max-size-time=1s` before decode — small jitter buffer
    //     so h264parse doesn't stall the whole graph when it drops a
    //     malformed NAL (Slice/SEI). Was the biggest cause of visible
    //     stutter on the server test.
    //   * `skip-frame=default` — no frame skipping. non-ref was
    //     compounding drops on already-lossy input.
    //   * `deinterlace mode=auto` — passthrough for progressive, only
    //     engages when the input is genuinely interlaced.
    // Timestamp-tolerance pipeline. Satellite MPEG-TS feeds from
    // Pakistani broadcasters have jittery PCR clocks (skew resets
    // ~every 30 s). GStreamer's default `avdec_h264` treats
    // "decreasing timestamp" as an error and drops the frame, which
    // is exactly what visibly stutters vs VLC. VLC never sync-checks
    // decoded frames.
    //
    //   * `identity single-segment=true` — strip incoming timestamps
    //     and re-stamp from the pipeline clock; decoder sees a clean
    //     monotonic stream so no more "decreasing timestamp" drops.
    //   * `output-corrupt=true` — even if a slice arrives partial,
    //     let the decoder emit what it CAN; visually way better than
    //     a gap.
    //   * `deinterlace mode=disabled` — none of the direct-UDP
    //     feeds we've seen are actually interlaced, and toggling
    //     yadif on/off per frame accounts for measurable CPU. If
    //     an interlaced source turns up we'll re-enable per channel.
    //   * Big pre-decoder queue absorbs UDP burstiness without
    //     the demuxer blocking on decoder.
    // Minimal-drop pipeline mirroring VLC's default behaviour:
    //   * No identity/timestamp mangling — let the decoder handle
    //     its own reorder (identity single-segment was CAUSING new
    //     stutter, not fixing).
    //   * `output-corrupt=true` — emit even partially-decoded frames
    //     instead of gapping. Matches VLC's tolerance.
    //   * Big pre-decoder queue to absorb UDP burstiness.
    //   * Single post-decoder queue with leaky=downstream so the
    //     sink can never back-pressure the decoder.
    // Zero-drop pipeline: skip `h264parse` entirely. Its strict
    // validation drops SEI + slice NALs that VLC accepts silently,
    // and those drops account for the residual stutter vs VLC.
    // `tsdemux` emits H.264 as byte-stream; `avdec_h264` accepts
    // byte-stream directly — no parser needed in between. A capsfilter
    // makes the negotiation explicit so avdec_h264 doesn't hunt for
    // an intermediary at runtime.
    build_swdec_pipeline(src, 0)
}

/// Software-decode pipeline with layout-aware post-decode downsample.
///
///   `downsample_to > 0` — pin the sink's incoming frames to that
///                          height (preserving aspect). Grid32 pipes
///                          this at 360 so 32 concurrent d3d11 swap
///                          chains fit within driver limits AND text
///                          still readable on typical tile sizes.
///   `downsample_to = 0` — full source resolution through to sink.
///                          Used for layouts with ≤ 20 tiles where
///                          d3d11 has headroom + we want max clarity.
///
/// `decodebin3` auto-picks the codec (H.264, H.265, MPEG-2) so
/// mixed-codec channel lineups like PAK NAVY's (some H.265 news
/// channels) all decode without manual per-codec plumbing.
pub fn build_swdec_pipeline(src: &UdpSource, downsample_to: u32) -> String {
    build_swdec_h264(src, downsample_to)
}

/// H.264-specific software decode with aggressive CPU-savings tuning
/// — the fast path most channels take. `avdec_h264` accepts
/// `lowres=1` (decode at half source resolution inside the decoder)
/// and `skip-frame=non-ref` (drop non-reference frames). Combined
/// these cut CPU per tile ~8× — 32 concurrent streams become
/// tractable on a CPU-only host.
///
/// Small-tile clarity + smoothness pass (only kicks in when
/// downsample_to > 0):
///   * `videobalance contrast=1.15 saturation=1.05` — perceived-
///     sharpness bump. At a 240 px tile the ticker text can't be
///     PIXEL-sharp (physical budget won't allow), but pushing local
///     contrast + saturation makes it readable rather than a smudge.
///     Cheaper + more portable than a real unsharp-mask filter.
///   * `videorate drop-only=true` with a per-tier fps cap —
///     Grid32 tiles = 15 fps, Mosaic tiles = 20 fps. Motion still
///     reads smoothly at that tile size + saves ~40 % CPU per
///     stream. drop-only=true means we NEVER duplicate frames,
///     just skip the excess — no visual "hold" artifact.
///   * Post-decoder queue capped at 100 ms — anything sitting
///     longer is dropped by `leaky=downstream` rather than
///     accumulating. Prevents the pipeline from falling further
///     and further behind under momentary CPU load.
pub fn build_swdec_h264(src: &UdpSource, downsample_to: u32) -> String {
    let bind = src
        .bind_address
        .as_ref()
        .map(|a| format!(" multicast-iface={a}"))
        .unwrap_or_default();
    let (scale, punch, rate) = if downsample_to > 0 {
        let fps = if downsample_to <= 260 { 15 } else { 20 };
        (
            format!(" ! videoscale method=lanczos ! video/x-raw,height={downsample_to},pixel-aspect-ratio=1/1"),
            " ! videobalance contrast=1.15 saturation=1.05".to_string(),
            format!(" ! videorate drop-only=true ! video/x-raw,framerate={fps}/1"),
        )
    } else {
        (String::new(), String::new(), String::new())
    };
    format!(
        "udpsrc address={addr} port={port}{bind} caps=\"video/mpegts,systemstream=(boolean)true\" \
             buffer-size=16777216 \
         ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=2000000000 \
         ! tsdemux \
         ! h264parse config-interval=-1 \
         ! avdec_h264 max-threads=4 skip-frame=non-ref lowres=1 output-corrupt=true \
         ! queue max-size-buffers=8 max-size-time=100000000 max-size-bytes=0 leaky=downstream \
         ! videoconvert{scale}{punch}{rate} \
         ! d3d11videosink name=vsink sync=false",
        addr = src.address,
        port = src.port,
    )
}

/// Codec-agnostic — `decodebin3` handles H.264, H.265, MPEG-2 etc.
/// `sink_kind` selects the sink family (see `SinkKind`).
///
/// glimagesink is preferred because ALL sinks in the process share a
/// single `GstGLDisplay`/context — 32 concurrent sinks cost O(1) in
/// GPU driver resources, not O(N). d3d11videosink allocates a fresh
/// D3D11 device + swap chain per pipeline; at N ≈ 24+ it exhausts
/// the driver and tiles start showing the desktop through.
pub fn build_swdec_any_codec(src: &UdpSource, downsample_to: u32, sink_kind: SinkKind) -> String {
    let bind = src
        .bind_address
        .as_ref()
        .map(|a| format!(" multicast-iface={a}"))
        .unwrap_or_default();
    // Same tier-based small-tile treatment as build_swdec_h264 — see
    // that function's doc for the reasoning behind each element.
    let (scale, punch, rate) = if downsample_to > 0 {
        let fps = if downsample_to <= 260 { 15 } else { 20 };
        (
            format!(" ! videoscale method=lanczos ! video/x-raw,height={downsample_to},pixel-aspect-ratio=1/1"),
            " ! videobalance contrast=1.15 saturation=1.05".to_string(),
            format!(" ! videorate drop-only=true ! video/x-raw,framerate={fps}/1"),
        )
    } else {
        (String::new(), String::new(), String::new())
    };
    let sink_chain = match sink_kind {
        SinkKind::GlShared => " ! glupload ! glimagesink name=vsink sync=false force-aspect-ratio=false",
        SinkKind::D3d11 => " ! d3d11videosink name=vsink sync=false",
        // Last-resort: whatever plugin registered on this host.
        // autovideosink swaps to the best-available sink at runtime
        // — on RDP or a headless Windows Server box (no D3D11
        // interface, no Mesa OpenGL) it typically picks
        // directdrawsink / d3dvideosink from gst-plugins-good, both
        // of which render fine on the Basic Display Adapter.
        SinkKind::Auto => " ! autovideosink name=vsink sync=false",
    };
    format!(
        "udpsrc address={addr} port={port}{bind} caps=\"video/mpegts,systemstream=(boolean)true\" \
             buffer-size=16777216 \
         ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=2000000000 \
         ! tsdemux \
         ! decodebin3 \
         ! queue max-size-buffers=8 max-size-time=100000000 max-size-bytes=0 leaky=downstream \
         ! videoconvert{scale}{punch}{rate}{sink_chain}",
        addr = src.address,
        port = src.port,
    )
}

#[derive(Copy, Clone, Debug)]
pub enum SinkKind {
    /// glimagesink — shared OpenGL context across N sinks. Best at
    /// scale (Grid32); requires OpenGL support (Mesa if no native).
    GlShared,
    /// d3d11videosink — one D3D11 device per sink. Fast on GPU
    /// hosts but caps out around 20 concurrent sinks before the
    /// driver runs out of swap chain slots.
    D3d11,
    /// autovideosink — GStreamer picks whatever's actually
    /// registered on this host. Ultimate fallback for headless /
    /// RDP servers where neither GL nor D3D11 initialise.
    Auto,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vlc_style_udp() {
        let s = UdpSource::parse("udp://@239.1.1.5:1111?localaddr=10.51.80.202").unwrap();
        assert_eq!(s.address, "239.1.1.5");
        assert_eq!(s.port, 1111);
        assert_eq!(s.bind_address.as_deref(), Some("10.51.80.202"));
    }

    #[test]
    fn parses_bare_udp() {
        let s = UdpSource::parse("udp://224.2.2.2:3108").unwrap();
        assert_eq!(s.address, "224.2.2.2");
        assert_eq!(s.port, 3108);
        assert!(s.bind_address.is_none());
    }

    #[test]
    fn rejects_bad_scheme() {
        assert!(UdpSource::parse("http://example.com").is_err());
    }
}
