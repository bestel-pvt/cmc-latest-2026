import fp from 'fastify-plugin';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { stringify } from 'yaml';
import { request } from 'undici';
import { env } from '../env.js';

/**
 * MediaMTX control plane:
 *  - reads channels + sources from Postgres
 *  - re-writes mediamtx.yml
 *  - triggers a hot reload (`POST /v3/config/reload`)
 *
 * In production, per-channel paths use an ffmpeg PTS-normalizing remux stage
 * as the source so failover switches happen on aligned timelines and viewers
 * see at most a single-segment glitch on switch.
 */

declare module 'fastify' {
  interface FastifyInstance {
    mediamtx: {
      regenerateConfig: () => Promise<void>;
      reload: () => Promise<void>;
      setActiveSource: (channelSlug: string, sourceUrl: string, kind: string) => Promise<void>;
    };
  }
}

function buildPath(kind: string, url: string): string {
  // Normalise the URL to MediaMTX's expected syntax.
  //   FFmpeg / VLC:     udp://@224.2.2.2:2020   (the @ means "listen / multicast join")
  //   MediaMTX source:  udp://224.2.2.2:2020    (no @; MediaMTX joins automatically)
  // Same for RTP.
  if (kind === 'UDP' || kind === 'RTP') {
    return url.replace(/^(udp|rtp):\/\/@/i, (_m, p) => `${p.toLowerCase()}://`);
  }
  return url;
}

