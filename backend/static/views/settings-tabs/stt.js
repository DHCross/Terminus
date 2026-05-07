// settings-tabs/stt.js - Speech-to-text provider settings
import { renderProviderTab, attachProviderListeners } from '../../shared/provider-selector.js';

const tabConfig = {
    providerKey: 'STT_PROVIDER',
    disabledMessage: 'Speech-to-text is disabled. Select a provider above to enable voice input.',

    providers: {
        none: {
            label: 'Disabled',
            essentialKeys: [],
            advancedKeys: []
        },
        faster_whisper: {
            label: 'Local (Faster Whisper)',
            essentialKeys: ['STT_MODEL_SIZE'],
            advancedKeys: [
                'FASTER_WHISPER_DEVICE', 'FASTER_WHISPER_CUDA_DEVICE', 'FASTER_WHISPER_COMPUTE_TYPE',
                'FASTER_WHISPER_BEAM_SIZE', 'FASTER_WHISPER_NUM_WORKERS', 'FASTER_WHISPER_VAD_FILTER'
            ]
        },
        fireworks_whisper: {
            label: 'Fireworks Whisper',
            essentialKeys: ['STT_FIREWORKS_API_KEY', 'STT_FIREWORKS_MODEL'],
            advancedKeys: []
        },
        terminus_router: {
            label: 'Terminus Router',
            essentialKeys: ['SAPPHIRE_ROUTER_URL', 'SAPPHIRE_ROUTER_TENANT_ID'],
            advancedKeys: []
        }
    },

    // Shown for all active providers (recorder keys hidden in managed/Docker — no local mic)
    commonKeys: window.__managed
        ? ['STT_LANGUAGE']
        : ['STT_LANGUAGE', 'RECORDER_BACKGROUND_PERCENTILE', 'RECORDER_SILENCE_DURATION', 'RECORDER_MAX_SECONDS'],
    commonAdvancedKeys: window.__managed
        ? []
        : ['RECORDER_SILENCE_THRESHOLD', 'RECORDER_SPEECH_DURATION', 'RECORDER_BEEP_WAIT_TIME']
};

export default {
    id: 'stt',
    name: 'STT',
    icon: '\uD83C\uDFA4',
    description: 'Speech-to-text engine and voice detection',

    render(ctx) {
        return renderProviderTab(tabConfig, ctx);
    },

    attachListeners(ctx, el) {
        attachProviderListeners(tabConfig, ctx, el);
    }
};
