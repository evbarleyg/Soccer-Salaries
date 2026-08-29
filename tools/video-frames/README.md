# grab_video_frames.py

Turn a YouTube video (or any video file) into a zip of still frames for downstream
spatial / interior-design work: timestamped stills at a chosen rate, one still per shot
change, a contact sheet, a machine-readable manifest and a plain-English README.

## The Olivian, "Floor Plan R" — one command

```bash
# macOS setup (once)
brew install ffmpeg
pip3 install yt-dlp playwright && python3 -m playwright install chromium

# find the "R" floor plan video on the channel, download it, cut frames, zip
python3 grab_video_frames.py \
  --channel https://www.youtube.com/@theolivian3201 \
  --title '\bR\s+floor\s*plan\b|\bfloor\s*plan\s*-?\s*R\b' \
  --fps 3
# -> frames_<videoid>.zip   (the full path is printed when done)
```

If the title regex matches zero or several uploads, the script prints every upload with
its URL — copy the right one and pass `--url ...` instead of `--channel/--title`.

### Prefer to "watch" it rather than download it

```bash
python3 grab_video_frames.py --url 'https://www.youtube.com/watch?v=VIDEOID' --mode browser --fps 3
```

Browser mode opens the watch page in headless Chromium like a normal viewer, asks the player
for 1080p, then steps through the video and copies each decoded frame off the `<video>`
element through a canvas (native stream resolution; player controls/overlays are not in the
pixels). If the player turns out not to be seekable it plays the video through and grabs
frames on the fly (`--playback-rate 2` speeds that up).

Not getting blocked: from a home connection YouTube serves this fine. If it ever shows
"Sign in to confirm you're not a bot", use your real Chrome (`--browser-channel chrome`),
reuse a signed-in profile (`--user-data-dir <profile dir>`; quit Chrome first), or in
download mode pass `--cookies-from-browser chrome`.

## Modes

| mode | needs | what it does |
|---|---|---|
| `download` (default) | yt-dlp, ffmpeg | best-quality stream via yt-dlp, frames + shot changes via ffmpeg, keeps the source video in the zip |
| `browser` | playwright (+ ffmpeg only for the contact sheet) | headless Chromium watches the page and lifts frames off the player |
| `file` | ffmpeg | you already have the video: `--video-file tour.mp4` |

Useful flags: `--fps N` (stills per second, default 2), `--all-frames` (every frame; large),
`--png` (lossless), `--no-dedupe` (keep static duplicates), `--scene-threshold 0.3`,
`--out DIR`, `--zip PATH`, `--no-source`.

## What is in the zip

```
frames_<id>/
  frames/frame_00042_t0021.00s.jpg ...   t = seconds into the video
  scenes/scene_0003_t0033.20s.jpg ...    one per shot change (download/file modes)
  contact_sheet.jpg                      the whole video at a glance
  manifest.json                          source, resolution, every file + timestamp
  README.txt                             description for whoever consumes the zip
  source/<id>.mp4 + <id>.info.json       original video + metadata (download mode)
```

Linux: `apt install ffmpeg` or `pip install imageio-ffmpeg` (auto-detected); set
`CHROMIUM_PATH=/path/to/chrome` to point browser mode at an existing Chromium build.
