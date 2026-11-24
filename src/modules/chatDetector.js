/**
 * @file chatDetector.js
 * @module ChatDetector
 * @description Automatically detects Google Chat context, page type, space/conversation details,
 * and tracks live DOM metrics (messages, independent threads, replies, attachments).
 */

'use strict';

/**
 * Conversation types supported by Google Chat
 * @readonly
 * @enum {string}
 */
export const ConversationType = {
  DIRECT_MESSAGE: 'DIRECT_MESSAGE',
  GROUP_CHAT: 'GROUP_CHAT',
  SPACE: 'SPACE',
  UNKNOWN: 'UNKNOWN'
};

/**
 * Threading architecture mode detected in a Google Chat Space
 * @readonly
 * @enum {string}
 */
export const ThreadMode = {
  INLINE_THREADS: 'INLINE_THREADS', // Modern spaces with in-line threaded replies
  TOPIC_BASED: 'TOPIC_BASED',       // Traditional spaces organized by conversation topics
  FLAT: 'FLAT',                     // Direct messages or flat stream with optional inline reply side panel
  UNKNOWN: 'UNKNOWN'
};

export class ChatDetector {
  /**
   * @param {Object} [options]
   * @param {Document} [options.doc=document]
   * @param {Location} [options.loc=window.location]
   */
  constructor(options = {}) {
    this._doc = options.doc || (typeof document !== 'undefined' ? document : null);
    this._loc = options.loc || (typeof window !== 'undefined' ? window.location : null);
  }

