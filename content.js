/**
 * ChatVault — Google Chat Extraction & Export Engine (content.js v2.1)
 *
 * Designed to accurately extract:
 * 1. Direct Messages, Group Chats, and Spaces (threaded topic cards & in-line replies).
 * 2. Real sender names (from avatar accessibility metadata and headers), NEVER generic fallbacks.
 * 3. Real timestamps (handling ISO, relative, AM/PM, non-breaking spaces).
 * 4. Real message text bodies (preserving paragraphs, mentions, code blocks, bold text).
 *    Strictly prevents sender names from being extracted as message text.
 * 5. Full-resolution screenshots & media attachments (upgraded to =s0, Base64 embedded).
 * 6. Quoted replies, in-line thread indicators, and shared files.
 * 7. Standalone HTML replica matching native Google Chat UI, plus vector PDF & ZIP formats.
 */

(function () {
  'use strict';

  if (window.__CHATVAULT_ENGINE_V2__) return;
  window.__CHATVAULT_ENGINE_V2__ = true;

  const LOG = (...args) => console.log('[ChatVault]', ...args);
  const WARN = (...args) => console.warn('[ChatVault]', ...args);

  let isCancelRequested = false;

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
      const title = detectConversationTitle();
      const feed = locateChatFeedContainer();
      const count = feed ? discoverMessageContainers(feed).length : 0;
      respond({ title, visibleCount: count });
      return true;
    }

    if (req.action === 'DIAGNOSE') {
      respond(generateSafeDiagnostics());
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
      executeExportPipeline(req.options || {})
        .then(result => respond({ success: true, result }))
        .catch(err => {
          if (err.name === 'AbortError' || isCancelRequested) {
            sendPopupMessage('EXPORT_CANCELLED', { message: 'Export cancelled by user.' });
            respond({ cancelled: true });
          } else {
            WARN('Export failed:', err);
            sendPopupMessage('EXPORT_ERROR', { error: err.message || 'Export failed.' });
            respond({ error: err.message || 'Export failed.' });
          }
        });
      return true;
    }
  });

  // ─── Safe Diagnostics (No private content logged) ──────────────────────────

  function generateSafeDiagnostics() {
    const feed = locateChatFeedContainer();
    const rows = feed ? discoverMessageContainers(feed) : [];
    const scroller = feed ? findActiveScrollContainer(feed) : null;
    return {
      url: location.href,
      documentTitle: document.title,
      feedDetected: Boolean(feed),
      feedTag: feed ? feed.tagName : null,
      feedRole: feed ? feed.getAttribute('role') : null,
      scrollDetected: Boolean(scroller),
      scrollerTag: scroller ? scroller.tagName : null,
      discoveredMessageRows: rows.length,
      topicsInDOM: document.querySelectorAll('[data-topic-id]').length,
      messagesInDOM: document.querySelectorAll('[data-message-id]').length,
      sampleFirstRowTags: rows[0] ? Array.from(rows[0].children).map(c => c.tagName) : null
    };
  }

  // ─── Main Pipeline Coordinator ────────────────────────────────────────────

  async function executeExportPipeline(options) {
    const {
      scope = 'single',
      format = 'html',
      batchIds = []
    } = options;

    if (isCancelRequested) abort();

    if ((format === 'both' || scope === 'batch') && typeof JSZip === 'undefined') {
      throw new Error('JSZip is missing. Ensure jszip.min.js is included.');
    }

    if ((format === 'pdf' || format === 'both') &&
        (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF)) {
      throw new Error('jsPDF is missing. Ensure jspdf.umd.min.js is included.');
    }

    if (scope === 'batch' && batchIds.length > 0) {
      return executeBatchExport(options);
    }
    return executeSingleExport(options);
  }

  // ─── Single Conversation Export ───────────────────────────────────────────

  async function executeSingleExport(options) {
    const {
      format = 'html',
      autoScroll = false,
      downloadImages = true,
      maxScrollAttempts = 20
    } = options;

    reportProgress({
      phase: 'INIT',
      message: 'Locating conversation stream...',
      percent: 5,
      discovered: 0,
      processed: 0,
      skipped: 0,
      failed: 0
    });

    const conversationTitle = detectConversationTitle();
    const cleanTitle = sanitizeFilename(conversationTitle);
    const feedContainer = locateChatFeedContainer();

    if (!feedContainer) {
      throw new Error('Could not find active chat stream. Make sure a conversation is open.');
    }

    let messages = [];
    let discovered = 0;
    let skipped = 0;

    const scrollContainer = findActiveScrollContainer(feedContainer);
    if (autoScroll && scrollContainer) {
      messages = await autoScrollAndHarvestMessages(feedContainer, scrollContainer, maxScrollAttempts);
      discovered = messages.length;
    } else {
      reportProgress({
        phase: 'SCANNING',
        message: 'Extracting message bodies & attachments from view...',
        percent: 40,
        discovered: 0,
        processed: 0,
        skipped: 0,
        failed: 0
      });
      const extractionResult = extractAllMessagesFromFeed(feedContainer);
      messages = extractionResult.messages;
      discovered = extractionResult.discovered;
      skipped = extractionResult.skipped;
    }
    checkCancel();

    if (!messages || messages.length === 0) {
      throw new Error('No messages found in active view. Scroll to the conversation and try again.');
    }

    LOG(`Extracted ${messages.length} messages (discovered=${discovered}, skipped=${skipped})`);

    reportProgress({
      phase: 'SCANNING',
      message: `Parsed ${messages.length} messages.`,
      percent: 55,
      discovered,
      processed: messages.length,
      skipped,
      failed: 0
    });

    // Process media attachments
    let imagesSuccess = 0;
    let imagesFailed = 0;

    if (downloadImages) {
      const tasks = [];
      messages.forEach((msg, mIdx) => {
        (msg.detectedImages || []).forEach((item, imgIdx) => {
          tasks.push({
            url: item.url,
            element: item.element,
            msgIndex: mIdx,
            imgId: `img_${tasks.length + 1}`
          });
        });
      });

      if (tasks.length > 0) {
        reportProgress({
          phase: 'MEDIA',
          message: `Fetching ${tasks.length} media attachments...`,
          percent: 60,
          discovered,
          processed: messages.length,
          skipped,
          failed: 0
        });

        const BATCH = 4;
        for (let i = 0; i < tasks.length; i += BATCH) {
          checkCancel();
          const chunk = tasks.slice(i, i + BATCH);

          await Promise.all(chunk.map(async task => {
            try {
              const { blob, extension } = await fetchImageBlob(task);
              const base64 = await blobToBase64(blob);
              imagesSuccess++;

              const target = messages[task.msgIndex];
              target.images.push(base64 || task.url);
              target.imageBlobs = target.imageBlobs || [];
              target.imageBlobs.push({ blob, fileName: `${task.imgId}.${extension}` });
            } catch (err) {
              imagesFailed++;
              messages[task.msgIndex].images.push(task.url);
            }
          }));

          reportProgress({
            phase: 'MEDIA',
            message: `Processed images (${imagesSuccess}/${tasks.length})...`,
            percent: 60 + Math.round(((i + BATCH) / tasks.length) * 25),
            discovered,
            processed: messages.length,
            skipped,
            failed: imagesFailed
          });
        }
      }
    }
    checkCancel();

    const dateStr = getIsoDateString();
    const formattedDate = getPrettyDateString();

    // ─── Format 1: Standalone HTML ──────────────────────────────────────────
    if (format === 'html') {
      reportProgress({
        phase: 'PACKAGING',
        message: 'Rendering native Google Chat HTML archive...',
        percent: 92,
        discovered,
        processed: messages.length,
        skipped,
        failed: imagesFailed
      });

      const html = generateNativeGoogleChatHTML({
        title: conversationTitle,
        exportDate: formattedDate,
        messages,
        totalImages: imagesSuccess
      });

      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const filename = `${cleanTitle}_${dateStr}.html`;
      triggerFileDownload(blob, filename);

      reportSuccess({
        format: 'html',
        filename,
        convoCount: 1,
        messageCount: messages.length,
        imageCount: imagesSuccess,
        skippedCount: skipped,
        failedCount: imagesFailed
      });

      return { filename, messageCount: messages.length };
    }

    // ─── Format 2: Vector PDF ───────────────────────────────────────────────
    if (format === 'pdf') {
      reportProgress({
        phase: 'PACKAGING',
        message: 'Building print-ready PDF document...',
        percent: 92,
        discovered,
        processed: messages.length,
        skipped,
        failed: imagesFailed
      });

      const pdfBlob = await generateConversationPDF({
        title: conversationTitle,
        exportDate: formattedDate,
        messages,
        totalImages: imagesSuccess
      });

      const filename = `${cleanTitle}_${dateStr}.pdf`;
      triggerFileDownload(pdfBlob, filename);

      reportSuccess({
        format: 'pdf',
        filename,
        convoCount: 1,
        messageCount: messages.length,
        imageCount: imagesSuccess,
        skippedCount: skipped,
        failedCount: imagesFailed
      });

      return { filename, messageCount: messages.length };
    }

    // ─── Format 3: Both (ZIP Bundle) ────────────────────────────────────────
    reportProgress({
      phase: 'PACKAGING',
      message: 'Packaging HTML, PDF, CSV & media into ZIP...',
      percent: 90,
      discovered,
      processed: messages.length,
      skipped,
      failed: imagesFailed
    });

    const zip = new JSZip();
    const imagesFolder = zip.folder('images');
    messages.forEach(m => {
      (m.imageBlobs || []).forEach(ib => imagesFolder.file(ib.fileName, ib.blob));
    });

    const htmlContent = generateNativeGoogleChatHTML({
      title: conversationTitle,
      exportDate: formattedDate,
      messages,
      totalImages: imagesSuccess
    });
    zip.file(`${cleanTitle}.html`, htmlContent);

    const pdfBlob = await generateConversationPDF({
      title: conversationTitle,
      exportDate: formattedDate,
      messages,
      totalImages: imagesSuccess
    });
    zip.file(`${cleanTitle}.pdf`, pdfBlob);
    zip.file('chat_history.csv', generateRFC4180CSV(messages));

    const jsonDump = {
      metadata: {
        title: conversationTitle,
        exportedAt: new Date().toISOString(),
        messageCount: messages.length,
        imageCount: imagesSuccess
      },
      messages: messages.map(m => ({
        id: m.id,
        timestamp: m.timestamp,
        sender: m.sender,
        text: m.text,
        images: m.images || [],
        replyTo: m.replyTo,
        threadReplies: m.threadReplies,
        reactions: m.reactions || []
      }))
    };
    zip.file('chat_data.json', JSON.stringify(jsonDump, null, 2));

    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 }
    });

    const zipFilename = `${cleanTitle}_ChatVault_${dateStr}.zip`;
    triggerFileDownload(zipBlob, zipFilename);

    reportSuccess({
      format: 'both',
      filename: zipFilename,
      convoCount: 1,
      messageCount: messages.length,
      imageCount: imagesSuccess,
      skippedCount: skipped,
      failedCount: imagesFailed
    });

    return { filename: zipFilename, messageCount: messages.length };
  }

  // ─── Batch Export Pipeline ────────────────────────────────────────────────

  async function executeBatchExport(options) {
    const {
      format = 'html',
      batchIds = [],
      autoScroll = false,
      downloadImages = true,
      maxScrollAttempts = 15
    } = options;

    const allConvos = discoverSidebarConversations();
    const targets = allConvos.filter(c => batchIds.includes(String(c.id)));

    if (targets.length === 0) {
      throw new Error('No matching conversations selected for batch export.');
    }

    const masterZip = new JSZip();
    let totalMessagesProcessed = 0;
    let totalImagesDownloaded = 0;
    let completedCount = 0;
    let failedCount = 0;

    const dateStr = getIsoDateString();
    const formattedDate = getPrettyDateString();

    for (let i = 0; i < targets.length; i++) {
      checkCancel();
      const conv = targets[i];
      const cleanName = sanitizeFilename(conv.name);

      reportProgress({
        target: `[${i + 1}/${targets.length}] ${conv.name}`,
        phase: 'NAVIGATING',
        message: `Opening conversation ${i + 1} of ${targets.length}...`,
        percent: 5 + Math.round((i / targets.length) * 85),
        discovered: targets.length,
        processed: totalMessagesProcessed,
        skipped: 0,
        failed: failedCount
      });

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

          for (const t of tasks) {
            try {
              const { blob } = await fetchImageBlob(t);
              const b64 = await blobToBase64(blob);
              msgs[t.msgIndex].images.push(b64 || t.url);
              convImagesCount++;
              totalImagesDownloaded++;
            } catch {
              msgs[t.msgIndex].images.push(t.url);
            }
          }
        }

        const folder = masterZip.folder(cleanName);
        if (format === 'html' || format === 'both') {
          folder.file(`${cleanName}.html`, generateNativeGoogleChatHTML({
            title: conv.name,
            exportDate: formattedDate,
            messages: msgs,
            totalImages: convImagesCount
          }));
        }
        if (format === 'pdf' || format === 'both') {
          folder.file(`${cleanName}.pdf`, await generateConversationPDF({
            title: conv.name,
            exportDate: formattedDate,
            messages: msgs,
            totalImages: convImagesCount
          }));
        }
        folder.file(`${cleanName}.csv`, generateRFC4180CSV(msgs));
        completedCount++;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        failedCount++;
        WARN(`Failed to export ${conv.name}:`, err);
      }
    }

    checkCancel();
    masterZip.file('export_summary.json', JSON.stringify({
      exportedAt: new Date().toISOString(),
      totalConversations: targets.length,
      completed: completedCount,
      failed: failedCount,
      totalMessages: totalMessagesProcessed,
      totalMedia: totalImagesDownloaded
    }, null, 2));

    const zipBlob = await masterZip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 }
    });

    const batchFilename = `Google_Chat_Batch_${dateStr}.zip`;
    triggerFileDownload(zipBlob, batchFilename);

    reportSuccess({
      format: 'batch',
      filename: batchFilename,
      convoCount: completedCount,
      messageCount: totalMessagesProcessed,
      imageCount: totalImagesDownloaded,
      skippedCount: 0,
      failedCount: failedCount
    });

    return { filename: batchFilename, messageCount: totalMessagesProcessed };
  }

  // ─── DOM: Feed & Sidebar Isolation ────────────────────────────────────────

  /**
   * Strictly verifies if an element belongs to the left sidebar navigation roster.
   */
  function isSidebarElement(el) {
    if (!el || el === document.body || el === document.documentElement) return false;

    // Direct semantic checks
    if (el.closest('nav, [role="navigation"], aside, [role="tree"]')) return true;

    // Explicit Google Chat navigation panels
    const navPanel = el.closest(
      'div[aria-label*="Direct messages" i], div[aria-label*="Spaces" i], div[aria-label*="Conversations" i], div[aria-label*="Chats" i], [data-navigation-item]'
    );
    if (navPanel) return true;

    // Position check: sidebar is docked to the left
    try {
      const rect = el.getBoundingClientRect();
      const screenWidth = window.innerWidth || 1200;
      if (rect.right < screenWidth * 0.35 && rect.left < 60) {
        if (el.querySelector('a[href*="/dm/"], a[href*="/space/"]') || el.closest('[data-navigation-item]')) {
          return true;
        }
      }
    } catch (_) {}

    return false;
  }

  /**
   * Locates the active message feed container in the DOM.
   * NEVER returns a single message or topic card as the feed!
   */
  function locateChatFeedContainer() {
    // 1. Semantic feed or log outside sidebar
    const semanticFeed = Array.from(document.querySelectorAll('div[role="feed"], div[role="log"]'))
      .find(el => !isSidebarElement(el));
    if (semanticFeed) return semanticFeed;

    // 2. Discover from message cards outside sidebar
    const messageCards = Array.from(document.querySelectorAll('[data-topic-id], [data-message-id]'))
      .filter(el => !isSidebarElement(el));

    if (messageCards.length > 0) {
      // Find ancestor that contains all or most of these message cards
      let curr = messageCards[0].parentElement;
      while (curr && curr !== document.body) {
        if (!isSidebarElement(curr)) {
          const contained = curr.querySelectorAll('[data-topic-id], [data-message-id]').length;
          if (contained >= messageCards.length) {
            const style = window.getComputedStyle(curr);
            if (
              style.overflowY === 'auto' ||
              style.overflowY === 'scroll' ||
              curr.getAttribute('role') === 'main' ||
              curr.tagName === 'MAIN'
            ) {
              return curr;
            }
          }
        }
        curr = curr.parentElement;
      }

      // Return the immediate common parent of the message cards
      if (messageCards[0].parentElement && !isSidebarElement(messageCards[0].parentElement)) {
        return messageCards[0].parentElement;
      }
    }

    // 3. Main container query
    const mainEl = document.querySelector('div[role="main"], c-wiz[role="main"], main');
    if (mainEl && !isSidebarElement(mainEl)) {
      const innerFeed = mainEl.querySelector('div[role="feed"], div[role="log"]');
      if (innerFeed && !isSidebarElement(innerFeed)) return innerFeed;
      return mainEl;
    }

    return document.body;
  }

  function findActiveScrollContainer(feedEl) {
    if (!feedEl) feedEl = document.body;

    // 1. Check feedEl itself and its ancestors
    let curr = feedEl;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      if (isElementScrollable(curr)) {
        return curr;
      }
      curr = curr.parentElement;
    }

    // 2. Check direct children of feedEl
    for (const child of feedEl.querySelectorAll('div, c-wiz, main, section')) {
      if (isSidebarElement(child)) continue;
      if (isElementScrollable(child)) {
        return child;
      }
    }

    return document.scrollingElement || document.documentElement || document.body;
  }

  function isElementScrollable(el) {
    if (!el || isSidebarElement(el) || el === document.body || el === document.documentElement) return false;
    const style = window.getComputedStyle(el);
    const hasScrollStyle = (style.overflowY === 'auto' || style.overflowY === 'scroll');
    const hasScrollHeight = (el.scrollHeight > el.clientHeight + 25 && el.clientHeight > 80);
    return hasScrollStyle && hasScrollHeight;
  }

  // ─── DOM: Message Row Discovery ───────────────────────────────────────────

  function discoverMessageContainers(feedEl) {
    if (!feedEl) return [];

    // 1. Space topic cards (e.g. c-wiz[data-topic-id] or div[data-topic-id])
    const topics = Array.from(feedEl.querySelectorAll('c-wiz[data-topic-id], div[data-topic-id]'))
      .filter(el => !isSidebarElement(el));
    if (topics.length > 0) {
      return dedupContainers(topics);
    }

    // 2. Standard messages with data-message-id
    const msgs = Array.from(feedEl.querySelectorAll('[data-message-id]'))
      .filter(el => !isSidebarElement(el));
    if (msgs.length > 0) {
      return dedupContainers(msgs);
    }

    // 3. Structural cards inside feed (elements containing sender or timestamp)
    const candidates = Array.from(feedEl.querySelectorAll('div, c-wiz')).filter(el => {
      if (isSidebarElement(el)) return false;
      if (el.offsetHeight < 25 || el.offsetHeight > 3500) return false;
      const ts = extractMessageTimestamp(el);
      const hasBody = el.querySelector('[dir="ltr"], [dir="auto"], img:not([width="20"]):not([width="24"])');
      return Boolean(ts && hasBody && el !== feedEl && !el.contains(feedEl));
    });

    if (candidates.length > 0) {
      return dedupContainers(candidates);
    }

    // 4. Direct child rows of stream
    const directChildren = Array.from(feedEl.children).filter(ch => {
      return !isSidebarElement(ch) && ch.offsetHeight > 25 && ch.textContent.trim().length > 2;
    });

    return dedupContainers(directChildren);
  }

  function dedupContainers(elements) {
    return elements.filter((el, idx, arr) => {
      return !arr.some((other, otherIdx) => otherIdx !== idx && other.contains(el));
    });
  }

  // ─── Message Parsing Engine ───────────────────────────────────────────────

  function extractAllMessagesFromFeed(feedContainer) {
    const rows = discoverMessageContainers(feedContainer);
    LOG(`discoverMessageContainers identified ${rows.length} rows.`);

    const parsedMessages = [];
    let skippedCount = 0;
    let lastKnownSender = '';
    let lastKnownAvatar = '';
    let lastKnownDate = '';

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      const dateHeader = extractPrecedingDateSeparator(row);
      if (dateHeader) lastKnownDate = dateHeader;

      const messageId =
        row.getAttribute('data-topic-id') ||
        row.getAttribute('data-message-id') ||
        row.getAttribute('data-id') ||
        `msg_${i + 1}`;

      // 1. Sender
      const sender = extractSenderName(row, lastKnownSender);
      const avatarUrl = extractAvatarUrl(row, lastKnownAvatar);

      if (sender) lastKnownSender = sender;
      if (avatarUrl) lastKnownAvatar = avatarUrl;

      // 2. Timestamp
      const timestamp = extractMessageTimestamp(row);
      const fullTimestamp = composeFullTimestamp(lastKnownDate, timestamp);

      // 3. Quoted Reply
      const quotedReply = extractQuotedReply(row);

      // 4. Message Body Text (Strictly avoids sender name)
      const messageText = extractCleanBodyText(row, sender);

      // 5. Media attachments & files
      const detectedImages = extractImageAttachments(row);
      const sharedFiles = extractSharedDocuments(row);

      // 6. In-line thread replies & reactions
      const threadReplies = extractInLineThreadReplies(row);
      const reactions = extractEmojiReactions(row);

      // Accept message if it has text OR an image OR a file OR a quote
      const hasContent = Boolean(
        messageText.length > 0 ||
        detectedImages.length > 0 ||
        sharedFiles.length > 0 ||
        quotedReply
      );

      if (hasContent) {
        parsedMessages.push({
          id: messageId,
          dateHeader: lastKnownDate,
          timestamp: fullTimestamp,
          sender: sender || lastKnownSender || '',
          avatarUrl: avatarUrl || lastKnownAvatar,
          replyTo: quotedReply,
          text: messageText,
          detectedImages,
          images: [],
          sharedFiles,
          threadReplies,
          reactions,
          imageBlobs: []
        });
      } else {
        skippedCount++;
      }
    }

    return {
      messages: parsedMessages,
      discovered: rows.length,
      skipped: skippedCount
    };
  }

  // ─── Field Extractors ─────────────────────────────────────────────────────

  /**
   * Extracts the actual sender display name.
   * Priority:
   * 1. Avatar element aria-labels (works for both photo avatars and letter initials like "M")
   * 2. Direct sender header elements (.Wq4GMc, .FvY9Uc, [data-hovercard-id], [data-name], [role="heading"])
   * 3. Header container text (stripping timestamps and "Edited")
   * 4. Fallback to lastKnownSender for continuation messages.
   * Strictly avoids thread reply footers, participant rosters, and NEVER returns generic fallbacks.
   */
  function extractSenderName(row, fallbackSender) {
    const isInsideThreadFooter = (el) => {
      return Boolean(el.closest('[aria-label*="repl" i], [aria-label*="unread" i], .gchat-thread-bar'));
    };

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
    }

    // 2. Specific Google Chat timestamp class (.njhDLc)
    const njh = row.querySelector('.njhDLc, time');
    if (njh && !njh.closest('[aria-label*="repl" i], button, .gchat-thread-bar')) {
      const t = (njh.innerText || njh.textContent || '').trim().replace(/\u00A0/g, ' ');
      if (t && /\d{1,2}:\d{2}/.test(t)) return t;
    }

    // 3. Scanning elements in header using time regex
    const TIME_REGEX = /\b((Mon|Tue|Wed|Thu|Fri|Sat|Sun|Yesterday|Today)[a-z]*\.?[\s\u00A0]*,?[\s\u00A0]*)?\d{1,2}:\d{2}([\s\u00A0]*[AP]M)?\b/i;

    const timeCandidates = row.querySelectorAll('span, div');
    for (const el of timeCandidates) {
      if (el.closest('[aria-label*="repl" i], button, .gchat-thread-bar')) continue;

      const aria = (el.getAttribute('aria-label') || '').trim();
      if (aria && TIME_REGEX.test(aria) && !aria.toLowerCase().includes('repl')) {
        return aria;
      }

      if (el.children.length <= 1) {
        const text = (el.innerText || el.textContent || '').trim();
        if (TIME_REGEX.test(text) && !text.toLowerCase().includes('repl') && text.length < 35) {
          return text.replace(/\u00A0/g, ' ');
        }
      }
    }

    return '';
  }

  function composeFullTimestamp(dateHeader, timeStr) {
    if (dateHeader && timeStr) {
      if (timeStr.includes(dateHeader)) return timeStr;
      return `${dateHeader}, ${timeStr}`;
    }
    return dateHeader || timeStr || '';
  }

  /**
   * Extracts clean message body text.
   * STRICT FIX: Removes all action buttons (:thumbs-up:, Add reaction, Reply in thread),
   * timestamps, headers, and thread footers.
   */
  function extractCleanBodyText(row, senderName) {
    // 1. Direct Google Chat message text body selectors
    const directBodySelectors = [
      'div[jsname="d9t4wf"]',
      'div.tMd3Re',
      'div.Zc1EHg',
      'div[data-message-text]'
    ];

    for (const sel of directBodySelectors) {
      const bodyNode = row.querySelector(sel);
      if (bodyNode) {
        const text = sanitizeExtractedLines(formatDomNodeToText(bodyNode.cloneNode(true)), senderName);
        if (text && text.length > 0) {
          return text;
        }
      }
    }

    // 2. Clone-and-strip method
    const clone = row.cloneNode(true);

    // Remove buttons: action toolbar (Add reaction, Reply, Quote, More), quick reactions, thread reply button
    clone.querySelectorAll('button').forEach(n => n.remove());

    // Remove quotes
    clone.querySelectorAll('blockquote, [aria-label*="Quote" i], [aria-label*="Replying to" i], div.I92drc, div.uYF0Xb').forEach(n => n.remove());

    // Remove thread replies footer & badges
    clone.querySelectorAll('[aria-label*="repl" i], [aria-label*="unread" i], .gchat-thread-bar').forEach(n => n.remove());

    // Remove reactions, emoji bars & toolbars
    clone.querySelectorAll('[aria-label*="reaction" i], [aria-label*="reacted" i], div.Fwf5Ef, [data-emoji-id], [role="toolbar"], [aria-label*="Message actions" i]').forEach(n => n.remove());

    // Remove sender names, headers, avatars, and timestamps
    clone.querySelectorAll('.FvY9Uc, .Wq4GMc, [data-hovercard-id], [data-name], header, [role="heading"], .njhDLc, time, [data-timestamp], img, [aria-label*="photo" i]').forEach(n => n.remove());

    // Remove sender name text explicitly if still present
    if (senderName) {
      clone.querySelectorAll('span, div, strong, b').forEach(el => {
        if (el.textContent.trim() === senderName) {
          el.remove();
        }
      });
    }

    // Look for text in dir="ltr" or dir="auto"
    const dirContainers = Array.from(clone.querySelectorAll('[dir="ltr"], [dir="auto"]')).filter(c => {
      const t = c.textContent.trim();
      return t.length > 0 && t !== senderName && !/^\d{1,2}:\d{2}/.test(t);
    });

    let rawResult = '';
    if (dirContainers.length > 0) {
      const texts = dirContainers.map(c => formatDomNodeToText(c)).filter(t => t.length > 0 && t !== senderName && !/^\d{1,2}:\d{2}/.test(t));
      if (texts.length > 0) {
        rawResult = texts.reduce((acc, curr) => {
          if (acc.includes(curr)) return acc;
          if (curr.includes(acc)) return curr;
          return acc + '\n' + curr;
        }, '').trim();
      }
    }

    if (!rawResult) {
      rawResult = formatDomNodeToText(clone);
    }

    return sanitizeExtractedLines(rawResult, senderName);
  }

  function sanitizeExtractedLines(raw, senderName) {
    if (!raw) return '';
    const rejectPatterns = [
      /^:(thumbs-up|joy|folded-hands|heart|smile|tada|fire|clap|plus_one|laughing|[a-z0-9_-]+):$/i,
      /^Add reaction$/i,
      /^Reply in thread$/i,
      /^Quote in reply$/i,
      /^More actions$/i,
      /^Message actions$/i,
      /^\d+\s+repl(y|ies)/i,
      /^Last Reply:?/i,
      /^[,\s]*(Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)?[,\s]*\d{1,2}:\d{2}\s*([AP]M)?(\s*\/?\s*PM|\s*\/?\s*AM)?[,\s]*$/i,
      /^[,\s]*[•·]?\s*Edited[,\s]*$/i
    ];

    const lines = raw.split('\n')
      .map(line => line.trim())
      .filter(line => {
        if (!line || line === ',') return false;
        if (senderName && line === senderName) return false;
        if (rejectPatterns.some(p => p.test(line))) return false;
        return true;
      });

    return lines.join('\n').trim();
  }

  function formatDomNodeToText(node) {
    if (!node) return '';
    node.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    node.querySelectorAll('p, div, li').forEach(el => el.append('\n'));

    const raw = node.innerText !== undefined ? node.innerText : node.textContent;
    return (raw || '')
      .split('\n')
      .map(line => line.trim())
      .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
      .join('\n')
      .trim();
  }

  /**
   * Extracts attached screenshots and images (excluding avatars and emojis).
   * Supports images wrapped in clickable buttons or links!
   * Upgrades thumbnails (=w... / =s...) to full original resolution (=s0).
   */
  function extractImageAttachments(row) {
    const images = [];
    const seenUrls = new Set();

    const imgs = Array.from(row.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      if (!src || src.startsWith('data:image/svg')) continue;

      // Filter out small avatars in thread reply footer
      if (img.closest('[aria-label*="repl" i], [aria-label*="unread" i], .gchat-thread-bar')) {
        const w = img.naturalWidth || img.clientWidth || 0;
        if (w > 0 && w <= 36) continue;
      }

      // Filter out user profile avatars in header
      const isAvatar = src.includes('/a/') || src.includes('/a-/') || src.includes('/ogw/') ||
        Boolean(img.closest('[data-hovercard-id], [aria-label*="Profile photo" i]')) ||
        Boolean(img.closest('header, .FvY9Uc, .Wq4GMc') && (img.clientWidth || 0) <= 44);
      if (isAvatar) continue;

      // Filter out small chat emojis
      const isEmoji = src.includes('/emoji/') || src.includes('gstatic.com/chat/emoji') ||
        (img.alt && img.alt.length <= 2 && (img.width <= 24 || img.naturalWidth <= 24));
      if (isEmoji) continue;

      // Full-resolution upgrade for Google CDN images
      let highRes = src;
      if (highRes.includes('googleusercontent.com')) {
        highRes = highRes.replace(/=w\d+-h\d+.*$/i, '=s0').replace(/=s\d+.*$/i, '=s0').replace(/=w\d+.*$/i, '=s0');
      }

      const parentLink = img.closest('a');
      if (parentLink && parentLink.href && (parentLink.href.includes('googleusercontent.com') || /\.(png|jpe?g|webp|gif)/i.test(parentLink.href))) {
        highRes = parentLink.href;
      }

      if (!seenUrls.has(src) && !seenUrls.has(highRes)) {
        seenUrls.add(src);
        seenUrls.add(highRes);
        images.push({
          url: highRes,
          originalSrc: src,
          element: img
        });
      }
    }

    // Direct image links
    for (const link of row.querySelectorAll('a[href]')) {
      const href = link.href;
      if (/\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(href) && !href.includes('/a/') && !seenUrls.has(href)) {
        seenUrls.add(href);
        images.push({ url: href, originalSrc: href, element: link.querySelector('img') || null });
      }
    }

    return images;
  }

  /**
   * Extracts shared Google Drive files and documents.
   */
  function extractSharedDocuments(row) {
    const files = [];
    for (const a of row.querySelectorAll('a[href]')) {
      const href = a.href;
      if (/\.(png|jpe?g|webp|gif)$/i.test(href)) continue;

      const isDrive = href.includes('drive.google.com') || href.includes('docs.google.com');
      const isDoc = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|txt|csv)/i.test(href);

      if (isDrive || isDoc) {
        files.push({
          name: a.textContent.trim() || 'Attachment',
          url: href,
          isDrive
        });
      }
    }
    return files;
  }

  /**
   * Extracts quoted reply card context.
   */
  function extractQuotedReply(row) {
    const quoteEl = row.querySelector('blockquote, [aria-label*="Quote" i], [aria-label*="Replying to" i], div.I92drc, div.uYF0Xb');
    if (!quoteEl) return null;

    let quoteSender = '';
    const label = quoteEl.getAttribute('aria-label') || '';
    const m = label.match(/replying to\s+([^:,]+)/i);
    if (m) quoteSender = m[1].trim();

    if (!quoteSender) {
      const senderEl = quoteEl.querySelector('[data-hovercard-id], [role="heading"], strong, b');
      if (senderEl) quoteSender = senderEl.textContent.trim();
    }

    const clone = quoteEl.cloneNode(true);
    clone.querySelectorAll('[data-hovercard-id], [role="heading"], strong, b').forEach(n => n.remove());
    const snippet = formatDomNodeToText(clone).slice(0, 300);

    return (quoteSender || snippet) ? { sender: quoteSender || 'Quoted Message', snippet } : null;
  }

  /**
   * Extracts in-line thread replies indicator (e.g. "6 unread 6 replies Tue 5:38 PM").
   */
  function extractInLineThreadReplies(row) {
    for (const el of row.querySelectorAll('[aria-label*="repl" i], [aria-label*="unread" i], button')) {
      const text = el.textContent.trim();
      if (/(\d+)\s+repl(y|ies)/i.test(text)) {
        return text.replace(/\s+/g, ' ');
      }
    }
    return '';
  }

  /**
   * Extracts emoji reactions.
   */
  function extractEmojiReactions(row) {
    const reactions = [];
    for (const badge of row.querySelectorAll('[aria-label*="reacted" i], [aria-label*="reaction" i], div.Fwf5Ef')) {
      const text = badge.textContent.trim();
      const aria = badge.getAttribute('aria-label') || '';
      if (text) reactions.push(text);
      else if (aria) reactions.push(aria);
    }
    return reactions;
  }

  /**
   * Extracts preceding date divider (e.g. "Tuesday, Oct 29").
   */
  function extractPrecedingDateSeparator(row) {
    let prev = row.previousElementSibling;
    let hops = 0;
    while (prev && hops < 6) {
      const role = prev.getAttribute('role');
      if (role === 'separator' || role === 'heading' || prev.hasAttribute('data-date')) {
        const text = prev.textContent.trim();
        if (text && text.length < 50 && !text.includes(':')) {
          return text;
        }
      }
      prev = prev.previousElementSibling;
      hops++;
    }
    return '';
  }

  // ─── Image Fetching & Canvas Fallback ──────────────────────────────────────

  async function fetchImageBlob(task) {
    const urlsToTry = [task.url, task.originalSrc].filter(Boolean);

    // 1. Try authenticated fetch with credentials
    for (const u of urlsToTry) {
      try {
        const res = await fetch(u, { credentials: 'include' });
        if (res.ok) {
          const blob = await res.blob();
          if (blob && blob.size > 100) {
            const extension = getFileExtensionFromBlob(blob, u);
            return { blob, extension };
          }
        }
      } catch (_) {}
    }

    // 2. In-memory Canvas capture from the already-rendered DOM image element!
    if (task.element && task.element.tagName === 'IMG') {
      try {
        const canvasBlob = await captureImageFromCanvas(task.element);
        if (canvasBlob && canvasBlob.size > 100) {
          return { blob: canvasBlob, extension: 'png' };
        }
      } catch (_) {}
    }

    // 3. Fallback unauthenticated fetch
    for (const u of urlsToTry) {
      try {
        const res = await fetch(u);
        if (res.ok) {
          const blob = await res.blob();
          if (blob && blob.size > 100) {
            const extension = getFileExtensionFromBlob(blob, u);
            return { blob, extension };
          }
        }
      } catch (_) {}
    }

    throw new Error(`Unable to fetch image: ${task.url}`);
  }

  function captureImageFromCanvas(img) {
    return new Promise(resolve => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.clientWidth || 400;
        canvas.height = img.naturalHeight || img.clientHeight || 300;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(b => resolve(b), 'image/png');
      } catch (_) {
        resolve(null);
      }
    });
  }

  function getFileExtensionFromBlob(blob, url) {
    if (blob.type) {
      if (blob.type.includes('jpeg') || blob.type.includes('jpg')) return 'jpg';
      if (blob.type.includes('png')) return 'png';
      if (blob.type.includes('webp')) return 'webp';
      if (blob.type.includes('gif')) return 'gif';
    }
    const match = url.match(/\.(png|jpe?g|webp|gif)/i);
    return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  }

  function blobToBase64(blob) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }

  // ─── Progressive Virtual Scroll Harvester ──────────────────────────────────

  /**
   * Paced, steady virtual scroll harvester.
   * Defeats Google Chat virtual unmounting by extracting messages at each step (450ms pace)
   * into an accumulated map as the viewport smoothly sweeps through history.
   */
  async function autoScrollAndHarvestMessages(feedContainer, scrollContainer, maxScrollAttempts) {
    const accumulatedMap = new Map();
    const orderedMessages = [];

    function harvest() {
      // Find active feed container (or re-locate if virtualization refreshed parent)
      const target = (feedContainer && feedContainer.isConnected && feedContainer.querySelectorAll('[data-topic-id], [data-message-id]').length > 0)
        ? feedContainer
        : (locateChatFeedContainer() || document.body);

      const extraction = extractAllMessagesFromFeed(target);
      for (const msg of extraction.messages) {
        // Unique key: id or sender + timestamp + text snippet or image signature
        const key = (msg.id && !msg.id.startsWith('msg_'))
          ? msg.id
          : `${msg.sender}_${msg.timestamp}_${(msg.text || '').slice(0, 45)}_${msg.detectedImages && msg.detectedImages[0] ? msg.detectedImages[0].url.slice(-25) : ''}`;

        if (!accumulatedMap.has(key)) {
          accumulatedMap.set(key, msg);
          orderedMessages.push(msg);
        } else {
          // Merge newly hydrated fields if found
          const existing = accumulatedMap.get(key);
          if ((!existing.text || existing.text.length < msg.text.length) && msg.text) {
            existing.text = msg.text;
          }
          if ((!existing.detectedImages || existing.detectedImages.length === 0) && msg.detectedImages && msg.detectedImages.length > 0) {
            existing.detectedImages = msg.detectedImages;
          }
          if (!existing.avatarUrl && msg.avatarUrl) {
            existing.avatarUrl = msg.avatarUrl;
          }
          if (!existing.threadReplies && msg.threadReplies) {
            existing.threadReplies = msg.threadReplies;
          }
        }
      }
    }

    function scrollTarget(targetY) {
      if (scrollContainer && scrollContainer !== document.body && scrollContainer !== document.documentElement) {
        scrollContainer.scrollTop = targetY;
      }
      if (document.scrollingElement) {
        document.scrollingElement.scrollTop = targetY;
      }
      window.scrollTo(0, targetY);
      try {
        if (scrollContainer) {
          scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      } catch (_) {}
    }

    // 1. Initial harvest of currently visible view
    harvest();

    reportProgress({
      phase: 'SCROLLING',
      message: `Loading older messages... (${orderedMessages.length} captured)`,
      percent: 10,
      discovered: orderedMessages.length,
      processed: orderedMessages.length,
      skipped: 0,
      failed: 0
    });

    // 2. Phase 1: Scroll UP to fetch older history (with 480ms network pace)
    let lastHeight = scrollContainer.scrollHeight;
    let unchangedCount = 0;

    for (let i = 0; i < maxScrollAttempts; i++) {
      checkCancel();
      scrollTarget(0);
      await sleep(480); // Steady pause: gives Google Chat network pagination time to respond

      harvest();

      const newHeight = scrollContainer.scrollHeight;
      if (newHeight === lastHeight) {
        if (++unchangedCount >= 2) break;
      } else {
        unchangedCount = 0;
        lastHeight = newHeight;
      }

      reportProgress({
        phase: 'SCROLLING',
        message: `Loading history... (${orderedMessages.length} captured)`,
        percent: 10 + Math.round(((i + 1) / maxScrollAttempts) * 16),
        discovered: orderedMessages.length,
        processed: orderedMessages.length,
        skipped: 0,
        failed: 0
      });
    }

    // 3. Phase 2: Steady sweep DOWN from top to bottom
    reportProgress({
      phase: 'SCROLLING',
      message: `Harvesting conversation top to bottom... (${orderedMessages.length} captured)`,
      percent: 28,
      discovered: orderedMessages.length,
      processed: orderedMessages.length,
      skipped: 0,
      failed: 0
    });

    scrollTarget(0);
    await sleep(300);
    harvest();

    const viewHeight = scrollContainer.clientHeight || 600;
    const stepSize = Math.max(260, Math.floor(viewHeight * 0.50)); // 50% step ensures continuous overlap
    let currentY = 0;
    let sweepStep = 0;

    while (currentY < scrollContainer.scrollHeight) {
      checkCancel();
      currentY += stepSize;
      scrollTarget(currentY);
      await sleep(420); // 420ms: steady human-paced pause for virtual DOM & image hydration

      harvest();
      sweepStep++;

      reportProgress({
        phase: 'SCROLLING',
        message: `Harvested ${orderedMessages.length} messages...`,
        percent: 28 + Math.min(22, sweepStep * 2),
        discovered: orderedMessages.length,
        processed: orderedMessages.length,
        skipped: 0,
        failed: 0
      });

      if (scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 25) {
        break;
      }
    }

    // 4. Anchor at bottom and finalize harvest
    scrollTarget(scrollContainer.scrollHeight);
    await sleep(400);
    harvest();

    LOG(`autoScrollAndHarvestMessages complete. Total unique messages harvested: ${orderedMessages.length}`);
    return orderedMessages;
  }

  // ─── Sidebar Navigation Discovery ─────────────────────────────────────────

  function discoverSidebarConversations() {
    const list = [];
    const seen = new Set();

    const anchors = document.querySelectorAll(
      'a[href*="/dm/"], a[href*="/space/"], a[href*="/room/"], [data-navigation-item]'
    );

    anchors.forEach((el, idx) => {
      if (!isSidebarElement(el)) return;

      const a = el.tagName === 'A' ? el : el.querySelector('a');
      const href = a ? (a.getAttribute('href') || '') : '';

      let name = '';
      const titleSpan = el.querySelector('[dir="auto"], span[style*="font-weight"], .Wq4GMc');
      if (titleSpan && titleSpan.textContent.trim()) {
        name = titleSpan.textContent.trim();
      } else {
        name = el.textContent.trim().split('\n')[0].trim();
      }

      if (!name || name.length < 2 || name.length > 60) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      const isSpace = href.includes('/space/') || href.includes('/room/') || Boolean(el.querySelector('[aria-label*="Space" i]'));

      list.push({
        id: `convo_${idx + 1}`,
        name,
        type: isSpace ? 'space' : 'dm',
        href,
        element: el
      });
    });

    return list;
  }

  async function navigateToConversation(conv) {
    if (conv.element && document.body.contains(conv.element)) {
      conv.element.click();
      return;
    }
    if (conv.href) {
      window.location.href = conv.href.startsWith('http') ? conv.href : location.origin + conv.href;
    }
  }

  // ─── Conversation Title Detection ─────────────────────────────────────────

  function detectConversationTitle() {
    if (document.title) {
      const clean = document.title
        .replace(/^\(\d+\)\s*/, '')
        .replace(/\s*[-–]\s*Google Chat.*$/i, '')
        .replace(/\s*[-–]\s*Gmail.*$/i, '')
        .trim();
      if (clean && !['Google Chat', 'Chat', 'Gmail', 'Inbox'].includes(clean)) {
        return clean;
      }
    }

    const header = document.querySelector('div[role="main"] h1, header h1, [role="heading"][aria-level="1"]');
    if (header && !isSidebarElement(header)) {
      const t = header.textContent.trim();
      if (t && t.length < 80) return t;
    }

    return 'Google_Chat_Conversation';
  }

  // ─── CSV Export ───────────────────────────────────────────────────────────

  function generateRFC4180CSV(messages) {
    const BOM = '\uFEFF';
    const headers = ['Timestamp', 'Sender', 'In Reply To', 'Message Text', 'Images', 'Thread Replies'];
    const rows = [headers.map(escapeCsv).join(',')];

    for (const m of messages) {
      const replyStr = m.replyTo ? `${m.replyTo.sender}: "${m.replyTo.snippet}"` : '';
      rows.push([
        escapeCsv(m.timestamp),
        escapeCsv(m.sender),
        escapeCsv(replyStr),
        escapeCsv(m.text),
        escapeCsv((m.images || []).join('; ')),
        escapeCsv(m.threadReplies || '')
      ].join(','));
    }

    return BOM + rows.join('\r\n');
  }

  function escapeCsv(val) {
    return '"' + String(val ?? '').replace(/"/g, '""') + '"';
  }

  // ─── Avatar Styling Helpers ──────────────────────────────────────────────

  function getAvatarColor(name) {
    const colors = ['#1a73e8', '#e52592', '#12b5cb', '#e8710a', '#0d904f', '#9334e6', '#ea4335', '#f9ab00'];
    let h = 0;
    for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return colors[Math.abs(h) % colors.length];
  }

  function getInitials(name) {
    const parts = (name || '?').trim().split(/\s+/);
    return parts.length >= 2 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : (name || '?').slice(0, 2).toUpperCase();
  }

  function hexToRgb(hex) {
    const clean = (hex || '#1a73e8').replace('#', '');
    const num = parseInt(clean, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }

  // ─── Professional PDF Export (jsPDF) ──────────────────────────────────────

  async function generateConversationPDF(data) {
    const { title, exportDate, messages, totalImages } = data;
    const { jsPDF } = window.jspdf;

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;
    const contentWidth = pageWidth - margin * 2;
    const maxContentY = pageHeight - 18;

    let currentY = margin;

    function checkPageOverflow(needed) {
      if (currentY + needed > maxContentY) {
        doc.addPage();
        currentY = margin;
        return true;
      }
      return false;
    }

    // Google Green accent bar
    doc.setFillColor(0, 131, 45);
    doc.rect(margin, currentY, contentWidth, 2.5, 'F');
    currentY += 7;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(31, 31, 31);
    doc.text(title || 'Google Chat Archive', margin, currentY);
    currentY += 5.5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(116, 119, 117);
    const participants = [...new Set(messages.map(m => m.sender).filter(Boolean))];
    doc.text(`Exported ${exportDate} · ${messages.length} messages · ${totalImages} media files · Participants: ${participants.slice(0, 5).join(', ')}`, margin, currentY);
    currentY += 5.5;

    doc.setDrawColor(224, 227, 231);
    doc.setLineWidth(0.3);
    doc.line(margin, currentY, margin + contentWidth, currentY);
    currentY += 7;

    let lastDate = '';

    for (let i = 0; i < messages.length; i++) {
      checkCancel();
      const msg = messages[i];

      // Date Header divider (centered pill)
      if (msg.dateHeader && msg.dateHeader !== lastDate) {
        lastDate = msg.dateHeader;
        checkPageOverflow(11);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(80, 80, 80);

        const dw = doc.getTextWidth(msg.dateHeader) + 10;
        doc.setFillColor(240, 244, 249);
        doc.roundedRect((pageWidth - dw) / 2, currentY - 3.5, dw, 5.5, 1.5, 1.5, 'F');
        doc.text(msg.dateHeader, (pageWidth - doc.getTextWidth(msg.dateHeader)) / 2, currentY);
        currentY += 8;
      }

      // Sender Avatar circle
      checkPageOverflow(14);
      const avatarSize = 7.5;
      const rgb = hexToRgb(getAvatarColor(msg.sender));
      doc.setFillColor(rgb.r, rgb.g, rgb.b);
      doc.circle(margin + avatarSize / 2, currentY + avatarSize / 2, avatarSize / 2, 'F');

      // Avatar Initial
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(255, 255, 255);
      const initial = getInitials(msg.sender).slice(0, 1);
      const initW = doc.getTextWidth(initial);
      doc.text(initial, margin + (avatarSize - initW) / 2, currentY + avatarSize / 2 + 2.6);

      // Sender Name & Timestamp
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(31, 31, 31);
      const senderText = msg.sender || '—';
      doc.text(senderText, margin + 10.5, currentY + 3.8);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(116, 119, 117);
      doc.text(`   ${msg.timestamp}`, margin + 10.5 + doc.getTextWidth(senderText), currentY + 3.8);
      currentY += 8.5;

      const bubbleMargin = margin + 10.5;
      const bubbleWidth = contentWidth - 10.5;

      // Quoted Reply Box
      if (msg.replyTo) {
        checkPageOverflow(12);
        doc.setFillColor(248, 250, 253);
        doc.rect(bubbleMargin, currentY, bubbleWidth, 11, 'F');
        doc.setFillColor(11, 87, 208);
        doc.rect(bubbleMargin, currentY, 1.5, 11, 'F');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(11, 87, 208);
        doc.text(`↩ ${msg.replyTo.sender}`, bubbleMargin + 3.5, currentY + 4);

        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(68, 71, 70);
        const splitQuote = doc.splitTextToSize(`"${msg.replyTo.snippet}"`, bubbleWidth - 8);
        doc.text(splitQuote[0] || '', bubbleMargin + 3.5, currentY + 8.5);
        currentY += 13;
      }

      // Message Body Text
      if (msg.text) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(31, 31, 31);

        const lines = doc.splitTextToSize(msg.text, bubbleWidth - 4);
        const textHeight = lines.length * 4.2;
        checkPageOverflow(textHeight + 2);
        doc.text(lines, bubbleMargin, currentY);
        currentY += textHeight + 2;
      }

      // Attached Screenshots & Images (Embedded directly)
      for (const imgSrc of (msg.images || [])) {
        if (imgSrc.startsWith('data:image/')) {
          const imgWidth = Math.min(135, bubbleWidth - 4);
          const imgHeight = 70;
          checkPageOverflow(imgHeight + 4);
          try {
            const format = imgSrc.includes('image/jpeg') ? 'JPEG' : 'PNG';
            doc.addImage(imgSrc, format, bubbleMargin, currentY, imgWidth, imgHeight);
            currentY += imgHeight + 4;
          } catch (_) {}
        }
      }

      // Shared Documents
      for (const file of (msg.sharedFiles || [])) {
        checkPageOverflow(6);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(11, 87, 208);
        doc.text(`📎 Attachment: ${file.name} (${file.url.slice(0, 65)})`, bubbleMargin, currentY);
        currentY += 5;
      }

      // In-line thread replies pill
      if (msg.threadReplies) {
        checkPageOverflow(6);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(11, 87, 208);
        doc.text(`💬 ${msg.threadReplies}`, bubbleMargin, currentY);
        currentY += 5;
      }

      currentY += 4.5;
    }

    // Page numbers
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text('ChatVault · Google Chat Archive', margin, pageHeight - 7);
      doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin - 20, pageHeight - 7);
    }

    return doc.output('blob');
  }

  // ─── Native Google Chat HTML Viewer (Exact Image 2 Replica) ────────────────

  function generateNativeGoogleChatHTML(data) {
    const { title, exportDate, messages, totalImages } = data;

    function esc(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatText(t) {
      if (!t) return '';
      let s = esc(t);
      // Mentions (e.g. @ Piotr Szczepanik)
      s = s.replace(/(@[\w][\w\s.-]{0,40})/g, '<span class="gchat-mention">$1</span>');
      // Clickable links
      s = s.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="gchat-link">$1</a>');
      // Bold & Code
      s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/`([^`\n]+)`/g, '<code class="gchat-code">$1</code>');
      return s.replace(/\n/g, '<br>');
    }

    let messagesHtml = '';
    let lastRenderedDate = '';

    messages.forEach(msg => {
      if (msg.dateHeader && msg.dateHeader !== lastRenderedDate) {
        lastRenderedDate = msg.dateHeader;
        messagesHtml += `
          <div class="gchat-date-separator">
            <span class="gchat-date-chip">${esc(msg.dateHeader)}</span>
          </div>
        `;
      }

      const color = getAvatarColor(msg.sender);
      const initials = getInitials(msg.sender);
      const avatarContent = msg.avatarUrl
        ? `<img src="${esc(msg.avatarUrl)}" class="gchat-avatar-img" alt="${esc(msg.sender)}" />`
        : initials;

      let quoteHtml = '';
      if (msg.replyTo) {
        quoteHtml = `
          <div class="gchat-quote-box">
            <div class="gchat-quote-bar"></div>
            <div class="gchat-quote-content">
              <div class="gchat-quote-header">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
                <span>Replying to <strong>${esc(msg.replyTo.sender)}</strong></span>
              </div>
              <div class="gchat-quote-snippet">${esc(msg.replyTo.snippet)}</div>
            </div>
          </div>
        `;
      }

      let imagesHtml = '';
      if (msg.images && msg.images.length > 0) {
        imagesHtml = '<div class="gchat-media-grid">' +
          msg.images.map(imgSrc => `
            <div class="gchat-media-wrapper" onclick="openLightbox('${esc(imgSrc)}')">
              <img src="${esc(imgSrc)}" alt="Attachment" loading="lazy" />
              <div class="gchat-zoom-badge">🔍 Click to enlarge</div>
            </div>
          `).join('') +
          '</div>';
      }

      let filesHtml = '';
      if (msg.sharedFiles && msg.sharedFiles.length > 0) {
        filesHtml = '<div class="gchat-files-list">' +
          msg.sharedFiles.map(f => `
            <a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" class="gchat-file-card">
              <span class="gchat-file-icon">📄</span>
              <div class="gchat-file-details">
                <span class="gchat-file-name">${esc(f.name)}</span>
                <span class="gchat-file-sub">${f.isDrive ? 'Google Drive File' : 'Attachment'}</span>
              </div>
            </a>
          `).join('') +
          '</div>';
      }

      let threadRepliesHtml = '';
      if (msg.threadReplies) {
        threadRepliesHtml = `
          <div class="gchat-thread-bar">
            <span class="gchat-thread-pill">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              ${esc(msg.threadReplies)}
            </span>
          </div>
        `;
      }

      let reactionsHtml = '';
      if (msg.reactions && msg.reactions.length > 0) {
        reactionsHtml = '<div class="gchat-reactions-row">' +
          msg.reactions.map(r => `<span class="gchat-reaction-chip">${esc(r)}</span>`).join('') +
          '</div>';
      }

      const hasBubble = Boolean(msg.text || (msg.images && msg.images.length > 0) || (msg.sharedFiles && msg.sharedFiles.length > 0) || msg.replyTo);

      messagesHtml += `
        <div class="gchat-card-container">
          <div class="gchat-msg-row" data-sender="${esc((msg.sender || '').toLowerCase())}" data-content="${esc((msg.text || '').toLowerCase().slice(0, 200))}">
            <div class="gchat-avatar" style="background-color: ${color}">
              ${avatarContent}
            </div>
            <div class="gchat-msg-container">
              <div class="gchat-meta-header">
                <span class="gchat-sender">${esc(msg.sender || '—')}</span>
                <span class="gchat-timestamp">${esc(msg.timestamp)}</span>
              </div>
              ${hasBubble ? `
              <div class="gchat-card-bubble">
                ${quoteHtml}
                ${msg.text ? `<div class="gchat-text">${formatText(msg.text)}</div>` : ''}
                ${imagesHtml}
                ${filesHtml}
                ${reactionsHtml}
              </div>` : ''}
              ${threadRepliesHtml}
            </div>
          </div>
        </div>
      `;
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} · Google Chat</title>
  <style>
    :root {
      --gchat-font: "Google Sans", Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      --bg-page: #f8fafd;
      --bg-card: #ffffff;
      --bg-surface: #f0f4f9;
      --bg-hover: #e9eef6;
      --border-card: #e0e3e7;
      --border-subtle: #e7eaee;
      --text-main: #1f1f1f;
      --text-secondary: #444746;
      --text-muted: #747775;
      --google-blue: #0b57d0;
      --google-green: #00832d;
      --quote-bg: #f8fafd;
      --reaction-bg: #f0f4f9;
      --reaction-border: #c4c7c5;
      --mention-bg: #d3e3fd;
      --mention-text: #041e49;
      --code-bg: #f1f3f4;
    }

    [data-theme="dark"] {
      --bg-page: #191a1a;
      --bg-card: #282a2c;
      --bg-surface: #313335;
      --bg-hover: #3b3d40;
      --border-card: #444746;
      --border-subtle: #3c4043;
      --text-main: #e3e3e3;
      --text-secondary: #c4c7c5;
      --text-muted: #8e918f;
      --google-blue: #a8c7fa;
      --google-green: #34a853;
      --quote-bg: #1f1f1f;
      --reaction-bg: #37393b;
      --reaction-border: #444746;
      --mention-bg: #004a77;
      --mention-text: #c2e7ff;
      --code-bg: #2d3032;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg-page);
      color: var(--text-main);
      font-family: var(--gchat-font);
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }

    header.gchat-topbar {
      position: sticky;
      top: 0;
      background-color: var(--bg-card);
      border-bottom: 1px solid var(--border-card);
      padding: 10px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      z-index: 100;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .gchat-brand-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: linear-gradient(135deg, #00832d, #1ea446);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 5px rgba(0,131,45,0.25);
    }

    .topbar-titles h1 {
      font-size: 17px;
      font-weight: 600;
      color: var(--text-main);
      letter-spacing: -0.01em;
    }

    .topbar-titles p {
      font-size: 11.5px;
      color: var(--text-muted);
    }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .gchat-search {
      padding: 7px 14px;
      border-radius: 20px;
      border: 1px solid var(--border-card);
      background-color: var(--bg-surface);
      color: var(--text-main);
      font-size: 12.5px;
      outline: none;
      width: 220px;
      transition: all 0.2s ease;
    }

    .gchat-search:focus {
      border-color: var(--google-blue);
      box-shadow: 0 0 0 3px rgba(11, 87, 208, 0.15);
      width: 260px;
    }

    .gchat-btn {
      padding: 7px 12px;
      border-radius: 20px;
      border: 1px solid var(--border-card);
      background: var(--bg-surface);
      color: var(--text-main);
      font-size: 12px;
      cursor: pointer;
      font-weight: 500;
      transition: background 0.15s ease;
    }

    .gchat-btn:hover { background: var(--bg-hover); }

    main.gchat-stream {
      max-width: 900px;
      width: 100%;
      margin: 0 auto;
      padding: 20px 24px 80px 24px;
      flex-grow: 1;
    }

    .gchat-date-separator {
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 24px 0 16px 0;
      position: relative;
    }

    .gchat-date-separator::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      height: 1px;
      background-color: var(--border-subtle);
      z-index: 1;
    }

    .gchat-date-chip {
      position: relative;
      z-index: 2;
      background-color: var(--bg-surface);
      border: 1px solid var(--border-card);
      padding: 3px 14px;
      border-radius: 16px;
      font-size: 11.5px;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .gchat-card-container {
      margin-bottom: 14px;
    }

    .gchat-msg-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .gchat-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 600;
      color: white;
      flex-shrink: 0;
      overflow: hidden;
      margin-top: 2px;
    }

    .gchat-avatar-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .gchat-msg-container {
      flex-grow: 1;
      max-width: calc(100% - 48px);
    }

    .gchat-meta-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }

    .gchat-sender {
      font-size: 14.5px;
      font-weight: 600;
      color: var(--text-main);
    }

    .gchat-timestamp {
      font-size: 11.5px;
      color: var(--text-muted);
    }

    .gchat-card-bubble {
      background-color: var(--bg-card);
      border: 1px solid var(--border-card);
      border-radius: 16px;
      padding: 14px 18px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      max-width: 100%;
    }

    .gchat-quote-box {
      display: flex;
      background-color: var(--quote-bg);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      margin-bottom: 10px;
      overflow: hidden;
    }

    .gchat-quote-bar {
      width: 4px;
      background-color: var(--google-blue);
      flex-shrink: 0;
    }

    .gchat-quote-content {
      padding: 6px 12px;
      font-size: 12px;
    }

    .gchat-quote-header {
      display: flex;
      align-items: center;
      gap: 5px;
      color: var(--google-blue);
      font-weight: 600;
      margin-bottom: 2px;
    }

    .gchat-quote-snippet {
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 600px;
    }

    .gchat-text {
      font-size: 14px;
      color: var(--text-main);
      line-height: 1.55;
      word-break: break-word;
    }

    .gchat-mention {
      background-color: var(--mention-bg);
      color: var(--mention-text);
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 500;
      font-size: 13px;
    }

    .gchat-link {
      color: var(--google-blue);
      text-decoration: underline;
    }

    .gchat-code {
      background-color: var(--code-bg);
      padding: 2px 5px;
      border-radius: 4px;
      font-family: Consolas, Menlo, Monaco, monospace;
      font-size: 12.5px;
    }

    .gchat-media-grid {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 12px;
    }

    .gchat-media-wrapper {
      position: relative;
      cursor: pointer;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--border-card);
      max-width: 680px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.06);
      transition: transform 0.2s ease;
    }

    .gchat-media-wrapper:hover {
      transform: scale(1.005);
    }

    .gchat-media-wrapper img {
      width: 100%;
      height: auto;
      display: block;
    }

    .gchat-zoom-badge {
      position: absolute;
      bottom: 8px;
      right: 8px;
      background: rgba(0,0,0,0.7);
      color: white;
      font-size: 10.5px;
      padding: 3px 8px;
      border-radius: 6px;
      opacity: 0;
      transition: opacity 0.2s;
    }

    .gchat-media-wrapper:hover .gchat-zoom-badge {
      opacity: 1;
    }

    .gchat-files-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 10px;
    }

    .gchat-file-card {
      display: flex;
      align-items: center;
      gap: 10px;
      background-color: var(--bg-surface);
      border: 1px solid var(--border-card);
      border-radius: 8px;
      padding: 8px 12px;
      text-decoration: none;
      color: var(--text-main);
      max-width: 480px;
      transition: background 0.15s ease;
    }

    .gchat-file-card:hover {
      background-color: var(--bg-hover);
    }

    .gchat-file-icon { font-size: 20px; }

    .gchat-file-details {
      display: flex;
      flex-direction: column;
    }

    .gchat-file-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--google-blue);
    }

    .gchat-file-sub {
      font-size: 11px;
      color: var(--text-muted);
    }

    .gchat-thread-bar {
      margin-top: 8px;
    }

    .gchat-thread-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background-color: var(--bg-card);
      border: 1px solid var(--border-card);
      padding: 4px 12px;
      border-radius: 16px;
      font-size: 12px;
      font-weight: 500;
      color: var(--google-blue);
      box-shadow: 0 1px 2px rgba(0,0,0,0.03);
    }

    .gchat-reactions-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    .gchat-reaction-chip {
      font-size: 12px;
      padding: 3px 10px;
      background-color: var(--reaction-bg);
      border: 1px solid var(--reaction-border);
      border-radius: 16px;
      color: var(--text-main);
    }

    .lightbox-modal {
      display: none;
      position: fixed;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      background: rgba(0,0,0,0.88);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .lightbox-modal.active { display: flex; }

    .lightbox-content {
      max-width: 90vw; max-height: 90vh;
      object-fit: contain;
      border-radius: 8px;
      box-shadow: 0 12px 35px rgba(0,0,0,0.6);
    }

    .lightbox-close {
      position: absolute;
      top: 20px; right: 26px;
      color: white; font-size: 32px;
      font-weight: bold; cursor: pointer;
    }

    .no-results {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
      font-size: 14px;
    }

    @media print {
      body { background-color: #ffffff; color: #000000; }
      header.gchat-topbar { position: static; box-shadow: none; border-bottom: 2px solid #00832d; }
      .topbar-actions, .lightbox-modal, .gchat-zoom-badge { display: none !important; }
      .gchat-card-bubble { border: 1px solid #cccccc; box-shadow: none; page-break-inside: avoid; }
      .gchat-card-container { page-break-inside: avoid; margin-bottom: 12px; }
      .gchat-media-wrapper { max-width: 100%; border: 1px solid #cccccc; }
    }
  </style>
</head>
<body>
  <header class="gchat-topbar">
    <div class="topbar-left">
      <div class="gchat-brand-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </div>
      <div class="topbar-titles">
        <h1>${esc(title)}</h1>
        <p>Exported ${esc(exportDate)} &bull; ${messages.length} messages &bull; ${totalImages} media files</p>
      </div>
    </div>
    <div class="topbar-actions">
      <input type="text" id="search-input" class="gchat-search" placeholder="Search in conversation..." />
      <button id="theme-btn" class="gchat-btn" type="button">🌓 Toggle Theme</button>
      <button class="gchat-btn" onclick="window.print()" type="button">🖨 Print</button>
    </div>
  </header>

  <main class="gchat-stream" id="chat-stream">
    ${messagesHtml}
    <div id="no-results-msg" class="no-results" style="display: none;">
      No messages matching your search query.
    </div>
  </main>

  <div id="lightbox" class="lightbox-modal" onclick="closeLightbox()">
    <span class="lightbox-close">&times;</span>
    <img id="lightbox-img" class="lightbox-content" src="" alt="Enlarged media" />
  </div>

  <script>
    const searchInput = document.getElementById('search-input');
    const rows = document.querySelectorAll('.gchat-card-container');
    const noResults = document.getElementById('no-results-msg');

    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      let matchCount = 0;

      rows.forEach(row => {
        const rowEl = row.querySelector('.gchat-msg-row');
        const sender = rowEl ? (rowEl.getAttribute('data-sender') || '') : '';
        const content = rowEl ? (rowEl.getAttribute('data-content') || '') : '';
        if (!q || sender.includes(q) || content.includes(q)) {
          row.style.display = 'block';
          matchCount++;
        } else {
          row.style.display = 'none';
        }
      });

      noResults.style.display = matchCount === 0 ? 'block' : 'none';
    });

    const themeBtn = document.getElementById('theme-btn');
    themeBtn.addEventListener('click', () => {
      const isDark = document.body.getAttribute('data-theme') === 'dark';
      document.body.setAttribute('data-theme', isDark ? 'light' : 'dark');
    });

    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');

    function openLightbox(src) {
      lightboxImg.src = src;
      lightbox.classList.add('active');
    }

    function closeLightbox() {
      lightbox.classList.remove('active');
      lightboxImg.src = '';
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });
  </script>
</body>
</html>`;
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  function checkCancel() {
    if (isCancelRequested) abort();
  }

  function abort() {
    throw new DOMException('Export cancelled', 'AbortError');
  }

  function getIsoDateString() {
    return new Date().toISOString().slice(0, 10);
  }

  function getPrettyDateString() {
    return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function sanitizeFilename(name) {
    return (name || 'Google_Chat_Export')
      .replace(/[\/\\?%*:|"<>]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 50);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function triggerFileDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 90000);
  }

  function reportProgress(data) {
    sendPopupMessage('STATUS_UPDATE', data);
  }

  function reportSuccess(data) {
    sendPopupMessage('EXPORT_COMPLETE', data);
  }

  function sendPopupMessage(type, data) {
    try {
      chrome.runtime.sendMessage({ type, data }).catch(() => {});
    } catch (_) {}
  }

})();
