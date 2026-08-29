#!/usr/bin/env python3
"""grab_video_frames.py - turn a YouTube video (or any video file) into a zip of still frames.

Modes
  download (default)  yt-dlp fetches the best-quality stream, ffmpeg slices it into stills.
  browser             headless Chromium (Playwright) opens the watch page like a normal viewer,
                      steps through the video and copies each decoded frame off the <video>
                      element through a canvas - i.e. exactly what a viewer sees, at the
                      stream's native resolution.
  file                you already have the video file; just slice and zip it (--video-file).

Picking the video
  --url URL                      an exact watch URL, or
  --channel URL --title REGEX    list the channel's uploads and take the single video whose
                                 title matches REGEX (case-insensitive), e.g.
                                 --channel https://www.youtube.com/@theolivian3201 --title "plan ?r\\b"

What ends up in the zip
  frames/            frame_00042_t0021.00s.jpg ... a still every 1/--fps seconds
                     (or every single frame with --all-frames); t = timestamp in the video
  scenes/            one still per detected shot change (download/file modes)
  contact_sheet.jpg  thumbnail overview of the whole video
  manifest.json      machine-readable index (source, resolution, every frame + timestamp)
  README.txt         plain-English description for whoever/whatever consumes the zip
  source/            the downloaded video + yt-dlp .info.json (download mode, unless --no-source)

Setup
  macOS:  brew install ffmpeg && pip3 install yt-dlp playwright && python3 -m playwright install chromium
  Linux:  apt install ffmpeg  (or: pip install imageio-ffmpeg)
          pip install yt-dlp playwright && python3 -m playwright install chromium
  (browser mode needs only playwright; download mode needs only yt-dlp + ffmpeg; file mode only ffmpeg)

Examples
  python3 grab_video_frames.py --channel https://www.youtube.com/@theolivian3201 --title "floor ?plan ?r\\b|\\br ?floor ?plan"
  python3 grab_video_frames.py --url "https://www.youtube.com/watch?v=VIDEOID" --mode browser --fps 3
  python3 grab_video_frames.py --video-file walkthrough.mp4 --all-frames --png
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36")


def log(msg: str) -> None:
    print(f"[frames] {msg}", file=sys.stderr, flush=True)


def die(msg: str) -> None:
    log("ERROR: " + msg)
    sys.exit(2)


# --------------------------------------------------------------------------- ffmpeg helpers
def find_ffmpeg(required: bool = True):
    exe = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if not exe:
        try:
            import imageio_ffmpeg  # `pip install imageio-ffmpeg` ships a static build
            exe = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            exe = None
    if not exe and required:
        die("ffmpeg not found. Install it (brew install ffmpeg / apt install ffmpeg), "
            "or `pip install imageio-ffmpeg`, or set FFMPEG=/path/to/ffmpeg")
    return exe


def ffmpeg_run(ffmpeg: str, args: list, quiet: bool = True) -> subprocess.CompletedProcess:
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y"] + [str(a) for a in args]
    log("$ " + " ".join(cmd))
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0 and "fps_mode" in p.stderr and "-fps_mode" in cmd:
        # ffmpeg < 5.1 does not know -fps_mode; retry with the old spelling
        i = cmd.index("-fps_mode")
        cmd[i:i + 2] = ["-vsync", cmd[i + 1]]
        p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(p.stderr[-4000:])
        die(f"ffmpeg failed (exit {p.returncode})")
    if not quiet:
        sys.stderr.write(p.stderr)
    return p


def probe(ffmpeg: str, video: Path) -> dict:
    """Duration / size / fps via `ffmpeg -i` banner parsing (avoids needing ffprobe)."""
    p = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(video)],
                       capture_output=True, text=True)
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


def slice_stills(ffmpeg, video: Path, out_dir: Path, vf: list, prefix: str, *, png: bool,
                 jpg_q: int) -> list:
    """Run one ffmpeg pass with filter chain `vf`, name each still <prefix>_<n>_t<sec>s.<ext>."""
    out_dir.mkdir(parents=True, exist_ok=True)
    ext = "png" if png else "jpg"
    args = ["-i", video, "-vf", ",".join(vf + ["showinfo"]), "-fps_mode", "vfr", "-an"]
    if not png:
        args += ["-q:v", jpg_q]
    p = ffmpeg_run(ffmpeg, args + [out_dir / f"{prefix}_%05d.{ext}"])
    times = [float(t) for t in re.findall(r"pts_time:\s*([\d.]+)", p.stderr)]  # one showinfo line per still
    stills = []
    for i, f in enumerate(sorted(out_dir.glob(f"{prefix}_*.{ext}"))):
        t = times[i] if i < len(times) else None
        name = f"{prefix}_{i + 1:05d}" + (f"_t{t:07.2f}s" if t is not None else "") + f".{ext}"
        f.rename(out_dir / name)
        stills.append({"file": f"{out_dir.name}/{name}", "t": t})
    log(f"{len(stills)} stills -> {out_dir}")
    return stills


def contact_sheet(ffmpeg, frames_dir: Path, out_file: Path, ext: str, cols: int = 8,
                  max_tiles: int = 64) -> bool:
    files = sorted(frames_dir.glob(f"*.{ext}"))
    if not files:
        return False
    step = max(1, math.ceil(len(files) / max_tiles))
    picked = files[::step]
    cols = min(cols, len(picked))
    rows = math.ceil(len(picked) / cols)
    lst = out_file.with_suffix(".ffconcat")
    lst.write_text("ffconcat version 1.0\n" + "".join(f"file '{p.resolve().as_posix()}'\n" for p in picked))
    try:
        ffmpeg_run(ffmpeg, ["-f", "concat", "-safe", "0", "-i", lst,
                            "-vf", f"scale=240:-2,tile={cols}x{rows}:padding=4:color=white",
                            "-frames:v", "1", "-q:v", "3", out_file])
    finally:
        lst.unlink(missing_ok=True)
    return out_file.exists()


# --------------------------------------------------------------------------- yt-dlp
def ytdlp_opts(args, **extra) -> dict:
    o = {"quiet": True, "no_warnings": True, "noprogress": True}
    if args.cookies:
        o["cookiefile"] = args.cookies
    if args.cookies_from_browser:
        o["cookiesfrombrowser"] = (args.cookies_from_browser,)
    o.update(extra)
    return o


def need_ytdlp():
    try:
        import yt_dlp
        return yt_dlp
    except ImportError:
        die("yt-dlp not installed: pip install yt-dlp   (or pass --url with --mode browser)")


def resolve_from_channel(args) -> str:
    yt_dlp = need_ytdlp()
    url = args.channel.rstrip("/")
    if not re.search(r"/(videos|shorts|streams|featured)$", url):
        url += "/videos"
    log(f"listing {url}")
    with yt_dlp.YoutubeDL(ytdlp_opts(args, extract_flat=True)) as y:
        info = y.extract_info(url, download=False)
    flat = []
    for e in info.get("entries") or []:
        if e and e.get("entries") is not None:      # channel tab nesting
            flat += [x for x in e["entries"] if x]
        elif e:
            flat.append(e)
    rx = re.compile(args.title, re.I)
    hits = [e for e in flat if rx.search(e.get("title") or "")]
    log(f"{len(flat)} uploads, {len(hits)} match /{args.title}/i:")
    for e in flat:
        log(f"  {'*' if e in hits else ' '} https://www.youtube.com/watch?v={e.get('id')}  {e.get('title')}")
    if len(hits) != 1:
        die("need exactly one title match - tighten --title, or copy the right URL from the list into --url")
    e = hits[0]
    return e.get("url") if str(e.get("url", "")).startswith("http") else f"https://www.youtube.com/watch?v={e['id']}"


def download_video(args, url: str, src_dir: Path, ffmpeg: str):
    yt_dlp = need_ytdlp()
    src_dir.mkdir(parents=True, exist_ok=True)
    opts = ytdlp_opts(args, quiet=False, noprogress=False, format=args.format,
                      outtmpl=str(src_dir / "%(id)s.%(ext)s"), writeinfojson=True,
                      merge_output_format="mp4/mkv", ffmpeg_location=ffmpeg, retries=5)
    log(f"downloading {url}")
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(url, download=True)
        path = Path(y.prepare_filename(info))
    if not path.exists():  # merged/remuxed under another extension
        cands = [c for c in src_dir.glob(f"{info['id']}.*") if c.suffix not in (".json", ".part", ".ytdl")]
        if not cands:
            die("download finished but no media file found in " + str(src_dir))
        path = max(cands, key=lambda c: c.stat().st_size)
    keys = ("id", "title", "webpage_url", "duration", "width", "height", "fps", "upload_date",
            "channel", "channel_url", "description")
    return path, {k: info.get(k) for k in keys}


# --------------------------------------------------------------------------- browser capture
JS_PREP = """async ({quality}) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let v = null;
  for (let i = 0; i < 300 && !(v = document.querySelector('video')); i++) await sleep(100);
  if (!v) return {error: 'no <video> element appeared on the page'};
  const p = document.getElementById('movie_player');           // YouTube player API, if present
  const yt = !!(p && typeof p.playVideo === 'function');
  if (yt) {
    try { p.mute(); } catch (e) {}
    try { if (quality && p.setPlaybackQualityRange) p.setPlaybackQualityRange(quality, quality); } catch (e) {}
    try { p.playVideo(); } catch (e) {}
  } else {
    v.muted = true;
    try { await v.play(); } catch (e) {}
  }
  const t0 = Date.now();
  let adSeen = false;
  while (Date.now() - t0 < 120000) {                            // wait out pre-roll ads / buffering
    v = document.querySelector('video') || v;
    const ad = yt && p.classList.contains('ad-showing');
    if (ad) {
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
  try { yt ? p.pauseVideo() : v.pause(); } catch (e) {}
  let qual = null; try { qual = yt ? p.getPlaybackQuality() : null; } catch (e) {}
  return {duration: v.duration, width: v.videoWidth, height: v.videoHeight, yt, adSeen, qual,
          title: (document.title || '').replace(/ - YouTube$/, '')};
}"""

JS_GRAB = """async ({t, seek, mime, q}) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const v = document.querySelector('video');
  const p = document.getElementById('movie_player');
  const yt = !!(p && typeof p.seekTo === 'function');
  if (seek && Math.abs(v.currentTime - t) > 0.02) {
    await new Promise(res => {
      const done = () => { v.removeEventListener('seeked', done); res(); };
      v.addEventListener('seeked', done);
      setTimeout(done, 20000);
      if (yt) { try { p.seekTo(t, true); } catch (e) { v.currentTime = t; } } else v.currentTime = t;
    });
    const t0 = Date.now();
    while (v.readyState < 2 && Date.now() - t0 < 20000) await sleep(100);
    if (!v.paused) { try { yt ? p.pauseVideo() : v.pause(); } catch (e) {} }
    await Promise.race([new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))), sleep(300)]);
  }
  if (!v.videoWidth) return {error: 'video has no decoded frame (videoWidth=0)'};
  const c = window.__grab || (window.__grab = document.createElement('canvas'));
  if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  try { return {data: c.toDataURL(mime, q), w: c.width, h: c.height, at: v.currentTime, ended: v.ended, paused: v.paused}; }
  catch (e) { return {error: 'canvas export blocked: ' + e, w: c.width, h: c.height}; }
}"""

JS_PLAY = """({rate}) => {
  const v = document.querySelector('video');
  const p = document.getElementById('movie_player');
  try { v.playbackRate = rate; if (p && p.setPlaybackRate) p.setPlaybackRate(rate); } catch (e) {}
  try { (p && p.playVideo) ? p.playVideo() : v.play(); } catch (e) {}
  return true;
}"""


def capture_browser(args, url: str, frames_dir: Path):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        die("playwright not installed: pip install playwright && python3 -m playwright install chromium")
    frames_dir.mkdir(parents=True, exist_ok=True)
    mime, ext = ("image/png", "png") if args.png else ("image/jpeg", "jpg")
    launch = {"headless": not args.headed,
              "args": ["--autoplay-policy=no-user-gesture-required", "--mute-audio",
                       "--disable-blink-features=AutomationControlled"]}
    if args.browser_channel:
        launch["channel"] = args.browser_channel          # e.g. "chrome" = your installed Google Chrome
    if os.environ.get("CHROMIUM_PATH"):
        launch["executable_path"] = os.environ["CHROMIUM_PATH"]
    ctx_opts = {"viewport": {"width": 1920, "height": 1080}, "user_agent": UA,
                "locale": "en-US", "timezone_id": "America/Los_Angeles"}
    with sync_playwright() as pw:
        if args.user_data_dir:                            # reuse a (logged-in) browser profile
            ctx = pw.chromium.launch_persistent_context(args.user_data_dir, **launch, **ctx_opts)
            browser = None
        else:
            browser = pw.chromium.launch(**launch)
            ctx = browser.new_context(**ctx_opts)
        if re.search(r"youtube\.|youtu\.be", url) and not args.user_data_dir:
            # pre-accepted consent cookies so the EU/UK consent interstitial never shows
            ctx.add_cookies([
                {"name": "SOCS", "value": "CAISAiAD", "domain": ".youtube.com", "path": "/", "secure": True},
                {"name": "CONSENT", "value": "YES+1", "domain": ".youtube.com", "path": "/", "secure": True},
            ])
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        log(f"opening {url} in {'headed' if args.headed else 'headless'} "
            f"{args.browser_channel or 'chromium'}")
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        meta = page.evaluate(JS_PREP, {"quality": args.yt_quality})
        if meta.get("error"):
            shot = frames_dir.parent / "browser_error.png"
            page.screenshot(path=str(shot), full_page=False)
            die(meta["error"] + f" (page screenshot saved to {shot})")
        dur = float(meta["duration"])
        log(f"title={meta['title']!r} duration={dur:.1f}s stream={meta['width']}x{meta['height']}"
            + (f" yt-quality={meta['qual']}" if meta.get("qual") else ""))
        step = 1.0 / args.fps
        times = [round(i * step, 3) for i in range(int(dur / step) + 2)]
        times = [t for t in times if t <= max(dur - 0.05, 0.0)] or [0.0]

        def grab(t, seek=True):
            r = page.evaluate(JS_GRAB, {"t": t, "seek": seek, "mime": mime, "q": 0.92})
            if r.get("error"):
                die(f"frame at t={t}: {r['error']}")
            return base64.b64decode(r["data"].split(",", 1)[1]), int(r["w"]), int(r["h"]), float(r["at"]), r

        frames, seen = [], set()

        def keep(i, t, raw, w, h):
            digest = hashlib.sha1(raw).hexdigest()
            if args.dedupe and digest in seen:
                return
            seen.add(digest)
            name = f"frame_{i:05d}_t{t:07.2f}s.{ext}"
            (frames_dir / name).write_bytes(raw)
            frames.append({"file": f"frames/{name}", "t": round(t, 3), "w": w, "h": h})

        # Preferred: frame-accurate seeking. Verify the first real seek actually moved the playhead;
        # some players/servers are not seekable, in which case we play the video through instead.
        probe_t = times[1] if len(times) > 1 else 0.0
        _, _, _, at, _ = grab(probe_t, seek=True)
        seekable = abs(at - probe_t) < 0.25
        if seekable:
            for i, t in enumerate(times, 1):
                raw, w, h, at, _ = grab(t, seek=True)
                keep(i, t, raw, w, h)
                if i % 20 == 0 or i == len(times):
                    log(f"  {i}/{len(times)} captured ({w}x{h})")
        else:
            log(f"player is not seekable here; playing it through at {args.playback_rate}x and grabbing on the fly")
            grab(0.0, seek=True)
            page.evaluate(JS_PLAY, {"rate": args.playback_rate})
            idx, tol, stalls, last_at = 0, 0.5 / args.fps, 0, -1.0
            while idx < len(times):
                raw, w, h, at, r = grab(0.0, seek=False)
                if at + 1e-3 >= times[idx] - tol:
                    while idx + 1 < len(times) and at >= times[idx + 1] - tol:
                        idx += 1                          # capture loop fell behind; skip missed slots
                    keep(idx + 1, at, raw, w, h)
                    idx += 1
                    if idx % 20 == 0 or idx == len(times):
                        log(f"  {idx}/{len(times)} captured ({w}x{h}) t={at:.2f}s")
                if r.get("ended"):
                    break
                stalls = stalls + 1 if at == last_at else 0
                last_at = at
                if stalls > 200:
                    die(f"playback stalled at t={at:.2f}s")
                if r.get("paused") and not r.get("ended"):
                    page.evaluate(JS_PLAY, {"rate": args.playback_rate})
                page.wait_for_timeout(20)
        # adaptive streams often start below full quality: re-grab any frame smaller than the best seen
        best_h = max(f["h"] for f in frames)
        redo = [f for f in frames if f["h"] < best_h]
        if redo and seekable:
            log(f"re-capturing {len(redo)} early low-res frames at {best_h}p")
            for f in redo:
                raw, w, h, at, _ = grab(f["t"], seek=True)
                if h >= f["h"]:
                    (frames_dir / Path(f["file"]).name).write_bytes(raw)
                    f["w"], f["h"] = w, h
        ctx.close()
        if browser:
            browser.close()
    info = {"title": meta.get("title"), "webpage_url": url, "duration": dur,
            "width": meta.get("width"), "height": best_h, "pre_roll_ad_seen": meta.get("adSeen"),
            "capture_strategy": "seek" if seekable else f"play-through@{args.playback_rate}x"}
    return frames, info


# --------------------------------------------------------------------------- packaging
README_TMPL = """Still frames extracted from a video, packaged for downstream spatial / interior-design work.

