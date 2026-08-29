# grab_video_frames.py

Turn a video — a YouTube URL or a file you already have — into a zip of timestamped still
frames: stills at a chosen rate, one still per shot change, a contact sheet, a machine-readable
`manifest.json` and a plain-English `README.txt` for whoever (or whatever) consumes the zip.

## Setup

```bash
# macOS
brew install ffmpeg
pip3 install yt-dlp playwright && python3 -m playwright install chromium
# Linux
sudo apt install ffmpeg            # or: pip install imageio-ffmpeg (auto-detected)
pip install yt-dlp playwright && python3 -m playwright install chromium
```

Download mode needs yt-dlp + ffmpeg, browser mode only Playwright (ffmpeg just adds the contact
sheet), file mode only ffmpeg.

## Use

```bash
python3 grab_video_frames.py --url 'https://www.youtube.com/watch?v=VIDEOID'                 # download + slice
python3 grab_video_frames.py --url 'https://www.youtube.com/watch?v=VIDEOID' --mode browser  # watch + capture
python3 grab_video_frames.py --channel 'https://www.youtube.com/@handle' --title 'REGEX'     # pick upload by title
python3 grab_video_frames.py --video-file walkthrough.mp4 --fps 4                            # local file
```

The zip path is printed at the end (`frames_<video id>.zip` next to a `frames_<video id>/` folder).

| mode | what it does |
|---|---|
| `download` (default) | yt-dlp fetches the best stream, ffmpeg cuts stills + shot changes, the source video is kept in the zip |
| `browser` | headless Chromium opens the watch page like a viewer, asks the player for 1080p, then seeks through the video and copies each decoded frame off the `<video>` element via a canvas (native stream resolution, no player controls in the pixels). If the player is not seekable it plays the video through and grabs frames as they come (`--playback-rate 2` speeds that up). |
| file | `--video-file PATH`: slice a video you already have |

Useful flags: `--fps N` (stills per second, default 2), `--all-frames` (every frame; large),
`--png` (lossless), `--no-dedupe`, `--scene-threshold 0.3`, `--out DIR`, `--force`, `--no-source`.

`--channel/--title`: the script lists the channel's uploads and takes the single one whose title
matches the regex (case-insensitive). With zero or several matches it prints every upload with
its URL so you can re-run with `--url`.

Not getting blocked: from a home connection YouTube serves all of this normally. If it shows
"Sign in to confirm you're not a bot", use your installed Chrome (`--use-browser chrome`), reuse a
signed-in profile (`--user-data-dir DIR`, quit that browser first), or in download mode pass
`--cookies-from-browser chrome` (same syntax as yt-dlp's flag).

## What is in the zip

```
frames_<id>/
  frames/frame_00042_t0021.00s.jpg ...   t = seconds into the video
  scenes/scene_00003_t0033.20s.jpg ...   one per shot change (download/file modes)
  contact_sheet.jpg                      the whole video at a glance
  manifest.json                          source, resolution, every file + timestamp
  README.txt                             what the folders contain
  source/<id>.mp4 + <id>.info.json       original video + metadata (download mode)
```

## Example: an apartment walkthrough ("Floor Plan R" on The Olivian's channel)

```bash
python3 grab_video_frames.py \
  --channel https://www.youtube.com/@theolivian3201 \
  --title '\bR\s+floor\s*plan\b|\bfloor\s*plan\s*-?\s*R\b' \
  --fps 3
```
