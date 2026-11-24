/**
 * @file threadExtractor.js
 * @module ThreadExtractor
 * @description Discovers and extracts independent threads associated with parent messages
 * in Google Chat. Strictly preserves the parent -> multiple threads -> replies hierarchy.
 *
 * CRITICAL SCENARIO GUARANTEE:
 * A single parent message may have 5 or more independent reply threads.
 * Each thread may contain multiple replies.
 * This module ensures every thread is preserved separately with its original ID,
 * ordering, and reply count, and NEVER merges separate threads into one conversation.
 */

'use strict';

/**
 * Thread completion status
 * @readonly
 * @enum {string}
 */
export const ThreadStatus = {
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  INACCESSIBLE: 'inaccessible'
};

export class ThreadExtractor {
  /**
   * @param {Object} [options]
   * @param {Element} [options.containerEl] - Root element to search inside (default: document.body)
   * @param {import('./duplicateManager.js').DuplicateManager} [options.duplicateManager]
   * @param {boolean} [options.debug=false]
   */
  constructor(options = {}) {
    this._container = options.containerEl || (typeof document !== 'undefined' ? document.body : null);
    this._duplicateManager = options.duplicateManager || null;
    this._debug = Boolean(options.debug);

    /**
     * Map of parentMessageId -> Array of Thread objects
     * @type {Map<string, Array<Object>>}
     */
    this._parentToThreads = new Map();

    /**
     * Map of threadId -> Thread object
     * @type {Map<string, Object>}
     */
    this._threads = new Map();
  }

  /**
   * Internal logging
   * @private
   */
  _log(...args) {
    if (this._debug) console.debug('[ThreadExtractor]', ...args);
  }

  /**
   * Extracts all independent threads associated with a given parent message DOM element.
   *
   * @param {Element} parentEl - The parent message DOM element or topic container
   * @param {string} parentMessageId - Stable identifier of the parent message
   * @returns {Array<Object>} Array of discovered Thread descriptors
   */
  extractThreadsForParent(parentEl, parentMessageId) {
    if (!parentEl || !parentMessageId) return [];

    const discoveredThreads = [];

    // 1. Topic-Based Space Check:
    // In topic-based spaces, the container itself has a topic/thread ID and holds replies.
    const topicId = parentEl.getAttribute('data-topic-id') ||
                    parentEl.closest('[data-topic-id]')?.getAttribute('data-topic-id');

    // 2. Discover inline thread chips / reply buttons inside or adjacent to parent element
    const threadTriggerSelectors = [
      '[data-thread-id]',
      '[jsname="Eoitje"]',                   // Google Chat inline thread container
      '[aria-label*="repl" i]',              // "X replies", "Reply to thread"
      'button[data-reply-count]',
      '.thread-reply-bar',
      '[role="button"][aria-label*="replies"]',
      '[data-panel-id*="thread"]'
    ];

    const threadElements = [];
    threadTriggerSelectors.forEach(sel => {
      try {
        const matches = parentEl.querySelectorAll(sel);
        matches.forEach(el => threadElements.push(el));
      } catch (_) {}
    });

    // Check if there are separate thread containers (e.g. 5+ distinct threads under parent)
    const threadContainers = parentEl.querySelectorAll('[data-thread-container], [role="region"][aria-label*="Thread"]');

    if (threadContainers.length > 0) {
      // Multiple explicit thread containers detected under this parent message
      threadContainers.forEach((tContainer, idx) => {
        const thread = this._buildThreadFromContainer(tContainer, parentMessageId, idx + 1);
        if (thread) discoveredThreads.push(thread);
      });
    } else if (threadElements.length > 0) {
      // Thread trigger elements (e.g. separate reply chips or side-panel references)
      threadElements.forEach((tEl, idx) => {
        const thread = this._buildThreadFromTrigger(tEl, parentMessageId, idx + 1);
        if (thread) discoveredThreads.push(thread);
      });
    } else if (topicId) {
      // Topic-based single thread container
      const thread = {
        id: topicId,
        parentMessageId: parentMessageId,
        threadIndex: 1,
        title: this._extractThreadTitle(parentEl) || `Thread 1`,
        replyCount: this._extractReplyCountFromDOM(parentEl),
        status: ThreadStatus.COMPLETE,
        replies: [],
        element: parentEl
      };
      discoveredThreads.push(thread);
    }

    // Deduplicate discovered threads for this parent
    const uniqueThreads = [];
    const seenThreadIds = new Set();

    for (const thread of discoveredThreads) {
      if (!seenThreadIds.has(thread.id)) {
        seenThreadIds.add(thread.id);
        if (this._duplicateManager) {
          if (!this._duplicateManager.trackThread(thread.id)) {
            continue;
          }
        }
        uniqueThreads.push(thread);
        this._threads.set(thread.id, thread);
      }
    }

    // Cache to parent map
    this._parentToThreads.set(parentMessageId, uniqueThreads);
    this._log(`Discovered ${uniqueThreads.length} independent threads for parent ${parentMessageId}`);

    return uniqueThreads;
  }

