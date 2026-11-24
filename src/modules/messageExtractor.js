/**
 * @file messageExtractor.js
 * @module MessageExtractor
 * @description Extracts and normalises parent messages from the Google Chat DOM
 * for the Google Chat Exporter Chrome Extension.
 *
 * Key responsibilities:
 *  - Discover parent (non-reply) messages in the live DOM
 *  - Normalise each message into a plain JS object
 *  - Handle virtualised / infinite-scroll message lists via MutationObserver
 *  - Deduplicate by stable message ID
 *  - Expose a clean public API: extractAll, extractVisible, getMessageById,
 *    onNewMessages, destroy
 *
 * Google Chat DOM landmarks (as of 2024 – subject to change):
 *  - Message list container  : [jsname="xySENc"] or [role="list"]
 *  - Each message row        : [data-message-id] or [role="listitem"]
 *  - Sender name             : [data-sender-id], .VfPpkd-rymPhb, or <h3>/<b> inside the row
 *  - Sender avatar           : img inside [data-hovercard-id] or .SFknad img
 *  - Timestamp               : <time> element or [data-absolute-time-ms]
 *  - Message body            : [jsname="r4nke"] or .oUJrbe
 *  - Reactions               : [jsname="DmVWLc"] emoji chip group
 *  - Thread/reply chip       : button containing "repl" text or [jsname="Eoitje"]
 *  - Edited marker           : text node or element containing "(edited)" / "Edited"
 *  - Attachments             : [data-attachment-id], <img> not inside avatar, <a> file links
 */

'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lightweight unique-id counter used as a fallback when no DOM id exists. */
let _idCounter = 0;
const _genId = () => `gc-msg-${Date.now()}-${++_idCounter}`;

/**
 * Safely query a selector, returning null instead of throwing.
 * @param {Element} root
 * @param {string} selector
 * @returns {Element|null}
 */
const $q = (root, selector) => {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
};

/**
 * Safely query all matching elements.
 * @param {Element} root
 * @param {string} selector
 * @returns {Element[]}
 */
const $qa = (root, selector) => {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
};

/**
 * Returns the trimmed text content of an element, or '' if null.
 * @param {Element|null} el
 * @returns {string}
 */
const textOf = (el) => (el ? el.textContent.trim() : '');

/**
 * Convert a millisecond epoch string/number to an ISO-8601 timestamp.
 * Returns null if the value is falsy or not parseable.
 * @param {string|number|null|undefined} ms
 * @returns {string|null}
 */
const msToISO = (ms) => {
  if (!ms) return null;
  const n = Number(ms);
  if (Number.isNaN(n) || n <= 0) return null;
  return new Date(n).toISOString();
};

/**
 * Walk the DOM tree of a message body and produce a Markdown-flavoured
 * plain-text representation that preserves:
 *   **bold**, _italic_, `code`, ```code blocks```, @mentions, and hyperlinks.
 *
 * @param {Element} bodyEl - The root element of the message body.
 * @returns {string}
 */
