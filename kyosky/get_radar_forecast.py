import argparse
import logging
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
import gc
import io
import time

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
import xarray as xr
from matplotlib.colors import ListedColormap, BoundaryNorm
from matplotlib.patches import Rectangle
from pyproj import Proj, Transformer

import cartopy.crs as ccrs
import cartopy.feature as cfeature

import imageio.v2 as imageio
import sys
from PIL import Image

from wetterdienst.provider.dwd.radar import (
    DwdRadarParameter,
    DwdRadarPeriod,
    DwdRadarResolution,
    DwdRadarValues,
)
from wetterdienst import Settings

Settings.cache_disable = True

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# -------------------------------------------------------------------
# RADOLAN projection
# -------------------------------------------------------------------
radolan_proj = Proj(
    proj="stere",
    lat_0=90,
    lat_ts=60,
    lon_0=10,
    a=6370040,
    b=6370040,
)

wgs84 = Proj("epsg:4326")
transformer = Transformer.from_proj(radolan_proj, wgs84, always_xy=True)

PIXEL_SIZE = 1000
NX = 900
NY = 900
X_ORIGIN = -523462
Y_ORIGIN = -4658645

# Pre-compute grid once (major speedup!)
_grid_cache = {}


def radolan_lonlat_grid(nx=None, ny=None):
    if nx is None:
        nx = NX
    if ny is None:
        ny = NY

    key = (nx, ny)
    if key not in _grid_cache:
        x = X_ORIGIN + np.arange(nx) * PIXEL_SIZE
        y = Y_ORIGIN + np.arange(ny) * PIXEL_SIZE
        xx, yy = np.meshgrid(x, y)
        lon, lat = transformer.transform(xx, yy)
        _grid_cache[key] = (lon, lat)

    return _grid_cache[key]


def lonlat_grid_for(ds):
    """Build the lon/lat grid from a dataset's own projection coordinates.

    RADOLAN RW comes on the 900x900 grid, but the RV nowcast uses DWD's larger
    DE1200 grid (1200x1100, different origin), so the grid cannot be hardcoded.
    The x/y coordinates are in km.
    """
    x_km = ds["x"].values
    y_km = ds["y"].values
    key = (len(x_km), len(y_km), round(float(x_km[0]), 3), round(float(y_km[0]), 3))

    if key not in _grid_cache:
        xx, yy = np.meshgrid(x_km * PIXEL_SIZE, y_km * PIXEL_SIZE)
        _grid_cache[key] = transformer.transform(xx, yy)

    return _grid_cache[key]


def forecast_lead_minutes(item):
    """Lead time of a RADVOR file in minutes, read from its name (..._030)."""
    name = getattr(item, "filename", None) or str(getattr(item, "url", "") or "")
    match = re.search(r"_(\d{3})(?:\D|$)", name)
    return int(match.group(1)) if match else None


def pick_lead(items, lead):
    """The file for one lead time out of a single forecast cycle."""
    for item in items:
        if forecast_lead_minutes(item) == lead:
            return item
    return None


def normalize_timestamp(item, ds=None):
    ts = getattr(item, "timestamp", None)

    if ts is not None:
        if isinstance(ts, str):
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if ts.tzinfo is None:
            return ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc)

    if ds is not None and "time" in ds.coords:
        ts = ds.coords["time"].values
        ts = pd.to_datetime(ts).to_pydatetime()
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts

    raise ValueError("No valid timestamp found")


def find_rain_within_radius(da, lon, lat, lon0, lat0, min_radius, max_radius=500):
    current_radius = min_radius

    while current_radius <= max_radius:
        da_masked = mask_radius_km(da, lon, lat, lon0, lat0, current_radius)
        max_val = float(da_masked.max(skipna=True))
        sum_val = float(da_masked.sum(skipna=True))
        val_flag = max_val < sum_val / 100

        if max_val > 0.2 and val_flag:
            log.info(
                f"  Found rain at radius {current_radius} km (max: {max_val:.2f} mm/h)"
            )
            current_radius += 20
            return da_masked, current_radius

        current_radius += 50

    log.warning(f"  No rain found up to {max_radius} km, using max radius")
    da_masked = mask_radius_km(da, lon, lat, lon0, lat0, max_radius)
    return da_masked, max_radius


