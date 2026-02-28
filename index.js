/* OpenClaw Memory Sync v2 — SillyTavern Extension
 *
 * Features:
 * - Real-time sync: POST each message turn as it happens
 * - Full conversation sync: POST entire chat on idle timeout
 * - Offline buffer: queue messages when laptop unreachable, batch sync later
 * - Duplicate detection: hash-based dedup prevents double-logging
 * - All settings configurable from ST UI
 */

// ─── Configuration ─────────────────────────────────────────────
const EXTENSION_NAME = 'openclaw-sync';
const DEFAULT_SYNC_URL = 'http://10.0.0.172:4000/st-sync';

const defaultSettings = {
    enabled: true,
    syncUrl: DEFAULT_SYNC_URL,

    // Real-time sync (per-message)
    realtimeSync: true,

    // Full conversation sync
    fullConversationSync: true,
    idleTimeoutMinutes: 5,        // sync full conversation after N minutes idle

    // Offline buffer
    offlineBuffer: true,
    maxBufferSize: 100,           // max queued messages before oldest are dropped

    // Dedup
    dedup: true,

    // Notifications
    showNotifications: true,
    showErrors: false,            // show error toasts (noisy when offline)

    // Internal state
    lastSyncTime: null,
};

// ─── State ─────────────────────────────────────────────────────
let idleTimer = null;
let lastSyncedChatId = null;
let syncedHashes = new Set();     // hashes of already-synced messages
const HASH_STORAGE_KEY = 'openclaw_sync_hashes';
const BUFFER_STORAGE_KEY = 'openclaw_sync_buffer';

// ─── Helpers ───────────────────────────────────────────────────

function getSettings() {
    if (!window.extension_settings) window.extension_settings = {};
    if (!window.extension_settings[EXTENSION_NAME]) {
        window.extension_settings[EXTENSION_NAME] = { ...defaultSettings };
    }
    // Merge missing defaults (for upgrades)
    const s = window.extension_settings[EXTENSION_NAME];
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function log(msg) {
    console.log(`[OpenClaw-Sync] ${msg}`);
}

function getCharacterName() {
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const ctx = SillyTavern.getContext();
            if (ctx.name2) return ctx.name2;
            if (ctx.characterId !== undefined && ctx.characters) {
                const char = ctx.characters[ctx.characterId];
                if (char && char.name) return char.name;
            }
        }
    } catch (_) { }
    return 'Unknown';
}

/** Simple hash for dedup */
function hashMessage(userMsg, assistantMsg) {
    const str = (userMsg || '').substring(0, 200) + '|' + (assistantMsg || '').substring(0, 200);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return hash.toString(36);
}

/** Load synced hashes from localStorage */
function loadSyncedHashes() {
    try {
        const stored = localStorage.getItem(HASH_STORAGE_KEY);
        if (stored) {
            const arr = JSON.parse(stored);
            syncedHashes = new Set(arr.slice(-500)); // keep last 500
        }
    } catch (_) { }
}

/** Save synced hashes to localStorage */
function saveSyncedHashes() {
    try {
        const arr = [...syncedHashes].slice(-500);
        localStorage.setItem(HASH_STORAGE_KEY, JSON.stringify(arr));
    } catch (_) { }
}

// ─── Offline Buffer ────────────────────────────────────────────

