# Import libraries and dependencies
import pandas as pd
from datetime import datetime, timedelta, timezone
import plotly.graph_objs as go
from plotly.subplots import make_subplots
import requests
import plotly.graph_objects as go
from jinja2 import Environment, FileSystemLoader
import webbrowser
import argparse
import sys
import numpy as np
from windpowerlib import ModelChain, WindTurbine, create_power_curve
from windpowerlib import data as wt
import logging
import pvlib
from pvlib.pvsystem import PVSystem
import openmeteo_requests
import requests_cache
from retry_requests import retry


logging.getLogger().setLevel(logging.DEBUG)

# Timezone of the site this runs for. Used for everything that is calculated or plotted.
LOCAL_TZ = "Europe/Berlin"


def to_local_time(values):
    """Return timestamps as naive wall-clock time in LOCAL_TZ, ready for plotting.

    Plotly.js has no timezone support: it plots the clock time it is handed and ignores any
    UTC offset that came with it. The data arrives in a mix of zones - Open-Meteo answers in
    UTC, while the PV and wind power calculations run in local time - so without converting
    them to one zone the weather curves sit an hour (two in summer) beside the power curves
    and the red NOW line. Naive input is returned unchanged: it has no zone to convert from.
    """
    if isinstance(values, pd.Series):
        if values.dt.tz is None:
            return values
        return values.dt.tz_convert(LOCAL_TZ).dt.tz_localize(None)
    if isinstance(values, pd.DatetimeIndex):
        if values.tz is None:
            return values
        return values.tz_convert(LOCAL_TZ).tz_localize(None)
    if isinstance(values, (list, tuple)):
        return [to_local_time(value) for value in values]
    value = pd.Timestamp(values)
    if value.tzinfo is None:
        return value
    return value.tz_convert(LOCAL_TZ).tz_localize(None)


def save_plots(merged_fig):
    plot_html = merged_fig.to_html(
        full_html=False, include_plotlyjs=False, div_id="merged_plot"
    )
    plots_container = f"""<div class="plots-container">
    {plot_html}
</div>"""

    filename = "Meteostat_and_openweathermap_plots_only.html"
    with open(filename, "w", encoding="utf-8") as f:
        f.write(plots_container)
    print(f"Saved merged plot to {filename}")


def get_historical_data_dwd(lat, lon, start_date, end_date):
    """
    Get historical weather data from Open-Meteo (DWD) API
    """
    cache_session = requests_cache.CachedSession(".cache", expire_after=-1)
    retry_session = retry(cache_session, retries=5, backoff_factor=0.2)
    openmeteo = openmeteo_requests.Client(session=retry_session)

    url = "https://archive-api.open-meteo.com/v1/archive"
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start_date.strftime("%Y-%m-%d"),
        "end_date": end_date.strftime("%Y-%m-%d"),
        "hourly": [
            "temperature_2m",
            "precipitation",
            "wind_speed_10m",
            "wind_speed_100m",
            "relative_humidity_2m",
            "surface_pressure",
            "cloudcover_low",
            "cloudcover_mid",
            "cloudcover_high",
            "wind_gusts_10m",
            "wind_direction_10m",
        ],
    }
    responses = openmeteo.weather_api(url, params=params)

    response = responses[0]
    print(f"Historical Coordinates: {response.Latitude()}°N {response.Longitude()}°E")
    print(f"Elevation: {response.Elevation()} m asl")

    hourly = response.Hourly()
    hourly_temperature_2m = hourly.Variables(0).ValuesAsNumpy()
    hourly_precipitation = hourly.Variables(1).ValuesAsNumpy()
    hourly_wind_speed_10m = hourly.Variables(2).ValuesAsNumpy()
    hourly_relative_humidity_2m = hourly.Variables(4).ValuesAsNumpy()
    hourly_surface_pressure = hourly.Variables(5).ValuesAsNumpy()
    hourly_cloudcover_low = hourly.Variables(6).ValuesAsNumpy()
    hourly_cloudcover_mid = hourly.Variables(7).ValuesAsNumpy()
    hourly_cloudcover_high = hourly.Variables(8).ValuesAsNumpy()
    hourly_wind_gusts_10m = hourly.Variables(9).ValuesAsNumpy()
    hourly_wind_direction_10m = hourly.Variables(10).ValuesAsNumpy()

    hourly_data = {
        "date": pd.date_range(
            start=pd.to_datetime(hourly.Time(), unit="s", utc=True),
            end=pd.to_datetime(hourly.TimeEnd(), unit="s", utc=True),
            freq=pd.Timedelta(seconds=hourly.Interval()),
            inclusive="left",
        ),
        "temp": hourly_temperature_2m,
        "prcp": hourly_precipitation,
        "wspd": hourly_wind_speed_10m,  # Open-Meteo already answers in km/h
        "wgst": hourly_wind_gusts_10m,
        "wdir": hourly_wind_direction_10m,
        "rhum": hourly_relative_humidity_2m,
        "pres": hourly_surface_pressure,
        "cloud_low": hourly_cloudcover_low,
        "cloud_mid": hourly_cloudcover_mid,
        "cloud_high": hourly_cloudcover_high,
    }

    df = pd.DataFrame(data=hourly_data)
    df.set_index("date", inplace=True)

    return df