def mask_radius_km(da, lon, lat, lon0, lat0, radius_km):
    R = 6371.0
    lon1 = np.radians(lon)
    lat1 = np.radians(lat)
    lon2 = np.radians(lon0)
    lat2 = np.radians(lat0)

    dlon = lon1 - lon2
    dlat = lat1 - lat2

    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    c = 2 * np.arcsin(np.sqrt(a))

    dist_km = R * c
    return da.where(dist_km <= radius_km)


def rainfall_colormap_with_norm():
    colors = [
        "#FFFFFF",
        "#00CCFF",
        "#7167FF",
        "#00FF00",
        "#FFFF00",
        "#FFA500",
        "#FF0000",
        "#8B008B",
    ]
    boundaries = [0, 0.1, 1, 2, 3, 5, 10, 20, 25]
    cmap = ListedColormap(colors)
    norm = BoundaryNorm(boundaries, cmap.N)
    return cmap, norm


# Pre-load cartopy features once (huge speedup!)
_feature_cache = {}


def get_cartopy_features():
    if not _feature_cache:
        _feature_cache["land"] = cfeature.LAND.with_scale(
            "50m"
        )  # Use 50m instead of 10m
        _feature_cache["ocean"] = cfeature.OCEAN.with_scale("50m")
        _feature_cache["lakes"] = cfeature.LAKES.with_scale("50m")
        _feature_cache["rivers"] = cfeature.RIVERS.with_scale("50m")
        _feature_cache["borders"] = cfeature.BORDERS.with_scale("50m")
        _feature_cache["coastline"] = cfeature.COASTLINE.with_scale("50m")
        _feature_cache["states"] = cfeature.NaturalEarthFeature(
            category="cultural",
            name="admin_1_states_provinces_lines",
            scale="50m",
            facecolor="none",
        )
    return _feature_cache


