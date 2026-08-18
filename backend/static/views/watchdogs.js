// views/watchdogs.js - Watchdog agents panel (APScheduler-backed autonomous tasks)
// Talks to /api/tasks (the APScheduler system in core/scheduler.py), NOT the
// continuity task system (/api/continuity/tasks) used by views/schedule.js.
import { fetchWithTimeout } from '../shared/fetch.js';
import * as ui from '../ui.js';

let container = null;
let jobs = [];
let pollTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export default {
    init(el) { container = el; },
    async show() {
        await loadData();
        render();
        startPolling();
    },
    hide() { stopPolling(); }
};

function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
        await loadData();
        updateList();
    }, 8000);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function loadData() {
    try {
        const data = await fetchWithTimeout('/api/tasks');
        // Filter to custom tasks only (exclude built-in daily_brief/journal/compact/ping)
        const all = data.jobs || [];
        jobs = all.filter(j => !['daily_brief', 'journal_prompt', 'trace_compact', 'health_ping'].includes(j.id));
    } catch (e) {
        console.warn('Watchdogs load failed:', e);
        jobs = [];
    }
}

function render() {
    if (!container) return;
    container.innerHTML = `
        <div class="wd-view">
            <div class="view-header">
                <h2>Watchdogs</h2>
                <span class="view-subtitle" id="wd-subtitle"></span>
                <button class="btn-primary" id="wd-new-btn">+ New Watchdog</button>
            </div>
            <div class="view-body view-scroll">
                <div id="wd-list"></div>
                <div id="wd-log" class="wd-log-panel"></div>
            </div>
        </div>
    `;
    updateList();
    bindEvents();
}

function updateList() {
    const listEl = container?.querySelector('#wd-list');
    const subEl = container?.querySelector('#wd-subtitle');
    if (listEl) listEl.innerHTML = renderList();
    if (subEl) {
        const wdCount = jobs.filter(j => j.watchdog).length;
        const simpleCount = jobs.length - wdCount;
        subEl.innerHTML = `${jobs.length} active (${wdCount} watchdogs, ${simpleCount} simple)`;
    }
}

function renderList() {
    if (jobs.length === 0) {
        return `<div class="view-placeholder" style="padding:40px;text-align:center">
            <p style="color:var(--text-muted)">No watchdogs yet. A watchdog is an autonomous background agent that runs on a schedule with full tool access (browser, memory, desktop) and only notifies you when something changes.</p>
            <p style="color:var(--text-muted);font-size:var(--font-sm);margin-top:12px">Example: "Check the Indeed job page every 4 hours, notify me only on new security jobs in Panama City."</p>
        </div>`;
    }
    return jobs.map(j => {
        const wdBadge = j.watchdog
            ? '<span class="wd-badge wd-badge-on" title="Full tool access + memory de-duplication">WATCHDOG</span>'
            : '<span class="wd-badge wd-badge-off" title="Simple LLM-only reminder">SIMPLE</span>';
        const nextRun = j.next_run ? new Date(j.next_run).toLocaleString() : '—';
        const instr = j.instruction ? esc(j.instruction).slice(0, 180) : '';
        const schedDesc = j.schedule_desc || '';
        return `
            <div class="wd-card" data-id="${esc(j.id)}">
                <div class="wd-card-header">
                    <span class="wd-name">${esc(j.name)}</span>
                    ${wdBadge}
                </div>
                <div class="wd-schedule">${esc(schedDesc)} · next: ${esc(nextRun)}</div>
                ${instr ? `<div class="wd-instruction">${instr}${j.instruction && j.instruction.length > 180 ? '…' : ''}</div>` : ''}
                <div class="wd-actions">
                    <button class="btn-icon" data-action="run" data-id="${esc(j.id)}" title="Run now">▶</button>
                    <button class="btn-icon" data-action="log" data-id="${esc(j.id)}" title="View run log">📜</button>
                    <button class="btn-icon danger" data-action="delete" data-id="${esc(j.id)}" title="Delete">✕</button>
                </div>
            </div>`;
    }).join('');
}