def get_forecast_data_dwd(lat, lon):
    """
    Get forecast weather data from Open-Meteo (DWD) API
    """
    cache_session = requests_cache.CachedSession(".cache", expire_after=3600)
    retry_session = retry(cache_session, retries=5, backoff_factor=0.2)
    openmeteo = openmeteo_requests.Client(session=retry_session)

    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": [
            "temperature_2m",
            "wind_speed_10m",
            "wind_speed_80m",
            "precipitation_probability",
            "precipitation",
            "relative_humidity_2m",
            "surface_pressure",
            "cloud_cover_low",
            "cloud_cover_mid",
            "cloud_cover_high",
            "wind_gusts_10m",
            "wind_direction_10m",
        ],
    }
    responses = openmeteo.weather_api(url, params=params)

    response = responses[0]
    print(f"Forecast Coordinates: {response.Latitude()}°N {response.Longitude()}°E")

    hourly = response.Hourly()
    hourly_temperature_2m = hourly.Variables(0).ValuesAsNumpy()
    hourly_wind_speed_10m = hourly.Variables(1).ValuesAsNumpy()
    hourly_precipitation_probability = hourly.Variables(3).ValuesAsNumpy()
    hourly_precipitation = hourly.Variables(4).ValuesAsNumpy()
    hourly_relative_humidity_2m = hourly.Variables(5).ValuesAsNumpy()
    hourly_surface_pressure = hourly.Variables(6).ValuesAsNumpy()
    hourly_cloud_cover_low = hourly.Variables(7).ValuesAsNumpy()
    hourly_cloud_cover_mid = hourly.Variables(8).ValuesAsNumpy()
    hourly_cloud_cover_high = hourly.Variables(9).ValuesAsNumpy()
    hourly_wind_gusts_10m = hourly.Variables(10).ValuesAsNumpy()
    hourly_wind_direction_10m = hourly.Variables(11).ValuesAsNumpy()

    timestamps = pd.date_range(
        start=pd.to_datetime(hourly.Time(), unit="s", utc=True),
        end=pd.to_datetime(hourly.TimeEnd(), unit="s", utc=True),
        freq=pd.Timedelta(seconds=hourly.Interval()),
        inclusive="left",
    )

    # Convert to lists matching the old format
    temps = hourly_temperature_2m.tolist()
    humiditys = hourly_relative_humidity_2m.tolist()
    wind_speeds = hourly_wind_speed_10m.tolist()  # Open-Meteo already answers in km/h
    timestamps = timestamps.tolist()
    rain_probabs = (hourly_precipitation_probability).tolist()
    rains = hourly_precipitation.tolist()
    pressures = hourly_surface_pressure.tolist()
    clounds_low = hourly_cloud_cover_low.tolist()
    clounds_mid = hourly_cloud_cover_mid.tolist()
    clounds_high = hourly_cloud_cover_high.tolist()
    wind_gusts = hourly_wind_gusts_10m.tolist()
    wind_dirs = hourly_wind_direction_10m.tolist()

    return (
        temps,
        humiditys,
        wind_speeds,
        timestamps,
        rain_probabs,
        rains,
        pressures,
        clounds_low,
        clounds_mid,
        clounds_high,
        wind_gusts,
        wind_dirs,
    )


def power_forecast(df_weather, hubheight, max_power, scale_turbine_to, turb_type):
    # specification of wind turbine
    windpowerlib_turbine = {
        "nominal_power": max_power * 1000,  # in W
        "turbine_type": turb_type,
        "hub_height": hubheight,  # in m
    }
    # initialize WindTurbine object
    wpl_turbine = WindTurbine(**windpowerlib_turbine)

    # scale turbine to the given value
    if scale_turbine_to is not None:
        wpl_turbine.power_curve["value"] = (
            wpl_turbine.power_curve["value"]
            * scale_turbine_to
            * 1000
            / max(wpl_turbine.power_curve["value"])
        )

    # own specifications for ModelChain setup
    modelchain_data = {
        "wind_speed_model": "logarithmic",
        "density_model": "barometric",
        "temperature_model": "linear_gradient",
        "power_output_model": "power_curve",
        "density_correction": False,
        "obstacle_height": 0,
        "hellman_exp": None,
    }

    # initialize ModelChain and calculate power output
    mc_wpl_turbine = ModelChain(wpl_turbine, **modelchain_data).run_model(df_weather)
    wpl_turbine.power_output = mc_wpl_turbine.power_output

    return wpl_turbine


def create_df_weather(dates, wind_10m, temp2m, surf_pres, roughnesslength):
    # create a dictionary with the variables
    data_dict = {
        "wind_speed_10m": wind_10m,
        "fsr": np.ones(len(wind_10m)) * roughnesslength,
        "t2m": temp2m,
        "sp": surf_pres,
    }

    # create a pandas DataFrame with the dictionary
    df_weather = pd.DataFrame(data_dict, index=dates)
    # create the MultiIndex columns
    col_dict = {
        ("wind_speed", 10): ("wind_speed_10m", "wind_speed"),
        ("roughness_length", 0): ("fsr", "roughness_length"),
        ("temperature", 2): ("t2m", "2mtemperature"),
        ("pressure", 0): ("sp", "pressure"),
    }
    df_weather.columns = pd.MultiIndex.from_tuples(
        col_dict.keys(), names=["variable_name", "height"]
    )
    df_weather = df_weather.rename(columns=col_dict)

    # Check if index is already timezone-aware
    if df_weather.index.tz is None:
        df_weather.index = (
            pd.to_datetime(df_weather.index)
            .tz_localize("UTC")
            .tz_convert(LOCAL_TZ)
        )
    else:
        df_weather.index = pd.to_datetime(df_weather.index).tz_convert(LOCAL_TZ)

    return df_weather


def process_pv_weather_data(
    df_weather, latitude, longitude, tilt, azimuth, system_size
):
    """Process weather data for PV power calculation"""
    # Convert time column to datetime format and ensure timezone awareness
    df_weather["datetime"] = pd.to_datetime(df_weather["datetime"], utc=True)

    # Set location parameters
    location = pvlib.location.Location(latitude=latitude, longitude=longitude)

    # Solar position
    solpos = location.get_solarposition(df_weather["datetime"])
    solpos = solpos.set_index(df_weather.index)

    # Filter daylight hours
    df_daylight = df_weather[df_weather["ghi"] > 10].copy()
    solpos_daylight = solpos.loc[df_daylight.index]

    # Calculate total irradiance
    total_irradiance_daylight = pvlib.irradiance.get_total_irradiance(
        surface_tilt=tilt,
        surface_azimuth=azimuth,
        dni=df_daylight["dni"],
        ghi=df_daylight["ghi"],
        dhi=df_daylight["dhi"],
        solar_zenith=solpos_daylight["apparent_zenith"],
        solar_azimuth=solpos_daylight["azimuth"],
    )

    poa_irradiance_daylight = total_irradiance_daylight["poa_global"]

    # Calculate module temperature
    thermal_params = pvlib.temperature.TEMPERATURE_MODEL_PARAMETERS["sapm"][
        "open_rack_glass_glass"
    ]
    temp_module_daylight = pvlib.temperature.sapm_cell(
        poa_global=poa_irradiance_daylight,
        temp_air=df_daylight["temp_air"],
        wind_speed=df_daylight["wind_speed"],
        **thermal_params,
    )

    # Define PV system parameters
    module_parameters = {
        "pdc0": system_size,
        "gamma_pdc": -0.004,
    }
    inverter_parameters = {
        "pdc0": system_size,
        "eta_inv_nom": 0.96,
    }

    # Create PVSystem object
    pv_system = pvlib.pvsystem.PVSystem(
        surface_tilt=tilt,
        surface_azimuth=azimuth,
        module_parameters=module_parameters,
        inverter_parameters=inverter_parameters,
    )

    # Calculate DC power output
    dc_power_daylight = pv_system.pvwatts_dc(
        g_poa_effective=poa_irradiance_daylight, temp_cell=temp_module_daylight
    )

    # Apply inverter efficiency
    inverter_efficiency = 0.96
    ac_power_daylight = dc_power_daylight * inverter_efficiency

    # Add AC power to DataFrame
    df_weather["AC Power (kW)"] = np.nan
    df_weather.loc[df_daylight.index, "AC Power (kW)"] = ac_power_daylight / 1000
    df_weather.fillna(0, inplace=True)

    return df_weather


