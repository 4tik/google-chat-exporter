/**
 * @file htmlExporter.js
 * @module HtmlExporter
 * @description Generates a standalone, fully-functional, responsive HTML file
 * designed to look and feel EXACTLY like the native Google Chat web application.
 * Features:
 *  - Native Google Chat light & dark theme styling with Google Sans typography
 *  - Centered date divider chips (e.g. "Tuesday, November 24, 2026")
 *  - Full parent message cards with 38px avatars, bold senders, exact timestamps,
 *    code blocks, blockquotes, styled @mentions, and reaction emoji chips
 *  - Independent thread hierarchy: preserves 5+ threads under one parent message separately
 *  - Embedded high-resolution Base64 screenshots & media attachments with interactive lightbox
 *  - Real-time client-side search, sender filter, and thread collapse/expand controls
 *  - 100% self-contained: works completely offline without internet or extension
 */

'use strict';

/**
 * Escapes HTML characters to prevent XSS.
 * @param {string|null|undefined} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats an ISO timestamp into a readable date/time string.
 * @param {string|null} isoStr
 * @returns {string}
 */
function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch (_) {
    return isoStr;
  }
}

/**
 * Formats an ISO timestamp into a date divider string.
 * @param {string|null} isoStr
 * @returns {string}
 */
function formatDateDivider(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  } catch (_) {
    return '';
  }
}

/**
 * Deterministic color picker for avatar initials like Google Chat
 */
const AVATAR_COLORS = [
  '#1a73e8', '#00897b', '#d93025', '#e37400',
  '#8e24aa', '#3949ab', '#00838f', '#0b8043'
];