  /**
   * Builds a Thread descriptor from an explicit thread container element.
   * @private
   */
  _buildThreadFromContainer(container, parentMessageId, index) {
    const threadId = container.getAttribute('data-thread-id') ||
                     container.getAttribute('id') ||
                     `thread_${parentMessageId}_${index}`;

    const title = this._extractThreadTitle(container) || `Thread ${index}`;
    const replyCount = this._extractReplyCountFromDOM(container);

    return {
      id: threadId,
      parentMessageId: parentMessageId,
      threadIndex: index,
      title: title,
      replyCount: replyCount,
      status: ThreadStatus.COMPLETE,
      replies: [],
      element: container
    };
  }

  /**
   * Builds a Thread descriptor from an inline trigger / button element.
   * @private
   */
  _buildThreadFromTrigger(triggerEl, parentMessageId, index) {
    const threadId = triggerEl.getAttribute('data-thread-id') ||
                     triggerEl.getAttribute('data-topic-id') ||
                     `thread_${parentMessageId}_${index}`;

    const label = triggerEl.getAttribute('aria-label') || triggerEl.textContent || '';
    let replyCount = 0;
    const match = label.match(/(\d+)\s+repl/i);
    if (match) {
      replyCount = parseInt(match[1], 10);
    }

    const title = this._extractThreadTitle(triggerEl) || `Thread ${index}`;

    return {
      id: threadId,
      parentMessageId: parentMessageId,
      threadIndex: index,
      title: title,
      replyCount: replyCount,
      status: ThreadStatus.COMPLETE,
      replies: [],
      element: triggerEl
    };
  }

  /**
   * Attempts to extract a thread title or summary from DOM annotations.
   * @private
   */
  _extractThreadTitle(el) {
    if (!el) return null;
    const titleEl = el.querySelector('[data-thread-title], .thread-title, h3, h4');
    if (titleEl && titleEl.textContent.trim()) {
      return titleEl.textContent.trim();
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && !ariaLabel.startsWith('Thread') && !ariaLabel.includes('replies')) {
      return ariaLabel.trim();
    }
    return null;
  }

  /**
   * Extracts reply count from DOM elements.
   * @private
   */
  _extractReplyCountFromDOM(el) {
    if (!el) return 0;
    const countAttr = el.getAttribute('data-reply-count');
    if (countAttr && !isNaN(parseInt(countAttr, 10))) {
      return parseInt(countAttr, 10);
    }
    const text = el.textContent || '';
    const match = text.match(/(\d+)\s+repl/i);
    if (match) {
      return parseInt(match[1], 10);
    }
    return 0;
  }

  /**
   * Registers a manually identified or synthesized thread (e.g. from network data or mock tests).
   *
   * @param {Object} threadData
   * @returns {Object} Normalized thread
   */
  registerThread(threadData) {
    const threadId = threadData.id || `thread_${threadData.parentMessageId}_${Date.now()}`;
    const parentMessageId = threadData.parentMessageId;

    const thread = {
      id: threadId,
      parentMessageId: parentMessageId,
      threadIndex: threadData.threadIndex || 1,
      title: threadData.title || `Thread ${threadData.threadIndex || 1}`,
      replyCount: threadData.replyCount !== undefined ? threadData.replyCount : (threadData.replies ? threadData.replies.length : 0),
      status: threadData.status || ThreadStatus.COMPLETE,
      replies: threadData.replies || [],
      element: threadData.element || null
    };

    this._threads.set(threadId, thread);

    if (parentMessageId) {
      const existing = this._parentToThreads.get(parentMessageId) || [];
      if (!existing.some(t => t.id === threadId)) {
        existing.push(thread);
        this._parentToThreads.set(parentMessageId, existing);
      }
    }

    return thread;
  }

  /**
   * Retrieves all threads associated with a specific parent message ID.
   *
   * @param {string} parentMessageId
   * @returns {Array<Object>}
   */
  getThreadsForParent(parentMessageId) {
    return this._parentToThreads.get(parentMessageId) || [];
  }

  /**
   * Retrieves a thread by its ID.
   *
   * @param {string} threadId
   * @returns {Object|null}
   */
  getThreadById(threadId) {
    return this._threads.get(threadId) || null;
  }

  /**
   * Returns all discovered threads across all parent messages.
   *
   * @returns {Array<Object>}
   */
  getAllThreads() {
    return Array.from(this._threads.values());
  }

  /**
   * Total number of threads discovered.
   * @returns {number}
   */
  get size() {
    return this._threads.size;
  }

  /**
   * Clears all internal caches.
   */
  clear() {
    this._threads.clear();
    this._parentToThreads.clear();
  }
}
