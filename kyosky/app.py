from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import subprocess
import os
import json
import sys
import logging
import threading
import time

# Setup logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PLOT_FILE = os.path.join(BASE_DIR, "Meteostat_and_openweathermap_plots_only.html")
RADAR_VIDEO = os.path.join(BASE_DIR, "radar_png/radar_forecast.mp4")

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
        _init_scheduler = True


if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=5001)
