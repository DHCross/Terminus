// features/chat-manager.js - Chat list management, import/export, kebab menus
import * as api from '../api.js';
import * as audio from '../audio.js';
import * as ui from '../ui.js';
import { getElements, getIsProc, setHistLen, refresh } from '../core/state.js';
import { updateScene, updateSendButtonLLM } from './scene.js';
import { applyTrimColor } from './chat-settings.js';

export async function populateChatDropdown() {
    const { chatSelect } = getElements();
    try {
        const data = await api.fetchChatList();
        // Separate regular chats from story chats
        const regularChats = data.chats.filter(c => !c.story_chat && !c.private_chat);
        const storyChats = data.chats.filter(c => c.story_chat);
        const privateChats = data.chats.filter(c => c.private_chat);
        ui.renderChatDropdown(regularChats, data.active_chat, storyChats, privateChats);
    } catch (e) {
        console.error('Failed to load chat list:', e);
        if (chatSelect && chatSelect.options.length === 0) {
            console.log('Backend may still be starting up, will retry...');
        }
    }
}

export async function handleChatChange(chatName = null) {
    const { chatSelect } = getElements();
    if (getIsProc()) {
        console.log('Cannot switch chats while processing');
        return;
    }

    const selectedChat = typeof chatName === 'string' && chatName.trim()
        ? chatName.trim()
        : String(chatSelect?.value || '').trim();
    if (!selectedChat) return;

    // Keep the hidden state select in sync even if the target chat was not in its current options.
    if (chatSelect) {
        let option = [...chatSelect.options].find(opt => opt.value === selectedChat);
        if (!option) {
            option = document.createElement('option');
            option.value = selectedChat;
            option.textContent = selectedChat;
            chatSelect.appendChild(option);
        }
        chatSelect.value = selectedChat;
    }
    
    try {
        audio.stop();
        // activateChat already returns settings - no need for separate getChatSettings call
        const result = await api.activateChat(selectedChat);
        const settings = result?.settings || {};
        
        const len = await refresh(false);
        setHistLen(len);
        await updateScene();
        
        // Use settings from activate response
        updateSendButtonLLM(settings.llm_primary || 'auto', settings.llm_model || '');
        applyTrimColor(settings.trim_color || '');
    } catch (e) {
        console.error('Failed to switch chat:', e);
        ui.showToast(`Failed to switch chat: ${e.message}`, 'error');
        await populateChatDropdown();
    }
}

export async function handleNewChat() {
    closeAllKebabs();
    const name = await ui.showPrompt('Enter name for new chat:');
    if (!name || !name.trim()) return;
    
    const { chatSelect } = getElements();
    
    try {
        const created = await api.createChat(name);
        // Backend returns the actual sanitized name — use it directly
        const chatName = created?.name || name.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/\s+/g, '_');
        await populateChatDropdown();

        chatSelect.value = chatName;
        await handleChatChange();
        // Re-sync picker now that backend has correct active chat
        await populateChatDropdown();
    } catch (e) {
        console.error('Failed to create chat:', e);
        if (e.message.includes('already exists')) {
            ui.showToast('Chat already exists! Try a different name.', 'error');
        } else {
            ui.showToast(`Failed to create chat: ${e.message}`, 'error');
        }
    }
}

export async function handleDeleteChat() {
    closeAllKebabs();
    const { chatSelect } = getElements();
    const selectedChat = chatSelect.value;
    
    if (!selectedChat) {
        alert('No chat selected');
        return;
    }
    
    const displayName = chatSelect.options[chatSelect.selectedIndex].text;
    if (!confirm(`Delete "${displayName}"?\n\nThis will permanently remove the chat history AND any custom settings for this chat.`)) return;
    
    try {
        await api.activateChat('default');
        await api.deleteChat(selectedChat);
        await populateChatDropdown();
        chatSelect.value = 'default';
        const len = await refresh(false);
        setHistLen(len);
    } catch (e) {
        console.error('Failed to delete chat:', e);
        alert(`Failed to delete chat: ${e.message}`);
    }
}

export async function handleClearChat() {
    const { chatSelect } = getElements();
    const displayName = chatSelect.options[chatSelect.selectedIndex]?.text || 'this chat';
    if (!confirm(`Clear all messages in "${displayName}"?`)) return;
    
    closeAllKebabs();
    try {
        await api.clearChat();
        const len = await refresh(false);
        setHistLen(len);
        ui.showToast('Chat cleared', 'success');
    } catch (e) {
        console.error('Failed to clear chat:', e);
        ui.showToast('Failed to clear chat', 'error');
    }
}

