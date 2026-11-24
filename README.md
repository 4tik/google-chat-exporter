# Google Chat Exporter &mdash; Advanced Thread Support

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?style=flat-square&logo=googlechrome)](https://chrome.google.com)
[![Zero External Network](https://img.shields.io/badge/Privacy-100%25%20Client--Side-green?style=flat-square)](https://chat.google.com)
[![Tested Scenarios](https://img.shields.io/badge/Tests-16%20Passed-brightgreen?style=flat-square)](tests/)

A production-ready Google Chrome Extension (Manifest V3) designed to export Google Chat conversations, spaces, direct messages, and group discussions while strictly identifying and preserving Google Chat's original message-thread hierarchy.

---

## 📑 Table of Contents

1. [Project Overview](#-project-overview)
2. [Critical Scenario: Multi-Thread Architecture](#-critical-scenario-multi-thread-architecture)
3. [Key Features](#-key-features)
4. [Installation & Setup](#-installation--setup)
5. [How to Use the Extension](#-how-to-use-the-extension)
6. [Export Formats](#-export-formats)
7. [Thread Extraction Architecture](#-thread-extraction-architecture)
8. [Data Model & Hierarchy](#-data-model--hierarchy)
9. [Reliability & Integrity Guarantees](#-reliability--integrity-guarantees)
10. [Testing Suite](#-testing-suite)
11. [Known Limitations](#-known-limitations)
12. [Troubleshooting](#-troubleshooting)
13. [Development & Build Instructions](#-development--build-instructions)

---

## 🎯 Project Overview

Google Chat conversations frequently contain complex hierarchical structures where a single parent message anchors multiple independent threads, each containing separate replies. Traditional scrapers flatten replies into a single linear feed or discard thread boundaries, corrupting context.

**Google Chat Exporter** solves this by maintaining a strict three-tier logical hierarchy:

```
Parent Message
  ├── Thread 1 (2 replies)
  │     ├── Reply 1
  │     └── Reply 2
  ├── Thread 2 (3 replies)
  │     ├── Reply 1
  │     ├── Reply 2
  │     └── Reply 3
  ├── Thread 3 (1 reply)
  │     └── Reply 1
  ├── Thread 4 (4 replies)
  │     ├── Reply 1
  │     ├── Reply 2
  │     ├── Reply 3
  │     └── Reply 4
  └── Thread 5 (2 replies)
        ├── Reply 1
        └── Reply 2
```

Every thread is extracted as an independent entity, preserving thread IDs, titles, chronological ordering, author metadata, inline media, and reactions.

---

## ⚡ Critical Scenario: Multi-Thread Architecture

In modern Google Chat spaces and API-managed conversations:
- A single parent message may anchor **5 or more independent reply threads**.
- Each thread contains its own isolated conversation replies.
- **The exporter never merges separate threads into one conversation or flat reply list.**
- The original relationship between parent messages, independent threads, and replies is preserved across **HTML**, **PDF**, and **JSON** export formats.

---

## 🌟 Key Features

### 1. Automatic Google Chat Detection
- Detects whether the active browser tab is running Google Chat (`chat.google.com`) or Gmail Chat (`mail.google.com`).
- Automatically identifies:
  - **Direct Messages (1:1 DMs)**
  - **Group Conversations**
  - **Google Chat Spaces** (Topic-based spaces and Inline-threaded spaces)
- Real-time popup dashboard displays:
  - Current conversation or space name
  - Conversation type
  - Live export status
  - Discovered messages count
  - Discovered threads count
  - Discovered replies count
  - Discovered attachments count

### 2. Advanced Thread Extraction
- Discovers independent thread containers (`[data-thread-id]`, `[data-topic-id]`, thread reply triggers, side-panel reply drawers).
- Preserves unique thread identifiers and parent message associations.
- Assigns clear thread titles and sequential indices (`Thread 1`, `Thread 2`, etc.).
- Preserves exact message ordering and timestamps within each thread.
- Tracks completeness and reports whether all replies declared by Google Chat were extracted.

### 3. Comprehensive Attachment Handling
- Preserves images, screenshots, PDF documents, Office files, and Google Drive resources.
- **Strict ownership guarantee**: Attachments remain directly under their originating parent message or reply&mdash;never moved to unrelated threads.
- Automatically upgrades image thumbnails (`=w...`) to full-resolution sources (`=s0`) and embeds them offline as base64 data URLs in standalone exports.
- Flags inaccessible or expired media without breaking document structure.

### 4. Interactive Standalone HTML Export
- 100% self-contained HTML file styled after native Google Chat (Material Design 3).
- Works completely offline without needing the browser extension or Google Chat open.
- Real-time client-side search across parent messages and replies.
- Filter conversations by sender dropdown.
- Expand / collapse individual threads or all threads simultaneously.
- Responsive design for mobile, tablet, and desktop viewing.
- Dark / Light theme toggle with local persistence.
- Print-friendly layout (`@media print`) for hard-copy records or print-to-PDF.

### 5. Professional Vector PDF Export
- Generates A4 print-ready multi-page documents.
- Clearly distinguishes parent message headers from distinct thread blocks with colored accent markers.
- Word-wrapped message bodies and scaled media attachments.
- Automatic page numbering (`Page X of Y`), export timestamp, and conversation metadata.

### 6. Standardized JSON Schema
- Export structured, machine-readable JSON matching the strict parent &rarr; threads &rarr; replies specification for programmatic archiving and auditing.

---

## 📦 Installation & Setup

### Prerequisites
- Any modern Chromium browser: **Google Chrome**, **Microsoft Edge**, **Brave**, **Opera**, or **Vivaldi**.

### Step 1: Open Chrome Extensions
1. Launch your Chromium browser.
2. Navigate to `chrome://extensions` in the address bar.
3. In the top-right corner, switch the **"Developer mode"** toggle to **ON**.

### Step 2: Load Unpacked Extension
1. Click the **"Load unpacked"** button in the top-left toolbar.
2. In the folder picker dialog, select the root `google-chat-exporter/` directory.
3. The extension card **"Google Chat Exporter"** will appear in your extensions list.
4. Pin the extension to your browser toolbar for easy access.

---

## 🚀 How to Use the Extension

1. Navigate to [Google Chat](https://chat.google.com) or [Gmail](https://mail.google.com).
2. Open the **Direct Message**, **Group Conversation**, or **Space** you want to archive.
3. Click the **Google Chat Exporter** icon in your browser toolbar to open the popup.
4. The popup automatically scans and displays:
   - Target conversation name and type badge
   - Live discovered counts for messages, threads, replies, and attachments
5. Select your desired export format:
   - **HTML**: Standalone interactive viewer with native Google Chat styling.
   - **PDF**: Multi-page printable vector document.
   - **JSON**: Structured machine-readable schema.
   - **ZIP**: Complete master bundle (HTML + PDF + JSON + media attachments).
6. Configure extraction options:
   - **Retrieve full message history**: Sweeps upward through the virtualized DOM to paginate and load older messages.
   - **Download images & attachments**: Embeds full-resolution offline media.
7. Click **"Start Export"**.
8. Monitor real-time extraction progress (Discovered &rarr; Processed &rarr; Threads &rarr; Replies &rarr; Media).
9. Once finished, your browser will automatically download the exported file!

---

## 📁 Export Formats

### 1. HTML (`.html`)
- Standalone single-file document with embedded CSS and vanilla JavaScript.
- Distinguishable parent message cards with sender avatar, timestamp, message body, attachments, and reaction emojis.
- Separate, collapsible thread containers for each independent thread.
- Embedded search bar, sender filter, theme toggle, and lightbox image previewer.

### 2. PDF (`.pdf`)
- Formatted for standard A4 pages with portrait orientation.
- Visual hierarchy preserved: parent messages &rarr; thread sub-boxes &rarr; replies.
- Page header, export metadata, and footer page numbers.

### 3. JSON (`.json`)
Structured schema maintaining strict thread isolation:
```json
{
  "conversation": {
    "id": "CONVERSATION_ID",
    "name": "Project Discussion",
    "type": "SPACE"
  },
  "export": {
    "exportedAt": "2026-11-24T10:00:00.000Z",
    "version": "1.0",
    "stats": {
      "totalMessages": 1,
      "totalThreads": 5,
      "totalReplies": 12,
      "totalAttachments": 3
    }
  },
  "messages": [
    {
      "id": "MSG-001",
      "sender": {
        "id": "user_atikur_rahman",
        "name": "Atikur Rahman",
        "avatarUrl": "https://lh3.googleusercontent.com/..."
      },
      "text": "Please review the project update.",
      "timestamp": "2026-11-24T10:00:00.000Z",
      "edited": false,
      "reactions": [{ "emoji": "👍", "count": 4 }],
      "attachments": [],
      "threads": [
        {
          "id": "THREAD-001",
          "title": "Thread 1",
          "threadIndex": 1,
          "replyCount": 2,
          "status": "complete",
          "replies": [
            {
              "id": "REPLY-001",
              "threadId": "THREAD-001",
              "parentMessageId": "MSG-001",
              "sender": { "name": "Farhan Akhanda" },
              "text": "The update is ready.",
              "timestamp": "2026-11-24T10:01:00.000Z",
              "attachments": []
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 🏗️ Thread Extraction Architecture

The codebase follows an independent, modular architecture with clear separation between UI, extraction, data processing, and export generation:

```
google-chat-exporter/
├── manifest.json                    # Manifest V3 configuration
├── popup.html                       # Modern Google-inspired popup interface
├── popup.css                        # Responsive popup design system
├── popup.js                         # Popup controller & live progress tracker
├── content.js                       # Content execution script in Google Chat tab
├── package.json                     # Node.js test configuration (type: module)
├── jszip.min.js                     # Client-side ZIP packaging library
├── jspdf.umd.min.js                 # Client-side PDF generation library
├── icons/                           # Extension icon assets (16, 32, 48, 128)
├── src/
│   ├── background/
│   │   └── background.js            # MV3 service worker (downloads & badge)
│   ├── modules/
│   │   ├── chatDetector.js          # Google Chat page & conversation context detection
│   │   ├── messageExtractor.js      # Parent message extraction & DOM parsing
│   │   ├── threadExtractor.js       # Independent thread discovery & multi-thread isolation
│   │   ├── replyExtractor.js        # Reply message extraction & ordering within threads
│   │   ├── attachmentExtractor.js   # Media resolution, files & drive resource extraction
│   │   ├── paginationManager.js     # Virtualized feed scrolling, hydration & safety limits
│   │   ├── dataNormalizer.js        # Data sanitization, hierarchy assembly & completeness validation
│   │   └── duplicateManager.js      # O(1) deduplication of messages, threads & replies
│   ├── exporters/
│   │   ├── htmlExporter.js          # Standalone responsive HTML generator
│   │   ├── pdfExporter.js           # Multi-page vector PDF generator
│   │   ├── jsonExporter.js          # Structured JSON generator
│   │   └── zipExporter.js           # Master ZIP bundle generator
│   └── utils/
│       └── idbStore.js              # IndexedDB temporary caching for large datasets
└── tests/
    ├── test_scenarios.test.js       # Verification of all 12 core test scenarios
    └── thread_extraction.test.js    # In-depth unit tests for Thread & Reply extractors
```

---

## 🛡️ Reliability & Integrity Guarantees

1. **No Incomplete Claims**: The exporter never exports only currently visible messages and claims the conversation is complete. If older messages or replies could not be loaded, the report clearly indicates partial data.
2. **Never Invent Data**: If a message or reply is missing or inaccessible due to permissions, the exporter flags the item rather than fabricating contents.
3. **Strict Deduplication**: Uses deterministic ID tracking and non-cryptographic content hashing to guarantee no message, thread, or reply is double-counted.
4. **Virtualized Scroll Handling**: Automatically compensates for DOM element recycling by caching extracted items in memory and IndexedDB.
5. **Session-Authorized Access Only**: Runs strictly within the authenticated user's active browser session without spoofing credentials or bypassing access controls.

---

## 🧪 Testing Suite

The project includes automated test coverage validating all 12 core scenarios:

| Scenario | Description | Status |
|---|---|---|
| **Scenario 1** | One parent message with no threads | ✅ Passed |
| **Scenario 2** | One parent message with one thread | ✅ Passed |
| **Scenario 3** | **Critical Scenario**: One parent message with 5 independent threads preserved separately | ✅ Passed |
| **Scenario 4** | One parent message with 20+ threads | ✅ Passed |
| **Scenario 5** | Multiple parent messages, each with multiple threads | ✅ Passed |
| **Scenario 6** | Threads containing variable numbers of replies | ✅ Passed |
| **Scenario 7** | Threads containing images and attachments under correct parents | ✅ Passed |
| **Scenario 8** | Long conversations with pagination and stall detection | ✅ Passed |
| **Scenario 9** | Partially loaded conversations and completeness diagnostics | ✅ Passed |
| **Scenario 10** | Duplicate prevention during repeated extraction | ✅ Passed |
| **Scenario 11** | Edited message detection and preservation | ✅ Passed |
| **Scenario 12** | Network interruption and cancellation handling | ✅ Passed |
| **Integrity** | Verification that HTML and JSON exports preserve identical hierarchy and item counts | ✅ Passed |

To run the automated tests:
```bash
node --test tests/*.test.js
```

---

## ⚠️ Known Limitations

1. **Access Permissions**: The extension can only export conversations and attachments accessible to the currently logged-in Google account.
2. **Deleted Messages**: Messages deleted prior to export cannot be recovered from Google Chat's DOM.
3. **Large Conversations**: Conversations with tens of thousands of messages may take a couple of minutes to paginate upwards through the virtualized scroll feed.

---

## 🔧 Troubleshooting

- **"Google Chat Not Detected" in Popup**:
  Ensure you are on `https://chat.google.com` or `https://mail.google.com/chat`. Refresh the tab and re-open the popup.
- **Incomplete History Exported**:
  Ensure the option *"Retrieve full message history"* is enabled in the popup options card so the paginator can sweep to the top of the feed.
- **Images Not Showing in Offline HTML**:
  Ensure the *"Download images & attachments"* toggle is turned on before starting the export.

---

## 💻 Development & Build Instructions

1. Clone or download the repository to your local machine.
2. No complex build step or transpiler is required&mdash;the extension uses modern, native browser-standard ES6+ JavaScript and Manifest V3.
3. Run the automated test suite:
   ```bash
   node --test tests/*.test.js
   ```
4. Reload the extension in `chrome://extensions` via the **Refresh (🔄)** icon after making code changes.

---

## 📄 License

MIT License. Developed for Google Chat conversation archiving with advanced thread preservation.