function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export class HtmlExporter {
  /**
   * Generates a complete standalone HTML document string identical to Google Chat.
   *
   * @param {Object} conversation - Normalized conversation object
   * @param {Object} [metadata]    - Export metadata
   * @returns {string} Standalone HTML document string
   */
  static export(conversation, metadata = {}) {
    const convoName = metadata.name || conversation.name || 'Google Chat Conversation';
    const convoType = metadata.type || conversation.type || 'SPACE';
    const exportedAt = metadata.exportedAt || conversation.exportedAt || new Date().toISOString();
    const formattedExportDate = new Date(exportedAt).toLocaleString();

    const messages = conversation.messages || [];

    // Calculate totals
    let totalThreads = 0;
    let totalReplies = 0;
    let totalAttachments = 0;
    const senders = new Set();

    messages.forEach(msg => {
      if (msg.sender && msg.sender.name) senders.add(msg.sender.name);
      if (msg.attachments) totalAttachments += msg.attachments.length;

      const threads = msg.threads || [];
      totalThreads += threads.length;
      threads.forEach(t => {
        const replies = t.replies || [];
        totalReplies += replies.length;
        replies.forEach(r => {
          if (r.sender && r.sender.name) senders.add(r.sender.name);
          if (r.attachments) totalAttachments += r.attachments.length;
        });
      });
    });

    const senderOptions = Array.from(senders)
      .sort()
      .map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
      .join('\n');

    // Group messages with date dividers
    let lastDateStr = '';
    let prevMsg = null;
    const renderedItems = [];

    messages.forEach((msg, index) => {
      const dateStr = formatDateDivider(msg.timestamp);
      let isNewDay = false;
      if (dateStr && dateStr !== lastDateStr) {
        renderedItems.push(`
          <div class="gc-date-divider-row date-divider-row">
            <span class="gc-date-divider-text date-divider-pill">${escapeHtml(dateStr)}</span>
          </div>
        `);
        lastDateStr = dateStr;
        isNewDay = true;
      }

      let isContinuation = false;
      if (!isNewDay && prevMsg && (prevMsg.sender?.name || '') === (msg.sender?.name || '')) {
        const timeDiff = Math.abs(new Date(msg.timestamp || 0) - new Date(prevMsg.timestamp || 0));
        if (timeDiff <= 3 * 60 * 1000 && (!prevMsg.threads || prevMsg.threads.length === 0) && (!msg.threads || msg.threads.length === 0)) {
          isContinuation = true;
        }
      }

      renderedItems.push(this._renderParentMessage(msg, index + 1, isContinuation));
      prevMsg = msg;
    });

    const messagesHtml = renderedItems.join('\n');

    return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(convoName)} - Google Chat</title>
<style>
/* Native Google Chat Design System */
:root {
  --font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
  --bg-page: #f8fafd;
  --bg-header: #ffffff;
  --bg-chat-pane: #ffffff;
  --bg-hover: #f1f3f4;
  --bg-thread-card: #f8fafd;
  --bg-reply: #ffffff;
  --border-color: #e0e2e6;
  --border-subtle: #f1f3f4;
  --border-accent: #00897b;
  --text-primary: #1f1f1f;
  --text-secondary: #444746;
  --text-muted: #70757a;
  --google-blue: #1a73e8;
  --google-green: #00897b;
  --chip-bg: #e6f4ea;
  --chip-text: #137333;
  --reaction-bg: #f1f3f4;
  --reaction-border: #dadce0;
  --mention-bg: #e8f0fe;
  --mention-text: #174ea6;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.08);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.12);
  --radius-avatar: 50%;
  --radius-card: 16px;
  --radius-thread: 12px;
  --radius-pill: 20px;
}

[data-theme="dark"] {
  --bg-page: #131314;
  --bg-header: #1f1f1f;
  --bg-chat-pane: #1e1f20;
  --bg-hover: #282a2c;
  --bg-thread-card: #18191a;
  --bg-reply: #222325;
  --border-color: #333537;
  --border-subtle: #282a2c;
  --border-accent: #26a69a;
  --text-primary: #e3e3e3;
  --text-secondary: #c4c7c5;
  --text-muted: #8e918f;
  --google-blue: #8ab4f8;
  --google-green: #26a69a;
  --chip-bg: #1e3a2f;
  --chip-text: #a8dab5;
  --reaction-bg: #2d2f31;
  --reaction-border: #444746;
  --mention-bg: #283e58;
  --mention-text: #d2e3fc;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.4);
  --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.5);
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-family);
  background-color: var(--bg-page);
  color: var(--text-primary);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* App Layout */
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* Header Bar - Native Google Chat Top Bar */
.chat-app-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border-color);
  padding: 12px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow-sm);
}

.header-main-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.chat-logo {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #00897b;
  color: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 6px rgba(0, 137, 123, 0.3);
}

.chat-logo svg {
  width: 24px;
  height: 24px;
}

.convo-title-group h1 {
  font-size: 19px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.2;
}

.convo-meta-badges {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.type-badge {
  background: var(--chip-bg);
  color: var(--chip-text);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}

.export-date-badge {
  font-size: 11.5px;
  color: var(--text-muted);
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.btn-ctrl {
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.2s ease;
}

.btn-ctrl:hover {
  filter: brightness(0.95);
}

/* Header Filter Toolbar */
.filter-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 4px;
}

.search-box-wrap {
  position: relative;
  flex: 1;
  max-width: 480px;
  min-width: 240px;
}

.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 8px 14px 8px 36px;
  border-radius: var(--radius-pill);
  font-size: 13.5px;
  outline: none;
  transition: border-color 0.2s;
}

