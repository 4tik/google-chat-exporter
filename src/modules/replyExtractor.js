/**
 * @file replyExtractor.js
 * @module ReplyExtractor
 * @description Extracts individual reply messages belonging to specific threads in Google Chat.
 * Preserves sender details, exact timestamps, formatted text, inline media, attachments,
 * and maintains chronological ordering within each thread.
 */

'use strict';

/**
 * Safely query a single selector
 * @param {Element} root
 * @param {string} sel
 * @returns {Element|null}
 */
const $q = (root, sel) => {
  try { return root.querySelector(sel); } catch (_) { return null; }
};

/**
 * Safely query all matching elements
 * @param {Element} root
 * @param {string} sel
 * @returns {Element[]}
 */
const $qa = (root, sel) => {
  try { return Array.from(root.querySelectorAll(sel)); } catch (_) { return []; }
};

/**
 * Extract trimmed text content
 * @param {Element|null} el
 * @returns {string}
 */
const textOf = (el) => (el ? el.textContent.trim() : '');

export class ReplyExtractor {
  /**
   * @param {Object} [options]
   * @param {import('./duplicateManager.js').DuplicateManager} [options.duplicateManager]
   * @param {boolean} [options.debug=false]
   */
  constructor(options = {}) {
    this._duplicateManager = options.duplicateManager || null;
    this._debug = Boolean(options.debug);

    /**
     * Map of replyId -> Reply object
     * @type {Map<string, Object>}
     */
    this._replies = new Map();

    /**
     * Map of threadId -> Array of Reply objects
     * @type {Map<string, Array<Object>>}
     */
    this._threadToReplies = new Map();
  }

  /**
   * Internal logging
   * @private
   */
  _log(...args) {
    if (this._debug) console.debug('[ReplyExtractor]', ...args);
  }

