from flask import Flask, request, jsonify, send_file, send_from_directory, Response, redirect, url_for
from flask_cors import CORS
import subprocess
import os
import json
import sys
import logging
import secrets
import threading
import time
import queue as _queue

try:
    from mutagen.mp3 import MP3 as _MP3
    def _get_mp3_duration(filepath: str) -> float:
        try:
            return _MP3(filepath).info.length
        except Exception:
            return 0.0
except ImportError:
    def _get_mp3_duration(filepath: str) -> float:
        try:
            import json as _json
            r = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", filepath],
                capture_output=True, text=True, timeout=10,
            )
            return float(_json.loads(r.stdout)["format"]["duration"])
        except Exception:
            return 0.0

# Setup logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PLOT_FILE = os.path.join(BASE_DIR, "Meteostat_and_openweathermap_plots_only.html")
RADAR_VIDEO = os.path.join(BASE_DIR, "radar_png/radar_forecast.mp4")
RADIO_DIR = os.path.join(BASE_DIR, "..", "radio")
HLS_LIVE_DIR = os.path.join(RADIO_DIR, "live")


def _scan_songs() -> list:
    """Return sorted list of {filename, duration} dicts for all MP3s in RADIO_DIR."""
    songs = []
    try:
        for name in sorted(os.listdir(RADIO_DIR)):
            if name.lower().endswith(".mp3"):
                path = os.path.join(RADIO_DIR, name)
                # Strip executable bits — MP3s are never executable
                current = os.stat(path).st_mode
                if current & 0o111:
                    os.chmod(path, current & ~0o111)
                    logger.info(f"Fixed permissions on {name}")
                songs.append({"filename": name, "duration": _get_mp3_duration(path)})
    except Exception as e:
        logger.error(f"Error scanning songs: {e}")
    return songs


_DEFAULT_SONG = "Jingle_Macker.mp3"
_default_duration = _get_mp3_duration(os.path.join(RADIO_DIR, _DEFAULT_SONG))

# Radio player state management — broadcast defaults to ON
RADIO_STATE = {
    "is_playing": True,
    "last_toggled_time": time.time(),
    "current_song": _DEFAULT_SONG,
    "audio_duration": _default_duration,
    "live_mode": False,
}
RADIO_STATE_LOCK = threading.Lock()

# Single-broadcaster session lock
BROADCASTER_SESSION = {
    "token": None,
    "last_seen": 0.0,
}
BROADCASTER_LOCK = threading.Lock()
BROADCASTER_TIMEOUT = (
    300  # seconds without heartbeat before another device can take over
)

# SSE (Server-Sent Events) — per-client queues for instant push on state change
SSE_CLIENT_QUEUES: dict = {}  # thread_id → queue.Queue
SSE_CLIENTS_LOCK = threading.Lock()

# Live stream buffer — chunks pushed by PUT /api/radio/stream, pulled by GET /api/radio/live-stream
LIVE_STREAM_BUFFER: _queue.Queue = _queue.Queue(maxsize=256)

# HLS segment counter for relay-segment endpoint
_HLS_SEG_COUNTER = 0
_HLS_SEG_LOCK = threading.Lock()

logger.info(f"Flask app initialized")
logger.info(f"Current working directory: {os.getcwd()}")
logger.info(f"App root path: {app.root_path}")
logger.info(f"Static folder: {app.static_folder}")

# Ensure Python 3.6 compatibility
if sys.version_info < (3, 7):
    print("Running on Python 3.6 - some features may be limited")


@app.route("/test-static")
def test_static():
    import os

    static_dir = os.path.join(BASE_DIR, "static")
    files = os.listdir(static_dir) if os.path.exists(static_dir) else []
    return jsonify(
        {"static_dir": static_dir, "exists": os.path.exists(static_dir), "files": files}
    )


