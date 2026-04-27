class RadioPlayer {
    constructor() {
        this.audioElement = document.getElementById('radioAudio');
        this.toggleButton = document.getElementById('toggleButton');
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

        // Playback state
        this.isPlaying = false;
        this.elapsedTime = 0;
        this.duration = 27.096;
        this.fetchTimestamp = Date.now();
        this.syncThreshold = 0.5;

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
        this.playButton.addEventListener('click', () => this.handlePlay());
        this.loginLink.addEventListener('click', (e) => {
            e.preventDefault();
            this.openModal();
        });
        this.modalClose.addEventListener('click', () => this.closeModal());
        // Close modal on backdrop click
        this.authModal.addEventListener('click', (e) => {
            if (e.target === this.authModal) this.closeModal();
        });

        if (this.storedToken) {
            this.isAuthenticated = true;
            this.showBroadcasterControls();
        }

        this.startPolling();
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

            // Immediately apply audio state without waiting for next poll
            this.syncAudioElement();
            this.updateUI();
            this.clearError();

            // Then sync from server to get accurate elapsed time
            await this.fetchState();
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
            this.isPlaying = data.is_playing;
            this.elapsedTime = data.elapsed_time;
            this.duration = data.audio_duration;
            this.fetchTimestamp = Date.now();

            this.syncAudioElement();
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

    syncAudioElement() {
        if (!this.audioElement) return;

        if (this.isPlaying) {
            if (this.audioElement.readyState >= this.audioElement.HAVE_FUTURE_DATA) {
                const timeDiff = Math.abs(this.audioElement.currentTime - this.elapsedTime);
                if (timeDiff > this.syncThreshold) {
                    try {
                        this.audioElement.currentTime = this.elapsedTime;
                    } catch (error) {
                        console.warn('Could not set currentTime:', error);
                    }
                }
            }
            if (this.audioElement.paused) {
                this.audioElement.play().catch(err => {
                    console.warn('Autoplay prevented by browser:', err);
                });
            }
        } else {
            if (!this.audioElement.paused) {
                this.audioElement.pause();
            }
        }
    }

    startPolling() {
        setInterval(() => this.fetchState(), 500);
        // Smooth time display between server polls
        setInterval(() => this.updateTimeDisplay(), 100);
    }

    updateTimeDisplay() {
        const interpolated = this.isPlaying
            ? this.elapsedTime + (Date.now() - this.fetchTimestamp) / 1000
            : this.elapsedTime;
        this.timeDisplay.textContent = this.formatTime(Math.min(interpolated, this.duration));
    }

    updateUI() {
        // Toggle graphic reflects broadcast state for all users
        if (this.isPlaying) {
            this.toggleButton.classList.add('on');
            this.toggleButton.classList.remove('off');
            this.toggleButton.querySelector('.switch-inner').textContent = 'ON';
        } else {
            this.toggleButton.classList.add('off');
            this.toggleButton.classList.remove('on');
            this.toggleButton.querySelector('.switch-inner').textContent = 'OFF';
        }

        // Play button label for broadcaster
        if (this.isAuthenticated) {
            this.playButton.innerHTML = this.isPlaying
                ? '&#9632; Stop'
                : '&#9654; Play';
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