  /**
   * Extracts all reply messages found within a thread DOM container.
   *
   * @param {Element} threadContainerEl - DOM container holding thread replies
   * @param {string} threadId - Identifier of the thread
   * @param {string} parentMessageId - Identifier of the parent message
   * @returns {Array<Object>} Array of Reply objects
   */
  extractRepliesFromContainer(threadContainerEl, threadId, parentMessageId) {
    if (!threadContainerEl || !threadId) return [];

    // Reply row selectors in Google Chat
    const replyRowSelectors = [
      '[data-is-reply="true"]',
      '[data-message-id]',
      '[role="listitem"]',
      '.thread-reply-row',
      '[jsname="oLhsH"] [role="listitem"]',
      '[jsname="Eoitje"] > div'
    ];

    let rowElements = [];
    for (const sel of replyRowSelectors) {
      const found = $qa(threadContainerEl, sel);
      // Filter out the parent message if it appears inside the container header
      rowElements = found.filter(el => {
        const mid = el.getAttribute('data-message-id') || el.getAttribute('data-id');
        return mid !== parentMessageId;
      });
      if (rowElements.length > 0) break;
    }

    const replies = [];
    let replyIndex = 0;

    for (const rowEl of rowElements) {
      replyIndex++;
      const reply = this.extractReplyFromRow(rowEl, threadId, parentMessageId, replyIndex);
      if (reply) {
        // Deduplicate using duplicateManager
        if (this._duplicateManager) {
          if (!this._duplicateManager.trackReply(reply.id)) {
            continue;
          }
        }
        replies.push(reply);
        this._replies.set(reply.id, reply);
      }
    }

    // Sort chronologically within the thread
    replies.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return new Date(a.timestamp) - new Date(b.timestamp);
    });

    this._threadToReplies.set(threadId, replies);
    this._log(`Extracted ${replies.length} replies for thread ${threadId}`);

    return replies;
  }

  /**
   * Extracts a single reply object from a DOM row element.
   *
   * @param {Element} rowEl
   * @param {string} threadId
   * @param {string} parentMessageId
   * @param {number} [fallbackIndex=1]
   * @returns {Object}
   */
  extractReplyFromRow(rowEl, threadId, parentMessageId, fallbackIndex = 1) {
    if (!rowEl) return null;

    const id = rowEl.getAttribute('data-message-id') ||
               rowEl.getAttribute('data-id') ||
               `reply_${threadId}_${fallbackIndex}_${Date.now()}`;

    // Sender Extraction
    const sender = this._extractSender(rowEl);

    // Text & HTML Extraction
    const { text, textHtml } = this._extractBody(rowEl);

    // Timestamp
    const timestamp = this._extractTimestamp(rowEl);

    // Edited status
    const edited = Boolean(rowEl.querySelector('[aria-label*="edited" i], .edited-marker')) ||
                   /edited/i.test(rowEl.textContent && rowEl.textContent.slice(-50));

    // Reactions
    const reactions = this._extractReactions(rowEl);

    // Attachments
    const attachments = this._extractAttachments(rowEl);

    return {
      id,
      threadId,
      parentMessageId,
      sender,
      text,
      textHtml,
      timestamp,
      edited,
      reactions,
      attachments,
      element: rowEl
    };
  }

  /**
   * Extracts sender information from a reply element.
   * @private
   */
  _extractSender(rowEl) {
    const nameSelectors = [
      '[data-hovercard-id]',
      '[data-sender-id]',
      '.VfPpkd-rymPhb',
      'h3',
      'b',
      '[role="heading"]',
      '.sender-name'
    ];

    let name = '';
    for (const sel of nameSelectors) {
      const el = $q(rowEl, sel);
      if (el && textOf(el)) {
        name = textOf(el);
        break;
      }
    }

    if (!name) {
      const avatarEl = $q(rowEl, 'img[alt]');
      if (avatarEl && avatarEl.getAttribute('alt')) {
        name = avatarEl.getAttribute('alt');
      }
    }

    const avatarImg = $q(rowEl, 'img[src*="googleusercontent.com"], img[src*="avatar"], .avatar img');
    const avatarUrl = avatarImg ? avatarImg.src : null;
    const senderId = rowEl.getAttribute('data-sender-id') || (name ? `user_${name.toLowerCase().replace(/\s+/g, '_')}` : 'unknown_sender');

    return {
      id: senderId,
      name: name || 'Participant',
      avatarUrl
    };
  }

  /**
   * Extracts text and HTML body from a reply row.
   * @private
   */
  _extractBody(rowEl) {
    const bodySelectors = [
      '[jsname="r4nke"]',
      '.oUJrbe',
      '[data-message-text]',
      '.message-body',
      '[dir="auto"]'
    ];

    let bodyEl = null;
    for (const sel of bodySelectors) {
      const el = $q(rowEl, sel);
      if (el) {
        bodyEl = el;
        break;
      }
    }

    if (!bodyEl) {
      return {
        text: textOf(rowEl),
        textHtml: rowEl.innerHTML ? rowEl.innerHTML.trim() : ''
      };
    }

    return {
      text: textOf(bodyEl),
      textHtml: bodyEl.innerHTML ? bodyEl.innerHTML.trim() : ''
    };
  }

  /**
   * Extracts timestamp from a reply row.
   * @private
   */
  _extractTimestamp(rowEl) {
    const timeEl = $q(rowEl, 'time, [data-absolute-time-ms], [data-timestamp]');
    if (timeEl) {
      const ms = timeEl.getAttribute('data-absolute-time-ms') || timeEl.getAttribute('data-timestamp');
      if (ms && !isNaN(Number(ms))) {
        return new Date(Number(ms)).toISOString();
      }
      const dt = timeEl.getAttribute('datetime');
      if (dt) return new Date(dt).toISOString();
      const txt = textOf(timeEl);
      if (txt) {
        const parsed = new Date(txt);
        if (!isNaN(parsed.getTime())) return parsed.toISOString();
      }
    }
    return new Date().toISOString();
  }

  /**
   * Extracts reactions from a reply row.
   * @private
   */
  _extractReactions(rowEl) {
    const reactions = [];
    const chipSelectors = ['[jsname="DmVWLc"] [role="button"]', '[data-reaction-emoji]', '[aria-label*="reacted"]'];

    let chips = [];
    for (const sel of chipSelectors) {
      chips = $qa(rowEl, sel);
      if (chips.length > 0) break;
    }

    for (const chip of chips) {
      const emojiImg = $q(chip, 'img');
      const emoji = chip.getAttribute('data-reaction-emoji') ||
                    (emojiImg && emojiImg.getAttribute('alt')) ||
                    textOf(chip) || '';
      if (!emoji) continue;

      const rawCount = chip.getAttribute('data-count') || textOf($q(chip, '.count, [data-count]')) || '1';
      const count = parseInt(rawCount, 10) || 1;
      reactions.push({ emoji, count, users: [] });
    }

    return reactions;
  }

  /**
   * Extracts attachments from a reply row.
   * @private
   */
  _extractAttachments(rowEl) {
    const attachments = [];
    const images = $qa(rowEl, 'img[src]:not([data-hovercard-id] img):not(.avatar img)');
    images.forEach(img => {
      const src = img.src || '';
      if (!src || /fonts\.gstatic\.com/i.test(src)) return;
      attachments.push({
        id: `att_reply_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'image',
        filename: img.getAttribute('alt') || 'image.png',
        url: src,
        previewUrl: src,
        isAccessible: true
      });
    });

    const fileLinks = $qa(rowEl, 'a[href][target="_blank"]');
    fileLinks.forEach(link => {
      const href = link.href || '';
      if (href.includes('google.com') || href.includes('drive')) {
        attachments.push({
          id: `att_file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: 'file',
          filename: textOf(link) || 'Shared Resource',
          url: href,
          previewUrl: null,
          isAccessible: true
        });
      }
    });

    return attachments;
  }

  /**
   * Registers a pre-formed reply object into the store.
   *
   * @param {Object} replyData
   * @returns {Object}
   */
  registerReply(replyData) {
    const reply = {
      id: replyData.id || `reply_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      threadId: replyData.threadId,
      parentMessageId: replyData.parentMessageId,
      sender: replyData.sender || { name: 'Unknown User' },
      text: replyData.text || '',
      textHtml: replyData.textHtml || '',
      timestamp: replyData.timestamp || new Date().toISOString(),
      edited: Boolean(replyData.edited),
      reactions: replyData.reactions || [],
      attachments: replyData.attachments || []
    };

    this._replies.set(reply.id, reply);

    if (reply.threadId) {
      const list = this._threadToReplies.get(reply.threadId) || [];
      if (!list.some(r => r.id === reply.id)) {
        list.push(reply);
        this._threadToReplies.set(reply.threadId, list);
      }
    }

    return reply;
  }

  /**
   * Gets all replies for a thread.
   * @param {string} threadId
   * @returns {Array<Object>}
   */
  getRepliesForThread(threadId) {
    return this._threadToReplies.get(threadId) || [];
  }

  /**
   * Gets a reply by its ID.
   * @param {string} replyId
   * @returns {Object|null}
   */
  getReplyById(replyId) {
    return this._replies.get(replyId) || null;
  }

  /**
   * Total number of replies extracted.
   * @returns {number}
   */
  get size() {
    return this._replies.size;
  }

  /**
   * Clears internal state.
   */
  clear() {
    this._replies.clear();
    this._threadToReplies.clear();
  }
}