@app.route("/")
@app.route("/kyosky/")
def index():
    logger.info("GET / - Serving index.html")
    try:
        # Try multiple paths for index.html
        index_paths = [
            "index.html",
            os.path.join(os.path.dirname(__file__), "index.html"),
            "/var/www/virtual/zef/html/kyosky/index.html",
        ]

        for path in index_paths:
            if os.path.exists(path):
                content = open(path, "r", encoding="utf-8").read()
                logger.info(
                    f"Successfully loaded index.html from {path} ({len(content)} bytes)"
                )
                return content

        logger.error(f"index.html not found in any of: {index_paths}")
        return jsonify({"error": "index.html not found"}), 404
    except Exception as e:
        logger.error(f"Error loading index.html: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/radio/")
@app.route("/radio")
def radio_page():
    """Serve the radio player page."""
    logger.info("GET /radio - Serving radio/index.html")
    try:
        radio_index_paths = [
            os.path.join(os.path.dirname(__file__), "..", "radio", "index.html"),
            "/home/zef/Nextcloud6/webpage_kyo_sk/radio/index.html",
        ]

        for path in radio_index_paths:
            if os.path.exists(path):
                content = open(path, "r", encoding="utf-8").read()
                logger.info(f"Successfully loaded radio/index.html from {path}")
                return content

        logger.error(f"radio/index.html not found in any of: {radio_index_paths}")
        return jsonify({"error": "radio/index.html not found"}), 404
    except Exception as e:
        logger.error(f"Error loading radio/index.html: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/radio/<path:filename>")
def radio_static(filename):
    """Serve static assets (CSS, JS) from the radio directory."""
    radio_dir = os.path.join(os.path.dirname(__file__), "..", "radio")
    return send_from_directory(radio_dir, filename)


@app.route("/initial-plots")
@app.route("/kyosky/initial-plots")
def initial_plots():
    print("Serving:", PLOT_FILE)

    if not os.path.exists(PLOT_FILE):
        return f"File not found: {PLOT_FILE}", 500

    return send_file(PLOT_FILE)


@app.route("/radar-video")
@app.route("/kyosky/radar-video")
def radar_video():
    logger.info(f"Serving radar video: {RADAR_VIDEO}")

    if not os.path.exists(RADAR_VIDEO):
        logger.error(f"Radar video not found: {RADAR_VIDEO}")
        return jsonify({"error": "Radar video not found"}), 404

    return send_file(RADAR_VIDEO, mimetype="video/mp4")


@app.route("/predict", methods=["POST"])
@app.route("/kyosky/predict", methods=["POST"])
def predict():
    logger.info(f"POST /predict - Received request with data: {request.json}")
    try:
        data = request.json or {}

        # Run the prediction script
        result = run_prediction_script(data)

        # If script failed, return details
        if result.returncode != 0:
            logger.error("Script execution failed")
            return (
                jsonify(
                    {
                        "error": "Script execution failed",
                        "details": result.stderr,
                        "output": result.stdout,
                        "command": (
                            " ".join(result.args) if hasattr(result, "args") else None
                        ),
                    }
                ),
                500,
            )

        # Look for the plots-only HTML file in the working directory
        work_dir = os.path.dirname(__file__)
        plots_filename = os.path.join(
            work_dir, "Meteostat_and_openweathermap_plots_only.html"
        )

        logger.info(f"Looking for output file: {plots_filename}")
        logger.info(f"File exists: {os.path.exists(plots_filename)}")

        if os.path.exists(plots_filename):
            with open(plots_filename, "r", encoding="utf-8") as f:
                html_content = f.read()

            logger.info(
                f"Successfully loaded {len(html_content)} bytes from output file"
            )
            return jsonify(
                {"success": True, "html": html_content, "filename": plots_filename}
            )
        else:
            files = [f for f in os.listdir(work_dir) if f.endswith(".html")]
            logger.error(f"Output file not found. Available HTML files: {files}")
            return (
                jsonify(
                    {
                        "error": "Output file not found",
                        "expected": plots_filename,
                        "available_files": files,
                        "work_dir": work_dir,
                    }
                ),
                500,
            )

    except subprocess.TimeoutExpired:
        logger.error("Script execution timeout")
        return jsonify({"error": "Script execution timeout"}), 500
    except Exception as e:
        import traceback

        logger.error(f"Exception in predict: {e}", exc_info=True)
        return jsonify({"error": str(e), "traceback": traceback.format_exc()}), 500