function getBuffer() {
    try {
        const stored = localStorage.getItem(BUFFER_STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (_) { return []; }
}

function saveBuffer(buffer) {
    try {
        localStorage.setItem(BUFFER_STORAGE_KEY, JSON.stringify(buffer));
    } catch (_) { }
}

function addToBuffer(payload) {
    const settings = getSettings();
    const buffer = getBuffer();
    buffer.push(payload);
    // Trim to max size
    while (buffer.length > settings.maxBufferSize) buffer.shift();
    saveBuffer(buffer);
    log(`📦 Buffered offline (${buffer.length} queued)`);
}

async function flushBuffer() {
    const buffer = getBuffer();
    if (buffer.length === 0) return;

    const settings = getSettings();
    log(`📤 Flushing ${buffer.length} buffered messages...`);

    const remaining = [];
    for (const payload of buffer) {
        try {
            const res = await fetch(settings.syncUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) remaining.push(payload);
        } catch (_) {
            remaining.push(payload);
            break; // still offline, stop trying
        }
    }

    saveBuffer(remaining);
    if (remaining.length === 0) {
        log('✅ Buffer flushed completely');
        if (settings.showNotifications) {
            toastr.success(`已補同步 ${buffer.length} 條離線訊息`, 'OpenClaw Sync', { timeOut: 3000 });
        }
    } else {
        log(`⚠️ ${remaining.length} messages still buffered`);
    }
}

// ─── Sync Functions ────────────────────────────────────────────

/**
 * POST a single message turn to the sync endpoint.
 */
async function syncMessage(userMessage, assistantMessage, chatId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.realtimeSync) return;

    // Dedup check
    if (settings.dedup) {
        const hash = hashMessage(userMessage, assistantMessage);
        if (syncedHashes.has(hash)) {
            log(`⏭️ Skipped duplicate: ${hash}`);
            return;
        }
        syncedHashes.add(hash);
        saveSyncedHashes();
    }

    const charName = getCharacterName();
    const payload = {
        type: 'message',
        character: charName,
        userMessage: userMessage || '',
        assistantMessage: assistantMessage || '',
        chatId: chatId || '',
        timestamp: new Date().toISOString(),
    };

    try {
        const res = await fetch(settings.syncUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (res.ok) {
            log(`✅ Synced message: ${charName} | ${(userMessage || '').substring(0, 40)}...`);
            settings.lastSyncTime = new Date().toISOString();
            if (settings.showNotifications) {
                toastr.success('已同步', 'OpenClaw', { timeOut: 1500 });
            }
            // Try flushing buffer while we're online
            await flushBuffer();
        } else {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (err) {
        log(`📦 Offline or error: ${err.message}`);
        if (settings.offlineBuffer) addToBuffer(payload);
        if (settings.showErrors) {
            toastr.warning('離線中，已存入 buffer', 'OpenClaw Sync', { timeOut: 2000 });
        }
    }
}

/**
 * POST the full conversation to the sync endpoint.
 */
async function syncFullConversation() {
    const settings = getSettings();
    if (!settings.enabled || !settings.fullConversationSync) return;

    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length < 2) return;

        const charName = getCharacterName();
        const chatId = context.chatId || '';

        // Don't re-sync same conversation if nothing changed
        const conversationHash = hashMessage(
            chat.length.toString(),
            chat[chat.length - 1]?.mes || ''
        );

        if (syncedHashes.has('full_' + conversationHash)) {
            log('⏭️ Full conversation already synced');
            return;
        }

        // Build full message list
        const messages = [];
        for (const msg of chat) {
            if (msg.is_system) continue;
            messages.push({
                role: msg.is_user ? 'user' : 'assistant',
                name: msg.is_user ? 'Kytrex' : charName,
                content: msg.mes || '',
                timestamp: msg.send_date || '',
            });
        }

        const payload = {
            type: 'full_conversation',
            character: charName,
            chatId: chatId,
            messageCount: messages.length,
            messages: messages,
            timestamp: new Date().toISOString(),
        };

        const res = await fetch(settings.syncUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (res.ok) {
            syncedHashes.add('full_' + conversationHash);
            saveSyncedHashes();
            log(`✅ Full conversation synced: ${charName} (${messages.length} messages)`);
            if (settings.showNotifications) {
                toastr.info(`完整對話已同步 (${messages.length} 條)`, 'OpenClaw', { timeOut: 2000 });
            }
        } else {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (err) {
        log(`❌ Full sync error: ${err.message}`);
    }
}

// ─── Idle Timer ────────────────────────────────────────────────

function resetIdleTimer() {
    const settings = getSettings();
    if (!settings.fullConversationSync) return;

    if (idleTimer) clearTimeout(idleTimer);

    idleTimer = setTimeout(() => {
        log('⏰ Idle timeout — syncing full conversation');
        syncFullConversation();
    }, settings.idleTimeoutMinutes * 60 * 1000);
}

// ─── Event Hooks ───────────────────────────────────────────────

function setupEventListeners() {
    const ctx = SillyTavern.getContext();
    const eventTypes = ctx.eventTypes;

    // Hook MESSAGE_RECEIVED (AI reply)
    if (eventTypes.MESSAGE_RECEIVED !== undefined) {
        ctx.eventSource.on(eventTypes.MESSAGE_RECEIVED, async (messageIndex) => {
            const settings = getSettings();
            if (!settings.enabled) return;

            try {
                const context = SillyTavern.getContext();
                const chat = context.chat;
                if (!chat || chat.length < 2) return;

                const aiMsg = chat[messageIndex];
                if (!aiMsg || aiMsg.is_user) return;

                // Find preceding user message
                let userMsg = null;
                for (let i = messageIndex - 1; i >= 0; i--) {
                    if (chat[i] && chat[i].is_user) {
                        userMsg = chat[i];
                        break;
                    }
                }

                const userText = userMsg ? userMsg.mes : '';
                const aiText = aiMsg.mes || '';
                const chatId = context.chatId || '';

                // Real-time sync
                await syncMessage(userText, aiText, chatId);

                // Reset idle timer for full conversation sync
                resetIdleTimer();
            } catch (err) {
                log(`❌ Event error: ${err.message}`);
            }
        });
        log('✅ Hooked MESSAGE_RECEIVED');
    }

    // Hook CHAT_CHANGED (user switches character/chat)
    if (eventTypes.CHAT_CHANGED !== undefined) {
        ctx.eventSource.on(eventTypes.CHAT_CHANGED, async () => {
            // Sync full conversation of previous chat before switching
            if (lastSyncedChatId) {
                log('🔄 Chat changed — syncing previous conversation');
                await syncFullConversation();
            }
            lastSyncedChatId = SillyTavern.getContext().chatId;
            resetIdleTimer();
        });
        log('✅ Hooked CHAT_CHANGED');
    }
}

// ─── Settings UI ───────────────────────────────────────────────

function createSettingsUI() {
    const settings = getSettings();

    const html = `
    <div id="openclaw-sync-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🧠 OpenClaw Memory Sync v2</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <div class="openclaw-sync-block">
                    <h4>🔗 連線設定</h4>
                    <div class="openclaw-sync-row">
                        <label><input id="oc_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} /> 啟用同步</label>
                    </div>
                    <div class="openclaw-sync-row">
                        <label>同步端點 URL</label>
                        <input id="oc_url" type="text" class="text_pole" value="${settings.syncUrl}" />
                    </div>
                </div>

                <div class="openclaw-sync-block">
                    <h4>⚡ 即時同步</h4>
                    <div class="openclaw-sync-row">
                        <label><input id="oc_realtime" type="checkbox" ${settings.realtimeSync ? 'checked' : ''} /> 每條訊息即時同步</label>
                    </div>
                </div>

                <div class="openclaw-sync-block">
                    <h4>📜 完整對話同步</h4>
                    <div class="openclaw-sync-row">
                        <label><input id="oc_fullsync" type="checkbox" ${settings.fullConversationSync ? 'checked' : ''} /> 閒置後同步完整對話</label>
                    </div>
                    <div class="openclaw-sync-row">
                        <label>閒置幾分鐘後同步</label>
                        <input id="oc_idle" type="number" class="text_pole" value="${settings.idleTimeoutMinutes}" min="1" max="60" style="width:60px" />
                        <span>分鐘</span>
                    </div>
                </div>

                <div class="openclaw-sync-block">
                    <h4>📦 離線 Buffer</h4>
                    <div class="openclaw-sync-row">
                        <label><input id="oc_buffer" type="checkbox" ${settings.offlineBuffer ? 'checked' : ''} /> 離線時暫存訊息</label>
                    </div>
                    <div class="openclaw-sync-row">
                        <label>Buffer 上限</label>
                        <input id="oc_bufmax" type="number" class="text_pole" value="${settings.maxBufferSize}" min="10" max="1000" style="width:60px" />
                        <span>條</span>
                    </div>
                </div>

                <div class="openclaw-sync-block">
                    <h4>🔒 去重</h4>
                    <div class="openclaw-sync-row">
                        <label><input id="oc_dedup" type="checkbox" ${settings.dedup ? 'checked' : ''} /> 重複訊息不再同步</label>
                    </div>
                </div>

                <div class="openclaw-sync-block">
                    <h4>🔔 通知</h4>
                    <div class="openclaw-sync-row">
                        <label><input id="oc_notify" type="checkbox" ${settings.showNotifications ? 'checked' : ''} /> 同步成功通知</label>
                    </div>
                    <div class="openclaw-sync-row">
                        <label><input id="oc_errors" type="checkbox" ${settings.showErrors ? 'checked' : ''} /> 顯示錯誤通知</label>
                    </div>
                </div>

                <div class="openclaw-sync-block">
                    <h4>🧪 測試</h4>
                    <div class="openclaw-sync-row">
                        <button id="oc_test" class="menu_button">測試連線</button>
                        <button id="oc_flush" class="menu_button">補送離線訊息</button>
                        <span id="oc_status"></span>
                    </div>
                    <div class="openclaw-sync-row">
                        <small>Buffer: <span id="oc_bufcount">0</span> 條 | 上次同步: <span id="oc_last">${settings.lastSyncTime || '—'}</span></small>
                    </div>
                </div>

                <div class="openclaw-sync-block">
                    <h4>💾 儲存</h4>
                    <div class="openclaw-sync-row">
                        <button id="oc_save" class="menu_button" style="background:#2563eb;color:#fff;font-weight:600;">💾 儲存設定</button>
                        <span id="oc_save_status"></span>
                    </div>
                </div>

            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    // ─── Bind all settings ───
    const save = () => { if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced(); };

    $('#oc_enabled').on('change', function () { settings.enabled = this.checked; save(); });
    $('#oc_url').on('input', function () { settings.syncUrl = this.value || DEFAULT_SYNC_URL; save(); });
    $('#oc_realtime').on('change', function () { settings.realtimeSync = this.checked; save(); });
    $('#oc_fullsync').on('change', function () { settings.fullConversationSync = this.checked; save(); });
    $('#oc_idle').on('change', function () { settings.idleTimeoutMinutes = parseInt(this.value) || 5; save(); });
    $('#oc_buffer').on('change', function () { settings.offlineBuffer = this.checked; save(); });
    $('#oc_bufmax').on('change', function () { settings.maxBufferSize = parseInt(this.value) || 100; save(); });
    $('#oc_dedup').on('change', function () { settings.dedup = this.checked; save(); });
    $('#oc_notify').on('change', function () { settings.showNotifications = this.checked; save(); });
    $('#oc_errors').on('change', function () { settings.showErrors = this.checked; save(); });

    // Update buffer count display
    const updateBufferCount = () => {
        $('#oc_bufcount').text(getBuffer().length);
        $('#oc_last').text(settings.lastSyncTime || '—');
    };
    updateBufferCount();
    setInterval(updateBufferCount, 10000);

    // Test button
    $('#oc_test').on('click', async function () {
        const st = $('#oc_status');
        st.text('測試中...').css('color', '#888');
        try {
            const res = await fetch(settings.syncUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'message', character: 'Test', userMessage: '[連線測試]', assistantMessage: '[OK]', chatId: 'test' }),
            });
            if (res.ok) {
                st.text('✅ 連線成功').css('color', '#34d399');
                toastr.success('連線成功', 'OpenClaw');
            } else {
                st.text(`❌ ${res.status}`).css('color', '#ef4444');
            }
        } catch (err) {
            st.text(`❌ ${err.message}`).css('color', '#ef4444');
        }
    });

    // Flush button
    $('#oc_flush').on('click', async function () {
        await flushBuffer();
        updateBufferCount();
    });

    // Save button — explicitly save all settings
    $('#oc_save').on('click', function () {
        // Read all current form values into settings object
        settings.enabled = $('#oc_enabled').is(':checked');
        settings.syncUrl = $('#oc_url').val() || DEFAULT_SYNC_URL;
        settings.realtimeSync = $('#oc_realtime').is(':checked');
        settings.fullConversationSync = $('#oc_fullsync').is(':checked');
        settings.idleTimeoutMinutes = parseInt($('#oc_idle').val()) || 5;
        settings.offlineBuffer = $('#oc_buffer').is(':checked');
        settings.maxBufferSize = parseInt($('#oc_bufmax').val()) || 100;
        settings.dedup = $('#oc_dedup').is(':checked');
        settings.showNotifications = $('#oc_notify').is(':checked');
        settings.showErrors = $('#oc_errors').is(':checked');

        // Persist
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();

        // Visual feedback
        const st = $('#oc_save_status');
        st.text('✅ 已儲存！').css('color', '#34d399');
        toastr.success('設定已儲存', 'OpenClaw Sync', { timeOut: 2000 });
        setTimeout(() => st.text(''), 3000);

        log('💾 Settings saved manually');
    });
}

// ─── Main ──────────────────────────────────────────────────────

jQuery(async () => {
    log('🔄 Loading OpenClaw Memory Sync v2...');

    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
        await new Promise(resolve => {
            const check = setInterval(() => {
                if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                    clearInterval(check);
                    resolve();
                }
            }, 500);
        });
    }

    loadSyncedHashes();
    createSettingsUI();
    setupEventListeners();

    log('✅ OpenClaw Memory Sync v2 loaded! URL: ' + getSettings().syncUrl);
});
