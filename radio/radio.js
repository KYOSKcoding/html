/**
 * Radio Player - Synchronized playback with password authentication
 * Only broadcaster can toggle ON/OFF, listeners are passive
 */

class RadioPlayer {
    constructor() {
        this.audioElement = document.getElementById('radioAudio');
        this.toggleButton = document.getElementById('toggleButton');
        this.statusText = document.getElementById('statusText');
        this.timeDisplay = document.getElementById('timeDisplay');
        this.errorContainer = document.getElementById('errorContainer');
        this.errorMessage = document.getElementById('errorMessage');
        this.listenerCount = document.getElementById('listenerCount');

        // Auth elements
        this.authSection = document.getElementById('authSection');
        this.passwordInput = document.getElementById('passwordInput');
        this.authButton = document.getElementById('authButton');
        this.authStatus = document.getElementById('authStatus');
        this.waitingMessage = document.getElementById('waitingMessage');
        this.waitingTime = document.getElementById('waitingTime');

        // API paths
        this.stateUrl = this.getApiUrl('/api/radio/state');
        this.toggleUrl = this.getApiUrl('/api/radio/toggle');
        this.authUrl = this.getApiUrl('/api/radio/auth');

        // State
        this.isPlaying = false;
        this.elapsedTime = 0;
        this.duration = 188.856; // Al_Bint_El_Shalabiya.mp3 duration
        this.pollInterval = 500;
        this.isPollActive = false;
        this.lastSyncTime = 0;
        this.syncThreshold = 0.5;

        // Auth state
        this.isAuthenticated = false;
        this.storedToken = localStorage.getItem('radio_auth_token');

        this.init();
    }

    /**
     * Determine correct API URL based on current location
     */
    getApiUrl(path) {
        const isLocal = window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1';

        if (isLocal) {
            return `http://localhost:5001${path}`;
        } else {
            // Production: Flask routes are prefixed with /kyosky/
            return `/kyosky${path}`;
        }
    }

    /**
     * Initialize the radio player
     */
    init() {
        this.authButton.addEventListener('click', () => this.handleAuth());
        this.passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleAuth();
        });

        this.toggleButton.addEventListener('click', () => this.handleToggle());

        // Set audio source dynamically so the correct URL is used in both local and production
        this.audioElement.src = this.getApiUrl('/api/radio/audio');

        // Prevent direct audio control
        this.audioElement.addEventListener('play', (e) => {
            if (!this.isPlaying) {
                e.preventDefault();
                this.audioElement.pause();
            }
        });

        this.audioElement.addEventListener('pause', (e) => {
            if (this.isPlaying) {
                e.preventDefault();
                this.audioElement.play().catch(err => console.log('Autoplay prevented:', err));
            }
        });

        // Check if already authenticated
        if (this.storedToken) {
            this.isAuthenticated = true;
            this.showBroadcasterControls();
        } else {
            this.showAuthSection();
        }

        // Start polling for state updates
        this.startPolling();
    }

    /**
     * Handle password authentication
     */
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
                // Store token for future visits
                localStorage.setItem('radio_auth_token', data.token);
                this.isAuthenticated = true;
                this.showBroadcasterControls();
                this.authStatus.textContent = '✓ Authenticated as broadcaster!';
                this.authStatus.className = 'auth-status success';
            } else {
                this.showAuthError('Incorrect password. Try again.');
            }
        } catch (error) {
            this.showAuthError(`Auth error: ${error.message}`);
        } finally {
            this.authButton.disabled = false;
        }
    }

    /**
     * Show authentication section for non-broadcasters
     */
    showAuthSection() {
        this.authSection.style.display = 'block';
        this.toggleButton.style.display = 'none';
        this.waitingMessage.style.display = 'block';
        this.showMessage('Connecting...', 'connecting');
    }

    /**
     * Show broadcaster controls
     */
    showBroadcasterControls() {
        this.authSection.style.display = 'none';
        this.toggleButton.style.display = 'flex';
        this.waitingMessage.style.display = 'none';
    }

    /**
     * Show authentication error
     */
    showAuthError(message) {
        this.authStatus.textContent = '✗ ' + message;
        this.authStatus.className = 'auth-status error';
    }

    /**
     * Handle toggle button click
     */
    async handleToggle() {
        this.toggleButton.disabled = true;

        try {
            const response = await fetch(this.toggleUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            this.isPlaying = data.is_playing;
            this.lastSyncTime = data.timestamp;

            await this.fetchState();
            this.clearError();
            this.updateUI();
        } catch (error) {
            console.error('Error toggling radio:', error);
            this.showError(`Failed to toggle: ${error.message}`);
        } finally {
            this.toggleButton.disabled = false;
        }
    }

    /**
     * Fetch current state from server
     */
    async fetchState() {
        try {
            const response = await fetch(this.stateUrl);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            this.isPlaying = data.is_playing;
            this.elapsedTime = data.elapsed_time;
            this.duration = data.audio_duration;
            this.lastSyncTime = data.timestamp;

            this.syncAudioElement();
            this.clearError();
            this.showMessage('Online', 'online');

            return true;
        } catch (error) {
            console.error('Error fetching radio state:', error);
            this.showError(`Connection error: ${error.message}`);
            this.showMessage('Offline', 'error');
            return false;
        }
    }

    /**
     * Sync audio element's currentTime to server's elapsed time
     */
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
            this.audioElement.play().catch(err => {
                console.warn('Autoplay prevented by browser:', err);
            });
        } else {
            this.audioElement.pause();
        }
    }

    /**
     * Start periodic sync of audio element
     */
    startPolling() {
        setInterval(() => this.syncAudioElement(), this.pollInterval);
        setInterval(() => this.fetchState(), this.pollInterval);

        // Update waiting time display
        setInterval(() => {
            this.waitingTime.textContent = this.formatTime(this.elapsedTime);
        }, 500);
    }

    /**
     * Update UI elements to reflect current state
     */
    updateUI() {
        // Update button state (only for broadcasters)
        if (this.isAuthenticated) {
            if (this.isPlaying) {
                this.toggleButton.classList.add('on');
                this.toggleButton.classList.remove('off');
                this.toggleButton.querySelector('.switch-inner').textContent = 'ON';
            } else {
                this.toggleButton.classList.add('off');
                this.toggleButton.classList.remove('on');
                this.toggleButton.querySelector('.switch-inner').textContent = 'OFF';
            }
        }

        // Update time display
        this.timeDisplay.textContent = this.formatTime(this.elapsedTime);
        this.waitingTime.textContent = this.formatTime(this.elapsedTime);
    }

    /**
     * Format seconds to MM:SS
     */
    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Show status message
     */
    showMessage(text, status = 'default') {
        this.statusText.textContent = text;
        this.statusText.className = `status-text ${status}`;
    }

    /**
     * Show error message
     */
    showError(message) {
        this.errorMessage.textContent = message;
        this.errorContainer.style.display = 'block';
        console.error('Radio error:', message);
    }

    /**
     * Clear error message
     */
    clearError() {
        this.errorContainer.style.display = 'none';
        this.errorMessage.textContent = '';
    }
}

// Initialize radio player when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.radioPlayer = new RadioPlayer();
});