export default fp(async (app) => {
  async function regenerateConfig() {
    const channels = await app.prisma.channel.findMany({
      where: { active: true },
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }] } },
    });

    // Load current file so we don't clobber operator-tuned top-level knobs.
    let baseConfig: Record<string, unknown> = {};
    if (existsSync(env.MEDIAMTX_CONFIG_PATH)) {
      try {
        const raw = await readFile(env.MEDIAMTX_CONFIG_PATH, 'utf8');
        const YAML = await import('yaml');
        baseConfig = YAML.parse(raw) ?? {};
      } catch { baseConfig = {}; }
    }

    // Host that MediaMTX will publish DEMP's own re-broadcast on. Consumers
    // on the same LAN use this + Channel.dempOutputPort to attach with VLC.
    const publishHost = process.env.PUBLIC_STREAM_HOST ?? '127.0.0.1';

    // Two paths per channel:
    //   * <slug>          — mediamtx auto-pulls the UDP source and keeps
    //                       it warm (single IGMP join, mtxReady stays
    //                       true → health checks work + demp-rebroadcast /
    //                       recording / ticker-detect still see it).
    //                       Serving raw HD to a viewer here costs
    //                       ~30 Mbps out, so we ask clients not to
    //                       use it for viewing.
    //   * <slug>-lo       — on-demand 480p H264+AAC transcode. mediamtx
    //                       spawns ffmpeg only when a viewer connects;
    //                       kills it 30 s after the last viewer leaves.
    //                       ~600 kbps out per viewer, ~5 % of one core.
    // All clients (VLC, Python wall) subscribe to <slug>-lo — that's
    // what dempOutputUrlRtsp resolves to now.
    const paths: Record<string, unknown> = {};
    for (const ch of channels) {
      const active = ch.sources.find((s) => s.isPrimary) ?? ch.sources[0];
      if (!active) continue;

      // Raw path — auto-pull UDP so mtxReady + bytesReceived flow. This
      // is what keeps our health signal alive.
      paths[ch.slug] = {
        source: buildPath(active.kind, active.url),
        sourceOnDemand: false,
      };

      // On-demand 480p transcode path.
      let sourceUrl = active.url.trim();
      if (active.kind === 'UDP' && sourceUrl.includes('://')) {
        const parts = sourceUrl.split('://', 2);
        if (parts[1] && !parts[1]!.startsWith('@')) {
          sourceUrl = `${parts[0]!.toLowerCase()}://@${parts[1]!}`;
        }
      }
      // Tuned for FIRST-KEYFRAME LATENCY, not compression ratio:
      //   -preset ultrafast + -tune zerolatency  → x264 emits its
      //     first NAL within ~150 ms of receiving a source frame
      //     (vs ~2 s on veryfast).
      //   -g 25 -force_key_frames "expr:gte(t,n_forced*1)"
      //     → keyframe every 1 s; the client can start decoding on
      //     the very first frame of the stream, not wait 2-3 GOPs.
      //   -fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0
      //     → tell ffmpeg to stop bufferbloating on the input side.
      //   The whole transcoder now cold-starts in ~1-2 s, well under
      //   VLC's 30 s cache. runOnDemand path is finally usable
      //   without a 'blank tile' failure for the first play.
      // preset veryfast (NOT ultrafast) — ultrafast disables enough
      // rate-control machinery inside libx264 that it produces
      // constant "VBV underflow" chatter and delivers a broken TS
      // stream, which is why the viewer was seeing every -lo path
      // 404 / stall and falling back to raw HD (26 Mbps × 4 tiles).
      // veryfast still gives us ~1 s first-keyframe latency but
      // actually respects -b:v / -bufsize.
      const transcodeCmd =
        `ffmpeg -hide_banner -nostdin -loglevel warning ` +
        `-fflags +discardcorrupt+igndts+genpts+nobuffer -flags low_delay ` +
        `-probesize 500000 -analyzeduration 1000000 -err_detect ignore_err ` +
        `-f mpegts -i '${sourceUrl}?fifo_size=100000&overrun_nonfatal=1&timeout=6000000' ` +
        `-map 0:v:0 -map 0:a:0? ` +
        `-vf scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2 ` +
        `-c:v libx264 -preset veryfast -tune zerolatency -profile:v baseline -pix_fmt yuv420p ` +
        `-threads 2 ` +
        `-b:v 700k -maxrate 1000k -bufsize 2000k ` +
        `-g 25 -keyint_min 25 -sc_threshold 0 ` +
        `-force_key_frames "expr:gte(t,n_forced*1)" ` +
        `-c:a aac -b:a 96k -ac 2 -ar 48000 ` +
        `-avoid_negative_ts make_zero ` +
        `-rtsp_transport tcp -f rtsp rtsp://127.0.0.1:8554/${ch.slug}-lo`;
      // CMC: keep EVERY -lo transcode always warm via runOnInit —
      // this deployment has only 32 channels, so ~32 × ~5 % of a core
      // = ~1.5 cores steady, well within the R740XD2 budget, and the
      // client (video wall, VLC) sees the stream immediately with
      // zero cold-start.
      paths[`${ch.slug}-lo`] = {
        source: 'publisher',
        runOnInit: transcodeCmd,
        runOnInitRestart: true,
      };
    }
    void publishHost;
    // Explicitly turn OFF the HLS server so we don't accidentally keep
    // serving stale variants once the transcoder pool is gone.
    (baseConfig as Record<string, unknown>).hls = false;
    (baseConfig as Record<string, unknown>).hlsAlwaysRemux = false;

    const next = { ...baseConfig, paths: Object.keys(paths).length ? paths : (baseConfig as { paths?: unknown }).paths };
    await writeFile(env.MEDIAMTX_CONFIG_PATH, stringify(next), 'utf8');
  }

  async function reload() {
    try {
      const r = await request(`${env.MEDIAMTX_API_URL}/v3/config/global/patch`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (r.statusCode >= 400) app.log.warn({ status: r.statusCode }, 'mediamtx reload returned non-2xx');
    } catch (err) {
      app.log.warn({ err }, 'mediamtx reload failed (is the container up?)');
    }
  }

  async function setActiveSource(channelSlug: string, sourceUrl: string, kind: string) {
    // Called by failover-controller (via a fetch), or directly from routes when
    // an operator forces a switch. We patch just the one path.
    try {
      const r = await request(`${env.MEDIAMTX_API_URL}/v3/config/paths/patch/${encodeURIComponent(channelSlug)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: buildPath(kind, sourceUrl) }),
      });
      if (r.statusCode >= 400) app.log.warn({ status: r.statusCode, channelSlug }, 'mediamtx patch path failed');
    } catch (err) {
      app.log.warn({ err, channelSlug }, 'mediamtx setActiveSource failed');
    }
  }

  app.decorate('mediamtx', { regenerateConfig, reload, setActiveSource });
});
