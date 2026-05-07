// settings-tabs/tts.js - Text-to-speech provider settings
import { renderProviderTab, attachProviderListeners } from '../../shared/provider-selector.js';

const tabConfig = {
    providerKey: 'TTS_PROVIDER',
    disabledMessage: 'Text-to-speech is disabled. Select a provider above to enable voice output.',

    providers: {
        none: {
            label: 'Disabled',
            essentialKeys: [],
            advancedKeys: []
        },
        kokoro: {
            label: 'Local (Kokoro)',
            essentialKeys: [],
            advancedKeys: [
                'TTS_SERVER_HOST', 'TTS_SERVER_PORT',
                'TTS_PRIMARY_SERVER', 'TTS_FALLBACK_SERVER', 'TTS_FALLBACK_TIMEOUT'
            ]
        },
        elevenlabs: {
            label: 'ElevenLabs (Cloud)',
            essentialKeys: ['TTS_ELEVENLABS_API_KEY', 'TTS_ELEVENLABS_MODEL', 'TTS_ELEVENLABS_VOICE_ID'],
            advancedKeys: []
        },
        terminus_router: {
            label: 'Terminus Router',
            essentialKeys: ['SAPPHIRE_ROUTER_URL', 'SAPPHIRE_ROUTER_TENANT_ID'],
            advancedKeys: []
        }
    },

    commonKeys: [],
    commonAdvancedKeys: []
};

export default {
    id: 'tts',
    name: 'TTS',
    icon: '\uD83D\uDD0A',
    description: 'Text-to-speech engine configuration',

    render(ctx) {
        let html = renderProviderTab(tabConfig, ctx);
        html += `
            <div class="settings-grid" style="margin-top: 1rem;">
                <div class="setting-row full-width">
                    <button id="tts-test-btn" class="btn btn-secondary" style="width: auto;">
                        Test TTS
                    </button>
                    <span id="tts-test-result" style="margin-left: 0.75rem; font-size: var(--font-sm);"></span>
                </div>
            </div>`;
        return html;
    },

    attachListeners(ctx, el) {
        attachProviderListeners(tabConfig, ctx, el, this);

        const btn = el.querySelector('#tts-test-btn');
        const result = el.querySelector('#tts-test-result');
        if (btn) btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Testing...';
            result.textContent = '';
            result.style.color = '';
            try {
                const res = await fetch('/api/tts/test', { method: 'POST' });
                if (!res.ok) throw new Error(`Server error (${res.status})`);
                const data = await res.json();
                if (data.success) {
                    result.style.color = 'var(--color-success, #4caf50)';
                    result.textContent = `${data.provider} — ${data.ms}ms`;
                } else {
                    result.style.color = 'var(--color-error, #f44336)';
                    result.textContent = data.error || 'Test failed';
                }
            } catch (e) {
                result.style.color = 'var(--color-error, #f44336)';
                result.textContent = `Error: ${e.message}`;
            }
            btn.disabled = false;
            btn.textContent = 'Test TTS';
        });
    }
};