# Broadcast password - change this to something secure!
BROADCAST_PASSWORD = "broadcast"


def _session_active_locked():
    """True if a broadcaster session is currently active. Caller must hold BROADCASTER_LOCK."""
    if not BROADCASTER_SESSION["token"]:
        return False
    return (time.time() - BROADCASTER_SESSION["last_seen"]) < BROADCASTER_TIMEOUT


def _validate_broadcaster_token(token):
    """If token matches the current session token, refresh last_seen and accept.

    The timeout is only used at /auth time to decide whether a new device can
    take over. Once a broadcaster holds the token, they keep using it until
    someone else explicitly logs in or they log out. This avoids spurious
    'session expired' kicks when polling pauses (background tab, sleep, etc).
    """
    if not token:
        return False
    with BROADCASTER_LOCK:
        if BROADCASTER_SESSION["token"] != token:
            return False
        BROADCASTER_SESSION["last_seen"] = time.time()
        return True


@app.route("/api/radio/auth", methods=["POST"])
@app.route("/kyosky/api/radio/auth", methods=["POST"])
def radio_auth():
    """Authenticate broadcaster — always allows login, taking over any active session."""
    data = request.json or {}
    password = data.get("password", "")

    if password != BROADCAST_PASSWORD:
        logger.warning("Radio authentication failed - incorrect password")
        return jsonify({"authenticated": False, "error": "incorrect_password"}), 401

    with BROADCASTER_LOCK:
        took_over = _session_active_locked()
        new_token = secrets.token_urlsafe(32)
        BROADCASTER_SESSION["token"] = new_token
        BROADCASTER_SESSION["last_seen"] = time.time()

    if took_over:
        logger.info("Radio authentication: took over existing session")
    else:
        logger.info("Radio authentication successful, session token issued")
    return jsonify({"authenticated": True, "token": new_token, "took_over": took_over})


@app.route("/api/radio/logout", methods=["POST"])
@app.route("/kyosky/api/radio/logout", methods=["POST"])
def radio_logout():
    """Release the broadcaster session."""
    token = request.headers.get("X-Broadcaster-Token", "")
    with BROADCASTER_LOCK:
        if BROADCASTER_SESSION["token"] and BROADCASTER_SESSION["token"] == token:
            BROADCASTER_SESSION["token"] = None
            BROADCASTER_SESSION["last_seen"] = 0.0
            logger.info("Broadcaster session released via logout")
            return jsonify({"success": True})
    return jsonify({"success": False, "error": "invalid_token"}), 401


def _current_state_dict() -> dict:
    """Return current radio state as a dict (thread-safe)."""
    with RADIO_STATE_LOCK:
        is_playing = RADIO_STATE["is_playing"]
        last_toggled_time = RADIO_STATE["last_toggled_time"]
        audio_duration = RADIO_STATE["audio_duration"]
        current_song = RADIO_STATE["current_song"]
        live_mode = RADIO_STATE["live_mode"]
    elapsed = (time.time() - last_toggled_time) % audio_duration if is_playing else 0
    return {
        "is_playing": is_playing,
        "elapsed_time": elapsed,
        "audio_duration": audio_duration,
        "current_song": current_song,
        "live_mode": live_mode,
        "timestamp": time.time(),
    }


def _notify_sse_clients(state_data: dict):
    """Push state to all connected SSE clients instantly."""
    with SSE_CLIENTS_LOCK:
        for q in list(SSE_CLIENT_QUEUES.values()):
            try:
                q.put_nowait(state_data)
            except _queue.Full:
                pass


@app.route("/api/radio/state", methods=["GET"])
@app.route("/kyosky/api/radio/state", methods=["GET"])
def radio_state():
    """Get current radio playback state. Acts as heartbeat if broadcaster token present."""
    token = request.headers.get("X-Broadcaster-Token", "")
    if token:
        _validate_broadcaster_token(token)
    return jsonify(_current_state_dict())


