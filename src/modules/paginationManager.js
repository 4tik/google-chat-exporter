/**
 * @file paginationManager.js
 * @module PaginationManager
 * @description Manages message retrieval, scrolling through virtualized Google Chat feeds,
 * expanding thread replies, and retrieving older historical messages with safety limits,
 * stall detection, and progress callbacks.
 */

'use strict';

/**
 * Pagination termination reason
 * @readonly
 * @enum {string}
 */
export const PaginationResult = {
  REACHED_TOP: 'REACHED_TOP',
  MAX_ITERATIONS_REACHED: 'MAX_ITERATIONS_REACHED',
  STALLED: 'STALLED',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR'
};

export class PaginationManager {
  /**
   * @param {Object} [options]
   * @param {Element} [options.scrollContainer] - Scrollable feed container element
   * @param {number} [options.stepDelay=400]    - Delay between scroll steps in ms
   * @param {number} [options.maxIterations=200]- Maximum scroll iterations
   * @param {number} [options.stallThreshold=4] - Number of non-increasing scrolls before stopping
   * @param {boolean} [options.debug=false]     - Enable debug logs
   */
  constructor(options = {}) {
    this._container = options.scrollContainer || null;
    this._stepDelay = options.stepDelay || 400;
    this._maxIterations = options.maxIterations || 200;
    this._stallThreshold = options.stallThreshold || 4;
    this._debug = Boolean(options.debug);

    this._isCancelled = false;
    this._isPaginating = false;
  }

  /**
   * Internal logging
   * @private
   */
  _log(...args) {
    if (this._debug) console.debug('[PaginationManager]', ...args);
  }

  /**
   * Request cancellation of the active pagination session.
   */
  cancel() {
    this._isCancelled = true;
    this._log('Cancellation requested.');
  }

  /**
   * Locates the active scroll container in the Google Chat interface.
   *
   * @param {Element} [root=document.body]
   * @returns {Element|null}
   */
  findScrollContainer(root = (typeof document !== 'undefined' ? document.body : null)) {
    if (!root) return null;

    // Check common Google Chat scroll containers
    const candidates = [
      root.querySelector('[jsname="xySENc"]'),
      root.querySelector('[role="main"] [role="list"]'),
      root.querySelector('[data-view-type="STREAM"]'),
      root.querySelector('.c-virtual-list'),
      root.querySelector('[role="main"]')
    ];

    for (const c of candidates) {
      if (c && (c.scrollHeight > c.clientHeight || getComputedStyle(c).overflowY === 'auto' || getComputedStyle(c).overflowY === 'scroll')) {
        this._container = c;
        return c;
      }
    }

    // Fallback: search for any element with vertical scrollability
    const allDivs = root.querySelectorAll('div, main, section');
    for (const div of allDivs) {
      if (div.scrollHeight > div.clientHeight + 100) {
        const style = (typeof window !== 'undefined' && window.getComputedStyle) ? window.getComputedStyle(div) : null;
        if (style && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
          this._container = div;
          return div;
        }
      }
    }

    this._container = root;
    return root;
  }

