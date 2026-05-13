class RadioPlayer {
    constructor() {
        this.audioElement = document.getElementById('radioAudio');
        this.toggleButton = document.getElementById('toggleButton');
        this.toggleInner = this.toggleButton.querySelector('.switch-inner');
        this.listenButton = document.getElementById('listenButton');
        this.playButton = document.getElementById('playButton');
        this.logoutButton = document.getElementById('logoutButton');
        this.statusText = document.getElementById('statusText');
        this.timeDisplay = document.getElementById('timeDisplay');
        this.listenerCountEl = document.getElementById('listenerCount');
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
        this.fileList = document.getElementById('fileList');
        this.importButton = document.getElementById('importButton');

        // Progress bar elements
        this.progressBar = document.getElementById('progressBar');
        this.currentTimeEl = document.getElementById('currentTime');
        this.durationEl = document.getElementById('duration');
        this._userSeeking = false;  // Flag to prevent updates while user drags

        // File list state
        this.files = [];  // Array of {filename, order, ignored}
        this.draggedItem = null;  // For drag-and-drop
        this.dragOffsetY = 0;
        this._autoAdvanceInterval = null;
        this._listenerCountInterval = null;
        this._lastAutoAdvancedSong = null;  // Track which song we auto-advanced from to prevent loops

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
        this.listenerCountUrl = this.getApiUrl('/api/radio/listener-count');
        this.shuffleUrl = this.getApiUrl('/api/radio/shuffle');
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
        this.shuffle = false;  // updated from SSE

        // Local listen state
        this.isListening = false;
        this.audioReady = false;
        this.needsInitialSync = true;

        // Idempotent UI tracking
        this._lastIsPlaying = null;
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
        this.logoutButton.addEventListener('click', () => this.handleLogout());
        this.loginLink.addEventListener('click', (e) => {
            e.preventDefault();
            this.openModal();
        });
        this.modalClose.addEventListener('click', () => this.closeModal());
        this.authModal.addEventListener('click', (e) => {
            if (e.target === this.authModal) this.closeModal();
        });
        this.importButton.addEventListener('click', () => this.handleImport());
        this.playPauseButton = document.getElementById('playPauseButton');
        this.volumeSlider = document.getElementById('volumeSlider');
        this.nextButton = document.getElementById('nextButton');
        this.prevButton = document.getElementById('prevButton');
        this.shuffleButton = document.getElementById('shuffleButton');
        this.playPauseButton.addEventListener('click', () => this.handlePlayPauseToggle());
        this.volumeSlider.addEventListener('input', (e) => this.handleVolumeChange(e));
        this.nextButton.addEventListener('click', () => this.handleNextSong());
        this.prevButton.addEventListener('click', () => this.handlePrevSong());
        this.shuffleButton.addEventListener('click', () => this.handleShuffleToggle());

        // Progress bar listeners
        this.progressBar.addEventListener('mousedown', () => { this._userSeeking = true; });
        this.progressBar.addEventListener('touchstart', () => { this._userSeeking = true; });
        this.progressBar.addEventListener('mouseup', (e) => this.handleSeek(e));
        this.progressBar.addEventListener('touchend', (e) => this.handleSeek(e));
        this.progressBar.addEventListener('input', (e) => this.handleSeek(e));

        // Validate stored token on startup
        if (this.isAuthenticated) {
            this.validateStoredToken().then(isValid => {
                if (!isValid) {
                    this.clearLocalAuth();
                }
            });
        }

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
        this.updateNowPlaying();
    }

    updateNowPlaying() {
        if (document.activeElement === this.titleEl) return;
        if (this.isAuthenticated) {
            this.titleEl.textContent = this._lastBroadcastTitle || '';
            this.titleEl.setAttribute('data-placeholder', 'Broadcast name…');
        } else if (this.liveMode || this.livePending) {
            this.titleEl.textContent = this._lastBroadcastTitle || 'Live';
        } else {
            this.titleEl.textContent = this.currentSong
                ? this.currentSong.replace(/\.mp3$/i, '').replace(/_/g, ' ')
                : '';
        }
    }

    preloadAudio() {
        this.audioElement.src = this.getApiUrl('/api/radio/audio');
        // Restore saved volume
        const savedVolume = localStorage.getItem('radio_volume');
        if (savedVolume) {
            const vol = Math.max(0, Math.min(100, parseInt(savedVolume) || 100));
            this.audioElement.volume = vol / 100;
            this.volumeSlider.value = vol;
        }
        this.audioElement.addEventListener('canplay', () => {
            this.audioReady = true;
            if (!this.isListening) this.listenButton.innerHTML = 'Sound ON';
            this.listenButton.disabled = false;
            this._lastListenDisabled = false;
        }, { once: true });
        this.audioElement.addEventListener('error', () => {
            this.showError('Failed to load audio');
            this.listenButton.innerHTML = 'Audio unavailable';
        }, { once: true });
        // Update progress bar during playback
        this.audioElement.addEventListener('timeupdate', () => {
            if (!this._userSeeking) {
                this.updateProgressBar();
            }
        });
        // Handle song ending — fetch fresh state and reload if new song available
        this.audioElement.addEventListener('ended', async () => {
            console.log('[AUDIO ENDED] Fetching fresh state');
            const ok = await this.fetchState();
            if (ok && this.isListening && this.isPlaying) {
                console.log('[AUDIO ENDED] New state received, reloading audio');
                this.reloadAudio();
            }
        });
        this.audioElement.load();
    }

    handleListen() {
        if (!this.audioReady) return;
        if (!this.isListening) {
            this.isListening = true;
            this.needsInitialSync = true;
            if (window.archivePlayer) window.archivePlayer.stop();
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
                const interpolated = this.isPlaying
                    ? this.elapsedTime + (Date.now() - this.fetchTimestamp) / 1000
                    : this.elapsedTime;
                this.audioElement.currentTime = interpolated % this.duration;
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

    async validateStoredToken() {
        // Validate the stored broadcaster token on app startup.
        // Returns true if token is valid, false if expired/invalid.
        if (!this.broadcasterToken) return false;

        try {
            const response = await fetch(this.getApiUrl('/api/radio/validate-token'), {
                method: 'POST',
                headers: this.broadcasterHeaders({ 'Content-Type': 'application/json' })
            });

            if (response.status === 401) {
                console.warn('Token validation failed: 401 Unauthorized');
                return false;
            }

            if (!response.ok) {
                console.warn('Token validation request failed:', response.status);
                return false;
            }

            const data = await response.json();
            return data.valid === true;
        } catch (error) {
            console.warn('Error validating stored token:', error);
            // If we can't reach the server, assume token might be valid (offline scenario)
            return true;
        }
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

    handlePlayPauseToggle() {
        this.handlePlay();
    }

    handleVolumeChange(e) {
        const volume = Math.max(0, Math.min(100, parseInt(e.target.value) || 100));
        e.target.value = volume;
        this.audioElement.volume = volume / 100;
        localStorage.setItem('radio_volume', volume);
    }

    handleNextSong() {
        if (!this.isAuthenticated) return;
        const availableFiles = this.files.filter(f => !f.ignored);
        if (availableFiles.length === 0) return;

        let nextFile;
        if (this.shuffle) {
            // Pick random song, preferring a different one
            const others = availableFiles.filter(f => f.filename !== this.currentSong);
            nextFile = others.length > 0 ? others[Math.floor(Math.random() * others.length)] : availableFiles[0];
        } else {
            const currentIdx = availableFiles.findIndex(f => f.filename === this.currentSong);
            const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % availableFiles.length : 0;
            nextFile = availableFiles[nextIdx];
        }
        this.handleSongSwitch(nextFile.filename);
    }

    handlePrevSong() {
        if (!this.isAuthenticated) return;
        const availableFiles = this.files.filter(f => !f.ignored);
        if (availableFiles.length === 0) return;

        let prevFile;
        if (this.shuffle) {
            // Pick random song, preferring a different one
            const others = availableFiles.filter(f => f.filename !== this.currentSong);
            prevFile = others.length > 0 ? others[Math.floor(Math.random() * others.length)] : availableFiles[0];
        } else {
            const currentIdx = availableFiles.findIndex(f => f.filename === this.currentSong);
            const prevIdx = currentIdx > 0 ? currentIdx - 1 : availableFiles.length - 1;
            prevFile = availableFiles[prevIdx];
        }
        this.handleSongSwitch(prevFile.filename);
    }

    async handleShuffleToggle() {
        if (!this.isAuthenticated) return;
        try {
            const response = await fetch(this.shuffleUrl, {
                method: 'POST',
                headers: this.broadcasterHeaders()
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this.shuffle = data.shuffle;
            this.updateUI();
        } catch (e) {
            this.showError(`Failed to toggle shuffle: ${e.message}`);
        }
    }

    applyAuthVisibility() {
        if (this.isAuthenticated === this._lastAuthVisible) return;
        this._lastAuthVisible = this.isAuthenticated;
        if (this.isAuthenticated) {
            this.playButton.style.display = 'inline-block';
            this.playButton.disabled = !this._playButtonReady;
            this.logoutButton.style.display = 'inline-block';
            this.timeDisplay.style.display = '';
            this.loginLink.style.display = 'none';
            this.titleEl.contentEditable = 'true';
            this.titleEl.setAttribute('data-placeholder', 'Broadcast name…');
            this.progressBar.disabled = false;
            this.listenerCountEl.style.display = '';
            this.refreshBroadcasterButtonLabel();
            this.startListenerCountPolling();
        } else {
            this.playButton.style.display = 'none';
            this.logoutButton.style.display = 'none';
            this.timeDisplay.style.display = 'none';
            this.listenerCountEl.style.display = 'none';
            this.loginLink.style.display = 'inline-block';
            this.titleEl.contentEditable = 'false';
            this.titleEl.removeAttribute('data-placeholder');
            this.progressBar.disabled = true;
            this.stopListenerCountPolling();
            this.updateNowPlaying();
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
            this.shuffle = data.shuffle || false;
            this.fetchTimestamp = Date.now();

            if (!wasPlaying && this.isPlaying) {
                this.needsInitialSync = true;
            }
            if (wasPlaying && !this.isPlaying && this.isListening) {
                if (!this.audioElement.paused) this.audioElement.pause();
            }
            if (this.isListening) this.applyLocalAudio();

            if (data.current_song && data.current_song !== this.currentSong) {
                this.currentSong = data.current_song;
                this._lastAutoAdvancedSong = null;
                this.highlightActiveSong(data.current_song);
            } else if (data.current_song) {
                this.currentSong = data.current_song;
            }
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
                    this._lastAutoAdvancedSong = null;  // Reset auto-advance tracker when song actually changes
                    this.highlightActiveSong(data.current_song);
                    this.reloadAudio();
                }

                if (data.broadcast_title !== undefined) this.updateBroadcastTitle(data.broadcast_title);

                const wasPlaying = this.isPlaying;
                this.isPlaying = data.is_playing;
                this.elapsedTime = data.elapsed_time;
                this.duration = data.audio_duration;
                this.shuffle = data.shuffle || false;
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
            this.listenButton.innerHTML = 'Sound OFF';
            this.listenButton.classList.add('listening');
        } else {
            this.listenButton.innerHTML = this.audioReady ? 'Sound ON' : 'Loading&hellip;';
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
                this.playPauseButton.textContent = '⏸';
            } else {
                this.toggleButton.classList.remove('on');
                this.toggleButton.classList.add('off');
                this.toggleInner.textContent = 'OFF';
                this.playPauseButton.textContent = '▶';
            }
            this.refreshBroadcasterButtonLabel();
        }

        this.updateNowPlaying();

        if (this.shuffle !== this._lastShuffle) {
            this._lastShuffle = this.shuffle;
            this.shuffleButton.classList.toggle('active', this.shuffle);
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

    updateProgressBar() {
        if (!this.audioElement || !this.audioElement.duration) return;
        const progress = (this.audioElement.currentTime / this.audioElement.duration) * 100;
        this.progressBar.value = Math.max(0, Math.min(100, progress));
        this.currentTimeEl.textContent = this.formatTime(this.audioElement.currentTime);
        this.durationEl.textContent = this.formatTime(this.audioElement.duration);
    }

    handleSeek(e) {
        if (!this.audioElement || !this.audioElement.duration) return;
        const percent = this.progressBar.value;
        const newTime = (percent / 100) * this.audioElement.duration;
        this.audioElement.currentTime = newTime;
        this._userSeeking = false;
        this.updateProgressBar();
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
        // Reset progress bar for new song
        this.progressBar.value = 0;
        this.currentTimeEl.textContent = '0:00';
        this.audioElement.src = this.getApiUrl('/api/radio/audio') + '?t=' + Date.now();
        this.audioElement.addEventListener('canplay', () => {
            this.audioReady = true;
            this.listenButton.disabled = false;
            this._lastListenDisabled = false;
            this.updateListenButton();
            // Update duration display when audio is ready
            if (this.audioElement.duration) {
                this.durationEl.textContent = this.formatTime(this.audioElement.duration);
            }
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
            const data = await response.json();
            // data is {files: [{filename, order, ignored}, ...]}
            this.files = data.files || [];
            // Sort by order field
            this.files.sort((a, b) => a.order - b.order);
            this.renderFileList();
            this.songSection.style.display = 'block';
        } catch (e) {
            console.warn('Could not load file list:', e);
        }
    }

    renderFileList() {
        this.fileList.innerHTML = '';
        for (const file of this.files) {
            const li = document.createElement('li');
            li.className = 'file-item';
            li.dataset.filename = file.filename;
            li.draggable = true;
            if (file.ignored) {
                li.classList.add('ignored');
            }

            // Checkbox for ignore
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'file-checkbox';
            checkbox.checked = !file.ignored;
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                this.handleIgnoreToggle(file.filename, !checkbox.checked);
            });

            // Filename label (clickable to switch to song)
            const label = document.createElement('span');
            label.className = 'file-label';
            label.textContent = file.filename.replace(/\.mp3$/i, '').replace(/_/g, ' ');
            label.title = file.filename;
            label.style.cursor = 'pointer';
            label.addEventListener('click', () => {
                if (!this.isAuthenticated) return;
                this.handleSongSwitch(file.filename);
            });

            // Drag handle
            const dragHandle = document.createElement('span');
            dragHandle.className = 'drag-handle';
            dragHandle.textContent = '⋮';
            dragHandle.title = 'Drag to reorder';

            // Active indicator
            if (file.filename === this.currentSong) {
                li.classList.add('active');
            }

            li.appendChild(checkbox);
            li.appendChild(label);
            li.appendChild(dragHandle);

            // Drag event listeners
            li.addEventListener('dragstart', (e) => this.handleDragStart(e, li));
            li.addEventListener('dragover', (e) => this.handleDragOver(e, li));
            li.addEventListener('dragend', (e) => this.handleDragEnd(e));
            li.addEventListener('drop', (e) => this.handleDrop(e, li));

            // Touch event listeners for mobile
            li.addEventListener('touchstart', (e) => this.handleTouchStart(e, li));
            li.addEventListener('touchmove', (e) => this.handleTouchMove(e, li));
            li.addEventListener('touchend', (e) => this.handleTouchEnd(e, li));

            this.fileList.appendChild(li);
        }

        // Start checking for auto-advance to next file
        this.startAutoAdvanceCheck();
    }

    startAutoAdvanceCheck() {
        // Clear any existing interval
        if (this._autoAdvanceInterval) {
            clearInterval(this._autoAdvanceInterval);
        }

        // Auto-advance should work for all users (broadcasters trigger, listeners follow via SSE)
        this._autoAdvanceInterval = setInterval(() => {
            if (!this.isPlaying || !this.isAuthenticated) return;

            // Get non-ignored files
            const availableFiles = this.files.filter(f => !f.ignored);
            if (availableFiles.length === 0) return;

            // Check if current song is done (elapsed >= duration with some margin)
            const margin = 0.5; // seconds
            if (this.elapsedTime >= (this.duration - margin)) {
                // Only auto-advance once per song — skip if we've already initiated a switch for this song
                if (this._lastAutoAdvancedSong === this.currentSong) return;

                // Advance to next song (shuffle or sequential)
                let nextFile;
                if (this.shuffle) {
                    // Pick random song, preferring a different one
                    const others = availableFiles.filter(f => f.filename !== this.currentSong);
                    nextFile = others.length > 0 ? others[Math.floor(Math.random() * others.length)] : availableFiles[0];
                } else {
                    const currentIdx = availableFiles.findIndex(f => f.filename === this.currentSong);
                    if (currentIdx >= 0) {
                        const nextIdx = (currentIdx + 1) % availableFiles.length;
                        nextFile = availableFiles[nextIdx];
                    } else {
                        nextFile = availableFiles[0];
                    }
                }
                if (nextFile) {
                    this._lastAutoAdvancedSong = this.currentSong;
                    this.handleSongSwitch(nextFile.filename);
                }
            }
        }, 1000); // Check every second
    }

    // Drag-and-drop handlers (mouse)
    handleDragStart(e, li) {
        this.draggedItem = li;
        e.dataTransfer.effectAllowed = 'move';
        li.classList.add('dragging');
    }

    handleDragOver(e, li) {
        if (!this.draggedItem || this.draggedItem === li) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const rect = li.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        if (e.clientY < midpoint) {
            li.classList.add('drag-over-before');
            li.classList.remove('drag-over-after');
        } else {
            li.classList.remove('drag-over-before');
            li.classList.add('drag-over-after');
        }
    }

    handleDragEnd(e) {
        document.querySelectorAll('.file-item').forEach(li => {
            li.classList.remove('dragging', 'drag-over-before', 'drag-over-after');
        });
        this.draggedItem = null;
    }

    handleDrop(e, targetLi) {
        e.preventDefault();
        if (!this.draggedItem || this.draggedItem === targetLi) return;

        const sourceName = this.draggedItem.dataset.filename;
        const targetName = targetLi.dataset.filename;

        const sourceFile = this.files.find(f => f.filename === sourceName);
        const targetFile = this.files.find(f => f.filename === targetName);
        if (!sourceFile || !targetFile) return;

        // Determine insertion position
        const rect = targetLi.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const insertBefore = e.clientY < midpoint;

        // Reorder in array
        const sourceIdx = this.files.indexOf(sourceFile);
        const targetIdx = this.files.indexOf(targetFile);
        this.files.splice(sourceIdx, 1);
        let newIdx = this.files.indexOf(targetFile);
        if (!insertBefore) newIdx++;
        this.files.splice(newIdx, 0, sourceFile);

        // Update order field
        for (let i = 0; i < this.files.length; i++) {
            this.files[i].order = i;
        }

        this.syncFileOrder();
        this.renderFileList();
    }

    // Touch handlers for mobile
    handleTouchStart(e, li) {
        this.draggedItem = li;
        this.dragOffsetY = e.touches[0].clientY;
        li.classList.add('dragging');
    }

    handleTouchMove(e, li) {
        if (!this.draggedItem) return;
        e.preventDefault();

        const touch = e.touches[0];
        const delta = touch.clientY - this.dragOffsetY;

        // Simple auto-scroll when dragging near list edges
        const list = this.fileList;
        if (delta < -50) {
            list.scrollTop -= 15;
        } else if (delta > 50) {
            list.scrollTop += 15;
        }
    }

    handleTouchEnd(e, li) {
        if (!this.draggedItem) return;

        const touch = e.changedTouches[0];
        const elementBelow = document.elementFromPoint(touch.clientX, touch.clientY);
        const targetLi = elementBelow?.closest('.file-item');

        if (targetLi && targetLi !== this.draggedItem) {
            const sourceName = this.draggedItem.dataset.filename;
            const targetName = targetLi.dataset.filename;

            const sourceFile = this.files.find(f => f.filename === sourceName);
            const targetFile = this.files.find(f => f.filename === targetName);
            if (sourceFile && targetFile) {
                const sourceIdx = this.files.indexOf(sourceFile);
                const targetIdx = this.files.indexOf(targetFile);
                this.files.splice(sourceIdx, 1);
                this.files.splice(targetIdx, 0, sourceFile);

                // Update order field
                for (let i = 0; i < this.files.length; i++) {
                    this.files[i].order = i;
                }

                this.syncFileOrder();
                this.renderFileList();
            }
        }

        document.querySelectorAll('.file-item').forEach(item => {
            item.classList.remove('dragging', 'drag-over-before', 'drag-over-after');
        });
        this.draggedItem = null;
    }

    async handleIgnoreToggle(filename, ignored) {
        try {
            const response = await fetch(this.getApiUrl('/api/radio/files/ignore'), {
                method: 'POST',
                headers: this.broadcasterHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ filename, ignored })
            });
            if (response.status === 401) {
                this.handleSessionExpired('Session expired.');
                return;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const file = this.files.find(f => f.filename === filename);
            if (file) {
                file.ignored = ignored;
            }
            this.renderFileList();
        } catch (e) {
            this.showError(`Failed to toggle ignore: ${e.message}`);
        }
    }

    async syncFileOrder() {
        try {
            const order = this.files.map(f => f.filename);
            await fetch(this.getApiUrl('/api/radio/files/reorder'), {
                method: 'POST',
                headers: this.broadcasterHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ order })
            });
        } catch (e) {
            this.showError(`Failed to sync file order: ${e.message}`);
        }
    }

    async handleImport() {
        // Refresh the file list from disk
        try {
            this.importButton.disabled = true;
            const response = await fetch(this.getApiUrl('/api/radio/files/refresh'), {
                method: 'POST',
                headers: this.broadcasterHeaders()
            });
            if (response.status === 401) {
                this.handleSessionExpired('Session expired.');
                return;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            await this.loadSongs();
        } catch (e) {
            this.showError(`Failed to refresh files: ${e.message}`);
        } finally {
            this.importButton.disabled = false;
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
            if (this.isListening) this.audioElement.play().catch(() => { });
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

    highlightActiveSong(filename) {
        for (const item of this.fileList.querySelectorAll('.file-item')) {
            item.classList.toggle('active', item.dataset.filename === filename);
        }
    }

    startHeartbeat() {
        // SSE cannot send custom headers, so the broadcaster token never refreshes
        // last_seen via SSE. Without a heartbeat the session expires after 5 minutes
        // of inactivity (no toggles), blocking re-login. This fetch keeps last_seen fresh.
        this._heartbeatTimer = setInterval(() => {
            if (this.isAuthenticated) {
                fetch(this.stateUrl, { headers: this.broadcasterHeaders() }).catch(() => { });
            }
        }, 60 * 1000);
    }

    startListenerCountPolling() {
        // Stop any existing polling
        if (this._listenerCountInterval) {
            clearInterval(this._listenerCountInterval);
        }
        // Poll every 5 seconds
        this._listenerCountInterval = setInterval(() => {
            fetch(this.listenerCountUrl)
                .then(r => r.json())
                .then(data => {
                    this.listenerCountEl.textContent = `👥 ${data.count}`;
                })
                .catch(() => { });
        }, 5 * 1000);
        // Fetch immediately on start
        fetch(this.listenerCountUrl)
            .then(r => r.json())
            .then(data => {
                this.listenerCountEl.textContent = `👥 ${data.count}`;
            })
            .catch(() => { });
    }

    stopListenerCountPolling() {
        if (this._listenerCountInterval) {
            clearInterval(this._listenerCountInterval);
            this._listenerCountInterval = null;
        }
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

class ArchivePlayer {
    constructor() {
        this.audio = new Audio();
        this.files = [];
        this.trackIdx = -1;
        this._playing = false;

        this.nowPlayingEl   = document.getElementById('archiveNowPlaying');
        this.fileListEl     = document.getElementById('archiveFileList');
        this.playPauseBtn   = document.getElementById('archivePlayPauseBtn');
        this.prevBtn        = document.getElementById('archivePrevBtn');
        this.nextBtn        = document.getElementById('archiveNextBtn');
        this.volumeSlider   = document.getElementById('archiveVolume');
        this.refreshBtn     = document.getElementById('archiveRefreshBtn');
        this.progressBar    = document.getElementById('archiveProgressBar');
        this.currentTimeEl  = document.getElementById('archiveCurrentTime');
        this.durationEl     = document.getElementById('archiveDuration');
        this._seeking       = false;

        const savedVol = localStorage.getItem('archive_volume');
        if (savedVol !== null) {
            this.volumeSlider.value = savedVol;
            this.audio.volume = savedVol / 100;
        } else {
            this.audio.volume = 0.8;
        }

        this.prevBtn.addEventListener('click', () => this.loadTrack(this.trackIdx - 1));
        this.nextBtn.addEventListener('click', () => this.loadTrack(this.trackIdx + 1));
        this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        this.refreshBtn.addEventListener('click', () => this.scanArchive());
        this.progressBar.addEventListener('mousedown',  () => { this._seeking = true; });
        this.progressBar.addEventListener('touchstart', () => { this._seeking = true; });
        this.progressBar.addEventListener('mouseup',  e => this.handleSeek());
        this.progressBar.addEventListener('touchend', e => this.handleSeek());
        this.progressBar.addEventListener('input',    () => this.handleSeek());
        this.volumeSlider.addEventListener('input', e => {
            this.audio.volume = e.target.value / 100;
            localStorage.setItem('archive_volume', e.target.value);
        });
        this.audio.addEventListener('timeupdate', () => {
            if (!this._seeking) this.updateProgressBar();
        });
        this.audio.addEventListener('loadedmetadata', () => {
            this.progressBar.disabled = false;
            this.durationEl.textContent = this.formatTime(this.audio.duration);
            this.updateProgressBar();
        });
        this.audio.addEventListener('ended', () => {
            if (this.trackIdx < this.files.length - 1) {
                this.loadTrack(this.trackIdx + 1);
            } else {
                this._playing = false;
                this.playPauseBtn.textContent = '▶';
            }
        });

        this.scanArchive();
    }

    async scanArchive() {
        this.fileListEl.innerHTML = '<li class="archive-empty">Scanning…</li>';
        try {
            const url = this.getApiUrl('/api/radio/archive');
            const r = await fetch(url);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            this.files = data.files || [];
            this.renderFileList();
        } catch (e) {
            this.fileListEl.innerHTML = '<li class="archive-empty">Could not load archive.</li>';
            console.error('Archive scan error:', e);
        }
    }

    getApiUrl(path) {
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        return isLocal ? `http://localhost:5001${path}` : `/kyosky${path}`;
    }

    renderFileList() {
        this.fileListEl.innerHTML = '';
        if (this.files.length === 0) {
            this.fileListEl.innerHTML = '<li class="archive-empty">No recordings in archive yet.</li>';
            return;
        }
        const sortedFiles = [...this.files].reverse();
        sortedFiles.forEach((file, displayIdx) => {
            const actualIdx = this.files.length - 1 - displayIdx;
            const filename = typeof file === 'object' ? file.name : file;
            const label    = typeof file === 'object' ? (file.label || file.name) : file;

            const li = document.createElement('li');
            li.className = 'file-item' + (actualIdx === this.trackIdx ? ' active' : '');
            li.dataset.idx = actualIdx;

            const span = document.createElement('span');
            span.className = 'file-label';
            span.textContent = label.replace(/\.mp3$/i, '').replace(/_/g, ' ');
            span.title = filename;

            li.appendChild(span);
            li.addEventListener('click', () => this.loadTrack(actualIdx));
            this.fileListEl.appendChild(li);
        });
    }

    loadTrack(idx) {
        if (idx < 0 || idx >= this.files.length) return;
        this.trackIdx = idx;
        const file     = this.files[idx];
        const filename = typeof file === 'object' ? file.name : file;
        const label    = typeof file === 'object' ? (file.label || file.name) : file;

        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const base = isLocal ? 'http://localhost:5001' : '';
        this.progressBar.value = 0;
        this.progressBar.disabled = true;
        this.currentTimeEl.textContent = '0:00';
        this.durationEl.textContent = '0:00';
        this.audio.src = `${base}/radio/music/archive/${encodeURIComponent(filename)}`;
        this.audio.play().catch(e => console.warn('Archive play error:', e));
        this._playing = true;
        this.playPauseBtn.textContent = '⏸';
        this.playPauseBtn.disabled = false;
        this.nowPlayingEl.textContent = label.replace(/\.mp3$/i, '').replace(/_/g, ' ');

        for (const li of this.fileListEl.querySelectorAll('.file-item')) {
            li.classList.toggle('active', parseInt(li.dataset.idx) === idx);
        }
        this.prevBtn.disabled = idx === 0;
        this.nextBtn.disabled = idx === this.files.length - 1;

        // Pause broadcast if it was playing
        if (window.radioPlayer && window.radioPlayer.isListening) {
            window.radioPlayer.handleListen();
        }
    }

    togglePlayPause() {
        if (this.trackIdx < 0) return;
        if (this._playing) {
            this.audio.pause();
            this._playing = false;
            this.playPauseBtn.textContent = '▶';
        } else {
            this.audio.play().catch(() => {});
            this._playing = true;
            this.playPauseBtn.textContent = '⏸';
        }
    }

    updateProgressBar() {
        if (!this.audio.duration) return;
        const pct = (this.audio.currentTime / this.audio.duration) * 100;
        this.progressBar.value = Math.max(0, Math.min(100, pct));
        this.currentTimeEl.textContent = this.formatTime(this.audio.currentTime);
        this.durationEl.textContent    = this.formatTime(this.audio.duration);
    }

    handleSeek() {
        if (!this.audio.duration) return;
        this.audio.currentTime = (this.progressBar.value / 100) * this.audio.duration;
        this._seeking = false;
        this.updateProgressBar();
    }

    formatTime(secs) {
        const s = Math.max(0, secs || 0);
        return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    }

    stop() {
        if (!this._playing) return;
        this.audio.pause();
        this._playing = false;
        this.playPauseBtn.textContent = '▶';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.radioPlayer = new RadioPlayer();
    window.archivePlayer = new ArchivePlayer();
});

// Clean up SSE connection on page unload
window.addEventListener('beforeunload', () => {
    if (window.radioPlayer) {
        window.radioPlayer.disconnect();
    }
});
