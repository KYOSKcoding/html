/**
 * Radio Player - Client-side synchronized playback
 * Uses localStorage to sync state across browser tabs/windows
 * No backend required
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

        // State
        this.isPlaying = false;
        this.elapsedTime = 0;
        this.duration = 201.552; // Antoine Villoutreix - Berlin.mp3 duration in seconds
        this.lastToggleTime = 0;
        this.syncInterval = 300; // milliseconds
        this.syncThreshold = 0.5; // seconds - threshold for sync correction

        // localStorage key
        this.storageKey = 'radio_state';

        this.init();
    }

    /**
     * Initialize the radio player
     */
    init() {
        this.toggleButton.addEventListener('click', () => this.handleToggle());

        // Prevent direct audio control - only server state controls playback
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

        // Listen for storage changes from other tabs
        window.addEventListener('storage', (e) => {
            if (e.key === this.storageKey) {
                console.log('Radio state changed in another tab');
                this.loadState();
                this.updateUI();
            }
        });

        // Load initial state and start syncing
        this.loadState();
        this.updateUI();
        this.startSyncing();

        this.showMessage('Ready', 'online');
    }

    /**
     * Load state from localStorage
     */
    loadState() {
        const stored = localStorage.getItem(this.storageKey);

        if (stored) {
            try {
                const state = JSON.parse(stored);
                this.isPlaying = state.is_playing;
                this.lastToggleTime = state.last_toggle_time;

                // Calculate current elapsed time
                if (this.isPlaying) {
                    const timeSinceToggle = (Date.now() - this.lastToggleTime) / 1000;
                    this.elapsedTime = (timeSinceToggle % this.duration);
                } else {
                    this.elapsedTime = 0;
                }
            } catch (error) {
                console.error('Error loading stored state:', error);
                this.initializeState();
            }
        } else {
            this.initializeState();
        }
    }

    /**
     * Initialize fresh state
     */
    initializeState() {
        this.isPlaying = false;
        this.lastToggleTime = Date.now();
        this.elapsedTime = 0;
        this.saveState();
    }

    /**
     * Save state to localStorage
     */
    saveState() {
        const state = {
            is_playing: this.isPlaying,
            last_toggle_time: this.lastToggleTime,
            duration: this.duration
        };
        localStorage.setItem(this.storageKey, JSON.stringify(state));
    }

    /**
     * Handle toggle button click
     */
    handleToggle() {
        this.toggleButton.disabled = true;

        try {
            this.isPlaying = !this.isPlaying;
            this.lastToggleTime = Date.now();
            this.saveState();

            this.clearError();
            this.updateUI();

            // Broadcast to other tabs
            window.dispatchEvent(new StorageEvent('storage', {
                key: this.storageKey,
                newValue: JSON.stringify({
                    is_playing: this.isPlaying,
                    last_toggle_time: this.lastToggleTime,
                    duration: this.duration
                })
            }));
        } catch (error) {
            console.error('Error toggling radio:', error);
            this.showError(`Failed to toggle: ${error.message}`);
        } finally {
            this.toggleButton.disabled = false;
        }
    }

    /**
     * Start periodic sync of audio element
     */
    startSyncing() {
        setInterval(() => this.syncAudioElement(), this.syncInterval);
    }

    /**
     * Sync audio element's currentTime to calculated elapsed time
     */
    syncAudioElement() {
        if (!this.audioElement) return;

        // Reload state to account for time passing
        this.loadState();

        // Check if audio is ready
        if (this.audioElement.readyState < this.audioElement.HAVE_FUTURE_DATA) {
            return;
        }

        const timeDiff = Math.abs(this.audioElement.currentTime - this.elapsedTime);

        // If difference exceeds threshold, resync
        if (timeDiff > this.syncThreshold) {
            try {
                this.audioElement.currentTime = this.elapsedTime;
                console.log(`Synced audio to ${this.elapsedTime.toFixed(2)}s`);
            } catch (error) {
                console.warn('Could not set currentTime:', error);
            }
        }

        // Play or pause based on state
        if (this.isPlaying) {
            this.audioElement.play().catch(err => {
                console.warn('Autoplay prevented by browser:', err);
            });
        } else {
            this.audioElement.pause();
        }

        this.updateUI();
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

        // Update listener count (placeholder - just shows sync is active)
        this.listenerCount.textContent = '✓';
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
        // Keep state stored for next visit
    });
