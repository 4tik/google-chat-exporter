# How to Install and Use ChatVault

A step-by-step user guide for installing, configuring, and exporting Google Chat conversations using **ChatVault (Google Chat Exporter & Archiver)**.

---

## 📑 Table of Contents
- [How to Install and Use ChatVault](#how-to-install-and-use-chatvault)
  - [📑 Table of Contents](#-table-of-contents)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Quick Start (3-Step Setup)](#2-quick-start-3-step-setup)
  - [3. Installation Guide](#3-installation-guide)
    - [Google Chrome](#google-chrome)
    - [Microsoft Edge](#microsoft-edge)
    - [Brave Browser](#brave-browser)
    - [Arc / Opera / Other Chromium Browsers](#arc--opera--other-chromium-browsers)
  - [4. Pinning the Extension](#4-pinning-the-extension)
  - [5. How to Export a Conversation](#5-how-to-export-a-conversation)
    - [Step 1: Open Google Chat](#step-1-open-google-chat)
    - [Step 2: Open the Target Conversation](#step-2-open-the-target-conversation)
    - [Step 3: Open ChatVault](#step-3-open-chatvault)
    - [Step 4: Configure Settings (Speed \& Media)](#step-4-configure-settings-speed--media)
    - [Step 5: Click "⚡ Fast Export Current Chat"](#step-5-click--fast-export-current-chat)
    - [Step 6: Instant Download](#step-6-instant-download)
  - [6. Export Options Explained](#6-export-options-explained)
  - [7. Opening \& Exploring Your Exported Files](#7-opening--exploring-your-exported-files)
    - [A. Interactive Offline Viewer (`index.html`)](#a-interactive-offline-viewer-indexhtml)
    - [B. Spreadsheet History (`chat_history.csv`)](#b-spreadsheet-history-chat_historycsv)
    - [C. Developer Data (`chat_data.json`)](#c-developer-data-chat_datajson)
    - [D. Attached Images (`images/`)](#d-attached-images-images)
  - [8. Troubleshooting \& FAQs](#8-troubleshooting--faqs)
    - [Q1: The popup says "Google Chat Not Detected" even though I have Google Chat open.](#q1-the-popup-says-google-chat-not-detected-even-though-i-have-google-chat-open)
    - [Q2: I modified code or updated files. How do I reload the extension?](#q2-i-modified-code-or-updated-files-how-do-i-reload-the-extension)
    - [Q3: Why did auto-scrolling stop before reaching the absolute beginning?](#q3-why-did-auto-scrolling-stop-before-reaching-the-absolute-beginning)
    - [Q4: Does ChatVault send any of my chat data to a server?](#q4-does-chatvault-send-any-of-my-chat-data-to-a-server)
  - [📞 Support \& Verification](#-support--verification)

---

## 1. Prerequisites

Before installing ChatVault:
* Any modern Chromium-based browser:
  * Google Chrome (v109+)
  * Microsoft Edge (v109+)
  * Brave Browser
  * Opera / Opera GX
  * Arc Browser
* The `google-chat-exporter` folder containing:
  * [`manifest.json`](manifest.json)
  * [`popup.html`](popup.html)
  * [`popup.css`](popup.css)
  * [`popup.js`](popup.js)
  * [`content.js`](content.js)
  * [`jszip.min.js`](jszip.min.js) *(already bundled in root directory)*
  * [`icons/`](icons/)

---

## 2. Quick Start (3-Step Setup)

```text
[1] Open chrome://extensions  ──>  [2] Enable Developer Mode  ──>  [3] Click "Load unpacked" & select folder
```

Once loaded, navigate to [chat.google.com](https://chat.google.com), open any conversation, and click the ChatVault icon in your browser toolbar!

---

## 3. Installation Guide

### Google Chrome

1. Open **Google Chrome**.
2. Type `chrome://extensions` in the address bar and press <kbd>Enter</kbd>.
3. In the top-right corner, switch the **Developer mode** toggle **ON**:
   ```
   Developer mode  [  ●  ] (Enabled)
   ```
4. In the top-left toolbar that appears, click the **Load unpacked** button.
5. In the file explorer dialog, browse to and select the `google-chat-exporter` folder (the folder containing `manifest.json`):
   ```
   Path: e:\personal\google-chat-exporter
   ```
6. Click **Select Folder**.
7. ChatVault will now appear as an active extension card with version `1.2.0`.
8. Whenever you update code files, simply click the **Reload (🔄)** icon on the extension card in `chrome://extensions`.

---

### Microsoft Edge

1. Open **Microsoft Edge**.
2. Type `edge://extensions` in the address bar and press <kbd>Enter</kbd>.
3. In the left sidebar, enable the **Developer mode** toggle switch.
4. Click the **Load unpacked** button at the top of the page.
5. Select the `google-chat-exporter` folder and confirm.

---

### Brave Browser

1. Open **Brave**.
2. Type `brave://extensions` in the address bar and press <kbd>Enter</kbd>.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the `google-chat-exporter` folder.

---

### Arc / Opera / Other Chromium Browsers

1. Go to the browser's extensions page (`arc://extensions` or `opera://extensions`).
2. Turn on **Developer Mode**.
3. Click **Load Unpacked Extension** and choose the `google-chat-exporter` directory.

---

## 4. Pinning the Extension

To make exporting quick and accessible:

1. Click the **Extensions puzzle icon** (`🧩`) in the top-right of your browser toolbar.
2. Locate **ChatVault - Google Chat Exporter & Archiver** in the dropdown list.
3. Click the **Pin icon** (`📌`) next to it.
4. The blue ChatVault shield/vault icon will now remain visible directly in your browser toolbar.

---

## 5. How to Export a Conversation

Follow these simple steps whenever you want to backup or archive a chat:

### Step 1: Open Google Chat
Navigate to either:
* **Standalone Google Chat**: [https://chat.google.com](https://chat.google.com)
* **Gmail with Chat**: [https://mail.google.com/chat](https://mail.google.com/chat)

### Step 2: Open the Target Conversation
Click on the **Direct Message (DM)**, **Group Conversation**, or **Space** you want to export. Ensure the chat messages are visible on your screen.

### Step 3: Open ChatVault
Click the **ChatVault icon** in your toolbar. A clean popup card will open:
* It will display **Connected to Chat** with a glowing green status indicator.
* It will show the detected name of your conversation (e.g. `Engineering Sprint`, `Project Alpha`, or your contact's name).
* It will show how many messages are currently loaded in view.

> [!NOTE]
> If you click the icon while on a tab other than Google Chat, ChatVault displays a helpful notice with a one-click button: **Open Google Chat**.

### Step 4: Configure Format & Scroll Options
1. **Choose Export Format**:
   * **📄 Save as HTML (Recommended)**: Downloads a single, self-contained `.html` file styled **identically to native Google Chat**. All shared images are embedded directly as Base64 data URLs—no unzipping needed!
   * **📦 ZIP Archive**: Bundles `index.html`, `chat_history.csv`, `chat_data.json`, and an `images/` directory.
2. **Scroll Options**:
   * **Auto-scroll top to bottom**: Turn this **ON** to have ChatVault scroll all the way up to load complete history, then smoothly sweep top-to-bottom so every virtualized message, avatar, and image is fully rendered. Keep **OFF** for fast instant exports of currently visible messages.
3. **Include shared images**: Keep checked to download and embed all full-resolution attachments.

### Step 5: Click "⚡ Save as HTML" (or "Export as ZIP")
* ChatVault will immediately scan messages, fetch media in parallel chunks, and trigger an instant download.
* Live status updates show:
  * **Status**: *"Extracting messages and text..."*, *"Embedding images into HTML..."*, *"Finalizing..."*.
  * **Progress Bar**: Smooth progress indicator from 0% to 100%.
  * **Live Counters**: Real-time count of parsed messages, downloaded images, and elapsed time.

### Step 6: Instant Download
As soon as processing finishes, your browser immediately downloads:
* For HTML format: `[Conversation_Name]_Chat_[Date].html` *(Single 100% offline file!)*
* For ZIP format: `[Conversation_Name]_ChatVault_[Date].zip`

---

## 6. Export Options Explained

| Option | Default | Description |
| :--- | :---: | :--- |
| **Save as HTML** | **Selected** | Exports directly as a standalone `.html` file styled to look **just like native Google Chat** on screen. All shared media are embedded as Base64 data URLs. |
| **ZIP Archive** | Optional | Exports as a structured `.zip` containing HTML viewer, CSV spreadsheet, JSON dump, and `images/` folder. |
| **Auto-scroll top to bottom** | **OFF** | When enabled, scrolls up to the top to fetch history, then sweeps down to the bottom to hydrate all virtualized messages and image elements. |
| **Include shared images** | **ON** | Fetches and embeds all shared photos in full resolution. Uses in-memory `<canvas>` fallbacks to bypass CORS boundaries. |

---

## 7. Opening & Exploring Your Exported Files

### A. Standalone HTML File (`.html`)
Simply double-click the downloaded `.html` file to view it in Chrome, Edge, Safari, or Firefox:
* **Looks Just Like Native Google Chat**:
  * Authentic Google Chat top bar, brand logo, and space/DM title.
  * Message clustering: consecutive messages from the same sender are cleanly grouped without repeating avatars.
  * Quoted reply cards with the Google blue vertical bar, author name, and snippet.
  * User mentions highlighted in Google Chat blue badge style (`@user`).
  * Centered date separator chips (`Today`, `Yesterday`, `October 28, 2026`).
  * Reaction pill badges with emojis and counts (`👍 2`, `❤️ 1`).
  * Embedded full-resolution images with click-to-enlarge lightbox modal.
  * Built-in instant search bar to filter messages live.
  * Dark / Light mode toggle.
* **100% Self-Contained**: All images are embedded inside the single HTML file. No external folders, zero broken links, works completely offline.

### B. ZIP Archive (If selected)
Extract the downloaded `.zip` file to view:
* `index.html` &mdash; Offline viewer.
* `chat_history.csv` &mdash; Excel-compatible spreadsheet with UTF-8 BOM.
* `chat_data.json` &mdash; Raw JSON dump for developers.
* `images/` &mdash; Full-resolution image files.
  1. `Timestamp`: Exact date and time of the message.
  2. `Sender`: Sender display name.
  3. `In Reply To`: Sender and snippet of any quoted parent message.
  4. `Message Text`: Full message body preserving intentional line breaks.
  5. `Attached Images`: Local file paths (e.g. `images/img_1.png`).

### C. Developer Data (`chat_data.json`)
Open `chat_data.json` in VS Code or parse it with Python / Node.js:
```json
{
  "metadata": {
    "title": "Core Engineering",
    "exportedAt": "2026-10-29T11:45:00.000Z",
    "generator": "ChatVault Chrome Extension v1.0",
    "messageCount": 142,
    "imageCount": 8,
    "participants": ["Alice", "Bob", "Charlie"]
  },
  "messages": [
    {
      "id": "spaces/.../messages/...",
      "timestamp": "Oct 28, 2026, 3:15 PM",
      "sender": "Alice",
      "replyTo": {
        "sender": "Bob",
        "snippet": "Here is the release schedule."
      },
      "text": "Approved! Let's deploy tomorrow.",
      "images": ["images/img_1.png"],
      "reactions": ["👍 2", "🚀 1"]
    }
  ]
}
```

### D. Attached Images (`images/`)
Every photo, diagram, and screenshot shared in the chat is saved into the `images/` directory:
* Automatically filtered to remove user profile avatars and emojis.
* Stored with original dimensions and correct extensions (`.png`, `.jpg`, `.webp`, `.gif`).

---

## 8. Troubleshooting & FAQs

### Q1: The popup says "Google Chat Not Detected" even though I have Google Chat open.
**Solution**:
1. Make sure you are actively looking at a tab with the URL starting with `https://chat.google.com` or `https://mail.google.com/chat`.
2. Click inside the chat window, then click the ChatVault extension icon again.
3. Refresh the Google Chat tab (<kbd>F5</kbd> or <kbd>Ctrl + R</kbd>) and re-open the popup.

### Q2: I modified code or updated files. How do I reload the extension?
**Solution**:
1. Go to `chrome://extensions`.
2. Locate the **ChatVault** card.
3. Click the circular **Reload** icon (`🔄`) in the bottom-right corner of the card.
4. Refresh your Google Chat browser tab.

### Q3: Why did auto-scrolling stop before reaching the absolute beginning?
**Solution**:
* Google Chat dynamically renders messages as you scroll. If you have years of messages (10,000+ messages), the safety limit is set to 40-45 continuous scroll batches to prevent browser memory exhaustion.
* If you need an earlier period, manually scroll up in Google Chat to load that section, and ChatVault will scrape everything currently in view.

### Q4: Does ChatVault send any of my chat data to a server?
**Answer**:
* **No, absolutely never.** ChatVault is 100% client-side. All scanning, media fetching, ZIP creation, and downloading take place directly inside your local browser sandbox. No external analytics, telemetry, or remote servers are involved.

---

## 📞 Support & Verification

To verify that all extension components are loaded properly, check that your folder contains:
* [`manifest.json`](manifest.json) &mdash; Configuration (MV3)
* [`popup.html`](popup.html) &mdash; Popup UI
* [`popup.css`](popup.css) &mdash; UI Styling
* [`popup.js`](popup.js) &mdash; Controller logic
* [`content.js`](content.js) &mdash; Scraper engine
* [`jszip.min.js`](jszip.min.js) &mdash; ZIP compressor
* [`icons/`](icons/) &mdash; Extension icons

