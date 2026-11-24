/**
 * @file dataNormalizer.js
 * @module DataNormalizer
 * @description Produces a consistent, validated, and sanitized normalized data
 * model from raw data extracted by the Google Chat Exporter Chrome Extension.
 *
 * Normalized message shape:
 * {
 *   id:          string,
 *   sender:      { id, name, avatarUrl },
 *   text:        string,
 *   textHtml:    string,          // sanitized – no <script>, <iframe>, etc.
 *   timestamp:   string,          // ISO 8601
 *   edited:      boolean,
 *   reactions:   [{ emoji, count, users }],
 *   attachments: [{ id, type, filename, url, previewUrl, isAccessible }],
 *   threads:     [{ id, parentMessageId, threadIndex, replyCount, replies }]
 * }
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** HTML tags that must be stripped during sanitisation. */
const DANGEROUS_TAGS = [
  'script', 'iframe', 'object', 'embed', 'form',
  'input', 'button', 'link', 'meta', 'style', 'base',
];

/**
 * Attributes that can carry executable or tracking payloads and must be
 * removed from any surviving element during sanitisation.
 */
const DANGEROUS_ATTRS = [
  'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur',
  'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress',
  'onmousedown', 'onmouseup', 'oncontextmenu', 'ondblclick',
  'javascript',   // catches href="javascript:…"
];

/** Sentinel value used for every missing / unknown field. */
const NULL_FIELD = null;

// ---------------------------------------------------------------------------
// Utility helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Coerces a value to a trimmed string or returns `null` when the value is
 * absent, empty, or not representable as a meaningful string.
 *
 * @param {*} value
 * @returns {string|null}
 */
function toStringOrNull(value) {
  if (value === NULL_FIELD || value === undefined) return NULL_FIELD;
  const str = String(value).trim();
  return str.length > 0 ? str : NULL_FIELD;
}

/**
 * Coerces a value to a finite integer or returns `null`.
 *
 * @param {*} value
 * @returns {number|null}
 */
function toIntOrNull(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : NULL_FIELD;
}

/**
 * Coerces a value to a boolean.  Treats the string `"false"` and `0` as
 * falsy.
 *
 * @param {*} value
 * @param {boolean} [defaultValue=false]
 * @returns {boolean}
 */
function toBoolean(value, defaultValue = false) {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === '0' || value === 'false') return false;
  return Boolean(value);
}

/**
 * Ensures the argument is an array.  Returns an empty array for any
 * non-array input (including `null` / `undefined`).
 *
 * @param {*} value
 * @returns {Array}
 */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  // Wrap a single object in an array rather than discarding it.
  return [value];
}

/**
 * Attempts to parse a timestamp from a variety of formats and returns an
 * ISO 8601 string.  Returns `null` when parsing fails.
 *
 * Supported inputs:
 *  - Unix epoch in milliseconds (number or numeric string)
 *  - Unix epoch in seconds (number < 1e10)
 *  - Any string that `Date` can parse (ISO, RFC 2822, locale strings, …)
 *  - `Date` objects
 *
 * @param {string|number|Date|null|undefined} raw
 * @returns {string|null}
 */
function normalizeTimestamp(raw) {
  if (raw === null || raw === undefined || raw === '') return NULL_FIELD;

  let date;

  if (raw instanceof Date) {
    date = raw;
  } else if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw.trim()))) {
    let ms = Number(raw);
    // Heuristic: values < 1e10 are likely seconds, not milliseconds.
    if (ms < 1e10) ms *= 1_000;
    date = new Date(ms);
  } else {
    date = new Date(raw);
  }

  if (!date || isNaN(date.getTime())) {
    console.warn('[DataNormalizer] Could not parse timestamp:', raw);
    return NULL_FIELD;
  }

  return date.toISOString();
}

/**
 * Lightweight HTML sanitiser that:
 *  1. Removes all dangerous block-level tags and their contents.
 *  2. Removes dangerous event-handler and `javascript:` attributes from
 *     any surviving element.
 *
 * This deliberately avoids a full DOM parser so it works in both browser
 * extension (content-script) and Node.js (testing) environments.
 *
 * @param {string|null|undefined} html
 * @returns {string}
 */
