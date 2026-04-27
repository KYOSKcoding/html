/**
 * Radio Player - Synchronized playback across multiple clients
 * Polls server for state and syncs audio element to shared playback position
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

        // API paths
        this.stateUrl = this.getApiUrl('/api/radio/state');
        this.toggleUrl = this.getApiUrl('/api/radio/toggle');

        // State
        this.isPlaying = false;
        this.elapsedTime = 0;
        this.duration = 201.552;
        this.pollInterval = 500; // milliseconds
        this.isPollActive = false;
        this.lastSyncTime = 0;
        this.syncThreshold = 0.5; // seconds - threshold for sync correction

        this.init();
    }

    /**
     * Determine correct API URL based on current location
     */
    getApiUrl(path) {
        const isLocal = window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1';

        if (isLocal) {
            // Local development - use localhost:5001
            return `http://localhost:5001${path}`;
        } else {
            // Production - use relative path
            return path;
        }
    }

    /**
     * Initialize the radio player
     */
    init() {
        this.toggleButton.addEventListener('click', () => this.handleToggle());

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

        // Start polling for state updates
        this.startPolling();

        this.showMessage('Connecting to server...', 'connecting');
    }

    /**
     * Handle toggle button click
     */
    async handleToggle() {
        this.toggleButton.disabled = true;

        try {
            const response = await fetch(this.toggleUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            this.isPlaying = data.is_playing;
            this.lastSyncTime = data.timestamp;

            // Immediately fetch new state to sync
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

            // Sync audio element to server position
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

        // Check if audio is ready
        if (this.audioElement.readyState < this.audioElement.HAVE_FUTURE_DATA) {
            // Audio not ready, try again soon
            setTimeout(() => this.syncAudioElement(), 100);
            return;
        }

        const timeDiff = Math.abs(this.audioElement.currentTime - this.elapsedTime);

        // If difference exceeds threshold, resync
        if (timeDiff > this.syncThreshold) {
            try {
                this.audioElement.currentTime = this.elapsedTime;
                console.log(`Synced audio to ${this.elapsedTime.toFixed(2)}s (was ${(this.audioElement.currentTime - timeDiff).toFixed(2)}s)`);
            } catch (error) {
                console.warn('Could not set currentTime:', error);
            }
        }

        // Play or pause based on server state
        if (this.isPlaying) {
            this.audioElement.play().catch(err => {
                console.warn('Autoplay prevented by browser:', err);
            });
        } else {
            this.audioElement.pause();
        }
    }

    /**
     * Start polling for state updates
     */
    startPolling() {
        if (this.isPollActive) return;
        this.isPollActive = true;

        const poll = async () => {
            if (!this.isPollActive) return;

            await this.fetchState();
            this.updateUI();

            // Schedule next poll
            setTimeout(poll, this.pollInterval);
        };

        poll();
    }

    /**
     * Stop polling for state updates
     */
    stopPolling() {
        this.isPollActive = false;
    }

    /**
     * Update UI elements to reflect current state
     */
    updateUI() {
        // Update button state
        if (this.isPlaying) {
            this.toggleButton.classList.add('on');
            this.toggleButton.classList.remove('off');
            this.toggleButton.querySelector('.switch-inner').textContent = 'ON';
        } else {
            this.toggleButton.classList.add('off');
            this.toggleButton.classList.remove('on');
            this.toggleButton.querySelector('.switch-inner').textContent = 'OFF';
        }

        // Update time display
        this.timeDisplay.textContent = this.formatTime(this.elapsedTime);

        // Update listener count (placeholder)
        this.listenerCount.textContent = '∞';
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

// Cleanup on page unload
window.addEventListener('unload', () => {
    if (window.radioPlayer) {
        window.radioPlayer.stopPolling();
    }
});