@app.route("/api/radio/toggle", methods=["POST"])
@app.route("/kyosky/api/radio/toggle", methods=["POST"])
def radio_toggle():
    """Toggle the radio playback state — requires valid broadcaster token."""
    token = request.headers.get("X-Broadcaster-Token", "")
    if not _validate_broadcaster_token(token):
        logger.warning("Radio toggle denied - invalid or expired session token")
        return jsonify({"success": False, "error": "unauthorized"}), 401

    with RADIO_STATE_LOCK:
        RADIO_STATE["is_playing"] = not RADIO_STATE["is_playing"]
        RADIO_STATE["last_toggled_time"] = time.time()
        is_playing = RADIO_STATE["is_playing"]

    logger.info(f"Radio toggled: now {'playing' if is_playing else 'stopped'}")

    state = _current_state_dict()
    _notify_sse_clients(state)

    return jsonify(
        {
            "success": True,
            "is_playing": is_playing,
            "timestamp": time.time(),
        }
    )


@app.route("/api/radio/audio")
@app.route("/kyosky/api/radio/audio")
def radio_audio():
    """Serve the currently active song, or redirect to live stream when live_mode is on."""
    with RADIO_STATE_LOCK:
        current_song = RADIO_STATE["current_song"]
        live_mode = RADIO_STATE["live_mode"]

    if live_mode:
        return redirect("/radio/live/index.m3u8")

    audio_file = os.path.join(RADIO_DIR, current_song)

    if not os.path.exists(audio_file):
        logger.error(f"Audio file not found: {audio_file}")
        return jsonify({"error": "Audio file not found"}), 404

    logger.info(f"Serving audio file: {audio_file}")
    return send_file(audio_file, mimetype="audio/mpeg")


@app.route("/api/radio/live/start", methods=["POST"])
@app.route("/kyosky/api/radio/live/start", methods=["POST"])
def live_start():
    """Switch all listeners to live stream — requires valid broadcaster token."""
    token = request.headers.get("X-Broadcaster-Token", "")
    if not _validate_broadcaster_token(token):
        return jsonify({"success": False, "error": "unauthorized"}), 401
    with RADIO_STATE_LOCK:
        RADIO_STATE["live_mode"] = True
    logger.info("Live mode enabled")
    _notify_sse_clients(_current_state_dict())
    return jsonify({"live_mode": True})


@app.route("/api/radio/live/stop", methods=["POST"])
@app.route("/kyosky/api/radio/live/stop", methods=["POST"])
def live_stop():
    """Return all listeners to recorded audio — requires valid broadcaster token."""
    token = request.headers.get("X-Broadcaster-Token", "")
    if not _validate_broadcaster_token(token):
        return jsonify({"success": False, "error": "unauthorized"}), 401
    with RADIO_STATE_LOCK:
        RADIO_STATE["live_mode"] = False
    logger.info("Live mode disabled")
    _notify_sse_clients(_current_state_dict())
    return jsonify({"live_mode": False})


@app.route("/api/radio/stream", methods=["PUT"])
@app.route("/kyosky/api/radio/stream", methods=["PUT"])
def receive_stream():
    """Accept chunked audio upload from broadcaster (ffmpeg/curl) and buffer it."""
    token = request.headers.get("X-Auth-Token", "")
    if not _validate_broadcaster_token(token):
        return jsonify({"success": False, "error": "unauthorized"}), 401
    chunk_size = 4096
    while True:
        chunk = request.stream.read(chunk_size)
        if not chunk:
            break
        try:
            LIVE_STREAM_BUFFER.put_nowait(chunk)
        except _queue.Full:
            LIVE_STREAM_BUFFER.get_nowait()
            LIVE_STREAM_BUFFER.put_nowait(chunk)
    return "", 200


