/**
 * @file duplicateManager.js
 * @module DuplicateManager
 * @description Prevents duplicate extraction of messages, threads, replies, and
 *   attachments during a Google Chat Exporter session. Uses in-memory Sets and
 *   Maps for O(1) look-ups. When an item has no usable ID the manager falls
 *   back to a lightweight content hash so nothing is silently skipped or
 *   double-counted.
 *
 * @example
 *   import { DuplicateManager } from './modules/duplicateManager.js';
 *   const dm = new DuplicateManager();
 *   if (dm.trackMessage(msg.id)) { ... process msg ... }
 */

'use strict';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight, non-cryptographic string hash (djb2 variant).
 * Returns a 32-bit unsigned integer as a hex string.
 *
 * @param {string} str - Input string.
 * @returns {string} 8-character hex hash, e.g. "1a2b3c4d".
 */
function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // hash * 33 XOR charCode  (bit-safe with |0)
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  // Convert to unsigned 32-bit and then to a fixed-length hex string.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Builds a content-based fallback key from the fields that most uniquely
 * identify a chat message when no server-assigned ID is available.
 *
 * Fields used:
 *   - sender   : display name or user ID of the author
 *   - timestamp: ISO string, epoch ms, or any string representation
 *   - text     : first 50 characters of the message body
 *
 * @param {Object} [item={}] - Partial message / reply / attachment object.
 * @returns {string} Fallback key prefixed with "hash:" for easy identification
 *   in logs.
 */
function buildContentHash(item = {}) {
  const sender    = String(item.sender    ?? item.author ?? item.userId ?? '');
  const timestamp = String(item.timestamp ?? item.time   ?? item.date  ?? '');
  const text      = String(item.text      ?? item.body   ?? item.name  ?? '').slice(0, 50);

  const raw = `${sender}|${timestamp}|${text}`;
  return `hash:${djb2Hash(raw)}`;
}

/**
 * Resolves the tracking key for any item.
 * - If `id` is a non-empty string / positive number  → use it directly.
 * - Otherwise fall back to a content hash derived from `item`.
 *
 * @param {string|number|null|undefined} id   - Preferred unique identifier.
 * @param {Object}                       item - Full object (for hash fallback).
 * @returns {string} The resolved key.
 */
function resolveKey(id, item) {
  if (id !== null && id !== undefined && id !== '') {
    return String(id);
  }
  return buildContentHash(item);
}

// ---------------------------------------------------------------------------
// DuplicateManager
// ---------------------------------------------------------------------------

/**
 * Tracks and prevents duplicate extraction of Google Chat content.
 *
 * All state is held in-memory; call {@link DuplicateManager#reset} to start a
 * fresh session, or {@link DuplicateManager#destroy} when the instance is no
 * longer needed.
 */
export class DuplicateManager {
  /**
   * @param {Object}  [options={}]              - Configuration options.
   * @param {boolean} [options.debug=false]     - Emit console logs on duplicate
   *   detections (useful during development / QA).
   * @param {string}  [options.logPrefix='[DuplicateManager]'] - Prefix for all
   *   log messages so they are easy to filter in DevTools.
   */
  constructor(options = {}) {
    const {
      debug     = false,
      logPrefix = '[DuplicateManager]',
    } = options;

    /** @private */
    this._debug     = debug;
    /** @private */
    this._logPrefix = logPrefix;

    // Initialise tracking collections via reset() so the logic lives in one place.
    this.reset();
  }

  // -------------------------------------------------------------------------
  // Private logging helpers
  // -------------------------------------------------------------------------

  /**
   * Logs a message when debug mode is enabled.
   * @private
   * @param {...*} args - Arguments forwarded to console.debug.
   */
  _log(...args) {
    if (this._debug) {
      console.debug(this._logPrefix, ...args);
    }
  }

  /**
   * Logs a duplicate detection event.
   * @private
   * @param {string} type - Content type label, e.g. "message".
   * @param {string} key  - The resolved key that was already seen.
   */
  _logDuplicate(type, key) {
    this._log(`Duplicate ${type} detected — key: "${key}"`);
  }

  // -------------------------------------------------------------------------
  // Core tracking — private primitive
  // -------------------------------------------------------------------------

  /**
   * Generic tracking primitive used by all public track* methods.
   *
   * @private
   * @param {Set}                        seen - The Set for this content type.
   * @param {string}                     type - Label used in log output.
   * @param {string|number|null}         id   - Item identifier (may be nullish).
   * @param {Object}                     item - Full item object (for fallback).
   * @returns {boolean} `true` if the key is new; `false` if it was already
   *   tracked (i.e. this is a duplicate).
   */
  _track(seen, type, id, item) {
    const key = resolveKey(id, item);

    if (seen.has(key)) {
      this._logDuplicate(type, key);
      this._stats.duplicatesRemoved++;
      return false; // duplicate
    }

    seen.add(key);
    return true; // new item
  }

  // -------------------------------------------------------------------------
  // Public track* methods
  // -------------------------------------------------------------------------

  /**
   * Records a message ID and reports whether it is new.
   *
   * @param {string|number|null|undefined} id   - Message identifier.
   * @param {Object}                      [item={}] - Full message object; used
   *   only when `id` is nullish to compute a content-hash fallback key.
   * @returns {boolean} `true` → process this message; `false` → skip (duplicate).
   */
  trackMessage(id, item = {}) {
    const isNew = this._track(this._seenMessages, 'message', id, item);
    if (isNew) this._stats.messages++;
    return isNew;
  }

  /**
   * Checks whether a message ID has already been recorded.
   * @param {string|number} id
   * @returns {boolean}
   */
  hasMessage(id) {
    if (id === null || id === undefined || id === '') return false;
    return this._seenMessages.has(String(id));
  }