Source     : {title}
URL        : {url}
Duration   : {duration}
Resolution : {res}
Captured   : {mode} mode, {when}

frames/   {nframes} stills, {sampling}.{dedupe}
          File names are frame_<index>_t<seconds>s.{ext}; t is the timestamp in the source video,
          so consecutive files are adjacent moments (useful for overlap / multi-view reasoning).
scenes/   {nscenes} stills, one per detected shot change (scene threshold {thr}); a quick
          "one picture per shot" summary. {scene_note}
contact_sheet.jpg   thumbnail grid of the whole video in time order.
manifest.json       machine-readable index of everything above.
{source_note}
Generated by grab_video_frames.py
"""


def write_docs(out: Path, manifest: dict) -> None:
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    v = manifest["video"]
    dur = v.get("duration")
    res = f"{v.get('width')}x{v.get('height')}" if v.get("height") else "unknown"
    if v.get("fps"):
        res += f" @ {v['fps']:g} fps"
    c = manifest["capture"]
    sampling = ("every frame of the source" if c["all_frames"]
                else f"one every {1 / c['fps']:.2f} s ({c['fps']:g} per second)")
    (out / "README.txt").write_text(README_TMPL.format(
        title=v.get("title") or "(unknown title)", url=v.get("webpage_url") or "(local file)",
        duration=f"{dur:.1f} s" if dur else "unknown", res=res, mode=c["mode"],
        when=manifest["generated_at"], nframes=len(manifest["frames"]), sampling=sampling,
        dedupe=" Near-duplicate frames (static moments) were dropped." if c["dedupe"] else "",
        ext="png" if c["png"] else "jpg", nscenes=len(manifest["scenes"]), thr=c["scene_threshold"],
        scene_note="" if manifest["scenes"] else "(not produced in this mode)",
        source_note=f"source/   the original video file + metadata ({manifest['source_file']})\n"
        if manifest.get("source_file") else ""))


def make_zip(out: Path, zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(out.rglob("*")):
            if p.is_file():
                z.write(p, (Path(out.name) / p.relative_to(out)).as_posix())
    mb = zip_path.stat().st_size / 1e6
    log(f"zip written: {zip_path} ({mb:.1f} MB)")


def slugify(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_")[:60] or "video"


# --------------------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_argument_group("which video")
    src.add_argument("--url", help="video URL (YouTube watch URL or anything yt-dlp/Chromium can open)")
    src.add_argument("--channel", help="channel URL; used with --title to find the video")
    src.add_argument("--title", help="regex matched (case-insensitive) against upload titles on --channel")
    src.add_argument("--video-file", help="local video file (implies --mode file)")
    ap.add_argument("--mode", choices=["download", "browser", "file"])
    cap = ap.add_argument_group("capture")
    cap.add_argument("--fps", type=float, default=2.0, help="stills per second of video (default 2)")
    cap.add_argument("--all-frames", action="store_true", help="every frame (download/file modes; big!)")
    cap.add_argument("--scene-threshold", type=float, default=0.30, help="ffmpeg scene score 0-1 (default 0.30)")
    cap.add_argument("--no-dedupe", dest="dedupe", action="store_false", help="keep near-duplicate frames")
    cap.add_argument("--png", action="store_true", help="lossless PNG instead of JPEG")
    cap.add_argument("--jpg-quality", type=int, default=2, help="ffmpeg -q:v, 2 (best) .. 31")
    out_g = ap.add_argument_group("output")
    out_g.add_argument("--out", help="output directory (default frames_<video id or file name>)")
    out_g.add_argument("--zip", help="zip path (default <out>.zip)")
    out_g.add_argument("--no-source", action="store_true", help="leave the downloaded video out of the zip")
    yt = ap.add_argument_group("youtube niceties")
    yt.add_argument("--format", default="bv*+ba/b", help="yt-dlp format selector (default: best video+audio)")
    yt.add_argument("--cookies", help="cookies.txt for yt-dlp (if YouTube asks you to sign in)")
    yt.add_argument("--cookies-from-browser", metavar="BROWSER", help="e.g. chrome, firefox, safari (yt-dlp)")
    yt.add_argument("--yt-quality", default="hd1080", help="browser mode: quality to request (hd2160, hd1080, hd720...)")
    yt.add_argument("--headed", action="store_true", help="browser mode: show the browser window")
    yt.add_argument("--browser-channel", metavar="CHANNEL",
                    help="browser mode: use an installed browser instead of Playwright's Chromium, e.g. chrome, msedge")
    yt.add_argument("--user-data-dir", metavar="DIR",
                    help="browser mode: browser profile dir to reuse (e.g. one already signed in to YouTube); quit that browser first")
    yt.add_argument("--playback-rate", type=float, default=1.0,
                    help="browser mode fallback (unseekable player): playback speed while grabbing (default 1.0)")
    args = ap.parse_args()

    mode = args.mode or ("file" if args.video_file else "download")
    if mode == "file" and not args.video_file:
        die("--mode file needs --video-file")
    if mode != "file" and not args.url and not (args.channel and args.title):
        die("say which video: --url URL, or --channel URL --title REGEX, or --video-file PATH")
    if args.all_frames and mode == "browser":
        die("--all-frames is only for download/file modes (browser mode samples at --fps; try --fps 10)")

    ffmpeg = find_ffmpeg(required=mode != "browser")  # browser mode only uses it for the contact sheet

    url = None
    if mode != "file":
        url = args.url or resolve_from_channel(args)
        log(f"video: {url}")

    # output directory
    if args.out:
        out = Path(args.out)
    elif mode == "file":
        out = Path(f"frames_{slugify(Path(args.video_file).stem)}")
    else:
        m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([A-Za-z0-9_-]{6,})", url)
        out = Path(f"frames_{m.group(1) if m else slugify(url.split('//')[-1])}")
    if out.exists():
        if (out / "manifest.json").exists() or not any(out.iterdir()):
            shutil.rmtree(out)
        else:
            die(f"{out} exists and is not a previous run of this script; pass a different --out")
    out.mkdir(parents=True)
    frames_dir, scenes_dir = out / "frames", out / "scenes"
    ext = "png" if args.png else "jpg"

    video_meta: dict = {}
    source_file = None
    scenes: list = []
    if mode == "browser":
        frames, video_meta = capture_browser(args, url, frames_dir)
    else:
        if mode == "download":
            video_path, video_meta = download_video(args, url, out / "source", ffmpeg)
        else:
            video_path = Path(args.video_file)
            if not video_path.exists():
                die(f"no such file: {video_path}")
            video_meta = {"title": video_path.name, "webpage_url": None}
        pr = probe(ffmpeg, video_path)
        for k in ("duration", "width", "height", "fps"):
            video_meta[k] = video_meta.get(k) or pr[k]
        log(f"source: {video_path.name} {pr['width']}x{pr['height']} {pr['fps']} fps {pr['duration']} s")
        vf = ([] if args.all_frames else [f"fps={args.fps}"]) + (["mpdecimate"] if args.dedupe else [])
        frames = slice_stills(ffmpeg, video_path, frames_dir, vf, "frame", png=args.png, jpg_q=args.jpg_quality)
        scenes = slice_stills(ffmpeg, video_path, scenes_dir,
                              [f"select=eq(n\\,0)+gt(scene\\,{args.scene_threshold})"], "scene",
                              png=args.png, jpg_q=args.jpg_quality)
        if mode == "download":
            if args.no_source:
                shutil.rmtree(out / "source", ignore_errors=True)
            else:
                source_file = f"source/{video_path.name}"
    if not frames:
        die("no frames were produced")
    if ffmpeg:
        contact_sheet(ffmpeg, frames_dir, out / "contact_sheet.jpg", ext)

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "video": video_meta,
        "capture": {"mode": mode, "fps": None if args.all_frames else args.fps, "all_frames": args.all_frames,
                    "dedupe": args.dedupe, "png": args.png, "scene_threshold": args.scene_threshold,
                    "yt_quality": args.yt_quality if mode == "browser" else None},
        "source_file": source_file,
        "frames": frames,
        "scenes": scenes,
    }
    write_docs(out, manifest)
    zip_path = Path(args.zip) if args.zip else out.with_suffix(".zip")
    make_zip(out, zip_path)
    print(zip_path.resolve())


if __name__ == "__main__":
    main()
