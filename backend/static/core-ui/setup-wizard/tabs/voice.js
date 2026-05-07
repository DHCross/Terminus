// tabs/voice.js - Voice feature setup (TTS, STT, Wakeword)

import { checkPackages, updateSetting, checkProviderStatus } from '../setup-api.js';
import { updateScene } from '../../../features/scene.js';

let packageStatus = {};

// Provider definitions
const STT_PROVIDERS = {
  none:              { label: 'Disabled', needsPackage: false },
  faster_whisper:    { label: 'Local (Faster Whisper)', needsPackage: 'stt', downloadLabel: 'STT' },
  fireworks_whisper: { label: 'Fireworks Whisper (Cloud)', needsPackage: false, needsKey: true, keyField: 'STT_FIREWORKS_API_KEY', keyPlaceholder: 'Fireworks API key (fireworks.ai)' },
};

const TTS_PROVIDERS = {
  none:       { label: 'Disabled', needsPackage: false },
  kokoro:     { label: 'Local (Kokoro)', needsPackage: 'tts', downloadLabel: 'Kokoro TTS' },
  elevenlabs: { label: 'ElevenLabs (Cloud)', needsPackage: false, needsKey: true, keyField: 'TTS_ELEVENLABS_API_KEY', keyPlaceholder: 'ElevenLabs API key (elevenlabs.io)' },
};

const PROVIDER_MAP = {
  STT_PROVIDER: STT_PROVIDERS,
  TTS_PROVIDER: TTS_PROVIDERS,
};

function renderProviderCard(icon, title, desc, settingKey, currentValue, providers) {
  const isActive = currentValue && currentValue !== 'none';
  const options = Object.entries(providers)
    .map(([val, def]) => `<option value="${val}" ${val === currentValue ? 'selected' : ''}>${def.label}</option>`)
    .join('');

  const providerDef = providers[currentValue] || providers.none;

  let body = '';
  if (providerDef.needsPackage) {
    body = `<div class="package-status checking" data-package="${providerDef.needsPackage}">
      <span class="spinner">&midcir;</span> Checking ${providerDef.label}...
    </div>`;
  }
  if (providerDef.needsKey) {
    body = `<div class="provider-key-row">
      <input type="password" class="provider-key-input" data-key-setting="${providerDef.keyField}"
        placeholder="${providerDef.keyPlaceholder}" value="" autocomplete="off">
      <span class="key-status" data-key-status="${providerDef.keyField}"></span>
    </div>`;
  }

  return `
    <div class="feature-card ${isActive ? 'enabled' : ''}" data-feature="${settingKey}">
      <div class="feature-card-header">
        <span class="feature-icon">${icon}</span>
        <div class="feature-info">
          <h4>${title}</h4>
          <p>${desc}</p>
        </div>
        <select class="provider-select" data-provider="${settingKey}">${options}</select>
      </div>
      ${body}
    </div>
  `;
}

