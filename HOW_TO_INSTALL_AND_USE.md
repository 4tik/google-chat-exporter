# How to Install and Use ChatVault

A step-by-step user guide for installing, configuring, and exporting Google Chat conversations using **ChatVault (Google Chat PDF Exporter)**.

---

## 📑 Table of Contents
- [1. Prerequisites](#1-prerequisites)
- [2. Quick Start (3-Step Setup)](#2-quick-start-3-step-setup)
- [3. Installation Guide](#3-installation-guide)
  - [Google Chrome](#google-chrome)
  - [Microsoft Edge](#microsoft-edge)
  - [Brave Browser](#brave-browser)
  - [Arc / Opera / Other Chromium Browsers](#arc--opera--other-chromium-browsers)
- [4. Pinning the Extension](#4-pinning-the-extension)
- [5. How to Export Current Chat as PDF](#5-how-to-export-current-chat-as-pdf)
  - [Step 1: Open Google Chat](#step-1-open-google-chat)
  - [Step 2: Open Target Conversation](#step-2-open-target-conversation)
  - [Step 3: Open ChatVault](#step-3-open-chatvault)
  - [Step 4: Configure Options](#step-4-configure-options)
  - [Step 5: Click "⚡ Export Chat as PDF"](#step-5-click--export-chat-as-pdf)
  - [Step 6: Instant Download](#step-6-instant-download)
- [6. Export Features & Options](#6-export-features--options)
- [7. PDF Features & Layout](#7-pdf-features--layout)
- [8. Troubleshooting & FAQs](#8-troubleshooting--faqs)

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
  * [`jspdf.umd.min.js`](jspdf.umd.min.js) *(bundled locally for vector PDF generation)*
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
5. In the file explorer dialog, browse to and select the `google-chat-exporter` folder (the folder containing `manifest.json`).
6. Click **Select Folder**.
7. ChatVault will now appear as an active extension card.
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
2. Locate **ChatVault - Google Chat PDF Exporter** in the dropdown list.
3. Click the **Pin icon** (`📌`) next to it.
4. The ChatVault icon will now remain visible directly in your browser toolbar.

---

## 5. How to Export Current Chat as PDF

Follow these simple steps whenever you want to export your current conversation to a print-ready PDF:

### Step 1: Open Google Chat
Navigate to either:
* **Standalone Google Chat**: [https://chat.google.com](https://chat.google.com)
* **Gmail with Chat**: [https://mail.google.com/chat](https://mail.google.com/chat)

### Step 2: Open Target Conversation
Click on the **Direct Message (DM)**, **Group Conversation**, or **Space** you want to export. Ensure the chat messages are visible on your screen.

### Step 3: Open ChatVault
Click the **ChatVault icon** in your toolbar. The extension popup will display:
* **Active Chat Connected** status with a pulsing indicator.
* The detected name of the target conversation (e.g. contact name or space title).
* The number of messages currently loaded in view.

### Step 4: Configure Options
* **Auto-scroll top to bottom**: Turn **ON** to have ChatVault sweep through older messages and hydrate lazy-loaded screenshots. Leave **OFF** for fast export of currently loaded messages.
* **Include shared media**: Leave checked to embed shared screenshots and photos directly into the PDF document.

### Step 5: Click "⚡ Export Chat as PDF"
ChatVault will parse messages, embed media, format page layout, and trigger your download.

### Step 6: Instant Download
Your browser automatically downloads the finished vector PDF:
`[Conversation_Name]_[Date].pdf`

---

## 6. Export Features & Options

| Option | Default | Description |
| :--- | :---: | :--- |
| **Format** | **Vector PDF** | Print-ready, multi-page PDF formatted with header accents, timestamps, participants, and page numbers. |
| **Target Scope** | **Current Chat** | Targets the active conversation currently open in Google Chat. |
| **Auto-scroll top to bottom** | **OFF** | Sweeps top-to-bottom to render virtualized messages and hydrate lazy-loaded screenshots. |
| **Include shared media** | **ON** | Fetches and embeds photos/screenshots cleanly scaled within PDF page boundaries. |

---

## 7. PDF Features & Layout

The exported PDF includes:
* **Branded Header**: Google Chat green accent bar with conversation title, export timestamp, message count, media count, and participant names.
* **Date Headers**: Centered date separator chips marking conversation day transitions.
* **Message Layout**: Sender avatar indicators, bold participant names, exact timestamps, and clean word-wrapped message bodies.
* **Quoted Replies**: Visual reply blocks displaying quoted snippet and parent author.
* **Shared Attachments**: Embedded full-resolution images and links to shared Drive files.
* **Page Numbers**: Automatic footer numbering (`Page X of Y`).

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
3. Click the circular **Reload** icon (`🔄`) on the card.
4. Refresh your Google Chat browser tab.

### Q3: Does ChatVault send any of my chat data to a server?
**Answer**:
* **No, absolutely never.** ChatVault runs 100% client-side inside your browser sandbox. No external servers, analytics, or telemetry are used.
