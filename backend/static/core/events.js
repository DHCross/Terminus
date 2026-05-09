// core/events.js - Centralized event binding
import * as audio from '../audio.js';
import { getElements } from './state.js';

// Features
import { handleVolumeChange, handleMuteToggle, handleTtsProviderToggle } from '../features/volume.js';
import { handleMicPress, handleMicRelease, handleMicLeave, handleVisibilityChange } from '../features/mic.js';
import {
    handleChatChange,
    handleClearChat,
    handleExportChat,
    handleExportMarkdown,
    handleImportChat,
    handleImportFile,
    toggleKebab,
    closeAllKebabs,
    handleLogout,
    handleRestart
} from '../features/chat-manager.js';

// Handlers
import { handleSend, handleStop, handleInput, handleKeyDown, triggerSendWithText } from '../handlers/send-handlers.js';
import { handleToolbar } from '../handlers/message-handlers.js';

// Nav rail integration

export function bindAllEvents() {
    const el = getElements();

    // Form events
    el.form.addEventListener('submit', e => e.preventDefault());
    el.input.addEventListener('keydown', handleKeyDown);
    el.input.addEventListener('input', handleInput);
    el.sendBtn.addEventListener('click', handleSend);
    el.stopBtn.addEventListener('click', handleStop);

    // Volume controls
    el.volumeSlider.addEventListener('input', handleVolumeChange);
    const ttsToggleBtn = document.getElementById('tts-toggle-btn');
    if (ttsToggleBtn) ttsToggleBtn.addEventListener('click', handleTtsProviderToggle);
    el.muteBtn.addEventListener('click', () => {
        const compact = document.getElementById('volume-compact');
        if (compact) compact.classList.toggle('open');
    });

    // Mic button - dual purpose (TTS stop or record)
    el.micBtn.addEventListener('mousedown', handleMicPress);
    el.micBtn.addEventListener('mouseup', () => handleMicRelease(triggerSendWithText));
    el.micBtn.addEventListener('touchstart', e => { e.preventDefault(); handleMicPress(); });
    el.micBtn.addEventListener('touchend', () => handleMicRelease(triggerSendWithText));
    el.micBtn.addEventListener('contextmenu', e => {
        e.preventDefault();
        audio.forceStop(el.micBtn, triggerSendWithText);
    });
    el.micBtn.addEventListener('mouseleave', () => handleMicLeave(triggerSendWithText));

    // Chat container toolbar clicks (event delegation)
    el.container.addEventListener('click', e => {
        const btn = e.target.closest('.toolbar button');
        if (btn) {
            e.stopPropagation();
            const action = btn.dataset.action;
            const idx = parseInt(btn.dataset.messageIndex);
            if (!isNaN(idx)) {
                handleToolbar(action, idx, btn);
            }
        }
    });

    // Local API spend estimate — click to set external remaining credit reference
    document.getElementById('credit-balance')?.addEventListener('click', async () => {
        const { fetchBalance, setBalance } = await import('../api.js');
        const current = await fetchBalance();
        const input = prompt(
            `Set manual account credit reference:\n\n` +
            `Shared local spend since reset: $${current?.session_spent?.toFixed(4) || '?'}\n` +
            `Shared tracked total: $${current?.total_spent?.toFixed(4) || '?'}\n` +
            `Current manual remaining credit: $${current?.remaining?.toFixed(2) || '?'}\n\n` +
            `This tracker can aggregate local projects that use the same tracker file. It still does not know about other Claude usage automatically.`,
            current?.remaining ?? '5.00'
        );
        if (input !== null && !isNaN(parseFloat(input))) {
            await setBalance(parseFloat(input));
            await fetchBalance();
        }
    });

    // Chat selector (hidden <select> for compatibility)
    el.chatSelect.addEventListener('change', handleChatChange);

    // Header icon buttons (chat picker + new/delete handled by views/chat.js with sb- prefixed IDs)
    el.clearChatBtn?.addEventListener('click', handleClearChat);
    el.importChatBtn?.addEventListener('click', handleImportChat);
    el.exportChatBtn?.addEventListener('click', handleExportChat);
    el.exportMarkdownBtn?.addEventListener('click', handleExportMarkdown);
    el.importFileInput?.addEventListener('change', handleImportFile);

    // Close dropdowns on outside click
    document.addEventListener('click', e => {
        if (!e.target.closest('.kebab-menu')) closeAllKebabs();
        if (!e.target.closest('.volume-compact')) {
            document.getElementById('volume-compact')?.classList.remove('open');
        }
    });

    // Chat menu kebab toggle
    el.chatMenu?.querySelector('.kebab-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        toggleKebab(el.chatMenu);
    });

    // Logout / Restart (may not exist until settings view is built)
    document.getElementById('logout-btn')?.addEventListener('click', handleLogout);
    document.getElementById('restart-btn')?.addEventListener('click', handleRestart);

    // Setup Wizard
    document.getElementById('setup-wizard-btn')?.addEventListener('click', () => {
        closeAllKebabs();
        if (window.terminusSetupWizard) {
            window.terminusSetupWizard.open(true);
        }
    });

    // Document-level events
    document.addEventListener('visibilitychange', () => handleVisibilityChange(triggerSendWithText));

    // Image ready handler (for inline cloning)
    document.addEventListener('imageReady', handleImageReady);
}

function handleImageReady(event) {
    const loadedImg = event.target;

    const message = loadedImg.closest('.message');
    if (!message) return;

    const content = message.querySelector('.message-content');
    if (!content) return;

    const accordions = content.querySelectorAll('details');
    const lastAccordion = accordions[accordions.length - 1];

    const inlineImg = loadedImg.cloneNode(true);
    inlineImg.dataset.inlineClone = 'true';

    if (lastAccordion) {
        lastAccordion.insertAdjacentElement('afterend', inlineImg);
    } else {
        content.insertBefore(inlineImg, content.firstChild);
    }

    // Force scroll
    import('../ui.js').then(ui => ui.forceScrollToBottom());
}

export function bindCleanupEvents(cleanupFn) {
    window.addEventListener('beforeunload', cleanupFn);
}