def render_frame_to_buffer(
    da,
    lon,
    lat,
    timestamp_utc,
    lat_center,
    lon_center,
    radius_km,
    name,
    is_forecast=False,
    entry=None,
    radius_str=None,
):
    """
    Render frame directly to buffer (no disk I/O).
    Returns numpy array.
    """
    map_extent_degrees = (radius_km / 111) * 1.2

    fig = plt.figure(figsize=(8, 8), dpi=80)  # Reduced from 10x10@100dpi
    ax = plt.axes(projection=ccrs.PlateCarree())

    ax.set_extent(
        [
            lon_center - map_extent_degrees,
            lon_center + map_extent_degrees,
            lat_center - map_extent_degrees,
            lat_center + map_extent_degrees,
        ],
        crs=ccrs.PlateCarree(),
    )

    features = get_cartopy_features()
    ax.add_feature(features["land"], facecolor="#e8e8e8", zorder=0)
    ax.add_feature(features["ocean"], facecolor="#d4f1f9", zorder=0)
    # ax.add_feature(
    #     features["lakes"],
    #     facecolor="#d4f1f9",
    #     edgecolor="blue",
    #     linewidth=0.3,
    #     alpha=1,
    #     zorder=1,
    # )
    # ax.add_feature(
    #     features["rivers"],
    #     edgecolor="#4da6ff",
    #     linewidth=0.7,
    #     alpha=1,
    #     zorder=2,
    # )
    ax.add_feature(features["borders"], linewidth=1, zorder=3)
    ax.add_feature(features["coastline"], linewidth=1, zorder=3)

    # Add coordinate grid
    gl = ax.gridlines(
        draw_labels=True,
        linewidth=0.5,
        color="gray",
        alpha=0.7,
        linestyle=":",
        zorder=3,
    )
    gl.top_labels = False
    gl.right_labels = False
    gl.xlabel_style = {"size": 8, "color": "black"}
    gl.ylabel_style = {"size": 8, "color": "black"}

    ax.add_feature(
        features["states"], edgecolor="black", linewidth=0.5, alpha=0.8, zorder=3
    )

    cmap, norm = rainfall_colormap_with_norm()

    pcm = ax.pcolormesh(
        lon,
        lat,
        da,
        cmap=cmap,
        norm=norm,
        shading="auto",
        transform=ccrs.PlateCarree(),
        alpha=0.6 if not is_forecast else 0.7,
        zorder=4,
    )

    cbar = plt.colorbar(pcm, ax=ax, shrink=0.75, pad=0.03)
    # cbar.set_label("Precipitation [mm/h]", fontsize=9)
    cbar.set_ticks([0.05, 0.55, 1.5, 2.5, 4.0, 7.5, 15.0, 22.5])
    cbar.set_ticklabels(
        [
            "0",
            "drizzle",
            "light",
            "moderate",
            "heavy",
            "very heavy",
            "hardcore",
            "insane",
        ],
        fontsize=8,
    )

    ax.plot(
        lon_center,
        lat_center,
        "ro",
        markersize=8,
        markeredgecolor="white",
        markeredgewidth=1,
        transform=ccrs.PlateCarree(),
        zorder=5,
    )

    # Convert timestamp to local time
    timestamp_local = timestamp_utc.astimezone(ZoneInfo("Europe/Berlin"))

    # For forecasts, add the lead time to the displayed timestamp
    if is_forecast and entry.get("lead_minutes", 0) > 0:
        display_time = timestamp_local + timedelta(minutes=entry.get("lead_minutes", 0))
        timestamp_str = display_time.strftime("%Y-%m-%d %H:%M")
        title = f"{timestamp_str} @{name}  (T+{entry.get('lead_minutes', 0)}min) R={radius_km} km"
    else:
        timestamp_str = timestamp_local.strftime("%Y-%m-%d %H:%M")
        title = f"{timestamp_str} @{name} R={radius_km} km"

    ax.set_title(title, fontsize=11, fontweight="bold", pad=15)

    # if is_forecast:
    #     ax.text(
    #         0.5,
    #         0.95,
    #         "future",
    #         transform=ax.transAxes,
    #         fontsize=12,
    #         fontweight="bold",
    #         color="limegreen",
    #         ha="center",
    #         va="center",
    #     )

    # ax.add_patch(
    #     Rectangle(
    #         (0.02, 0.02),
    #         0.95,
    #         0.05,
    #         transform=ax.transAxes,
    #         facecolor="white",
    #         edgecolor="black",
    #         alpha=0.8,
    #         zorder=6,
    #     )
    # )
    # ax.text(
    #     0.5,
    #     0.045,
    #     f"{radius_str}",
    #     transform=ax.transAxes,
    #     fontsize=11,
    #     color="limegreen",
    #     ha="center",
    #     va="center",
    #     zorder=7,
    # )

    # Render to buffer
    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=80, bbox_inches="tight", facecolor="white")
    buf.seek(0)

    # Read as numpy array
    img = imageio.imread(buf)

    plt.close(fig)
    del fig, ax, pcm, cbar, buf
    plt.close("all")

    return img