def get_pv_data_from_openmeteo(lat, lon, start_date, end_date):
    """Fetch PV-relevant data from Open-Meteo"""
    cache_session = requests_cache.CachedSession(".cache", expire_after=3600)
    retry_session = retry(cache_session, retries=5, backoff_factor=0.2)
    openmeteo = openmeteo_requests.Client(session=retry_session)

    # Fetch historical data
    archive_url = "https://archive-api.open-meteo.com/v1/archive"
    archive_params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start_date.strftime("%Y-%m-%d"),
        "end_date": end_date.strftime("%Y-%m-%d"),
        "hourly": [
            "temperature_2m",
            "wind_speed_10m",
            "shortwave_radiation",
            "diffuse_radiation",
            "direct_normal_irradiance",
        ],
        "wind_speed_unit": "ms",
    }
    archive_responses = openmeteo.weather_api(archive_url, params=archive_params)
    archive_response = archive_responses[0]
    archive_hourly = archive_response.Hourly()

    # Convert to DataFrame
    archive_hourly_data = {
        "datetime": pd.date_range(
            start=pd.to_datetime(archive_hourly.Time(), unit="s", utc=True),
            end=pd.to_datetime(archive_hourly.TimeEnd(), unit="s", utc=True),
            freq=pd.Timedelta(seconds=archive_hourly.Interval()),
            inclusive="left",
        ),
        "temp_air": archive_hourly.Variables(0).ValuesAsNumpy(),
        "wind_speed": archive_hourly.Variables(1).ValuesAsNumpy(),
        "ghi": archive_hourly.Variables(2).ValuesAsNumpy(),
        "dhi": archive_hourly.Variables(3).ValuesAsNumpy(),
        "dni": archive_hourly.Variables(4).ValuesAsNumpy(),
    }

    df_archive = pd.DataFrame(archive_hourly_data)
    df_archive["datetime"] = pd.to_datetime(df_archive["datetime"], utc=True)

    return df_archive


def get_pv_forecast_from_openmeteo(lat, lon):
    """Fetch PV forecast data from Open-Meteo"""
    cache_session = requests_cache.CachedSession(".cache", expire_after=3600)
    retry_session = retry(cache_session, retries=5, backoff_factor=0.2)
    openmeteo = openmeteo_requests.Client(session=retry_session)

    forecast_url = "https://api.open-meteo.com/v1/forecast"
    forecast_params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": ["temperature_2m", "wind_speed_10m"],
        "minutely_15": [
            "shortwave_radiation",
            "diffuse_radiation",
            "direct_normal_irradiance",
        ],
        "wind_speed_unit": "ms",
        "models": "icon_seamless",
    }
    forecast_responses = openmeteo.weather_api(forecast_url, params=forecast_params)
    forecast_response = forecast_responses[0]
    forecast_minutely_15 = forecast_response.Minutely15()
    forecast_hourly = forecast_response.Hourly()

    # Convert forecast data
    forecast_minutely_15_data = {
        "datetime": pd.date_range(
            start=pd.to_datetime(forecast_minutely_15.Time(), unit="s", utc=True),
            end=pd.to_datetime(forecast_minutely_15.TimeEnd(), unit="s", utc=True),
            freq=pd.Timedelta(seconds=forecast_minutely_15.Interval()),
            inclusive="left",
        ),
        "dni": forecast_minutely_15.Variables(0).ValuesAsNumpy(),
        "ghi": forecast_minutely_15.Variables(1).ValuesAsNumpy(),
        "dhi": forecast_minutely_15.Variables(2).ValuesAsNumpy(),
    }
    forecast_hourly_data = {
        "datetime": pd.date_range(
            start=pd.to_datetime(forecast_hourly.Time(), unit="s", utc=True),
            end=pd.to_datetime(forecast_hourly.TimeEnd(), unit="s", utc=True),
            freq=pd.Timedelta(seconds=forecast_hourly.Interval()),
            inclusive="left",
        ),
        "temp_air": forecast_hourly.Variables(0).ValuesAsNumpy(),
        "wind_speed": forecast_hourly.Variables(1).ValuesAsNumpy(),
    }

    df_forecast_minutely_15 = pd.DataFrame(forecast_minutely_15_data)
    df_forecast_hourly = pd.DataFrame(forecast_hourly_data)

    # Process forecast data
    df_forecast_hourly["datetime"] = pd.to_datetime(
        df_forecast_hourly["datetime"], utc=True
    )
    df_forecast_hourly.set_index("datetime", inplace=True)
    df_forecast_minutely_15["datetime"] = pd.to_datetime(
        df_forecast_minutely_15["datetime"], utc=True
    )
    df_forecast_minutely_15.set_index("datetime", inplace=True)

    # Resample and merge
    df_forecast_hourly_resampled = df_forecast_hourly.resample("15T").interpolate()
    df_weather_forecast = df_forecast_minutely_15.merge(
        df_forecast_hourly_resampled, left_index=True, right_index=True, how="left"
    )
    df_weather_forecast.reset_index(inplace=True)

    return df_weather_forecast


