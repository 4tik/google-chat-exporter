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
    if (href.includes('/dm/') || href.includes('/direct/')) {
      return ConversationType.DIRECT_MESSAGE;
    }
    if (href.includes('/room/') || href.includes('/space/')) {
      return ConversationType.SPACE;
    }

    // DOM heuristics
    if (this._doc) {
      const mainEl = this._doc.querySelector('[role="main"]') || this._doc.body;
      const mainText = mainEl ? (mainEl.innerText || mainEl.textContent || '') : '';

      // Direct Message heuristics: email in header or welcome text
      if (
        mainText.includes('You created this chat on') ||
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(mainText.slice(0, 800))
      ) {
        return ConversationType.DIRECT_MESSAGE;
      }

      // Check sidebar section of the active conversation link
      const pathParts = (this._loc.pathname || '').split('/').filter(Boolean);
      const convoId = pathParts[pathParts.length - 1];
      if (convoId && convoId.length >= 4) {
        const activeLink = this._doc.querySelector(`a[href*="${convoId}"], [data-id*="${convoId}"]`);
        if (activeLink) {
          const dmSection = activeLink.closest('[aria-label*="Direct messages" i], [data-section*="dm" i]');
          if (dmSection) return ConversationType.DIRECT_MESSAGE;
          const spaceSection = activeLink.closest('[aria-label*="Spaces" i], [data-section*="spaces" i]');
          if (spaceSection) return ConversationType.SPACE;
        }
      }

      // Space header indicators
      const spaceBadge = this._doc.querySelector('[aria-label*="Space" i], [data-is-space="true"], [data-space-id]');
      if (spaceBadge) return ConversationType.SPACE;

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

    const cleanTitle = (str) => {
      if (!str) return '';
      return str
        .replace(/^\(\d+\)\s*/, '')
        .replace(/\s*[-–]\s*(?:Google\s+)?Chat.*$/i, '')
        .replace(/\s*[-–]\s*Gmail.*$/i, '')
        .replace(/^(?:Chat with|Space options for|Conversation options for)\s+/i, '')
        .replace(/,\s*\d+\s+unread.*$/i, '')
        .replace(/\s*[▼v]$/i, '')
        .trim();
    };

    const isValidName = (str) => {
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
    };

    // 1. Try document.title
    const docTitle = this._doc.title || '';
    if (docTitle) {
      const cleaned = cleanTitle(docTitle);
      if (isValidName(cleaned)) return cleaned;
    }

    // 2. Try top bar dropdown button
    const topBarButtons = this._doc.querySelectorAll(
      '[role="main"] button, [role="main"] [role="button"], div[role="banner"] [role="button"], [jscontroller] [role="button"]'
    );
    for (const btn of topBarButtons) {
      const aria = btn.getAttribute('aria-label') || '';
      if (aria) {
        const cleanedAria = cleanTitle(aria);
        if (isValidName(cleanedAria) && !aria.toLowerCase().includes('search')) {
          return cleanedAria;
        }
      }
      const spans = btn.querySelectorAll('span[dir="auto"], div[dir="auto"]');
      for (const sp of spans) {
        const txt = cleanTitle(sp.innerText || sp.textContent);
        if (isValidName(txt)) return txt;
      }
    }

    // 3. Welcome card / heading in main stream
    const welcomeHeadings = this._doc.querySelectorAll(
      '[role="main"] h1, [role="main"] h2, [role="main"] [role="heading"], [role="main"] .Yv3xrd, [role="main"] [data-conversation-title]'
    );
    for (const h of welcomeHeadings) {
      const txt = cleanTitle(h.innerText || h.textContent);
      if (isValidName(txt)) return txt;
    }

    // 4. Match active conversation link in sidebar using current URL pathname
    if (this._loc) {
      const pathParts = (this._loc.pathname || '').split('/').filter(Boolean);
      const convoId = pathParts[pathParts.length - 1];
      if (convoId && convoId.length >= 4) {
        const activeLink = this._doc.querySelector(`a[href*="${convoId}"], [data-id*="${convoId}"]`);
        if (activeLink) {
          const label = activeLink.getAttribute('aria-label') ||
                        activeLink.querySelector('[dir="auto"]')?.textContent ||
                        activeLink.innerText || '';
          const cleaned = cleanTitle(label);
          if (isValidName(cleaned)) return cleaned;
        }
      }
    }

    // 5. Active item in sidebar navigation
    const activeSidebarItem = this._doc.querySelector(
      '[role="navigation"] [aria-selected="true"], [role="treeitem"][aria-selected="true"], [aria-current="page"]'
    );
    if (activeSidebarItem) {
      const label = activeSidebarItem.getAttribute('aria-label') ||
                    activeSidebarItem.querySelector('[dir="auto"]')?.textContent ||
                    activeSidebarItem.innerText || '';
      const cleaned = cleanTitle(label);
      if (isValidName(cleaned)) return cleaned;
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
