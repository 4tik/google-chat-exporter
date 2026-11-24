/**
 * @file test_scenarios.test.js
 * @description Comprehensive automated test suite verifying all 12 scenarios
 * and hierarchy preservation across Google Chat Exporter modules.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ChatDetector, ConversationType, ThreadMode } from '../src/modules/chatDetector.js';
import { ThreadExtractor, ThreadStatus } from '../src/modules/threadExtractor.js';
import { ReplyExtractor } from '../src/modules/replyExtractor.js';
import { DataNormalizer } from '../src/modules/dataNormalizer.js';
import { DuplicateManager } from '../src/modules/duplicateManager.js';
import { PaginationManager, PaginationResult } from '../src/modules/paginationManager.js';
import { HtmlExporter } from '../src/exporters/htmlExporter.js';
import { JsonExporter } from '../src/exporters/jsonExporter.js';

describe('Google Chat Exporter - Advanced Thread Support Test Suite', () => {

  // ─── Scenario 1: One parent message with no threads ─────────────────────────
  it('Scenario 1: Handles one parent message with no threads', () => {
    const normalizer = new DataNormalizer();
    const rawMessages = [{
      id: 'MSG-001',
      sender: { name: 'Atikur Rahman' },
      text: 'Simple announcement with no replies.',
      timestamp: '2026-11-24T10:00:00Z'
    }];

    const conversation = normalizer.buildConversation(rawMessages, [], [], []);

    assert.equal(conversation.messages.length, 1);
    assert.equal(conversation.messages[0].id, 'MSG-001');
    assert.equal(conversation.messages[0].threads.length, 0);

    // Verify JSON export
    const jsonStr = JsonExporter.export(conversation);
    const parsed = JSON.parse(jsonStr);
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].threads.length, 0);
    assert.equal(parsed.export.stats.totalThreads, 0);
    assert.equal(parsed.export.stats.totalReplies, 0);

    // Verify HTML export
    const html = HtmlExporter.export(conversation);
    assert.match(html, /Simple announcement with no replies/);
    assert.doesNotMatch(html, /class="thread-card"/);
  });

  // ─── Scenario 2: One parent message with one thread ──────────────────────────
  it('Scenario 2: Handles one parent message with one thread', () => {
    const normalizer = new DataNormalizer();
    const rawMessages = [{
      id: 'MSG-001',
      sender: { name: 'Atikur Rahman' },
      text: 'Parent message for single thread.',
      timestamp: '2026-11-24T10:00:00Z'
    }];

    const rawThreads = [{
      id: 'THREAD-001',
      parentMessageId: 'MSG-001',
      threadIndex: 1,
      replyCount: 2
    }];

    const rawReplies = [
      {
        id: 'REPLY-001',
        threadId: 'THREAD-001',
        sender: { name: 'Farhan Akhanda' },
        text: 'First reply',
        timestamp: '2026-11-24T10:05:00Z'
      },
      {
        id: 'REPLY-002',
        threadId: 'THREAD-001',
        sender: { name: 'Atikur Rahman' },
        text: 'Second reply',
        timestamp: '2026-11-24T10:10:00Z'
      }
    ];

    const conversation = normalizer.buildConversation(rawMessages, rawThreads, rawReplies, []);

    assert.equal(conversation.messages.length, 1);
    assert.equal(conversation.messages[0].threads.length, 1);
    assert.equal(conversation.messages[0].threads[0].id, 'THREAD-001');
    assert.equal(conversation.messages[0].threads[0].replies.length, 2);
    assert.equal(conversation.messages[0].threads[0].replies[0].sender.name, 'Farhan Akhanda');

    const json = JSON.parse(JsonExporter.export(conversation));
    assert.equal(json.export.stats.totalThreads, 1);
    assert.equal(json.export.stats.totalReplies, 2);
  });

  // ─── Scenario 3: CRITICAL SCENARIO - One parent message with 5 independent threads
  it('Scenario 3: Preserves 5 independent threads under one parent message separately without merging', () => {
    const normalizer = new DataNormalizer();
    const rawMessages = [{
      id: 'MSG-001',
      sender: { name: 'Atikur Rahman' },
      text: 'Please review the project update.',
      timestamp: '2026-11-24T10:00:00Z'
    }];

    const rawThreads = [
      { id: 'THREAD-001', parentMessageId: 'MSG-001', threadIndex: 1, replyCount: 2 },
      { id: 'THREAD-002', parentMessageId: 'MSG-001', threadIndex: 2, replyCount: 3 },
      { id: 'THREAD-003', parentMessageId: 'MSG-001', threadIndex: 3, replyCount: 1 },
      { id: 'THREAD-004', parentMessageId: 'MSG-001', threadIndex: 4, replyCount: 4 },
      { id: 'THREAD-005', parentMessageId: 'MSG-001', threadIndex: 5, replyCount: 2 }
    ];

    const rawReplies = [
      // Thread 1
      { id: 'R-1-1', threadId: 'THREAD-001', sender: { name: 'Farhan Akhanda' }, text: 'Thread 1 Reply 1', timestamp: '2026-11-24T10:01:00Z' },
      { id: 'R-1-2', threadId: 'THREAD-001', sender: { name: 'Atikur Rahman' }, text: 'Thread 1 Reply 2', timestamp: '2026-11-24T10:02:00Z' },
      // Thread 2
      { id: 'R-2-1', threadId: 'THREAD-002', sender: { name: 'Abdullah Al Masum' }, text: 'Thread 2 Reply 1', timestamp: '2026-11-24T10:03:00Z' },
      { id: 'R-2-2', threadId: 'THREAD-002', sender: { name: 'Karim Hossain' }, text: 'Thread 2 Reply 2', timestamp: '2026-11-24T10:04:00Z' },
      { id: 'R-2-3', threadId: 'THREAD-002', sender: { name: 'Abdullah Al Masum' }, text: 'Thread 2 Reply 3', timestamp: '2026-11-24T10:05:00Z' },
      // Thread 3
      { id: 'R-3-1', threadId: 'THREAD-003', sender: { name: 'Rahim Ahmed' }, text: 'Thread 3 Reply 1', timestamp: '2026-11-24T10:06:00Z' },
      // Thread 4
      { id: 'R-4-1', threadId: 'THREAD-004', sender: { name: 'Karim Hossain' }, text: 'Thread 4 Reply 1', timestamp: '2026-11-24T10:07:00Z' },
      { id: 'R-4-2', threadId: 'THREAD-004', sender: { name: 'Sakib Hasan' }, text: 'Thread 4 Reply 2', timestamp: '2026-11-24T10:08:00Z' },
      { id: 'R-4-3', threadId: 'THREAD-004', sender: { name: 'Karim Hossain' }, text: 'Thread 4 Reply 3', timestamp: '2026-11-24T10:09:00Z' },
      { id: 'R-4-4', threadId: 'THREAD-004', sender: { name: 'Sakib Hasan' }, text: 'Thread 4 Reply 4', timestamp: '2026-11-24T10:10:00Z' },
      // Thread 5
      { id: 'R-5-1', threadId: 'THREAD-005', sender: { name: 'Sakib Hasan' }, text: 'Thread 5 Reply 1', timestamp: '2026-11-24T10:11:00Z' },
      { id: 'R-5-2', threadId: 'THREAD-005', sender: { name: 'Atikur Rahman' }, text: 'Thread 5 Reply 2', timestamp: '2026-11-24T10:12:00Z' }
    ];

    const conversation = normalizer.buildConversation(rawMessages, rawThreads, rawReplies, []);

    // 1. Verify parent message contains EXACTLY 5 independent threads
    assert.equal(conversation.messages.length, 1);
    const parentMsg = conversation.messages[0];
    assert.equal(parentMsg.threads.length, 5, 'Must contain 5 separate threads');

    // 2. Verify each thread has its exact replies preserved separately
    assert.equal(parentMsg.threads[0].id, 'THREAD-001');
    assert.equal(parentMsg.threads[0].replies.length, 2);

    assert.equal(parentMsg.threads[1].id, 'THREAD-002');
    assert.equal(parentMsg.threads[1].replies.length, 3);

    assert.equal(parentMsg.threads[2].id, 'THREAD-003');
    assert.equal(parentMsg.threads[2].replies.length, 1);

    assert.equal(parentMsg.threads[3].id, 'THREAD-004');
    assert.equal(parentMsg.threads[3].replies.length, 4);

    assert.equal(parentMsg.threads[4].id, 'THREAD-005');
    assert.equal(parentMsg.threads[4].replies.length, 2);

    // 3. Verify JSON export preserves exact 5 threads
    const jsonStr = JsonExporter.export(conversation);
    const json = JSON.parse(jsonStr);
    assert.equal(json.messages[0].threads.length, 5);
    assert.equal(json.export.stats.totalThreads, 5);
    assert.equal(json.export.stats.totalReplies, 12);

    // 4. Verify HTML export contains 5 distinct thread cards
    const html = HtmlExporter.export(conversation);
    const threadCardMatches = html.match(/class="thread-card"/g);
    assert.equal(threadCardMatches?.length, 5, 'HTML must render 5 distinct thread cards');
    assert.match(html, /Thread 1/);
    assert.match(html, /Thread 5/);
  });

  // ─── Scenario 4: One parent message with 20+ threads ────────────────────────
  it('Scenario 4: Handles parent message with 20+ threads gracefully', () => {
    const normalizer = new DataNormalizer();
    const rawMessages = [{
      id: 'MSG-001',
      sender: { name: 'Coordinator' },
      text: 'Massive thread container',
      timestamp: '2026-11-24T00:00:00Z'
    }];

    const rawThreads = [];
    const rawReplies = [];

    for (let i = 1; i <= 25; i++) {
      const threadId = `THREAD-${String(i).padStart(3, '0')}`;
      rawThreads.push({
        id: threadId,
        parentMessageId: 'MSG-001',
        threadIndex: i,
        replyCount: 2
      });
      rawReplies.push(
        { id: `R-${i}-1`, threadId, sender: { name: `User ${i}` }, text: `Reply A in thread ${i}`, timestamp: '2026-11-24T00:01:00Z' },
        { id: `R-${i}-2`, threadId, sender: { name: `User ${i}` }, text: `Reply B in thread ${i}`, timestamp: '2026-11-24T00:02:00Z' }
      );
    }

    const conversation = normalizer.buildConversation(rawMessages, rawThreads, rawReplies, []);
    assert.equal(conversation.messages[0].threads.length, 25);
    assert.equal(conversation.messages[0].threads[24].replies.length, 2);

    const json = JSON.parse(JsonExporter.export(conversation));
    assert.equal(json.export.stats.totalThreads, 25);
    assert.equal(json.export.stats.totalReplies, 50);
  });

  // ─── Scenario 5: Multiple parent messages, each with multiple threads ─────────
  it('Scenario 5: Handles multiple parent messages each with multiple threads', () => {
    const normalizer = new DataNormalizer();
    const rawMessages = [
      { id: 'MSG-001', sender: { name: 'Alice' }, text: 'Topic A', timestamp: '2026-11-24T01:00:00Z' },
      { id: 'MSG-002', sender: { name: 'Bob' }, text: 'Topic B', timestamp: '2026-11-24T02:00:00Z' }
    ];

    const rawThreads = [
      { id: 'T-1-1', parentMessageId: 'MSG-001', threadIndex: 1 },
      { id: 'T-1-2', parentMessageId: 'MSG-001', threadIndex: 2 },
      { id: 'T-2-1', parentMessageId: 'MSG-002', threadIndex: 1 },
      { id: 'T-2-2', parentMessageId: 'MSG-002', threadIndex: 2 },
      { id: 'T-2-3', parentMessageId: 'MSG-002', threadIndex: 3 }
    ];

    const rawReplies = [
      { id: 'R-1-1-1', threadId: 'T-1-1', text: 'Reply to T-1-1', timestamp: '2026-11-24T01:01:00Z' },
      { id: 'R-2-3-1', threadId: 'T-2-3', text: 'Reply to T-2-3', timestamp: '2026-11-24T02:05:00Z' }
    ];

    const conversation = normalizer.buildConversation(rawMessages, rawThreads, rawReplies, []);
    assert.equal(conversation.messages.length, 2);
    assert.equal(conversation.messages[0].threads.length, 2);
    assert.equal(conversation.messages[1].threads.length, 3);
  });

  // ─── Scenario 6: Threads containing different numbers of replies ─────────────
  it('Scenario 6: Correctly associates variable numbers of replies to respective threads', () => {
    const normalizer = new DataNormalizer();
    const rawMessages = [{ id: 'MSG-001', sender: { name: 'Alice' }, text: 'Parent' }];
    const rawThreads = [
      { id: 'T-EMPTY', parentMessageId: 'MSG-001', threadIndex: 1 },
      { id: 'T-SINGLE', parentMessageId: 'MSG-001', threadIndex: 2 },
      { id: 'T-MANY', parentMessageId: 'MSG-001', threadIndex: 3 }
    ];
    const rawReplies = [
      { id: 'R-S1', threadId: 'T-SINGLE', text: 'Only reply' },
      { id: 'R-M1', threadId: 'T-MANY', text: 'Reply 1' },
      { id: 'R-M2', threadId: 'T-MANY', text: 'Reply 2' },
      { id: 'R-M3', threadId: 'T-MANY', text: 'Reply 3' }
    ];

    const conversation = normalizer.buildConversation(rawMessages, rawThreads, rawReplies, []);
    assert.equal(conversation.messages[0].threads[0].replies.length, 0);
    assert.equal(conversation.messages[0].threads[1].replies.length, 1);
    assert.equal(conversation.messages[0].threads[2].replies.length, 3);
  });

  // ─── Scenario 7: Threads containing images and attachments ──────────────────
  it('Scenario 7: Preserves attachments under original parent messages or specific replies without moving', () => {
    const normalizer = new DataNormalizer();
    const rawMessages = [{
      id: 'MSG-001',
      sender: { name: 'Alice' },
      text: 'Parent with image',
      attachments: [{ id: 'ATT-PARENT', type: 'image', filename: 'chart.png', url: 'https://cdn/chart.png' }]
    }];

    const rawThreads = [{ id: 'T-001', parentMessageId: 'MSG-001', threadIndex: 1 }];
    const rawReplies = [{
      id: 'R-001',
      threadId: 'T-001',
      sender: { name: 'Bob' },
      text: 'Reply with PDF',
      attachments: [{ id: 'ATT-REPLY', type: 'document', filename: 'report.pdf', url: 'https://cdn/report.pdf' }]
    }];

    const conversation = normalizer.buildConversation(rawMessages, rawThreads, rawReplies, []);

    assert.equal(conversation.messages[0].attachments.length, 1);
    assert.equal(conversation.messages[0].attachments[0].filename, 'chart.png');

    assert.equal(conversation.messages[0].threads[0].replies[0].attachments.length, 1);
    assert.equal(conversation.messages[0].threads[0].replies[0].attachments[0].filename, 'report.pdf');
  });

  // ─── Scenario 8: Long conversations with pagination ──────────────────────────
  it('Scenario 8: PaginationManager controls upward retrieval with stall detection and limits', async () => {
    let mockScrollTop = 500;
    let mockMessageCount = 10;

    const mockScroller = {
      scrollTop: mockScrollTop,
      scrollHeight: 2000,
      clientHeight: 500
    };

    const paginator = new PaginationManager({
      scrollContainer: mockScroller,
      stepDelay: 10,
      maxIterations: 5,
      stallThreshold: 2
    });

    const result = await paginator.retrieveOlderMessages({
      getMessageCount: () => {
        mockMessageCount += 2;
        return mockMessageCount;
      }
    });

    assert.equal(result.result, PaginationResult.MAX_ITERATIONS_REACHED);
    assert.equal(result.iterations, 5);
  });

  // ─── Scenario 9: Partially loaded conversations & honest completeness report ──
  it('Scenario 9: Detects incomplete or missing thread data without inventing content', () => {
    const normalizer = new DataNormalizer();
    const rawMessages = [{ id: 'MSG-001', sender: { name: 'Alice' }, text: 'Parent' }];
    const rawThreads = [{
      id: 'T-PARTIAL',
      parentMessageId: 'MSG-001',
      threadIndex: 1,
      replyCount: 5 // Expected 5 replies, but only 2 extracted
    }];
    const rawReplies = [
      { id: 'R-1', threadId: 'T-PARTIAL', text: 'Reply 1' },
      { id: 'R-2', threadId: 'T-PARTIAL', text: 'Reply 2' }
    ];

    const conversation = normalizer.buildConversation(rawMessages, rawThreads, rawReplies, []);
    const report = normalizer.validateCompleteness(conversation);

    assert.equal(report.complete, false);
    assert.ok(report.warnings.some(w => w.includes('declares replyCount=5 but only 2 replies were extracted')));
  });

  // ─── Scenario 10: Duplicate messages and repeated extraction ─────────────────
  it('Scenario 10: Prevents duplicate messages, threads, and replies during repeated extraction', () => {
    const dm = new DuplicateManager();

    // Message deduplication
    assert.equal(dm.trackMessage('MSG-001'), true);
    assert.equal(dm.trackMessage('MSG-001'), false);
    assert.equal(dm.hasMessage('MSG-001'), true);

    // Thread deduplication
    assert.equal(dm.trackThread('THREAD-001'), true);
    assert.equal(dm.trackThread('THREAD-001'), false);

    // Reply deduplication
    assert.equal(dm.trackReply('REPLY-001'), true);
    assert.equal(dm.trackReply('REPLY-001'), false);
  });

  // ─── Scenario 11: Edited messages where detectable ───────────────────────────
  it('Scenario 11: Detects and preserves edited status correctly', () => {
    const normalizer = new DataNormalizer();
    const rawMessages = [
      { id: 'MSG-001', text: 'Edited text', edited: true },
      { id: 'MSG-002', text: 'Unedited text', edited: false }
    ];

    const conversation = normalizer.buildConversation(rawMessages, [], [], []);
    assert.equal(conversation.messages[0].edited, true);
    assert.equal(conversation.messages[1].edited, false);
  });

  // ─── Scenario 12: Network interruptions during export & cancellation ─────────
  it('Scenario 12: Safely handles cancellation requests during active operations', async () => {
    const paginator = new PaginationManager({
      scrollContainer: { scrollTop: 100, scrollHeight: 1000, clientHeight: 300 },
      stepDelay: 10,
      maxIterations: 100
    });

    setTimeout(() => paginator.cancel(), 25);

    const result = await paginator.retrieveOlderMessages({
      getMessageCount: () => 1
    });

    assert.equal(result.result, PaginationResult.CANCELLED);
  });

  // ─── Hierarchy & Count Preservation Across Formats ───────────────────────────
  it('Verifies HTML and JSON exports preserve identical hierarchy and item counts', () => {
    const normalizer = new DataNormalizer();
    const rawMessages = [{ id: 'M1', text: 'P1' }, { id: 'M2', text: 'P2' }];
    const rawThreads = [
      { id: 'T1-1', parentMessageId: 'M1', threadIndex: 1 },
      { id: 'T1-2', parentMessageId: 'M1', threadIndex: 2 },
      { id: 'T2-1', parentMessageId: 'M2', threadIndex: 1 }
    ];
    const rawReplies = [
      { id: 'R1', threadId: 'T1-1', text: 'R1' },
      { id: 'R2', threadId: 'T1-1', text: 'R2' },
      { id: 'R3', threadId: 'T1-2', text: 'R3' },
      { id: 'R4', threadId: 'T2-1', text: 'R4' }
    ];

    const conversation = normalizer.buildConversation(rawMessages, rawThreads, rawReplies, []);

    // JSON verification
    const json = JSON.parse(JsonExporter.export(conversation));
    assert.equal(json.export.stats.totalMessages, 2);
    assert.equal(json.export.stats.totalThreads, 3);
    assert.equal(json.export.stats.totalReplies, 4);

    // HTML verification
    const html = HtmlExporter.export(conversation);
    const parentMatches = html.match(/class="parent-message-card"/g);
    const threadMatches = html.match(/class="thread-card"/g);
    const replyMatches = html.match(/class="reply-row"/g);

    assert.equal(parentMatches?.length, 2);
    assert.equal(threadMatches?.length, 3);
    assert.equal(replyMatches?.length, 4);
  });

});