function sanitizeHtml(html) {
  if (!html) return '';

  let result = String(html);

  // 1. Strip dangerous tags and their inner content (non-greedy).
  for (const tag of DANGEROUS_TAGS) {
    // Matches <tag …> … </tag>  OR self-closing <tag … />
    const withContent = new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi');
    const selfClosing = new RegExp(`<${tag}(\\s[^>]*)?\\/?>`, 'gi');
    result = result.replace(withContent, '').replace(selfClosing, '');
  }

  // 2. Strip dangerous attributes from surviving elements.
  for (const attr of DANGEROUS_ATTRS) {
    // Covers on*="…", on*='…', on*=noQuotes, javascript:…
    const attrPattern = new RegExp(
      `\\s${attr}[^\\s>]*(?:=(?:"[^"]*"|'[^']*'|[^\\s>]*))?`,
      'gi',
    );
    result = result.replace(attrPattern, '');
  }

  // 3. Remove href / src / action values that start with javascript:.
  result = result.replace(
    /(href|src|action)\s*=\s*["']?\s*javascript:[^"'\s>]*/gi,
    '$1="#"',
  );

  return result.trim();
}

/**
 * Generates a stable fallback ID when the raw data does not supply one.
 * Uses a combination of a prefix, a timestamp, and a random suffix to
 * minimise the chance of collision.
 *
 * @param {string} prefix
 * @returns {string}
 */
function generateFallbackId(prefix = 'unknown') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Sorts an array of normalized objects by their `timestamp` field in
 * ascending (chronological) order.  Objects with a `null` timestamp are
 * moved to the end.
 *
 * @param {Array<{timestamp: string|null}>} items
 * @returns {Array}
 */
function sortChronologically(items) {
  return [...items].sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(a.timestamp) - new Date(b.timestamp);
  });
}

// ---------------------------------------------------------------------------
// DataNormalizer class
// ---------------------------------------------------------------------------

/**
 * Transforms raw, browser-extracted Google Chat data into a well-typed,
 * validated, and sanitized data model suitable for export.
 *
 * Usage:
 * ```js
 * const normalizer = new DataNormalizer();
 * const conversation = normalizer.buildConversation(
 *   rawMessages, rawThreads, rawReplies, rawAttachments
 * );
 * const { complete, warnings } = normalizer.validateCompleteness(conversation);
 * ```
 */
