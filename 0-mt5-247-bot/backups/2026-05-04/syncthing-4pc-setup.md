# Syncthing 4-Computer Setup — Step by Step

## Device Reference

| Name | Role | Device ID |
|------|------|-----------|
| CryptoTech-LT01 | Laptop — dev/config | LPGKCBX-7WIQ6JH-AIRBMEB-4VSVYAP-UCRHIQI-GOXMG34-KDJIU4Z-PUUIQAN |
| CryptoTech | Desktop — runs 247-bot + Free Signals | OXDLOUW-6OR6LIT-3HKHYJU-ADPJ54A-7E7NLKP-L2OYDRX-Z6MSMOB-UDJMNQ4 |
| NVID-01A | Signal runner — runs tg-mt5-bot | A5DSL73-KW4CC6R-PR2JJG6-I6NFFGS-M76OTE2-FQ5JOXV-LZRLEPB-S44DRQI |
| NVID-01B | Spare — Free Signals (optional) | NUV7MUD-LWJCRA3-DHBZJQ4-B5QKKZ6-KBW5NKJ-P5MD6DD-LFM2NZH-45K2SA2 |

---

## Step 1 — Add all devices on EVERY computer

On **each** of the 4 computers, open `http://127.0.0.1:8384` and add the other 3 devices:

Click **Add Remote Device** → paste the Device ID → give it the name from the table above → Save.

Do this for all 3 other machines. When the other computer shows a popup saying
"X wants to connect", click **Add Device** to accept.

---

## Step 2 — Place the .stignore file

On the **Laptop (CryptoTech-LT01)** only:
1. Copy the `.stignore` file from this backups folder
2. Paste it to `C:\CryptoNite-MT5-Bots\.stignore`
   (root of the folder, one level above the bot subfolders)

Syncthing will sync this file to all other machines automatically.

---

## Step 3 — Add the shared folder (do this on Laptop first)

On **CryptoTech-LT01 (Laptop)**:
1. In the Syncthing UI, click **Add Folder**
2. Fill in:
   - **Folder Label**: `CryptoNite Bots`
   - **Folder Path**: `C:\CryptoNite-MT5-Bots`
   - **Folder Type**: `Send & Receive`
3. Go to the **Sharing** tab — tick all 3 other devices
4. Go to **Ignore Patterns** tab — paste the contents of `.stignore`
5. Click **Save**

---

## Step 4 — Accept the folder on each other machine

On **CryptoTech Desktop**, **NVID-01A**, and **NVID-01B**:
- A popup will appear: *"CryptoTech-LT01 wants to share folder CryptoNite Bots"*
- Click **Add**
- Set path to `C:\CryptoNite-MT5-Bots` → Save

Syncthing will now sync all files. First sync may take a few minutes.

---

## What syncs where

| Folder / File | Laptop | Desktop | NVID-01A | NVID-01B |
|---------------|--------|---------|----------|----------|
| 0-mt5-247-bot (code) | ✅ | ✅ runs it | ✅ synced | ✅ synced |
| 0-tg-mt5-bot (code) | ✅ | ✅ synced | ✅ runs it | ✅ synced |
| CryptoNite-Free-Signals | ✅ | ✅ runs it | ✅ synced | ✅ optional |
| All other bots | ✅ | ✅ synced | ✅ synced | ✅ synced |
| *.session files | ✅ own | ❌ own | ❌ own | ❌ own |
| __pycache__ | ❌ | ❌ | ❌ | ❌ |

All machines have all the code. Each machine runs its assigned bot.
Runtime data (logs, state.json, trades.csv) syncs back to Laptop automatically
so you can monitor everything from one place.

---

## After first sync — update bot startup paths

On **CryptoTech Desktop**: update the 0-mt5-247-bot startup script:
```bat
cd /d C:\CryptoNite-MT5-Bots\0-mt5-247-bot
python cryptonite_bot.py
```

On **NVID-01A**: update the 0-tg-mt5-bot startup script:
```bat
cd /d C:\CryptoNite-MT5-Bots\0-tg-mt5-bot
python main.py
```

---

## Key rules

1. **Never copy files manually again** — edit on Laptop, Syncthing handles distribution
2. **Telegram `.session` files stay on their own machine** — already excluded in .stignore
3. **If a `.sync-conflict-*` file appears** — two machines edited the same file
   at the same time. Open both, pick the right version, delete the conflict copy.
4. **Syncthing UI** is always at `http://127.0.0.1:8384` on any machine