def filter_forecast_data(
    temps,
    humiditys,
    wind_speeds,
    timestamps,
    rain_probabs,
    rains,
    pressures,
    clouds_low,
    clouds_mid,
    clouds_high,
    wind_gusts,
    wind_dirs,
    first_date_dt,
    end_date_dt,
):
    """
    Filter forecast data to fit within the specified date range.

    Args:
        temps, humiditys, wind_speeds, timestamps, rain_probabs, rains, pressures: Forecast data lists
        first_date_dt: Start datetime
        end_date_dt: End date

    Returns:
        Filtered tuples of all data
    """
    if not timestamps:
        return ([],) * 12

    # Convert timestamps to datetime objects for comparison
    dt_timestamps = [pd.to_datetime(ts) for ts in timestamps]

    # Create end datetime at end of day
    end_datetime = datetime.combine(end_date_dt, datetime.max.time()).replace(
        tzinfo=dt_timestamps[0].tzinfo
    )

    # Create a list of indices that fall within the date range
    valid_indices = [
        i
        for i, dt in enumerate(dt_timestamps)
        if first_date_dt.replace(tzinfo=dt.tzinfo) <= dt <= end_datetime
    ]

    # If no valid indices, return empty lists
    if not valid_indices:
        print(
            f"Warning: No forecast data found in range {first_date_dt} to {end_date_dt}"
        )
        return ([],) * 12

    # Filter all lists using valid indices
    filtered_temps = [temps[i] for i in valid_indices]
    filtered_humiditys = [humiditys[i] for i in valid_indices]
    filtered_wind_speeds = [wind_speeds[i] for i in valid_indices]
    filtered_timestamps = [timestamps[i] for i in valid_indices]
    filtered_rain_probabs = [rain_probabs[i] for i in valid_indices]
    filtered_rains = [rains[i] for i in valid_indices]
    filtered_pressures = [pressures[i] for i in valid_indices]
    filtered_clouds_low = [clouds_low[i] for i in valid_indices]
    filtered_clouds_mid = [clouds_mid[i] for i in valid_indices]
    filtered_clouds_high = [clouds_high[i] for i in valid_indices]
    filtered_wind_gusts = [wind_gusts[i] for i in valid_indices]
    filtered_wind_dirs = [wind_dirs[i] for i in valid_indices]

    print(
        f"Filtered forecast data: {len(valid_indices)} records from {filtered_timestamps[0]} to {filtered_timestamps[-1]}"
    )

    return (
        filtered_temps,
        filtered_humiditys,
        filtered_wind_speeds,
        filtered_timestamps,
        filtered_rain_probabs,
        filtered_rains,
        filtered_pressures,
        filtered_clouds_low,
        filtered_clouds_mid,
        filtered_clouds_high,
        filtered_wind_gusts,
        filtered_wind_dirs,
    )


def create_continuous_timeline(first_date_dt, end_date_dt, freq="H"):
    """
    Create a continuous timeline DataFrame from start to end date.

    Args:
        first_date_dt: Start datetime
        end_date_dt: End date
        freq: Frequency ('H' for hourly)

    Returns:
        DataFrame with continuous datetime index
    """
    end_datetime = datetime.combine(end_date_dt, datetime.max.time())
    timeline = pd.date_range(start=first_date_dt, end=end_datetime, freq=freq)
    df = pd.DataFrame(index=timeline)
    return df


def merge_and_calculate_power(
    data_hourly_dwd,
    forecast_data,
    hubheight,
    max_power,
    scale_turbine_to,
    turb_type,
    roughnesslength,
):
    """
    Merge historical and forecast data, then calculate wind power for the combined dataset.
    """
    (
        temps,
        humiditys,
        wind_speeds,
        timestamps,
        rain_probabs,
        rains,
        pressures,
        clouds_low,
        clouds_mid,
        clouds_high,
        wind_gusts,
        wind_dirs,
    ) = forecast_data

    # Calculate wind power for past (only if data exists)
    if not data_hourly_dwd.empty and "wspd" in data_hourly_dwd.columns:
        dates_past = data_hourly_dwd.index
        wind_10m_past = data_hourly_dwd["wspd"].values / 3.6
        temp2m_past = data_hourly_dwd["temp"].values
        surf_pres_past = data_hourly_dwd["pres"].values

        df_weather_past = create_df_weather(
            dates_past, wind_10m_past, temp2m_past, surf_pres_past, roughnesslength
        )
        power_turbine_past = power_forecast(
            df_weather_past, hubheight, max_power, scale_turbine_to, turb_type
        )
        data_hourly_dwd["power"] = power_turbine_past.power_output.values / 1000
    else:
        print("No historical data available for wind power calculation")

    # Calculate wind power for future (only if data exists)
    if timestamps and len(timestamps) > 0:
        dates_future = timestamps
        wind_10m_future = [s / 3.6 for s in wind_speeds]
        temp2m_future = temps
        surf_pres_future = pressures

        df_weather_future = create_df_weather(
            dates_future,
            wind_10m_future,
            temp2m_future,
            surf_pres_future,
            roughnesslength,
        )
        power_turbine_future = power_forecast(
            df_weather_future, hubheight, max_power, scale_turbine_to, turb_type
        )
        power_future_plt = power_turbine_future.power_output / 1000
    else:
        print("No forecast data available for wind power calculation")
        power_future_plt = pd.Series()

    return data_hourly_dwd, power_future_plt


WIND_ARROW_STEP = 3  # hours between wind direction arrows, so they stay apart on a phone


def add_wind_arrows(fig, row, timestamps, directions, y, name, showlegend):
    """Mark the wind direction along the top of a panel, one arrow every few hours.

    Open-Meteo reports the direction the wind comes FROM, so the arrows are turned around:
    they point the way the wind blows, a northerly pointing down the panel.
    """
    picked = range(0, len(timestamps), WIND_ARROW_STEP)
    fig.add_trace(
        go.Scatter(
            x=[timestamps[i] for i in picked],
            y=[y] * len(list(picked)),
            mode="markers",
            marker=dict(
                symbol="arrow",
                size=9,
                color="red",
                angle=[(float(directions[i]) + 180) % 360 for i in picked],
            ),
            name=name,
            legendgroup="wind_direction",
            showlegend=showlegend,
            customdata=[round(float(directions[i])) for i in picked],
            hovertemplate="wind from %{customdata}\u00b0<extra></extra>",
        ),
        row=row,
        col=1,
        secondary_y=True,
    )


CLOUD_BANDS = ("cloud_low", "cloud_mid", "cloud_high")
CLOUD_BAND_HEIGHT = 100  # each layer gets its own 0-100% slot on the cloud axis


