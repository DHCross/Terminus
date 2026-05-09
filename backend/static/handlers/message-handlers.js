// handlers/message-handlers.js - Trash, regenerate, edit, continue, replay handlers
import * as api from '../api.js';
import * as ui from '../ui.js';
import * as audio from '../audio.js';
import * as chat from '../chat.js';
import { 
    getIsProc, 
    getTtsEnabled,
    setProc, 
    setAbortController, 
    setIsCancelling,
    getIsCancelling,
    refresh,
    setHistLen,
    getHistLen
} from '../core/state.js';

export async function handleTrash(idx) {
    console.log(`Trashing from message ${idx}`);
    const len = await chat.handleTrash(idx, refresh);
    if (len !== null) setHistLen(len);
}

export async function handleRegen(idx) {
    if (getIsProc()) {
        console.log('Regenerate blocked: isProc is true');
        return;
    }
    console.log(`Regenerating message ${idx}`);
    
    const abortController = new AbortController();
    setAbortController(abortController);
    setIsCancelling(false);
    
    const audioFn = getTtsEnabled() ? audio.playText : null;
    
    const len = await chat.handleRegen(
        idx, 
        setProc, 
        audioFn, 
        refresh, 
        abortController,
        getIsCancelling
    );
    
    if (len !== null) setHistLen(len);
}

export async function handleEdit(idx) {
    const hist = await api.fetchHistory();
    const msg = hist[idx];
    const msgEl = document.querySelectorAll('#chat-container .message:not(.status):not(.error)')[idx];
    
    ui.enterEditMode(msgEl, idx, msg.timestamp);
    
    document.getElementById('save-edit').onclick = async () => {
        const newText = document.getElementById('edit-textarea').value;
        const timestamp = msgEl.dataset.editTimestamp;

        try {
            console.log('[EDIT DEBUG] Editing message with timestamp:', timestamp);
            await api.editMessage(msg.role, timestamp, newText);
            // refresh() rebuilds DOM, so exitEditMode not needed - new elements won't have edit state
            await refresh(false);
        } catch (e) {
            console.error('Edit failed:', e);
            ui.showToast(`Edit failed: ${e.message}`, 'error');
            ui.exitEditMode(msgEl, true);  // Restore on error (element still exists)
        }
    };
    
    document.getElementById('cancel-edit').onclick = () => ui.exitEditMode(msgEl, true);
}

export async function handleContinue(idx) {
    if (getIsProc()) {
        console.log('Continue blocked: isProc is true');
        return;
    }
    console.log(`Continuing message ${idx}`);
    
    const abortController = new AbortController();
    setAbortController(abortController);
    setIsCancelling(false);
    
    const audioFn = getTtsEnabled() ? audio.playText : null;
    
    const len = await chat.handleContinue(
        idx, 
        setProc, 
        audioFn, 
        refresh, 
        abortController,
        getIsCancelling
    );
    
    if (len !== null) setHistLen(len);
}

export async function handleReplay(idx) {
    if (audio.isTtsPlaying()) {
        audio.stop(true);
        return;
    }
    console.log(`Replaying TTS for message ${idx}`);
    await audio.replayTts(idx);
}

function stripHiddenThinking(text) {
    if (!text) return '';

    return text
        .replace(/<(?:seed:)?think[^>]*>[\s\S]*?<\/(?:seed:think|seed:cot_budget_reflect|think)>/gi, '')
        .replace(/<(?:seed:)?think[^>]*>[\s\S]*$/gi, '')
        .replace(/^([\s\S]*?)<\/(?:seed:think|seed:cot_budget_reflect|think)>/gi, '')
        .trim();
}

function contentToMarkdown(content) {
    if (!content) return '';

    if (typeof content === 'string') {
        return stripHiddenThinking(content);
    }

    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (!part || typeof part !== 'object') return '';
                if (part.type === 'text') return part.text || '';
                if (part.type === 'file') {
                    const filename = part.filename ? `File: ${part.filename}\n\n` : '';
                    return `${filename}${part.text || ''}`.trim();
                }
                return '';
            })
            .filter(Boolean)
            .join('\n\n')
            .trim();
    }

    return String(content).trim();
}

