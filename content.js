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

  if (window.__GCE_CONTENT_ENGINE_V7__) return;
  window.__GCE_CONTENT_ENGINE_V7__ = true;

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
      const timePart = d.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      const monthPart = d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric'
      });
      return `${monthPart}, ${timePart}`;
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
        day: 'numeric'
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

  function cleanConversationTitle(str) {
    if (!str) return '';
    return str
      .replace(/^\(\d+\)\s*/, '')
      .replace(/\s*[-–]\s*(?:Google\s+)?Chat.*$/i, '')
      .replace(/\s*[-–]\s*Gmail.*$/i, '')
      .replace(/^(?:Chat with|Space options for|Conversation options for)\s+/i, '')
      .replace(/,\s*\d+\s+unread.*$/i, '')
      .replace(/\s*[▼v]$/i, '')
      .trim();
  }

  function isValidConversationName(str) {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim();
    if (s.length < 2 || s.length > 80) return false;
    if (s.includes('\n')) return false;
    const reject = [
      'google chat', 'chat', 'spaces', 'search chat', 'history is on',
      'history is off', 'active now', 'away', 'back', 'close', 'send',
      'reply', 'share', 'options', 'main menu', 'navigation drawer',
      'direct messages', 'ready to export', 'export incomplete',
      'scanning conversation...', 'active google chat', 'google chat space'
    ];
    if (reject.includes(s.toLowerCase())) return false;
    return true;
  }

  function detectConversationName() {
    // 1. Try document.title (e.g. "Md Zahidul Islam Sumon - Chat" or "CNS support - Google Chat")
    if (document.title) {
      const cleaned = cleanConversationTitle(document.title);
      if (isValidConversationName(cleaned)) {
        return cleaned;
      }
    }

    // 2. Look for the conversation title dropdown button in the top bar
    const topBarButtons = document.querySelectorAll(
      '[role="main"] button, [role="main"] [role="button"], div[role="banner"] [role="button"], [jscontroller] [role="button"]'
    );
    for (const btn of topBarButtons) {
      if (isSidebarElement(btn)) continue;
      // Check aria-label
      const aria = btn.getAttribute('aria-label') || '';
      if (aria) {
        const cleanedAria = cleanConversationTitle(aria);
        if (isValidConversationName(cleanedAria) && !aria.toLowerCase().includes('search') && !aria.toLowerCase().includes('message')) {
          const rect = btn.getBoundingClientRect();
          if (rect.top < 180 && rect.height > 20) {
            return cleanedAria;
          }
        }
      }

      // Check inner visible text
      const spans = btn.querySelectorAll('span[dir="auto"], div[dir="auto"]');
      for (const sp of spans) {
        const txt = cleanConversationTitle(sp.innerText || sp.textContent);
        if (isValidConversationName(txt)) {
          const rect = sp.getBoundingClientRect();
          if (rect.top < 180 && rect.height > 14) {
            return txt;
          }
        }
      }
    }

    // 3. Welcome card / contact heading in main stream (e.g. Direct message header showing name + email)
    const welcomeHeadings = document.querySelectorAll(
      '[role="main"] h1, [role="main"] h2, [role="main"] [role="heading"], [role="main"] .Yv3xrd, [role="main"] [data-conversation-title]'
    );
    for (const h of welcomeHeadings) {
      if (isSidebarElement(h)) continue;
      const txt = cleanConversationTitle(h.innerText || h.textContent);
      if (isValidConversationName(txt)) {
        return txt;
      }
    }

    // Elements followed by an email or "You created this chat on"
    const textNodes = document.querySelectorAll('[role="main"] div[dir="auto"], [role="main"] span[dir="auto"]');
    for (const node of textNodes) {
      if (isSidebarElement(node)) continue;
      const parent = node.closest('div');
      if (parent && (parent.textContent.includes('@') || parent.textContent.includes('You created this chat on'))) {
        const txt = cleanConversationTitle(node.innerText || node.textContent);
        if (isValidConversationName(txt) && !txt.includes('@') && !txt.includes('created')) {
          return txt;
        }
      }
    }

    // 4. Match active conversation link in sidebar using current URL pathname
    const currentPath = location.pathname;
    const pathParts = currentPath.split('/').filter(Boolean);
    const convoId = pathParts[pathParts.length - 1];

    if (convoId && convoId.length >= 4) {
      const activeLink = document.querySelector(`a[href*="${convoId}"], [data-navigation-item-id*="${convoId}"], [data-id*="${convoId}"]`);
      if (activeLink) {
        const label = activeLink.getAttribute('aria-label') ||
                      activeLink.querySelector('[dir="auto"]')?.textContent ||
                      activeLink.innerText || '';
        const cleaned = cleanConversationTitle(label);
        if (isValidConversationName(cleaned)) {
          return cleaned;
        }
      }
    }

    // 5. Active item in sidebar navigation
    const activeSidebarItem = document.querySelector(
      '[role="navigation"] [aria-selected="true"], [role="treeitem"][aria-selected="true"], [aria-current="page"]'
    );
    if (activeSidebarItem) {
      const label = activeSidebarItem.getAttribute('aria-label') ||
                    activeSidebarItem.querySelector('[dir="auto"]')?.textContent ||
                    activeSidebarItem.innerText || '';
      const cleaned = cleanConversationTitle(label);
      if (isValidConversationName(cleaned)) {
        return cleaned;
      }
    }

    // Fallback: If in a 1:1 chat and sender is discovered, use the partner's name
    if (runningSender && isValidConversationName(runningSender) && runningSender !== 'Participant' && runningSender !== 'You') {
      return runningSender;
    }

    return 'Google Chat Conversation';
  }

  function detectConversationType() {
    const href = location.href || '';
    if (href.includes('/dm/') || href.includes('/direct/')) return 'DIRECT_MESSAGE';
    if (href.includes('/room/') || href.includes('/space/')) return 'SPACE';

    // 1. Email address visible in main chat header or welcome card -> DIRECT_MESSAGE
    const mainEl = document.querySelector('[role="main"]') || document.body;
    const mainText = mainEl.innerText || mainEl.textContent || '';
    if (
      mainText.includes('You created this chat on') ||
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(mainText.slice(0, 800))
    ) {
      return 'DIRECT_MESSAGE';
    }

    // 2. Check sidebar section of the active conversation link
    const pathParts = location.pathname.split('/').filter(Boolean);
    const convoId = pathParts[pathParts.length - 1];
    if (convoId && convoId.length >= 4) {
      const activeLink = document.querySelector(`a[href*="${convoId}"], [data-id*="${convoId}"]`);
      if (activeLink) {
        const dmSection = activeLink.closest('[aria-label*="Direct messages" i], [data-section*="dm" i]');
        if (dmSection) return 'DIRECT_MESSAGE';
        const spaceSection = activeLink.closest('[aria-label*="Spaces" i], [data-section*="spaces" i]');
        if (spaceSection) return 'SPACE';
      }
    }

    // 3. Space indicators
    const hasSpaceIndicator = Boolean(
      document.querySelector('[data-space-id], [aria-label*="Space details" i], [aria-label*="Space options" i]') ||
      document.querySelector('[role="main"] [data-topic-id]') ||
      /\b\d+\s+members\b/i.test(mainText.slice(0, 500))
    );
    if (hasSpaceIndicator) return 'SPACE';

    // 4. Comma-separated names in title indicates group chat
    const title = detectConversationName();
    if (title.includes(',') && title.split(',').length >= 2) {
      return 'GROUP_CHAT';
    }

    // 5. If flat stream with 0 topic IDs or reply chips -> DIRECT_MESSAGE
    if (document.querySelectorAll('[data-topic-id], [aria-label*="replies" i]').length === 0) {
      return 'DIRECT_MESSAGE';
    }

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

    // 0. Check if outgoing / self message
    const rowAria = row.getAttribute('aria-label') || '';
    if (/^(?:You|Me)\b/i.test(rowAria) || row.querySelector('[data-is-self="true"]') || row.getAttribute('data-is-self') === 'true') {
      return 'You';
    }
    const isAlignRight = row.style?.justifyContent === 'flex-end' ||
                         row.classList.contains('outgoing') ||
                         row.querySelector('.outgoing, [data-self="true"]');
    if (isAlignRight) {
      return 'You';
    }

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
      .replace(/^Message\s+/i, '')
      .replace(/^Send a direct message to\s+/i, '')
      .replace(/^Chat with\s+/i, '')
      .replace(/[•·]\s*Edited.*/i, '')
      .replace(/\b(Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?[,\s]*\d{0,2},?[,\s]*\d{1,2}:\d{2}\s*([AP]M)?.*$/i, '')
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
      'history is off', 'add reaction', 'only visible to you', 'joined', 'left', 'at',
      'space updates', 'messages sent', 'direct message', 'chat with'
    ];
    if (rejectWords.some(w => text.toLowerCase() === w || text.toLowerCase().startsWith(w + ' '))) return false;
    if (/^Message\s+[A-Z]/i.test(text)) return false;
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

    // Strip leading commas, spaces, timestamps, and edited markers
    for (let i = 0; i < 3; i++) {
      str = str
        .replace(/^[,\s]*/, '')
        .replace(/^(?:(?:Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s*\d{0,2},?\s*)?\d{1,2}:\d{2}\s*(?:[AP]M)?\.?[,\s]*/i, '')
        .replace(/^[•·]?\s*Edited[,\s]*/i, '')
        .trim();
    }

    // Strip trailing actions: Add reaction, Reply, timestamps, Edited, Read receipts
    str = str
      .replace(/Add reaction[,\s]*(?:(?:Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s*\d{0,2},?\s*)?(?:\d{1,2}:\d{2}\s*(?:[AP]M)?)?[,\s]*(?:[•·]?\s*Edited)?[,\s]*$/i, '')
      .replace(/Reply in thread[,\s]*$/i, '')
      .replace(/Add reaction[,\s]*$/i, '')
      .replace(/[•·]?\s*Edited[,\s]*$/i, '')
      .replace(/Message viewed by.*$/i, '')
      .replace(/[,\s]*\d{1,2}:\d{2}\s*(?:[AP]M)?\.?[,\s]*$/i, '')
      .trim();

    const lines = str.split('\n')
      .map(line => line.trim())
      .filter(line => {
        if (!line || line === ',') return false;
        if (senderName && line === senderName) return false;
        if (/^Add reaction$/i.test(line)) return false;
        if (/^Reply in thread$/i.test(line)) return false;
        if (/^\d+\s+repl(y|ies)/i.test(line)) return false;
        if (/^Message viewed by/i.test(line)) return false;
        if (/^[,\s]*(?:Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?[,\s]*\d{0,2},?[,\s]*\d{1,2}:\d{2}\s*([AP]M)?.*$/i.test(line)) return false;
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

    const TIME_REGEX = /\b(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Yesterday|Today|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?[\s\u00A0]*,?[\s\u00A0]*\d{0,2},?[\s\u00A0]*)?\d{1,2}:\d{2}([\s\u00A0]*[AP]M)?\b/i;
    const candidates = row.querySelectorAll('span, div, time');
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
      const currentYear = new Date().getFullYear();

      // 1. Match month + day + time (e.g. "Sep 29, 3:59 PM" or "Sep 30, 12:38 PM")
      const mFull = str.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s*(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
      if (mFull) {
        const month = mFull[1];
        const day = mFull[2];
        let hours = parseInt(mFull[3], 10);
        const minutes = parseInt(mFull[4], 10);
        const ampm = mFull[5] ? mFull[5].toUpperCase() : '';
        if (ampm === 'PM' && hours < 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;
        const d = new Date(Date.parse(`${month} ${day}, ${currentYear} ${hours}:${minutes < 10 ? '0' + minutes : minutes}:00`));
        if (!isNaN(d.getTime())) return d.toISOString();
      }

      // 2. Direct Date parse if year > 2010
      let d = new Date(str);
      if (!isNaN(d.getTime()) && d.getFullYear() > 2010) return d.toISOString();

      // 3. Try with current year appended
      d = new Date(str + ', ' + currentYear);
      if (!isNaN(d.getTime()) && d.getFullYear() > 2010) return d.toISOString();

      // 4. Time only, e.g. "3:59 PM"
      const mTime = str.match(/(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
      if (mTime) {
        let hours = parseInt(mTime[1], 10);
        const minutes = parseInt(mTime[2], 10);
        const ampm = mTime[3] ? mTime[3].toUpperCase() : '';
        if (ampm === 'PM' && hours < 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;
        const now = new Date();
        now.setHours(hours, minutes, 0, 0);
        return now.toISOString();
      }
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
      // Skip read receipt avatars and tiny icons
      if (
        img.closest('[aria-label*="viewed by" i], [aria-label*="read receipt" i], [data-tooltip*="viewed" i]') ||
        (img.alt && /viewed by/i.test(img.alt)) ||
        (img.clientWidth > 0 && img.clientWidth <= 24) ||
        (img.clientHeight > 0 && img.clientHeight <= 24)
      ) {
        return;
      }
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

      harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds, scrollContainer);

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
      harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds, scrollContainer);
    }
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await sleep(200);
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (isSidebarElement(el)) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    if (el.closest('.c-pane-sidebar, [role="navigation"]')) return false;
    if (typeof el.offsetParent !== 'undefined' && el.offsetParent === null) {
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        const pos = window.getComputedStyle(el).position;
        if (pos !== 'fixed') return false;
      }
    }
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  }

  function isSystemEventNode(el) {
    if (!el) return false;
    const text = (el.innerText || el.textContent || '').trim();
    if (
      text.startsWith('Space updates') ||
      text.startsWith('History is on') ||
      text.startsWith('You created this chat on') ||
      text.includes('Messages sent with history on are saved')
    ) {
      return true;
    }
    return false;
  }

  function getActiveMainContainer() {
    const mainCandidates = Array.from(document.querySelectorAll('[role="main"], div[role="region"], div[data-view-type="STREAM"]'));
    for (const main of mainCandidates) {
      if (isSidebarElement(main)) continue;
      if (main.closest('[aria-hidden="true"]')) continue;
      if (main.offsetWidth > 250 && main.offsetHeight > 200) {
        return main;
      }
    }
    return document.querySelector('[role="main"]') || document.body;
  }

  function findFeedScrollContainer() {
    const activeMain = getActiveMainContainer();
    const candidates = [
      activeMain.querySelector('[jsname="xySENc"]'),
      activeMain.querySelector('[role="list"]'),
      activeMain.querySelector('[data-view-type="STREAM"]'),
      activeMain
    ];
    for (const c of candidates) {
      if (c && isElementVisible(c) && (c.scrollHeight > c.clientHeight || c.offsetHeight > 250)) {
        return c;
      }
    }
    return activeMain;
  }

  async function expandThreadsInDOM() {
    const activeMain = getActiveMainContainer();
    const expandButtons = activeMain.querySelectorAll(
      '[aria-label*="replies" i][role="button"], [aria-label*="unread" i][role="button"], button[data-reply-count]'
    );
    for (const btn of expandButtons) {
      if (isCancelRequested) break;
      const label = (btn.getAttribute('aria-label') || btn.textContent || '').trim();
      if (/^(?:reply|reply in thread|quick reply)$/i.test(label)) continue;
      try {
        if (btn.getAttribute('aria-expanded') === 'false') {
          btn.click();
          await sleep(120);
        }
      } catch (_) {}
    }
  }

  // ─── DOM Message & Thread Harvesting ──────────────────────────────────────

  function discoverMessageElements(container) {
    const root = container || findFeedScrollContainer();
    if (!root) return [];

    const topics = Array.from(root.querySelectorAll('[data-topic-id]'))
      .filter(el => isElementVisible(el) && !isSystemEventNode(el));
    if (topics.length > 0) return topics;

    const msgs = Array.from(root.querySelectorAll('[data-message-id]'))
      .filter(el => isElementVisible(el) && !isSystemEventNode(el));
    if (msgs.length > 0) return msgs;

    const streamItems = Array.from(root.querySelectorAll('[role="listitem"], .oUJrbe'))
      .filter(el => isElementVisible(el) && !isSystemEventNode(el));
    if (streamItems.length > 0) return streamItems;

    return Array.from(root.querySelectorAll('div')).filter(el => {
      if (!isElementVisible(el) || isSystemEventNode(el)) return false;
      if (el.offsetHeight < 30 || el.offsetHeight > 4000) return false;
      const hasTime = el.querySelector('time, [data-timestamp], [data-absolute-time-ms]');
      const hasAvatar = el.querySelector('img[alt], [data-hovercard-id]');
      return Boolean(hasTime && hasAvatar);
    });
  }

  let runningSender = '';
  let runningAvatar = '';

  function harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds, scrollContainer) {
    const container = scrollContainer || findFeedScrollContainer();
    const candidates = discoverMessageElements(container).filter(el => {
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

        const isSelf = senderName.toLowerCase() === 'you';
        let avatarUrl = isSelf ? null : (extractAvatarUrl(row) || runningAvatar);
        if (avatarUrl && !isSelf) runningAvatar = avatarUrl;

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
          isSelf,
          threads: []
        };
        messageAccumulator.set(msgId, msg);
      }

      extractIndependentThreads(row, msgId, msg, seenThreadIds, seenReplyIds);
    });
  }

  function extractIndependentThreads(parentRow, parentMessageId, parentMsg, seenThreadIds, seenReplyIds) {
    const threadContainers = Array.from(parentRow.querySelectorAll(
      '[data-thread-container], [role="region"][aria-label*="Thread"], [data-topic-id]'
    )).filter(c => c !== parentRow);

    const threadChips = Array.from(parentRow.querySelectorAll(
      '[aria-label*="repl" i], [data-thread-id], button[data-reply-count]'
    )).filter(btn => {
      const label = (btn.getAttribute('aria-label') || btn.textContent || '').trim();
      if (/^(?:reply|reply in thread|quick reply)$/i.test(label)) return false;
      return /(\d+)\s+repl/i.test(label) || btn.hasAttribute('data-reply-count') || btn.hasAttribute('data-thread-id');
    });

    if (threadContainers.length > 0) {
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
        }
        extractRepliesIntoThread(tCont, threadId, parentMessageId, threadObj, seenReplyIds);
        if (threadObj.replies.length > 0 && !parentMsg.threads.some(t => t.id === threadId)) {
          parentMsg.threads.push(threadObj);
        }
      });
    } else if (threadChips.length > 0) {
      threadChips.forEach((chip, idx) => {
        const label = chip.getAttribute('aria-label') || chip.textContent || '';
        const m = label.match(/(\d+)\s+repl/i);
        const count = m ? parseInt(m[1], 10) : (parseInt(chip.getAttribute('data-reply-count'), 10) || 0);
        if (count === 0) return;

        const threadId = chip.getAttribute('data-thread-id') || `thread_${parentMessageId}_${idx + 1}`;
        let threadObj = parentMsg.threads.find(t => t.id === threadId);
        if (!threadObj) {
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

    runningSender = '';
    runningAvatar = '';

    const scrollContainer = findFeedScrollContainer();
    const messageAccumulator = new Map();
    const seenThreadIds = new Set();
    const seenReplyIds = new Set();

    // 1. Initial DOM sweep
    harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds, scrollContainer);

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
    harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds, scrollContainer);

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
    let prevMsg = null;
    const renderedFeed = [];

    messages.forEach((msg, idx) => {
      const dateStr = formatDateDivider(msg.timestamp);
      let isNewDay = false;
      if (dateStr && dateStr !== lastDateStr) {
        renderedFeed.push(`
          <div class="gc-date-divider-row">
            <span class="gc-date-divider-text">${escapeHtml(dateStr)}</span>
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

      renderedFeed.push(renderParentMessageHtml(msg, idx + 1, isContinuation));
      prevMsg = msg;
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(convoName)} - Google Chat</title>
<style>
/* ─── Exact Native Google Chat Styling & Speech Bubbles ─── */
:root {
  --font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
  --bg-page: #ffffff;
  --bg-header: #ffffff;
  --bg-incoming-bubble: #f0f4f9;
  --bg-outgoing-bubble: #1f1f1f;
  --text-incoming-bubble: #1f1f1f;
  --text-outgoing-bubble: #ffffff;
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
  --radius-bubble: 18px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font-family);
  background-color: var(--bg-page);
  color: var(--text-primary);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* Authentic Google Chat Top Bar (Clean, Minimal, No Clutter) */
.gc-app-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border-color);
  padding: 12px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: var(--shadow-sm);
}

.gc-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
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
  max-width: 920px;
  width: 100%;
  margin: 0 auto;
  padding: 24px 20px 80px;
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
.gc-date-divider-row {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 28px 0 16px;
  user-select: none;
}

.gc-date-divider-text {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

/* Message Rows */
.gc-msg-row {
  margin-bottom: 12px;
}

/* Incoming Message Row (Left-aligned) */
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

.gc-avatar-circle img {
  width: 100%;
  height: 100%;
  object-fit: cover;
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

.gc-sender-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.gc-timestamp {
  font-size: 12px;
  color: var(--text-muted);
}

.gc-edited-tag {
  font-size: 11px;
  color: var(--text-muted);
}

/* Incoming Speech Bubble (Light Grey/Blue) */
.gc-bubble-incoming {
  background-color: var(--bg-incoming-bubble);
  color: var(--text-incoming-bubble);
  border-radius: var(--radius-bubble);
  padding: 8px 16px;
  font-size: 14px;
  line-height: 1.5;
  max-width: 72%;
  word-break: break-word;
  white-space: pre-wrap;
  display: inline-block;
  box-shadow: 0 1px 1px rgba(0, 0, 0, 0.04);
}

/* Outgoing Message Row (Right-aligned) */
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

/* Outgoing Speech Bubble (Dark Charcoal / Black) */
.gc-bubble-outgoing {
  background-color: var(--bg-outgoing-bubble);
  color: var(--text-outgoing-bubble);
  border-radius: var(--radius-bubble);
  padding: 8px 16px;
  font-size: 14px;
  line-height: 1.5;
  max-width: 72%;
  word-break: break-word;
  white-space: pre-wrap;
  display: inline-block;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

.gc-bubble-incoming a,
.gc-bubble-outgoing a {
  color: #8ab4f8;
  text-decoration: underline;
}

.gc-bubble-incoming a {
  color: var(--google-blue);
}

/* Reactions */
.gc-reactions-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
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
  margin-top: 6px;
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
  width: 100%;
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
  <div class="gc-history-banner">
    <div class="gc-history-title">
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
      </svg>
      <span>HISTORY IS ON</span>
    </div>
    <div class="gc-history-sub">Messages sent with history on are saved</div>
  </div>
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

  function renderParentMessageHtml(msg, index, isContinuation = false) {
    const senderName = msg.sender?.name || 'Participant';
    const isSelf = senderName.toLowerCase() === 'you' || Boolean(msg.isSelf);
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

    if (isSelf) {
      // Outgoing message (Right-aligned speech bubble, dark charcoal, white text)
      return `
      <article class="gc-msg-row gc-msg-outgoing parent-message-card" id="msg-${escapeHtml(msg.id)}" data-sender="You">
        ${!isContinuation ? `
        <div class="gc-msg-outgoing-meta">
          <span class="gc-timestamp">${escapeHtml(timeStr)}</span>
        </div>` : ''}
        <div class="gc-bubble-outgoing">${escapeHtml(textContent)}</div>
        ${attachmentsHtml}
        ${reactionsHtml}
        ${threadsSectionHtml}
      </article>`;
    }

    // Incoming message (Left-aligned speech bubble, light grey/blue, avatar on left)
    return `
    <article class="gc-msg-row gc-msg-incoming parent-message-card" id="msg-${escapeHtml(msg.id)}" data-sender="${escapeHtml(senderName)}">
      <div class="gc-avatar-col">
        ${!isContinuation ? `
        <div class="gc-avatar-circle" style="background-color: ${avatarColor};">
          ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(senderName)}" onerror="this.style.display='none';this.parentElement.textContent='${escapeHtml(initial)}'" />` : initial}
        </div>` : `<div class="gc-avatar-spacer"></div>`}
      </div>
      <div class="gc-incoming-content">
        ${!isContinuation ? `
        <div class="gc-msg-incoming-meta">
          <span class="gc-sender-name">${escapeHtml(senderName)}</span>
          <span class="gc-timestamp">${escapeHtml(timeStr)}</span>
          ${msg.edited ? '<span class="gc-edited-tag">(edited)</span>' : ''}
        </div>` : ''}
        <div class="gc-bubble-incoming">${escapeHtml(textContent)}</div>
        ${attachmentsHtml}
        ${reactionsHtml}
        ${threadsSectionHtml}
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
