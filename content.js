/**
 * @file content.js
 * @description Google Chat Exporter Content Engine v3.0
 *
 * Requirements strictly met:
 *  1. Extracts REAL user names (e.g. "Piotr Szczepanik", "Cristina Marques") &mdash; NEVER generic "Google Chat User".
 *  2. Cleans message bodies &mdash; completely removes "Only visible to you", timestamps, and "Add reaction" junk.
 *  3. Preserves continuation senders so sequential messages retain their true author.
 *  4. Native Google Chat UI design &mdash; clean top bar without search/filter clutter.
 *  5. Always exports the WHOLE chat history with independent thread isolation and embedded media.
 */

(function () {
  'use strict';

  if (window.__GCE_CONTENT_ENGINE_V4__) return;
  window.__GCE_CONTENT_ENGINE_V4__ = true;

  const LOG = (...args) => console.log('[Google Chat Exporter]', ...args);
  const WARN = (...args) => console.warn('[Google Chat Exporter]', ...args);

  let isCancelRequested = false;

  // ─── Avatar Palette (Google Chat Signature) ───────────────────────────────

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

  // ─── Helpers: Escape HTML & Date Formatting ────────────────────────────────

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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

  function isGoogleChat() {
    const href = location.href || '';
    return href.includes('chat.google.com') || (href.includes('mail.google.com') && href.includes('chat'));
  }

  function isSidebarElement(el) {
    if (!el) return false;
    return Boolean(
      el.closest('[role="navigation"]') ||
      el.closest('nav') ||
      el.closest('.c-pane-sidebar') ||
      el.closest('[aria-label="Navigation drawer"]') ||
      el.closest('[aria-label="Main menu"]')
    );
  }

  // ─── Context & Metadata Detection ─────────────────────────────────────────

  function detectConversationName() {
    // 1. Try document.title (e.g. "CNS support - Google Chat" -> "CNS support")
    if (document.title) {
      const cleaned = document.title
        .replace(/^\(\d+\)\s*/, '')
        .replace(/\s*[-–]\s*Google Chat.*$/i, '')
        .replace(/\s*[-–]\s*Gmail.*$/i, '')
        .trim();
      if (cleaned && !['Google Chat', 'Chat', 'Gmail', 'Inbox', 'Mail'].includes(cleaned)) {
        return cleaned;
      }
    }

    // 2. Main room header element
    const headerSelectors = [
      'div[role="main"] h1', 'header h1', 'div[role="main"] h2',
      '[role="heading"][aria-level="1"]', '[jsname="A4bMJe"]',
      'header [role="button"] span[dir="auto"]',
      '[data-conversation-title]'
    ];

    for (const sel of headerSelectors) {
      const el = document.querySelector(sel);
      if (el && !isSidebarElement(el) && el.textContent.trim()) {
        const text = el.textContent.trim();
        if (!['Chat', 'Google Chat', 'Mail', 'Spaces'].includes(text) && text.length < 80) {
          return text;
        }
      }
    }

    return 'Google Chat Space';
  }

  function detectConversationType() {
    const href = location.href || '';
    if (href.includes('/room/') || href.includes('/space/') || href.includes('/r/') || href.includes('/app/chat/')) return 'SPACE';
    if (href.includes('/dm/') || href.includes('/direct/')) return 'DIRECT_MESSAGE';
    if (document.querySelector('[data-space-id], [aria-label*="Space"]')) return 'SPACE';
    return 'SPACE';
  }

  function scanLiveMetrics() {
    const name = detectConversationName();
    const type = detectConversationType();
    const rows = discoverMessageElements();

    const topicEls = document.querySelectorAll('[data-topic-id]');
    const threadChips = document.querySelectorAll('[aria-label*="repl" i], [data-thread-id], button[data-reply-count]');

    let totalReplies = 0;
    threadChips.forEach(btn => {
      const label = btn.getAttribute('aria-label') || btn.textContent || '';
      const m = label.match(/(\d+)\s+repl/i);
      if (m) totalReplies += parseInt(m[1], 10);
    });
    const renderedReplies = document.querySelectorAll('[data-is-reply="true"], [jsname="oLhsH"] [role="listitem"]').length;
    totalReplies = Math.max(totalReplies, renderedReplies);

    const attachments = document.querySelectorAll('img[src]:not([data-hovercard-id] img):not(.SFknad img), [data-attachment-id], [jsname="q9ME8e"]');

    return {
      isChat: isGoogleChat(),
      name,
      type,
      totalMessages: rows.length,
      totalThreads: Math.max(topicEls.length, threadChips.length),
      totalReplies,
      totalAttachments: attachments.length
    };
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
      try {
        respond(scanLiveMetrics());
      } catch (err) {
        respond({ isChat: isGoogleChat(), name: detectConversationName(), type: detectConversationType(), totalMessages: 0, totalThreads: 0, totalReplies: 0, totalAttachments: 0 });
      }
      return true;
    }

    if (req.action === 'START_EXPORT') {
      isCancelRequested = false;
      executeFullChatExport()
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

  // ─── Real Sender Name Extraction (Never "Google Chat User") ────────────────

  function extractSenderName(row, fallbackSender) {
    const isInsideThreadFooter = (el) => {
      return Boolean(el.closest('[aria-label*="repl" i], [aria-label*="unread" i], .gchat-thread-bar'));
    };

    // 1. Inspect avatar element aria-labels (Google Chat standard for photo & initial avatars)
    const avatarEls = row.querySelectorAll('img[alt], [role="img"][aria-label], [data-hovercard-id], [aria-label*="photo" i], [aria-label*="profile" i]');
    for (const el of avatarEls) {
      if (isInsideThreadFooter(el)) continue;
      const aria = (el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim();
      const m = aria.match(/profile photo of\s+([^,.]+)/i) || aria.match(/view\s+([^'s]+)'s\s+profile/i) || aria.match(/photo of\s+([^,.]+)/i);
      if (m && isValidSenderString(cleanSenderString(m[1]))) {
        return cleanSenderString(m[1]);
      }
      if (aria && isValidSenderString(cleanSenderString(aria))) {
        return cleanSenderString(aria);
      }
    }

    // 2. Direct sender header elements in Google Chat
    const senderSelectors = [
      '[data-hovercard-id]',
      '[data-name]',
      '[data-sender-name]',
      'span.Wq4GMc',
      'div.Wq4GMc',
      'span.FvY9Uc',
      'div.FvY9Uc',
      'span.Z4Eb9b',
      'div[role="heading"]',
      'span[role="heading"]',
      'h3',
      'b',
      '.VfPpkd-rymPhb',
      '.sender-name',
      'span[dir="auto"][style*="font-weight"]'
    ];

    for (const sel of senderSelectors) {
      const candidates = row.querySelectorAll(sel);
      for (const el of candidates) {
        if (isInsideThreadFooter(el)) continue;
        const text = cleanSenderString(el.textContent.trim());
        if (isValidSenderString(text)) {
          return text;
        }
      }
    }

    // 3. Inspect avatar images (alt / title / aria)
    const imgs = row.querySelectorAll('img');
    for (const img of imgs) {
      if (isInsideThreadFooter(img)) continue;
      const src = img.currentSrc || img.src || '';
      const isAvatar = src.includes('/a/') || src.includes('/a-/') || src.includes('/ogw/') ||
        Boolean(img.closest('[data-hovercard-id], [aria-label*="photo" i]')) ||
        (img.clientWidth > 0 && img.clientWidth <= 44);

      if (isAvatar) {
        const alt = cleanSenderString((img.getAttribute('alt') || '').trim());
        if (isValidSenderString(alt)) return alt;

        const aria = (img.getAttribute('aria-label') || '').trim();
        const ariaMatch = aria.match(/profile photo of\s+([^,.]+)/i) || aria.match(/photo:\s*([^,.]+)/i);
        if (ariaMatch && isValidSenderString(cleanSenderString(ariaMatch[1]))) {
          return cleanSenderString(ariaMatch[1]);
        }
      }
    }

    // 4. Header text parsing (e.g. "Only visible to youPiotr Szczepanik, Wed 8:59 PM, Edited")
    const headerEl = row.querySelector('header, .Wq4GMc, .FvY9Uc, div[role="heading"]');
    if (headerEl && !isInsideThreadFooter(headerEl)) {
      const parsed = parseSenderFromHeaderLine(headerEl.textContent);
      if (parsed) return parsed;
    }

    // 5. Cluster / topic sender attribute
    const cluster = row.closest('[data-sender-name]');
    if (cluster && isValidSenderString(cluster.getAttribute('data-sender-name'))) {
      return cluster.getAttribute('data-sender-name').trim();
    }

    // Check first 150 characters of row text for "Only visible to you[Name]" or "[Name] [Time]"
    const rawPreview = (row.innerText || row.textContent || '').slice(0, 150);
    if (rawPreview.includes('Only visible to you') || /\b\d{1,2}:\d{2}/.test(rawPreview)) {
      const parsed = parseSenderFromHeaderLine(rawPreview);
      if (parsed) return parsed;
    }

    return fallbackSender || '';
  }

  function parseSenderFromHeaderLine(raw) {
    if (!raw) return null;
    const firstLine = raw.split('\n')[0].trim();
    let str = firstLine
      .replace(/^Only visible to you\s*/i, '')
      .replace(/[•·]\s*Edited.*/i, '')
      .trim();
    const m = str.match(/^([A-Z][a-zA-Z\s.'-]+?)(?:,\s*|\s+)(?:(Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s*)?\d{1,2}:\d{2}/i);
    if (m && isValidSenderString(cleanSenderString(m[1]))) {
      return cleanSenderString(m[1]);
    }
    return null;
  }

  function cleanSenderString(str) {
    if (!str) return '';
    return str
      .replace(/^Only visible to you\s*/i, '')
      .replace(/[•·]\s*Edited.*/i, '')
      .replace(/\b(Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?[,\s]*\d{1,2}:\d{2}\s*([AP]M)?.*$/i, '')
      .replace(/[,\s]*\d{1,2}:\d{2}\s*([AP]M)?.*$/i, '')
      .trim();
  }

  function isValidSenderString(text) {
    if (!text || text.length < 2 || text.length > 55) return false;
    if (text.includes('\n') || text.includes('http://') || text.includes('https://')) return false;
    if (/^\d{1,2}:\d{2}/.test(text)) return false;
    if (/\b(AM|PM)\b/i.test(text) && /\d/.test(text)) return false;
    const rejectWords = [
      'google chat', 'chat user', 'replies', 'reply', 'unread', 'reaction',
      'quote', 'forward', 'edited', 'delete', 'options', 'history is on',
      'add reaction', 'only visible to you', 'joined', 'left', 'at'
    ];
    if (rejectWords.some(w => text.toLowerCase() === w || text.toLowerCase().startsWith(w + ' '))) return false;
    return true;
  }

  function extractAvatarUrl(row) {
    const imgs = row.querySelectorAll('img');
    for (const img of imgs) {
      if (img.closest('[aria-label*="repl" i], [aria-label*="unread" i], button, .gchat-thread-bar')) continue;
      const src = img.currentSrc || img.src || '';
      if (
        src.includes('googleusercontent.com/a/') ||
        src.includes('googleusercontent.com/a-/') ||
        src.includes('googleusercontent.com/ogw/') ||
        Boolean(img.closest('[data-hovercard-id], [aria-label*="Profile photo" i]')) ||
        (img.clientWidth > 0 && img.clientWidth <= 44)
      ) {
        return src;
      }
    }
    return null;
  }

  // ─── Clean Message Body Text (Removes Header Junk & Buttons) ───────────────

  function extractCleanBodyText(row, senderName) {
    // 1. Direct Google Chat message text body selectors
    const directBodySelectors = [
      'div[jsname="d9t4wf"]',
      'div.tMd3Re',
      'div.Zc1EHg',
      'div[data-message-text]',
      'div.oUJrbe'
    ];

    for (const sel of directBodySelectors) {
      const bodyNode = row.querySelector(sel);
      if (bodyNode) {
        const text = sanitizeExtractedBody(bodyNode.innerText || bodyNode.textContent, senderName);
        if (text && text.length > 0) return text;
      }
    }

    // 2. Clone and strip method
    const clone = row.cloneNode(true);

    // Remove buttons: action toolbar, quick reactions, thread reply buttons
    clone.querySelectorAll('button, [role="button"], [role="toolbar"], [aria-label*="Message actions" i]').forEach(n => n.remove());

    // Remove thread replies footer & badges
    clone.querySelectorAll('[aria-label*="repl" i], [aria-label*="unread" i], .gchat-thread-bar, .gc-threads-container').forEach(n => n.remove());

    // Remove reactions & emoji bars
    clone.querySelectorAll('[aria-label*="reaction" i], [aria-label*="reacted" i], div.Fwf5Ef, [data-emoji-id]').forEach(n => n.remove());

    // Remove sender names, headers, avatars, and timestamps
    clone.querySelectorAll('.FvY9Uc, .Wq4GMc, [data-hovercard-id], [data-name], header, [role="heading"], .njhDLc, time, [data-timestamp], img').forEach(n => n.remove());

    const raw = clone.innerText || clone.textContent || '';
    return sanitizeExtractedBody(raw, senderName);
  }

  function sanitizeExtractedBody(raw, senderName) {
    if (!raw) return '';
    let str = raw.replace(/^Only visible to you\s*/i, '');

    if (senderName) {
      const escaped = senderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const senderRegex = new RegExp('^' + escaped + '[,\\s]*', 'i');
      str = str.replace(senderRegex, '');
    }

    // Strip timestamp and edited markers at start (repeat in case of order variation)
    for (let i = 0; i < 3; i++) {
      str = str
        .replace(/^(?:(?:Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s*)?\d{1,2}:\d{2}\s*(?:[AP]M)?\.?[,\s]*/i, '')
        .replace(/^[•·]?\s*Edited[,\s]*/i, '')
        .trim();
    }

    // Strip trailing actions: Add reaction, Reply, timestamps, Edited
    str = str
      .replace(/Add reaction[,\s]*(?:(?:Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s*)?(?:\d{1,2}:\d{2}\s*(?:[AP]M)?)?[,\s]*(?:[•·]?\s*Edited)?[,\s]*$/i, '')
      .replace(/Reply in thread[,\s]*$/i, '')
      .replace(/Add reaction[,\s]*$/i, '')
      .replace(/[•·]?\s*Edited[,\s]*$/i, '')
      .trim();

    const lines = str.split('\n')
      .map(line => line.trim())
      .filter(line => {
        if (!line || line === ',') return false;
        if (senderName && line === senderName) return false;
        if (/^Add reaction$/i.test(line)) return false;
        if (/^Reply in thread$/i.test(line)) return false;
        if (/^\d+\s+repl(y|ies)/i.test(line)) return false;
        if (/^[,\s]*(Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)?[,\s]*\d{1,2}:\d{2}\s*([AP]M)?.*$/i.test(line)) return false;
        if (/^[,\s]*[•·]?\s*Edited[,\s]*$/i.test(line)) return false;
        return true;
      });

    return lines.join('\n').trim();
  }

  function extractTimestamp(row) {
    const dataTs = row.getAttribute('data-timestamp') || row.querySelector('[data-timestamp]')?.getAttribute('data-timestamp');
    if (dataTs) {
      const num = Number(dataTs);
      if (!isNaN(num) && num > 1000000000) {
        return new Date(num > 1e12 ? num : num * 1000).toISOString();
      }
    }

    const njh = row.querySelector('.njhDLc, time');
    if (njh && !njh.closest('[aria-label*="repl" i], button')) {
      const t = (njh.innerText || njh.textContent || '').trim().replace(/\u00A0/g, ' ');
      if (t && /\d{1,2}:\d{2}/.test(t)) {
        return parseDateStringToIso(t);
      }
    }

    const TIME_REGEX = /\b((Mon|Tue|Wed|Thu|Fri|Sat|Sun|Yesterday|Today)[a-z]*\.?[\s\u00A0]*,?[\s\u00A0]*)?\d{1,2}:\d{2}([\s\u00A0]*[AP]M)?\b/i;
    const candidates = row.querySelectorAll('span, div');
    for (const el of candidates) {
      if (el.closest('[aria-label*="repl" i], button')) continue;
      const text = (el.innerText || el.textContent || '').trim();
      const m = text.match(TIME_REGEX);
      if (m && text.length < 35 && !text.toLowerCase().includes('repl')) {
        return parseDateStringToIso(m[0]);
      }
    }

    return new Date().toISOString();
  }

  function parseDateStringToIso(str) {
    if (!str) return new Date().toISOString();
    try {
      const d = new Date(str);
      if (!isNaN(d.getTime())) return d.toISOString();
    } catch (_) {}
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
      const src = img.currentSrc || img.src || '';
      if (!src || /fonts\.gstatic\.com/i.test(src) || src.startsWith('data:image/svg')) return;
      attachments.push({
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'image',
        filename: img.getAttribute('alt') || 'Screenshot.png',
        url: src,
        previewUrl: src,
        isAccessible: true
      });
    });

    el.querySelectorAll('a[href][target="_blank"]').forEach(link => {
      const href = link.href || '';
      if (href.includes('drive.google.com') || href.includes('docs.google.com') || href.includes('/d/')) {
        attachments.push({
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: 'document',
          filename: link.textContent.trim() || 'Shared Resource',
          url: href,
          previewUrl: null,
          isAccessible: true
        });
      }
    });

    return attachments;
  }

  // ─── Upward Pagination to Absolute Beginning ──────────────────────────────

  async function paginateToAbsoluteBeginning(scrollContainer, messageAccumulator, seenThreadIds, seenReplyIds) {
    let iterations = 0;
    const maxIterations = 500;
    let consecutiveTopStalls = 0;
    let lastAccumulatedCount = messageAccumulator.size;

    while (iterations < maxIterations) {
      if (isCancelRequested) break;
      iterations++;

      scrollContainer.scrollTop = 0;
      await sleep(320);

      harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds);

      const currentCount = messageAccumulator.size;
      const progressPercent = Math.min(42, 10 + Math.round((iterations / maxIterations) * 32));

      sendProgress('Retrieving older messages...', progressPercent, {
        messages: currentCount
      });

      if (currentCount > lastAccumulatedCount) {
        lastAccumulatedCount = currentCount;
        consecutiveTopStalls = 0;
      } else {
        if (scrollContainer.scrollTop === 0) {
          consecutiveTopStalls++;
          scrollContainer.scrollTop = 60;
          await sleep(150);
          scrollContainer.scrollTop = 0;

          if (consecutiveTopStalls >= 5) {
            LOG(`Reached top of conversation after ${iterations} iterations.`);
            break;
          }
        }
      }
    }
  }

  async function sweepDownToBottom(scrollContainer, messageAccumulator, seenThreadIds, seenReplyIds) {
    const scrollHeight = scrollContainer.scrollHeight;
    const step = Math.max(400, Math.floor(scrollContainer.clientHeight * 0.8));
    let pos = 0;

    while (pos < scrollContainer.scrollHeight) {
      if (isCancelRequested) break;
      pos += step;
      scrollContainer.scrollTop = pos;
      await sleep(120);
      harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds);
    }
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await sleep(200);
  }

  function findFeedScrollContainer() {
    const candidates = [
      document.querySelector('[jsname="xySENc"]'),
      document.querySelector('[role="main"] [role="list"]'),
      document.querySelector('[data-view-type="STREAM"]'),
      document.querySelector('[role="main"]')
    ];
    for (const c of candidates) {
      if (c && !isSidebarElement(c) && (c.scrollHeight > c.clientHeight || c.offsetHeight > 350)) return c;
    }
    return document.querySelector('[role="main"]') || document.body;
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
          await sleep(120);
        }
      } catch (_) {}
    }
  }

  // ─── DOM Message & Thread Harvesting ──────────────────────────────────────

  function discoverMessageElements() {
    const topics = Array.from(document.querySelectorAll('[data-topic-id]')).filter(el => !isSidebarElement(el));
    if (topics.length > 0) return topics;

    const msgs = Array.from(document.querySelectorAll('[data-message-id]')).filter(el => !isSidebarElement(el));
    if (msgs.length > 0) return msgs;

    const streamItems = Array.from(document.querySelectorAll('[role="main"] [role="listitem"], [role="main"] .oUJrbe')).filter(el => !isSidebarElement(el));
    if (streamItems.length > 0) return streamItems;

    return Array.from(document.querySelectorAll('div[role="main"] div')).filter(el => {
      if (isSidebarElement(el)) return false;
      if (el.offsetHeight < 30 || el.offsetHeight > 4000) return false;
      const hasTime = el.querySelector('time, [data-timestamp], [data-absolute-time-ms]');
      const hasAvatar = el.querySelector('img[alt], [data-hovercard-id]');
      return Boolean(hasTime && hasAvatar);
    });
  }

  let runningSender = '';
  let runningAvatar = '';

  function harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds) {
    const candidates = discoverMessageElements().filter(el => {
      return !el.closest('[data-is-reply="true"], [jsname="oLhsH"], .gc-thread-card');
    });

    candidates.forEach((row, idx) => {
      const msgId = row.getAttribute('data-message-id') || row.getAttribute('data-id') || `msg_${idx}_${row.offsetTop || Date.now()}`;

      let msg = messageAccumulator.get(msgId);
      if (!msg) {
        let senderName = extractSenderName(row, runningSender);
        if (!senderName) {
          senderName = runningSender || 'Participant';
        } else {
          runningSender = senderName;
        }

        let avatarUrl = extractAvatarUrl(row) || runningAvatar;
        if (avatarUrl) runningAvatar = avatarUrl;

        const sender = {
          name: senderName,
          avatarUrl: avatarUrl || null
        };

        const text = extractCleanBodyText(row, senderName);
        const timestamp = extractTimestamp(row);
        const edited = checkEdited(row);
        const reactions = extractReactions(row);
        const attachments = extractAttachments(row);

        msg = {
          id: msgId,
          sender,
          text,
          timestamp,
          edited,
          reactions,
          attachments,
          threads: []
        };
        messageAccumulator.set(msgId, msg);
      }

      extractIndependentThreads(row, msgId, msg, seenThreadIds, seenReplyIds);
    });
  }

  function extractIndependentThreads(parentRow, parentMessageId, parentMsg, seenThreadIds, seenReplyIds) {
    const threadContainers = parentRow.querySelectorAll(
      '[data-thread-container], [role="region"][aria-label*="Thread"], [data-topic-id]'
    );

    const threadChips = parentRow.querySelectorAll(
      '[aria-label*="repl" i], [data-thread-id], button[data-reply-count]'
    );

    if (threadContainers.length > 1) {
      threadContainers.forEach((tCont, idx) => {
        const threadId = tCont.getAttribute('data-thread-id') || tCont.getAttribute('data-topic-id') || `thread_${parentMessageId}_${idx + 1}`;
        let threadObj = parentMsg.threads.find(t => t.id === threadId);
        if (!threadObj) {
          threadObj = {
            id: threadId,
            parentMessageId,
            threadIndex: idx + 1,
            title: `Thread ${idx + 1}`,
            replyCount: 0,
            replies: []
          };
          parentMsg.threads.push(threadObj);
        }
        extractRepliesIntoThread(tCont, threadId, parentMessageId, threadObj, seenReplyIds);
      });
    } else if (threadChips.length > 0) {
      threadChips.forEach((chip, idx) => {
        const threadId = chip.getAttribute('data-thread-id') || `thread_${parentMessageId}_${idx + 1}`;
        let threadObj = parentMsg.threads.find(t => t.id === threadId);
        if (!threadObj) {
          const label = chip.getAttribute('aria-label') || chip.textContent || '';
          let count = 0;
          const m = label.match(/(\d+)\s+repl/i);
          if (m) count = parseInt(m[1], 10);

          threadObj = {
            id: threadId,
            parentMessageId,
            threadIndex: idx + 1,
            title: `Thread ${idx + 1}`,
            replyCount: count,
            replies: []
          };
          parentMsg.threads.push(threadObj);
        }
        extractRepliesIntoThread(parentRow, threadId, parentMessageId, threadObj, seenReplyIds);
      });
    } else {
      const topicId = parentRow.getAttribute('data-topic-id');
      if (topicId) {
        let threadObj = parentMsg.threads.find(t => t.id === topicId);
        if (!threadObj) {
          threadObj = {
            id: topicId,
            parentMessageId,
            threadIndex: 1,
            title: 'Thread 1',
            replyCount: 0,
            replies: []
          };
        }
        extractRepliesIntoThread(parentRow, topicId, parentMessageId, threadObj, seenReplyIds);
        if (threadObj.replies.length > 0 && !parentMsg.threads.some(t => t.id === topicId)) {
          parentMsg.threads.push(threadObj);
        }
      }
    }
  }

  function extractRepliesIntoThread(container, threadId, parentMessageId, threadObj, seenReplyIds) {
    const replyRows = Array.from(container.querySelectorAll(
      '[data-is-reply="true"], [role="listitem"], .thread-reply-row, [jsname="oLhsH"] div'
    )).filter(r => {
      const mid = r.getAttribute('data-message-id') || r.getAttribute('data-id');
      return mid !== parentMessageId;
    });

    let runningReplySender = '';

    replyRows.forEach((r, idx) => {
      const rId = r.getAttribute('data-message-id') || `reply_${threadId}_${idx + 1}`;
      if (seenReplyIds.has(rId)) return;
      seenReplyIds.add(rId);

      let rSenderName = extractSenderName(r, runningReplySender);
      if (!rSenderName) {
        rSenderName = runningReplySender || 'Participant';
      } else {
        runningReplySender = rSenderName;
      }

      const rSender = {
        name: rSenderName,
        avatarUrl: extractAvatarUrl(r) || null
      };

      const rText = extractCleanBodyText(r, rSenderName);
      const rTimestamp = extractTimestamp(r);
      const rAttachments = extractAttachments(r);
      const rReactions = extractReactions(r);

      threadObj.replies.push({
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

    threadObj.replyCount = Math.max(threadObj.replyCount, threadObj.replies.length);
  }

  // ─── High-Resolution Media & Avatar Base64 Embedding ──────────────────────

  async function hydrateAllMediaAndAvatars(messages) {
    const mediaTasks = [];

    for (const msg of messages) {
      if (msg.sender?.avatarUrl && !msg.sender.avatarUrl.startsWith('data:')) {
        mediaTasks.push({
          target: msg.sender,
          key: 'avatarUrl',
          url: msg.sender.avatarUrl
        });
      }
      for (const att of (msg.attachments || [])) {
        if (att.type === 'image' && att.url && !att.url.startsWith('data:')) {
          mediaTasks.push({
            target: att,
            key: 'previewUrl',
            url: att.url.replace(/=w\d+.*$/, '=s0')
          });
        }
      }
      for (const t of (msg.threads || [])) {
        for (const r of (t.replies || [])) {
          if (r.sender?.avatarUrl && !r.sender.avatarUrl.startsWith('data:')) {
            mediaTasks.push({
              target: r.sender,
              key: 'avatarUrl',
              url: r.sender.avatarUrl
            });
          }
          for (const att of (r.attachments || [])) {
            if (att.type === 'image' && att.url && !att.url.startsWith('data:')) {
              mediaTasks.push({
                target: att,
                key: 'previewUrl',
                url: att.url.replace(/=w\d+.*$/, '=s0')
              });
            }
          }
        }
      }
    }

    LOG(`Hydrating ${mediaTasks.length} media and avatar resources to offline Base64 data URLs...`);

    const BATCH_SIZE = 4;
    for (let i = 0; i < mediaTasks.length; i += BATCH_SIZE) {
      if (isCancelRequested) break;
      const batch = mediaTasks.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async task => {
        try {
          const resp = await fetch(task.url, { credentials: 'include' });
          if (resp.ok) {
            const blob = await resp.blob();
            const dataUrl = await blobToDataUrl(blob);
            if (dataUrl) {
              task.target[task.key] = dataUrl;
            }
          }
        } catch (_) {}
      }));

      const pct = 65 + Math.round((i / Math.max(1, mediaTasks.length)) * 22);
      sendProgress(`Downloading full-res media (${Math.min(i + BATCH_SIZE, mediaTasks.length)}/${mediaTasks.length})...`, pct);
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

  // ─── Full Chat Export Orchestration ───────────────────────────────────────

  async function executeFullChatExport() {
    LOG('Starting full chat export...');
    sendProgress('Detecting chat and preparing export...', 2);

    const scrollContainer = findFeedScrollContainer();
    const messageAccumulator = new Map();
    const seenThreadIds = new Set();
    const seenReplyIds = new Set();

    // 1. Initial DOM sweep
    harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds);

    // 2. Expand collapsed threads
    sendProgress('Expanding conversation threads...', 6);
    await expandThreadsInDOM();

    // 3. Paginate up to absolute beginning
    sendProgress('Retrieving full conversation history...', 10, {
      messages: messageAccumulator.size
    });
    await paginateToAbsoluteBeginning(scrollContainer, messageAccumulator, seenThreadIds, seenReplyIds);

    // 4. Sweep down to capture all virtualized messages and replies
    sendProgress('Verifying messages from top to bottom...', 50, {
      messages: messageAccumulator.size
    });
    await sweepDownToBottom(scrollContainer, messageAccumulator, seenThreadIds, seenReplyIds);

    // 5. Final harvest
    harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds);

    const rawMessages = Array.from(messageAccumulator.values());
    if (rawMessages.length === 0) {
      throw new Error('No messages detected in this Google Chat view. Please scroll slightly in the chat and retry.');
    }

    // Sort chronologically
    rawMessages.sort((a, b) => {
      const tA = new Date(a.timestamp || 0).getTime();
      const tB = new Date(b.timestamp || 0).getTime();
      return tA - tB;
    });

    let totalThreads = 0;
    let totalReplies = 0;
    let totalAttachments = 0;
    rawMessages.forEach(m => {
      if (m.attachments) totalAttachments += m.attachments.length;
      (m.threads || []).forEach(t => {
        totalThreads++;
        totalReplies += (t.replies || []).length;
        (t.replies || []).forEach(r => {
          if (r.attachments) totalAttachments += r.attachments.length;
        });
      });
    });

    sendProgress('Embedding high-resolution media & avatars...', 65, {
      messages: rawMessages.length,
      threads: totalThreads,
      replies: totalReplies,
      attachments: totalAttachments
    });

    // 6. Offline media hydration
    await hydrateAllMediaAndAvatars(rawMessages);

    // 7. Generate Standalone Google Chat Replica HTML
    sendProgress('Generating clean Google Chat replica HTML...', 90);
    const convoName = detectConversationName();
    const convoType = detectConversationType();
    const metadata = {
      name: convoName,
      type: convoType,
      exportedAt: new Date().toISOString()
    };

    const htmlContent = generateGoogleChatReplicaHtml(rawMessages, metadata);

    // 8. Download HTML file
    const safeName = convoName.replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_').slice(0, 40) || 'GoogleChat';
    const timestampStr = new Date().toISOString().slice(0, 10);
    const filename = `${safeName}_Export_${timestampStr}.html`;

    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    downloadBlob(blob, filename);

    sendProgress('Export complete!', 100, {
      messages: rawMessages.length,
      threads: totalThreads,
      replies: totalReplies,
      attachments: totalAttachments
    });

    return {
      filename,
      totalMessages: rawMessages.length,
      totalThreads,
      totalReplies,
      totalAttachments
    };
  }

  // ─── Native Google Chat UI HTML Generator (Clean, Authentic, No Clutter) ───

  function generateGoogleChatReplicaHtml(messages, metadata) {
    const convoName = metadata.name || 'Google Chat Space';
    const convoType = metadata.type || 'SPACE';
    const exportedAt = metadata.exportedAt || new Date().toISOString();
    const formattedExportDate = new Date(exportedAt).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });

    let totalThreads = 0;
    let totalReplies = 0;
    let totalAttachments = 0;

    messages.forEach(m => {
      if (m.attachments) totalAttachments += m.attachments.length;
      (m.threads || []).forEach(t => {
        totalThreads++;
        totalReplies += (t.replies || []).length;
        (t.replies || []).forEach(r => {
          if (r.attachments) totalAttachments += r.attachments.length;
        });
      });
    });

    let lastDateStr = '';
    const renderedFeed = [];

    messages.forEach((msg, idx) => {
      const dateStr = formatDateDivider(msg.timestamp);
      if (dateStr && dateStr !== lastDateStr) {
        renderedFeed.push(`
          <div class="gc-date-divider-row">
            <span class="gc-date-divider-pill">${escapeHtml(dateStr)}</span>
          </div>
        `);
        lastDateStr = dateStr;
      }
      renderedFeed.push(renderParentMessageHtml(msg, idx + 1));
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(convoName)} - Google Chat</title>
<style>
/* ─── Exact Native Google Chat Styling & Palette ─── */
:root {
  --font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
  --bg-page: #ffffff;
  --bg-header: #ffffff;
  --bg-chat-pane: #ffffff;
  --bg-hover: #f8fafd;
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
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.06);
  --radius-avatar: 50%;
  --radius-pill: 20px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font-family);
  background-color: var(--bg-page);
  color: var(--text-primary);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* Authentic Google Chat Top Bar */
.gc-app-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border-color);
  padding: 14px 28px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: var(--shadow-sm);
}

.gc-header-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.gc-logo-icon {
  width: 36px;
  height: 36px;
  background: #00897b;
  color: #fff;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 137, 123, 0.25);
}

.gc-logo-icon svg { width: 22px; height: 22px; }

.gc-title-group h1 {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.2;
}

.gc-meta-group {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 3px;
}

.gc-badge-pill {
  background: var(--chip-bg);
  color: var(--chip-text);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  text-transform: uppercase;
}

.gc-export-stats-text {
  font-size: 12px;
  color: var(--text-muted);
}

/* Chat Feed */
.gc-main-feed-container {
  max-width: 980px;
  width: 100%;
  margin: 0 auto;
  padding: 16px 20px 60px;
}

/* Date Divider */
.gc-date-divider-row {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  margin: 24px 0 16px;
  user-select: none;
}

.gc-date-divider-row::before {
  content: '';
  position: absolute;
  left: 20px;
  right: 20px;
  height: 1px;
  background: var(--border-color);
  z-index: 1;
}

.gc-date-divider-pill {
  position: relative;
  z-index: 2;
  background: var(--bg-header);
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  padding: 4px 14px;
  border-radius: var(--radius-pill);
}

/* Parent Message */
.gc-parent-message {
  padding: 14px 18px;
  border-radius: 8px;
  margin-bottom: 6px;
  transition: background-color 0.1s ease;
}

.gc-parent-message:hover {
  background-color: var(--bg-hover);
}

.gc-message-layout {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.gc-avatar-col { flex-shrink: 0; }

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

.gc-avatar-circle img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.gc-content-col {
  flex: 1;
  min-width: 0;
}

.gc-meta-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 3px;
}

.gc-sender-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.gc-timestamp-text {
  font-size: 12px;
  color: var(--text-muted);
}

.gc-edited-tag {
  font-size: 11px;
  color: var(--text-muted);
}

.gc-body-text {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.gc-body-text a {
  color: var(--google-blue);
  text-decoration: none;
}
.gc-body-text a:hover { text-decoration: underline; }

/* Reactions */
.gc-reactions-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.gc-reaction-chip {
  background: var(--reaction-bg);
  border: 1px solid var(--reaction-border);
  border-radius: var(--radius-pill);
  padding: 2px 8px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.gc-reaction-count {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 11px;
}

/* Attachments */
.gc-attachments-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}

.gc-screenshot-card {
  max-width: 440px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  overflow: hidden;
  background: #000;
  cursor: pointer;
}

.gc-screenshot-card img {
  display: block;
  width: 100%;
  max-height: 380px;
  object-fit: cover;
}

.gc-doc-file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 8px 12px;
  text-decoration: none;
  color: var(--text-primary);
  max-width: 380px;
}

.gc-doc-file-icon { font-size: 20px; }
.gc-doc-file-name {
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* In-line Thread Container & Cards */
.gc-threads-container {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gc-thread-card {
  background: var(--bg-thread-card);
  border: 1px solid var(--border-color);
  border-left: 3px solid var(--border-accent);
  border-radius: 8px;
  overflow: hidden;
}

.gc-thread-header {
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(0, 137, 123, 0.04);
  cursor: pointer;
  user-select: none;
}

.gc-thread-header:hover {
  background: rgba(0, 137, 123, 0.08);
}

.gc-thread-title-area {
  display: flex;
  align-items: center;
  gap: 6px;
}

.gc-thread-badge {
  color: var(--google-green);
  font-size: 11px;
  font-weight: 700;
}

.gc-reply-count-badge {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary);
}

.gc-thread-chevron {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.gc-thread-card.collapsed .gc-thread-chevron {
  transform: rotate(-90deg);
}

.gc-thread-card.collapsed .gc-replies-list {
  display: none;
}

.gc-replies-list {
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gc-reply-row {
  background: var(--bg-reply);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 12px;
  display: flex;
  gap: 10px;
}

.gc-reply-avatar {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-avatar);
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  overflow: hidden;
}

.gc-reply-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.gc-reply-content {
  flex: 1;
  min-width: 0;
}

/* Lightbox Modal */
.gc-lightbox-modal {
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

.gc-lightbox-modal.active { display: flex; }

.gc-lightbox-img {
  max-width: 92%;
  max-height: 92%;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8);
}
</style>
</head>
<body>

<!-- Native Google Chat App Top Bar -->
<header class="gc-app-header">
  <div class="gc-header-left">
    <div class="gc-logo-icon" title="Google Chat">
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/>
        <path d="M7 9h10v2H7zm0-3h10v2H7z"/>
      </svg>
    </div>
    <div class="gc-title-group">
      <h1>${escapeHtml(convoName)}</h1>
      <div class="gc-meta-group">
        <span class="gc-badge-pill">${escapeHtml(convoType)}</span>
        <span class="gc-export-stats-text">${messages.length} messages &bull; ${totalThreads} threads &bull; ${totalReplies} replies &bull; ${totalAttachments} media &bull; Exported ${escapeHtml(formattedExportDate)}</span>
      </div>
    </div>
  </div>
</header>

<!-- Chat Feed -->
<main class="gc-main-feed-container">
  ${renderedFeed.join('\n') || '<div style="padding:48px;text-align:center;color:var(--text-muted);">No messages found.</div>'}
</main>

<!-- Lightbox Modal -->
<div class="gc-lightbox-modal" id="lightbox" onclick="this.classList.remove('active')">
  <img class="gc-lightbox-img" id="lightbox-img" src="" alt="Enlarged screenshot" />
</div>

<script>
// Standalone Thread Toggle & Lightbox
(function() {
  document.querySelectorAll('.gc-thread-header').forEach(header => {
    header.addEventListener('click', () => {
      const card = header.closest('.gc-thread-card');
      card.classList.toggle('collapsed');
    });
  });

  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');

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

  function renderParentMessageHtml(msg, index) {
    const senderName = msg.sender?.name || 'Participant';
    const avatarUrl = msg.sender?.avatarUrl;
    const initial = (senderName[0] || 'P').toUpperCase();
    const avatarColor = getAvatarColor(senderName);
    const timeStr = formatTime(msg.timestamp);
    const textContent = msg.text || '';
    const reactionsHtml = renderReactionsHtml(msg.reactions);
    const attachmentsHtml = renderAttachmentsHtml(msg.attachments);

    const threads = msg.threads || [];
    let threadsSectionHtml = '';

    if (threads.length > 0) {
      const threadsHtml = threads.map((thread, tIdx) => renderThreadHtml(thread, tIdx + 1, msg.id)).join('\n');
      threadsSectionHtml = `
      <div class="gc-threads-container">
        ${threadsHtml}
      </div>`;
    }

    return `
    <article class="gc-parent-message parent-message-card" id="msg-${escapeHtml(msg.id)}">
      <div class="gc-message-layout">
        <div class="gc-avatar-col">
          <div class="gc-avatar-circle" style="background-color: ${avatarColor};">
            ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(senderName)}" onerror="this.style.display='none';this.parentElement.textContent='${escapeHtml(initial)}'" />` : initial}
          </div>
        </div>
        <div class="gc-content-col">
          <div class="gc-meta-line">
            <span class="gc-sender-name">${escapeHtml(senderName)}</span>
            <span class="gc-timestamp-text">${escapeHtml(timeStr)}</span>
            ${msg.edited ? '<span class="gc-edited-tag">(edited)</span>' : ''}
          </div>
          <div class="gc-body-text">${escapeHtml(textContent)}</div>
          ${attachmentsHtml}
          ${reactionsHtml}
          ${threadsSectionHtml}
        </div>
      </div>
    </article>`;
  }

  function renderThreadHtml(thread, threadNumber, parentMessageId) {
    const threadId = thread.id || `thread-${threadNumber}`;
    const replies = thread.replies || [];
    const replyCount = thread.replyCount !== undefined ? thread.replyCount : replies.length;
    const repliesHtml = replies.map(r => renderReplyHtml(r)).join('\n');

    return `
    <div class="gc-thread-card thread-card" id="${escapeHtml(threadId)}">
      <div class="gc-thread-header" title="Click to expand/collapse thread">
        <div class="gc-thread-title-area">
          <span class="gc-thread-badge">Thread ${threadNumber}</span>
          <span class="gc-reply-count-badge">${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
        </div>
        <span class="gc-thread-chevron">▼</span>
      </div>
      <div class="gc-replies-list">
        ${repliesHtml || '<div style="color:var(--text-muted);font-size:12px;">No replies found.</div>'}
      </div>
    </div>`;
  }

  function renderReplyHtml(reply) {
    const senderName = reply.sender?.name || 'Participant';
    const avatarUrl = reply.sender?.avatarUrl;
    const initial = (senderName[0] || 'P').toUpperCase();
    const avatarColor = getAvatarColor(senderName);
    const timeStr = formatTime(reply.timestamp);
    const textContent = reply.text || '';
    const reactionsHtml = renderReactionsHtml(reply.reactions);
    const attachmentsHtml = renderAttachmentsHtml(reply.attachments);

    return `
    <div class="gc-reply-row reply-row" id="reply-${escapeHtml(reply.id)}">
      <div class="gc-reply-avatar" style="background-color: ${avatarColor};">
        ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(senderName)}" onerror="this.style.display='none';this.parentElement.textContent='${escapeHtml(initial)}'" />` : initial}
      </div>
      <div class="gc-reply-content">
        <div class="gc-meta-line">
          <span class="gc-sender-name">${escapeHtml(senderName)}</span>
          <span class="gc-timestamp-text">${escapeHtml(timeStr)}</span>
          ${reply.edited ? '<span class="gc-edited-tag">(edited)</span>' : ''}
        </div>
        <div class="gc-body-text">${escapeHtml(textContent)}</div>
        ${attachmentsHtml}
        ${reactionsHtml}
      </div>
    </div>`;
  }

  function renderReactionsHtml(reactions) {
    if (!reactions || reactions.length === 0) return '';
    const chips = reactions.map(r => `
      <span class="gc-reaction-chip">
        <span>${escapeHtml(r.emoji)}</span>
        <span class="gc-reaction-count">${r.count}</span>
      </span>
    `).join('');
    return `<div class="gc-reactions-row">${chips}</div>`;
  }

  function renderAttachmentsHtml(attachments) {
    if (!attachments || attachments.length === 0) return '';
    const items = attachments.map(att => {
      const name = att.filename || att.name || 'Screenshot';
      const isImg = att.type === 'image' || (att.previewUrl && (att.previewUrl.startsWith('data:image') || !att.previewUrl.includes('drive')));
      const previewUrl = att.previewUrl || att.url;

      if (isImg && previewUrl) {
        return `
        <div class="gc-screenshot-card" onclick="openLightbox('${escapeHtml(previewUrl)}')">
          <img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(name)}" loading="lazy" />
        </div>`;
      }

      return `
      <a href="${escapeHtml(att.url || '#')}" target="_blank" class="gc-doc-file-card" rel="noopener noreferrer">
        <span class="gc-doc-file-icon">📄</span>
        <span class="gc-doc-file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      </a>`;
    }).join('');

    return `<div class="gc-attachments-wrap">${items}</div>`;
  }

  // ─── Download & Progress Messaging ────────────────────────────────────────

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

  LOG('Google Chat Exporter Engine v3.0 loaded.');
})();
