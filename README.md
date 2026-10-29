# ChatVault &mdash; Google Chat Exporter & Archiver

**ChatVault** is a production-grade, 100% client-side Chromium browser extension (Manifest V3) designed to export, backup, and archive conversations from Google Chat (`chat.google.com` and `mail.google.com`).

It extracts full conversation threads, exact timestamps, senders, quoted replies, emoji reactions, in-line thread summaries, and full-resolution shared screenshots/media into standalone **HTML**, print-ready **PDF**, or a complete **ZIP** bundle.

---

## 🌟 Key Capabilities

1. **Native Google Chat Replica (Standalone HTML)**:
   - Self-contained, responsive chat reader styled exactly like Google Chat.
   - Preserves message cards, profile avatars, bold sender names, and exact timestamps.
   - Renders **in-line thread reply bars** (e.g. `6 unread 6 replies Tue 5:38 PM`) right below message cards.
   - Highlights `@mentions`, code blocks, bold/italic text, and clickable links.
   - Offline Base64 embedded full-resolution screenshots and media attachments.
   - Built-in **real-time search bar** to filter conversation messages instantly.
   - Click-to-enlarge **interactive image lightbox** modal.
   - Dark / Light theme toggle.

2. **Professional Vector PDF Export**:
   - Generates an A4 print-ready multi-page document using **jsPDF**.
   - Includes Google Chat green header bar, export metadata, participant list, word-wrapped message bodies, scaled images, and automatic page numbers (`Page X of Y`).

3. **Complete Master Bundle (Both / ZIP)**:
   - Bundles Native HTML + Vector PDF + CSV spreadsheet (`chat_history.csv`) + JSON developer dump (`chat_data.json`) + `images/` directory.

4. **Multi-Conversation Batch Export**:
   - Automatically discovers accessible Direct Messages and Spaces from your sidebar navigation.
   - Filter, select all, or choose specific conversations to archive sequentially into a master ZIP.

5. **Fast & Adaptive Two-Phase Auto-Scroll**:
   - Sweeps from top to bottom at high speed to hydrate virtualized DOM message elements and lazy-loaded screenshots.
   - Option to disable auto-scroll for sub-second instant exports of the currently visible screen.

---

## 🚀 Quick Setup & Installation

### Step 1: Verify Dependencies
ChatVault bundles its client-side libraries locally:
- `jszip.min.js` (for ZIP archiving)
- `jspdf.umd.min.js` (for client-side vector PDF generation)

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

## 💡 How to Export a Google Chat Conversation

1. Go to [Google Chat](https://chat.google.com) or [Gmail](https://mail.google.com).
2. Open the **Direct Message**, **Group Chat**, or **Space** you wish to export.
3. Click the **ChatVault** extension icon in your browser toolbar.
4. Choose your format:
   - **HTML**: Self-contained offline viewer matching Google Chat's exact design with embedded screenshots.
   - **PDF**: Multi-page printable vector PDF.
   - **Both (ZIP)**: Full package (HTML + PDF + CSV + JSON + raw images).
5. Customize options:
   - **Auto-scroll top to bottom**: Sweeps through history to render older messages and hydrate lazy-loaded screenshots.
   - **Include shared media**: Embeds full-resolution screenshots and attachments.
6. Click **"Save as HTML"** (or PDF / ZIP).
7. Watch the live 4-metric progress tracker (`Discovered`, `Processed`, `Skipped`, `Failed`). Your browser will immediately download the finished archive!

---

## 🔒 Privacy & Security

- **100% Client-Side**: ChatVault runs strictly inside your browser sandbox.
- **Zero External Transmissions**: Your private messages, contacts, tokens, and media are never transmitted to any third-party server or external API.
- **Direct Auth Fetching**: Media attachments are fetched using your existing active Google Chat session directly within your browser.

---

## 🛠️ Project Structure

```
google-chat-exporter/
├── manifest.json            # Manifest V3 configuration with host permissions
├── popup.html               # Modern popup interface with single & batch tabs
├── popup.css                # Tailwind-inspired modern responsive styles
├── popup.js                 # Popup controller with live 4-metric progress tracking
├── content.js               # Isolated content extraction engine & HTML/PDF generators
├── jszip.min.js             # JSZip 3.10.1 library
├── jspdf.umd.min.js         # jsPDF 2.5.1 library
├── icons/                   # Chrome extension PNG icons (16, 32, 48, 128)
├── HOW_TO_INSTALL_AND_USE.md# Step-by-step installation guide
└── README.md                # Project documentation
```
