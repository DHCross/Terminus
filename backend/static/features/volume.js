// features/volume.js - Volume slider and mute controls
import * as audio from '../audio.js';
import { getElements } from '../core/state.js';

// Check TTS provider and update button state to reflect whether TTS is active.
// Shows a strikethrough audio icon when TTS_PROVIDER is "none".
async function applyTtsProviderState() {
    const { muteBtn } = getElements();
    if (!muteBtn) return;
    try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const data = await res.json();
        const provider = (data.settings?.TTS_PROVIDER || data.TTS_PROVIDER || '').toLowerCase();
        const lastProvider = localStorage.getItem('tts-last-provider');

        const ttsBtn = document.getElementById('tts-toggle-btn');
        if (provider && provider !== 'none') {
            // TTS is active — save provider so we can restore it later
            localStorage.setItem('tts-last-provider', provider);
            muteBtn.classList.remove('tts-off');
            muteBtn.title = 'Volume';
            if (ttsBtn) { ttsBtn.textContent = 'TTS: On'; ttsBtn.classList.remove('tts-btn-off'); }
        } else {
            // TTS is off
            muteBtn.classList.add('tts-off');
            muteBtn.title = 'TTS disabled — open volume to enable';
            muteBtn.textContent = '🔇';
            if (ttsBtn) { ttsBtn.textContent = 'TTS: Off'; ttsBtn.classList.add('tts-btn-off'); }
        }
    } catch (_) {}
}

export async function handleTtsProviderToggle() {
    const { muteBtn } = getElements();
    if (!muteBtn) return;

    const ttsBtn = document.getElementById('tts-toggle-btn');
    const isTtsOff = muteBtn.classList.contains('tts-off');
    if (isTtsOff) {
        // Re-enable: restore last known provider or default to 'elevenlabs'
        const provider = localStorage.getItem('tts-last-provider') || 'elevenlabs';
        try {
            await fetch('/api/settings/TTS_PROVIDER', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: provider })
            });
            muteBtn.classList.remove('tts-off');
            muteBtn.title = 'Volume';
            muteBtn.textContent = '🔊';
            if (ttsBtn) { ttsBtn.textContent = 'TTS: On'; ttsBtn.classList.remove('tts-btn-off'); }
        } catch (_) {}
    } else {
        // Disable TTS
        try {
            await fetch('/api/settings/TTS_PROVIDER', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: 'none' })
            });
            muteBtn.classList.add('tts-off');
            muteBtn.title = 'TTS disabled — open volume to enable';
            muteBtn.textContent = '🔇';
            if (ttsBtn) { ttsBtn.textContent = 'TTS: Off'; ttsBtn.classList.add('tts-btn-off'); }
        } catch (_) {}
    }
}

export function initVolumeControls() {
    const { volumeSlider, muteBtn } = getElements();

    const savedVolume = localStorage.getItem('terminus-volume');
    const savedMuted = localStorage.getItem('terminus-muted');

    if (savedVolume !== null) {
        const vol = parseInt(savedVolume, 10);
        volumeSlider.value = vol;
        audio.setVolume(vol / 100);
    }
    updateSliderFill();

    if (savedMuted === 'true') {
        audio.setMuted(true);
        muteBtn.textContent = '🔇';
        muteBtn.classList.add('muted');
    }

    // Check TTS provider status on load
    applyTtsProviderState();
}

export function updateSliderFill() {
    const { volumeSlider } = getElements();
    if (!volumeSlider) return;
    
    const val = parseInt(volumeSlider.value, 10);
    // Get computed colors - resolve actual color values
    const styles = getComputedStyle(document.documentElement);
    let fillColor = styles.getPropertyValue('--trim').trim();
    
    // If trim is transparent/empty/unset, use accent-blue
    if (!fillColor || fillColor === 'transparent' || fillColor.startsWith('var(')) {
        fillColor = styles.getPropertyValue('--accent-blue').trim() || '#0f766e';
    }
    
    // Resolve bg-tertiary to actual color
    let bgColor = styles.getPropertyValue('--bg-tertiary').trim() || '#2a2a2a';
    
    volumeSlider.style.background = `linear-gradient(to right, ${fillColor} 0%, ${fillColor} ${val}%, ${bgColor} ${val}%, ${bgColor} 100%)`;

}

export function handleVolumeChange() {
    const { volumeSlider, muteBtn } = getElements();
    const val = parseInt(volumeSlider.value, 10);
    
    audio.setVolume(val / 100);
    localStorage.setItem('terminus-volume', val);
    updateSliderFill();
    
    // Auto-unmute when adjusting volume
    if (audio.isMuted() && val > 0) {
        audio.setMuted(false);
        muteBtn.textContent = '🔊';
        muteBtn.classList.remove('muted');
        localStorage.setItem('terminus-muted', 'false');
    }
    
    // Update icon based on level
    if (!audio.isMuted()) {
        if (val === 0) muteBtn.textContent = '🔇';
        else if (val < 50) muteBtn.textContent = '🔉';
        else muteBtn.textContent = '🔊';
    }
}

export function handleMuteToggle() {
    const { volumeSlider, muteBtn } = getElements();
    const nowMuted = !audio.isMuted();
    
    audio.setMuted(nowMuted);
    localStorage.setItem('terminus-muted', nowMuted);
    
    if (nowMuted) {
        muteBtn.textContent = '🔇';
        muteBtn.classList.add('muted');
    } else {
        muteBtn.classList.remove('muted');
        const val = parseInt(volumeSlider.value, 10);
        if (val === 0) muteBtn.textContent = '🔇';
        else if (val < 50) muteBtn.textContent = '🔉';
        else muteBtn.textContent = '🔊';
    }
}