// tabs/identity.js - User and AI identity setup

import { updateSetting } from '../setup-api.js';

export default {
  id: 'identity',
  name: 'Identity',
  icon: '👤',

  render(settings) {
    const userName = settings.DEFAULT_USERNAME || 'Human Protagonist';
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    return `
      <div class="identity-section">
        <div class="identity-field">
          <label for="setup-user-name">Your Name</label>
          <input type="text" id="setup-user-name" class="identity-input"
                 value="${userName}" placeholder="What should Terminus call you?">
        </div>
        <div class="identity-field" style="margin-top:16px">
          <label>Timezone</label>
          <div style="font-size:0.95em;padding:8px 0">${browserTz.replace(/_/g, ' ')}</div>
          <div style="font-size:0.8em;color:var(--text-muted)">Auto-detected from your browser. Change later in Settings.</div>
        </div>
      </div>
    `;
  },

  attachListeners(container, settings, updateSettings) {
    const userInput = container.querySelector('#setup-user-name');

    const saveField = async (key, value) => {
      if (!value) return;
      try {
        await updateSetting(key, value);
        settings[key] = value;
      } catch (err) {
        console.error(`Failed to save ${key}:`, err);
      }
    };

    userInput?.addEventListener('blur', () => saveField('DEFAULT_USERNAME', userInput.value.trim()));
    userInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveField('DEFAULT_USERNAME', userInput.value.trim());
      }
    });
  },

  async validate(settings) {
    // Save username
    const userInput = document.querySelector('#setup-user-name');
    if (userInput?.value.trim()) {
      try {
        await updateSetting('DEFAULT_USERNAME', userInput.value.trim());
        settings.DEFAULT_USERNAME = userInput.value.trim();
      } catch (e) {
        console.error('[Setup] Failed to save username:', e);
      }
    }

    // Save browser timezone if not already set
    const currentTz = settings.USER_TIMEZONE;
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    console.log('[Setup] TZ check — current:', currentTz, 'browser:', browserTz);
    const isDefaultTz = !currentTz || currentTz === 'UTC' || currentTz === 'Etc/UTC';
    if (isDefaultTz) {
      if (browserTz && browserTz !== 'UTC') {
        try {
          console.log('[Setup] Saving timezone:', browserTz);
          await updateSetting('USER_TIMEZONE', browserTz);
          settings.USER_TIMEZONE = browserTz;
          console.log('[Setup] Timezone saved successfully');
        } catch (e) {
          console.error('[Setup] Failed to save timezone:', e);
        }
      }
    }

    return { valid: true };
  }
};