class RadioPlayer {
    constructor() {
        this.audioElement = document.getElementById('radioAudio');
        this.toggleButton = document.getElementById('toggleButton');
        this.toggleInner = this.toggleButton.querySelector('.switch-inner');
        this.listenButton = document.getElementById('listenButton');
        this.playButton = document.getElementById('playButton');
        this.statusText = document.getElementById('statusText');
        this.timeDisplay = document.getElementById('timeDisplay');
        this.errorContainer = document.getElementById('errorContainer');
        this.errorMessage = document.getElementById('errorMessage');
        this.listenerCount = document.getElementById('listenerCount');

        // Auth elements (in modal)
        this.passwordInput = document.getElementById('passwordInput');
        this.authButton = document.getElementById('authButton');
        this.authStatus = document.getElementById('authStatus');
        this.loginLink = document.getElementById('loginLink');
        this.authModal = document.getElementById('authModal');
        this.modalClose = document.getElementById('modalClose');

        // API paths
        this.stateUrl = this.getApiUrl('/api/radio/state');
        this.toggleUrl = this.getApiUrl('/api/radio/toggle');
        this.authUrl = this.getApiUrl('/api/radio/auth');

        // Server broadcast state
        this.isPlaying = false;
        this.elapsedTime = 0;
        this.duration = 27.096;
        this.fetchTimestamp = Date.now();

        // Local listen state
        this.isListening = false;
        this.audioReady = false;
        this.syncThreshold = 2.0;
        this.needsInitialSync = true;

        // Idempotent UI tracking
        this._lastIsPlaying = null;
        this._lastListening = null;
        this._lastListenDisabled = null;
        this._lastStatusClass = null;
        this._lastStatusText = null;
        this._fetchInFlight = false;

        // Auth
        this.isAuthenticated = false;
        this.storedToken = localStorage.getItem('radio_auth_token');

        this.init();
    }

    getApiUrl(path) {
        const isLocal = window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1';
        return isLocal ? `http://localhost:5001${path}` : `/kyosky${path}`;
    }

    init() {
        this.authButton.addEventListener('click', () => this.handleAuth());
        this.passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleAuth();
        });
        this.listenButton.addEventListener('click', () => this.handleListen());
        this.playButton.addEventListener('click', () => this.handlePlay());
        this.loginLink.addEventListener('click', (e) => {
            e.preventDefault();
            this.openModal();
        });
        this.modalClose.addEventListener('click', () => this.closeModal());
        this.authModal.addEventListener('click', (e) => {
            if (e.target === this.authModal) this.closeModal();
        });

        if (this.storedToken) {
            this.isAuthenticated = true;
            this.showBroadcasterControls();
        }

        this.preloadAudio();
        this.startPolling();
    }

    async preloadAudio() {
        try {
            const response = await fetch(this.getApiUrl('/api/radio/audio'));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            this.audioElement.src = URL.createObjectURL(blob);
            this.audioReady = true;
            this.listenButton.innerHTML = '&#9654; Listen';
            // Disabled state will be reconciled by next updateUI
            this._lastListenDisabled = null;
        } catch (error) {
            this.showError(`Failed to load audio: ${error.message}`);
            this.listenButton.innerHTML = 'Audio unavailable';
        }
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
            } catch (e) {}
        }
        // No periodic re-seeking: blob is in memory and the audio element
        // loops natively, so let it run uninterrupted.

        if (this.audioElement.paused) {
            this.audioElement.play().catch(err => {
                console.warn('Autoplay prevented:', err);
                this.isListening = false;
                this.updateListenButton();
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
                localStorage.setItem('radio_auth_token', data.token);
                this.isAuthenticated = true;
                this.showBroadcasterControls();
                this.closeModal();
            } else {
                this.showAuthError('Incorrect password.');
            }
        } catch (error) {
            this.showAuthError(`Error: ${error.message}`);
        } finally {
            this.authButton.disabled = false;
        }
    }

    showBroadcasterControls() {
        this.playButton.style.display = 'inline-block';
        this.loginLink.style.display = 'none';
    }

    showAuthError(message) {
        this.authStatus.textContent = '✗ ' + message;
        this.authStatus.className = 'auth-status error';
    }

    async handlePlay() {
        this.playButton.disabled = true;

        try {
            const response = await fetch(this.toggleUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            this.isPlaying = data.is_playing;
            this.fetchTimestamp = Date.now();

            if (!this.isPlaying && this.isListening) {
                this.isListening = false;
                if (!this.audioElement.paused) this.audioElement.pause();
                this.updateListenButton();
            }

            if (this.isPlaying) this.needsInitialSync = true;

            await this.fetchState();
            this.clearError();
        } catch (error) {
            this.showError(`Failed to toggle: ${error.message}`);
        } finally {
            this.playButton.disabled = false;
        }
    }

    async fetchState() {
        if (this._fetchInFlight) return;
        this._fetchInFlight = true;

        try {
            const response = await fetch(this.stateUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
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
            return true;
        } catch (error) {
            this.setStatus('Offline', 'error');
            return false;
        } finally {
            this._fetchInFlight = false;
        }
    }

    startPolling() {
        setInterval(() => this.fetchState(), 2000);
        setInterval(() => this.updateTimeDisplay(), 100);
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
        // Toggle graphic — only update on transition
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
            // Broadcaster button label tracks isPlaying
            if (this.isAuthenticated) {
                this.playButton.innerHTML = this.isPlaying
                    ? '&#9632; Stop Broadcast'
                    : '&#9654; Start Broadcast';
            }
        }

        // Listen button disabled state — only update on transition
        const listenDisabled = !this.isPlaying || !this.audioReady;
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
}

document.addEventListener('DOMContentLoaded', () => {
    window.radioPlayer = new RadioPlayer();
});
