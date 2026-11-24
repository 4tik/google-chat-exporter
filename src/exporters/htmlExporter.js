/**
 * @file htmlExporter.js
 * @module HtmlExporter
 * @description Generates a standalone, fully-functional, responsive HTML file
 * inspired by Google Chat. Accurately renders parent messages, multiple independent threads,
 * replies, attachments, reactions, search, filtering, and dark/light themes.
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
function formatTimestamp(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch (_) {
    return isoStr;
  }
}

export class HtmlExporter {
  /**
   * Generates a complete standalone HTML document string from a normalized conversation.
   *
   * @param {Object} conversation - Normalized conversation object
   * @param {Object} [metadata]    - Export metadata (conversation name, type, exportedAt)
   * @returns {string} Standalone HTML document string
   */
  static export(conversation, metadata = {}) {
    const convoName = metadata.name || conversation.name || 'Google Chat Conversation';
    const convoType = metadata.type || conversation.type || 'SPACE';
    const exportedAt = metadata.exportedAt || conversation.exportedAt || new Date().toISOString();
    const formattedExportDate = formatTimestamp(exportedAt);

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

    const messagesHtml = messages.map((msg, index) => this._renderParentMessage(msg, index + 1)).join('\n');

    return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(convoName)} - Google Chat Exporter</title>
<style>
:root {
  --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --bg-primary: #ffffff;
  --bg-secondary: #f8f9fa;
  --bg-hover: #f1f3f4;
  --bg-parent: #ffffff;
  --bg-thread: #f8fafc;
  --bg-reply: #ffffff;
  --border-color: #e2e8f0;
  --border-accent: #00897b;
  --text-primary: #1f2937;
  --text-secondary: #64748b;
  --text-muted: #94a3b8;
  --google-green: #00897b;
  --google-blue: #1a73e8;
  --badge-bg: #e6f4ea;
  --badge-text: #137333;
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
}

[data-theme="dark"] {
  --bg-primary: #111827;
  --bg-secondary: #1f2937;
  --bg-hover: #374151;
  --bg-parent: #1f2937;
  --bg-thread: #182234;
  --bg-reply: #222f44;
  --border-color: #374151;
  --border-accent: #26a69a;
  --text-primary: #f9fafb;
  --text-secondary: #cbd5e1;
  --text-muted: #64748b;
  --google-green: #26a69a;
  --google-blue: #8ab4f8;
  --badge-bg: #1e3a2f;
  --badge-text: #a8dab5;
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.5);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.6);
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-family);
  background-color: var(--bg-secondary);
  color: var(--text-primary);
  line-height: 1.5;
  padding: 24px 16px;
  min-height: 100vh;
}

.exporter-container {
  max-width: 1000px;
  margin: 0 auto;
}

/* Header */
.exporter-header {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 24px;
  margin-bottom: 20px;
  box-shadow: var(--shadow-sm);
}

.header-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}

.brand-section {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-icon {
  width: 44px;
  height: 44px;
  background: linear-gradient(135deg, #00897b, #004d40);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 700;
  font-size: 20px;
}

.title-wrap h1 {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.title-wrap .convo-type-badge {
  display: inline-block;
  background: var(--badge-bg);
  color: var(--badge-text);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 12px;
  margin-top: 4px;
  letter-spacing: 0.5px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.theme-btn, .action-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.2s ease;
}

.theme-btn:hover, .action-btn:hover {
  background: var(--bg-hover);
}

/* Stats Row */
.stats-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--border-color);
  font-size: 13px;
}

.stat-pill {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  display: flex;
  gap: 6px;
}

.stat-pill .stat-label {
  color: var(--text-secondary);
}

.stat-pill .stat-value {
  font-weight: 600;
  color: var(--text-primary);
}

/* Control Bar */
.control-bar {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 14px 18px;
  margin-bottom: 20px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  box-shadow: var(--shadow-sm);
}

.search-filter-group {
  display: flex;
  flex: 1;
  min-width: 280px;
  gap: 10px;
}

.search-input {
  flex: 1;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  outline: none;
}

.search-input:focus {
  border-color: var(--google-green);
}

.sender-select {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  outline: none;
  cursor: pointer;
}

.expand-controls {
  display: flex;
  gap: 8px;
}

/* Message List */
.messages-feed {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Parent Message Container */
.parent-message-card {
  background: var(--bg-parent);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 18px 20px;
  box-shadow: var(--shadow-sm);
  position: relative;
  transition: border-color 0.2s;
}

.parent-message-card:hover {
  border-color: #cbd5e1;
}

.message-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.sender-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--border-accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 15px;
  overflow: hidden;
  flex-shrink: 0;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sender-meta {
  display: flex;
  flex-direction: column;
}

.sender-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.timestamp {
  font-size: 12px;
  color: var(--text-muted);
}

.edited-tag {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 4px;
}

.message-body {
  font-size: 14.5px;
  color: var(--text-primary);
  margin-bottom: 12px;
  word-break: break-word;
  white-space: pre-wrap;
}

.message-body a {
  color: var(--google-blue);
  text-decoration: none;
}

.message-body a:hover {
  text-decoration: underline;
}

/* Reactions */
.reactions-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  margin-bottom: 8px;
}

.reaction-chip {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 2px 8px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.reaction-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

/* Attachments */
.attachments-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
  margin-top: 10px;
  margin-bottom: 10px;
}

.attachment-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-decoration: none;
  color: var(--text-primary);
  overflow: hidden;
}