function stripMarkdownForTopic(text) {
    return String(text || '')
        .replace(/^\s*[>#*\-\d.\[\]()_`~]+\s*/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function inferTopic(text, fallback = 'Journal Entry') {
    const clean = stripMarkdownForTopic(text);
    if (!clean) return fallback;
    return clean.length > 64 ? `${clean.slice(0, 64).trimEnd()}...` : clean;
}

function getMessageText(msg) {
    if (!msg) return '';

    let markdown = contentToMarkdown(msg.content);
    if (!markdown && Array.isArray(msg.parts)) {
        markdown = msg.parts
            .filter(p => p && p.type === 'content' && p.text)
            .map(p => stripHiddenThinking(p.text))
            .join('\n\n')
            .trim();
    }
    return stripHiddenThinking(markdown || '');
}

function buildThreadSummary(history, upToIdx) {
    const slice = (Array.isArray(history) ? history : []).slice(0, upToIdx + 1);
    const userTurns = slice.filter(m => m && m.role === 'user');
    const assistantTurns = slice.filter(m => m && m.role === 'assistant');

    const asks = userTurns
        .slice(-4)
        .map(m => getMessageText(m))
        .filter(Boolean)
        .map(t => `- ${inferTopic(t, 'User ask')}`);

    const highlights = assistantTurns
        .slice(-4)
        .map(m => getMessageText(m))
        .filter(Boolean)
        .map(t => `- ${inferTopic(t, 'Assistant response')}`);

    const summaryLines = [
        '### Thread Summary',
        '',
        `- Messages reviewed: ${slice.length}`,
        `- User turns: ${userTurns.length}`,
        `- Assistant turns: ${assistantTurns.length}`,
        ''
    ];

    if (asks.length) {
        summaryLines.push('#### Recent User Asks');
        summaryLines.push(...asks);
        summaryLines.push('');
    }

    if (highlights.length) {
        summaryLines.push('#### Key Assistant Points');
        summaryLines.push(...highlights);
        summaryLines.push('');
    }

    return summaryLines.join('\n').trim();
}

function toQuotedMarkdown(text) {
    const lines = String(text || '').split(/\r?\n/);
    return lines.map(line => (line ? `> ${line}` : '>')).join('\n');
}

function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function getActiveTopicFolder() {
    const input = document.getElementById('topic-folder-input');
    return String(input?.value || '').trim();
}

export async function handleCopyMarkdown(idx, button = null) {
    try {
        const domMsg = button?.closest?.('.message');
        if (domMsg) {
            if (!domMsg.classList.contains('assistant')) {
                ui.showToast('Only assistant responses can be copied as markdown', 'error');
                return;
            }
            const contentEl = domMsg.querySelector('.message-content');
            const clone = contentEl?.cloneNode(true);
            if (clone) {
                clone.querySelectorAll('details, .tool-block, .message-metadata, .toolbar').forEach(e => e.remove());
                const markdown = clone.textContent.trim();
                if (markdown) {
                    await navigator.clipboard.writeText(markdown);
                    ui.showToast('Copied markdown', 'success', 2000);
                    return;
                }
            }
        }

        const hist = await api.fetchHistory();
        const msg = hist[idx];
        if (!msg || msg.role !== 'assistant') {
            ui.showToast('Only assistant responses can be copied as markdown', 'error');
            return;
        }

        // Try msg.content first; fall back to msg.parts (display format)
        let markdown = contentToMarkdown(msg.content);
        if (!markdown && msg.parts) {
            markdown = msg.parts
                .filter(p => p.type === 'content' && p.text)
                .map(p => stripHiddenThinking(p.text))
                .join('\n\n')
                .trim();
        }
        if (!markdown) {
            ui.showToast('No markdown content found to copy', 'error');
            return;
        }

        await navigator.clipboard.writeText(markdown);
        ui.showToast('Copied markdown', 'success', 2000);
    } catch (e) {
        console.error('Copy markdown failed:', e);
        ui.showToast('Copy failed', 'error');
    }
}

export async function handleSaveJournal(idx) {
    try {
        const hist = await api.fetchHistory();
        const msg = hist[idx];
        if (!msg || msg.role !== 'assistant') {
            ui.showToast('Only assistant responses can be saved to journal', 'error');
            return;
        }

        const modeInput = prompt('Save mode: quote or summary', 'quote');
        if (modeInput === null) return;
        const mode = String(modeInput).trim().toLowerCase().startsWith('s') ? 'summary' : 'quote';

        const baseText = getMessageText(msg);
        const defaultTopic = mode === 'summary'
            ? inferTopic(baseText, 'Thread Summary')
            : inferTopic(baseText, 'Quote');

        const topicInput = prompt('Topic (leave blank to auto-generate):', defaultTopic);
        if (topicInput === null) return;
        const topic = topicInput.trim() || defaultTopic;

        const today = new Date().toISOString().slice(0, 10);
        const dateInput = prompt('Date (YYYY-MM-DD, blank uses today):', today);
        if (dateInput === null) return;
        const date = dateInput.trim() || today;
        if (!isIsoDate(date)) {
            ui.showToast('Invalid date format. Use YYYY-MM-DD', 'error');
            return;
        }

        const content = mode === 'summary'
            ? buildThreadSummary(hist, idx)
            : toQuotedMarkdown(baseText);

        if (!content.trim()) {
            ui.showToast('Nothing to save for this entry', 'error');
            return;
        }

        const chatName = document.getElementById('chat-select')?.value || '';
        await api.saveJournalEntry({
            mode,
            topic,
            date,
            chat_name: chatName,
            source_timestamp: msg.timestamp || null,
            content
        });

        ui.showToast(`Saved ${mode} to journal`, 'success');
    } catch (e) {
        console.error('Save journal failed:', e);
        ui.showToast(`Save failed: ${e.message || 'unknown error'}`, 'error');
    }
}

export async function handleSaveTopic(idx) {
    try {
        const hist = await api.fetchHistory();
        const msg = hist[idx];
        if (!msg || msg.role !== 'assistant') {
            ui.showToast('Only assistant responses can be saved to topics', 'error');
            return;
        }

        const kindInput = prompt('Save to topics as: quote or summary', 'quote');
        if (kindInput === null) return;
        const kind = String(kindInput).trim().toLowerCase().startsWith('s') ? 'summary' : 'quote';

        const baseText = getMessageText(msg);
        const activeTopic = getActiveTopicFolder();
        const defaultTopic = activeTopic || inferTopic(baseText, 'General');
        const topicInput = prompt('Topic folder:', defaultTopic);
        if (topicInput === null) return;
        const topic = topicInput.trim() || defaultTopic;
        if (!topic) {
            ui.showToast('Topic folder is required', 'error');
            return;
        }

        const defaultTitle = kind === 'summary'
            ? inferTopic(baseText, 'Thread Summary')
            : inferTopic(baseText, 'Saved Quote');
        const titleInput = prompt('Entry title (optional):', defaultTitle);
        if (titleInput === null) return;

        const content = kind === 'summary'
            ? buildThreadSummary(hist, idx)
            : toQuotedMarkdown(baseText);

        if (!content.trim()) {
            ui.showToast('Nothing to save for this entry', 'error');
            return;
        }

        const chatName = document.getElementById('chat-select')?.value || '';
        await api.saveTopicEntry({
            topic,
            kind,
            title: titleInput.trim() || defaultTitle,
            source_chat: chatName,
            source_message_timestamp: msg.timestamp || null,
            content
        });

        if (chatName && topic !== activeTopic) {
            await api.updateChatSettings(chatName, { topic_folder: topic });
            const topicInputEl = document.getElementById('topic-folder-input');
            if (topicInputEl) topicInputEl.value = topic;
        }

        window.dispatchEvent(new CustomEvent('terminus-topic-saved', { detail: { topic } }));
        ui.showToast(`Saved ${kind} to ${topic}`, 'success');
    } catch (e) {
        console.error('Save topic failed:', e);
        ui.showToast(`Save failed: ${e.message || 'unknown error'}`, 'error');
    }
}

export function handleToolbar(action, idx, button = null) {
    if (action === 'trash') handleTrash(idx);
    else if (action === 'regenerate') handleRegen(idx);
    else if (action === 'continue') handleContinue(idx);
    else if (action === 'edit') handleEdit(idx);
    else if (action === 'replay') handleReplay(idx);
    else if (action === 'copy-markdown') handleCopyMarkdown(idx, button);
    else if (action === 'save-topic') handleSaveTopic(idx);
    else if (action === 'save-journal') handleSaveJournal(idx);
}

export async function handleAutoRefresh() {
    // Skip if SSE is connected — real-time events handle all updates
    if (window.eventBus?.isConnected?.()) return;
    const histLen = getHistLen();
    const len = await chat.autoRefresh(getIsProc(), histLen, async () => {
        // Import dynamically to avoid circular dep
        const scene = await import('../features/scene.js');
        return scene.updateScene();
    });
    setHistLen(len);
}
