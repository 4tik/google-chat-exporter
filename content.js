/**
 * @file content.js
 * @description Google Chat Exporter Content Engine v2.5
 * Strictly adheres to user specifications:
 *  1. Always exports the WHOLE conversation history (scrolling & accumulating virtualized messages).
 *  2. Standalone HTML format.
 *  3. Embeds all media & screenshots offline as full-resolution Base64 data URLs.
 *  4. Looks and feels EXACTLY like the native Google Chat web application.
 *  5. Critical scenario: strictly preserves independent threads under parent messages without merging.
 */

(function () {
  'use strict';

  if (window.__GCE_CONTENT_ENGINE_V2__) return;
  window.__GCE_CONTENT_ENGINE_V2__ = true;

  const LOG = (...args) => console.log('[Google Chat Exporter]', ...args);
  const WARN = (...args) => console.warn('[Google Chat Exporter]', ...args);

  let isCancelRequested = false;

  // ─── Deterministic Avatar Initial Colors (Google Chat Signature) ───────────

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

  // ─── Chat Detection ────────────────────────────────────────────────────────

  function isGoogleChat() {
    const href = location.href || '';
    return href.includes('chat.google.com') || (href.includes('mail.google.com') && href.includes('chat'));
  }

  function detectConversationName() {
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

  function detectConversationType() {
    const href = location.href || '';
    if (href.includes('/room/') || href.includes('/space/') || href.includes('/r/')) return 'SPACE';
    if (href.includes('/dm/') || href.includes('/direct/')) return 'DIRECT_MESSAGE';
    if (document.querySelector('[data-space-id], [aria-label*="Space"]')) return 'SPACE';
    return 'SPACE';
  }

  function scanLiveMetrics() {
    const name = detectConversationName();
    const type = detectConversationType();

    const msgEls = document.querySelectorAll('[data-message-id], [role="listitem"][data-id], .oUJrbe');
    const msgIds = new Set();
    msgEls.forEach(el => {
      const id = el.getAttribute('data-message-id') || el.getAttribute('data-id');
      if (id) msgIds.add(id);
    });

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
      totalMessages: Math.max(msgIds.size, msgEls.length),
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
      respond(scanLiveMetrics());
      return true;
    }

    if (req.action === 'DISCOVER_CONVERSATIONS') {
      try {
        respond({ conversations: discoverSidebarConversations() });
      } catch (err) {
        respond({ conversations: [], error: err.message });
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

  // ─── Core Extraction Pipeline: ALWAYS WHOLE CHAT + MEDIA + GOOGLE CHAT REPLICA HTML ───

  async function executeFullChatExport() {
    sendProgress('Connecting to conversation stream...', 5);

    const convoName = detectConversationName();
    const convoType = detectConversationType();
    const scrollContainer = findFeedScrollContainer();

    if (!scrollContainer) {
      throw new Error('Could not find active chat stream. Please ensure Google Chat is open.');
    }

    // Accumulator for virtualized DOM messages
    const messageAccumulator = new Map();
    const seenThreadIds = new Set();
    const seenReplyIds = new Set();

    // 1. Initial harvest of visible DOM
    harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds);

    // 2. ALWAYS PAGINATE TO THE ABSOLUTE TOP (WHOLE CHAT)
    sendProgress('Paginating full history to the beginning of chat...', 10);
    await paginateToAbsoluteBeginning(scrollContainer, messageAccumulator, seenThreadIds, seenReplyIds);

    if (isCancelRequested) throw new Error('AbortError');

    // 3. Expand thread reply drawers and sweep back down
    sendProgress('Discovering and expanding independent threads...', 45);
    await expandThreadsInDOM();
    await sweepDownToBottom(scrollContainer, messageAccumulator, seenThreadIds, seenReplyIds);

    // Final harvest
    harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds);

    const allMessages = Array.from(messageAccumulator.values());
    allMessages.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return new Date(a.timestamp) - new Date(b.timestamp);
    });

    LOG(`Total unique parent messages accumulated: ${allMessages.length}`);

    // Count statistics
    const totalThreads = allMessages.reduce((acc, m) => acc + (m.threads ? m.threads.length : 0), 0);
    const totalReplies = allMessages.reduce((acc, m) => {
      return acc + (m.threads || []).reduce((tAcc, t) => tAcc + (t.replies ? t.replies.length : 0), 0);
    }, 0);
    const totalAttachments = allMessages.reduce((acc, m) => {
      const pAtt = m.attachments ? m.attachments.length : 0;
      const rAtt = (m.threads || []).reduce((tAcc, t) => {
        return tAcc + (t.replies || []).reduce((ra, r) => ra + (r.attachments ? r.attachments.length : 0), 0);
      }, 0);
      return acc + pAtt + rAtt;
    }, 0);

    // 4. ALWAYS DOWNLOAD MEDIA & EMBED OFFLINE AS BASE64 DATA URLS
    sendProgress('Downloading and embedding full-resolution media offline...', 65, {
      messages: allMessages.length,
      threads: totalThreads,
      replies: totalReplies,
      attachments: totalAttachments
    });

    await hydrateAllMediaAndAvatars(allMessages);

    if (isCancelRequested) throw new Error('AbortError');

    // 5. GENERATE STANDALONE NATIVE GOOGLE CHAT REPLICA HTML
    sendProgress('Generating native Google Chat replica HTML...', 90);

    const metadata = {
      name: convoName,
      type: convoType,
      exportedAt: new Date().toISOString()
    };

    const htmlContent = generateGoogleChatReplicaHtml(allMessages, metadata);

    // 6. DOWNLOAD COMPLETED STANDALONE HTML FILE
    const safeTitle = convoName.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const timestampStr = new Date().toISOString().slice(0, 10);
    const filename = `GoogleChat_${safeTitle}_${timestampStr}.html`;

    downloadBlob(new Blob([htmlContent], { type: 'text/html;charset=utf-8' }), filename);

    sendProgress('Export completed', 100, {
      messages: allMessages.length,
      threads: totalThreads,
      replies: totalReplies,
      attachments: totalAttachments
    });

    return {
      filename,
      totalMessages: allMessages.length,
      totalThreads: totalThreads,
      totalReplies: totalReplies,
      totalAttachments: totalAttachments
    };
  }

  // ─── Paginate to the Absolute Beginning (Whole Chat History) ───────────────

  async function paginateToAbsoluteBeginning(scrollContainer, messageAccumulator, seenThreadIds, seenReplyIds) {
    let iterations = 0;
    const maxIterations = 500; // supports very long conversations
    let consecutiveTopStalls = 0;
    let lastAccumulatedCount = messageAccumulator.size;

    while (iterations < maxIterations) {
      if (isCancelRequested) break;
      iterations++;

      // Scroll to the very top
      scrollContainer.scrollTop = 0;

      // Small delay for virtualized DOM nodes to mount and network responses to complete
      await sleep(320);

      // Harvest newly mounted elements immediately before they leave the DOM
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
        // If scroll is at 0 and no new messages loaded
        if (scrollContainer.scrollTop === 0) {
          consecutiveTopStalls++;
          // Wiggle scroll slightly to trigger listener if needed
          scrollContainer.scrollTop = 60;
          await sleep(150);
          scrollContainer.scrollTop = 0;

          if (consecutiveTopStalls >= 5) {
            LOG(`Reached the absolute top of the conversation after ${iterations} iterations.`);
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

      try {
        await navigateToConversation(conv);
        await sleep(1800);

        const feed = locateChatFeedContainer();
        const scroller = feed ? findActiveScrollContainer(feed) : null;
        let msgs = [];
        if (autoScroll && scroller) {
          msgs = await autoScrollAndHarvestMessages(feed, scroller, maxScrollAttempts);
        } else {
          const extraction = extractAllMessagesFromFeed(feed || document.body);
          msgs = extraction.messages;
        }
        checkCancel();
        totalMessagesProcessed += msgs.length;

        let convImagesCount = 0;
        if (downloadImages) {
          const tasks = [];
          msgs.forEach((m, mIdx) => {
            (m.detectedImages || []).forEach(img => {
              tasks.push({ url: img.url, element: img.element, msgIndex: mIdx });
            });
          });

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
      if (c && (c.scrollHeight > c.clientHeight || c.offsetHeight > 350)) return c;
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

  function harvestCurrentDOM(messageAccumulator, seenThreadIds, seenReplyIds) {
    const candidates = Array.from(document.querySelectorAll(
      '[data-topic-id], [data-message-id], [role="listitem"]'
    )).filter(el => !el.closest('[data-is-reply="true"], [jsname="oLhsH"], .thread-replies-list'));

    candidates.forEach((row, idx) => {
      const msgId = row.getAttribute('data-message-id') || row.getAttribute('data-id') || `msg_${idx}_${Date.now()}`;

      // If already accumulated, update threads/replies if newly rendered
      let msg = messageAccumulator.get(msgId);
      if (!msg) {
        const sender = extractSender(row);
        const text = extractBodyText(row, sender.name);
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

      // Discover and extract independent threads under this parent message
      extractIndependentThreads(row, msgId, msg, seenThreadIds, seenReplyIds);
    });
  }

  /**
   * CRITICAL FUNCTION: Extracts independent threads without merging!
   */
  function extractIndependentThreads(parentRow, parentMessageId, parentMsg, seenThreadIds, seenReplyIds) {
    // 1. Check for separate thread containers
    const threadContainers = parentRow.querySelectorAll(
      '[data-thread-container], [role="region"][aria-label*="Thread"], [data-topic-id]'
    );

    // 2. Check for inline thread chips (e.g. "5 replies", "2 replies")
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

    replyRows.forEach((r, idx) => {
      const rId = r.getAttribute('data-message-id') || `reply_${threadId}_${idx + 1}`;
      if (seenReplyIds.has(rId)) return;
      seenReplyIds.add(rId);

      const rSender = extractSender(r);
      const rText = extractBodyText(r, rSender.name);
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

  function extractSender(el) {
    const avatarEl = el.querySelector('img[alt]:not([src*="emoji"]), [data-hovercard-id] img');
    let name = avatarEl ? avatarEl.getAttribute('alt') : '';

    if (!name) {
      const nameEl = el.querySelector('[data-sender-id], [data-hovercard-id], h3, b, .VfPpkd-rymPhb, .sender-name');
      if (nameEl) name = nameEl.textContent.trim();
    }

    const avatarUrl = avatarEl ? avatarEl.src : null;
    return {
      messages: parsedMessages,
      discovered: rows.length,
      skipped: skippedCount
    };
  }

  // ─── Field Extractors ─────────────────────────────────────────────────────

    const clone = bodyEl.cloneNode(true);
    clone.querySelectorAll('button, [role="button"], [aria-label*="repl" i], [aria-label*="reaction" i]').forEach(n => n.remove());

    // 1. Inspect avatar element aria-labels (Google accessibility standard for photo & initial avatars)
    const avatarEls = row.querySelectorAll('[aria-label*="profile" i], [aria-label*="Profile photo" i], [data-hovercard-id]');
    for (const el of avatarEls) {
      if (isInsideThreadFooter(el)) continue;
      const aria = (el.getAttribute('aria-label') || '').trim();
      const m = aria.match(/profile photo of\s+([^,.]+)/i) || aria.match(/view\s+([^'s]+)'s\s+profile/i);
      if (m && isValidSenderString(cleanSenderString(m[1]))) {
        return cleanSenderString(m[1]);
      }
      if (aria && isValidSenderString(cleanSenderString(aria))) {
        return cleanSenderString(aria);
      }
    }

    // 2. Direct sender header elements
    const senderSelectors = [
      '[data-hovercard-id]',
      '[data-name]',
      'div[role="heading"]',
      'span[role="heading"]',
      'span.Wq4GMc',
      'div.Wq4GMc',
      'span.FvY9Uc',
      'div.FvY9Uc',
      'span.Z4Eb9b',
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

    // 3. Inspect avatar image attributes in header (excluding thread replies bar)
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

    // 4. Header container text (extract name by stripping timestamp & "Edited")
    const headerEl = row.querySelector('header, div.Wq4GMc, div.FvY9Uc, div[role="heading"]');
    if (headerEl && !isInsideThreadFooter(headerEl)) {
      const text = cleanSenderString(headerEl.textContent.trim());
      if (isValidSenderString(text)) {
        return text;
      }
    }

    // 5. Cluster / topic sender attribute
    const cluster = row.closest('[data-sender-name]');
    if (cluster && isValidSenderString(cluster.getAttribute('data-sender-name'))) {
      return cluster.getAttribute('data-sender-name').trim();
    }

    return fallbackSender || '';
  }

  function cleanSenderString(str) {
    if (!str) return '';
    return str
      .replace(/[•·]\s*Edited.*/i, '')
      .replace(/\b(Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)?[,\s]*\d{1,2}:\d{2}\s*([AP]M)?.*$/i, '')
      .trim();
  }

  function isValidSenderString(text) {
    if (!text || text.length < 2 || text.length > 55) return false;
    if (text.includes('\n') || text.includes('http://') || text.includes('https://')) return false;
    // Exclude time strings
    if (/^\d{1,2}:\d{2}/.test(text)) return false;
    if (/\b(AM|PM)\b/i.test(text) && /\d/.test(text)) return false;
    // Exclude UI action labels & system tokens
    const rejectWords = ['replies', 'reply', 'unread', 'reaction', 'quote', 'forward', 'edit', 'delete', 'options', 'history is on', 'add reaction'];
    if (rejectWords.some(w => text.toLowerCase().includes(w))) return false;
    return true;
  }

  /**
   * Extracts user avatar photo URL.
   */
  function extractAvatarUrl(row, fallbackAvatar) {
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
    return fallbackAvatar || '';
  }

  /**
   * Extracts message timestamp. Handles non-breaking spaces (\u00A0) and formats cleanly.
   */
  function extractMessageTimestamp(row) {
    // 1. data-timestamp attribute (epoch ms)
    const dataTs = row.getAttribute('data-timestamp') || row.querySelector('[data-timestamp]')?.getAttribute('data-timestamp');
    if (dataTs) {
      const num = Number(dataTs);
      if (!isNaN(num) && num > 1000000000) {
        return new Date(num > 1e12 ? num : num * 1000)
          .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
        filename: img.getAttribute('alt') || 'Screenshot.png',
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
          filename: link.textContent.trim() || 'Shared Drive Resource',
          url: href,
          previewUrl: null,
          isAccessible: true
        });
      }
    });

    return attachments;
  }

  // ─── High-Resolution Media & Avatar Base64 Embedding ──────────────────────

  async function hydrateAllMediaAndAvatars(messages) {
    const mediaTasks = [];

    // Collect all media and avatars
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
            url: att.url.replace(/=w\d+.*$/, '=s0') // Upgrade to full resolution!
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
                url: att.url.replace(/=w\d+.*$/, '=s0') // Upgrade to full resolution!
              });
            }
          }
        }
      }
    }

    LOG(`Hydrating ${mediaTasks.length} media and avatar resources to offline Base64 data URLs...`);

    // Process in batches of 4 concurrently
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
        } catch (_) {
          // Keep original link as fallback if fetch fails
        }
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

  // ─── Pixel-Perfect Google Chat Replica Standalone HTML Generator ──────────

  function generateGoogleChatReplicaHtml(messages, metadata) {
    const convoName = metadata.name || 'Google Chat Conversation';
    const convoType = metadata.type || 'SPACE';
    const exportedAt = metadata.exportedAt || new Date().toISOString();
    const formattedExportDate = new Date(exportedAt).toLocaleString();

    let totalThreads = 0;
    let totalReplies = 0;
    let totalAttachments = 0;
    const senders = new Set();

    messages.forEach(m => {
      if (m.sender?.name) senders.add(m.sender.name);
      if (m.attachments) totalAttachments += m.attachments.length;
      (m.threads || []).forEach(t => {
        totalThreads++;
        (t.replies || []).forEach(r => {
          totalReplies++;
          if (r.sender?.name) senders.add(r.sender.name);
          if (r.attachments) totalAttachments += r.attachments.length;
        });
      });
    });

    const senderOptions = Array.from(senders).sort()
      .map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
      .join('\n');

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
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(convoName)} - Google Chat</title>
<style>
/* ─── Google Chat Official Design System & Typography ─── */
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

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--font-family);
  background-color: var(--bg-page);
  color: var(--text-primary);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* Header Bar - Google Chat Style */
.gc-app-header {
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

.gc-header-top-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.gc-header-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.gc-logo-icon {
  width: 40px;
  height: 40px;
  background: #00897b;
  color: #fff;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 137, 123, 0.3);
}

.gc-logo-icon svg { width: 22px; height: 22px; }

.gc-title-group h1 {
  font-size: 19px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.2;
}

.gc-meta-group {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.gc-badge-pill {
  background: var(--chip-bg);
  color: var(--chip-text);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}

.gc-export-stats-text {
  font-size: 12px;
  color: var(--text-muted);
}

.gc-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gc-btn {
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

.gc-btn:hover { filter: brightness(0.95); }

/* Search & Filter Toolbar */
.gc-toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.gc-search-box-wrap {
  position: relative;
  flex: 1;
  max-width: 480px;
  min-width: 240px;
}

.gc-search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}

.gc-search-input {
  width: 100%;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 8px 14px 8px 36px;
  border-radius: var(--radius-pill);
  font-size: 13.5px;
  outline: none;
}

.gc-search-input:focus { border-color: var(--google-blue); }

.gc-toolbar-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gc-sender-dropdown {
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
.gc-main-feed-container {
  max-width: 1020px;
  width: 100%;
  margin: 0 auto;
  padding: 24px 16px;
}

.gc-feed-card {
  background: var(--bg-chat-pane);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
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
  left: 32px;
  right: 32px;
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
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

/* Parent Message Card */
.gc-parent-message {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-subtle);
  transition: background-color 0.15s ease;
}

.gc-parent-message:hover {
  background-color: var(--bg-hover);
}

.gc-message-layout {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.gc-avatar-col { flex-shrink: 0; }

.gc-avatar-circle {
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
  margin-bottom: 4px;
}

.gc-sender-name {
  font-size: 14.5px;
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
  font-size: 14.5px;
  color: var(--text-primary);
  line-height: 1.55;
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
  font-size: 12.5px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: default;
}

.gc-reaction-count {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 11.5px;
}

/* Attachments */
.gc-attachments-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
}

.gc-screenshot-card {
  max-width: 440px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  overflow: hidden;
  background: #000;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.gc-screenshot-card:hover { transform: scale(1.01); }

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
  border-radius: 10px;
  padding: 10px 14px;
  text-decoration: none;
  color: var(--text-primary);
  max-width: 380px;
}

.gc-doc-file-icon { font-size: 22px; }
.gc-doc-file-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Independent Threads Hierarchy */
.gc-threads-container {
  margin-top: 14px;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gc-thread-card {
  background: var(--bg-thread-card);
  border: 1px solid var(--border-color);
  border-left: 4px solid var(--border-accent);
  border-radius: var(--radius-thread);
  overflow: hidden;
}

.gc-thread-header {
  padding: 9px 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(0, 137, 123, 0.05);
  cursor: pointer;
  user-select: none;
}

.gc-thread-header:hover {
  background: rgba(0, 137, 123, 0.09);
}

.gc-thread-title-area {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gc-thread-badge {
  background: #00897b20;
  color: var(--google-green);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 6px;
}

.gc-thread-title-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.gc-thread-meta-area {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gc-reply-count-badge {
  font-size: 11.5px;
  font-weight: 600;
  background: var(--bg-reply);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}

.gc-thread-chevron {
  font-size: 11px;
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
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gc-reply-row {
  background: var(--bg-reply);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px 14px;
  display: flex;
  gap: 12px;
}

.gc-reply-avatar {
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

/* Print Friendly */
@media print {
  body { background: #fff !important; color: #000 !important; }
  .gc-app-header, .gc-toolbar-row, .gc-btn { display: none !important; }
  .gc-feed-card, .gc-parent-message, .gc-thread-card, .gc-reply-row {
    border: 1px solid #ccc !important;
    box-shadow: none !important;
    page-break-inside: avoid;
  }
  .gc-thread-card.collapsed .gc-replies-list { display: flex !important; }
}
</style>
</head>
<body>

<div class="gc-app-shell">
  <!-- Header Bar -->
  <header class="gc-app-header">
    <div class="gc-header-top-row">
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
      <div class="gc-header-actions">
        <button class="gc-btn" id="theme-toggle">🌙 Theme</button>
        <button class="gc-btn" onclick="window.print()">🖨️ Print</button>
      </div>
    </div>

    <!-- Search & Filter Controls -->
    <div class="gc-toolbar-row">
      <div class="gc-search-box-wrap">
        <span class="gc-search-icon">🔍</span>
        <input type="text" id="search-input" class="gc-search-input" placeholder="Search parent messages and replies..." />
      </div>
      <div class="gc-toolbar-controls">
        <select id="sender-filter" class="gc-sender-dropdown">
          <option value="">All Senders</option>
          ${senderOptions}
        </select>
        <button class="gc-btn" id="expand-all-btn">Expand All Threads</button>
        <button class="gc-btn" id="collapse-all-btn">Collapse All</button>
      </div>
    </div>
  </header>

  <!-- Feed -->
  <main class="gc-main-feed-container">
    <div class="gc-feed-card" id="chat-pane">
      ${renderedFeed.join('\n') || '<div style="padding:48px;text-align:center;color:var(--text-muted);">No messages found.</div>'}
    </div>
  </main>
</div>

<!-- Lightbox Modal -->
<div class="gc-lightbox-modal" id="lightbox" onclick="this.classList.remove('active')">
  <img class="gc-lightbox-img" id="lightbox-img" src="" alt="Enlarged screenshot" />
</div>

<script>
// Standalone Google Chat Replica Interaction Controller
(function() {
  const themeToggle = document.getElementById('theme-toggle');
  const searchInput = document.getElementById('search-input');
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

  // Individual Thread Card Toggle
  document.querySelectorAll('.gc-thread-header').forEach(header => {
    header.addEventListener('click', () => {
      const card = header.closest('.gc-thread-card');
      card.classList.toggle('collapsed');
    });
  });

  // Expand / Collapse All
  expandAllBtn.addEventListener('click', () => {
    document.querySelectorAll('.gc-thread-card').forEach(c => c.classList.remove('collapsed'));
  });

  collapseAllBtn.addEventListener('click', () => {
    document.querySelectorAll('.gc-thread-card').forEach(c => c.classList.add('collapsed'));
  });

  // Search & Sender Filter
  function applyFilter() {
    const query = (searchInput.value || '').toLowerCase().trim();
    const sender = (senderFilter.value || '').toLowerCase().trim();

    document.querySelectorAll('.gc-parent-message').forEach(card => {
      const parentSender = (card.getAttribute('data-sender') || '').toLowerCase();
      const parentText = (card.querySelector('.gc-body-text')?.textContent || '').toLowerCase();

      let replyMatch = false;
      card.querySelectorAll('.gc-reply-row').forEach(reply => {
        const replySender = (reply.getAttribute('data-sender') || '').toLowerCase();
        const replyText = (reply.querySelector('.gc-body-text')?.textContent || '').toLowerCase();

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

      if (replyMatch && (query || sender)) {
        card.querySelectorAll('.gc-thread-card').forEach(tc => tc.classList.remove('collapsed'));
      }
    });
  }

  searchInput.addEventListener('input', applyFilter);
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

  function renderParentMessageHtml(msg, index) {
    const senderName = msg.sender?.name || 'Google Chat User';
    const avatarUrl = msg.sender?.avatarUrl;
    const initial = (senderName[0] || 'U').toUpperCase();
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
    <article class="gc-parent-message" id="msg-${escapeHtml(msg.id)}" data-sender="${escapeHtml(senderName)}">
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
    const threadTitle = thread.title || `Thread ${threadNumber}`;
    const replies = thread.replies || [];
    const replyCount = thread.replyCount !== undefined ? thread.replyCount : replies.length;

    const repliesHtml = replies.map(r => renderReplyHtml(r)).join('\n');

    return `
    <div class="gc-thread-card" id="${escapeHtml(threadId)}">
      <div class="gc-thread-header" title="Click to expand/collapse thread">
        <div class="gc-thread-title-area">
          <span class="gc-thread-badge">Thread ${threadNumber}</span>
          <span class="gc-thread-title-text">${escapeHtml(threadTitle)}</span>
        </div>
        <div class="gc-thread-meta-area">
          <span class="gc-reply-count-badge">${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
          <span class="gc-thread-chevron">▼</span>
        </div>
      </div>
      <div class="gc-replies-list">
        ${repliesHtml || '<div style="color:var(--text-muted);font-size:12px;">No replies found.</div>'}
      </div>
    </div>`;
  }

  function renderReplyHtml(reply) {
    const senderName = reply.sender?.name || 'Google Chat User';
    const avatarUrl = reply.sender?.avatarUrl;
    const initial = (senderName[0] || 'U').toUpperCase();
    const avatarColor = getAvatarColor(senderName);
    const timeStr = formatTime(reply.timestamp);
    const textContent = reply.text || '';
    const reactionsHtml = renderReactionsHtml(reply.reactions);
    const attachmentsHtml = renderAttachmentsHtml(reply.attachments);

    return `
    <div class="gc-reply-row" id="reply-${escapeHtml(reply.id)}" data-sender="${escapeHtml(senderName)}">
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

  LOG('Google Chat Exporter Engine v2.5 loaded.');
})();