  /**
   * Sweeps upward through the chat feed to retrieve older historical messages.
   *
   * @param {Object} [options]
   * @param {function(number): number} [options.getMessageCount] - Function returning current count of extracted messages
   * @param {function(Object): void} [options.onProgress] - Callback reporting progress
   * @returns {Promise<{ result: string, iterations: number, finalCount: number }>}
   */
  async retrieveOlderMessages(options = {}) {
    const getMessageCount = options.getMessageCount || (() => 0);
    const onProgress = options.onProgress || (() => {});

    this._isCancelled = false;
    this._isPaginating = true;

    const scroller = this._container || this.findScrollContainer();
    if (!scroller) {
      return { result: PaginationResult.ERROR, iterations: 0, finalCount: getMessageCount() };
    }

    let iterations = 0;
    let stallCount = 0;
    let lastCount = getMessageCount();
    let lastScrollTop = scroller.scrollTop;

    this._log(`Starting upward pagination. Initial count: ${lastCount}`);

    while (iterations < this._maxIterations) {
      if (this._isCancelled) {
        this._isPaginating = false;
        return { result: PaginationResult.CANCELLED, iterations, finalCount: getMessageCount() };
      }

      iterations++;

      // Scroll toward top to trigger older message fetch
      scroller.scrollTop = 0;

      // Small pause to allow virtual DOM hydration and network requests to fulfill
      await this._sleep(this._stepDelay);

      const currentCount = getMessageCount();
      const currentScrollTop = scroller.scrollTop;

      onProgress({
        phase: 'RETRIEVING_OLDER_MESSAGES',
        iteration: iterations,
        maxIterations: this._maxIterations,
        currentCount,
        percent: Math.min(95, Math.round((iterations / this._maxIterations) * 100))
      });

      if (currentCount > lastCount) {
        // New messages loaded! Reset stall counter
        stallCount = 0;
        lastCount = currentCount;
      } else {
        stallCount++;
        if (stallCount >= this._stallThreshold) {
          // Check if we are firmly at the top
          if (scroller.scrollTop === 0) {
            this._log(`Reached top of feed or no more messages after ${stallCount} attempts.`);
            this._isPaginating = false;
            return { result: PaginationResult.REACHED_TOP, iterations, finalCount: currentCount };
          } else {
            this._log(`Pagination stalled at iteration ${iterations}.`);
            this._isPaginating = false;
            return { result: PaginationResult.STALLED, iterations, finalCount: currentCount };
          }
        }
      }
    }

    this._isPaginating = false;
    return { result: PaginationResult.MAX_ITERATIONS_REACHED, iterations, finalCount: getMessageCount() };
  }

  /**
   * Sweeps top-to-bottom across the feed to ensure all virtualized DOM elements and lazy images are rendered.
   *
   * @param {Object} [options]
   * @param {function(Object): void} [options.onProgress]
   * @returns {Promise<void>}
   */
  async sweepToBottom(options = {}) {
    const onProgress = options.onProgress || (() => {});
    const scroller = this._container || this.findScrollContainer();
    if (!scroller) return;

    this._log('Starting top-to-bottom hydration sweep.');
    const scrollHeight = scroller.scrollHeight;
    const clientHeight = scroller.clientHeight;
    const stepSize = Math.max(300, Math.floor(clientHeight * 0.75));

    let currentPos = 0;
    while (currentPos < scroller.scrollHeight) {
      if (this._isCancelled) break;
      currentPos += stepSize;
      scroller.scrollTop = currentPos;
      await this._sleep(150);

      onProgress({
        phase: 'HYDRATING_DOM',
        scrollTop: currentPos,
        scrollHeight: scroller.scrollHeight
      });
    }

    // Scroll to the very bottom
    scroller.scrollTop = scroller.scrollHeight;
    await this._sleep(200);
  }

  /**
   * Automatically discovers and expands collapsed thread reply bars or side-panel threads.
   *
   * @param {Element} root
   * @returns {Promise<number>} Number of expanded threads
   */
  async expandCollapsedThreads(root = (typeof document !== 'undefined' ? document.body : null)) {
    if (!root) return 0;

    const expandTriggers = root.querySelectorAll(
      '[aria-label*="replies" i][role="button"], [aria-label*="unread" i][role="button"], button[data-reply-count]'
    );

    let expandedCount = 0;
    for (const trigger of expandTriggers) {
      if (this._isCancelled) break;
      try {
        const ariaExpanded = trigger.getAttribute('aria-expanded');
        if (ariaExpanded === 'false' || !ariaExpanded) {
          trigger.click();
          expandedCount++;
          await this._sleep(200);
        }
      } catch (_) {}
    }

    return expandedCount;
  }

  /**
   * Internal sleep helper
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
