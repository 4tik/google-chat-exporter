/**
 * @file popup.js
 * @description Google Chat Exporter popup interface controller.
 * Auto-injects content scripts if needed, handles tab reconnections,
 * and executes full-history HTML export with embedded offline media.
 */

'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const wrongTabView = document.getElementById('wrong-tab-view');
  const mainContent = document.getElementById('main-content');
  const openChatBtn = document.getElementById('open-chat-btn');
  const statusPill = document.getElementById('status-pill');

  // Conversation Info
  const conversationNameEl = document.getElementById('conversation-name');
  const conversationTypeBadge = document.getElementById('conversation-type-badge');
  const exportStatusBadge = document.getElementById('export-status-badge');

  // Discovered Metrics
  const metricDiscoveredMessages = document.getElementById('metric-discovered-messages');
  const metricDiscoveredThreads = document.getElementById('metric-discovered-threads');
  const metricDiscoveredReplies = document.getElementById('metric-discovered-replies');
  const metricDiscoveredAttachments = document.getElementById('metric-discovered-attachments');

  // Progress Card Elements
  const progressCard = document.getElementById('progress-card');
  const progressPhaseText = document.getElementById('progress-phase-text');
  const progressPercentText = document.getElementById('progress-percent-text');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressDetailText = document.getElementById('progress-detail-text');

  const metricProcessedMessages = document.getElementById('metric-processed-messages');
  const metricProcessedThreads = document.getElementById('metric-processed-threads');
  const metricProcessedReplies = document.getElementById('metric-processed-replies');
  const metricProcessedAttachments = document.getElementById('metric-processed-attachments');
  const metricTime = document.getElementById('metric-time');

  // Success & Error Cards
  const successCard = document.getElementById('success-card');
  const successHeadline = document.getElementById('success-headline');
  const successFilename = document.getElementById('success-filename');
  const successStatsBox = document.getElementById('success-stats-box');

  const errorCard = document.getElementById('error-card');
  const errorMessage = document.getElementById('error-message');

  // Action Buttons
  const exportBtn = document.getElementById('export-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const resetBtn = document.getElementById('reset-btn');

  let activeTab = null;
  let timerInterval = null;
  let startTime = null;
  let isExporting = false;

  // Open Chat Button
  openChatBtn?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://chat.google.com' });
  });

  /**
   * Automatically ensures content script is injected into the active tab.
   * Eliminates the "Could not establish connection. Receiving end does not exist" error
   * when users reload the extension without refreshing existing Google Chat tabs!
   */
  async function ensureContentScriptInjected(tabId) {
    if (!tabId) return false;

    // 1. Try to ping existing content script
    try {
      const pingResponse = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'PING' }, (res) => {
          if (chrome.runtime.lastError || !res) resolve(null);
          else resolve(res);
        });
      });
      if (pingResponse && pingResponse.status === 'PONG') {
        return true;
      }
    } catch (_) {}

    // 2. If no response, dynamically inject scripts using chrome.scripting API
    try {
      if (chrome.scripting && chrome.scripting.executeScript) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['jszip.min.js', 'jspdf.umd.min.js', 'content.js']
        });
        await new Promise((r) => setTimeout(r, 250));
        return true;
      }
    } catch (err) {
      console.warn('[Google Chat Exporter] Script injection failed:', err);
    }

    return false;
  }

  // Check Active Tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];

    const url = activeTab?.url || '';
    const isGoogleChat = url.includes('chat.google.com') || (url.includes('mail.google.com') && url.includes('chat'));

    if (!isGoogleChat) {
      wrongTabView?.classList.remove('hidden');
      mainContent?.classList.add('hidden');
      statusPill.textContent = 'Disconnected';
      statusPill.style.background = '#fef2f2';
      statusPill.style.color = '#dc2626';
      return;
    }

    wrongTabView?.classList.add('hidden');
    mainContent?.classList.remove('hidden');
    statusPill.textContent = 'Connected';

    // Ensure script injection and scan info
    await ensureContentScriptInjected(activeTab.id);
    scanConversationInfo();
  } catch (err) {
    console.error('Initialization error:', err);
  }

  function formatConversationType(type) {
    if (!type) return 'Direct Message';
    const t = String(type).toUpperCase();
    if (t === 'DIRECT_MESSAGE' || t.includes('DIRECT')) return 'Direct Message';
    if (t === 'GROUP_CHAT' || t.includes('GROUP')) return 'Group Chat';
    if (t === 'SPACE') return 'Space';
    return type;
  }

  // Scan Active Conversation Info
  function scanConversationInfo() {
    if (!activeTab?.id) return;

    chrome.tabs.sendMessage(activeTab.id, { action: 'GET_CHAT_INFO' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        conversationNameEl.textContent = 'Active Google Chat';
        exportStatusBadge.textContent = 'Ready to export';
        return;
      }

      conversationNameEl.textContent = response.name || 'Google Chat Conversation';
      conversationTypeBadge.textContent = formatConversationType(response.type);
      exportStatusBadge.textContent = 'Ready to export';

      if (metricDiscoveredMessages) metricDiscoveredMessages.textContent = response.totalMessages || 0;
      if (metricDiscoveredThreads) metricDiscoveredThreads.textContent = response.totalThreads || 0;
      if (metricDiscoveredReplies) metricDiscoveredReplies.textContent = response.totalReplies || 0;
      if (metricDiscoveredAttachments) metricDiscoveredAttachments.textContent = response.totalAttachments || 0;
    });
  }

  // Start Export Handler: ALWAYS WHOLE CHAT + HTML + MEDIA
  exportBtn?.addEventListener('click', async () => {
    if (isExporting || !activeTab?.id) return;

    // Ensure content script is live before starting
    const injected = await ensureContentScriptInjected(activeTab.id);
    if (!injected) {
      showError('Please refresh your Google Chat tab (F5) once and click Export again.');
      return;
    }

    isExporting = true;

    // UI Updates
    exportBtn.classList.add('hidden');
    cancelBtn.classList.remove('hidden');
    resetBtn.classList.add('hidden');
    progressCard.classList.remove('hidden');
    successCard.classList.add('hidden');
    errorCard.classList.add('hidden');

    progressPhaseText.textContent = 'Paginating whole chat history...';
    exportStatusBadge.textContent = 'Paginating history...';
    progressPercentText.textContent = '0%';
    progressBarFill.style.width = '0%';

    // Start Timer
    startTime = Date.now();
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      if (metricTime) metricTime.textContent = `${m}:${s}`;
    }, 1000);

    // Trigger full export in content script
    chrome.tabs.sendMessage(activeTab.id, { action: 'START_EXPORT' }, (response) => {
      clearInterval(timerInterval);
      isExporting = false;

      exportBtn.classList.remove('hidden');
      cancelBtn.classList.add('hidden');
      resetBtn.classList.remove('hidden');

      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || '';
        if (errMsg.includes('Receiving end does not exist')) {
          showError('Connection refreshed. Please reload your Google Chat tab (F5) and click Export.');
        } else {
          showError(errMsg);
        }
        exportStatusBadge.textContent = 'Export incomplete';
        return;
      }

      if (response && response.cancelled) {
        progressPhaseText.textContent = 'Export cancelled';
        exportStatusBadge.textContent = 'Export cancelled';
        return;
      }

      if (response && response.success) {
        showSuccess(response.result || {});
        exportStatusBadge.textContent = 'Export completed';
      } else {
        showError(response?.error || 'Extraction failed.');
        exportStatusBadge.textContent = 'Export incomplete';
      }
    });
  });

  // Cancel Handler
  cancelBtn?.addEventListener('click', () => {
    if (!activeTab?.id) return;
    chrome.tabs.sendMessage(activeTab.id, { action: 'CANCEL_EXPORT' }, () => {
      progressPhaseText.textContent = 'Cancelling export...';
      exportStatusBadge.textContent = 'Cancelling...';
    });
  });

  // Reset Handler
  resetBtn?.addEventListener('click', () => {
    progressCard.classList.add('hidden');
    successCard.classList.add('hidden');
    errorCard.classList.add('hidden');
    resetBtn.classList.add('hidden');
    exportStatusBadge.textContent = 'Ready to export';
    scanConversationInfo();
  });

  // Real-time Progress Listener from Content Script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'EXPORT_PROGRESS') {
      const data = msg.data || {};
      if (data.phase) {
        progressPhaseText.textContent = data.phase;
        exportStatusBadge.textContent = data.phase;
      }
      if (data.percent !== undefined) {
        progressPercentText.textContent = `${data.percent}%`;
        progressBarFill.style.width = `${data.percent}%`;
      }
      if (data.messages !== undefined && metricProcessedMessages) metricProcessedMessages.textContent = data.messages;
      if (data.threads !== undefined && metricProcessedThreads) metricProcessedThreads.textContent = data.threads;
      if (data.replies !== undefined && metricProcessedReplies) metricProcessedReplies.textContent = data.replies;
      if (data.attachments !== undefined && metricProcessedAttachments) metricProcessedAttachments.textContent = data.attachments;
    }
  });

  function showSuccess(result) {
    progressCard.classList.add('hidden');
    successCard.classList.remove('hidden');
    successFilename.textContent = result.filename || 'GoogleChat_Export.html';

    if (successStatsBox) {
      successStatsBox.innerHTML = `
        <div style="display:flex; justify-content:space-around; padding:10px 0; font-size:12px; background:var(--bg-primary); border-radius:8px; margin-top:8px;">
          <div><strong>${result.totalMessages || 0}</strong> Messages</div>
          <div><strong>${result.totalThreads || 0}</strong> Threads</div>
          <div><strong>${result.totalReplies || 0}</strong> Replies</div>
          <div><strong>${result.totalAttachments || 0}</strong> Media</div>
        </div>
      `;
    }
  }

  function showError(msg) {
    progressCard.classList.add('hidden');
    errorCard.classList.remove('hidden');
    errorMessage.textContent = msg;
  }
});