  /**
   * Checks whether the current URL represents an active Google Chat environment.
   * Supports both standalone Google Chat (chat.google.com) and Gmail embedded Chat (mail.google.com).
   *
   * @returns {boolean}
   */
  isGoogleChatPage() {
    if (!this._loc) return false;
    const href = this._loc.href || '';
    const host = this._loc.hostname || '';

    if (host.includes('chat.google.com')) return true;
    if (host.includes('mail.google.com') && (href.includes('/chat') || href.includes('#chat'))) return true;

    // Also check DOM indicators if hostname check needs validation
    if (this._doc) {
      if (this._doc.querySelector('[data-chat-app], [jscontroller][data-topic-id], [jsname="xySENc"], [role="main"] [data-message-id]')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detects the conversation type (SPACE, DIRECT_MESSAGE, GROUP_CHAT).
   *
   * @returns {string} One of ConversationType values
   */
  detectConversationType() {
    if (!this._loc) return ConversationType.UNKNOWN;
    const href = this._loc.href || '';

    // URL path heuristics
    if (href.includes('/room/') || href.includes('/space/') || href.includes('/r/')) {
      return ConversationType.SPACE;
    }
    if (href.includes('/dm/') || href.includes('/direct/')) {
      return ConversationType.DIRECT_MESSAGE;
    }

    // DOM heuristics
    if (this._doc) {
      // Space header indicators
      const spaceBadge = this._doc.querySelector('[aria-label*="Space"], [data-is-space="true"], [data-space-id]');
      if (spaceBadge) return ConversationType.SPACE;

      // Check title or header icons
      const headerIcon = this._doc.querySelector('header [aria-label*="Space"], [role="main"] header [data-tooltip*="Space"]');
      if (headerIcon) return ConversationType.SPACE;

      // Group chat indicator: headers showing multiple participants or "members"
      const memberCountEl = this._doc.querySelector('[aria-label*="member"], [aria-label*="participant"]');
      if (memberCountEl) {
        const text = memberCountEl.textContent || '';
        const match = text.match(/(\d+)\s+(?:members|people)/i);
        if (match && parseInt(match[1], 10) > 2) {
          return ConversationType.GROUP_CHAT;
        }
      }

      // Check if topic cards exist (characteristic of Spaces)
      if (this._doc.querySelectorAll('[data-topic-id]').length > 1) {
        return ConversationType.SPACE;
      }
    }

    // Fallback: if in chat URL but not space
    if (href.includes('/chat')) {
      return ConversationType.DIRECT_MESSAGE;
    }

    return ConversationType.UNKNOWN;
  }

  /**
   * Detects the threading model used by the active space or conversation.
   *
   * @returns {string} One of ThreadMode values
   */
  detectThreadMode() {
    if (!this._doc) return ThreadMode.UNKNOWN;

    // Check for topic cards
    const topicCards = this._doc.querySelectorAll('[data-topic-id], [jsmodel*="topic"]');
    if (topicCards.length > 0) {
      return ThreadMode.TOPIC_BASED;
    }

    // Check for inline thread triggers, reply buttons, or side panel reply drawers
    const inlineReplyButtons = this._doc.querySelectorAll(
      '[aria-label*="reply" i], [aria-label*="replies" i], [data-thread-id], [jsname="Eoitje"], button[data-reply-count]'
    );
    if (inlineReplyButtons.length > 0) {
      return ThreadMode.INLINE_THREADS;
    }

    return ThreadMode.FLAT;
  }

  /**
   * Extracts the conversation title/name from the active Google Chat view.
   *
   * @returns {string}
   */
  detectConversationName() {
    if (!this._doc) return 'Google Chat Conversation';

    // 1. Try dedicated conversation header elements
    const headerSelectors = [
      'header h1',
      'header h2',
      '[role="heading"][aria-level="1"]',
      '[role="heading"][aria-level="2"]',
      'header [data-hovercard-id]',
      '[jsname="A4bMJe"]', // Google Chat room/DM title element
      '.Yv3xrd',          // observed conversation title class
      '[data-conversation-title]',
      'header [role="button"] span[dir="auto"]'
    ];

    for (const sel of headerSelectors) {
      const el = this._doc.querySelector(sel);
      if (el && el.textContent.trim()) {
        const title = el.textContent.trim();
        // Ignore generic labels
        if (!['Chat', 'Google Chat', 'Mail', 'Spaces'].includes(title)) {
          return title;
        }
      }
    }

    // 2. Check active item in sidebar navigation
    const activeSidebarItem = this._doc.querySelector(
      '[role="navigation"] [aria-selected="true"], [role="treeitem"][aria-selected="true"]'
    );
    if (activeSidebarItem) {
      const label = activeSidebarItem.getAttribute('aria-label') || activeSidebarItem.textContent.trim();
      if (label) return label.replace(/^Chat with\s+/i, '').replace(/,\s*\d+\s+unread.*$/i, '').trim();
    }

    // 3. Document title fallback
    const docTitle = this._doc.title || '';
    if (docTitle && !docTitle.startsWith('Google Chat') && !docTitle.startsWith('Gmail')) {
      return docTitle.split(' - ')[0].replace(/\(\d+\)\s*/, '').trim();
    }

    return 'Google Chat Conversation';
  }

  /**
   * Extracts the conversation or space ID from the URL or DOM.
   *
   * @returns {string}
   */
  detectConversationId() {
    if (this._loc) {
      const href = this._loc.href || '';
      // Pattern: /space/AAAAxxxx or /dm/BBBBxxxx or /room/CCCCxxxx
      const match = href.match(/\/(?:space|dm|room|r)\/([a-zA-Z0-9_\-]+)/);
      if (match) return match[1];
    }

    if (this._doc) {
      const el = this._doc.querySelector('[data-space-id], [data-topic-id], [data-conversation-id]');
      if (el) {
        return el.getAttribute('data-space-id') ||
               el.getAttribute('data-conversation-id') ||
               el.getAttribute('data-topic-id') ||
               'chat_convo_' + Date.now();
      }
    }

    return 'chat_convo_' + Date.now();
  }

  /**
   * Performs a rapid scan of the active DOM to report current live counts
   * of messages, independent threads, replies, and attachments.
   *
   * @returns {{
   *   isChat: boolean,
   *   name: string,
   *   type: string,
   *   id: string,
   *   threadMode: string,
   *   totalMessages: number,
   *   totalThreads: number,
   *   totalReplies: number,
   *   totalAttachments: number
   * }}
   */
  scanLiveMetrics() {
    const isChat = this.isGoogleChatPage();
    if (!isChat || !this._doc) {
      return {
        isChat: false,
        name: 'Not a Google Chat page',
        type: ConversationType.UNKNOWN,
        id: '',
        threadMode: ThreadMode.UNKNOWN,
        totalMessages: 0,
        totalThreads: 0,
        totalReplies: 0,
        totalAttachments: 0
      };
    }

    const name = this.detectConversationName();
    const type = this.detectConversationType();
    const id = this.detectConversationId();
    const threadMode = this.detectThreadMode();

    // Scan messages
    const messageElements = this._doc.querySelectorAll(
      '[data-message-id], [role="listitem"][data-id], .oUJrbe'
    );
    const messageIds = new Set();
    messageElements.forEach(el => {
      const mid = el.getAttribute('data-message-id') || el.getAttribute('data-id');
      if (mid) messageIds.add(mid);
    });
    const totalMessages = Math.max(messageIds.size, messageElements.length);

    // Scan threads & topics
    const topicElements = this._doc.querySelectorAll('[data-topic-id]');
    const threadButtonElements = this._doc.querySelectorAll(
      '[aria-label*="repl" i], [data-thread-id], button[data-reply-count]'
    );
    const totalThreads = Math.max(topicElements.length, threadButtonElements.length);

    // Scan replies
    let totalReplies = 0;
    threadButtonElements.forEach(btn => {
      const label = btn.getAttribute('aria-label') || btn.textContent || '';
      const match = label.match(/(\d+)\s+repl/i);
      if (match) {
        totalReplies += parseInt(match[1], 10);
      }
    });
    const renderedReplies = this._doc.querySelectorAll('[data-is-reply="true"], [jsname="oLhsH"] [role="listitem"]').length;
    totalReplies = Math.max(totalReplies, renderedReplies);

    // Scan attachments
    const attachmentElements = this._doc.querySelectorAll(
      'img[src]:not([data-hovercard-id] img):not(.SFknad img), [data-attachment-id], [jsname="q9ME8e"], a[target="_blank"][href*="drive.google"]'
    );
    const totalAttachments = attachmentElements.length;

    return {
      isChat: true,
      name,
      type,
      id,
      threadMode,
      totalMessages,
      totalThreads,
      totalReplies,
      totalAttachments
    };
  }
}
