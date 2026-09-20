# Uberspace Server Setup Guide

Complete guide for setting up the Weather Prediction Flask application on Uberspace with custom Python 3.12 and OpenSSL.

## Table of Contents
1. [Initial Server Setup](#initial-server-setup)
2. [Install Custom OpenSSL](#install-custom-openssl)
3. [Install Custom Python 3.12](#install-custom-python-312)
4. [Configure Environment Variables](#configure-environment-variables)
5. [Setup Flask Application](#setup-flask-application)
6. [Configure Supervisord](#configure-supervisord)
7. [Setup Web Backend](#setup-web-backend)
8. [Troubleshooting](#troubleshooting)

---

## Initial Server Setup

### Connect to Uberspace
```bash
ssh username@server.uberspace.de
```

### Create necessary directories
```bash
mkdir -p ~/logs
mkdir -p ~/bin
mkdir -p ~/html/kyosky
mkdir -p ~/html/kyosky/static
```

---

## Install Custom OpenSSL

Uberspace may have an older OpenSSL version. Install a newer version locally:

```bash
cd ~
wget https://www.openssl.org/source/openssl-1.1.1w.tar.gz
tar xzf openssl-1.1.1w.tar.gz
cd openssl-1.1.1w

./config --prefix=$HOME/openssl --openssldir=$HOME/openssl shared zlib
make
make install

# Verify installation
~/openssl/bin/openssl version
```

**Expected output:** `OpenSSL 1.1.1w` (or similar version)

---

## Install Custom Python 3.12

Install Python 3.12 with custom OpenSSL support:

```bash
cd ~
wget https://www.python.org/ftp/python/3.12.0/Python-3.12.0.tgz
tar xzf Python-3.12.0.tgz
cd Python-3.12.0

# Configure with custom OpenSSL
./configure --prefix=$HOME/python312 \
    --with-openssl=$HOME/openssl \
    --enable-optimizations \
    LDFLAGS="-L$HOME/openssl/lib64 -Wl,-rpath,$HOME/openssl/lib64"

make
make install

# Verify installation
~/python312/bin/python3 --version
~/python312/bin/python3 -c "import ssl; print(ssl.OPENSSL_VERSION)"
~/python312/bin/python3 -c "import sqlite3; print(sqlite3.sqlite_version)"
```

**Expected output:**
```
Python 3.12.0
OpenSSL 1.1.1w
3.53.4
```

**If `import sqlite3` fails** with `No module named '_sqlite3'`, this build was made
without the SQLite headers. `wetterdienst` needs it (`diskcache` backs its directory
listing cache), so the radar script fails with `No module named '_sqlite3'`.
The host ships a stock CPython 3.12 with the module compiled in, and extension
modules are ABI-compatible across 3.12.x, so copy it in:

```bash
cp /usr/lib64/python3.12/lib-dynload/_sqlite3.cpython-312-x86_64-linux-gnu.so \
   ~/python312/lib/python3.12/lib-dynload/
```

Rebuilding `~/python312` drops this file — copy it again afterwards. (The stock
`/usr/bin/python3.12` has both SSL and SQLite; a future venv could just use it and
make the custom build unnecessary.)

---

## Configure Environment Variables

### Update ~/.bashrc

Add the following to your `~/.bashrc`:

```bash
nano ~/.bashrc
```

Add these lines at the end:

```bash
# Python 3.12 custom installation
export PATH="$HOME/python312/bin:$PATH"
export LD_LIBRARY_PATH="$HOME/openssl/lib64:$LD_LIBRARY_PATH"
export SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt
export SSL_CERT_DIR=/etc/pki/tls/certs

# Optional: Add bin directory for custom scripts
export PATH="$HOME/bin:$PATH"
```

Save and reload:

```bash
source ~/.bashrc
```

### Verify environment
```bash
echo $PATH
echo $LD_LIBRARY_PATH
which python3
python3 --version
```

---

## Setup Flask Application

### 1. Navigate to application directory
```bash
cd ~/html/kyosky
```

### 2. Create virtual environment with custom Python
```bash
~/python312/bin/python3 -m venv venv
source venv/bin/activate
```

### 3. Upgrade pip
```bash
python3.12 -m venv venv
source venv/bin/activate
pip install --upgrade pip setuptools wheel

### 4. Install application dependencies
python3.12 -m venv venv
source venv/bin/activate

# 1. Core numerical stack
pip install --only-binary=:all: numpy==1.26.4 pandas==2.2.2

# 2. Geospatial (most fragile)
pip install --only-binary=:all: pyproj==3.6.1 shapely==2.0.3 cartopy==0.23.0

# 3. Polars (explicit wheel)
# The CPU here (Xeon E5-2630L v2) has no avx2/fma/bmi, so the default polars runtime
# aborts with SIGILL (subprocess return code -4) on `import polars`.
# Do NOT use polars-lts-cpu: pip does not accept it as satisfying wetterdienst's
# `polars` dependency, so plain polars is installed over it and the radar breaks.
pip install --only-binary=:all: "polars[rtcompat]==1.40.1"

# 4. Everything else
pip install --only-binary=:all: -r requirements.txt
```



**Key packages installed:**
- Flask==3.0.0
- flask-cors==4.0.0
- gunicorn==21.2.0
- pandas
- meteostat
- plotly
- requests
- windpowerlib
- jinja2
- numpy

### 5. Upload application files
´´´
cd /home/kyosk/html

# Add mareitzef as a remote
git remote add mareitzef https://github.com/mareitzef/website.git
# Fetch from mareitzef
git fetch mareitzef
# Check out just the kyosky folder from mareitzef's master branch
git checkout mareitzef/master -- kyosky/
# Verify it's there
ls -la kyosky/
# Check status
git status
# Commit it
git commit -m "Add kyosky folder from mareitzef/website"
# Push to your GitHub
git push origin main
```

## Configure Supervisord

Supervisord manages your Flask application as a service.

### 1. Create startup script

```bash
nano ~/bin/start-kyosky.sh
```

Add this content:

```bash
#!/bin/bash

# Python 3.12 custom installation
export PATH="$HOME/python312/bin:$PATH"
export LD_LIBRARY_PATH="$HOME/openssl/lib64:$LD_LIBRARY_PATH"
export SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt
export SSL_CERT_DIR=/etc/pki/tls/certs

# Change to app directory
cd $HOME/html/kyosky || exit 1

# Activate virtual environment if it exists
if [ -f venv/bin/activate ]; then
    source venv/bin/activate
fi

# Start Gunicorn - bind to 0.0.0.0 for Uberspace
# NOTE: must be 1 worker with threads (not multiple workers) so that all
# SSE connections and toggle requests share the same in-memory RADIO_STATE.
# Multiple workers = separate processes = state not shared = stop/start broken.
exec gunicorn \
    --bind 0.0.0.0:5001 \
    --workers 1 \
    --threads 4 \
    --timeout 300 \
    --access-logfile $HOME/logs/kyosky-access.log \
    --error-logfile $HOME/logs/kyosky-error.log \
    --log-level info \
    app:app
```

Make it executable:
```bash
chmod +x ~/bin/start-kyosky.sh
```

### 2. Create supervisord service configuration

```bash
nano ~/etc/services.d/flask_kyosky.ini
```

Add this content:

```ini
[program:flask_kyosky]
command=%(ENV_HOME)s/bin/start-kyosky.sh
autostart=yes
autorestart=yes
startsecs=10
stopwaitsecs=60
stdout_logfile=%(ENV_HOME)s/logs/supervisord-flask-kyosky.log
stderr_logfile=%(ENV_HOME)s/logs/supervisord-flask-kyosky-error.log
environment=HOME="%(ENV_HOME)s",USER="%(ENV_USER)s"
```

### 3. Update and start the service

```bash
supervisorctl reread
supervisorctl update
supervisorctl start flask_kyosky
```

### 4. Check service status

```bash
supervisorctl status flask_kyosky
```

**Expected output:**
```
flask_kyosky                RUNNING   pid 12345, uptime 0:00:30
```

---

## Setup Web Backend

Configure Uberspace's Apache to proxy requests to your Flask app.

### 1. Set up web backend

```bash
uberspace web backend set /kyosky --http --port 5001
```

**Important:** Gunicorn must bind to `0.0.0.0:5001`, NOT `127.0.0.1:5001`!

### 2. Verify backend configuration

```bash
uberspace web backend list
```

**Expected output:**
```
/kyosky http:5001 => OK, PID 12345, ...
/ apache (default)
```

If you see `NOT OK, wrong interface`, your Gunicorn is binding to the wrong interface. Check your startup script.

### 3. Test the application

```bash
# Test backend directly
curl -I http://0.0.0.0:5001/

# Test through web
curl -I https://kyo.sk/kyosky
```

---

## Useful Commands

### Service Management

```bash
# Check status
supervisorctl status flask_kyosky

# Start service
supervisorctl start flask_kyosky

# Stop service
supervisorctl stop flask_kyosky

# Restart service
supervisorctl restart flask_kyosky

# View logs
tail -f ~/logs/kyosky-error.log
tail -f ~/logs/kyosky-access.log
tail -f ~/logs/supervisord-flask-kyosky-error.log
```

### Check if port is in use

```bash
netstat -tulpn | grep 5001
```

### Test backend manually

```bash
cd ~/html/kyosky
source venv/bin/activate
export PATH="$HOME/python312/bin:$PATH"
export LD_LIBRARY_PATH="$HOME/openssl/lib64:$LD_LIBRARY_PATH"
gunicorn --bind 0.0.0.0:5001 app:app
```

### Update application

```bash
# Stop service
supervisorctl stop flask_kyosky

# Update files (upload new versions)
# ...

# Restart service
supervisorctl start flask_kyosky
```

---

## Troubleshooting

### Issue: Service won't start

**Check logs:**
```bash
tail -50 ~/logs/supervisord-flask-kyosky-error.log
```

**Common causes:**
- Missing Python dependencies: `pip install -r requirements.txt`
- Port already in use: `netstat -tulpn | grep 5001`
- Wrong Python path: Check `~/bin/start-kyosky.sh`

### Issue: Web backend shows "NOT OK, wrong interface"

**Problem:** Gunicorn is binding to `127.0.0.1` instead of `0.0.0.0`

**Solution:** Edit `~/bin/start-kyosky.sh` and change:
```bash
--bind 127.0.0.1:5001
```
to:
```bash
--bind 0.0.0.0:5001
```

Then restart:
```bash
supervisorctl restart flask_kyosky
```

### Issue: Static files (music) not loading

**Check if file exists:**
```bash
ls -la ~/html/kyosky/static/
```

**Check HTML path:**
Should be: `/kyosky/static/filename.mp3` (with `/kyosky/` prefix)

**Test static file access:**
```bash
curl -I https://$(hostname).uber.space/kyosky/static/02%20-%20Hilight%20Tribe%20-%20Tsunami.mp3
```

### Issue: SSL certificate errors

**Verify SSL configuration:**
```bash
python3 -c "import ssl; print(ssl.OPENSSL_VERSION)"
echo $SSL_CERT_FILE
ls -la $SSL_CERT_FILE
```

**Reinstall with proper SSL:**
```bash
pip install --upgrade certifi
```

### Issue: ModuleNotFoundError

**Solution:** Activate venv and reinstall dependencies:
```bash
cd ~/html/kyosky
source venv/bin/activate
pip install -r requirements.txt
```

### Issue: Permission denied errors

**Fix permissions:**
```bash
chmod +x ~/bin/start-kyosky.sh
chmod -R 755 ~/html/kyosky
```

---

### Issue: Radar / prediction shows "JSON.parse: unexpected character" in the browser

The app returns a JSON body on failure, but Uberspace's frontend replaces any 5xx
response with its own HTML error page, so `response.json()` chokes on the leading `<`
and the real reason is hidden. Let the application's own error responses through:

```bash
uberspace web errorpage 500 disable
uberspace web errorpage 500 status
```

To see what the backend really answered, bypass the proxy:

```bash
curl -s -X POST http://0.0.0.0:5001/radar -H "Content-Type: application/json" -d '{}'
```

---

### Issue: [GENERATE RADAR] returns 504 after three minutes

nginx in front of the app gives up at 180 s. A radar run takes roughly 100-120 s, so
it normally fits, but a slow DWD response can push it over. The run itself is not
cancelled - it finishes and the video does update, the browser just never sees the
reply. Reload the page after a minute to see the new video.

For the same reason a radar request that has to wait for another run in progress
would always end in a 504, so `run_radar_script` does not queue: it answers 409
("a radar run is already in progress") straight away.

---

### Issue: Radar run killed with return code -9

That is SIGKILL from the kernel. The account is capped at 1.5 GiB
(`/sys/fs/cgroup/memory/user.slice/user-$(id -u).slice/memory.limit_in_bytes`) and a
single radar render peaks around 760 MB, so two at once do not fit. The scheduler and
the button now share `RADAR_LOCK` in `app.py` to prevent that; if it happens anyway,
use a smaller radius.

---

### Issue: Radar video never updates

The scheduler in `app.py` runs the radar every 10 minutes and logs the outcome. Check:

```bash
grep -a "Scheduler radar run\|Radar script returned code" ~/logs/supervisord-flask-kyosky-error.log | tail
```

A `returned code: -4` means the subprocess was killed by SIGILL — that is the polars
CPU problem described in the install section above.

---

## Application Structure

```
~/
├── bin/
│   └── start-kyosky.sh          # Gunicorn startup script
├── etc/
│   └── services.d/
│       └── flask_kyosky.ini     # Supervisord config
├── html/
│   └── kyosky/
│       ├── venv/                      # Python virtual environment
│       ├── static/
│       │   └── *.mp3                  # Static files (music)
│       ├── app.py                     # Flask application
│       ├── energy_weather_node_past_future.py  # Weather script
│       ├── index.html                 # Frontend
│       ├── requirements.txt           # Python dependencies
│       └── *.html                     # Generated plots
├── logs/
│   ├── kyosky-access.log         # Gunicorn access log
│   ├── kyosky-error.log          # Gunicorn error log
│   ├── supervisord-flask-kyosky.log
│   └── supervisord-flask-kyosky-error.log
├── openssl/                           # Custom OpenSSL install
└── python312/                         # Custom Python 3.12 install
```

---

## Environment Variables Reference

```bash
# Python and OpenSSL paths
PATH="$HOME/python312/bin:$HOME/bin:$PATH"
LD_LIBRARY_PATH="$HOME/openssl/lib64:$LD_LIBRARY_PATH"

# SSL certificates
SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt
SSL_CERT_DIR=/etc/pki/tls/certs
```

---

## Port Configuration

- **Port 5001**: Flask/Gunicorn application
- **Binding**: `0.0.0.0:5001` (required by Uberspace)
- **External access**: Via Apache proxy at `/kyosky/`

---

## Security Notes

1. **Never commit** the OpenWeatherMap API key to public repositories
2. Uberspace handles external firewall - binding to `0.0.0.0` is safe
3. Keep Python and dependencies updated regularly
4. Monitor logs for suspicious activity

---

## Backup Recommendations

Regularly backup:
```bash
# Application code
tar czf ~/backup-html-$(date +%Y%m%d).tar.gz ~/html/

# Configuration
tar czf ~/backup-config-$(date +%Y%m%d).tar.gz ~/etc/services.d/ ~/bin/

# Exclude venv and large files
tar czf ~/backup-code-$(date +%Y%m%d).tar.gz \
    --exclude='venv' \
    --exclude='*.pyc' \
    --exclude='__pycache__' \
    ~/html/kyosky/
```

---

## Support and Resources

- **Uberspace Documentation**: https://manual.uberspace.de/
- **Flask Documentation**: https://flask.palletsprojects.com/
- **Gunicorn Documentation**: https://docs.gunicorn.org/
- **Supervisord Documentation**: http://supervisord.org/

---

*Last updated: November 30, 2025*