function extractFormattedText(bodyEl) {
  if (!bodyEl) return '';

  /**
   * Recursive walker.
   * @param {Node} node
   * @returns {string}
   */
  function walk(node) {
    // Text node – return its value directly.
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = /** @type {Element} */ (node);
    const tag = el.tagName.toUpperCase();
    const children = Array.from(el.childNodes).map(walk).join('');

    switch (tag) {
      case 'B':
      case 'STRONG':
        return `**${children}**`;

      case 'I':
      case 'EM':
        return `_${children}_`;

      case 'S':
      case 'STRIKE':
      case 'DEL':
        return `~~${children}~~`;

      case 'CODE': {
        // If CODE is inside a PRE treat it as a code block; handled by PRE.
        return el.closest('pre') ? children : `\`${children}\``;
      }

      case 'PRE': {
        const lang = el.getAttribute('data-language') || '';
        return `\`\`\`${lang}\n${children}\n\`\`\``;
      }

      case 'A': {
        const href = el.getAttribute('href') || '';
        // @mention chips in Google Chat have a data-mention attribute.
        const mention = el.getAttribute('data-mention') || el.dataset?.hovercardId;
        if (mention) return `@${children}`;
        return href ? `[${children}](${href})` : children;
      }

      case 'SPAN': {
        // Google Chat renders @mentions as chips with specific attributes.
        if (el.hasAttribute('data-member-id') || el.hasAttribute('data-mention')) {
          return `@${children}`;
        }
        // Chip for room references (@room, @here, etc.).
        if (el.getAttribute('role') === 'button' && el.closest('[data-annotation-type]')) {
          return `@${children}`;
        }
        return children;
      }

      case 'BR':
        return '\n';

      case 'P':
      case 'DIV':
        // Block-level elements: add newline after if content is non-empty.
        return children ? `${children}\n` : '';

      case 'UL':
      case 'OL':
        return `${children}\n`;

      case 'LI':
        return `- ${children}\n`;

      case 'BLOCKQUOTE':
        return children
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');

      default:
        return children;
    }
  }

  return walk(bodyEl).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract the reactions from a message row element.
 *
 * Google Chat renders reactions as a row of "emoji chips" each containing:
 *   - an emoji glyph (img alt or text)
 *   - a count label
 *   - (optionally) user IDs/names in aria-label or data attributes
 *
 * @param {Element} rowEl
 * @returns {Array<{emoji: string, count: number, users: string[]}>}
 */
function extractReactions(rowEl) {
  const reactions = [];

  // Primary selector: reaction chip group containers.
  // Google Chat uses jsname="DmVWLc" for the emoji reaction row or
  // aria-label that includes "reacted" text on each chip.
  const chipSelectors = [
    '[jsname="DmVWLc"] [role="button"]',
    '[data-reaction-emoji]',
    '.T4LgNb',  // observed class for reaction chips
    '[aria-label*="reacted"]',
  ];

  let chips = [];
  for (const sel of chipSelectors) {
    chips = $qa(rowEl, sel);
    if (chips.length > 0) break;
  }

  for (const chip of chips) {
    // Try to get the emoji from an img alt, then text content, then data attr.
    const emojiImg = $q(chip, 'img');
    const emoji =
      chip.getAttribute('data-reaction-emoji') ||
      (emojiImg && emojiImg.getAttribute('alt')) ||
      (chip.firstChild?.nodeType === Node.TEXT_NODE
        ? chip.firstChild.textContent.trim()
        : '') ||
      textOf($q(chip, '[data-emoji]')) ||
      '';

    if (!emoji) continue;

    // Count: last text node or dedicated count element.
    const countEl = $q(chip, '.count, [data-count], .BH49nc');
    const rawCount = countEl
      ? textOf(countEl)
      : chip.getAttribute('data-count') || '';
    const count = parseInt(rawCount, 10) || 1;

    // Users: may be encoded in aria-label like "Alice, Bob and 3 others reacted with 👍"
    const ariaLabel = chip.getAttribute('aria-label') || '';
    const users = [];
    const beforeReacted = ariaLabel.split(/\s+reacted/i)[0];
    if (beforeReacted) {
      // Split on commas and "and".
      beforeReacted
        .split(/,\s*|\s+and\s+/i)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((name) => {
          if (!/^\d+\s+other/i.test(name)) users.push(name);
        });
    }

    reactions.push({ emoji, count, users });
  }

  return reactions;
}

/**
 * Extract basic attachment metadata from a message row.
 * Full attachment detail (download URL, file type, thumbnail blob, etc.) is
 * handled by the companion `attachmentExtractor` module; here we capture
 * only what is immediately visible in the DOM.
 *
 * @param {Element} rowEl
 * @returns {Array<{type: string, url: string|null, name: string|null, attachmentId: string|null, element: Element}>}
 */
function extractAttachments(rowEl) {
  const attachments = [];
  const seen = new Set();

  const push = (obj) => {
    const key = obj.url || obj.name || obj.attachmentId;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    attachments.push(obj);
  };

  // ── Images (not avatars) ──────────────────────────────────────────────────
  const images = $qa(rowEl, 'img[src]:not([data-hovercard-id] img):not(.SFknad img)');
  for (const img of images) {
    // Skip tiny tracking pixels and emoji images.
    const w = parseInt(img.getAttribute('width') || img.naturalWidth || '0', 10);
    const h = parseInt(img.getAttribute('height') || img.naturalHeight || '0', 10);
    if ((w > 0 && w < 20) || (h > 0 && h < 20)) continue;
    // Skip Google emoji CDN images (chat emoji).
    const src = img.src || '';
    if (/fonts\.gstatic\.com\/s\/e\/notoemoji/i.test(src)) continue;

    push({
      type: 'image',
      url: src,
      name: img.getAttribute('alt') || null,
      attachmentId: img.closest('[data-attachment-id]')?.getAttribute('data-attachment-id') || null,
      element: img,
    });
  }

  // ── Uploaded file cards ───────────────────────────────────────────────────
  const fileCards = $qa(rowEl, '[data-attachment-id], [jsname="q9ME8e"], .fO1Lid');
  for (const card of fileCards) {
    const attachmentId = card.getAttribute('data-attachment-id') || null;
    const nameEl = $q(card, '.filename, [data-filename], .ZeVbfd, .KF4T6b');
    const linkEl = $q(card, 'a[href]');
    push({
      type: 'file',
      url: linkEl?.href || null,
      name: textOf(nameEl) || null,
      attachmentId,
      element: card,
    });
  }

  // ── Hyperlink previews / link unfurls ─────────────────────────────────────
  const linkPreviews = $qa(rowEl, '[data-url], .yt-simple-endpoint, .Fhgmsd');
  for (const preview of linkPreviews) {
    const url = preview.getAttribute('data-url') || preview.getAttribute('href') || null;
    if (!url) continue;
    push({
      type: 'link_preview',
      url,
      name: textOf($q(preview, '.preview-title, .H7DPT, [data-title]')) || null,
      attachmentId: null,
      element: preview,
    });
  }

  return attachments;
}

/**
 * Determine whether a DOM row represents a *parent* message (not a thread reply).
 * Thread replies appear inside a collapsed/expanded thread drawer which Google Chat
 * typically nests under a sibling or child container distinct from the main list.
 *
 * Heuristics used (all must pass):
 *  1. The element has a data-message-id or role="listitem" in the main list.
 *  2. It is NOT inside a thread reply container ([data-is-reply="true"],
 *     [jsname="oLhsH"], or similar known reply wrappers).
 *
 * @param {Element} el
 * @returns {boolean}
 */
function isParentMessage(el) {
  // Reject elements that are nested inside a known reply drawer/thread container.
  const replyContainerSelectors = [
    '[data-is-reply="true"]',
    '[jsname="oLhsH"]',    // thread reply panel
    '[jsname="Eoitje"]',   // inner thread message list
    '.thread-messages',
    '[data-thread-container]',
  ];

  for (const sel of replyContainerSelectors) {
    if (el.closest(sel)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Normalised message shape
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NormalisedMessage
 * @property {string}   id           - Stable message ID (from DOM or generated).
 * @property {string}   sender       - Display name of the sender.
 * @property {string|null} avatarUrl - URL of the sender's avatar image.
 * @property {string|null} senderId  - Sender's Google Chat user ID (if available).
 * @property {string|null} timestamp - ISO-8601 timestamp string.
 * @property {string}   text         - Formatted text content (Markdown-flavoured).
 * @property {Array}    reactions    - [{emoji, count, users}]
 * @property {Array}    attachments  - [{type, url, name, attachmentId, element}]
 * @property {boolean}  edited       - True if the message was edited.
 * @property {boolean}  hasThread    - True if the message has threaded replies.
 * @property {number}   replyCount   - Number of thread replies (0 if unknown).
 * @property {Element}  element      - Raw DOM element reference.
 */

// ---------------------------------------------------------------------------
// MessageExtractor class
// ---------------------------------------------------------------------------

export class MessageExtractor {
  /**
   * @param {Object} [options]
   * @param {Element} [options.containerEl] - Root element to search inside.
   *   Defaults to document.body.
   * @param {boolean} [options.debug] - Enable console debug output.
   */
  constructor(options = {}) {
    /** @type {Element} */
    this._container = options.containerEl || document.body;

    /** @type {boolean} */
    this._debug = Boolean(options.debug);

    /**
     * Internal store: messageId → NormalisedMessage
     * @type {Map<string, NormalisedMessage>}
     */
    this._messages = new Map();

    /**
     * Set of callbacks registered via onNewMessages().
     * @type {Set<function(NormalisedMessage[]): void>}
     */
    this._newMessageCallbacks = new Set();

    /** @type {MutationObserver|null} */
    this._observer = null;

    // Start observing immediately so messages added after construction are captured.
    this._startObserver();

    this._log('MessageExtractor initialised.');
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Emit a debug log if debug mode is on.
   * @param {...any} args
   */
  _log(...args) {
    if (this._debug) console.debug('[MessageExtractor]', ...args);
  }

  /**
   * Locate the best-guess message list scroll container inside this._container.
   * Returns document.body as a safe fallback.
   * @returns {Element}
   */
  _findScrollContainer() {
    const candidates = [
      $q(this._container, '[jsname="xySENc"]'),   // main message list (observed)
      $q(this._container, '[role="list"]'),
      $q(this._container, '[role="main"]'),
      $q(this._container, '[data-view-type="STREAM"]'),
    ];
    return candidates.find(Boolean) || this._container;
  }

  /**
   * Locate all candidate message row elements in the given root.
   * @param {Element} root
   * @returns {Element[]}
   */
  _findMessageRows(root) {
    const rowSelectors = [
      '[data-message-id]',
      '[role="listitem"][data-id]',
      '[jsname="N07Ab"]',   // observed row wrapper jsname
      '.GDhqjd',            // observed row class
    ];

    for (const sel of rowSelectors) {
      const rows = $qa(root, sel);
      if (rows.length > 0) return rows;
    }

    // Final fallback: role="listitem" (may include non-message items).
    return $qa(root, '[role="listitem"]');
  }

  /**
   * Parse a single message row element into a NormalisedMessage object.
   * Returns null if the row does not look like a valid parent message.
   *
   * @param {Element} rowEl
   * @returns {NormalisedMessage|null}
   */
  _parseRow(rowEl) {
    if (!rowEl || !(rowEl instanceof Element)) return null;
    if (!isParentMessage(rowEl)) return null;

    // ── Message ID ─────────────────────────────────────────────────────────
    const id =
      rowEl.getAttribute('data-message-id') ||
      rowEl.getAttribute('data-id') ||
      rowEl.id ||
      _genId();

    // ── Sender ─────────────────────────────────────────────────────────────
    const senderId =
      rowEl.getAttribute('data-sender-id') ||
      $q(rowEl, '[data-sender-id]')?.getAttribute('data-sender-id') ||
      $q(rowEl, '[data-hovercard-id]')?.getAttribute('data-hovercard-id') ||
      null;

    // Sender name: try several selectors in preference order.
    const senderEl =
      $q(rowEl, '[data-sender-name]') ||
      $q(rowEl, '.VfPpkd-rymPhb') ||   // Material chip
      $q(rowEl, '.nF6pT') ||            // observed name class
      $q(rowEl, 'h3') ||
      $q(rowEl, 'b');
    const sender =
      senderEl?.getAttribute('data-sender-name') ||
      textOf(senderEl) ||
      senderId ||
      'Unknown';

    // Avatar URL.
    const avatarImgEl =
      $q(rowEl, '[data-hovercard-id] img') ||
      $q(rowEl, '.SFknad img') ||
      $q(rowEl, '[jsname="YjVTbd"] img') ||
      $q(rowEl, '[data-sender-id] img');
    const avatarUrl = avatarImgEl?.src || avatarImgEl?.getAttribute('data-src') || null;

    // ── Timestamp ──────────────────────────────────────────────────────────
    let timestamp = null;

    // Try <time> element first (most reliable).
    const timeEl = $q(rowEl, 'time');
    if (timeEl) {
      const dt =
        timeEl.getAttribute('datetime') ||
        timeEl.getAttribute('data-absolute-time-ms');
      timestamp = dt
        ? (/^\d+$/.test(dt) ? msToISO(dt) : new Date(dt).toISOString())
        : null;
    }

    // Fallback: data-absolute-time-ms on any element.
    if (!timestamp) {
      const tsEl = $q(rowEl, '[data-absolute-time-ms]');
      if (tsEl) timestamp = msToISO(tsEl.getAttribute('data-absolute-time-ms'));
    }

    // Fallback: data-timestamp (seconds epoch).
    if (!timestamp) {
      const tsEl = $q(rowEl, '[data-timestamp]');
      if (tsEl) {
        const raw = tsEl.getAttribute('data-timestamp');
        // Google sometimes uses seconds, sometimes milliseconds.
        const n = Number(raw);
        timestamp = msToISO(n > 1e12 ? n : n * 1000);
      }
    }

    // ── Message body / text ────────────────────────────────────────────────
    const bodyEl =
      $q(rowEl, '[jsname="r4nke"]') ||
      $q(rowEl, '.oUJrbe') ||
      $q(rowEl, '[data-message-text]') ||
      $q(rowEl, '.Im5df') ||    // observed body class
      $q(rowEl, '.GV3Sre');     // another observed body class
    const text = extractFormattedText(bodyEl);

    // ── Edited flag ────────────────────────────────────────────────────────
    const editedEl =
      $q(rowEl, '[data-is-edited]') ||
      $q(rowEl, '.edited-marker') ||
      $q(rowEl, '[jsname="oR5oLe"]');
    let edited = Boolean(editedEl);
    if (!edited) {
      // Some versions show "(edited)" as a text node inside the body.
      edited = /\(edited\)|Edited/i.test(rowEl.textContent || '');
    }

    // ── Thread / reply count ───────────────────────────────────────────────
    const replyChip =
      $q(rowEl, '[jsname="Eoitje"]') ||
      $q(rowEl, '[data-thread-id]') ||
      Array.from($qa(rowEl, 'button')).find((b) =>
        /repl(y|ies)|thread/i.test(b.textContent || b.getAttribute('aria-label') || '')
      );

    const hasThread = Boolean(replyChip);
    let replyCount = 0;
    if (replyChip) {
      const countMatch = (replyChip.textContent || '').match(/(\d+)/);
      replyCount = countMatch ? parseInt(countMatch[1], 10) : 0;
    }

    // ── Reactions ──────────────────────────────────────────────────────────
    const reactions = extractReactions(rowEl);

    // ── Attachments ────────────────────────────────────────────────────────
    const attachments = extractAttachments(rowEl);

    return {
      id,
      sender,
      avatarUrl,
      senderId,
      timestamp,
      text,
      reactions,
      attachments,
      edited,
      hasThread,
      replyCount,
      element: rowEl,
    };
  }

  /**
   * Process an array of raw row elements, parse each one, deduplicate against
   * the internal store, and return only the newly discovered messages.
   *
   * @param {Element[]} rows
   * @returns {NormalisedMessage[]}
   */
  _processRows(rows) {
    const newMessages = [];

    for (const row of rows) {
      const msg = this._parseRow(row);
      if (!msg) continue;

      if (!this._messages.has(msg.id)) {
        this._messages.set(msg.id, msg);
        newMessages.push(msg);
      } else {
        // Update the stored entry in case the DOM was mutated (edit, reaction).
        this._messages.set(msg.id, msg);
      }
    }

    return newMessages;
  }

  /**
   * Notify all registered onNewMessages callbacks with the given messages.
   * Each callback is invoked in a try/catch to prevent one bad callback from
   * breaking the observer loop.
   *
   * @param {NormalisedMessage[]} messages
   */
  _notifyCallbacks(messages) {
    if (messages.length === 0) return;
    for (const cb of this._newMessageCallbacks) {
      try {
        cb(messages);
      } catch (err) {
        console.error('[MessageExtractor] onNewMessages callback threw:', err);
      }
    }
  }

  /**
   * Start a MutationObserver on the scroll container to detect:
   *   - New messages rendered as the user scrolls (virtualisation).
   *   - Messages added in real-time while the chat is open.
   *   - Mutations to existing messages (edits, reactions).
   */
  _startObserver() {
    if (this._observer) return; // Already running.

    const target = this._findScrollContainer();
    this._log('Observing mutations on', target);

    this._observer = new MutationObserver((mutations) => {
      /** @type {Set<Element>} */
      const candidateRows = new Set();

      for (const mutation of mutations) {
        // Added nodes: check each for being (or containing) a message row.
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = /** @type {Element} */ (node);

          // The node itself might be a message row.
          if (
            el.hasAttribute('data-message-id') ||
            el.getAttribute('role') === 'listitem'
          ) {
            candidateRows.add(el);
          }

          // Or it might contain message rows (batch render).
          for (const row of this._findMessageRows(el)) {
            candidateRows.add(row);
          }
        }

        // Changed attributes on existing rows (edits, reactions, etc.).
        if (mutation.type === 'attributes') {
          const target = /** @type {Element} */ (mutation.target);
          const row = target.closest('[data-message-id], [role="listitem"]');
          if (row) candidateRows.add(row);
        }
      }

      if (candidateRows.size === 0) return;

      this._log(`MutationObserver: ${candidateRows.size} candidate row(s) detected.`);
      const newMsgs = this._processRows([...candidateRows]);
      this._notifyCallbacks(newMsgs);
    });

    this._observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-message-id',
        'data-reaction-emoji',
        'data-is-edited',
        'data-absolute-time-ms',
      ],
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Perform a full extraction of **all** message rows currently present in
   * the DOM (visible or not, since Google Chat may keep off-screen rows in
   * the DOM while only hiding them).
   *
   * For virtualised lists where rows are removed from the DOM when off-screen,
   * you must scroll through the list first (or use the companion scrollHelper
   * utility) so that all messages are rendered at least once and captured by
   * the MutationObserver.
   *
   * @returns {NormalisedMessage[]} Array of all known messages, oldest first.
   */
  extractAll() {
    this._log('extractAll() called.');
    const rows = this._findMessageRows(this._container);
    this._log(`Found ${rows.length} row(s) in DOM.`);
    this._processRows(rows); // Populates / refreshes this._messages.
    return this._getStoredMessages();
  }

  /**
   * Extract only the message rows that are **currently visible** in the
   * viewport.  Useful for a quick snapshot without scrolling.
   *
   * @returns {NormalisedMessage[]}
   */
  extractVisible() {
    this._log('extractVisible() called.');
    const allRows = this._findMessageRows(this._container);

    const visibleRows = allRows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight
      );
    });

    this._log(`${visibleRows.length} visible row(s) out of ${allRows.length} total.`);
    this._processRows(visibleRows);
    return visibleRows
      .map((row) => {
        const id =
          row.getAttribute('data-message-id') ||
          row.getAttribute('data-id') ||
          row.id;
        return id ? this._messages.get(id) : undefined;
      })
      .filter(Boolean);
  }

  /**
   * Retrieve a previously-extracted message by its ID.
   *
   * @param {string} id
   * @returns {NormalisedMessage|undefined}
   */
  getMessageById(id) {
    return this._messages.get(id);
  }

  /**
   * Register a callback that is invoked whenever new messages are discovered
   * (either by an explicit extract call or by the MutationObserver).
   *
   * The callback receives an array of NormalisedMessage objects that were NOT
   * previously in the internal store (truly new, deduplicated).
   *
   * @param {function(NormalisedMessage[]): void} callback
   * @returns {function(): void} Unsubscribe function – call it to remove this callback.
   */
  onNewMessages(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('[MessageExtractor] onNewMessages: callback must be a function.');
    }
    this._newMessageCallbacks.add(callback);
    this._log('onNewMessages: callback registered. Total:', this._newMessageCallbacks.size);

    // Return an unsubscribe function.
    return () => {
      this._newMessageCallbacks.delete(callback);
      this._log('onNewMessages: callback unregistered.');
    };
  }

  /**
   * Stop the MutationObserver, clear all callbacks and internal state.
   * Call this when the exporter is closed or the page is navigated away.
   */
  destroy() {
    this._log('destroy() called – tearing down MessageExtractor.');

    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }

    this._newMessageCallbacks.clear();
    this._messages.clear();
  }

  // ── Private internal getters ──────────────────────────────────────────────

  /**
   * Return all stored messages sorted by timestamp (ascending), with
   * messages lacking a timestamp placed at the end.
   *
   * @returns {NormalisedMessage[]}
   */
  _getStoredMessages() {
    const msgs = [...this._messages.values()];
    msgs.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return new Date(a.timestamp) - new Date(b.timestamp);
    });
    return msgs;
  }

  // ── Convenience getters ───────────────────────────────────────────────────

  /**
   * Total number of unique messages currently in the internal store.
   * @returns {number}
   */
  get size() {
    return this._messages.size;
  }

  /**
   * Whether the MutationObserver is currently active.
   * @returns {boolean}
   */
  get isObserving() {
    return this._observer !== null;
  }
}
