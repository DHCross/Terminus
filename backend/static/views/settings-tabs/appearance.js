// settings-tabs/appearance.js - Theme, density, font settings
// Appearance settings use localStorage (client-side only)
// Trim color is per-persona now — global default is cyan (#00cccc)

export default {
    id: 'appearance',
    name: 'Visual',
    icon: '\uD83C\uDFA8',
    description: 'Theme, spacing, and font settings',

    render(ctx) {
        const theme = localStorage.getItem('terminus-theme') || 'dark';
        const density = localStorage.getItem('terminus-density') || 'default';
        const font = localStorage.getItem('terminus-font') || 'system';
        const avatars = ctx.settings.AVATARS_IN_CHAT ?? true;

        return `<div class="settings-grid">
            <div class="setting-row">
                <div class="setting-label"><label>Theme</label><div class="setting-help">Color scheme</div></div>
                <div class="setting-input">
                    <select id="app-theme">
                        ${ctx.availableThemes.map(t => `<option value="${t}" ${t === theme ? 'selected' : ''}>${t.charAt(0).toUpperCase() + t.slice(1)}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div class="setting-row">
                <div class="setting-label"><label>Spacing</label><div class="setting-help">UI density</div></div>
                <div class="setting-input">
                    <select id="app-density">
                        <option value="compact" ${density === 'compact' ? 'selected' : ''}>Compact</option>
                        <option value="default" ${density === 'default' ? 'selected' : ''}>Default</option>
                        <option value="comfortable" ${density === 'comfortable' ? 'selected' : ''}>Comfortable</option>
                    </select>
                </div>
            </div>
            <div class="setting-row">
                <div class="setting-label"><label>Font</label><div class="setting-help">Text style</div></div>
                <div class="setting-input">
                    <select id="app-font">
                        <option value="system" ${font === 'system' ? 'selected' : ''}>System</option>
                        <option value="mono" ${font === 'mono' ? 'selected' : ''}>Monospace</option>
                        <option value="serif" ${font === 'serif' ? 'selected' : ''}>Serif</option>
                        <option value="rounded" ${font === 'rounded' ? 'selected' : ''}>Rounded</option>
                    </select>
                </div>
            </div>
            <div class="setting-row">
                <div class="setting-label"><label>Send Button</label><div class="setting-help">Use trim color vs provider indicator</div></div>
                <div class="setting-input">
                    <label class="setting-toggle">
                        <input type="checkbox" id="app-send-trim" ${localStorage.getItem('terminus-send-btn-trim') === 'true' ? 'checked' : ''}>
                        <span>Use trim color</span>
                    </label>
                </div>
            </div>
            <div class="setting-row" data-key="AVATARS_IN_CHAT">
                <div class="setting-label"><label>Avatars In Chat</label><div class="setting-help">Show avatars next to messages</div></div>
                <div class="setting-input">
                    <label class="setting-toggle">
                        <input type="checkbox" id="setting-AVATARS_IN_CHAT" data-key="AVATARS_IN_CHAT" ${avatars ? 'checked' : ''}>
                        <span>${avatars ? 'Enabled' : 'Disabled'}</span>
                    </label>
                </div>
            </div>
        </div>`;
    },

    attachListeners(ctx, el) {
        el.querySelector('#app-theme')?.addEventListener('change', e => {
            const theme = e.target.value;
            localStorage.setItem('terminus-theme', theme);
            document.documentElement.setAttribute('data-theme', theme);
            const link = document.getElementById('theme-stylesheet');
            if (link) link.href = `/static/themes/${theme}.css`;
            else {
                const l = document.createElement('link');
                l.id = 'theme-stylesheet'; l.rel = 'stylesheet';
                l.href = `/static/themes/${theme}.css`;
                document.head.appendChild(l);
            }
        });

        el.querySelector('#app-density')?.addEventListener('change', e => {
            const v = e.target.value;
            if (v === 'default') {
                document.documentElement.removeAttribute('data-density');
                localStorage.removeItem('terminus-density');
            } else {
                document.documentElement.setAttribute('data-density', v);
                localStorage.setItem('terminus-density', v);
            }
        });

        el.querySelector('#app-font')?.addEventListener('change', e => {
            const v = e.target.value;
            if (v === 'system') {
                document.documentElement.removeAttribute('data-font');
                localStorage.removeItem('terminus-font');
            } else {
                document.documentElement.setAttribute('data-font', v);
                localStorage.setItem('terminus-font', v);
            }
        });

        el.querySelector('#app-send-trim')?.addEventListener('change', e => {
            localStorage.setItem('terminus-send-btn-trim', e.target.checked);
            const sendBtn = document.getElementById('send-btn');
            if (sendBtn) sendBtn.classList.toggle('use-trim', e.target.checked);
        });
    }
};