def add_cloud_bands(fig, row, timestamps, coverages):
    """Draw hourly cloud cover as grey boxes, denser cover being brighter and more opaque.

    The three layers are stacked on the panel's secondary y axis, low at the bottom and high
    at the top. Each one keeps its own 0-100% slot there, so the clouds are read off their
    own scale instead of sharing the one the data on the primary axis uses.
    """
    for band, coverage in enumerate(coverages):
        base = band * CLOUD_BAND_HEIGHT
        for i in range(len(timestamps) - 1):
            cover = float(coverage[i])
            if cover <= 0:
                continue
            top = base + cover
            opacity = 0.02 + (cover / 100) * 0.5
            grey = int(60 + (cover / 100) * 195)
            edge = min(grey + 20, 255)
            fig.add_trace(
                go.Scatter(
                    x=[
                        timestamps[i],
                        timestamps[i + 1],
                        timestamps[i + 1],
                        timestamps[i],
                    ],
                    y=[base, base, top, top],
                    fill="toself",
                    fillcolor=f"rgba({grey}, {grey}, {grey}, {opacity})",
                    line=dict(
                        width=0.5,
                        color=f"rgba({edge}, {edge}, {edge}, {opacity * 0.6})",
                    ),
                    showlegend=False,
                    hoverinfo="skip",
                ),
                row=row,
                col=1,
                secondary_y=True,
            )


