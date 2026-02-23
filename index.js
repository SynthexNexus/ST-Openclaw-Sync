/* OpenClaw Memory Sync — SillyTavern Extension
 *
 * 每次收到 AI 回覆後，自動 POST 對話到 OpenClaw 筆電端
 * 讓 Mio 知道你在 SillyTavern 裡聊了什麼
 */

// ─── Configuration ─────────────────────────────────────────────
const EXTENSION_NAME = 'openclaw-sync';
const DEFAULT_SYNC_URL = 'http://10.0.0.172:4000/st-sync';

// Extension settings (saved in ST)
const defaultSettings = {
    enabled: true,
    syncUrl: DEFAULT_SYNC_URL,
    syncOnReceive: true,    // sync when AI replies
    showNotifications: true, // show toast on sync
    lastSyncTime: null,
};

// ─── Helpers ───────────────────────────────────────────────────

function getSettings() {
    if (!window.extension_settings) window.extension_settings = {};
    if (!window.extension_settings[EXTENSION_NAME]) {
        window.extension_settings[EXTENSION_NAME] = { ...defaultSettings };
    }
    return window.extension_settings[EXTENSION_NAME];
}

function log(msg) {
    console.log(`[OpenClaw-Sync] ${msg}`);
}

function getCharacterName() {
    try {
        // SillyTavern stores current character info in various globals
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const ctx = SillyTavern.getContext();
            if (ctx.name2) return ctx.name2; // character name
            if (ctx.characterId !== undefined && ctx.characters) {
                const char = ctx.characters[ctx.characterId];
                if (char && char.name) return char.name;
            }
        }
    } catch (_) { }
    return 'Unknown';
}

/**
 * Send chat data to OpenClaw sync endpoint.
 */
async function syncToOpenClaw(userMessage, assistantMessage, chatId) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const charName = getCharacterName();

    try {
        const response = await fetch(settings.syncUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                character: charName,
                userMessage: userMessage || '',
                assistantMessage: assistantMessage || '',
                chatId: chatId || '',
                timestamp: new Date().toISOString(),
            }),
        });

        if (response.ok) {
            log(`✅ Synced: ${charName} | ${(userMessage || '').substring(0, 40)}...`);
            settings.lastSyncTime = new Date().toISOString();
            if (settings.showNotifications) {
                toastr.success(`已同步到 OpenClaw`, 'OpenClaw Sync', { timeOut: 2000 });
            }
        } else {
            const errText = await response.text();
            log(`❌ Sync failed (${response.status}): ${errText}`);
            if (settings.showNotifications) {
                toastr.warning(`同步失敗: ${response.status}`, 'OpenClaw Sync');
            }
        }
    } catch (err) {
        log(`❌ Network error: ${err.message}`);
        // Silently fail if laptop is not reachable (e.g., not on WiFi)
        // Don't annoy user with repeated error toasts
    }
}

// ─── Event Hooks ───────────────────────────────────────────────

function setupEventListeners() {
    const ctx = SillyTavern.getContext();
    const eventTypes = ctx.eventTypes;

    // Hook into MESSAGE_RECEIVED event (when AI sends a reply)
    if (eventTypes.MESSAGE_RECEIVED !== undefined) {
        ctx.eventSource.on(eventTypes.MESSAGE_RECEIVED, async (messageIndex) => {
            const settings = getSettings();
            if (!settings.enabled || !settings.syncOnReceive) return;

            try {
                const context = SillyTavern.getContext();
                const chat = context.chat;

                if (!chat || chat.length < 2) return;

                // Get the AI message that was just received
                const aiMsg = chat[messageIndex];
                if (!aiMsg || aiMsg.is_user) return;

                // Find the preceding user message
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

                await syncToOpenClaw(userText, aiText, chatId);
            } catch (err) {
                log(`❌ Event handler error: ${err.message}`);
            }
        });

        log('✅ Hooked into MESSAGE_RECEIVED event');
    }

    // Also hook into MESSAGE_SENT to capture user messages
    // (for cases where we want to sync before AI replies)
    if (eventTypes.MESSAGE_SENT !== undefined) {
        ctx.eventSource.on(eventTypes.MESSAGE_SENT, async (messageIndex) => {
            // Currently we sync on MESSAGE_RECEIVED which includes both sides
            // This hook is here for future use
        });
    }
}

