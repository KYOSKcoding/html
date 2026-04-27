class RadioPlayer {
    constructor() {
        this.audioElement = document.getElementById('radioAudio');
        this.toggleButton = document.getElementById('toggleButton');
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

        // Local listen state (independent of server broadcast)
        this.isListening = false;
        // Only seek to sync position when audio first starts, or drift exceeds this
        this.syncThreshold = 2.0;
        this.needsInitialSync = true;

        // Auth state
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
        this.audioElement.src = this.getApiUrl('/api/radio/audio');

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

        // When audio ends (shouldn't happen with loop, but as safety net)
        this.audioElement.addEventListener('ended', () => {
            if (this.isListening && this.isPlaying) {
                this.audioElement.currentTime = 0;
                this.audioElement.play().catch(() => {});
            }
        });

        if (this.storedToken) {
            this.isAuthenticated = true;
            this.showBroadcasterControls();
        }

        this.startPolling();
    }

    handleListen() {
        if (!this.isListening) {
            this.isListening = true;
            this.needsInitialSync = true;
            this.applyLocalAudio();
        } else {
            this.isListening = false;
            this.audioElement.pause();
        }
        this.updateListenButton();
    }

    // Apply local audio state based on isListening + isPlaying (server state)
    applyLocalAudio() {
        if (!this.isListening || !this.isPlaying) {
            if (!this.audioElement.paused) this.audioElement.pause();
            return;
        }

        // On initial start or large drift, seek to server position first
        if (this.needsInitialSync) {
            this.needsInitialSync = false;
            try {
                this.audioElement.currentTime = this.elapsedTime;
            } catch (e) {}
        } else {
            // Only re-seek if audio has drifted significantly
            const timeDiff = Math.abs(this.audioElement.currentTime - this.elapsedTime);
            if (timeDiff > this.syncThreshold) {
                try {
                    this.audioElement.currentTime = this.elapsedTime;
                } catch (e) {}
            }
        }

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

    // Broadcaster: toggle server broadcast state
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

            // When broadcast stops, also stop listening locally
            if (!this.isPlaying && this.isListening) {
                this.isListening = false;
                this.audioElement.pause();
                this.updateListenButton();
            }

            // When broadcast starts, mark as needing sync for next listen
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
        try {
            const response = await fetch(this.stateUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            const wasPlaying = this.isPlaying;
            this.isPlaying = data.is_playing;
            this.elapsedTime = data.elapsed_time;
            this.duration = data.audio_duration;
            this.fetchTimestamp = Date.now();

            // Broadcast just started: mark for initial sync
            if (!wasPlaying && this.isPlaying) {
                this.needsInitialSync = true;
            }

            // Broadcast stopped: pause local audio
            if (wasPlaying && !this.isPlaying && this.isListening) {
                this.audioElement.pause();
            }

            // Apply local audio (won't seek unless needed)
            if (this.isListening) this.applyLocalAudio();

            this.clearError();
            this.showMessage('Online', 'online');
            this.updateUI();
            return true;
        } catch (error) {
            this.showError(`Connection error: ${error.message}`);
            this.showMessage('Offline', 'error');
            return false;
        }
    }

    startPolling() {
        setInterval(() => this.fetchState(), 500);
        setInterval(() => this.updateTimeDisplay(), 100);
    }

    updateTimeDisplay() {
        const interpolated = this.isPlaying
            ? this.elapsedTime + (Date.now() - this.fetchTimestamp) / 1000
            : this.elapsedTime;
        this.timeDisplay.textContent = this.formatTime(Math.min(interpolated, this.duration));
    }

    updateListenButton() {
        if (this.isListening) {
            this.listenButton.innerHTML = '&#9632; Stop';
            this.listenButton.classList.add('listening');
        } else {
            this.listenButton.innerHTML = '&#9654; Listen';
            this.listenButton.classList.remove('listening');
        }
    }

    updateUI() {
        // Toggle graphic reflects server broadcast state for all users
        if (this.isPlaying) {
            this.toggleButton.classList.add('on');
            this.toggleButton.classList.remove('off');
            this.toggleButton.querySelector('.switch-inner').textContent = 'ON';
        } else {
            this.toggleButton.classList.add('off');
            this.toggleButton.classList.remove('on');
            this.toggleButton.querySelector('.switch-inner').textContent = 'OFF';
        }

        // Listen button enabled only when broadcast is live
        this.listenButton.disabled = !this.isPlaying;

        // Broadcaster button label
        if (this.isAuthenticated) {
            this.playButton.innerHTML = this.isPlaying
                ? '&#9632; Stop Broadcast'
                : '&#9654; Start Broadcast';
        }

        this.updateTimeDisplay();
    }

    formatTime(seconds) {
        const s = Math.max(0, seconds);
        const minutes = Math.floor(s / 60);
        const secs = Math.floor(s % 60);
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    showMessage(text, status = 'default') {
        this.statusText.textContent = text;
        this.statusText.className = `status-text ${status}`;
    }

    showError(message) {
        this.errorMessage.textContent = message;
        this.errorContainer.style.display = 'block';
        console.error('Radio error:', message);
    }

    clearError() {
        this.errorContainer.style.display = 'none';
        this.errorMessage.textContent = '';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.radioPlayer = new RadioPlayer();
});