def create_merged_plot(
    data_hourly_dwd,
    forecast_data,
    power_future_plt,
    df_pv_past_processed,
    df_pv_forecast_processed,
    location,
    lat,
    lon,
    pv_system_size_kWp,
):
    """
    Create a single merged plot showing both historical and forecast data
    with a red dashed line separating past from future.
    """
    (
        temps,
        humiditys,
        wind_speeds,
        timestamps,
        rain_probabs,
        rains,
        pressures,
        clouds_low,
        clouds_mid,
        clouds_high,
        wind_gusts,
        wind_dirs,
    ) = forecast_data

    # Put every series on the same clock before anything is compared or plotted: the weather
    # comes back from Open-Meteo in UTC, the PV and wind power series are calculated in local
    # time, and Plotly.js would plot each of them at its own face value. See to_local_time().
    timestamps = to_local_time(timestamps)
    if data_hourly_dwd is not None and not data_hourly_dwd.empty:
        data_hourly_dwd = data_hourly_dwd.set_axis(to_local_time(data_hourly_dwd.index))
    if power_future_plt is not None and not power_future_plt.empty:
        power_future_plt = power_future_plt.set_axis(to_local_time(power_future_plt.index))
    if df_pv_past_processed is not None:
        df_pv_past_processed = df_pv_past_processed.assign(
            datetime=to_local_time(df_pv_past_processed["datetime"])
        )
    if df_pv_forecast_processed is not None:
        df_pv_forecast_processed = df_pv_forecast_processed.assign(
            datetime=to_local_time(df_pv_forecast_processed["datetime"])
        )

    # Get the transition point (current time or first forecast timestamp)
    transition_time = to_local_time(datetime.now().astimezone())
    # remove data from df_pv_forecast_processed which is before transition_time
    if df_pv_forecast_processed is not None:
        df_pv_forecast_processed = df_pv_forecast_processed[
            df_pv_forecast_processed["datetime"] >= transition_time
        ]
    if df_pv_past_processed is not None:
        df_pv_past_processed = df_pv_past_processed[
            df_pv_past_processed["datetime"] < transition_time
        ]
    if power_future_plt is not None and not power_future_plt.empty:
        power_future_plt = power_future_plt[power_future_plt.index >= transition_time]

    if data_hourly_dwd is not None and not data_hourly_dwd.empty:
        data_hourly_dwd = data_hourly_dwd[data_hourly_dwd.index < transition_time]
    if forecast_data is not None and timestamps:
        # Find index where timestamps >= transition_time
        idx = next(
            (i for i, ts in enumerate(timestamps) if ts >= transition_time),
            len(timestamps),
        )
        # Slice all forecast data lists from idx
        temps = temps[idx:]
        humiditys = humiditys[idx:]
        wind_speeds = wind_speeds[idx:]
        timestamps = timestamps[idx:]
        rain_probabs = rain_probabs[idx:]
        rains = rains[idx:]
        pressures = pressures[idx:]
        clouds_low = clouds_low[idx:]
        clouds_mid = clouds_mid[idx:]
        clouds_high = clouds_high[idx:]
        wind_gusts = wind_gusts[idx:]
        wind_dirs = wind_dirs[idx:]

    fig = make_subplots(
        rows=3,
        cols=1,
        shared_xaxes=True,
        # room for a row of date tick labels in each gap between the subplots
        vertical_spacing=0.07,
        specs=[
            [{"secondary_y": True}],
            [{"secondary_y": True}],
            [{"secondary_y": True}],
        ],
    )

    # ========== ROW 1: Temperature and Humidity ==========
    # Past data
    fig.add_trace(
        go.Scatter(
            x=data_hourly_dwd.index,
            y=data_hourly_dwd["temp"],
            name="Temperature (Past)",
            marker=dict(color="orange"),
            line=dict(width=2),
        ),
        row=1,
        col=1,
    )
    # Future data
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=temps,
            name="Temperature (Forecast)",
            marker=dict(color="orange"),
            line=dict(width=2, dash="dash"),
        ),
        row=1,
        col=1,
    )

    # Humidity - Past
    fig.add_trace(
        go.Scatter(
            x=data_hourly_dwd.index,
            y=data_hourly_dwd["rhum"],
            name="Humidity (Past)",
            line=dict(width=1, dash="dot"),
            marker=dict(color="lightgrey"),
        ),
        row=1,
        col=1,
        secondary_y=True,
    )
    # Humidity - Future
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=humiditys,
            name="Humidity (Forecast)",
            line=dict(width=1, dash="dot"),
            marker=dict(color="lightgrey"),
        ),
        row=1,
        col=1,
        secondary_y=True,
    )

    fig.update_yaxes(
        title_text="Temperature (°C)",
        secondary_y=False,
        gridcolor="grey",
        gridwidth=1,
        row=1,
        col=1,
    )
    fig.update_yaxes(
        title_text="Humidity (%)",
        secondary_y=True,
        row=1,
        col=1,
        gridcolor="grey",
        gridwidth=1,
        griddash="dash",
    )

    # ========== ROW 2: Precipitation and Wind ==========
    # Calculate max precipitation from both past and future
    max_past = data_hourly_dwd["prcp"].max()
    max_future = max(rains) if rains else 0
    max_precip = max(max_past, max_future)
    y_range = [0, 1] if max_precip < 1 else [0, max_precip]

    # Past precipitation
    fig.add_trace(
        go.Bar(
            x=data_hourly_dwd.index,
            y=data_hourly_dwd["prcp"],
            name="Precipitation (Past)",
            marker=dict(color="blue"),
            opacity=0.9,
            zorder=2,
        ),
        row=2,
        col=1,
    )
    # Future precipitation
    fig.add_trace(
        go.Bar(
            x=timestamps,
            y=rains,
            name="Precipitation (Forecast)",
            marker=dict(color="cyan"),
            opacity=0.9,
            zorder=2,
        ),
        row=2,
        col=1,
    )

    # Past wind
    fig.add_trace(
        go.Scatter(
            x=data_hourly_dwd.index,
            y=data_hourly_dwd["wspd"],
            name="Wind 10m (Past)",
            opacity=1,
            line=dict(width=1.2),
            marker=dict(color="red"),
        ),
        row=2,
        col=1,
        secondary_y=True,
    )
    # Future wind
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=wind_speeds,
            name="Wind 10m (Forecast)",
            opacity=1,
            line=dict(width=1.2, dash="dash"),
            marker=dict(color="red"),
        ),
        row=2,
        col=1,
        secondary_y=True,
    )

    # Gusts next to the wind they belong to, in a lighter red
    fig.add_trace(
        go.Scatter(
            x=data_hourly_dwd.index,
            y=data_hourly_dwd["wgst"],
            name="Gusts (Past)",
            opacity=1,
            line=dict(width=1),
            marker=dict(color="lightcoral"),
        ),
        row=2,
        col=1,
        secondary_y=True,
    )
    fig.add_trace(
        go.Scatter(
            x=timestamps,
            y=wind_gusts,
            name="Gusts (Forecast)",
            opacity=1,
            line=dict(width=1, dash="dash"),
            marker=dict(color="lightcoral"),
        ),
        row=2,
        col=1,
        secondary_y=True,
    )

    # Wind direction rides in the headroom above the curves
    wind_values = [
        value
        for value in (
            list(data_hourly_dwd["wspd"].values)
            + list(data_hourly_dwd["wgst"].values)
            + list(wind_speeds)
            + list(wind_gusts)
        )
        if pd.notna(value)
    ]
    wind_axis_max = (max(wind_values) if wind_values else 10) * 1.25
    arrow_y = wind_axis_max * 0.93
    if len(data_hourly_dwd) > 0 and "wdir" in data_hourly_dwd.columns:
        add_wind_arrows(
            fig,
            2,
            data_hourly_dwd.index.tolist(),
            data_hourly_dwd["wdir"].values,
            arrow_y,
            "Wind direction",
            True,
        )
    if timestamps and wind_dirs:
        add_wind_arrows(
            fig, 2, timestamps, wind_dirs, arrow_y, "Wind direction", False
        )

    # Add precipitation probability annotations for forecast
    for i in range(len(rain_probabs)):
        if rain_probabs[i] > 4:
            fig.add_annotation(
                x=timestamps[i],
                y=rains[i],
                text=str(int(round(rain_probabs[i]))) + "%",
                showarrow=False,
                font=dict(color="black", size=8),
                bgcolor="rgba(0, 255, 255, 0.8)",
                bordercolor="cyan",
                borderwidth=1,
                textangle=-90,
                yshift=10,
                # xshift=10,
                row=2,
                col=1,
            )

    fig.update_yaxes(
        title_text="Precipitation (mm)",
        secondary_y=False,
        gridcolor="grey",
        gridwidth=1,
        range=y_range,
        row=2,
        col=1,
    )
    fig.update_yaxes(
        title_text="Wind / gusts (km/h)",
        secondary_y=True,
        row=2,
        col=1,
        range=[0, wind_axis_max],
        gridcolor="grey",
        gridwidth=1,
        griddash="dash",
    )

    # Add vertical grid lines to subplot 2
    fig.update_xaxes(
        showgrid=True,
        gridcolor="grey",
        gridwidth=1,
        row=2,
        col=1,
    )

    # ========== ROW 3: Clouds and PV ==========
    # PV is drawn per kWp installed, so the panel always reads 0..1 and can be read together
    # with the cloud cover behind it as "how much sun is there".
    pv_past_yield = (
        df_pv_past_processed["AC Power (kW)"] / pv_system_size_kWp
        if df_pv_past_processed is not None
        else pd.Series(dtype=float)
    )
    pv_forecast_yield = (
        df_pv_forecast_processed["AC Power (kW)"] / pv_system_size_kWp
        if df_pv_forecast_processed is not None
        else pd.Series(dtype=float)
    )
    pv_axis_max = max(
        1.0,
        pv_past_yield.max() if not pv_past_yield.empty else 0,
        pv_forecast_yield.max() if not pv_forecast_yield.empty else 0,
    )

    # Clouds first so the PV curves are drawn on top of them
    if (
        data_hourly_dwd is not None
        and len(data_hourly_dwd) > 0
        and "cloud_low" in data_hourly_dwd.columns
    ):
        add_cloud_bands(
            fig,
            3,
            data_hourly_dwd.index.tolist(),
            [data_hourly_dwd[band].values for band in CLOUD_BANDS],
        )
    if len(timestamps) > 0 and (clouds_low or clouds_mid or clouds_high):
        add_cloud_bands(fig, 3, timestamps, [clouds_low, clouds_mid, clouds_high])

    # Dashed lines where one cloud layer ends and the next starts
    for boundary in range(1, len(CLOUD_BANDS)):
        fig.add_hline(
            y=boundary * CLOUD_BAND_HEIGHT,
            line_width=1,
            line_dash="dash",
            line_color="grey",
            row=3,
            col=1,
            secondary_y=True,
        )

    # Past PV Power
    if df_pv_past_processed is not None:
        fig.add_trace(
            go.Scatter(
                x=df_pv_past_processed["datetime"],
                y=pv_past_yield,
                name="PV Power (Past)",
                marker=dict(color="yellow"),
                line=dict(width=2),
            ),
            row=3,
            col=1,
        )

    # Future PV Power
    if df_pv_forecast_processed is not None:
        fig.add_trace(
            go.Scatter(
                x=df_pv_forecast_processed["datetime"],
                y=pv_forecast_yield,
                name="PV Power (Forecast)",
                marker=dict(color="gold"),
                line=dict(width=2, dash="dash"),
            ),
            row=3,
            col=1,
        )

    # Wind power is parked for now - it says little next to the wind speed in row 2.
    # # Past Wind Power
    # fig.add_trace(
    #     go.Scatter(
    #         x=data_hourly_dwd.index,
    #         y=data_hourly_dwd["power"],
    #         name="Wind Power (Past)",
    #         marker=dict(color="cyan"),
    #         line=dict(width=2),
    #     ),
    #     row=3,
    #     col=1,
    #     secondary_y=True,
    # )
    #
    # # Future Wind Power
    # fig.add_trace(
    #     go.Scatter(
    #         x=timestamps,
    #         y=power_future_plt,
    #         name="Wind Power (Forecast)",
    #         marker=dict(color="cyan"),
    #         line=dict(width=2, dash="dash"),
    #     ),
    #     row=3,
    #     col=1,
    #     secondary_y=True,
    # )

    fig.update_yaxes(
        title_text="PV (kW per kWp)",
        gridcolor="grey",
        gridwidth=1,
        range=[0, pv_axis_max],
        row=3,
        col=1,
        secondary_y=False,
    )
    # The cloud axis is labelled per layer rather than per percent: the ticks sit in the
    # middle of each band, between the dashed lines that separate them.
    fig.update_yaxes(
        title_text="Clouds",
        range=[0, len(CLOUD_BANDS) * CLOUD_BAND_HEIGHT],
        tickvals=[
            (band + 0.5) * CLOUD_BAND_HEIGHT for band in range(len(CLOUD_BANDS))
        ],
        ticktext=[name.replace("cloud_", "") for name in CLOUD_BANDS],
        showgrid=False,
        row=3,
        col=1,
        secondary_y=True,
    )

    # ========== Add red dashed vertical line separating past and future ==========
    # Axis references of each subplot, for the "NOW" label that sits next to the line
    now_label_refs = {1: ("x", "y domain"), 2: ("x2", "y3 domain"), 3: ("x3", "y5 domain")}
    for row in [1, 2, 3]:
        fig.add_vline(
            x=transition_time,
            line_width=3,
            line_dash="dash",
            line_color="red",
            row=row,
            col=1,
        )
        # The label goes inside the top of the subplot: the gaps underneath carry date tick
        # labels now, which the old position (y=-0.14) would have collided with.
        xref, yref = now_label_refs[row]
        fig.add_annotation(
            x=transition_time,
            y=0.98,
            yanchor="top",
            text="NOW",
            showarrow=False,
            font=dict(color="red", size=12, family="Arial Black"),
            xref=xref,
            yref=yref,
        )

    # Date labels on every axis, so no subplot boundary is left bare. One axis can only print
    # its labels on one side, so the three subplot axes cover the figure top (subplot 1, moved
    # up by side="top"), the gap above subplot 2 and the figure bottom (subplot 3); the gap
    # above subplot 3 gets the extra overlaid axis set up below.
    fig.update_xaxes(
        side="top",
        showticklabels=True,
        showgrid=True,
        gridcolor="grey",
        gridwidth=1,
        row=1,
        col=1,
    )

    fig.update_xaxes(
        side="top",
        showticklabels=True,
        showgrid=True,
        gridcolor="grey",
        gridwidth=1,
        row=2,
        col=1,
    )

    fig.update_xaxes(
        showticklabels=True,
        showgrid=True,
        gridcolor="grey",
        gridwidth=1,
        row=3,
        col=1,
    )

    # Fourth x-axis, sharing subplot 3's plot area, purely to label the gap above it.
    # "matches" keeps it locked to the shared range when zooming or panning.
    fig.update_layout(
        xaxis4=dict(
            overlaying="x3",
            matches="x3",
            # without an explicit anchor the axis defaults to the first subplot and ends up
            # drawn at the top of the figure
            anchor="y5",
            side="top",
            showticklabels=True,
            showgrid=False,
            ticks="outside",
        )
    )
    # Plotly only draws an axis that a trace refers to, hence this invisible anchor point.
    # Note the axes are set explicitly: passing row/col would reassign it to x3.
    fig.add_trace(
        go.Scatter(
            x=[transition_time],
            y=[0],
            xaxis="x4",
            yaxis="y5",
            mode="markers",
            marker=dict(opacity=0),
            hoverinfo="skip",
            showlegend=False,
        )
    )

    # Layout settings
    fig.update_layout(
        title=f"Weather & Energy Data (DWD) - {location} - {lat} N° {lon} E°",
        height=950,
        plot_bgcolor="black",
        paper_bgcolor="black",
        font=dict(color="white"),
        showlegend=True,
        legend=dict(orientation="h", yanchor="bottom", y=-0.15, xanchor="right", x=0.9),
    )

    return fig