// ─── Settings UI ───────────────────────────────────────────────

function createSettingsUI() {
    const settings = getSettings();

    const html = `
    <div id="openclaw-sync-settings" class="openclaw-sync-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🧠 OpenClaw Memory Sync</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <div class="openclaw-sync-row">
                    <label for="openclaw_sync_enabled">
                        <input id="openclaw_sync_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                        啟用同步
                    </label>
                </div>

                <div class="openclaw-sync-row">
                    <label for="openclaw_sync_url">同步端點 URL</label>
                    <input id="openclaw_sync_url" type="text" class="text_pole" value="${settings.syncUrl}" placeholder="${DEFAULT_SYNC_URL}" />
                </div>

                <div class="openclaw-sync-row">
                    <label for="openclaw_sync_notifications">
                        <input id="openclaw_sync_notifications" type="checkbox" ${settings.showNotifications ? 'checked' : ''} />
                        顯示同步通知
                    </label>
                </div>

                <div class="openclaw-sync-row">
                    <button id="openclaw_sync_test" class="menu_button">🧪 測試連線</button>
                    <span id="openclaw_sync_status" class="openclaw-sync-status"></span>
                </div>

                <div class="openclaw-sync-row">
                    <small>上次同步: <span id="openclaw_sync_last">${settings.lastSyncTime || '尚未同步'}</span></small>
                </div>

            </div>
        </div>
    </div>`;

    // Append to extension settings area
    $('#extensions_settings2').append(html);

    // Bind events
    $('#openclaw_sync_enabled').on('change', function () {
        settings.enabled = this.checked;
        SillyTavern.getContext().saveSettingsDebounced();
        log(`Sync ${settings.enabled ? 'enabled' : 'disabled'}`);
    });

    $('#openclaw_sync_url').on('input', function () {
        settings.syncUrl = this.value || DEFAULT_SYNC_URL;
        SillyTavern.getContext().saveSettingsDebounced();
    });

    $('#openclaw_sync_notifications').on('change', function () {
        settings.showNotifications = this.checked;
        SillyTavern.getContext().saveSettingsDebounced();
    });

    $('#openclaw_sync_test').on('click', async function () {
        const statusEl = $('#openclaw_sync_status');
        statusEl.text('測試中...').css('color', '#888');

        try {
            const res = await fetch(settings.syncUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    character: 'Test',
                    userMessage: '[測試連線]',
                    assistantMessage: '[連線成功]',
                    chatId: 'test',
                }),
            });

            if (res.ok) {
                statusEl.text('✅ 連線成功！').css('color', '#34d399');
                toastr.success('OpenClaw 連線成功', 'OpenClaw Sync');
            } else {
                statusEl.text(`❌ 錯誤 ${res.status}`).css('color', '#ef4444');
            }
        } catch (err) {
            statusEl.text(`❌ ${err.message}`).css('color', '#ef4444');
            toastr.error(`無法連線到 ${settings.syncUrl}`, 'OpenClaw Sync');
        }
    });
}

// ─── Main Entry Point ──────────────────────────────────────────

jQuery(async () => {
    log('🔄 Loading OpenClaw Memory Sync extension...');

    // Wait for SillyTavern to fully load
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
        log('⏳ Waiting for SillyTavern context...');
        await new Promise(resolve => {
            const check = setInterval(() => {
                if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                    clearInterval(check);
                    resolve();
                }
            }, 500);
        });
    }

    // Create settings UI
    createSettingsUI();

    // Setup event listeners
    setupEventListeners();

    log('✅ OpenClaw Memory Sync loaded! Sync URL: ' + getSettings().syncUrl);
});