  /**
   * Checks whether a thread ID has already been recorded.
   * @param {string|number} id
   * @returns {boolean}
   */
  hasThread(id) {
    if (id === null || id === undefined || id === '') return false;
    return this._seenThreads.has(String(id));
  }

  /**
   * Checks whether a reply ID has already been recorded.
   * @param {string|number} id
   * @returns {boolean}
   */
  hasReply(id) {
    if (id === null || id === undefined || id === '') return false;
    return this._seenReplies.has(String(id));
  }

  /**
   * Records a thread ID and reports whether it is new.
   *
   * @param {string|number|null|undefined} id       - Thread identifier.
   * @param {Object}                      [item={}] - Thread object for fallback.
   * @returns {boolean} `true` → new thread; `false` → duplicate.
   */
  trackThread(id, item = {}) {
    const isNew = this._track(this._seenThreads, 'thread', id, item);
    if (isNew) this._stats.threads++;
    return isNew;
  }

  /**
   * Records a reply ID and reports whether it is new.
   *
   * @param {string|number|null|undefined} id       - Reply identifier.
   * @param {Object}                      [item={}] - Reply object for fallback.
   * @returns {boolean} `true` → new reply; `false` → duplicate.
   */
  trackReply(id, item = {}) {
    const isNew = this._track(this._seenReplies, 'reply', id, item);
    if (isNew) this._stats.replies++;
    return isNew;
  }

  /**
   * Records an attachment ID and reports whether it is new.
   *
   * @param {string|number|null|undefined} id       - Attachment identifier.
   * @param {Object}                      [item={}] - Attachment object for fallback.
   * @returns {boolean} `true` → new attachment; `false` → duplicate.
   */
  trackAttachment(id, item = {}) {
    const isNew = this._track(this._seenAttachments, 'attachment', id, item);
    if (isNew) this._stats.attachments++;
    return isNew;
  }

  // -------------------------------------------------------------------------
  // Deduplication helpers
  // -------------------------------------------------------------------------

  /**
   * Removes duplicate messages from an array **without** mutating the original,
   * preserving the order of first occurrence.
   *
   * Each message is registered with {@link DuplicateManager#trackMessage}, so
   * the internal counters are updated as a side-effect.
   *
   * @param {Array<Object>} messages - Array of message objects.  Each object
   *   may carry an `id` property; if absent, a content hash is used.
   * @returns {Array<Object>} New array containing only unique messages.
   */
  deduplicateMessages(messages) {
    if (!Array.isArray(messages)) {
      console.warn(this._logPrefix, 'deduplicateMessages: expected an array, got', typeof messages);
      return [];
    }

    const result = [];
    for (const msg of messages) {
      const id = msg?.id ?? msg?.messageId ?? null;
      if (this.trackMessage(id, msg)) {
        result.push(msg);
      }
    }

    this._log(`deduplicateMessages: ${messages.length} in → ${result.length} out`);
    return result;
  }

  /**
   * Removes duplicate replies from an array, preserving order of first
   * occurrence and updating internal reply counters.
   *
   * @param {Array<Object>} replies - Array of reply objects.
   * @returns {Array<Object>} New array containing only unique replies.
   */
  deduplicateReplies(replies) {
    if (!Array.isArray(replies)) {
      console.warn(this._logPrefix, 'deduplicateReplies: expected an array, got', typeof replies);
      return [];
    }

    const result = [];
    for (const reply of replies) {
      const id = reply?.id ?? reply?.replyId ?? null;
      if (this.trackReply(id, reply)) {
        result.push(reply);
      }
    }

    this._log(`deduplicateReplies: ${replies.length} in → ${result.length} out`);
    return result;
  }

  // -------------------------------------------------------------------------
  // Stats & lifecycle
  // -------------------------------------------------------------------------

  /**
   * Returns a snapshot of the current deduplication statistics.
   *
   * The returned object is a **copy**; mutating it has no effect on the manager.
   *
   * @returns {{
   *   messages:         number,
   *   threads:          number,
   *   replies:          number,
   *   attachments:      number,
   *   duplicatesRemoved:number
   * }}
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * Clears all tracking state and resets statistics to zero.
   * Call this between export sessions to avoid false-positive duplicate
   * detections across separate runs.
   */
  reset() {
    /** @private @type {Set<string>} */
    this._seenMessages    = new Set();
    /** @private @type {Set<string>} */
    this._seenThreads     = new Set();
    /** @private @type {Set<string>} */
    this._seenReplies     = new Set();
    /** @private @type {Set<string>} */
    this._seenAttachments = new Set();

    /**
     * Mutable statistics object.
     * @private
     * @type {{ messages: number, threads: number, replies: number,
     *           attachments: number, duplicatesRemoved: number }}
     */
    this._stats = {
      messages:          0,
      threads:           0,
      replies:           0,
      attachments:       0,
      duplicatesRemoved: 0,
    };

    this._log('State reset.');
  }

  /**
   * Releases all references held by this instance.
   * After calling `destroy()` the instance must not be used again.
   *
   * Useful when the extension's background service worker is shutting down or
   * the content script is being unloaded.
   */
  destroy() {
    this._seenMessages    = null;
    this._seenThreads     = null;
    this._seenReplies     = null;
    this._seenAttachments = null;
    this._stats           = null;
    this._log('Instance destroyed.');
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Creates a pre-configured {@link DuplicateManager} instance.
 *
 * @param {Object} [options] - Forwarded to the {@link DuplicateManager}
 *   constructor.
 * @returns {DuplicateManager}
 */
export function createDuplicateManager(options) {
  return new DuplicateManager(options);
}

export default DuplicateManager;