export class DataNormalizer {
  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * @param {object} [options]
   * @param {boolean} [options.strict=false]
   *   When `true`, throws instead of warning on data integrity issues.
   * @param {boolean} [options.generateIds=true]
   *   When `true`, generates fallback IDs for records that arrive without one.
   */
  constructor({ strict = false, generateIds = true } = {}) {
    /** @private */ this._strict = strict;
    /** @private */ this._generateIds = generateIds;
    /** @private */ this._warnings = [];
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Normalizes a single raw message object.
   *
   * @param {object} raw - Raw message as extracted from the DOM / network.
   * @returns {NormalizedMessage}
   */
  normalizeMessage(raw) {
    if (!raw || typeof raw !== 'object') {
      this._warn('normalizeMessage received a non-object value; returning empty message.');
      raw = {};
    }

    const id = this._resolveId(raw, 'msg');

    return {
      id,
      sender:      this._normalizeSender(raw.sender ?? raw),
      text:        toStringOrNull(raw.text ?? raw.textContent ?? raw.content),
      textHtml:    sanitizeHtml(raw.textHtml ?? raw.htmlContent ?? raw.html ?? ''),
      timestamp:   normalizeTimestamp(raw.timestamp ?? raw.time ?? raw.ts ?? raw.sentAt),
      edited:      toBoolean(raw.edited ?? raw.isEdited),
      reactions:   toArray(raw.reactions).map(r => this._normalizeReaction(r)),
      attachments: toArray(raw.attachments).map(a => this.normalizeAttachment(a)),
      threads:     [],   // populated by buildConversation()
    };
  }

  /**
   * Normalizes a single raw thread (a top-level thread container, not a
   * reply).
   *
   * @param {object} raw
   * @returns {NormalizedThread}
   */
  normalizeThread(raw) {
    if (!raw || typeof raw !== 'object') {
      this._warn('normalizeThread received a non-object value; returning empty thread.');
      raw = {};
    }

    const id = this._resolveId(raw, 'thread');

    return {
      id,
      parentMessageId: toStringOrNull(
        raw.parentMessageId ?? raw.parentId ?? raw.messageId ?? raw.parent,
      ),
      threadIndex: toIntOrNull(raw.threadIndex ?? raw.index ?? raw.position),
      replyCount:  toIntOrNull(raw.replyCount ?? raw.count ?? raw.totalReplies),
      replies:     [],  // populated by buildConversation()
    };
  }

  /**
   * Normalizes a single raw reply (a message inside a thread).
   * Reply objects share the same structure as messages but do not carry
   * nested `threads`.
   *
   * @param {object} raw
   * @returns {NormalizedReply}
   */
  normalizeReply(raw) {
    if (!raw || typeof raw !== 'object') {
      this._warn('normalizeReply received a non-object value; returning empty reply.');
      raw = {};
    }

    const id = this._resolveId(raw, 'reply');

    return {
      id,
      sender:      this._normalizeSender(raw.sender ?? raw),
      text:        toStringOrNull(raw.text ?? raw.textContent ?? raw.content),
      textHtml:    sanitizeHtml(raw.textHtml ?? raw.htmlContent ?? raw.html ?? ''),
      timestamp:   normalizeTimestamp(raw.timestamp ?? raw.time ?? raw.ts ?? raw.sentAt),
      edited:      toBoolean(raw.edited ?? raw.isEdited),
      reactions:   toArray(raw.reactions).map(r => this._normalizeReaction(r)),
      attachments: toArray(raw.attachments).map(a => this.normalizeAttachment(a)),
      threadId:    toStringOrNull(raw.threadId ?? raw.thread ?? raw.parentThreadId),
    };
  }

  /**
   * Normalizes a single raw attachment.
   *
   * @param {object} raw
   * @returns {NormalizedAttachment}
   */
  normalizeAttachment(raw) {
    if (!raw || typeof raw !== 'object') {
      this._warn('normalizeAttachment received a non-object value; returning empty attachment.');
      raw = {};
    }

    const id = this._resolveId(raw, 'att');

    return {
      id,
      type:         toStringOrNull(raw.type ?? raw.mimeType ?? raw.fileType ?? raw.kind),
      filename:     toStringOrNull(raw.filename ?? raw.name ?? raw.fileName ?? raw.title),
      url:          toStringOrNull(raw.url ?? raw.downloadUrl ?? raw.src ?? raw.href),
      previewUrl:   toStringOrNull(raw.previewUrl ?? raw.thumbnailUrl ?? raw.preview),
      isAccessible: toBoolean(raw.isAccessible ?? raw.accessible ?? raw.available, true),
    };
  }

  /**
   * Assembles a complete, sorted conversation structure from the four
   * collections returned by the extraction layer.
   *
   * Algorithm:
   *  1. Normalize all messages, threads, replies, and attachments.
   *  2. Build lookup maps for O(1) access.
   *  3. Attach attachments to their owning messages/replies when the
   *     attachment carries a `messageId` reference.
   *  4. Attach replies to their owning threads.
   *  5. Attach threads to their parent messages.
   *  6. Sort messages and replies chronologically.
   *
   * @param {object[]} messages    - Raw message objects.
   * @param {object[]} threads     - Raw thread container objects.
   * @param {object[]} replies     - Raw reply objects (messages within threads).
   * @param {object[]} attachments - Raw attachment objects (may already be
   *                                 inline on messages; deduplication is handled).
   * @returns {NormalizedConversation}
   */
  buildConversation(
    messages    = [],
    threads     = [],
    replies     = [],
    attachments = [],
  ) {
    // ---- 1. Normalize all collections ----------------------------------------
    const normalizedMessages = toArray(messages).map(m => this.normalizeMessage(m));
    const normalizedThreads  = toArray(threads).map(t => this.normalizeThread(t));
    const normalizedReplies  = toArray(replies).map(r => this.normalizeReply(r));
    const normalizedAttachments = toArray(attachments).map(a => this.normalizeAttachment(a));

    // ---- 2. Build lookup maps ------------------------------------------------
    /** @type {Map<string, NormalizedMessage>} */
    const messageMap = new Map(normalizedMessages.map(m => [m.id, m]));

    /** @type {Map<string, NormalizedThread>} */
    const threadMap  = new Map(normalizedThreads.map(t => [t.id, t]));

    /** @type {Map<string, NormalizedReply>} */
    const replyMap   = new Map(normalizedReplies.map(r => [r.id, r]));

    // ---- 3. Attach standalone attachments to messages / replies --------------
    for (const att of normalizedAttachments) {
      const rawRef = att._messageId ?? att._replyId;  // internal back-reference
      if (rawRef) {
        const owner = messageMap.get(rawRef) ?? replyMap.get(rawRef);
        if (owner) {
          // Avoid duplicates when the attachment was already inlined.
          if (!owner.attachments.some(a => a.id === att.id)) {
            owner.attachments.push(att);
          }
          continue;
        }
      }
    }

    // ---- 4. Attach replies to threads ----------------------------------------
    for (const reply of normalizedReplies) {
      const threadId = reply.threadId;
      if (!threadId) {
        this._warn(`Reply "${reply.id}" has no threadId and cannot be linked to a thread.`);
        continue;
      }
      const thread = threadMap.get(threadId);
      if (!thread) {
        this._warn(`Reply "${reply.id}" references unknown thread "${threadId}".`);
        continue;
      }
      if (!thread.replies.some(r => r.id === reply.id)) {
        thread.replies.push(reply);
      }
    }

    // Sort replies within each thread chronologically.
    for (const thread of normalizedThreads) {
      thread.replies = sortChronologically(thread.replies);

      // Reconcile replyCount: if extracted count is null, infer from replies.
      if (thread.replyCount === NULL_FIELD) {
        thread.replyCount = thread.replies.length;
      }
    }

    // ---- 5. Attach threads to their parent messages --------------------------
    for (const thread of normalizedThreads) {
      const parentId = thread.parentMessageId;
      if (!parentId) {
        this._warn(`Thread "${thread.id}" has no parentMessageId and cannot be linked.`);
        continue;
      }
      const message = messageMap.get(parentId);
      if (!message) {
        this._warn(`Thread "${thread.id}" references unknown message "${parentId}".`);
        continue;
      }
      if (!message.threads.some(t => t.id === thread.id)) {
        message.threads.push(thread);
      }
    }

    // Sort threads within each message by threadIndex (ascending).
    for (const message of normalizedMessages) {
      message.threads.sort((a, b) => {
        if (a.threadIndex === NULL_FIELD && b.threadIndex === NULL_FIELD) return 0;
        if (a.threadIndex === NULL_FIELD) return 1;
        if (b.threadIndex === NULL_FIELD) return -1;
        return a.threadIndex - b.threadIndex;
      });
    }

    // ---- 6. Sort top-level messages chronologically -------------------------
    const sortedMessages = sortChronologically(normalizedMessages);

    return {
      messages:    sortedMessages,
      // Expose flat maps for downstream consumers that need direct lookup.
      _threadMap:  threadMap,
      _replyMap:   replyMap,
      _messageMap: messageMap,
      exportedAt:  new Date().toISOString(),
    };
  }

  /**
   * Validates the completeness of an assembled conversation and returns a
   * diagnostic report.
   *
   * Checks performed:
   *  - Every message has an `id` and a `timestamp`.
   *  - Every thread has a `parentMessageId` that resolves to a known message.
   *  - Every thread's `replyCount` matches the number of attached replies.
   *  - Every reply has a `threadId` that resolves to a known thread.
   *  - Every reply has a `sender.id` and a `timestamp`.
   *  - Attachments are individually inspected for required fields.
   *
   * @param {NormalizedConversation} conversation
   * @returns {{ complete: boolean, warnings: string[], missingThreads: string[], missingReplies: string[] }}
   */
  validateCompleteness(conversation) {
    const warnings       = [];
    const missingThreads = [];
    const missingReplies = [];

    if (!conversation || !Array.isArray(conversation.messages)) {
      return {
        complete:       false,
        warnings:       ['validateCompleteness: conversation has no messages array.'],
        missingThreads: [],
        missingReplies: [],
      };
    }

    const messageMap = conversation._messageMap ?? new Map(
      conversation.messages.map(m => [m.id, m]),
    );

    // ---- Validate top-level messages ----------------------------------------
    for (const msg of conversation.messages) {
      if (!msg.id) {
        warnings.push(`Message is missing an id (text preview: "${String(msg.text).slice(0, 40)}")`);
      }
      if (!msg.timestamp) {
        warnings.push(`Message "${msg.id}" is missing a timestamp.`);
      }
      if (!msg.sender?.id) {
        warnings.push(`Message "${msg.id}" sender has no id.`);
      }

      // ---- Validate threads within message ----------------------------------
      for (const thread of msg.threads) {
        if (!thread.id) {
          warnings.push(`A thread on message "${msg.id}" is missing an id.`);
        }
        if (!thread.parentMessageId) {
          warnings.push(`Thread "${thread.id}" is missing parentMessageId.`);
        } else if (!messageMap.has(thread.parentMessageId)) {
          const note = `Thread "${thread.id}" points to unknown message "${thread.parentMessageId}".`;
          warnings.push(note);
          missingThreads.push(thread.id);
        }

        // Check replyCount vs actual replies.
        if (
          thread.replyCount !== NULL_FIELD &&
          thread.replies.length !== thread.replyCount
        ) {
          warnings.push(
            `Thread "${thread.id}" declares replyCount=${thread.replyCount} ` +
            `but only ${thread.replies.length} repl${thread.replies.length === 1 ? 'y was' : 'ies were'} extracted.`,
          );
        }

        // ---- Validate replies within thread ---------------------------------
        for (const reply of thread.replies) {
          this._validateReplyObject(reply, thread.id, warnings, missingReplies);
        }

        // ---- Validate attachments within replies ----------------------------
        for (const att of msg.attachments) {
          this._validateAttachmentObject(att, `message "${msg.id}"`, warnings);
        }
      }

      // ---- Validate attachments on the message itself -----------------------
      for (const att of msg.attachments) {
        this._validateAttachmentObject(att, `message "${msg.id}"`, warnings);
      }
    }

    return {
      complete:       warnings.length === 0,
      warnings,
      missingThreads: [...new Set(missingThreads)],
      missingReplies: [...new Set(missingReplies)],
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolves an ID from a raw object, optionally generating a fallback.
   *
   * @private
   * @param {object} raw
   * @param {string} prefix - Used when generating a fallback ID.
   * @returns {string}
   */
  _resolveId(raw, prefix) {
    const id = toStringOrNull(
      raw.id ?? raw.messageId ?? raw.threadId ?? raw.replyId ?? raw.attachmentId,
    );
    if (id) return id;

    if (this._generateIds) {
      const fallback = generateFallbackId(prefix);
      this._warn(`Record missing "id" field; assigned generated id "${fallback}".`);
      return fallback;
    }

    return NULL_FIELD;
  }

  /**
   * Normalizes a sender sub-object.
   *
   * @private
   * @param {object|null|undefined} raw
   * @returns {{ id: string|null, name: string|null, avatarUrl: string|null }}
   */
  _normalizeSender(raw) {
    if (!raw || typeof raw !== 'object') {
      return { id: NULL_FIELD, name: NULL_FIELD, avatarUrl: NULL_FIELD };
    }

    // Google Chat's DOM may expose the sender at different depths.
    const senderRaw = raw.sender ?? raw;

    return {
      id:        toStringOrNull(senderRaw.id ?? senderRaw.userId ?? senderRaw.senderId),
      name:      toStringOrNull(senderRaw.name ?? senderRaw.displayName ?? senderRaw.fullName),
      avatarUrl: toStringOrNull(senderRaw.avatarUrl ?? senderRaw.photoUrl ?? senderRaw.avatar),
    };
  }

  /**
   * Normalizes a single reaction entry.
   *
   * @private
   * @param {object|null|undefined} raw
   * @returns {{ emoji: string|null, count: number|null, users: string[] }}
   */
  _normalizeReaction(raw) {
    if (!raw || typeof raw !== 'object') {
      return { emoji: NULL_FIELD, count: NULL_FIELD, users: [] };
    }

    return {
      emoji: toStringOrNull(raw.emoji ?? raw.reaction ?? raw.unicode ?? raw.symbol),
      count: toIntOrNull(raw.count ?? raw.total ?? (Array.isArray(raw.users) ? raw.users.length : null)),
      users: toArray(raw.users ?? raw.reactors).map(u =>
        typeof u === 'string' ? u : toStringOrNull(u?.id ?? u?.name) ?? 'unknown',
      ),
    };
  }

  /**
   * Validates a reply object and appends any issues to the shared arrays.
   *
   * @private
   */
  _validateReplyObject(reply, threadId, warnings, missingReplies) {
    if (!reply.id) {
      warnings.push(`A reply in thread "${threadId}" is missing an id.`);
      missingReplies.push(`<no-id> in thread ${threadId}`);
    }
    if (!reply.timestamp) {
      warnings.push(`Reply "${reply.id}" in thread "${threadId}" is missing a timestamp.`);
    }
    if (!reply.sender?.id) {
      warnings.push(`Reply "${reply.id}" in thread "${threadId}" sender has no id.`);
    }
    if (reply.threadId && reply.threadId !== threadId) {
      warnings.push(
        `Reply "${reply.id}" declares threadId="${reply.threadId}" ` +
        `but is nested inside thread "${threadId}".`,
      );
      missingReplies.push(reply.id);
    }
    for (const att of toArray(reply.attachments)) {
      this._validateAttachmentObject(att, `reply "${reply.id}"`, warnings);
    }
  }

  /**
   * Validates a single attachment and appends any issues to the warnings array.
   *
   * @private
   */
  _validateAttachmentObject(att, ownerLabel, warnings) {
    if (!att || typeof att !== 'object') {
      warnings.push(`${ownerLabel} contains a non-object attachment.`);
      return;
    }
    if (!att.id) {
      warnings.push(`An attachment on ${ownerLabel} is missing an id.`);
    }
    if (!att.url && !att.previewUrl) {
      warnings.push(`Attachment "${att.id}" on ${ownerLabel} has neither url nor previewUrl.`);
    }
  }

  /**
   * Issues a warning via `console.warn` and, in strict mode, throws instead.
   *
   * @private
   * @param {string} message
   */
  _warn(message) {
    this._warnings.push(message);
    if (this._strict) {
      throw new Error(`[DataNormalizer] ${message}`);
    }
    console.warn(`[DataNormalizer] ${message}`);
  }

  /**
   * Returns all warnings accumulated since construction (or last reset).
   *
   * @returns {string[]}
   */
  get warnings() {
    return [...this._warnings];
  }

  /**
   * Clears the internal warning log (useful when re-using a single instance
   * across multiple `buildConversation` calls).
   */
  clearWarnings() {
    this._warnings = [];
  }
}

// ---------------------------------------------------------------------------
// JSDoc type definitions (for IDE tooling – not runtime)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} NormalizedSender
 * @property {string|null} id
 * @property {string|null} name
 * @property {string|null} avatarUrl
 */

/**
 * @typedef {object} NormalizedReaction
 * @property {string|null} emoji
 * @property {number|null} count
 * @property {string[]}    users
 */

/**
 * @typedef {object} NormalizedAttachment
 * @property {string|null}  id
 * @property {string|null}  type
 * @property {string|null}  filename
 * @property {string|null}  url
 * @property {string|null}  previewUrl
 * @property {boolean}      isAccessible
 */

/**
 * @typedef {object} NormalizedReply
 * @property {string|null}             id
 * @property {NormalizedSender}        sender
 * @property {string|null}             text
 * @property {string}                  textHtml
 * @property {string|null}             timestamp   ISO 8601
 * @property {boolean}                 edited
 * @property {NormalizedReaction[]}    reactions
 * @property {NormalizedAttachment[]}  attachments
 * @property {string|null}             threadId
 */

/**
 * @typedef {object} NormalizedThread
 * @property {string|null}      id
 * @property {string|null}      parentMessageId
 * @property {number|null}      threadIndex
 * @property {number|null}      replyCount
 * @property {NormalizedReply[]} replies
 */

/**
 * @typedef {object} NormalizedMessage
 * @property {string|null}             id
 * @property {NormalizedSender}        sender
 * @property {string|null}             text
 * @property {string}                  textHtml
 * @property {string|null}             timestamp   ISO 8601
 * @property {boolean}                 edited
 * @property {NormalizedReaction[]}    reactions
 * @property {NormalizedAttachment[]}  attachments
 * @property {NormalizedThread[]}      threads
 */

/**
 * @typedef {object} NormalizedConversation
 * @property {NormalizedMessage[]}           messages
 * @property {Map<string, NormalizedMessage>} _messageMap
 * @property {Map<string, NormalizedThread>}  _threadMap
 * @property {Map<string, NormalizedReply>}   _replyMap
 * @property {string}                         exportedAt  ISO 8601
 */
