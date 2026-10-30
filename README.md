# ChatVault &mdash; Google Chat PDF Exporter

**ChatVault** is a fast, 100% client-side Chromium browser extension (Manifest V3) designed to export the **current active conversation** in Google Chat (`chat.google.com` or `mail.google.com`) directly into a clean, print-ready vector **PDF document**.

It extracts complete conversation threads, exact timestamps, senders, quoted replies, emoji reactions, in-line thread summaries, and embeds full-resolution shared screenshots and media cleanly within PDF page boundaries.

---

## 🌟 Key Features

1. **Focused Current Chat Export**:
   - Automatically detects and binds to your active Google Chat Direct Message, Group Chat, or Space.
   - Shows active status, conversation title, and loaded message count in real time.

2. **Professional Vector PDF**:
   - Generates an A4 print-ready multi-page document powered by **jsPDF**.
   - Includes Google Chat green accent header bar, export metadata, participant list, word-wrapped message bodies, scaled embedded images, and automatic page numbers (`Page X of Y`).

3. **Smart History Sweeping (Auto-scroll)**:
   - Sweeps from top to bottom to hydrate virtualized DOM messages and lazy-loaded screenshots.
   - Option to disable auto-scroll for sub-second exports of the currently loaded chat view.

4. **Media Embedding**:
   - Embeds shared photos and screenshots scaled cleanly within PDF page bounds.

5. **Real-Time Progress & Metrics**:
   - Live 4-metric tracker (`Discovered`, `Processed`, `Skipped`, `Failed`) with live elapsed timer.
   - One-click safe export cancellation.

---

## 🚀 Quick Setup & Installation

### Step 1: Verify Dependencies
ChatVault bundles its client-side libraries locally:
- `jspdf.umd.min.js` (for client-side vector PDF generation)
- `jszip.min.js`

Both files are already present in your `google-chat-exporter/` directory.

---

### Step 2: Load Unpacked Extension in Chrome / Edge / Brave

1. Open your Chromium browser (Google Chrome, Microsoft Edge, Brave, Opera, Arc, etc.).
2. Navigate to the extensions manager:
   - In Google Chrome: `chrome://extensions`
   - In Microsoft Edge: `edge://extensions`
   - In Brave: `brave://extensions`
3. In the top-right corner, enable the **"Developer mode"** toggle switch.
4. Click the **"Load unpacked"** button in the top-left toolbar.
5. In the file picker, select the `google-chat-exporter/` directory.
6. **ChatVault** will appear in your extensions list. Click the puzzle icon in Chrome's toolbar and **pin** ChatVault for 1-click access.
7. *Tip: Whenever you update code files, simply click the **Reload (🔄)** icon on the ChatVault card in `chrome://extensions`.*

---

## 💡 How to Export Current Chat to PDF

1. Go to [Google Chat](https://chat.google.com) or [Gmail](https://mail.google.com).
2. Open the **Direct Message**, **Group Chat**, or **Space** you wish to export.
3. Click the **ChatVault** extension icon in your browser toolbar.
4. The extension automatically detects the active conversation.
5. Customize options:
   - **Auto-scroll top to bottom**: Sweeps through history to render older messages and lazy-loaded screenshots.
   - **Include shared media**: Embeds full-resolution screenshots directly into the PDF.
6. Click **"⚡ Export Chat as PDF"**.
7. Watch the live progress tracker. Your browser will automatically download the print-ready `.pdf` document!

---

## 🔒 Privacy & Security

- **100% Client-Side**: ChatVault runs strictly inside your browser sandbox.
- **Zero External Transmissions**: Your private messages, contacts, tokens, and media are never transmitted to any third-party server or external API.
- **Direct Auth Fetching**: Media attachments are fetched using your existing active Google Chat session directly within your browser.

---

## 🛠️ Project Structure

```
google-chat-exporter/
├── manifest.json            # Manifest V3 configuration
├── popup.html               # Clean popup interface focused on Current Chat PDF export
├── popup.css                # Modern responsive styling
├── popup.js                 # Popup controller with live 4-metric progress tracking
├── content.js               # Isolated content extraction & PDF generation engine
├── jspdf.umd.min.js         # jsPDF 2.5.1 library
├── jszip.min.js             # JSZip library
├── icons/                   # Chrome extension PNG icons (16, 32, 48, 128)
├── HOW_TO_INSTALL_AND_USE.md# Step-by-step user guide
└── README.md                # Project documentation
```
