// views/journal.js - Journal browser view
import * as api from '../api.js';
import * as ui from '../ui.js';

let container = null;
let entries = [];
let activeEntry = '';

export default {
    init(el) { container = el; },
    async show() {
        await refresh();
    },
    hide() {}
};

async function refresh(preferredEntry = '') {
    if (!container) return;
    try {
        const data = await api.fetchJournalEntries();
        entries = Array.isArray(data?.entries) ? data.entries : [];
        if (preferredEntry && entries.includes(preferredEntry)) {
            activeEntry = preferredEntry;
        } else if (!activeEntry || !entries.includes(activeEntry)) {
            activeEntry = entries[0] || '';
        }
        await render();
    } catch (e) {
        container.innerHTML = `
            <div class="view-placeholder">
                <h2>Journal</h2>
                <p>Failed to load journal entries.</p>
            </div>
        `;
    }
}

async function render() {
    if (!container) return;

    container.innerHTML = `
        <div class="journal-view">
            <div class="view-header">
                <h2>Journal</h2>
                <div class="journal-actions">
                    <button class="btn-secondary" id="journal-refresh-btn">Refresh</button>
                </div>
            </div>
            <div class="journal-layout">
                <aside class="journal-list" id="journal-list"></aside>
                <section class="journal-content-wrap" id="journal-content-wrap"></section>
            </div>
        </div>
    `;

    const refreshBtn = container.querySelector('#journal-refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            await refresh(activeEntry);
            ui.showToast('Journal refreshed', 'success', 1500);
        });
    }

    renderList();
    await renderEntry();
}

function renderList() {
    const listEl = container?.querySelector('#journal-list');
    if (!listEl) return;

    if (!entries.length) {
        listEl.innerHTML = `<div class="journal-empty">No journal entries found yet.</div>`;
        return;
    }

    listEl.innerHTML = entries.map((filename) => `
        <button class="journal-list-item${filename === activeEntry ? ' active' : ''}" data-filename="${escapeHtml(filename)}">
            ${escapeHtml(filename)}
        </button>
    `).join('');

    listEl.querySelectorAll('.journal-list-item').forEach((btn) => {
        btn.addEventListener('click', async () => {
            activeEntry = btn.dataset.filename || '';
            renderList();
            await renderEntry();
        });
    });
}

async function renderEntry() {
    const wrap = container?.querySelector('#journal-content-wrap');
    if (!wrap) return;

    if (!activeEntry) {
        wrap.innerHTML = `<div class="journal-empty">Select an entry to view it.</div>`;
        return;
    }

    try {
        const data = await api.fetchJournalEntry(activeEntry);
        const content = String(data?.content || '').trim();
        wrap.innerHTML = `
            <div class="journal-content-header">
                <div class="journal-filename">${escapeHtml(activeEntry)}</div>
            </div>
            <pre class="journal-content">${escapeHtml(content || '(empty entry)')}</pre>
        `;
    } catch (e) {
        wrap.innerHTML = `
            <div class="journal-empty">Failed to load ${escapeHtml(activeEntry)}.</div>
        `;
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