export default {
  id: 'voice',
  name: 'Voice',
  icon: '\uD83D\uDDE3\uFE0F',

  async render(settings, opts = {}) {
    const sttProvider = settings.STT_PROVIDER || 'none';
    const ttsProvider = settings.TTS_PROVIDER || 'none';
    const wakewordEnabled = settings.WAKE_WORD_ENABLED || false;

    const wakewordCard = opts.docker ? '' : `
      <!-- Wake Word -->
      <div class="feature-card ${wakewordEnabled ? 'enabled' : ''}" data-feature="wakeword">
        <div class="feature-card-header">
          <span class="feature-icon">\uD83C\uDFB5</span>
          <div class="feature-info">
            <h4>Wake Word</h4>
            <p>Say "Hey Terminus" to start talking anytime</p>
          </div>
          <label class="feature-toggle">
            <input type="checkbox" data-setting="WAKE_WORD_ENABLED" ${wakewordEnabled ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
        <div class="package-status checking" data-package="wakeword">
          <span class="spinner">&midcir;</span> Checking OpenWakeWord...
        </div>
      </div>
    `;

    return `
      ${renderProviderCard('\uD83C\uDFA4', 'Speech Recognition', 'Talk to Terminus using your voice', 'STT_PROVIDER', sttProvider, STT_PROVIDERS)}

      ${renderProviderCard('\uD83D\uDD0A', 'Voice Responses', 'Terminus speaks back to you', 'TTS_PROVIDER', ttsProvider, TTS_PROVIDERS)}

      ${wakewordCard}
    `;
  },

  attachListeners(container, settings, updateSettings) {
    this.loadPackageStatus(container);

    // Provider dropdowns (STT + TTS)
    container.querySelectorAll('.provider-select').forEach(select => {
      select.addEventListener('change', async (e) => {
        const settingKey = e.target.dataset.provider;
        const value = e.target.value;
        const card = e.target.closest('.feature-card');
        const providers = PROVIDER_MAP[settingKey] || {};
        const providerDef = providers[value] || {};
        const isLocal = !!providerDef.needsPackage;

        // Show download status for local providers
        if (isLocal) {
          const pkgStatus = card.querySelector('.package-status');
          if (pkgStatus) {
            pkgStatus.className = 'package-status checking';
            pkgStatus.dataset.downloading = 'true';
            pkgStatus.innerHTML = `<span class="spinner">&midcir;</span> Downloading ${providerDef.downloadLabel || 'models'}, please wait...`;
          }
        }

        try {
          // Local providers: fire-and-forget so UI isn't blocked during model download
          await updateSetting(settingKey, value, { async: isLocal });
          settings[settingKey] = value;

          card.classList.toggle('enabled', value !== 'none');

          // Re-render card body for new provider
          this._updateCardBody(card, settingKey, value, providers);

          // For local providers, poll until the provider reports ready
          if (isLocal) {
            this._pollProviderReady(container, settingKey, providerDef);
          } else if (providerDef.needsPackage) {
            this.loadPackageStatus(container);
          }

          updateScene();
        } catch (err) {
          console.error('Failed to update provider:', err);
          e.target.value = settings[settingKey] || 'none';
        }
      });
    });

    // API key inputs (delegated — cards get re-rendered)
    container.addEventListener('change', async (e) => {
      const keyInput = e.target.closest('.provider-key-input');
      if (!keyInput) return;
      const keySetting = keyInput.dataset.keySetting;
      const value = keyInput.value.trim();
      const status = container.querySelector(`[data-key-status="${keySetting}"]`);

      try {
        await updateSetting(keySetting, value);
        settings[keySetting] = value;
        if (status) {
          status.textContent = value ? '\u2713 Saved' : '';
          status.style.color = 'var(--accent-green, #5cb85c)';
        }
      } catch (err) {
        if (status) {
          status.textContent = '\u2717 Failed';
          status.style.color = 'var(--error, #d9534f)';
        }
      }
    });

    // Toggle checkboxes (Wakeword)
    container.querySelectorAll('.feature-toggle input').forEach(toggle => {
      toggle.addEventListener('change', async (e) => {
        const settingKey = e.target.dataset.setting;
        const enabled = e.target.checked;
        const card = e.target.closest('.feature-card');
        const pkgStatus = card.querySelector('.package-status');

        const needsDownload = enabled && settingKey === 'WAKE_WORD_ENABLED';
        if (needsDownload && pkgStatus) {
          pkgStatus.className = 'package-status checking';
          pkgStatus.dataset.downloading = 'true';
          pkgStatus.innerHTML = `<span class="spinner">&midcir;</span> Downloading wakeword models, please wait...`;
        }

        try {
          await updateSetting(settingKey, enabled);
          settings[settingKey] = enabled;
          card.classList.toggle('enabled', enabled);

          if (needsDownload && pkgStatus) {
            delete pkgStatus.dataset.downloading;
            pkgStatus.className = 'package-status installed';
            pkgStatus.innerHTML = `<span class="status-icon">\u2713</span> Models loaded successfully`;
          }
          updateScene();
        } catch (err) {
          console.error('Failed to update setting:', err);
          e.target.checked = !enabled;
          if (needsDownload && pkgStatus) {
            delete pkgStatus.dataset.downloading;
            pkgStatus.className = 'package-status not-installed';
            pkgStatus.innerHTML = `<span class="status-icon">\u2717</span> Failed to load models`;
          }
        }
      });
    });

    // Copy buttons
    container.addEventListener('click', (e) => {
      if (e.target.classList.contains('copy-btn')) {
        e.stopPropagation();
        const text = e.target.dataset.copy;
        navigator.clipboard.writeText(text).then(() => {
          const original = e.target.textContent;
          e.target.textContent = 'Copied!';
          setTimeout(() => e.target.textContent = original, 1500);
        });
      }
    });
  },

  _updateCardBody(card, settingKey, value, providers) {
    const providerDef = providers[value] || {};
    // Remove existing body content (package-status, key-row)
    card.querySelectorAll('.package-status, .provider-key-row').forEach(el => el.remove());

    if (providerDef.needsPackage) {
      card.insertAdjacentHTML('beforeend',
        `<div class="package-status checking" data-package="${providerDef.needsPackage}" data-downloading="true">
          <span class="spinner">&midcir;</span> Downloading ${providerDef.downloadLabel || providerDef.label}, please wait...
        </div>`);
    }
    if (providerDef.needsKey) {
      card.insertAdjacentHTML('beforeend',
        `<div class="provider-key-row">
          <input type="password" class="provider-key-input" data-key-setting="${providerDef.keyField}"
            placeholder="${providerDef.keyPlaceholder}" autocomplete="off">
          <span class="key-status" data-key-status="${providerDef.keyField}"></span>
        </div>`);
    }
  },

  _pollProviderReady(container, settingKey, providerDef) {
    // Poll provider-status endpoint until the provider reports ready
    const statusKey = settingKey === 'STT_PROVIDER' ? 'stt' : 'tts';
    const pkgKey = providerDef.needsPackage;
    let attempts = 0;
    const maxAttempts = 120; // 6 minutes at 3s intervals

    const poll = async () => {
      attempts++;
      try {
        const status = await checkProviderStatus();
        if (status[statusKey] === 'ready') {
          // Provider is loaded — show success
          const statusEl = container.querySelector(`[data-package="${pkgKey}"]`);
          if (statusEl) {
            delete statusEl.dataset.downloading;
            statusEl.className = 'package-status installed';
            statusEl.innerHTML = `<span class="status-icon">\u2713</span> ${providerDef.downloadLabel || 'Models'} loaded successfully`;
          }
          return;
        }
      } catch (e) {
        // Network error — keep polling
      }

      if (attempts < maxAttempts) {
        setTimeout(poll, 3000);
      } else {
        const statusEl = container.querySelector(`[data-package="${pkgKey}"]`);
        if (statusEl) {
          delete statusEl.dataset.downloading;
          statusEl.className = 'package-status not-installed';
          statusEl.innerHTML = `<span class="status-icon">\u2717</span> Download timed out — try restarting Terminus`;
        }
      }
    };

    // Start polling after a brief delay
    setTimeout(poll, 2000);
  },

  async loadPackageStatus(container) {
    try {
      packageStatus = await checkPackages();

      for (const [key, info] of Object.entries(packageStatus)) {
        const statusEl = container.querySelector(`[data-package="${key}"]`);
        if (!statusEl) continue;
        if (statusEl.dataset.downloading) continue;

        statusEl.classList.remove('checking');

        if (info.installed) {
          statusEl.classList.add('installed');
          statusEl.innerHTML = `\u2713 ${info.package || key} is installed and ready to use`;
        } else {
          statusEl.classList.add('not-installed');
          const requirements = info.requirements || `requirements-${key}.txt`;
          statusEl.innerHTML = `
            <div>\u26A0\uFE0F Requires ${info.package || key} - install to enable this feature:</div>
            <div class="pip-command">
              <code>pip install -r ${requirements}</code>
              <button class="copy-btn" data-copy="pip install -r ${requirements}">Copy</button>
            </div>
          `;
        }
      }
    } catch (e) {
      console.warn('Could not check packages:', e);
      container.querySelectorAll('.package-status.checking').forEach(el => {
        el.classList.remove('checking');
        el.innerHTML = `\u26A0\uFE0F Could not check package status`;
      });
    }
  },

  validate(settings) {
    return { valid: true };
  }
};
