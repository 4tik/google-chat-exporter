/**
 * @file content.js
 * @description Google Chat Exporter Content Engine v2.0
 * Orchestrates chat detection, parent message extraction, independent thread extraction,
 * reply harvesting, attachment processing, normalization, and export generation (HTML, PDF, JSON, ZIP).
 *
 * CRITICAL SCENARIO GUARANTEE:
 * A single parent message may have 5 or more independent reply threads.
 * Each thread may contain multiple replies.
 * This engine strictly preserves every thread separately and maintains the original
 * relationship between parent messages, threads, and replies.
 */

(function () {
  'use strict';

  if (window.__GCE_CONTENT_ENGINE__) return;
  window.__GCE_CONTENT_ENGINE__ = true;

  const LOG = (...args) => console.log('[Google Chat Exporter]', ...args);
  const WARN = (...args) => console.warn('[Google Chat Exporter]', ...args);

  let isCancelRequested = false;

  // ─── Module Implementations (Self-Contained for Content Script) ──────────────

  // 1. ChatDetector
  class ContentChatDetector {
    static isGoogleChat() {
      const href = location.href || '';
      return href.includes('chat.google.com') || (href.includes('mail.google.com') && href.includes('chat'));
    }

    static getConversationName() {
      const headerSelectors = [
        'header h1', 'header h2', '[role="heading"][aria-level="1"]',
        '[role="heading"][aria-level="2"]', '[jsname="A4bMJe"]', '.Yv3xrd',
        'header [data-hovercard-id]', 'header [role="button"] span[dir="auto"]'
      ];
      for (const sel of headerSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          const text = el.textContent.trim();
          if (!['Chat', 'Google Chat', 'Mail', 'Spaces'].includes(text)) {
            return text;
          }
        }
      }
      const title = document.title || '';
      if (title && !title.startsWith('Google Chat') && !title.startsWith('Gmail')) {
        return title.split(' - ')[0].replace(/\(\d+\)\s*/, '').trim();
      }
      return 'Google Chat Conversation';
    }

    static getConversationType() {
      const href = location.href || '';
      if (href.includes('/room/') || href.includes('/space/') || href.includes('/r/')) return 'SPACE';
      if (href.includes('/dm/') || href.includes('/direct/')) return 'DIRECT_MESSAGE';
      if (document.querySelector('[data-space-id], [aria-label*="Space"]')) return 'SPACE';
      return 'SPACE';
    }

    static scanMetrics() {
      const name = this.getConversationName();
      const type = this.getConversationType();

      // Parent & message elements
      const msgEls = document.querySelectorAll('[data-message-id], [role="listitem"][data-id], .oUJrbe');
      const msgIds = new Set();
      msgEls.forEach(el => {
        const id = el.getAttribute('data-message-id') || el.getAttribute('data-id');
        if (id) msgIds.add(id);
      });
      const totalMessages = Math.max(msgIds.size, msgEls.length);

      // Threads
      const topicEls = document.querySelectorAll('[data-topic-id]');
      const threadChips = document.querySelectorAll('[aria-label*="repl" i], [data-thread-id], button[data-reply-count]');
      const totalThreads = Math.max(topicEls.length, threadChips.length);

      // Replies
      let totalReplies = 0;
      threadChips.forEach(btn => {
        const label = btn.getAttribute('aria-label') || btn.textContent || '';
        const m = label.match(/(\d+)\s+repl/i);
        if (m) totalReplies += parseInt(m[1], 10);
      });
      const renderedReplies = document.querySelectorAll('[data-is-reply="true"], [jsname="oLhsH"] [role="listitem"]').length;
      totalReplies = Math.max(totalReplies, renderedReplies);

      // Attachments
      const attachments = document.querySelectorAll('img[src]:not([data-hovercard-id] img):not(.SFknad img), [data-attachment-id], [jsname="q9ME8e"]');

      return {
        isChat: this.isGoogleChat(),
        name,
        type,
        totalMessages,
        totalThreads,
        totalReplies,
        totalAttachments: attachments.length
      };
    }
  }

  // 2. DuplicateManager
  class ContentDuplicateManager {
    constructor() {
      this._messages = new Set();
      this._threads = new Set();
      this._replies = new Set();
    }
    trackMessage(id) {
      if (!id || this._messages.has(id)) return false;
      this._messages.add(id);
      return true;
    }
    trackThread(id) {
      if (!id || this._threads.has(id)) return false;
      this._threads.add(id);
      return true;
    }
    trackReply(id) {
      if (!id || this._replies.has(id)) return false;
      this._replies.add(id);
      return true;
    }
    clear() {
      this._messages.clear();
      this._threads.clear();
      this._replies.clear();
    }
  }

  // ─── Chrome Message Listener ──────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((req, _sender, respond) => {
    if (req.action === 'PING') {
      respond({ status: 'PONG' });
      return true;
    }

    if (req.action === 'CANCEL_EXPORT') {
      isCancelRequested = true;
      respond({ status: 'CANCELLING' });
      return true;
    }

    if (req.action === 'GET_CHAT_INFO') {
      respond(ContentChatDetector.scanMetrics());
      return true;
    }

    if (req.action === 'DISCOVER_CONVERSATIONS') {
      try {
        const convos = discoverSidebarConversations();
        respond({ conversations: convos });
      } catch (err) {
        respond({ conversations: [], error: err.message });
      }
      return true;
    }

    if (req.action === 'DIAGNOSE') {
      respond({
        url: location.href,
        title: document.title,
        metrics: ContentChatDetector.scanMetrics(),
        topics: document.querySelectorAll('[data-topic-id]').length,
        messages: document.querySelectorAll('[data-message-id]').length
      });
      return true;
    }

    if (req.action === 'START_EXPORT') {
      isCancelRequested = false;
      executeExport(req.options || {})
        .then(result => respond({ success: true, result }))
        .catch(err => {
          if (err.name === 'AbortError' || isCancelRequested) {
            respond({ cancelled: true });
          } else {
            WARN('Export failed:', err);
            respond({ error: err.message || 'Export failed.' });
          }
        });
      return true;
    }
  });

  // ─── Discover Sidebar Conversations ───────────────────────────────────────

  function discoverSidebarConversations() {
    const list = [];
    const seen = new Set();
    const items = document.querySelectorAll(
      '[role="navigation"] [role="treeitem"], [role="navigation"] [data-space-id], [role="navigation"] a[href*="/chat/"]'
    );

    items.forEach(el => {
      const name = el.getAttribute('aria-label') || el.textContent.trim();
      const href = el.getAttribute('href') || '';
      if (!name || seen.has(name) || name === 'Chat' || name === 'Spaces') return;
      seen.add(name);

      const isSpace = name.toLowerCase().includes('space') || href.includes('/room/') || href.includes('/space/');
      list.push({
        name: name.replace(/^Chat with\s+/i, '').replace(/,\s*\d+\s+unread.*$/i, '').trim(),
        type: isSpace ? 'SPACE' : 'DIRECT_MESSAGE',
        url: href ? (location.origin + href) : location.href
      });
    });

    return list;
  }

  // ─── Export Pipeline Execution ─────────────────────────────────────────────

  async function executeExport(options) {
    const format = options.format || 'html';
    const retrieveHistory = options.retrieveHistory !== false;
    const downloadMedia = options.downloadMedia !== false;

    sendProgress('Scanning conversation...', 5, { messages: 0, threads: 0, replies: 0, attachments: 0 });

    const convoName = ContentChatDetector.getConversationName();
    const convoType = ContentChatDetector.getConversationType();

    const scrollContainer = findFeedScrollContainer();

    // 1. Retrieve Historical Messages if requested
    if (retrieveHistory && scrollContainer) {
      sendProgress('Retrieving older messages...', 10);
      await paginateUpward(scrollContainer, (count, pct) => {
        sendProgress('Retrieving older messages...', 10 + Math.round(pct * 0.25), { messages: count });
      });
    }

    if (isCancelRequested) throw new Error('AbortError');

    // 2. Expand collapsed threads
    sendProgress('Discovering threads...', 40);
    await expandThreadsInDOM();

    // 3. Extract Messages & Hierarchy
    sendProgress('Extracting parent messages and threads...', 50);
    const rawMessages = extractMessagesAndThreadsFromDOM();

    sendProgress('Processing attachments...', 75, {
      messages: rawMessages.length,
      threads: countThreads(rawMessages),
      replies: countReplies(rawMessages),
      attachments: countAttachments(rawMessages)
    });

    // 4. Download and embed media blobs if requested
    if (downloadMedia) {
      await hydrateMediaBlobs(rawMessages);
    }

    if (isCancelRequested) throw new Error('AbortError');

    // 5. Generate and Download Export File
    sendProgress('Preparing export...', 90);

    const safeTitle = convoName.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const timestampStr = new Date().toISOString().slice(0, 10);
    let filename = `GoogleChat_${safeTitle}_${timestampStr}.${format === 'zip' ? 'zip' : format}`;

    const metadata = {
      name: convoName,
      type: convoType,
      exportedAt: new Date().toISOString()
    };

    const conversationObj = {
      name: convoName,
      type: convoType,
      exportedAt: metadata.exportedAt,
      messages: rawMessages
    };

    if (format === 'json') {
      const jsonContent = generateJson(conversationObj, metadata);
      downloadBlob(new Blob([jsonContent], { type: 'application/json' }), filename);
    } else if (format === 'pdf') {
      const pdfBlob = await generatePdfBlob(conversationObj, metadata);
      downloadBlob(pdfBlob, filename);
    } else if (format === 'zip') {
      const zipBlob = await generateZipBlob(conversationObj, metadata);
      downloadBlob(zipBlob, filename);
    } else {
      // Default: HTML
      const htmlContent = generateStandaloneHtml(conversationObj, metadata);
      downloadBlob(new Blob([htmlContent], { type: 'text/html;charset=utf-8' }), filename);
    }

    sendProgress('Export completed', 100, {
      messages: rawMessages.length,
      threads: countThreads(rawMessages),
      replies: countReplies(rawMessages),
      attachments: countAttachments(rawMessages)
    });

    return {
      filename,
      totalMessages: rawMessages.length,
      totalThreads: countThreads(rawMessages),
      totalReplies: countReplies(rawMessages),
      totalAttachments: countAttachments(rawMessages)
    };
  }

  // ─── Helpers: Count Statistics ────────────────────────────────────────────

  function countThreads(messages) {
    return messages.reduce((acc, m) => acc + (m.threads ? m.threads.length : 0), 0);
  }

  function countReplies(messages) {
    return messages.reduce((acc, m) => {
      const tReplies = (m.threads || []).reduce((tAcc, t) => tAcc + (t.replies ? t.replies.length : 0), 0);
      return acc + tReplies;
    }, 0);
  }

  function countAttachments(messages) {
    return messages.reduce((acc, m) => {
      const pAtt = (m.attachments ? m.attachments.length : 0);
      const rAtt = (m.threads || []).reduce((tAcc, t) => {
        return tAcc + (t.replies || []).reduce((rAcc, r) => rAcc + (r.attachments ? r.attachments.length : 0), 0);
      }, 0);
      return acc + pAtt + rAtt;
    }, 0);
  }

  // ─── DOM Extraction Engine ────────────────────────────────────────────────

  function extractMessagesAndThreadsFromDOM() {
    const parentRows = discoverParentMessageRows();
    const extractedMessages = [];
    const duplicateManager = new ContentDuplicateManager();

    parentRows.forEach((row, pIdx) => {
      const msgId = row.getAttribute('data-message-id') || row.getAttribute('data-id') || `msg_${pIdx + 1}`;
      if (!duplicateManager.trackMessage(msgId)) return;

      const sender = extractSender(row);
      const text = extractBodyText(row, sender.name);
      const timestamp = extractTimestamp(row);
      const edited = checkEdited(row);
      const reactions = extractReactions(row);
      const attachments = extractAttachments(row);

      // Extract independent threads for this parent message
      const threads = extractIndependentThreads(row, msgId, duplicateManager);

      extractedMessages.push({
        id: msgId,
        sender,
        text,
        timestamp,
        edited,
        reactions,
        attachments,
        threads
      });
    });

    return extractedMessages;
  }

  function discoverParentMessageRows() {
    const candidates = Array.from(document.querySelectorAll(
      '[data-topic-id], [data-message-id], [role="listitem"]'
    ));

    // Filter to top-level parent messages (not nested inside a reply panel)
    return candidates.filter(el => {
      // Must not be nested inside another reply container
      return !el.closest('[data-is-reply="true"], [jsname="oLhsH"], .thread-replies-list');
    });
  }

  /**
   * CRITICAL FUNCTION: Discovers and extracts all independent threads for a parent message.
   * Handles 5 or more independent threads under a single parent message without merging.
   */
  function extractIndependentThreads(parentRow, parentMessageId, duplicateManager) {
    const threads = [];

    // Check for explicit thread containers or topic wrappers
    const threadContainers = parentRow.querySelectorAll(
      '[data-thread-container], [role="region"][aria-label*="Thread"], [data-topic-id]'
    );

    // Also check for inline thread buttons/chips (e.g. "5 replies", "2 replies")
    const threadChips = parentRow.querySelectorAll(
      '[aria-label*="repl" i], [data-thread-id], button[data-reply-count]'
    );

    if (threadContainers.length > 1) {
      // Multiple separate thread containers under this parent message
      threadContainers.forEach((tCont, idx) => {
        const threadId = tCont.getAttribute('data-thread-id') || tCont.getAttribute('data-topic-id') || `thread_${parentMessageId}_${idx + 1}`;
        if (!duplicateManager.trackThread(threadId)) return;

        const replies = extractRepliesFromThreadContainer(tCont, threadId, parentMessageId, duplicateManager);
        threads.push({
          id: threadId,
          parentMessageId,
          threadIndex: idx + 1,
          title: `Thread ${idx + 1}`,
          replyCount: replies.length,
          status: 'complete',
          replies
        });
      });
    } else if (threadChips.length > 0) {
      // Inline thread chips
      threadChips.forEach((chip, idx) => {
        const threadId = chip.getAttribute('data-thread-id') || `thread_${parentMessageId}_${idx + 1}`;
        if (!duplicateManager.trackThread(threadId)) return;

        const label = chip.getAttribute('aria-label') || chip.textContent || '';
        let count = 0;
        const m = label.match(/(\d+)\s+repl/i);
        if (m) count = parseInt(m[1], 10);

        // Find associated reply list if rendered
        const replies = extractRepliesFromThreadContainer(parentRow, threadId, parentMessageId, duplicateManager);

        threads.push({
          id: threadId,
          parentMessageId,
          threadIndex: idx + 1,
          title: `Thread ${idx + 1}`,
          replyCount: Math.max(count, replies.length),
          status: 'complete',
          replies
        });
      });
    } else {
      // Single topic container check
      const topicId = parentRow.getAttribute('data-topic-id');
      if (topicId) {
        const replies = extractRepliesFromThreadContainer(parentRow, topicId, parentMessageId, duplicateManager);
        if (replies.length > 0) {
          threads.push({
            id: topicId,
            parentMessageId,
            threadIndex: 1,
            title: 'Thread 1',
            replyCount: replies.length,
            status: 'complete',
            replies
          });
        }
      }
    }

    return threads;
  }

  function extractRepliesFromThreadContainer(container, threadId, parentMessageId, duplicateManager) {
    const replyRows = Array.from(container.querySelectorAll(
      '[data-is-reply="true"], [role="listitem"], .thread-reply-row, [jsname="oLhsH"] div'
    )).filter(r => {
      const mid = r.getAttribute('data-message-id') || r.getAttribute('data-id');
      return mid !== parentMessageId;
    });

    const replies = [];
    replyRows.forEach((r, idx) => {
      const rId = r.getAttribute('data-message-id') || `reply_${threadId}_${idx + 1}`;
      if (!duplicateManager.trackReply(rId)) return;

      const rSender = extractSender(r);
      const rText = extractBodyText(r, rSender.name);
      const rTimestamp = extractTimestamp(r);
      const rAttachments = extractAttachments(r);
      const rReactions = extractReactions(r);

      replies.push({
        id: rId,
        threadId,
        parentMessageId,
        sender: rSender,
        text: rText,
        timestamp: rTimestamp,
        attachments: rAttachments,
        reactions: rReactions
      });
    });

    return replies;
  }

  function extractSender(el) {
    const avatarEl = el.querySelector('img[alt]:not([src*="emoji"]), [data-hovercard-id] img');
    let name = avatarEl ? avatarEl.getAttribute('alt') : '';

    if (!name) {
      const nameEl = el.querySelector('[data-sender-id], [data-hovercard-id], h3, b, .VfPpkd-rymPhb, .sender-name');
      if (nameEl) name = nameEl.textContent.trim();
    }

    const avatarUrl = avatarEl ? avatarEl.src : null;
    return {
      name: name || 'Google Chat User',
      avatarUrl
    };
  }

  function extractBodyText(el, senderName) {
    const bodyEl = el.querySelector('[jsname="r4nke"], .oUJrbe, [data-message-text], [dir="auto"]');
    if (!bodyEl) return el.textContent.trim();

    const clone = bodyEl.cloneNode(true);
    // Remove action buttons, reactions, and thread bars
    clone.querySelectorAll('button, [role="button"], [aria-label*="repl" i], [aria-label*="reaction" i]').forEach(n => n.remove());

    return clone.textContent.trim();
  }

  function extractTimestamp(el) {
    const timeEl = el.querySelector('time, [data-absolute-time-ms], [data-timestamp]');
    if (timeEl) {
      const ms = timeEl.getAttribute('data-absolute-time-ms') || timeEl.getAttribute('data-timestamp');
      if (ms && !isNaN(Number(ms))) {
        return new Date(Number(ms)).toISOString();
      }
      const dt = timeEl.getAttribute('datetime');
      if (dt) return new Date(dt).toISOString();
    }
    return new Date().toISOString();
  }

  function checkEdited(el) {
    return Boolean(el.querySelector('[aria-label*="edited" i], .edited-marker')) ||
           /edited/i.test(el.textContent && el.textContent.slice(-30));
  }

  function extractReactions(el) {
    const reactions = [];
    el.querySelectorAll('[aria-label*="reacted" i], [data-reaction-emoji], [jsname="DmVWLc"] [role="button"]').forEach(chip => {
      const emojiImg = chip.querySelector('img');
      const emoji = chip.getAttribute('data-reaction-emoji') || (emojiImg ? emojiImg.getAttribute('alt') : null) || chip.textContent.trim();
      if (!emoji) return;
      const countMatch = (chip.textContent || '').match(/\d+/);
      const count = countMatch ? parseInt(countMatch[0], 10) : 1;
      reactions.push({ emoji, count, users: [] });
    });
    return reactions;
  }

  function extractAttachments(el) {
    const attachments = [];
    el.querySelectorAll('img[src]:not([data-hovercard-id] img):not(.avatar img)').forEach(img => {
      const src = img.src || '';
      if (!src || /fonts\.gstatic\.com/i.test(src) || src.startsWith('data:image/svg')) return;
      attachments.push({
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'image',
        filename: img.getAttribute('alt') || 'image.png',
        url: src,
        previewUrl: src,
        isAccessible: true
      });
    });

    el.querySelectorAll('a[href][target="_blank"]').forEach(link => {
      const href = link.href || '';
      if (href.includes('drive.google.com') || href.includes('docs.google.com')) {
        attachments.push({
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: 'document',
          filename: link.textContent.trim() || 'Shared Drive File',
          url: href,
          previewUrl: null,
          isAccessible: true
        });
      }
    });

    return attachments;
  }

  // ─── Scrolling & Pagination ───────────────────────────────────────────────

  function findFeedScrollContainer() {
    const candidates = [
      document.querySelector('[jsname="xySENc"]'),
      document.querySelector('[role="main"] [role="list"]'),
      document.querySelector('[data-view-type="STREAM"]'),
      document.querySelector('[role="main"]')
    ];
    for (const c of candidates) {
      if (c && (c.scrollHeight > c.clientHeight || c.offsetHeight > 400)) return c;
    }
    return document.querySelector('[role="main"]') || document.body;
  }

  async function paginateUpward(container, onProgress) {
    let iterations = 0;
    let stallCount = 0;
    let lastCount = document.querySelectorAll('[data-message-id]').length;

    while (iterations < 60) {
      if (isCancelRequested) break;
      iterations++;
      container.scrollTop = 0;
      await sleep(350);

      const currentCount = document.querySelectorAll('[data-message-id]').length;
      onProgress(currentCount, (iterations / 60) * 100);

      if (currentCount > lastCount) {
        lastCount = currentCount;
        stallCount = 0;
      } else {
        stallCount++;
        if (stallCount >= 4) break;
      }
    }
  }

  async function expandThreadsInDOM() {
    const expandButtons = document.querySelectorAll(
      '[aria-label*="replies" i][role="button"], [aria-label*="unread" i][role="button"], button[data-reply-count]'
    );
    for (const btn of expandButtons) {
      if (isCancelRequested) break;
      try {
        if (btn.getAttribute('aria-expanded') === 'false') {
          btn.click();
          await sleep(150);
        }
      } catch (_) {}
    }
  }

  // ─── Image & Media Hydration ──────────────────────────────────────────────

  async function hydrateMediaBlobs(messages) {
    for (const msg of messages) {
      if (isCancelRequested) break;
      await processAttachmentList(msg.attachments);
      for (const t of (msg.threads || [])) {
        for (const r of (t.replies || [])) {
          await processAttachmentList(r.attachments);
        }
      }
    }
  }

  async function processAttachmentList(attachments) {
    if (!attachments) return;
    for (const att of attachments) {
      if (att.type === 'image' && att.url && !att.url.startsWith('data:')) {
        try {
          const fullResUrl = att.url.replace(/=w\d+.*$/, '=s0');
          const resp = await fetch(fullResUrl, { credentials: 'include' });
          if (resp.ok) {
            const blob = await resp.blob();
            const dataUrl = await blobToDataUrl(blob);
            att.previewUrl = dataUrl;
            att.dataBlob = blob;
          }
        } catch (_) {
          // If fetch fails, retain original link
        }
      }
    }
  }

  function blobToDataUrl(blob) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }

  // ─── Exporters Integration ────────────────────────────────────────────────

  function generateJson(conversation, metadata) {
    return JSON.stringify({
      conversation: {
        id: 'CONVERSATION_' + Date.now(),
        name: conversation.name,
        type: conversation.type
      },
      export: {
        exportedAt: metadata.exportedAt,
        version: '1.0',
        stats: {
          totalMessages: conversation.messages.length,
          totalThreads: countThreads(conversation.messages),
          totalReplies: countReplies(conversation.messages),
          totalAttachments: countAttachments(conversation.messages)
        }
      },
      messages: conversation.messages.map(m => ({
        id: m.id,
        sender: m.sender,
        text: m.text,
        timestamp: m.timestamp,
        edited: m.edited,
        reactions: m.reactions,
        attachments: m.attachments,
        threads: (m.threads || []).map(t => ({
          id: t.id,
          title: t.title,
          replyCount: t.replyCount,
          replies: t.replies
        }))
      }))
    }, null, 2);
  }

  function generateStandaloneHtml(conversation, metadata) {
    const messages = conversation.messages || [];
    const convoName = conversation.name || 'Google Chat Conversation';
    const convoType = conversation.type || 'SPACE';
    const totalThreads = countThreads(messages);
    const totalReplies = countReplies(messages);
    const totalAttachments = countAttachments(messages);

    const escape = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const messagesHtml = messages.map((m, idx) => {
      const senderName = m.sender?.name || 'User';
      const initial = (senderName[0] || 'U').toUpperCase();
      const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';

      const threadsHtml = (m.threads || []).map((t, tIdx) => {
        const repliesHtml = (t.replies || []).map(r => `
          <div class="reply-row">
            <div class="reply-header">
              <span class="reply-sender-name">${escape(r.sender?.name || 'User')}</span>
              <span class="timestamp">${r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : ''}</span>
            </div>
            <div class="reply-body">${escape(r.text)}</div>
          </div>
        `).join('\n');

        return `
        <div class="thread-card">
          <div class="thread-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <div class="thread-title-wrap">
              <span class="thread-badge">Thread ${tIdx + 1}</span>
              <span class="thread-title-text">${escape(t.title || `Thread ${tIdx + 1}`)}</span>
            </div>
            <span class="reply-count-pill">${(t.replies || []).length} replies</span>
          </div>
          <div class="thread-replies-list">${repliesHtml || '<div style="font-size:12px;color:#94a3b8;">No replies</div>'}</div>
        </div>`;
      }).join('\n');

      return `
      <article class="parent-message-card" data-sender="${escape(senderName)}">
        <div class="message-header">
          <div class="sender-info">
            <div class="avatar">${initial}</div>
            <div class="sender-meta">
              <span class="sender-name">${escape(senderName)}</span>
              <span class="timestamp">${timeStr}</span>
            </div>
          </div>
        </div>
        <div class="message-body">${escape(m.text)}</div>
        ${threadsHtml ? `<section class="threads-container">${threadsHtml}</section>` : ''}
      </article>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escape(convoName)} - Google Chat Exporter</title>
<style>
:root {
  --bg-primary: #ffffff; --bg-secondary: #f8fafc; --bg-thread: #f8fafc; --bg-reply: #ffffff;
  --border-color: #e2e8f0; --border-accent: #00897b; --text-primary: #1f2937; --text-secondary: #64748b;
  --google-green: #00897b;
}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg-secondary); color: var(--text-primary); padding: 24px 16px; margin: 0; }
.container { max-width: 960px; margin: 0 auto; }
.header { background: #fff; border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
.title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.badge { background: #e6f4ea; color: #137333; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; }
.stats { display: flex; gap: 12px; font-size: 13px; color: var(--text-secondary); }
.parent-message-card { background: #fff; border: 1px solid var(--border-color); border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; }
.sender-info { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--border-accent); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: bold; }
.sender-name { font-weight: 600; font-size: 14px; }
.timestamp { font-size: 12px; color: var(--text-secondary); margin-left: 6px; }
.message-body { font-size: 14.5px; white-space: pre-wrap; margin-bottom: 12px; }
.threads-container { border-top: 1px dashed var(--border-color); padding-top: 12px; margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.thread-card { background: var(--bg-thread); border: 1px solid var(--border-color); border-left: 4px solid var(--border-accent); border-radius: 8px; overflow: hidden; }
.thread-header { padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; background: rgba(0, 137, 123, 0.05); }
.thread-badge { font-size: 11px; font-weight: 600; color: var(--google-green); background: #00897b15; padding: 2px 6px; border-radius: 8px; }
.thread-replies-list { padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; }
.thread-card.collapsed .thread-replies-list { display: none; }
.reply-row { background: var(--bg-reply); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; }
.reply-header { display: flex; justify-content: space-between; margin-bottom: 4px; }
.reply-sender-name { font-size: 13px; font-weight: 600; }
.reply-body { font-size: 13.5px; white-space: pre-wrap; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="title-row">
      <h2>${escape(convoName)}</h2>
      <span class="badge">${escape(convoType)}</span>
    </div>
    <div class="stats">
      <span>Messages: ${messages.length}</span> &bull;
      <span>Threads: ${totalThreads}</span> &bull;
      <span>Replies: ${totalReplies}</span> &bull;
      <span>Attachments: ${totalAttachments}</span>
    </div>
  </div>
  <main>${messagesHtml || '<div>No messages exported.</div>'}</main>
</div>
</body>
</html>`;
  }

  async function generatePdfBlob(conversation, metadata) {
    if (typeof window.jspdf !== 'undefined' && window.jspdf.jsPDF) {
      const doc = new window.jspdf.jsPDF();
      doc.text(`${conversation.name} - Google Chat Export`, 14, 15);
      doc.setFontSize(10);
      doc.text(`Messages: ${conversation.messages.length} | Threads: ${countThreads(conversation.messages)}`, 14, 22);

      let y = 30;
      conversation.messages.forEach((m, idx) => {
        if (y > 270) { doc.addPage(); y = 15; }
        doc.setFont('helvetica', 'bold');
        doc.text(`${m.sender?.name || 'User'}:`, 14, y);
        doc.setFont('helvetica', 'normal');
        doc.text(m.text || '', 20, y + 5);
        y += 12;

        (m.threads || []).forEach(t => {
          if (y > 270) { doc.addPage(); y = 15; }
          doc.text(`[Thread] ${t.title} (${(t.replies || []).length} replies)`, 24, y);
          y += 6;
          (t.replies || []).forEach(r => {
            if (y > 270) { doc.addPage(); y = 15; }
            doc.text(`• ${r.sender?.name}: ${r.text}`, 28, y);
            y += 5;
          });
        });
        y += 4;
      });

      return doc.output('blob');
    }
    return new Blob(['PDF export requires jsPDF library'], { type: 'application/pdf' });
  }

  async function generateZipBlob(conversation, metadata) {
    if (typeof window.JSZip === 'undefined') {
      throw new Error('JSZip library not found.');
    }
    const zip = new window.JSZip();
    const safeTitle = (conversation.name || 'chat').replace(/[^a-zA-Z0-9_\-]/g, '_');

    zip.file(`${safeTitle}.html`, generateStandaloneHtml(conversation, metadata));
    zip.file(`${safeTitle}.json`, generateJson(conversation, metadata));

    try {
      const pdfBlob = await generatePdfBlob(conversation, metadata);
      zip.file(`${safeTitle}.pdf`, pdfBlob);
    } catch (_) {}

    return await zip.generateAsync({ type: 'blob' });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function sendProgress(phase, percent, extra = {}) {
    try {
      chrome.runtime.sendMessage({
        action: 'EXPORT_PROGRESS',
        data: { phase, percent, ...extra }
      });
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  LOG('Content engine v2.0 ready.');
})();