function bindEvents() {
    container.querySelector('#wd-new-btn')?.addEventListener('click', () => openEditor());

    const listEl = container.querySelector('#wd-list');
    listEl?.addEventListener('click', async e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const { action, id } = btn.dataset;
        if (action === 'run') {
            try {
                await fetchWithTimeout(`/api/tasks/${encodeURIComponent(id)}/run`, { method: 'POST' });
                ui.showToast('Watchdog triggered', 'success');
            } catch { ui.showToast('Run failed', 'error'); }
        } else if (action === 'delete') {
            const job = jobs.find(j => j.id === id);
            if (!job || !confirm(`Delete "${job.name}"? This cancels the schedule and removes it.`)) return;
            try {
                await fetchWithTimeout(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
                ui.showToast('Deleted', 'success');
                await loadData(); updateList();
            } catch { ui.showToast('Delete failed', 'error'); }
        } else if (action === 'log') {
            await showLog(id);
        }
    });
}

async function showLog(jobId) {
    const logEl = container?.querySelector('#wd-log');
    if (!logEl) return;
    const job = jobs.find(j => j.id === jobId);
    logEl.innerHTML = `<div class="wd-log-header">Run log: ${esc(job?.name || jobId)} <button class="btn-icon" id="wd-log-close">✕</button></div><div class="wd-log-body" id="wd-log-body">Loading…</div>`;
    logEl.style.display = '';
    container.querySelector('#wd-log-close')?.addEventListener('click', () => { logEl.style.display = 'none'; logEl.innerHTML = ''; });
    try {
        const data = await fetchWithTimeout(`/api/tasks/${encodeURIComponent(jobId)}/log`);
        const entries = data.entries || [];
        const body = container.querySelector('#wd-log-body');
        if (!entries.length) {
            body.innerHTML = '<p class="text-muted" style="padding:12px">No runs logged yet.</p>';
            return;
        }
        body.innerHTML = entries.map(en => `<div class="wd-log-entry"><div class="wd-log-date">${esc(en.date)}</div><pre class="wd-log-pre">${esc(en.entry)}</pre></div>`).join('');
    } catch (e) {
        container.querySelector('#wd-log-body').innerHTML = `<p class="text-muted" style="padding:12px">Failed to load log: ${esc(e.message)}</p>`;
    }
}

function openEditor() {
    const overlay = document.createElement('div');
    overlay.className = 'wd-editor-overlay';
    overlay.innerHTML = `
        <div class="wd-editor">
            <h3>New Watchdog</h3>
            <label class="wd-field">
                <span class="wd-label">Name</span>
                <input type="text" id="wd-ed-name" placeholder="e.g. Indeed Panama City Security Jobs" />
            </label>
            <label class="wd-field">
                <span class="wd-label">Instruction</span>
                <textarea id="wd-ed-instruction" rows="4" placeholder="Open https://example.com/jobs, read the page, list any job titles containing 'security' that weren't in your last run. If nothing new, return NO_ACTION."></textarea>
            </label>
            <div class="wd-field-row">
                <label class="wd-field">
                    <span class="wd-label">Interval (minutes)</span>
                    <input type="number" id="wd-ed-interval" placeholder="240" min="1" />
                </label>
                <label class="wd-field">
                    <span class="wd-label">OR daily at (UTC hour 0-23)</span>
                    <input type="number" id="wd-ed-cron-hour" placeholder="9" min="0" max="23" />
                </label>
            </div>
            <label class="wd-checkbox">
                <input type="checkbox" id="wd-ed-watchdog" checked />
                <span>Watchdog mode (full tool access + memory de-duplication — only notify on changes)</span>
            </label>
            <div class="wd-editor-actions">
                <button class="btn-secondary" id="wd-ed-cancel">Cancel</button>
                <button class="btn-primary" id="wd-ed-save">Create</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#wd-ed-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#wd-ed-save').addEventListener('click', async () => {
        const name = overlay.querySelector('#wd-ed-name').value.trim();
        const instruction = overlay.querySelector('#wd-ed-instruction').value.trim();
        const interval = overlay.querySelector('#wd-ed-interval').value;
        const cronHour = overlay.querySelector('#wd-ed-cron-hour').value;
        const watchdog = overlay.querySelector('#wd-ed-watchdog').checked;
        if (!name || !instruction) { ui.showToast('Name and instruction are required', 'error'); return; }
        if (!interval && !cronHour) { ui.showToast('Set either interval (minutes) or daily hour', 'error'); return; }
        const body = {
            name, instruction, watchdog,
            interval_minutes: interval ? parseInt(interval, 10) : null,
            cron_hour: cronHour ? parseInt(cronHour, 10) : null,
        };
        try {
            await fetchWithTimeout('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            ui.showToast('Watchdog created', 'success');
            overlay.remove();
            await loadData(); updateList();
        } catch (e) {
            ui.showToast(`Create failed: ${e.message}`, 'error');
        }
    });
}
