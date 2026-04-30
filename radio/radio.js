class RadioPlayer {
    constructor() {
        this.audioElement = document.getElementById('radioAudio');
        this.toggleButton = document.getElementById('toggleButton');
        this.toggleInner = this.toggleButton.querySelector('.switch-inner');
        this.listenButton = document.getElementById('listenButton');
        this.playButton = document.getElementById('playButton');
        this.liveButton = document.getElementById('liveButton');
        this.monitorButton = document.getElementById('monitorButton');
        this.monitorAudio = document.getElementById('monitorAudio');
        this.logoutButton = document.getElementById('logoutButton');
        this.statusText = document.getElementById('statusText');
        this.timeDisplay = document.getElementById('timeDisplay');
        this.errorContainer = document.getElementById('errorContainer');
        this.errorMessage = document.getElementById('errorMessage');

        // Auth elements
        this.passwordInput = document.getElementById('passwordInput');
        this.authButton = document.getElementById('authButton');
        this.authStatus = document.getElementById('authStatus');
        this.loginLink = document.getElementById('loginLink');
        this.authModal = document.getElementById('authModal');
        this.modalClose = document.getElementById('modalClose');

        // Song selector elements (broadcaster only)
        this.songSection = document.getElementById('songSection');
        this.songButtonsEl = document.getElementById('songButtons');

        // Broadcast title (editable when authenticated)
        this.titleEl = document.querySelector('.radio-track');
        this.titleUrl = this.getApiUrl('/api/radio/title');

        // API paths
        this.stateUrl = this.getApiUrl('/api/radio/state');
        this.toggleUrl = this.getApiUrl('/api/radio/toggle');
        this.authUrl = this.getApiUrl('/api/radio/auth');
        this.logoutUrl = this.getApiUrl('/api/radio/logout');
        this.songsUrl = this.getApiUrl('/api/radio/songs');
        this.songSwitchUrl = this.getApiUrl('/api/radio/song');
        this.liveStartUrl = this.getApiUrl('/api/radio/live/start');
        this.liveStopUrl = this.getApiUrl('/api/radio/live/stop');
        // HLS served at /radio/live/ — not under /kyosky prefix
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        this.liveHlsUrl = isLocal ? 'http://localhost:5001/radio/live/index.m3u8' : '/radio/live/index.m3u8';

        // Server broadcast state
        this.liveMode = false;
        this.livePending = false;
        this.isPlaying = false;
        this.elapsedTime = 0;
        this.duration = 27.096;
        this.fetchTimestamp = Date.now();
        this.currentSong = null;  // updated from SSE

        // Local listen state
        this.isListening = false;
        this.audioReady = false;
        this.needsInitialSync = true;

        // Monitor (private broadcaster preview)
        this._monitorHls = null;
        this._monitorActive = false;

        // Idempotent UI tracking
        this._lastIsPlaying = null;
        this._lastLiveMode = null;
        this._lastLivePending = null;
        this._lastListening = null;
        this._lastListenDisabled = null;
        this._lastStatusClass = null;
        this._lastStatusText = null;
        this._lastAuthVisible = null;

        // Broadcast title
        this._lastBroadcastTitle = null;

        // Race protection — handlePlay bumps stateSeq to invalidate stale poll responses
        this._stateSeq = 0;
        this._fetchInFlight = false;

        // SSE connection
        this.eventSource = null;
        this._hls = null;

        // Auth
        this.broadcasterToken = localStorage.getItem('radio_auth_token') || null;
        this.isAuthenticated = !!this.broadcasterToken;

        // Play button stays disabled until first state is received from server,
        // preventing the race where the button shows "Start" before SSE delivers
        // the real is_playing=true, causing an accidental stop-instead-of-start click.
        this._playButtonReady = false;

        this.init();
    }

    getApiUrl(path) {
        const isLocal = window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1';
        return isLocal ? `http://localhost:5001${path}` : `/kyosky${path}`;
    }

    broadcasterHeaders(extra = {}) {
        const h = { ...extra };
        if (this.broadcasterToken) h['X-Broadcaster-Token'] = this.broadcasterToken;
        return h;
    }

    init() {
        this.authButton.addEventListener('click', () => this.handleAuth());
        this.passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleAuth();
        });
        this.listenButton.addEventListener('click', () => this.handleListen());
        this.playButton.addEventListener('click', () => this.handlePlay());
        this.liveButton.addEventListener('click', () => this.handleLiveToggle());
        this.monitorButton.addEventListener('click', () => this.handleMonitorToggle());
        this.logoutButton.addEventListener('click', () => this.handleLogout());
        this.loginLink.addEventListener('click', (e) => {
            e.preventDefault();
            this.openModal();
        });
        this.modalClose.addEventListener('click', () => this.closeModal());
        this.authModal.addEventListener('click', (e) => {
            if (e.target === this.authModal) this.closeModal();
        });

        this.applyAuthVisibility();
        this.setupTitleEditing();
        this.preloadAudio();
        this.startSSE();
        this.startTimeDisplayUpdate();
        this.startHeartbeat();
        if (this.isAuthenticated) this.loadSongs();
    }

    setupTitleEditing() {
        this.titleEl.addEventListener('blur', () => {
            if (this.isAuthenticated) this.saveBroadcastTitle();
        });
        this.titleEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.titleEl.blur(); }
            if (e.key === 'Escape') {
                this.titleEl.textContent = this._lastBroadcastTitle || '';
                this.titleEl.blur();
            }
        });
    }

    async saveBroadcastTitle() {
        const title = this.titleEl.textContent.trim();
        try {
            await fetch(this.titleUrl, {
                method: 'POST',
                headers: this.broadcasterHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ title })
            });
        } catch (e) {
            console.warn('Could not save broadcast title:', e);
        }
    }

    updateBroadcastTitle(title) {
        if (title === this._lastBroadcastTitle) return;
        this._lastBroadcastTitle = title;
        // Don't overwrite while broadcaster is actively editing
        if (document.activeElement === this.titleEl) return;
        this.titleEl.textContent = title || (this.isAuthenticated ? '' : 'Jingle Macker');
        if (this.isAuthenticated) {
            this.titleEl.setAttribute('data-placeholder', 'Broadcast name…');
        }
    }

    preloadAudio() {
        this.audioElement.src = this.getApiUrl('/api/radio/audio');
        this.audioElement.addEventListener('canplay', () => {
            this.audioReady = true;
            if (!this.isListening) this.listenButton.innerHTML = '&#9654; Listen';
            this.listenButton.disabled = false;
            this._lastListenDisabled = false;
        }, { once: true });
        this.audioElement.addEventListener('error', () => {
            this.showError('Failed to load audio');
            this.listenButton.innerHTML = 'Audio unavailable';
        }, { once: true });
        this.audioElement.load();
    }

    handleListen() {
        if (!this.audioReady) return;
        if (!this.isListening) {
            this.isListening = true;
            this.needsInitialSync = true;
            this.applyLocalAudio();
        } else {
            this.isListening = false;
            if (!this.audioElement.paused) this.audioElement.pause();
        }
        this.updateListenButton();
    }

    applyLocalAudio() {
        if (!this.audioReady) return;

        if (!this.isListening || !this.isPlaying) {
            if (!this.audioElement.paused) this.audioElement.pause();
            return;
        }

        if (this.needsInitialSync) {
            this.needsInitialSync = false;
            try {
                this.audioElement.currentTime = this.elapsedTime % this.duration;
            } catch (e) { }
        }

        if (this.audioElement.paused) {
            this.audioElement.play().catch(err => {
                // Just log — don't auto-revert isListening, the user will retry if needed
                console.warn('play() rejected:', err);
            });
        }
    }

    openModal() {
        this.authModal.style.display = 'flex';
        this.passwordInput.focus();
    }

    closeModal() {
        this.authModal.style.display = 'none';
        this.passwordInput.value = '';
        this.authStatus.textContent = '';
        this.authStatus.className = 'auth-status';
    }

    async handleAuth() {
        const password = this.passwordInput.value;
        if (!password) {
            this.showAuthError('Please enter a password');
            return;
        }

        this.authButton.disabled = true;
        this.authStatus.textContent = 'Verifying...';
        this.authStatus.className = 'auth-status';

        try {
            const response = await fetch(this.authUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await response.json();

            if (data.authenticated) {
                this.broadcasterToken = data.token;
                localStorage.setItem('radio_auth_token', data.token);
                this.isAuthenticated = true;
                this.applyAuthVisibility();
                this.loadSongs();
                if (data.took_over) {
                    this.showAuthError('Warning: previous broadcaster session ended.');
                    setTimeout(() => this.closeModal(), 2000);
                } else {
                    this.closeModal();
                }
            } else {
                this.showAuthError('Incorrect password.');
            }
        } catch (error) {
            this.showAuthError(`Error: ${error.message}`);
        } finally {
            this.authButton.disabled = false;
        }
    }

    async handleLogout() {
        this.logoutButton.disabled = true;
        try {
            await fetch(this.logoutUrl, {
                method: 'POST',
                headers: this.broadcasterHeaders()
            });
        } catch (e) {
            // Best effort — clear local state regardless
        }
        this.clearLocalAuth();
        this.logoutButton.disabled = false;
    }

    clearLocalAuth() {
        this.broadcasterToken = null;
        localStorage.removeItem('radio_auth_token');
        this.isAuthenticated = false;
        this.applyAuthVisibility();
        this.songSection.style.display = 'none';
    }

    applyAuthVisibility() {
        if (this.isAuthenticated === this._lastAuthVisible) return;
        this._lastAuthVisible = this.isAuthenticated;
        if (this.isAuthenticated) {
            this.playButton.style.display = 'inline-block';
            this.playButton.disabled = !this._playButtonReady;
            this.liveButton.style.display = 'inline-block';
            this.monitorButton.style.display = 'inline-block';
            this.logoutButton.style.display = 'inline-block';
            this.loginLink.style.display = 'none';
            this.titleEl.contentEditable = 'true';
            this.titleEl.setAttribute('data-placeholder', 'Broadcast name…');
            this.refreshBroadcasterButtonLabel();
        } else {
            this.playButton.style.display = 'none';
            this.liveButton.style.display = 'none';
            this.monitorButton.style.display = 'none';
            this.logoutButton.style.display = 'none';
            this.loginLink.style.display = 'inline-block';
            this.titleEl.contentEditable = 'false';
            this.titleEl.removeAttribute('data-placeholder');
            this.stopMonitor();
        }
    }

    refreshBroadcasterButtonLabel() {
        if (!this.isAuthenticated) return;
        this.playButton.innerHTML = this.isPlaying
            ? '&#9632; Stop Broadcast'
            : '&#9654; Start Broadcast';
    }

    showAuthError(message) {
        this.authStatus.textContent = '✗ ' + message;
        this.authStatus.className = 'auth-status error';
    }

    async handlePlay() {
        this.playButton.disabled = true;
        this._stateSeq++;  // invalidate any in-flight periodic fetchState

        try {
            const response = await fetch(this.toggleUrl, {
                method: 'POST',
                headers: this.broadcasterHeaders({ 'Content-Type': 'application/json' })
            });

            if (response.status === 401) {
                this.handleSessionExpired('Session expired or another broadcaster took over.');
                return;
            }
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            this.isPlaying = data.is_playing;
            this.fetchTimestamp = Date.now();

            // Local listen state is independent — let applyLocalAudio reconcile
            // (it will pause audio if broadcast is now off, resume if back on).
            if (this.isPlaying) this.needsInitialSync = true;
            if (this.isListening) this.applyLocalAudio();

            this.updateUI();
            this.clearError();
        } catch (error) {
            this.showError(`Failed to toggle: ${error.message}`);
        } finally {
            this.playButton.disabled = false;
        }
    }

    handleSessionExpired(message) {
        this.clearLocalAuth();
        this.showError(message);
    }

    async fetchState() {
        if (this._fetchInFlight) return;
        this._fetchInFlight = true;
        const seq = this._stateSeq;

        try {
            const response = await fetch(this.stateUrl, {
                headers: this.broadcasterHeaders()
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            // Discard if a newer authoritative action (toggle) has bumped the sequence
            if (seq !== this._stateSeq) return true;

            const wasLiveFetch = this.liveMode;
            this.liveMode = data.live_mode || false;
            this.livePending = data.live_pending || false;
            if (!wasLiveFetch && this.liveMode) this.switchToLive();
            else if (wasLiveFetch && !this.liveMode) this.switchToFile();

            const wasPlaying = this.isPlaying;
            this.isPlaying = data.is_playing;
            this.elapsedTime = data.elapsed_time;
            this.duration = data.audio_duration;
            this.fetchTimestamp = Date.now();

            if (!wasPlaying && this.isPlaying) {
                this.needsInitialSync = true;
            }
            if (wasPlaying && !this.isPlaying && this.isListening) {
                if (!this.audioElement.paused) this.audioElement.pause();
            }
            if (this.isListening) this.applyLocalAudio();

            if (data.broadcast_title !== undefined) this.updateBroadcastTitle(data.broadcast_title);
            this.clearError();
            this.setStatus('Online', 'online');
            this.updateUI();
            return true;
        } catch (error) {
            this.setStatus('Offline', 'error');
            return false;
        } finally {
            this._fetchInFlight = false;
        }
    }

    startSSE() {
        const eventSourceUrl = this.getApiUrl('/api/radio/events');
        console.log('Connecting to SSE:', eventSourceUrl);

        this.eventSource = new EventSource(eventSourceUrl);

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Live mode change — switch audio source for all listeners
                const wasLive = this.liveMode;
                this.liveMode = data.live_mode || false;
                this.livePending = data.live_pending || false;
                if (!wasLive && this.liveMode) {
                    this.switchToLive();
                } else if (wasLive && !this.liveMode) {
                    this.switchToFile();
                }

                // Song changed — reload audio from server (elapsed resets to near 0)
                if (!this.liveMode && data.current_song && data.current_song !== this.currentSong) {
                    this.currentSong = data.current_song;
                    this.highlightActiveSong(data.current_song);
                    this.reloadAudio();
                }

                if (data.broadcast_title !== undefined) this.updateBroadcastTitle(data.broadcast_title);

                const wasPlaying = this.isPlaying;
                this.isPlaying = data.is_playing;
                this.elapsedTime = data.elapsed_time;
                this.duration = data.audio_duration;
                this.fetchTimestamp = Date.now();

                if (!wasPlaying && this.isPlaying) {
                    this.needsInitialSync = true;
                }

                if (wasPlaying && !this.isPlaying && this.isListening) {
                    if (!this.audioElement.paused) this.audioElement.pause();
                }

                if (this.isListening) this.applyLocalAudio();

                this.clearError();
                this.setStatus('Online', 'online');
                this.updateUI();
            } catch (error) {
                console.error('Error parsing SSE data:', error);
            }
        };

        this.eventSource.onerror = (error) => {
            console.error('SSE connection error:', error);
            this.setStatus('Offline', 'error');
            // EventSource will auto-reconnect
        };
    }

    startTimeDisplayUpdate() {
        setInterval(() => this.updateTimeDisplay(), 100);
    }

    startPolling() {
        // DEPRECATED: Replaced with SSE. This method kept for reference.
        // setInterval(() => this.fetchState(), 2000);
        // setInterval(() => this.updateTimeDisplay(), 100);
    }

    updateTimeDisplay() {
        const interpolated = this.isPlaying
            ? this.elapsedTime + (Date.now() - this.fetchTimestamp) / 1000
            : this.elapsedTime;
        this.timeDisplay.textContent = this.formatTime(interpolated % this.duration);
    }

    updateListenButton() {
        if (this.isListening === this._lastListening) return;
        this._lastListening = this.isListening;
        if (this.isListening) {
            this.listenButton.innerHTML = '&#9632; Stop';
            this.listenButton.classList.add('listening');
        } else {
            this.listenButton.innerHTML = this.audioReady ? '&#9654; Listen' : 'Loading&hellip;';
            this.listenButton.classList.remove('listening');
        }
    }

    updateUI() {
        // Unlock play button on first state received — prevents wrong-direction
        // toggle caused by the race between page render and SSE initial state.
        if (!this._playButtonReady) {
            this._playButtonReady = true;
            if (this.isAuthenticated) this.playButton.disabled = false;
        }

        if (this.isPlaying !== this._lastIsPlaying) {
            this._lastIsPlaying = this.isPlaying;
            if (this.isPlaying) {
                this.toggleButton.classList.remove('off');
                this.toggleButton.classList.add('on');
                this.toggleInner.textContent = 'ON';
            } else {
                this.toggleButton.classList.remove('on');
                this.toggleButton.classList.add('off');
                this.toggleInner.textContent = 'OFF';
            }
            this.refreshBroadcasterButtonLabel();
        }

        if (this.liveMode !== this._lastLiveMode || this.livePending !== this._lastLivePending) {
            this._lastLiveMode = this.liveMode;
            this._lastLivePending = this.livePending;
            if (this.isAuthenticated) {
                if (this.liveMode) {
                    this.liveButton.innerHTML = '&#9679; Live ON';
                } else if (this.livePending) {
                    this.liveButton.innerHTML = '&#9679; Waiting…';
                } else {
                    this.liveButton.innerHTML = '&#9679; Go Live';
                }
                this.liveButton.classList.toggle('active', this.liveMode);
                this.liveButton.classList.toggle('pending', this.livePending && !this.liveMode);
            }
        }

        // Listen button is gated only by whether the audio blob has loaded —
        // no longer toggles with broadcast state, so it stops flickering.
        const listenDisabled = !this.audioReady;
        if (listenDisabled !== this._lastListenDisabled) {
            this._lastListenDisabled = listenDisabled;
            this.listenButton.disabled = listenDisabled;
        }
    }

    setStatus(text, cls) {
        if (text === this._lastStatusText && cls === this._lastStatusClass) return;
        this._lastStatusText = text;
        this._lastStatusClass = cls;
        this.statusText.textContent = text;
        this.statusText.className = `status-text ${cls}`;
    }

    formatTime(seconds) {
        const s = Math.max(0, seconds);
        const minutes = Math.floor(s / 60);
        const secs = Math.floor(s % 60);
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    showError(message) {
        this.errorMessage.textContent = message;
        this.errorContainer.style.display = 'block';
        console.error('Radio error:', message);
    }

    clearError() {
        if (this.errorContainer.style.display !== 'none') {
            this.errorContainer.style.display = 'none';
            this.errorMessage.textContent = '';
        }
    }

    reloadAudio() {
        this.audioReady = false;
        this.needsInitialSync = true;
        if (!this.audioElement.paused) this.audioElement.pause();
        this.audioElement.src = this.getApiUrl('/api/radio/audio') + '?t=' + Date.now();
        this.audioElement.addEventListener('canplay', () => {
            this.audioReady = true;
            this.listenButton.disabled = false;
            this._lastListenDisabled = false;
            this.updateListenButton();
            if (this.isListening && this.isPlaying) this.applyLocalAudio();
        }, { once: true });
        this.audioElement.addEventListener('error', () => {
            this.showError('Failed to load audio after song switch');
        }, { once: true });
        this.audioElement.load();
    }

    async loadSongs() {
        try {
            const response = await fetch(this.songsUrl);
            if (!response.ok) return;
            const songs = await response.json();
            this.renderSongButtons(songs);
            this.songSection.style.display = 'block';
        } catch (e) {
            console.warn('Could not load song list:', e);
        }
    }

    renderSongButtons(songs) {
        this.songButtonsEl.innerHTML = '';
        for (const song of songs) {
            const btn = document.createElement('button');
            btn.className = 'song-btn';
            btn.dataset.filename = song.filename;
            // Display name: strip extension, replace underscores with spaces
            btn.textContent = song.filename.replace(/\.mp3$/i, '').replace(/_/g, ' ');
            btn.title = song.filename;
            if (song.filename === this.currentSong) btn.classList.add('active');
            btn.addEventListener('click', () => this.handleSongSwitch(song.filename));
            this.songButtonsEl.appendChild(btn);
        }
    }

    async handleSongSwitch(filename) {
        if (filename === this.currentSong) return;
        // Optimistically mark active so UI is instant
        this.highlightActiveSong(filename);
        try {
            const response = await fetch(this.songSwitchUrl, {
                method: 'POST',
                headers: this.broadcasterHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ filename })
            });
            if (response.status === 401) {
                this.handleSessionExpired('Session expired.');
                return;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            // SSE will deliver the state update and call reloadAudio() for all clients
        } catch (e) {
            this.showError(`Song switch failed: ${e.message}`);
            // Revert highlight on failure
            this.highlightActiveSong(this.currentSong);
        }
    }

    async handleLiveToggle() {
        this.liveButton.disabled = true;
        try {
            const url = (this.liveMode || this.livePending) ? this.liveStopUrl : this.liveStartUrl;
            const response = await fetch(url, {
                method: 'POST',
                headers: this.broadcasterHeaders()
            });
            if (response.status === 401) {
                this.handleSessionExpired('Session expired.');
                return;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            // SSE will deliver the live_mode change to all clients
        } catch (e) {
            this.showError(`Live toggle failed: ${e.message}`);
        } finally {
            this.liveButton.disabled = false;
        }
    }

    switchToLive() {
        this.audioReady = false;
        if (!this.audioElement.paused) this.audioElement.pause();
        if (this._hls) { this._hls.destroy(); this._hls = null; }

        const url = this.liveHlsUrl;
        const onReady = () => {
            this.audioReady = true;
            this.listenButton.disabled = false;
            this._lastListenDisabled = false;
            this.updateListenButton();
            if (this.isListening) this.audioElement.play().catch(() => {});
        };

        if (this.audioElement.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari — native HLS
            this.audioElement.src = url;
            this.audioElement.addEventListener('canplay', onReady, { once: true });
            this.audioElement.load();
        } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            this._hls = new Hls();
            this._hls.loadSource(url);
            this._hls.attachMedia(this.audioElement);
            this._hls.on(Hls.Events.MANIFEST_PARSED, onReady);
        } else {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
            s.onload = () => {
                if (!Hls.isSupported()) { this.showError('HLS not supported in this browser'); return; }
                this._hls = new Hls();
                this._hls.loadSource(url);
                this._hls.attachMedia(this.audioElement);
                this._hls.on(Hls.Events.MANIFEST_PARSED, onReady);
            };
            document.head.appendChild(s);
        }
    }

    switchToFile() {
        if (this._hls) { this._hls.destroy(); this._hls = null; }
        this.reloadAudio();
    }

    handleMonitorToggle() {
        if (this._monitorActive) {
            this.stopMonitor();
        } else {
            this.startMonitor();
        }
    }

    startMonitor() {
        this._monitorActive = true;
        this.monitorButton.innerHTML = '&#128266; Monitor ON';
        this.monitorButton.classList.add('active');

        const url = this.liveHlsUrl;
        const audio = this.monitorAudio;

        if (audio.canPlayType('application/vnd.apple.mpegurl')) {
            audio.src = url;
            audio.load();
            audio.play().catch(() => {});
        } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            this._monitorHls = new Hls();
            this._monitorHls.loadSource(url);
            this._monitorHls.attachMedia(audio);
            this._monitorHls.on(Hls.Events.MANIFEST_PARSED, () => audio.play().catch(() => {}));
        } else {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
            s.onload = () => {
                if (!Hls.isSupported()) { this.showError('HLS not supported'); return; }
                this._monitorHls = new Hls();
                this._monitorHls.loadSource(url);
                this._monitorHls.attachMedia(audio);
                this._monitorHls.on(Hls.Events.MANIFEST_PARSED, () => audio.play().catch(() => {}));
            };
            document.head.appendChild(s);
        }
    }

    stopMonitor() {
        this._monitorActive = false;
        this.monitorButton.innerHTML = '&#128266; Monitor';
        this.monitorButton.classList.remove('active');
        if (this._monitorHls) { this._monitorHls.destroy(); this._monitorHls = null; }
        this.monitorAudio.pause();
        this.monitorAudio.src = '';
    }

    highlightActiveSong(filename) {
        for (const btn of this.songButtonsEl.querySelectorAll('.song-btn')) {
            btn.classList.toggle('active', btn.dataset.filename === filename);
        }
    }

    startHeartbeat() {
        // SSE cannot send custom headers, so the broadcaster token never refreshes
        // last_seen via SSE. Without a heartbeat the session expires after 5 minutes
        // of inactivity (no toggles), blocking re-login. This fetch keeps last_seen fresh.
        this._heartbeatTimer = setInterval(() => {
            if (this.isAuthenticated) {
                fetch(this.stateUrl, { headers: this.broadcasterHeaders() }).catch(() => {});
            }
        }, 60 * 1000);
    }

    disconnect() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
            console.log('SSE connection closed');
        }
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.radioPlayer = new RadioPlayer();
});

// Clean up SSE connection on page unload
window.addEventListener('beforeunload', () => {
    if (window.radioPlayer) {
        window.radioPlayer.disconnect();
    }
});
