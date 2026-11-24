/**
 * @file jsonExporter.js
 * @module JsonExporter
 * @description Generates structured, validated JSON preserving the exact
 * parent message -> multiple independent threads -> replies hierarchy.
 */

'use strict';

export class JsonExporter {
  /**
   * Generates a structured JSON string or object from a normalized conversation.
   *
   * @param {Object} conversation - Normalized conversation object
   * @param {Object} [metadata]    - Export metadata
   * @param {boolean} [pretty=true]- Whether to format with indentation
   * @returns {string} JSON string
   */
  static export(conversation, metadata = {}, pretty = true) {
    const convoName = metadata.name || conversation.name || 'Google Chat Conversation';
    const convoType = metadata.type || conversation.type || 'SPACE';
    const convoId = metadata.id || conversation.id || 'chat_convo';
    const exportedAt = metadata.exportedAt || conversation.exportedAt || new Date().toISOString();

    const messages = conversation.messages || [];

    // Calculate totals
    let totalThreads = 0;
    let totalReplies = 0;
    let totalAttachments = 0;

    const formattedMessages = messages.map((msg, mIdx) => {
      if (msg.attachments) totalAttachments += msg.attachments.length;

      const threads = (msg.threads || []).map((t, tIdx) => {
        totalThreads++;
        const replies = (t.replies || []).map(r => {
          totalReplies++;
          if (r.attachments) totalAttachments += r.attachments.length;
          return {
            id: r.id,
            threadId: r.threadId || t.id,
            parentMessageId: r.parentMessageId || msg.id,
            sender: {
              id: r.sender?.id || null,
              name: r.sender?.name || 'Participant',
              avatarUrl: r.sender?.avatarUrl || null
            },
            text: r.text || '',
            timestamp: r.timestamp || null,
            edited: Boolean(r.edited),
            reactions: r.reactions || [],
            attachments: (r.attachments || []).map(a => ({
              id: a.id,
              type: a.type || 'file',
              filename: a.filename || a.name || '',
              url: a.url || '',
              previewUrl: a.previewUrl || null,
              isAccessible: a.isAccessible !== undefined ? a.isAccessible : true
            }))
          };
        });

        return {
          id: t.id || `THREAD-${String(tIdx + 1).padStart(3, '0')}`,
          title: t.title || `Thread ${tIdx + 1}`,
          threadIndex: t.threadIndex !== undefined ? t.threadIndex : (tIdx + 1),
          replyCount: t.replyCount !== undefined ? t.replyCount : replies.length,
          status: t.status || 'complete',
          replies: replies
        };
      });

      return {
        id: msg.id || `MSG-${String(mIdx + 1).padStart(3, '0')}`,
        sender: {
          id: msg.sender?.id || null,
          name: msg.sender?.name || 'Participant',
          avatarUrl: msg.sender?.avatarUrl || null
        },
        text: msg.text || '',
        timestamp: msg.timestamp || null,
        edited: Boolean(msg.edited),
        reactions: msg.reactions || [],
        attachments: (msg.attachments || []).map(a => ({
          id: a.id,
          type: a.type || 'file',
          filename: a.filename || a.name || '',
          url: a.url || '',
          previewUrl: a.previewUrl || null,
          isAccessible: a.isAccessible !== undefined ? a.isAccessible : true
        })),
        threads: threads
      };
    });

    const exportPayload = {
      conversation: {
        id: convoId,
        name: convoName,
        type: convoType
      },
      export: {
        exportedAt: exportedAt,
        version: '1.0',
        stats: {
          totalMessages: formattedMessages.length,
          totalThreads: totalThreads,
          totalReplies: totalReplies,
          totalAttachments: totalAttachments
        }
      },
      messages: formattedMessages
    };

    return pretty ? JSON.stringify(exportPayload, null, 2) : JSON.stringify(exportPayload);
  }
}