.attachment-thumb {
  max-height: 140px;
  width: 100%;
  object-fit: cover;
  border-radius: 4px;
  cursor: pointer;
}

.attachment-name {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.attachment-type-badge {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
}

/* Threads Container */
.threads-container {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Individual Thread Card */
.thread-card {
  background: var(--bg-thread);
  border: 1px solid var(--border-color);
  border-left: 4px solid var(--border-accent);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: all 0.2s ease;
}

.thread-header {
  padding: 10px 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  background: rgba(0, 137, 123, 0.04);
  user-select: none;
}

.thread-header:hover {
  background: rgba(0, 137, 123, 0.08);
}

.thread-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.thread-badge {
  font-size: 11.5px;
  font-weight: 600;
  background: #00897b1f;
  color: var(--google-green);
  padding: 2px 8px;
  border-radius: 10px;
}

.thread-title-text {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.thread-meta-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.reply-count-pill {
  font-size: 11.5px;
  font-weight: 600;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 2px 8px;
  border-radius: 12px;
}

.thread-toggle-arrow {
  font-size: 12px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.thread-card.collapsed .thread-toggle-arrow {
  transform: rotate(-90deg);
}

.thread-card.collapsed .thread-replies-list {
  display: none;
}

/* Thread Replies */
.thread-replies-list {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.reply-row {
  background: var(--bg-reply);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  box-shadow: 0 1px 1px rgba(0, 0, 0, 0.02);
}

.reply-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.reply-sender-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.reply-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #64748b;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  overflow: hidden;
  flex-shrink: 0;
}

.reply-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.reply-sender-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.reply-body {
  font-size: 13.5px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Empty State */
.empty-state {
  text-align: center;
  padding: 48px 16px;
  color: var(--text-secondary);
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
  background: rgba(0, 0, 0, 0.85);
  align-items: center;
  justify-content: center;
}

.lightbox-modal.active {
  display: flex;
}

.lightbox-img {
  max-width: 90%;
  max-height: 90%;
  border-radius: 6px;
  box-shadow: 0 5px 25px rgba(0, 0, 0, 0.5);
}

/* Print Friendly */
@media print {
  body {
    background: #fff !important;
    color: #000 !important;
    padding: 0 !important;
  }
  .header-actions, .control-bar, .theme-btn, .expand-controls {
    display: none !important;
  }
  .parent-message-card, .thread-card, .reply-row {
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

<div class="exporter-container">
  <!-- Header -->
  <header class="exporter-header">
    <div class="header-top">
      <div class="brand-section">
        <div class="brand-icon">GC</div>
        <div class="title-wrap">
          <h1>${escapeHtml(convoName)}</h1>
          <span class="convo-type-badge">${escapeHtml(convoType)}</span>
        </div>
      </div>
      <div class="header-actions">
        <button class="theme-btn" id="theme-toggle" title="Toggle Dark/Light Mode">🌙 Theme</button>
        <button class="action-btn" onclick="window.print()" title="Print to Paper or PDF">🖨️ Print</button>
      </div>
    </div>
    <div class="stats-row">
      <div class="stat-pill"><span class="stat-label">Exported:</span> <span class="stat-value">${escapeHtml(formattedExportDate)}</span></div>
      <div class="stat-pill"><span class="stat-label">Messages:</span> <span class="stat-value">${messages.length}</span></div>
      <div class="stat-pill"><span class="stat-label">Threads:</span> <span class="stat-value">${totalThreads}</span></div>
      <div class="stat-pill"><span class="stat-label">Replies:</span> <span class="stat-value">${totalReplies}</span></div>
      <div class="stat-pill"><span class="stat-label">Attachments:</span> <span class="stat-value">${totalAttachments}</span></div>
    </div>
  </header>

  <!-- Interactive Controls -->
  <section class="control-bar">
    <div class="search-filter-group">
      <input type="text" id="search-box" class="search-input" placeholder="Search parent messages and replies..." />
      <select id="sender-filter" class="sender-select">
        <option value="">All Senders</option>
        ${senderOptions}
      </select>
    </div>
    <div class="expand-controls">
      <button class="action-btn" id="expand-all-btn">Expand All Threads</button>
      <button class="action-btn" id="collapse-all-btn">Collapse All Threads</button>
    </div>
  </section>

  <!-- Feed -->
  <main class="messages-feed" id="messages-feed">
    ${messagesHtml || '<div class="empty-state">No messages exported.</div>'}
  </main>
</div>

<!-- Lightbox Modal -->
<div class="lightbox-modal" id="lightbox" onclick="this.classList.remove('active')">
  <img class="lightbox-img" id="lightbox-img" src="" alt="Enlarged preview" />
</div>

<script>
// Standalone Interactive Controller
(function() {
  const themeToggle = document.getElementById('theme-toggle');
  const searchBox = document.getElementById('search-box');
  const senderFilter = document.getElementById('sender-filter');
  const expandAllBtn = document.getElementById('expand-all-btn');
  const collapseAllBtn = document.getElementById('collapse-all-btn');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');

  // Theme Toggle
  themeToggle.addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    themeToggle.textContent = isDark ? '🌙 Theme' : '☀️ Theme';
  });

  // Individual Thread Toggle
  document.querySelectorAll('.thread-header').forEach(header => {
    header.addEventListener('click', (e) => {
      const card = header.closest('.thread-card');
      card.classList.toggle('collapsed');
    });
  });

  // Expand / Collapse All
  expandAllBtn.addEventListener('click', () => {
    document.querySelectorAll('.thread-card').forEach(card => card.classList.remove('collapsed'));
  });

  collapseAllBtn.addEventListener('click', () => {
    document.querySelectorAll('.thread-card').forEach(card => card.classList.add('collapsed'));
  });

  // Search & Filter
  function applyFilter() {
    const query = (searchBox.value || '').toLowerCase().trim();
    const sender = (senderFilter.value || '').toLowerCase().trim();

    document.querySelectorAll('.parent-message-card').forEach(card => {
      const parentSender = (card.getAttribute('data-sender') || '').toLowerCase();
      const parentText = (card.querySelector('.message-body')?.textContent || '').toLowerCase();

      // Check replies
      let replyMatch = false;
      const replies = card.querySelectorAll('.reply-row');
      replies.forEach(reply => {
        const replySender = (reply.getAttribute('data-sender') || '').toLowerCase();
        const replyText = (reply.querySelector('.reply-body')?.textContent || '').toLowerCase();

        const matchSender = !sender || replySender === sender;
        const matchQuery = !query || replyText.includes(query) || replySender.includes(query);

        if (matchSender && matchQuery) {
          replyMatch = true;
          reply.style.display = '';
        } else if (query || sender) {
          reply.style.display = 'none';
        } else {
          reply.style.display = '';
        }
      });

      const parentMatchSender = !sender || parentSender === sender;
      const parentMatchQuery = !query || parentText.includes(query) || parentSender.includes(query);
      const isVisible = (parentMatchSender && parentMatchQuery) || replyMatch;

      card.style.display = isVisible ? '' : 'none';

      // Auto expand thread if reply matches query
      if (replyMatch && (query || sender)) {
        card.querySelectorAll('.thread-card').forEach(tc => tc.classList.remove('collapsed'));
      }
    });
  }

  searchBox.addEventListener('input', applyFilter);
  senderFilter.addEventListener('change', applyFilter);

  // Lightbox
  window.openLightbox = function(url) {
    if (!url) return;
    lightboxImg.src = url;
    lightbox.classList.add('active');
  };
})();
</script>
</body>
</html>`;
  }

  /**
   * Renders a single parent message and all its associated independent threads.
   * @private
   */
  static _renderParentMessage(msg, index) {
    const senderName = msg.sender?.name || 'Google Chat User';
    const avatarUrl = msg.sender?.avatarUrl;
    const initial = (senderName[0] || 'U').toUpperCase();
    const timestampStr = formatTimestamp(msg.timestamp);
    const textContent = msg.text || '';
    const reactionsHtml = this._renderReactions(msg.reactions);
    const attachmentsHtml = this._renderAttachments(msg.attachments);

    const threads = msg.threads || [];
    let threadsSectionHtml = '';

    if (threads.length > 0) {
      const threadsHtml = threads.map((thread, tIdx) => this._renderThread(thread, tIdx + 1, msg.id)).join('\n');
      threadsSectionHtml = `
      <section class="threads-container">
        ${threadsHtml}
      </section>`;
    }

    return `
    <article class="parent-message-card" id="msg-${escapeHtml(msg.id)}" data-sender="${escapeHtml(senderName)}">
      <div class="message-header">
        <div class="sender-info">
          <div class="avatar">
            ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(senderName)}" onerror="this.style.display='none';this.parentElement.textContent='${escapeHtml(initial)}'" />` : initial}
          </div>
          <div class="sender-meta">
            <span class="sender-name">${escapeHtml(senderName)}</span>
            <span class="timestamp">${escapeHtml(timestampStr)}${msg.edited ? '<span class="edited-tag">(edited)</span>' : ''}</span>
          </div>
        </div>
      </div>
      <div class="message-body">${escapeHtml(textContent)}</div>
      ${attachmentsHtml}
      ${reactionsHtml}
      ${threadsSectionHtml}
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
      <div class="thread-header" title="Click to expand/collapse thread">
        <div class="thread-title-wrap">
          <span class="thread-badge">Thread ${threadNumber}</span>
          <span class="thread-title-text">${escapeHtml(threadTitle)}</span>
        </div>
        <div class="thread-meta-wrap">
          <span class="reply-count-pill">${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
          <span class="thread-toggle-arrow">▼</span>
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
    const senderName = reply.sender?.name || 'Google Chat User';
    const avatarUrl = reply.sender?.avatarUrl;
    const initial = (senderName[0] || 'U').toUpperCase();
    const timestampStr = formatTimestamp(reply.timestamp);
    const textContent = reply.text || '';
    const reactionsHtml = this._renderReactions(reply.reactions);
    const attachmentsHtml = this._renderAttachments(reply.attachments);

    return `
    <div class="reply-row" id="reply-${escapeHtml(reply.id)}" data-sender="${escapeHtml(senderName)}">
      <div class="reply-header">
        <div class="reply-sender-info">
          <div class="reply-avatar">
            ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(senderName)}" onerror="this.style.display='none';this.parentElement.textContent='${escapeHtml(initial)}'" />` : initial}
          </div>
          <span class="reply-sender-name">${escapeHtml(senderName)}</span>
        </div>
        <span class="timestamp">${escapeHtml(timestampStr)}${reply.edited ? '<span class="edited-tag">(edited)</span>' : ''}</span>
      </div>
      <div class="reply-body">${escapeHtml(textContent)}</div>
      ${attachmentsHtml}
      ${reactionsHtml}
    </div>`;
  }

  /**
   * Renders reactions list
   * @private
   */
  static _renderReactions(reactions) {
    if (!reactions || reactions.length === 0) return '';
    const chips = reactions.map(r => `
      <span class="reaction-chip" title="${escapeHtml((r.users || []).join(', '))}">
        <span>${escapeHtml(r.emoji)}</span>
        <span class="reaction-count">${r.count}</span>
      </span>
    `).join('');
    return `<div class="reactions-list">${chips}</div>`;
  }

  /**
   * Renders attachments
   * @private
   */
  static _renderAttachments(attachments) {
    if (!attachments || attachments.length === 0) return '';
    const items = attachments.map(att => {
      const name = att.filename || att.name || 'Attachment';
      const isImg = att.type === 'image' || /\.(jpe?g|png|gif|webp)$/i.test(name) || (att.previewUrl && !att.previewUrl.includes('drive'));
      const previewUrl = att.previewUrl || att.url;

      if (isImg && previewUrl) {
        return `
        <div class="attachment-card">
          <img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(name)}" class="attachment-thumb" onclick="openLightbox('${escapeHtml(previewUrl)}')" />
          <span class="attachment-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="attachment-type-badge">Image</span>
        </div>`;
      }

      return `
      <a href="${escapeHtml(att.url || '#')}" target="_blank" class="attachment-card" rel="noopener noreferrer">
        <div style="font-size:24px;text-align:center;padding:10px 0;">📄</div>
        <span class="attachment-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="attachment-type-badge">${escapeHtml(att.type || 'Document')}</span>
      </a>`;
    }).join('');

    return `<div class="attachments-grid">${items}</div>`;
  }
}
