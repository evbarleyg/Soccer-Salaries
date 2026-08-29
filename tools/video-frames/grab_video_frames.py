#!/usr/bin/env python3
"""Turn a video (YouTube URL or local file) into a zip of timestamped still frames.

  python3 grab_video_frames.py --url https://www.youtube.com/watch?v=ID                 # yt-dlp + ffmpeg
  python3 grab_video_frames.py --url https://www.youtube.com/watch?v=ID --mode browser  # headless Chromium watches it
  python3 grab_video_frames.py --channel https://www.youtube.com/@handle --title REGEX  # pick an upload by title
  python3 grab_video_frames.py --video-file walkthrough.mp4                             # a file you already have

Setup, what lands in the zip, and tips for not getting blocked: README.md next to this file.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# YouTube player quality labels -> frame height, used to tell whether the stream reached what we asked for
QUALITY_HEIGHT = {"highres": 4320, "hd2160": 2160, "hd1440": 1440, "hd1080": 1080, "hd720": 720,
                  "large": 480, "medium": 360, "small": 240}
ALREADY_COMPRESSED = {".jpg", ".jpeg", ".png", ".mp4", ".webm", ".mkv", ".mov", ".m4a"}


def log(msg: str) -> None:
    print(f"[frames] {msg}", file=sys.stderr, flush=True)


def die(msg: str) -> None:
    log("ERROR: " + msg)
    sys.exit(2)


# --------------------------------------------------------------------------- ffmpeg
def find_ffmpeg(required: bool = True):
    exe = shutil.which("ffmpeg")
    if not exe:
        try:
            import imageio_ffmpeg  # `pip install imageio-ffmpeg` ships a static build
            exe = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            exe = None
    if not exe and required:
        die("ffmpeg not found: brew install ffmpeg / apt install ffmpeg / pip install imageio-ffmpeg")
    return exe


def ffmpeg_run(ffmpeg: str, args: list, fatal: bool = True) -> subprocess.CompletedProcess:
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y"] + [str(a) for a in args]
    log("$ " + " ".join(cmd))
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0 and "-fps_mode" in cmd and "fps_mode" in p.stderr:
        i = cmd.index("-fps_mode")                 # ffmpeg < 5.1 spells it -vsync
        cmd[i:i + 2] = ["-vsync", cmd[i + 1]]
        p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(p.stderr[-3000:])
        if fatal:
            die(f"ffmpeg failed (exit {p.returncode})")
    return p


def probe(ffmpeg: str, video: Path) -> dict:
    """Duration / size / fps from the `ffmpeg -i` banner (imageio-ffmpeg ships no ffprobe)."""
    p = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(video)], capture_output=True, text=True)
    out: dict = {"duration": None, "width": None, "height": None, "fps": None}
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", p.stderr)
    if m:
        h, mn, s = m.groups()
        out["duration"] = int(h) * 3600 + int(mn) * 60 + float(s)
    m = re.search(r"Video:.*?\b(\d{2,5})x(\d{2,5})\b(?:.*?(\d+(?:\.\d+)?) fps)?", p.stderr)
    if m:
        out["width"], out["height"] = int(m.group(1)), int(m.group(2))
        out["fps"] = float(m.group(3)) if m.group(3) else None
    return out


def slice_stills(ffmpeg: str, video: Path, out_dir: Path, vf: list, prefix: str, ext: str) -> list:
    """One ffmpeg pass with filter chain `vf`; each still is named <prefix>_<n>_t<seconds>s.<ext>."""
    out_dir.mkdir(parents=True, exist_ok=True)
    quality = [] if ext == "png" else ["-q:v", "2"]
    p = ffmpeg_run(ffmpeg, ["-i", video, "-vf", ",".join(vf + ["showinfo"]), "-fps_mode", "vfr", "-an",
                            *quality, out_dir / f"{prefix}_%05d.{ext}"])
    times = [float(t) for t in re.findall(r"pts_time:\s*([\d.]+)", p.stderr)]  # one showinfo line per still
    stills = []
    for i, f in enumerate(sorted(out_dir.glob(f"{prefix}_*.{ext}"))):
        t = times[i] if i < len(times) else None
        name = f"{prefix}_{i + 1:05d}" + (f"_t{t:07.2f}s" if t is not None else "") + f".{ext}"
        f.rename(out_dir / name)
        stills.append({"file": f"{out_dir.name}/{name}", "t": t})
    log(f"{len(stills)} stills -> {out_dir}")
    return stills


def contact_sheet(ffmpeg: str, files: list, out_file: Path) -> None:
    """Best-effort thumbnail grid (up to 64 tiles, 8 wide) of the given stills."""
    picked = files[::max(1, math.ceil(len(files) / 64))]
    cols = min(8, len(picked))
    rows = math.ceil(len(picked) / cols)
    lst = out_file.with_suffix(".ffconcat")
    lst.write_text("ffconcat version 1.0\n" + "".join(f"file '{Path(p).resolve().as_posix()}'\n" for p in picked))
    p = ffmpeg_run(ffmpeg, ["-f", "concat", "-safe", "0", "-i", lst,
                            "-vf", f"scale=240:-2,tile={cols}x{rows}:padding=4:color=white",
                            "-frames:v", "1", "-q:v", "3", out_file], fatal=False)
    lst.unlink(missing_ok=True)
    if p.returncode != 0:
        log("contact sheet skipped (ffmpeg could not tile the stills)")


# --------------------------------------------------------------------------- yt-dlp
def ytdlp():
    try:
        import yt_dlp
        return yt_dlp
    except ImportError:
        die("yt-dlp not installed: pip install yt-dlp   (or use --mode browser with --url)")


def ytdlp_opts(args, **extra) -> dict:
    o = {"quiet": True, "no_warnings": True, "noprogress": True}
    if args.cookies:
        o["cookiefile"] = args.cookies
    if args.cookies_from_browser:   # same BROWSER[+KEYRING][:PROFILE][::CONTAINER] grammar as yt-dlp's own flag
        parsed = ytdlp().parse_options(["--cookies-from-browser", args.cookies_from_browser])
        o["cookiesfrombrowser"] = parsed.ydl_opts["cookiesfrombrowser"]
    o.update(extra)
    return o


def resolve_from_channel(args) -> str:
    url = args.channel.rstrip("/")
    if not re.search(r"/(videos|shorts|streams)$", url):
        url += "/videos"
    log(f"listing {url}")
    with ytdlp().YoutubeDL(ytdlp_opts(args, extract_flat=True)) as y:
        uploads = [e for e in (y.extract_info(url, download=False).get("entries") or []) if e]
    rx = re.compile(args.title, re.I)
    hits = [e for e in uploads if rx.search(e.get("title") or "")]
    log(f"{len(uploads)} uploads, {len(hits)} match /{args.title}/i:")
    for e in uploads:
        log(f"  {'*' if e in hits else ' '} https://www.youtube.com/watch?v={e.get('id')}  {e.get('title')}")
    if len(hits) != 1:
        die("need exactly one title match - tighten --title, or copy the right URL from the list into --url")
    return f"https://www.youtube.com/watch?v={hits[0]['id']}"


def download_video(args, url: str, src_dir: Path, ffmpeg: str):
    src_dir.mkdir(parents=True, exist_ok=True)
    opts = ytdlp_opts(args, quiet=False, noprogress=False, format=args.format, retries=5,
                      outtmpl=str(src_dir / "%(id)s.%(ext)s"), writeinfojson=True,
                      merge_output_format="mp4/mkv", ffmpeg_location=ffmpeg)
    log(f"downloading {url}")
    with ytdlp().YoutubeDL(opts) as y:
        info = y.extract_info(url, download=True)
        final = (info.get("requested_downloads") or [{}])[0].get("filepath")  # post-merge path
        path = Path(final or y.prepare_filename(info))
    if not path.exists():
        die(f"download finished but {path} is missing")
    keys = ("id", "title", "webpage_url", "duration", "width", "height", "fps", "upload_date",
            "channel", "channel_url", "description")
    return path, {k: info.get(k) for k in keys}


# --------------------------------------------------------------------------- browser capture
# Installed once per page (add_init_script). Generic <video> handling; when YouTube's player API
# (#movie_player) is present it is used for play/pause/seek/quality and for waiting out pre-roll ads.
JS_LIB = r"""(() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vid = () => document.querySelector('video');
  const ytp = () => { const p = document.getElementById('movie_player');
                      return p && typeof p.playVideo === 'function' ? p : null; };
  const fg = window.__fg = {
    opts: {mime: 'image/jpeg', q: 0.92},
    play(rate) {
      const v = vid(), p = ytp();
      try { v.playbackRate = rate; if (p && p.setPlaybackRate) p.setPlaybackRate(rate); } catch (e) {}
      try { p ? p.playVideo() : v.play(); } catch (e) {}
    },
    pause() { const v = vid(), p = ytp(); try { p ? p.pauseVideo() : v.pause(); } catch (e) {} },
    state() { const v = vid(); return {at: v.currentTime, ended: v.ended, paused: v.paused}; },
    async prep({quality, targetHeight, heights, mime, q}) {
      fg.opts = {mime, q};
      let v = null;
      for (let i = 0; i < 300 && !(v = vid()); i++) await sleep(100);
      if (!v) return {error: 'no <video> element appeared on the page'};
      const p = ytp();
      if (p) {
        try { p.mute(); } catch (e) {}
        try { if (quality && p.setPlaybackQualityRange) p.setPlaybackQualityRange(quality, quality); } catch (e) {}
      } else v.muted = true;
      fg.play(1);
      const t0 = Date.now();
      let adSeen = false;
      while (Date.now() - t0 < 120000) {               // wait out pre-roll ads / initial buffering
        v = vid() || v;
        if (p && p.classList.contains('ad-showing')) {
          adSeen = true;
          const b = document.querySelector('.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button');
          if (b) try { b.click(); } catch (e) {}
        } else if (v.readyState >= 2 && v.duration > 0 && isFinite(v.duration) && v.currentTime > 0.2) break;
        await sleep(250);
      }
      if (!(v.duration > 0) || !isFinite(v.duration)) {
        const err = document.querySelector('.ytp-error, #reason, yt-player-error-message-renderer');
        return {error: 'video never became playable' + (err ? ': ' + err.innerText.trim().slice(0, 300) : '')};
      }
      // adaptive streams ramp up: give the YouTube player a few seconds to reach the requested height
      // (capped at the best quality it says this video has)
      let target = p ? targetHeight : 0;
      if (p && p.getAvailableQualityLevels) {
        const avail = p.getAvailableQualityLevels().map(l => heights[l] || 0).filter(h => h);
        if (avail.length) target = Math.min(target, Math.max(...avail));
      }
      for (let i = 0; i < 24 && v.videoHeight < target; i++) await sleep(250);
      fg.pause();
      return {duration: v.duration, width: v.videoWidth, height: v.videoHeight, yt: !!p, adSeen,
              title: (document.title || '').replace(/ - YouTube$/, '')};
    },
    async grab(t) {                                    // t == null: snapshot whatever is showing now
      const v = vid(), p = ytp();
      if (t != null && Math.abs(v.currentTime - t) > 0.02) {
        await new Promise(res => {
          let done = false;
          const fin = () => { if (!done) { done = true; res(); } };
          if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);   // the sought frame was presented
          v.addEventListener('seeked', () => setTimeout(fin, 250), {once: true}); // fallback if no new frame shows
          setTimeout(fin, 20000);
          if (p) { try { p.seekTo(t, true); } catch (e) { v.currentTime = t; } } else v.currentTime = t;
        });
        const t0 = Date.now();
        while (v.readyState < 2 && Date.now() - t0 < 20000) await sleep(50);
        if (!v.paused) fg.pause();
      }
      if (!v.videoWidth) return {error: 'video has no decoded frame (videoWidth=0)'};
      const c = fg.canvas || (fg.canvas = document.createElement('canvas'));
      if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      try { return {data: c.toDataURL(fg.opts.mime, fg.opts.q), w: c.width, h: c.height, at: v.currentTime}; }
      catch (e) { return {error: 'canvas export blocked: ' + e}; }
    },
  };
})();"""


def capture_browser(args, url: str, frames_dir: Path, ext: str):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        die("playwright not installed: pip install playwright && python3 -m playwright install chromium")
    frames_dir.mkdir(parents=True, exist_ok=True)
    launch = {"headless": not args.headed,
              "args": ["--autoplay-policy=no-user-gesture-required", "--mute-audio",
                       "--disable-blink-features=AutomationControlled"]}
    if args.use_browser:
        key = "executable_path" if ("/" in args.use_browser or "\\" in args.use_browser) else "channel"
        launch[key] = args.use_browser
    with sync_playwright() as pw:
        ctx_opts = {"viewport": {"width": 1920, "height": 1080}, "locale": "en-US",
                    "timezone_id": "America/Los_Angeles"}
        if not args.use_browser:   # bundled Chromium announces itself as HeadlessChrome; use the stock desktop UA
            ctx_opts["user_agent"] = pw.devices["Desktop Chrome"]["user_agent"]
        if args.user_data_dir:     # reuse a (signed-in) browser profile
            ctx = pw.chromium.launch_persistent_context(args.user_data_dir, **launch, **ctx_opts)
        else:
            ctx = pw.chromium.launch(**launch).new_context(**ctx_opts)
        ctx.add_init_script(script=JS_LIB)
        if re.search(r"youtube\.|youtu\.be", url) and not args.user_data_dir:
            ctx.add_cookies([  # pre-accepted consent so the EU/UK interstitial never shows
                {"name": "SOCS", "value": "CAISAiAD", "domain": ".youtube.com", "path": "/", "secure": True},
                {"name": "CONSENT", "value": "YES+1", "domain": ".youtube.com", "path": "/", "secure": True},
            ])
        page = ctx.new_page()
        log(f"opening {url} in {'headed' if args.headed else 'headless'} {args.use_browser or 'chromium'}")
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        target_h = QUALITY_HEIGHT.get(args.yt_quality, 0)
        meta = page.evaluate("o => window.__fg.prep(o)",
                             {"quality": args.yt_quality, "targetHeight": target_h, "heights": QUALITY_HEIGHT,
                              "mime": "image/png" if ext == "png" else "image/jpeg", "q": 0.92})
        if meta.get("error"):
            shot = frames_dir.parent / "browser_error.png"
            page.screenshot(path=str(shot))
            die(meta["error"] + f" (page screenshot saved to {shot})")
        dur = float(meta["duration"])
        log(f"title={meta['title']!r} duration={dur:.1f}s stream={meta['width']}x{meta['height']}")
        if meta["yt"] and meta["height"] < target_h:
            log(f"note: the player settled at {meta['height']}p, below the requested {args.yt_quality} "
                "(that may simply be the best this video has)")
        end = max(dur - 0.05, 0.0)
        times = [round(i / args.fps, 3) for i in range(int(end * args.fps) + 1)]

        def grab(t=None):
            r = page.evaluate("t => window.__fg.grab(t)", t)
            if r.get("error"):
                die(f"frame at t={t}: {r['error']}")
            r["raw"] = base64.b64decode(r["data"].split(",", 1)[1])
            return r

        probe_t = times[1] if len(times) > 1 else 0.0
        seekable = abs(grab(probe_t)["at"] - probe_t) < 0.25   # does seeking actually move the playhead?

        def by_seeking():
            for i, t in enumerate(times, 1):
                yield i, t, grab(t)

        def by_playing():   # unseekable player: play it through and snapshot each slot as it comes up
            log(f"player is not seekable here; playing it through at {args.playback_rate}x")
            grab(0.0)
            page.evaluate("r => window.__fg.play(r)", args.playback_rate)
            idx, tol, last_at, last_move = 0, 0.5 / args.fps, -1.0, time.monotonic()
            while idx < len(times):
                s = page.evaluate("() => window.__fg.state()")
                at = float(s["at"])
                if at >= times[idx] - tol:
                    while idx + 1 < len(times) and at >= times[idx + 1] - tol:
                        idx += 1                       # fell behind: skip the slots we missed
                    r = grab()
                    idx += 1
                    yield idx, float(r["at"]), r
                    continue
                if s["ended"]:
                    break
                if s["paused"]:
                    page.evaluate("r => window.__fg.play(r)", args.playback_rate)
                if at != last_at:
                    last_at, last_move = at, time.monotonic()
                elif time.monotonic() - last_move > 20:
                    die(f"playback stalled at t={at:.2f}s")
                page.wait_for_timeout(max(5, min(250, (times[idx] - tol - at) / args.playback_rate * 1000)))

        frames, seen = [], set()
        for i, t, r in (by_seeking() if seekable else by_playing()):
            digest = hashlib.sha1(r["raw"]).hexdigest()
            if args.dedupe and digest in seen:
                continue
            seen.add(digest)
            name = f"frame_{i:05d}_t{t:07.2f}s.{ext}"
            (frames_dir / name).write_bytes(r["raw"])
            frames.append({"file": f"frames/{name}", "t": round(t, 3), "w": r["w"], "h": r["h"]})
            if i % 20 == 0 or i == len(times):
                log(f"  {i}/{len(times)} captured ({r['w']}x{r['h']})")
        best = max(frames, key=lambda f: f["h"])
        redo = [f for f in frames if f["h"] < best["h"]] if seekable else []
        if redo:   # adaptive streams often start below full quality: re-grab those frames now
            log(f"re-capturing {len(redo)} early low-res frames at {best['h']}p")
            for f in redo:
                r = grab(f["t"])
                if r["h"] > f["h"]:
                    (frames_dir / Path(f["file"]).name).write_bytes(r["raw"])
                    f["w"], f["h"] = r["w"], r["h"]
        ctx.close()
    return frames, {"title": meta["title"], "webpage_url": url, "duration": dur, "width": best["w"],
                    "height": best["h"], "pre_roll_ad_seen": meta["adSeen"],
                    "capture_strategy": "seek" if seekable else f"play-through@{args.playback_rate:g}x"}


# --------------------------------------------------------------------------- packaging
DEDUPE_NOTE = {"mpdecimate": " Near-duplicate frames (static moments) were dropped.",
               "exact": " Byte-identical frames were dropped.", None: ""}


def write_docs(out: Path, m: dict) -> None:
    (out / "manifest.json").write_text(json.dumps(m, indent=2))
    v, c = m["video"], m["capture"]
    res = f"{v.get('width')}x{v.get('height')}" if v.get("height") else "unknown"
    lines = [
        "Still frames extracted from a video.",
        "",
        f"Source     : {v.get('title') or '(unknown)'}",
        f"URL        : {v.get('webpage_url') or '(local file)'}",
        "Duration   : " + (f"{v['duration']:.1f} s" if v.get("duration") else "unknown"),
        f"Resolution : {res}" + (f" @ {v['fps']:g} fps" if v.get("fps") else ""),
        f"Captured   : {c['mode']} mode, {m['generated_at']}",
        "",
        f"frames/   {len(m['frames'])} stills, "
        + ("every frame of the source" if c["fps"] is None else f"one every {1 / c['fps']:.2f} s")
        + "." + DEDUPE_NOTE[c["dedupe"]],
        f"          Named frame_<index>_t<seconds>s.{c['ext']}: t is the timestamp in the source video,",
        "          so neighbouring files are neighbouring moments (overlapping views of the same space).",
    ]
    if m["scenes"] is not None:
        lines.append(f"scenes/   {len(m['scenes'])} stills, one per detected shot change "
                     f"(scene threshold {c['scene_threshold']}).")
    lines += ["contact_sheet.jpg   thumbnail grid of the whole video in time order.",
              "manifest.json       machine-readable index: source details and every file with its timestamp."]
    if m["source_file"]:
        lines.append(f"{m['source_file']}   the original video (plus yt-dlp .info.json metadata).")
    (out / "README.txt").write_text("\n".join(lines) + "\n")


def make_zip(out: Path) -> Path:
    zip_path = out.parent / (out.name + ".zip")
    with zipfile.ZipFile(zip_path, "w") as z:
        for p in sorted(out.rglob("*")):
            if p.is_file():
                kind = zipfile.ZIP_STORED if p.suffix.lower() in ALREADY_COMPRESSED else zipfile.ZIP_DEFLATED
                z.write(p, (Path(out.name) / p.relative_to(out)).as_posix(), compress_type=kind)
    log(f"zip written: {zip_path} ({zip_path.stat().st_size / 1e6:.1f} MB)")
    return zip_path


def default_out_dir(url, video_file) -> Path:
    if video_file:
        key = Path(video_file).stem
    else:
        m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([A-Za-z0-9_-]{6,})", url)
        key = m.group(1) if m else url.split("//")[-1]
    return Path("frames_" + (re.sub(r"[^A-Za-z0-9._-]+", "_", key).strip("_")[:60] or "video"))


# --------------------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--url", help="video URL (YouTube watch URL, or any page/file Chromium/yt-dlp can open)")
    src.add_argument("--channel", help="YouTube channel URL; used with --title to find the video")
    src.add_argument("--video-file", help="a video file you already have")
    ap.add_argument("--title", help="regex (case-insensitive) matched against upload titles on --channel")
    ap.add_argument("--mode", choices=["download", "browser"], default="download",
                    help="how to capture a URL: yt-dlp download (default) or watch it in headless Chromium")
    cap = ap.add_argument_group("capture")
    cap.add_argument("--fps", type=float, default=2.0, help="stills per second of video (default 2)")
    cap.add_argument("--all-frames", action="store_true", help="every frame (download/file; big)")
    cap.add_argument("--scene-threshold", type=float, default=0.30, help="ffmpeg scene score 0-1 (default 0.30)")
    cap.add_argument("--no-dedupe", dest="dedupe", action="store_false", help="keep near-duplicate frames")
    cap.add_argument("--png", action="store_true", help="lossless PNG instead of JPEG (much bigger)")
    outg = ap.add_argument_group("output")
    outg.add_argument("--out", help="output directory (default frames_<video id or file name>); zip lands beside it")
    outg.add_argument("--force", action="store_true", help="replace the output directory if it exists")
    outg.add_argument("--no-source", action="store_true", help="leave the downloaded video out of the zip")
    yt = ap.add_argument_group("youtube / browser")
    yt.add_argument("--format", default="bv*+ba/b", help="yt-dlp format selector (default: best video+audio)")
    yt.add_argument("--cookies", metavar="FILE", help="cookies.txt for yt-dlp, if YouTube asks you to sign in")
    yt.add_argument("--cookies-from-browser", metavar="SPEC", help="yt-dlp style, e.g. chrome or 'chrome:Profile 2'")
    yt.add_argument("--yt-quality", default="hd1080", help="browser mode: quality to request (hd2160, hd1080, hd720...)")
    yt.add_argument("--use-browser", metavar="CHANNEL_OR_PATH",
                    help="browser mode: an installed browser (chrome, msedge) or a path to a Chromium binary")
    yt.add_argument("--user-data-dir", metavar="DIR",
                    help="browser mode: profile dir to reuse, e.g. one signed in to YouTube (quit that browser first)")
    yt.add_argument("--headed", action="store_true", help="browser mode: show the window")
    yt.add_argument("--playback-rate", type=float, default=1.0,
                    help="browser mode, unseekable players only: playback speed while grabbing (default 1)")
    args = ap.parse_args()
    if args.channel and not args.title:
        ap.error("--channel needs --title REGEX")
    mode = "file" if args.video_file else args.mode
    if args.all_frames and mode == "browser":
        ap.error("--all-frames is only for download/file capture (browser mode samples at --fps; try --fps 10)")

    ext = "png" if args.png else "jpg"
    ffmpeg = find_ffmpeg(required=mode != "browser")   # browser mode only uses it for the contact sheet
    url = None if mode == "file" else (args.url or resolve_from_channel(args))
    out = Path(args.out) if args.out else default_out_dir(url, args.video_file)
    if out.exists() and any(out.iterdir()):
        if not args.force:
            die(f"{out} already exists: pass --force to replace it, or --out DIR")
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    scenes = source_file = None
    if mode == "browser":
        frames, video = capture_browser(args, url, out / "frames", ext)
    else:
        if mode == "file":
            video_path = Path(args.video_file)
            if not video_path.is_file():
                die(f"no such file: {video_path}")
            video = {"title": video_path.name}
        else:
            video_path, video = download_video(args, url, out / "source", ffmpeg)
            if args.no_source:
                shutil.rmtree(out / "source")
            else:
                source_file = f"source/{video_path.name}"
        for k, val in probe(ffmpeg, video_path).items():
            video[k] = video.get(k) or val
        log(f"source: {video_path.name} {video['width']}x{video['height']} {video['fps']} fps {video['duration']} s")
        vf = ([] if args.all_frames else [f"fps={args.fps}"]) + (["mpdecimate"] if args.dedupe else [])
        frames = slice_stills(ffmpeg, video_path, out / "frames", vf, "frame", ext)
        scenes = slice_stills(ffmpeg, video_path, out / "scenes",
                              [f"select=eq(n\\,0)+gt(scene\\,{args.scene_threshold})"], "scene", ext)
    if not frames:
        die("no frames were produced")
    if ffmpeg:
        contact_sheet(ffmpeg, [out / f["file"] for f in frames], out / "contact_sheet.jpg")

    write_docs(out, {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "video": video,
        "capture": {"mode": mode, "fps": None if args.all_frames else args.fps, "ext": ext,
                    "dedupe": ("exact" if mode == "browser" else "mpdecimate") if args.dedupe else None,
                    "scene_threshold": None if scenes is None else args.scene_threshold,
                    "yt_quality": args.yt_quality if mode == "browser" else None},
        "source_file": source_file,
        "frames": frames,
        "scenes": scenes,
    })
    print(make_zip(out).resolve())


if __name__ == "__main__":
    main()