def main():
    # Settings
    today = datetime.today()
    days_into_past = 2
    days_into_future = 3
    first_date_default = (datetime.today() - timedelta(days=days_into_past)).strftime(
        "%Y-%m-%d"
    )

    # Parse command line arguments
    if len(sys.argv) > 1:
        parser = argparse.ArgumentParser(
            description="Get weather forecast from DWD/Open-Meteo and historical data",
        )
        parser.add_argument(
            "-l", "--location", help="Name of your location", default="FreeCity?"
        )
        parser.add_argument(
            "-lat", "--latitude", help="Latitude of location", default="47.993794"
        )
        parser.add_argument(
            "-lon", "--longitude", help="Longitude of location", default="7.840820"
        )
        parser.add_argument(
            "-f",
            "--first_date",
            help="Set first day to plot past weather (YYYY-MM-DD)",
            default=first_date_default,
        )
        parser.add_argument(
            "-t",
            "--turbine_power_kW",
            help="Set turbine power in kW",
            default=1000,
        )
        parser.add_argument(
            "-pv",
            "--PV_power_kWp",
            help="Set PV system size in kWp",
            default=1000,
        )

        args = parser.parse_args()
        location = args.location
        lat = args.latitude
        lon = args.longitude
        first_date_dt = datetime.strptime(args.first_date, "%Y-%m-%d")
        end_date_dt = datetime.today().date() + timedelta(days=days_into_future)
        wind_turbine_power_kW = int(args.turbine_power_kW)
        pv_system_size_kWp = int(args.PV_power_kWp)

    else:
        # No command line arguments - use defaults
        location = "KYOLO"
        lat = "47.993794"
        lon = "7.840820"
        first_date_dt = datetime.today() - timedelta(days=days_into_past)
        end_date_dt = datetime.today().date() + timedelta(days=days_into_future)
        wind_turbine_power_kW = 1000
        pv_system_size_kWp = 1000

    print(f"\n{'='*50}")
    print(
        f"Date Range: {first_date_dt.strftime('%Y-%m-%d')} to {end_date_dt.strftime('%Y-%m-%d')}"
    )
    print(f"Location: {location} ({lat}°N, {lon}°E)")
    print(f"{'='*50}\n")

    # Get weather data from DWD
    forecast_data = get_forecast_data_dwd(float(lat), float(lon))

    # Filter forecast data to fit within the requested date range
    # This handles both past-only queries and future forecasts
    forecast_data = filter_forecast_data(*forecast_data, first_date_dt, end_date_dt)

    # Get historic data from DWD
    # Determine the end point for historical data (either end_date or today, whichever is earlier)
    historical_end = min(end_date_dt, today.date())

    # Only fetch historical data if the date range includes past dates
    if first_date_dt.date() <= historical_end:
        data_hourly_dwd = get_historical_data_dwd(
            float(lat),
            float(lon),
            first_date_dt,
            historical_end,
        )
        print(f"Fetched {len(data_hourly_dwd)} historical records")
    else:
        # If querying only future dates, create empty historical dataframe with proper columns
        data_hourly_dwd = pd.DataFrame(
            columns=["temp", "rhum", "wspd", "prcp", "pres", "power"]
        )
        print("Note: No historical data requested (start date is in the future)")

    # Wind turbine settings
    hubheight = 63
    turb_type = "E48/800"
    max_power = 600
    scale_turbine_to = wind_turbine_power_kW
    roughnesslength = 0.84

    # Calculate wind power using merged approach
    data_hourly_dwd, power_future_plt = merge_and_calculate_power(
        data_hourly_dwd,
        forecast_data,
        hubheight,
        max_power,
        scale_turbine_to,
        turb_type,
        roughnesslength,
    )

    # PV system settings
    pv_tilt = 30
    pv_azimuth = 180
    pv_system_size = pv_system_size_kWp * 1000  # Watts

    # Get PV data for past (only if historical data exists)
    if first_date_dt.date() <= historical_end:
        print("=" * 50)
        print("STARTING PV HISTORICAL DATA PROCESSING")
        print("=" * 50)
        try:
            print("Fetching PV historical data...")
            sys.stdout.flush()

            pv_end_date = datetime.combine(historical_end, datetime.max.time())

            df_pv_past = get_pv_data_from_openmeteo(
                float(lat), float(lon), first_date_dt, pv_end_date
            )

            print(f"✓ Raw PV past data fetched: {len(df_pv_past)} records")

            df_pv_past_processed = process_pv_weather_data(
                df_pv_past, float(lat), float(lon), pv_tilt, pv_azimuth, pv_system_size
            )

            df_pv_past_processed["datetime"] = df_pv_past_processed[
                "datetime"
            ].dt.tz_convert(LOCAL_TZ)

            # Filter to requested date range
            df_pv_past_processed = df_pv_past_processed[
                (
                    df_pv_past_processed["datetime"]
                    >= first_date_dt.replace(
                        tzinfo=df_pv_past_processed["datetime"].iloc[0].tzinfo
                    )
                )
                & (
                    df_pv_past_processed["datetime"]
                    <= pv_end_date.replace(
                        tzinfo=df_pv_past_processed["datetime"].iloc[0].tzinfo
                    )
                )
            ]

            print(f"✓ PV past data filtered: {len(df_pv_past_processed)} records")
            print(
                f"✓ Date range: {df_pv_past_processed['datetime'].min()} to {df_pv_past_processed['datetime'].max()}"
            )

        except Exception as e:
            print(f"✗ Error processing PV past data: {e}")
            import traceback

            traceback.print_exc()
            df_pv_past_processed = None
    else:
        print("No PV historical data requested (start date is in the future)")
        df_pv_past_processed = None

    # Get PV forecast (only if end_date is in the future)
    if end_date_dt > today.date():
        print("\n" + "=" * 50)
        print("STARTING PV FORECAST DATA PROCESSING")
        print("=" * 50)
        try:
            df_pv_forecast = get_pv_forecast_from_openmeteo(float(lat), float(lon))

            df_pv_forecast_processed = process_pv_weather_data(
                df_pv_forecast,
                float(lat),
                float(lon),
                pv_tilt,
                pv_azimuth,
                pv_system_size,
            )

            df_pv_forecast_processed["datetime"] = df_pv_forecast_processed[
                "datetime"
            ].dt.tz_convert(LOCAL_TZ)

            # Filter forecast to only show future dates
            future_start = datetime.combine(today.date(), datetime.min.time()).replace(
                tzinfo=df_pv_forecast_processed["datetime"].iloc[0].tzinfo
            )
            df_pv_forecast_processed = df_pv_forecast_processed[
                df_pv_forecast_processed["datetime"] >= future_start
            ]

            print(f"✓ PV forecast filtered: {len(df_pv_forecast_processed)} records")

        except Exception as e:
            print(f"✗ Error processing PV forecast data: {e}")
            import traceback

            traceback.print_exc()
            df_pv_forecast_processed = None
    else:
        print("No PV forecast needed (end date is not in the future)")
        df_pv_forecast_processed = None

    print("\n" + "=" * 50)
    print("CREATING MERGED PLOT")
    print("=" * 50)

    merged_fig = create_merged_plot(
        data_hourly_dwd,
        forecast_data,
        power_future_plt,
        df_pv_past_processed,
        df_pv_forecast_processed,
        location,
        lat,
        lon,
        pv_system_size_kWp,
    )

    save_plots(merged_fig)
    print("\nPV and Wind power predictions complete!")


if __name__ == "__main__":
    main()