def radar_with_forecast_to_video(lat, lon, radius0, name):
    output_dir = Path("radar_png")
    output_dir.mkdir(exist_ok=True, parents=True)
    output_mp4 = output_dir / "radar_forecast.mp4"
    # Render to a temp file and move it into place at the end, so the web page never
    # serves a half-written video during the ~2 minutes a run takes.
    tmp_mp4 = output_dir / "radar_forecast.tmp.mp4"  # keep .mp4 so imageio picks the ffmpeg backend
    max_radius = 500
    now = datetime.now(timezone.utc)

    log.info("=" * 60)
    log.info("Querying RADOLAN (historical, past 2 hours)...")
    log.info("=" * 60)

    hist_start = now - timedelta(minutes=90)
    hist_start_str = hist_start.strftime("%Y-%m-%d %H:%M:%S")
    hist_end_str = now.strftime("%Y-%m-%d %H:%M:%S")

    historical_items = []
    try:
        radolan = DwdRadarValues(
            parameter=DwdRadarParameter.RADOLAN_CDC,
            resolution=DwdRadarResolution.HOURLY,
            period=DwdRadarPeriod.RECENT,
            start_date=hist_start_str,
            end_date=hist_end_str,
        )
        historical_items = sorted(
            radolan.query(), key=lambda i: i.timestamp, reverse=True
        )
    except Exception as e:
        log.error(f"Failed to query RADOLAN: {e}")

    if not historical_items:
        log.warning("No RADOLAN historical data found")
    else:
        log.info(f"Found {len(historical_items)} RADOLAN timesteps")

    log.info("=" * 60)
    log.info("Querying RADVOR (radar-based nowcast)...")
    log.info("=" * 60)

    def floor_to_5min(dt):
        return dt.replace(
            minute=(dt.minute // 5) * 5,
            second=0,
            microsecond=0,
        )

    forecast_base = floor_to_5min(now)
    forecast_start = forecast_base - timedelta(minutes=15)
    forecast_end = forecast_base + timedelta(minutes=15)
    forecast_start_str = forecast_start.strftime("%Y-%m-%d %H:%M:%S")
    forecast_end_str = forecast_end.strftime("%Y-%m-%d %H:%M:%S")

    forecast_items = []
    try:
        log.info(
            f"  Trying RQ_REFLECTIVITY from {forecast_start_str} to {forecast_end_str}..."
        )
        radvor = DwdRadarValues(
            parameter=DwdRadarParameter.RQ_REFLECTIVITY,
            resolution=DwdRadarResolution.MINUTE_5,
            start_date=forecast_start_str,
            end_date=forecast_end_str,
        )
        forecast_items = sorted(radvor.query(), key=lambda i: i.timestamp)
        if forecast_items:
            log.info(f"✓ Found {len(forecast_items)} RQ_REFLECTIVITY timesteps")
        else:
            log.warning("RQ_REFLECTIVITY query returned no results")
    except Exception as e:
        log.warning(f"RQ_REFLECTIVITY failed: {e}")

    # DWD no longer publishes RQ - the query just comes back empty rather than
    # erroring - so fall back to RV, its replacement. Not RE: that one still
    # exists but delivers an all-zero field, which renders as a frozen, rainless
    # forecast.
    if not forecast_items:
        log.info("Trying RV_REFLECTIVITY...")
        try:
            radvor = DwdRadarValues(
                parameter=DwdRadarParameter.RV_REFLECTIVITY,
                start_date=forecast_start_str,
                end_date=forecast_end_str,
            )
            forecast_items = sorted(radvor.query(), key=lambda i: i.timestamp)
            if forecast_items:
                log.info(f"✓ Found {len(forecast_items)} RV_REFLECTIVITY timesteps")
            else:
                log.warning("RV_REFLECTIVITY query returned no results")
        except Exception as e2:
            log.warning(f"RV_REFLECTIVITY also failed: {e2}")

    if forecast_items:
        log.info(f"Found {len(forecast_items)} RADVOR timesteps")
    else:
        log.warning("No RADVOR forecast data found")

    from collections import defaultdict

    cycles = defaultdict(list)
    for item in forecast_items:
        if item.timestamp:
            cycles[item.timestamp].append(item)

    radvor_cycles = sorted(cycles.items(), key=lambda x: x[0])
    radvor_frames = []

    if radvor_cycles:
        *older_cycles, latest_cycle = radvor_cycles

        for base_time, items in older_cycles:
            radvor_frames.append(
                {
                    "item": pick_lead(items, 0) or items[0],
                    "is_forecast": True,
                    "timestamp": base_time,
                    "lead_minutes": 0,
                }
            )

        latest_base, latest_items = latest_cycle
        LEAD_MINUTES = [0, 30, 60]

        # A cycle holds one file per 5-minute lead time, so the file for T+30 has to
        # be looked up by its lead: taking the first three files of the cycle would
        # label T+5 and T+10 as T+30 and T+60 and the forecast would barely move.
        for lead in LEAD_MINUTES:
            item = pick_lead(latest_items, lead)
            if item is None:
                log.warning(f"No forecast file for T+{lead}min in cycle {latest_base}")
                continue
            radvor_frames.append(
                {
                    "item": item,
                    "is_forecast": True,
                    "timestamp": latest_base + timedelta(minutes=lead),
                    "lead_minutes": lead,
                }
            )

    log.info("=" * 60)
    log.info("Combining historical + forecast...")
    log.info("=" * 60)

    all_items = []

    for item in reversed(historical_items):
        if item.timestamp:
            all_items.append(
                {"item": item, "is_forecast": False, "timestamp": item.timestamp}
            )

    for frame in radvor_frames:
        all_items.append(frame)

    all_items = sorted(all_items, key=lambda x: x["timestamp"])

    if not all_items:
        log.error("No data (historical or forecast) found")
        return False

    log.info(f"Total frames to generate: {len(all_items)}")

    # Open video writer
    log.info("=" * 60)
    log.info("Rendering frames directly to video...")
    log.info("=" * 60)

    # We'll determine target size from first frame
    target_size = None
    writer = None

    try:
        for idx, entry in enumerate(all_items):
            item = entry["item"]
            is_forecast = entry["is_forecast"]
            data_type = "FORECAST" if is_forecast else "OBSERVED"

            log.info(
                f"[{idx+1}/{len(all_items)}] Processing {item.timestamp} ({data_type})"
            )

            ds = None
            try:
                ds = xr.open_dataset(item.data, engine="radolan")
                product = next(iter(ds.data_vars))
                da = ds[product].astype("float32")
                timestamp_utc = normalize_timestamp(item, ds)

                grid_lon, grid_lat = lonlat_grid_for(ds)

                da_masked, radius = find_rain_within_radius(
                    da, grid_lon, grid_lat, lon, lat, radius0, max_radius
                )

                if radius > max_radius - 50:
                    radius_str = "No rain within 500 km!"
                elif radius > radius0:
                    radius_str = f"found rain within {radius} km"
                else:
                    radius_str = "Rainy days? use an umbrella ;)"

                num_duplicates = 3 if is_forecast else 1

                for dup_idx in range(num_duplicates):
                    img = render_frame_to_buffer(
                        da_masked,
                        grid_lon,
                        grid_lat,
                        timestamp_utc,
                        lat,
                        lon,
                        radius,
                        name,
                        is_forecast=is_forecast,
                        entry=entry,
                        radius_str=radius_str,
                    )

                    # Initialize writer with first frame size
                    if writer is None:
                        target_size = img.shape[:2]
                        log.info(f"Video frame size: {target_size}")
                        writer = imageio.get_writer(
                            tmp_mp4, fps=1.5, codec="libx264", quality=8
                        )

                    # Ensure RGB
                    if img.ndim == 2:
                        img = np.stack([img] * 3, axis=-1)

                    # Resize if needed
                    current_size = img.shape[:2]
                    if current_size != target_size:
                        pil_img = Image.fromarray(img)
                        pil_img = pil_img.resize(
                            (target_size[1], target_size[0]), Image.Resampling.LANCZOS
                        )
                        img = np.array(pil_img)
                        del pil_img

                    writer.append_data(img)
                    del img

            except Exception as e:
                log.error(f"  Error processing {item.timestamp}: {e}")
                import traceback

                traceback.print_exc()
            finally:
                if ds is not None:
                    ds.close()
                    del ds

                if "da" in locals():
                    del da
                if "da_masked" in locals():
                    del da_masked

                if idx % 3 == 0:
                    gc.collect()

    finally:
        if writer is not None:
            writer.close()

    if writer is None:
        log.error("No frames were successfully processed")
        tmp_mp4.unlink(missing_ok=True)
        return False

    tmp_mp4.replace(output_mp4)

    log.info(f"✓ Video saved: {output_mp4}")
    log.info(
        f"  Historical frames: {sum(1 for e in all_items if not e['is_forecast'])}"
    )
    log.info(f"  Forecast frames: {sum(1 for e in all_items if e['is_forecast'])}")

    return True


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate radar video combining RADOLAN (historical) + RADVOR (forecast)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "-lat",
        "--latitude",
        type=float,
        required=False,
        default=47.993794,
        help="Center latitude (decimal degrees)",
    )

    parser.add_argument(
        "-lon",
        "--longitude",
        type=float,
        required=False,
        default=7.84082,
        help="Center longitude (decimal degrees)",
    )

    parser.add_argument(
        "-rad",
        "--radius",
        type=float,
        required=False,
        default=80,
        help="Radius in kilometers",
    )

    parser.add_argument(
        "-name",
        "--name",
        type=str,
        required=False,
        default="kyo.sk_Y",
        help="Location name (displayed in plot title)",
    )

    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    # measure time that code needs

    try:
        start = time.perf_counter()
        success = radar_with_forecast_to_video(
            lat=args.latitude,
            lon=args.longitude,
            radius0=args.radius,
            name=args.name,
        )
        elapsed = time.perf_counter() - start
        print(f"Total runtime: {elapsed:.2f} seconds")
        sys.exit(0 if success else 1)
    except Exception as e:
        log.error(f"Fatal error: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)