export async function handleExportChat() {
    closeAllKebabs();
    const { chatSelect } = getElements();

    try {
        const data = await api.fetchRawHistory();
        const chatName = chatSelect.value || 'chat';
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${chatName}_export.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        ui.showToast('Chat exported', 'success');
    } catch (e) {
        console.error('Failed to export chat:', e);
        ui.showToast('Failed to export chat', 'error');
    }
}

export async function handleExportMarkdown() {
    closeAllKebabs();
    const { chatSelect } = getElements();

    try {
        const messages = await api.fetchRawHistory();
        const chatName = chatSelect.value || 'chat';
        const messageList = Array.isArray(messages) ? messages : (messages.messages || []);

        // Build markdown
        let md = `# ${chatName}\n\n`;
        md += `Exported: ${new Date().toLocaleString()}\n\n---\n\n`;

        messageList.forEach(msg => {
            const role = msg.role || 'unknown';
            const label = role === 'user' ? '👤 You' : role === 'assistant' ? '🤖 Terminus' : `**${role}**`;
            md += `## ${label}\n\n`;
            md += (msg.content || '').trim() + '\n\n';
        });

        const blob = new Blob([md], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${chatName}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        ui.showToast('Markdown downloaded', 'success');
    } catch (e) {
        console.error('Failed to export markdown:', e);
        ui.showToast('Failed to export markdown', 'error');
    }
}

export function handleImportChat() {
    closeAllKebabs();
    const { importFileInput } = getElements();
    importFileInput.click();
}

export async function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        // Support both raw array and {messages: []} format
        const messages = Array.isArray(data) ? data : data.messages;
        if (!messages || !Array.isArray(messages)) {
            ui.showToast('Invalid chat format', 'error');
            return;
        }
        
        await api.importChat(messages);
        const len = await refresh(false);
        setHistLen(len);
        ui.showToast(`Imported ${messages.length} messages`, 'success');
    } catch (e) {
        console.error('Failed to import chat:', e);
        ui.showToast('Failed to import chat', 'error');
    } finally {
        e.target.value = '';
    }
}

// Kebab menu utilities
export function toggleKebab(menu) {
    const wasOpen = menu.classList.contains('open');
    closeAllKebabs();
    if (!wasOpen) menu.classList.add('open');
}

export function closeAllKebabs() {
    document.querySelectorAll('.kebab-menu.open').forEach(m => m.classList.remove('open'));
}

export async function handleLogout() {
    closeAllKebabs();
    try {
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
        await fetch('/logout', {
            method: 'POST',
            headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
        });
        window.location.href = '/login';
    } catch (e) {
        console.error('Logout failed:', e);
        window.location.href = '/login';
    }
}

export async function handleRestart() {
    closeAllKebabs();
    if (!confirm('Restart Terminus? The page will reload when the server is back.')) {
        return;
    }
    try {
        await fetch('/api/system/restart', { method: 'POST' });
        showRestartingScreen();
    } catch (e) {
        console.error('Restart failed:', e);
        alert('Restart request failed: ' + e.message);
    }
}

function showRestartingScreen() {
    document.body.innerHTML = `
        <div style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:system-ui,sans-serif;background:#1a1a2e;">
            <div style="font-size:1.5rem;color:#888;">Restarting Terminus...</div>
            <div id="restart-status" style="font-size:1rem;color:#666;">Waiting for server...</div>
            <button id="manual-refresh-btn" style="display:none;padding:12px 24px;font-size:1rem;cursor:pointer;background:#0f766e;color:white;border:none;border-radius:6px;">
                Click to Refresh
            </button>
        </div>
    `;
    
    // Show manual button after 5 seconds regardless
    setTimeout(() => {
        const btn = document.getElementById('manual-refresh-btn');
        if (btn) {
            btn.style.display = 'block';
            btn.addEventListener('click', () => window.location.reload());
        }
    }, 5000);
    
    // Start polling after 2 second delay
    setTimeout(() => pollForServer(), 2000);
}

function pollForServer(attempts = 0) {
    const statusEl = document.getElementById('restart-status');
    const maxAttempts = 30;
    
    if (attempts >= maxAttempts) {
        if (statusEl) statusEl.textContent = 'Server may be ready. Click button to refresh.';
        return;
    }
    
    if (statusEl) statusEl.textContent = `Checking server... (${attempts + 1}/${maxAttempts})`;
    
    fetch('/api/settings', { method: 'GET' })
        .then(r => {
            if (r.ok) {
                if (statusEl) statusEl.textContent = 'Server is back! Refreshing...';
                setTimeout(() => window.location.reload(), 500);
            } else {
                setTimeout(() => pollForServer(attempts + 1), 1000);
            }
        })
        .catch(() => {
            setTimeout(() => pollForServer(attempts + 1), 1000);
        });
}