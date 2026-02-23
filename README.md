# 🧠 ST-OpenClaw-Sync

SillyTavern Extension that syncs your conversations to [OpenClaw](https://openclaw.ai) memory.

## What it does

Every time your AI character replies in SillyTavern, this extension automatically sends the conversation to your OpenClaw server. This way, your OpenClaw agent (e.g. Mio) knows what you talked about in SillyTavern — **two-way memory sharing**.

## Architecture

```
SillyTavern (Phone/Termux)          Laptop (WSL)
────────────────────────            ──────────────────
    ↕ Chat with AI                  OpenClaw + Proxy
    │                                    │
    └── Extension ──POST──→  http://IP:4000/st-sync
                                         │
                                    ┌────┴────┐
                                    │  Writes  │
                                    └────┬────┘
                                         │
                              ┌──────────┼──────────┐
                              ↓                     ↓
                         st-chats.jsonl      memory/YYYY-MM-DD.md
                         (full log)          (OpenClaw readable)
```

## Installation

### On SillyTavern (Phone/Termux)

```bash
cd ~/SillyTavern/data/default-user/extensions/third-party/
git clone https://github.com/SynthexNexus/ST-Openclaw-Sync.git openclaw-sync
```

Then restart SillyTavern. Go to **Settings → Extensions** and find **🧠 OpenClaw Memory Sync**.

### On your Laptop (Proxy side)

Your `local-proxy.js` needs the `/st-sync` endpoint. This is already included if you're using KytrexRouter v2.1+.

## Configuration

In SillyTavern → Settings → Extensions → OpenClaw Memory Sync:

| Setting | Default | Description |
|---|---|---|
| 啟用同步 | ✅ On | Enable/disable sync |
| 同步端點 URL | `http://10.0.0.172:4000/st-sync` | Your laptop's proxy URL |
| 顯示同步通知 | ✅ On | Show toast on successful sync |

Click **🧪 測試連線** to verify connectivity.

## How memory sync works

1. You chat with a character in SillyTavern
2. AI replies → Extension captures the conversation turn
3. Extension POSTs `{character, userMessage, assistantMessage}` to your proxy
4. Proxy writes to:
   - `st-chats.jsonl` — Full conversation log (JSONL format)
   - `memory/YYYY-MM-DD.md` — Daily markdown file that OpenClaw auto-loads
5. Next time you talk to your OpenClaw agent, it can recall what happened in SillyTavern

## Offline behavior

When not on the same WiFi as your laptop, sync silently fails. Your SillyTavern works normally — conversations are just not synced until you're back on WiFi.

## License

MIT
