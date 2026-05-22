# Syncthing Setup Guide — CryptoNite Bots (3 Computers)

## What this does
Syncthing keeps `C:\CryptoNite-MT5-Bots\` in sync across all three computers
automatically. Edit code on any machine → all others update within seconds.
No cloud, no manual copying.

---

## Step 1 — Install on all 3 computers

Download from: https://syncthing.net/downloads/
Choose **Windows (64-bit) — Installer (.exe)**

Install on each computer. After install, Syncthing opens in your browser at:
`http://127.0.0.1:8384`

It also adds a tray icon so you can open it any time.

---

## Step 2 — Get the Device ID from each computer

On each computer, open the Syncthing web UI (`http://127.0.0.1:8384`), then:
- Click **Actions** (top right) → **Show ID**
- Copy the Device ID (looks like: `XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX`)

Write down the Device ID for all 3 computers — call them PC1, PC2, PC3.

---

## Step 3 — Add devices to each other

**On PC1:**
1. Click **Add Remote Device** (bottom right of the web UI)
2. Paste PC2's Device ID → give it a name (e.g. "Trading PC 2") → Save
3. Repeat for PC3

**On PC2 and PC3:**
- When you add a device, the other computer will show a popup asking to confirm.
  Click **Add Device** to accept on each machine.

---

## Step 4 — Add the shared folder

**On PC1 (do this first):**
1. Click **Add Folder**
2. Fill in:
   - **Folder Label**: `CryptoNite Bots`
   - **Folder Path**: `C:\CryptoNite-MT5-Bots`
   - **Folder Type**: `Send & Receive` (bidirectional sync)
3. Go to the **Sharing** tab → tick PC2 and PC3
4. Go to the **Ignore Patterns** tab → paste the contents of `.stignore`
5. Click **Save**

**On PC2 and PC3:**
- Syncthing will show a popup: *"PC1 wants to share folder CryptoNite Bots"*
- Click **Add** → set the path to `C:\CryptoNite-MT5-Bots` → Save

---

## Step 5 — Run Syncthing as a service (so it always runs on startup)

In the Syncthing web UI:
- Click **Actions** → **Settings** → tick **Start on Login**

Or for a proper Windows service, download **SyncTrayzor** (a Windows wrapper):
https://github.com/canton7/SyncTrayzor/releases

---

## Important: What NOT to sync

The `.stignore` file excludes:

| File | Why excluded |
|------|-------------|
| `*.session` | Telegram login sessions — machine-specific, do not share |
| `__pycache__` / `*.pyc` | Auto-generated, machine-specific |
| `*.sync-conflict-*` | Syncthing conflict copies — review and delete manually |

### Bot runtime data (decide based on your setup)

If **only one computer runs each bot**, leave these syncing — it's useful.
If **multiple computers could run the same bot**, add these to `.stignore`
to prevent state conflicts:

```
**/state.json
**/events.log
**/signal_intake.csv
**/trades.csv
```

---

## Conflict handling

If two computers edit the same file at the same time, Syncthing keeps both
copies. The conflicting version gets renamed to:
`filename.sync-conflict-YYYYMMDD-HHMMSS-DEVICEID.ext`

The `.stignore` file ignores these — but review them occasionally in
File Explorer to see what conflicted.

---

## Syncthing web UI quick reference

| URL | Purpose |
|-----|---------|
| `http://127.0.0.1:8384` | Main UI |
| Folder → **Edit** → **Ignore Patterns** | Update sync exclusions |
| **Actions** → **Show ID** | Get your Device ID |
| **Actions** → **Rescan** | Force immediate sync |
