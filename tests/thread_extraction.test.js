/**
 * @file thread_extraction.test.js
 * @description In-depth tests for ThreadExtractor and ReplyExtractor APIs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ThreadExtractor, ThreadStatus } from '../src/modules/threadExtractor.js';
import { ReplyExtractor } from '../src/modules/replyExtractor.js';
import { DuplicateManager } from '../src/modules/duplicateManager.js';

describe('ThreadExtractor & ReplyExtractor In-Depth Unit Tests', () => {

  it('ThreadExtractor registers and retrieves threads by parent and ID', () => {
    const dm = new DuplicateManager();
    const te = new ThreadExtractor({ duplicateManager: dm });

    const t1 = te.registerThread({
      id: 'T-001',
      parentMessageId: 'P-100',
      threadIndex: 1,
      title: 'Topic Alpha',
      replyCount: 3
    });

    const t2 = te.registerThread({
      id: 'T-002',
      parentMessageId: 'P-100',
      threadIndex: 2,
      title: 'Topic Beta',
      replyCount: 5
    });

    assert.equal(te.size, 2);
    assert.equal(te.getThreadById('T-001')?.title, 'Topic Alpha');
    assert.equal(te.getThreadsForParent('P-100').length, 2);
    assert.equal(te.getThreadsForParent('P-100')[1].id, 'T-002');
  });

  it('ReplyExtractor associates replies to threads with chronological ordering', () => {
    const re = new ReplyExtractor();

    re.registerReply({
      id: 'R-2',
      threadId: 'T-001',
      parentMessageId: 'P-100',
      sender: { name: 'Bob' },
      text: 'Later reply',
      timestamp: '2026-11-24T12:00:00Z'
    });

    re.registerReply({
      id: 'R-1',
      threadId: 'T-001',
      parentMessageId: 'P-100',
      sender: { name: 'Alice' },
      text: 'Earlier reply',
      timestamp: '2026-11-24T11:00:00Z'
    });

    const replies = re.getRepliesForThread('T-001');
    assert.equal(replies.length, 2);
    assert.equal(re.size, 2);
    assert.equal(re.getReplyById('R-1')?.sender.name, 'Alice');
  });

  it('ThreadExtractor correctly deduplicates threads using DuplicateManager', () => {
    const dm = new DuplicateManager();
    const te = new ThreadExtractor({ duplicateManager: dm });

    te.registerThread({ id: 'THREAD-X', parentMessageId: 'P-1' });
    te.registerThread({ id: 'THREAD-X', parentMessageId: 'P-1' });

    assert.equal(te.getThreadsForParent('P-1').length, 1);
  });
});