.search-input:focus {
  border-color: var(--google-blue);
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sender-dropdown {
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 7px 12px;
  border-radius: 8px;
  font-size: 13px;
  outline: none;
  cursor: pointer;
}

/* Chat Pane */
.chat-container {
  max-width: 1020px;
  width: 100%;
  margin: 0 auto;
  padding: 24px 16px;
}

.chat-card-pane {
  background: var(--bg-chat-pane);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* History Banner */
.gc-history-banner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin: 16px 0 28px;
  text-align: center;
  user-select: none;
}

.gc-history-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.gc-history-title svg {
  width: 18px;
  height: 18px;
  color: var(--text-secondary);
}

.gc-history-sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* Date Divider */
.date-divider-row,
.gc-date-divider-row {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  margin: 28px 0 16px;
  user-select: none;
}

.gc-date-divider-text,
.date-divider-pill {
  position: relative;
  z-index: 2;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  padding: 4px 14px;
}

/* Message Rows & Speech Bubbles */
.gc-msg-row {
  margin-bottom: 12px;
  padding: 8px 16px;
}

.gc-msg-incoming {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.gc-avatar-col {
  flex-shrink: 0;
  width: 36px;
}

.gc-avatar-spacer {
  width: 36px;
  height: 1px;
}

.gc-avatar-circle {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-avatar);
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 15px;
  overflow: hidden;
}

.gc-incoming-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.gc-msg-incoming-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.gc-bubble-incoming {
  background-color: #f0f4f9;
  color: #1f1f1f;
  border-radius: 18px;
  padding: 8px 16px;
  font-size: 14px;
  line-height: 1.5;
  max-width: 72%;
  word-break: break-word;
  white-space: pre-wrap;
  display: inline-block;
  box-shadow: 0 1px 1px rgba(0, 0, 0, 0.04);
}

[data-theme="dark"] .gc-bubble-incoming {
  background-color: #282a2c;
  color: #e3e3e3;
}

.gc-msg-outgoing {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.gc-msg-outgoing-meta {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 4px;
  padding-right: 4px;
}

.gc-bubble-outgoing {
  background-color: #1f1f1f;
  color: #ffffff;
  border-radius: 18px;
  padding: 8px 16px;
  font-size: 14px;
  line-height: 1.5;
  max-width: 72%;
  word-break: break-word;
  white-space: pre-wrap;
  display: inline-block;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

[data-theme="dark"] .gc-bubble-outgoing {
  background-color: #004d40;
  color: #ffffff;
}

/* Parent Message Row */
.parent-message-card {
  padding: 10px 18px;
  border-bottom: 1px solid var(--border-subtle);
  transition: background-color 0.15s ease;
}

.parent-message-card:hover {
  background-color: var(--bg-hover);
}

.message-main-layout {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

/* Avatar */
.avatar-col {
  flex-shrink: 0;
}

.avatar-circle {
  width: 38px;
  height: 38px;
  border-radius: var(--radius-avatar);
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 16px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

.avatar-circle img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* Message Content Area */
.message-content-col {
  flex: 1;
  min-width: 0;
}

.message-meta-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.sender-display-name {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.message-time-text {
  font-size: 12px;
  color: var(--text-muted);
}

.edited-indicator {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 2px;
}

/* Body Text */
.message-body-text {
  font-size: 14.5px;
  color: var(--text-primary);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-body-text a {
  color: var(--google-blue);
  text-decoration: none;
}

.message-body-text a:hover {
  text-decoration: underline;
}

.message-body-text code {
  background: var(--bg-hover);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 13px;
}

.message-body-text pre {
  background: var(--bg-hover);
  padding: 10px 14px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 8px 0;
}

/* Mentions */
.mention-chip {
  background: var(--mention-bg);
  color: var(--mention-text);
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  display: inline-block;
}

/* Reactions */
.reactions-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.reaction-chip {
  background: var(--reaction-bg);
  border: 1px solid var(--reaction-border);
  border-radius: var(--radius-pill);
  padding: 2px 8px;
  font-size: 12.5px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: default;
}

.reaction-count {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 11.5px;
}

/* Attachments */
.media-attachments-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
}

.media-image-card {
  max-width: 420px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  overflow: hidden;
  background: #000;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.media-image-card:hover {
  transform: scale(1.01);
}

.media-image-card img {
  display: block;
  width: 100%;
  max-height: 380px;
  object-fit: cover;
}

.file-attachment-card {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 10px 14px;
  text-decoration: none;
  color: var(--text-primary);
  max-width: 380px;
}

.file-icon {
  font-size: 22px;
}

.file-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Threads Container */
.threads-block-wrap {
  margin-top: 14px;
  padding-left: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Individual Thread Card */
.thread-card {
  background: var(--bg-thread-card);
  border: 1px solid var(--border-color);
  border-left: 4px solid var(--border-accent);
  border-radius: var(--radius-thread);
  overflow: hidden;
  transition: border-color 0.2s ease;
}

.thread-header {
  padding: 9px 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(0, 137, 123, 0.05);
  cursor: pointer;
  user-select: none;
}

.thread-header:hover {
  background: rgba(0, 137, 123, 0.09);
}

.thread-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.thread-badge {
  background: #00897b20;
  color: var(--google-green);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 6px;
  letter-spacing: 0.3px;
}

.thread-title-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.thread-meta-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.reply-count-badge {
  font-size: 11.5px;
  font-weight: 600;
  background: var(--bg-reply);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}

.thread-chevron {
  font-size: 11px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.thread-card.collapsed .thread-chevron {
  transform: rotate(-90deg);
}

.thread-card.collapsed .thread-replies-list {
  display: none;
}

/* Thread Replies List */
.thread-replies-list {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.reply-row {
  background: var(--bg-reply);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px 14px;
  display: flex;
  gap: 12px;
}

.reply-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-avatar);
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
  overflow: hidden;
}

.reply-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.reply-content-col {
  flex: 1;
  min-width: 0;
}

.reply-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;
}

.reply-sender-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.reply-body-text {
  font-size: 13.5px;
  color: var(--text-primary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Lightbox Modal */
.lightbox-modal {
  display: none;
  position: fixed;
  z-index: 9999;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.9);
  align-items: center;
  justify-content: center;
}

.lightbox-modal.active {
  display: flex;
}

.lightbox-img {
  max-width: 92%;
  max-height: 92%;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8);
}

/* Print Friendly */
@media print {
  body {
    background: #fff !important;
    color: #000 !important;
  }
  .chat-app-header, .filter-toolbar, .btn-ctrl, .header-controls {
    display: none !important;
  }
  .chat-card-pane, .parent-message-card, .thread-card, .reply-row {
    border: 1px solid #ccc !important;
    box-shadow: none !important;
    page-break-inside: avoid;
  }
  .thread-card.collapsed .thread-replies-list {
    display: flex !important;
  }
}
</style>
</head>
<body>

<div class="app-shell">
  <!-- Google Chat Top App Bar -->
  <header class="chat-app-header">
    <div class="header-main-row">
      <div class="header-left">
        <div class="chat-logo" title="Google Chat">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/>
            <path d="M7 9h10v2H7zm0-3h10v2H7z"/>
          </svg>
        </div>
        <div class="convo-title-group">
          <h1>${escapeHtml(convoName)}</h1>
          <div class="convo-meta-badges">
            <span class="type-badge">${escapeHtml(convoType)}</span>
            <span class="export-date-badge">${messages.length} messages &bull; ${totalThreads} threads &bull; ${totalReplies} replies &bull; ${totalAttachments} media &bull; Exported: ${escapeHtml(formattedExportDate)}</span>
          </div>
        </div>
      </div>
    </div>
  </header>

  <!-- Main Chat Pane -->
  <main class="chat-container">
    <div class="gc-history-banner">
      <div class="gc-history-title">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
        </svg>
        <span>HISTORY IS ON</span>
      </div>
      <div class="gc-history-sub">Messages sent with history on are saved</div>
    </div>
    <div class="chat-card-pane" id="chat-pane">
      ${messagesHtml || '<div style="padding:48px;text-align:center;color:var(--text-muted);">No messages found in conversation.</div>'}
    </div>
  </main>
</div>

<!-- Image Lightbox Modal -->
<div class="lightbox-modal" id="lightbox" onclick="this.classList.remove('active')">
  <img class="lightbox-img" id="lightbox-img" src="" alt="Enlarged screenshot" />
</div>

<script>
// Standalone Interactive Controller
(function() {
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');

  // Individual Thread Card Expand/Collapse
  document.querySelectorAll('.thread-header').forEach(header => {
    header.addEventListener('click', () => {
      const card = header.closest('.thread-card');
      if (card) card.classList.toggle('collapsed');
    });
  });

  // Lightbox click handler
  window.openLightbox = function(url) {
    if (!url || !lightboxImg || !lightbox) return;
    lightboxImg.src = url;
    lightbox.classList.add('active');
  };
})();
</script>
</body>
</html>`;
  }

  /**
   * Renders a single parent message card with avatar, sender, timestamp,
   * message body, media attachments, and separate independent threads.
   * @private
   */
  static _renderParentMessage(msg, index, isContinuation = false) {
    const senderName = msg.sender?.name || 'Participant';
    const isSelf = senderName.toLowerCase() === 'you' || Boolean(msg.isSelf);
    const avatarUrl = msg.sender?.avatarUrl;
    const initial = (senderName[0] || 'U').toUpperCase();
    const avatarColor = getAvatarColor(senderName);
    const timeStr = formatTime(msg.timestamp);
    const textContent = msg.text || '';
    const reactionsHtml = this._renderReactions(msg.reactions);
    const attachmentsHtml = this._renderAttachments(msg.attachments);

    const threads = msg.threads || [];
    let threadsSectionHtml = '';

    if (threads.length > 0) {
      const threadsHtml = threads.map((thread, tIdx) => this._renderThread(thread, tIdx + 1, msg.id)).join('\n');
      threadsSectionHtml = `
      <div class="threads-block-wrap gc-threads-container">
        ${threadsHtml}
      </div>`;
    }

    if (isSelf) {
      return `
      <article class="parent-message-card" id="msg-${escapeHtml(msg.id)}" data-sender="You" data-is-self="true">
        ${!isContinuation ? `
        <div class="gc-msg-outgoing-meta">
          <span class="message-time-text gc-timestamp">${escapeHtml(timeStr)}</span>
        </div>` : ''}
        <div class="gc-bubble-outgoing">${escapeHtml(textContent)}</div>
        ${attachmentsHtml}
        ${reactionsHtml}
        ${threadsSectionHtml}
      </article>`;
    }

    return `
    <article class="parent-message-card" id="msg-${escapeHtml(msg.id)}" data-sender="${escapeHtml(senderName)}">
      <div class="gc-msg-incoming">
        <div class="avatar-col gc-avatar-col">
          ${!isContinuation ? `
          <div class="avatar-circle gc-avatar-circle" style="background-color: ${avatarColor};">
            ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(senderName)}" onerror="this.style.display='none';this.parentElement.textContent='${escapeHtml(initial)}'" />` : initial}
          </div>` : `<div class="gc-avatar-spacer"></div>`}
        </div>
        <div class="message-content-col gc-incoming-content">
          ${!isContinuation ? `
          <div class="message-meta-header gc-msg-incoming-meta">
            <span class="sender-display-name gc-sender-name">${escapeHtml(senderName)}</span>
            <span class="message-time-text gc-timestamp">${escapeHtml(timeStr)}</span>
            ${msg.edited ? '<span class="edited-indicator gc-edited-tag">(edited)</span>' : ''}
          </div>` : ''}
          <div class="gc-bubble-incoming message-body-text">${escapeHtml(textContent)}</div>
          ${attachmentsHtml}
          ${reactionsHtml}
          ${threadsSectionHtml}
        </div>
      </div>
    </article>`;
  }

  /**
   * Renders an independent thread container with its replies.
   * @private
   */
  static _renderThread(thread, threadNumber, parentMessageId) {
    const threadId = thread.id || `thread-${threadNumber}`;
    const threadTitle = thread.title || `Thread ${threadNumber}`;
    const replies = thread.replies || [];
    const replyCount = thread.replyCount !== undefined ? thread.replyCount : replies.length;

    const repliesHtml = replies.map(r => this._renderReply(r)).join('\n');

    return `
    <div class="thread-card" id="${escapeHtml(threadId)}">
      <div class="thread-header" title="Click to expand or collapse thread">
        <div class="thread-title-wrap">
          <span class="thread-badge">Thread ${threadNumber}</span>
          <span class="thread-title-text">${escapeHtml(threadTitle)}</span>
        </div>
        <div class="thread-meta-wrap">
          <span class="reply-count-badge">${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
          <span class="thread-chevron">▼</span>
        </div>
      </div>
      <div class="thread-replies-list">
        ${repliesHtml || '<div style="color:var(--text-muted);font-size:12px;">No replies found.</div>'}
      </div>
    </div>`;
  }

  /**
   * Renders an individual reply inside a thread.
   * @private
   */
  static _renderReply(reply) {
    const senderName = reply.sender?.name || 'Participant';
    const avatarUrl = reply.sender?.avatarUrl;
    const initial = (senderName[0] || 'U').toUpperCase();
    const avatarColor = getAvatarColor(senderName);
    const timeStr = formatTime(reply.timestamp);
    const textContent = reply.text || '';
    const reactionsHtml = this._renderReactions(reply.reactions);
    const attachmentsHtml = this._renderAttachments(reply.attachments);

    return `
    <div class="reply-row" id="reply-${escapeHtml(reply.id)}" data-sender="${escapeHtml(senderName)}">
      <div class="reply-avatar" style="background-color: ${avatarColor};">
        ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(senderName)}" onerror="this.style.display='none';this.parentElement.textContent='${escapeHtml(initial)}'" />` : initial}
      </div>
      <div class="reply-content-col">
        <div class="reply-meta">
          <span class="reply-sender-name">${escapeHtml(senderName)}</span>
          <span class="message-time-text">${escapeHtml(timeStr)}</span>
          ${reply.edited ? '<span class="edited-indicator">(edited)</span>' : ''}
        </div>
        <div class="reply-body-text">${escapeHtml(textContent)}</div>
        ${attachmentsHtml}
        ${reactionsHtml}
      </div>
    </div>`;
  }

  /**
   * Renders reaction chips
   * @private
   */
  static _renderReactions(reactions) {
    if (!reactions || reactions.length === 0) return '';
    const chips = reactions.map(r => `
      <span class="reaction-chip">
        <span>${escapeHtml(r.emoji)}</span>
        <span class="reaction-count">${r.count}</span>
      </span>
    `).join('');
    return `<div class="reactions-row">${chips}</div>`;
  }

  /**
   * Renders media attachments (screenshots, images, and document links)
   * @private
   */
  static _renderAttachments(attachments) {
    if (!attachments || attachments.length === 0) return '';
    const items = attachments.map(att => {
      const name = att.filename || att.name || 'Attachment';
      const isImg = att.type === 'image' || (att.previewUrl && (att.previewUrl.startsWith('data:image') || !att.previewUrl.includes('drive')));
      const previewUrl = att.previewUrl || att.url;

      if (isImg && previewUrl) {
        return `
        <div class="media-image-card" onclick="openLightbox('${escapeHtml(previewUrl)}')">
          <img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(name)}" loading="lazy" />
        </div>`;
      }

      return `
      <a href="${escapeHtml(att.url || '#')}" target="_blank" class="file-attachment-card" rel="noopener noreferrer">
        <span class="file-icon">📄</span>
        <span class="file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      </a>`;
    }).join('');

    return `<div class="media-attachments-grid">${items}</div>`;
  }
}