@app.route("/api/radio/relay-stream", methods=["PUT"])
@app.route("/kyosky/api/radio/relay-stream", methods=["PUT"])
def relay_stream():
    """Accept raw OGG/AAC from a phone without ffmpeg; transcode server-side to HLS."""
    token = request.headers.get("X-Auth-Token", "")
    if not _validate_broadcaster_token(token):
        return jsonify({"success": False, "error": "unauthorized"}), 401

    content_type = request.content_type or "audio/ogg"
    input_fmt = "aac" if "aac" in content_type else "ogg"

    os.makedirs(HLS_LIVE_DIR, exist_ok=True)
    for f in os.listdir(HLS_LIVE_DIR):
        try:
            os.remove(os.path.join(HLS_LIVE_DIR, f))
        except OSError:
            pass

    cmd = [
        "ffmpeg", "-f", input_fmt, "-i", "pipe:0",
        "-map", "0:a", "-c:a", "libmp3lame", "-b:a", "128k",
        "-f", "hls", "-hls_time", "3", "-hls_list_size", "5",
        "-hls_flags", "delete_segments",
        "-hls_segment_filename", os.path.join(HLS_LIVE_DIR, "seg%03d.ts"),
        os.path.join(HLS_LIVE_DIR, "index.m3u8"),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    with RADIO_STATE_LOCK:
        RADIO_STATE["live_mode"] = True
    _notify_sse_clients(_current_state_dict())
    logger.info("relay_stream: live mode on, ffmpeg transcoding %s", input_fmt)

    try:
        while True:
            chunk = request.stream.read(4096)
            if not chunk:
                break
            try:
                proc.stdin.write(chunk)
                proc.stdin.flush()
            except BrokenPipeError:
                break
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass
        proc.wait(timeout=10)
        with RADIO_STATE_LOCK:
            RADIO_STATE["live_mode"] = False
        _notify_sse_clients(_current_state_dict())
        logger.info("relay_stream: stream ended, live mode off")

    return "", 200


def _ts_duration(ts_path: str) -> float:
    """Return duration of a .ts file in seconds via ffprobe."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", ts_path],
            capture_output=True, text=True, timeout=5,
        )
        return float(json.loads(r.stdout)["format"]["duration"])
    except Exception:
        return 4.0


def _write_hls_playlist(ts_files: list, media_sequence: int) -> None:
    """Atomically write an HLS playlist for the given .ts filenames.

    Each segment is independently converted and starts with PTS=0, so we mark
    every segment with EXT-X-DISCONTINUITY to prevent hls.js from expecting
    continuous timestamps and inserting silence at boundaries.
    """
    max_dur = 5.0
    entries = []
    for fname in ts_files:
        dur = _ts_duration(os.path.join(HLS_LIVE_DIR, fname))
        max_dur = max(max_dur, dur + 0.5)
        entries.append((fname, dur))

    content = (
        "#EXTM3U\n"
        "#EXT-X-VERSION:3\n"
        f"#EXT-X-TARGETDURATION:{int(max_dur)}\n"
        f"#EXT-X-MEDIA-SEQUENCE:{media_sequence}\n"
        "#EXT-X-DISCONTINUITY-SEQUENCE:0\n"
    )
    for fname, dur in entries:
        content += f"#EXT-X-DISCONTINUITY\n#EXTINF:{dur:.3f},\n{fname}\n"

    m3u8 = os.path.join(HLS_LIVE_DIR, "index.m3u8")
    tmp = m3u8 + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.replace(tmp, m3u8)


@app.route("/api/radio/relay-segment", methods=["POST"])
@app.route("/kyosky/api/radio/relay-segment", methods=["POST"])
def relay_segment():
    """Receive a single OGG audio segment, convert to .ts, update HLS playlist.

    Phone loops: record 4 s → POST here → repeat.  No ffmpeg needed on phone.
    Uses password-based auth so it never touches the browser broadcaster session.
    """
    global _HLS_SEG_COUNTER
    password = request.headers.get("X-Broadcast-Password", "")
    if password != BROADCAST_PASSWORD:
        return jsonify({"success": False, "error": "unauthorized"}), 401

    ogg_data = request.stream.read()
    if not ogg_data:
        return "", 400

    os.makedirs(HLS_LIVE_DIR, exist_ok=True)

    with _HLS_SEG_LOCK:
        n = _HLS_SEG_COUNTER
        _HLS_SEG_COUNTER += 1

    tmp_ogg = os.path.join(HLS_LIVE_DIR, f"_tmp_{n}.ogg")
    ts_name = f"seg{n:06d}.ts"
    ts_path = os.path.join(HLS_LIVE_DIR, ts_name)

    with open(tmp_ogg, "wb") as f:
        f.write(ogg_data)

    result = subprocess.run(
        ["ffmpeg", "-y", "-i", tmp_ogg,
         "-c:a", "aac", "-b:a", "128k", "-f", "mpegts", ts_path],
        capture_output=True,
    )
    try:
        os.unlink(tmp_ogg)
    except OSError:
        pass

    if result.returncode != 0 or not os.path.exists(ts_path):
        logger.error("relay_segment: ffmpeg failed: %s", result.stderr.decode()[-300:])
        return "", 500

    # Keep last 5 .ts segments; delete older ones
    all_ts = sorted(
        f for f in os.listdir(HLS_LIVE_DIR)
        if f.endswith(".ts") and not f.startswith("_")
    )
    while len(all_ts) > 5:
        old = all_ts.pop(0)
        try:
            os.remove(os.path.join(HLS_LIVE_DIR, old))
        except OSError:
            pass

    first_n = int(all_ts[0].replace("seg", "").replace(".ts", "")) if all_ts else n
    _write_hls_playlist(all_ts, first_n)
    logger.info("relay_segment: wrote segment %d, playlist has %d entries", n, len(all_ts))

    # Enable live mode on first segment
    with RADIO_STATE_LOCK:
        was_live = RADIO_STATE["live_mode"]
        RADIO_STATE["live_mode"] = True
    if not was_live:
        _notify_sse_clients(_current_state_dict())
        logger.info("relay_segment: live mode enabled")

    return "", 200


@app.route("/api/radio/live-stream")
@app.route("/kyosky/api/radio/live-stream")
def serve_live_stream():
    """Relay buffered live audio chunks to a browser listener."""
    def generate():
        while True:
            try:
                chunk = LIVE_STREAM_BUFFER.get(timeout=10)
                yield chunk
            except _queue.Empty:
                break

    return Response(
        generate(),
        mimetype="audio/mpeg",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/radio/songs", methods=["GET"])
@app.route("/kyosky/api/radio/songs", methods=["GET"])
def radio_songs():
    """List all available MP3 files with durations."""
    return jsonify(_scan_songs())


@app.route("/api/radio/song", methods=["POST"])
@app.route("/kyosky/api/radio/song", methods=["POST"])
def radio_song_switch():
    """Switch the active song — requires valid broadcaster token."""
    token = request.headers.get("X-Broadcaster-Token", "")
    if not _validate_broadcaster_token(token):
        return jsonify({"success": False, "error": "unauthorized"}), 401

    data = request.json or {}
    filename = data.get("filename", "")

    # Validate: only allow plain filenames (no path traversal)
    if not filename or os.path.basename(filename) != filename or not filename.lower().endswith(".mp3"):
        return jsonify({"success": False, "error": "invalid_filename"}), 400

    audio_file = os.path.join(RADIO_DIR, filename)
    if not os.path.exists(audio_file):
        return jsonify({"success": False, "error": "file_not_found"}), 404

    duration = _get_mp3_duration(audio_file)

    with RADIO_STATE_LOCK:
        RADIO_STATE["current_song"] = filename
        RADIO_STATE["audio_duration"] = duration
        RADIO_STATE["last_toggled_time"] = time.time()

    logger.info(f"Song switched to: {filename} ({duration:.1f}s)")

    state = _current_state_dict()
    _notify_sse_clients(state)

    return jsonify({"success": True, "current_song": filename, "duration": duration})


@app.route("/api/radio/events")
@app.route("/kyosky/api/radio/events")
def radio_events():
    """Server-Sent Events stream — queue-based push, no polling."""

    def generate_sse():
        client_id = id(threading.current_thread())
        q: _queue.Queue = _queue.Queue(maxsize=8)

        # Send initial state before registering — avoids missing an update
        # that arrives between registration and the first yield.
        initial = _current_state_dict()
        yield f"data: {json.dumps(initial)}\n\n"

        with SSE_CLIENTS_LOCK:
            SSE_CLIENT_QUEUES[client_id] = q

        try:
            while True:
                try:
                    # Block until toggle pushes a state update (releases GIL).
                    # Timeout fires keepalive so proxies don't kill idle connections.
                    event = q.get(timeout=15)
                    yield f"data: {json.dumps(event)}\n\n"
                except _queue.Empty:
                    yield ": keepalive\n\n"
        except GeneratorExit:
            logger.debug("SSE client disconnected")
        except Exception as e:
            logger.error(f"SSE error: {e}")
        finally:
            with SSE_CLIENTS_LOCK:
                SSE_CLIENT_QUEUES.pop(client_id, None)

    return Response(
        generate_sse(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/radar", methods=["POST"])
@app.route("/kyosky/radar", methods=["POST"])
def radar():
    logger.info(f"POST /radar - Received request with data: {request.json}")
    try:
        data = request.json or {}

        # Run the radar script
        result = run_radar_script(data)

        # If script failed, return details
        if result.returncode != 0:
            logger.error("Radar script execution failed")
            return (
                jsonify(
                    {
                        "error": "Radar script execution failed",
                        "details": result.stderr,
                        "output": result.stdout,
                        "command": (
                            " ".join(result.args) if hasattr(result, "args") else None
                        ),
                    }
                ),
                500,
            )

        # Check if video was created
        if os.path.exists(RADAR_VIDEO):
            logger.info(f"Radar video created successfully: {RADAR_VIDEO}")
            return jsonify(
                {
                    "success": True,
                    "video_url": "radar-video",
                    "message": "Radar generated successfully",
                }
            )
        else:
            logger.error(f"Radar video not found after generation: {RADAR_VIDEO}")
            return (
                jsonify(
                    {
                        "error": "Radar video not created",
                        "expected": RADAR_VIDEO,
                    }
                ),
                500,
            )

    except subprocess.TimeoutExpired:
        logger.error("Radar script execution timeout")
        return jsonify({"error": "Radar script execution timeout"}), 500
    except Exception as e:
        import traceback

        logger.error(f"Exception in radar: {e}", exc_info=True)
        return jsonify({"error": str(e), "traceback": traceback.format_exc()}), 500


def _build_cmd_from_data(data=None):
    """Build the command list for running the prediction script from given data or defaults."""
    script_path = os.path.join(
        os.path.dirname(__file__), "energy_weather_node_past_future.py"
    )
    cmd = [sys.executable, script_path]

    if not data:
        data = {}

    location = data.get("location")
    start_date = data.get("start_date")
    latitude = data.get("latitude")
    longitude = data.get("longitude")
    turbine_power_kW = data.get("turbine_power_kW")
    pv_power_kWp = data.get("pv_power_kWp")

    if location:
        cmd.extend(["--location", str(location)])
    if start_date:
        cmd.extend(["--first_date", str(start_date)])
    if latitude is not None and longitude is not None:
        cmd.extend(["--latitude", str(latitude), "--longitude", str(longitude)])
    if turbine_power_kW:
        cmd.extend(["--turbine_power_kW", str(turbine_power_kW)])
    if pv_power_kWp:
        cmd.extend(["--PV_power_kWp", str(pv_power_kWp)])

    return cmd


def _build_radar_cmd_from_data(data=None):
    """Build the command list for running the radar script from given data or defaults."""
    script_path = os.path.join(os.path.dirname(__file__), "get_radar_forecast.py")
    cmd = [sys.executable, script_path]

    if not data:
        data = {}

    # Use defaults if not provided
    latitude = data.get("latitude", 47.993794)
    longitude = data.get("longitude", 7.840820)
    radius = data.get("radar_radius", 80)
    location = data.get("location", "kyo.sk_Y")

    cmd.extend(
        [
            "-lat",
            str(latitude),
            "-lon",
            str(longitude),
            "-rad",
            str(radius),
            "-name",
            str(location),
        ]
    )

    return cmd


def run_prediction_script(data=None, timeout=300):
    """Execute the prediction script with the given data dict (or defaults when None).

    Returns the subprocess.CompletedProcess instance.
    """
    work_dir = os.path.dirname(__file__)
    cmd = _build_cmd_from_data(data)

    logger.info(f"Executing command: {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=work_dir,
    )

    logger.info(f"Script returned code: {result.returncode}")
    if result.stdout:
        logger.info(f"Script stdout: {result.stdout[:1000]}")
    if result.stderr:
        logger.error(f"Script stderr: {result.stderr[:1000]}")

    return result


def run_radar_script(data=None, timeout=300):
    """Execute the radar script with the given data dict (or defaults when None).

    Returns the subprocess.CompletedProcess instance.
    """
    work_dir = os.path.dirname(__file__)
    cmd = _build_radar_cmd_from_data(data)

    logger.info(f"Executing radar command: {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=work_dir,
    )

    logger.info(f"Radar script returned code: {result.returncode}")
    if result.stdout:
        logger.info(f"Radar script stdout: {result.stdout[:1000]}")
    if result.stderr:
        logger.error(f"Radar script stderr: {result.stderr[:1000]}")

    return result


def _live_watchdog():
    """Auto-disable live_mode when the HLS stream goes stale (stream dropped without clicking Stop Live)."""
    while True:
        time.sleep(5)
        with RADIO_STATE_LOCK:
            if not RADIO_STATE["live_mode"]:
                continue
        hls_index = os.path.join(HLS_LIVE_DIR, "index.m3u8")
        if os.path.exists(hls_index):
            age = time.time() - os.path.getmtime(hls_index)
            if age > 15:
                with RADIO_STATE_LOCK:
                    RADIO_STATE["live_mode"] = False
                logger.info("Live watchdog: HLS stale for %.0fs, disabling live mode", age)
                _notify_sse_clients(_current_state_dict())


def _scheduler_loop(interval_minutes=10):
    """Background loop that runs radar generation every `interval_minutes` minutes.
    Prediction runs every 3 hours."""
    logger.info(
        f"Scheduler loop starting: radar every {interval_minutes}min, prediction every 3h"
    )

    prediction_counter = 0
    prediction_interval_minutes = 180  # 3 hours

    while True:
        try:
            # Run radar every interval
            logger.info("Scheduler: running automatic radar generation")
            radar_res = run_radar_script(None)
            if radar_res.returncode != 0:
                logger.error(
                    "Scheduler radar run failed: %s",
                    radar_res.stderr[:1000] if radar_res.stderr else "",
                )
            else:
                logger.info("Scheduler radar run completed successfully")

            # Check if it's time to run prediction (every 3 hours = 180 minutes)
            prediction_counter += interval_minutes
            if prediction_counter >= prediction_interval_minutes:
                logger.info("Scheduler: running automatic prediction")
                res = run_prediction_script(None)
                if res.returncode != 0:
                    logger.error(
                        "Scheduler prediction run failed: %s",
                        res.stderr[:1000] if res.stderr else "",
                    )
                else:
                    logger.info("Scheduler prediction run completed successfully")
                prediction_counter = 0

        except Exception as e:
            logger.exception("Scheduler exception: %s", e)

        # Sleep for the configured interval
        time.sleep(interval_minutes * 60)


_init_scheduler = False


@app.before_request
def _start_scheduler_once():
    global _init_scheduler
    if not _init_scheduler:
        logger.info("Starting scheduler thread (on first request)")

        # Run initial generation in background
        def initial_run():
            logger.info("Initial run: generating radar")
            try:
                run_radar_script(None)
            except Exception as e:
                logger.error(f"Initial radar generation failed: {e}")

        # Start initial run in separate thread
        threading.Thread(target=initial_run, daemon=True).start()

        # Start the scheduler loop
        t = threading.Thread(
            target=_scheduler_loop, kwargs={"interval_minutes": 10}, daemon=True
        )
        t.start()
        threading.Thread(target=_live_watchdog, daemon=True).start()
        _init_scheduler = True


if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=5001)
