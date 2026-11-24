/**
 * @file popup.js
 * @description Google Chat Exporter popup interface controller.
 * Displays conversation context, live metrics (messages, threads, replies, attachments),
 * export format controls (HTML, PDF, JSON, ZIP), real-time progress, and cancellation.
 */

'use strict';

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

  // Scope Tabs
  const tabScopeSingle = document.getElementById('tab-scope-single');
  const tabScopeBatch = document.getElementById('tab-scope-batch');
  const singleChatView = document.getElementById('single-chat-view');
  const batchChatView = document.getElementById('batch-chat-view');

  // Batch Selection Elements
  const refreshConvosBtn = document.getElementById('refresh-convos-btn');
  const batchSearchInput = document.getElementById('batch-search-input');
  const selectAllBtn = document.getElementById('select-all-btn');
  const deselectAllBtn = document.getElementById('deselect-all-btn');
  const conversationListEl = document.getElementById('conversation-list');
  const batchSelectionCountEl = document.getElementById('batch-selection-count');

  // Format Radios
  const formatHtmlRadio = document.getElementById('format-html');
  const formatPdfRadio = document.getElementById('format-pdf');
  const formatJsonRadio = document.getElementById('format-json');
  const formatZipRadio = document.getElementById('format-zip');

  const formatLabels = {
    html: document.getElementById('format-html-label'),
    pdf: document.getElementById('format-pdf-label'),
    json: document.getElementById('format-json-label'),
    zip: document.getElementById('format-zip-label')
  };

  // Options
  const autoScrollToggle = document.getElementById('auto-scroll-toggle');
  const downloadImagesToggle = document.getElementById('download-images-toggle');

  // Progress Card Elements
  const progressCard = document.getElementById('progress-card');
  const progressTargetText = document.getElementById('progress-target-text');
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
  const diagnoseBtn = document.getElementById('diagnose-btn');

  // Action Buttons
  const exportBtn = document.getElementById('export-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const resetBtn = document.getElementById('reset-btn');
  const btnSpinner = document.getElementById('btn-spinner');
  const btnIcon = document.getElementById('btn-icon');
  const btnText = document.getElementById('btn-text');

  let activeTab = null;
  let timerInterval = null;
  let startTime = null;
  let isExporting = false;
  let currentScope = 'single';
  let discoveredConversations = [];

  // Format Selection Update
  function updateFormatUI(format) {
    Object.keys(formatLabels).forEach(key => {
      if (formatLabels[key]) {
        formatLabels[key].classList.toggle('active', key === format);
      }
    });

    const formatLabelsMap = {
      html: 'Save as HTML',
      pdf: 'Save as PDF',
      json: 'Save as JSON',
      zip: 'Save as ZIP'
    };
    btnText.textContent = formatLabelsMap[format] || 'Start Export';
  }

  [formatHtmlRadio, formatPdfRadio, formatJsonRadio, formatZipRadio].forEach(radio => {
    if (radio) {
      radio.addEventListener('change', () => {
        if (radio.checked) updateFormatUI(radio.value);
      });
    }
  });

  function getSelectedFormat() {
    if (formatPdfRadio?.checked) return 'pdf';
    if (formatJsonRadio?.checked) return 'json';
    if (formatZipRadio?.checked) return 'zip';
    return 'html';
  }

  // Scope Tabs
  tabScopeSingle?.addEventListener('click', () => {
    currentScope = 'single';
    tabScopeSingle.classList.add('active');
    tabScopeBatch?.classList.remove('active');
    singleChatView?.classList.remove('hidden');
    batchChatView?.classList.add('hidden');
  });

  tabScopeBatch?.addEventListener('click', () => {
    currentScope = 'batch';
    tabScopeBatch.classList.add('active');
    tabScopeSingle?.classList.remove('active');
    singleChatView?.classList.add('hidden');
    batchChatView?.classList.remove('hidden');
    if (discoveredConversations.length === 0) {
      loadBatchConversations();
    }
  });

  // Open Chat Button
  openChatBtn?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://chat.google.com' });
  });

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

    // Scan Live Info
    scanConversationInfo();
  } catch (err) {
    console.error('Initialization error:', err);
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

      conversationNameEl.textContent = response.name || response.title || 'Google Chat Space';
      conversationTypeBadge.textContent = response.type || 'Space';
      exportStatusBadge.textContent = 'Ready to export';

      if (metricDiscoveredMessages) metricDiscoveredMessages.textContent = response.totalMessages || response.visibleCount || 0;
      if (metricDiscoveredThreads) metricDiscoveredThreads.textContent = response.totalThreads || 0;
      if (metricDiscoveredReplies) metricDiscoveredReplies.textContent = response.totalReplies || 0;
      if (metricDiscoveredAttachments) metricDiscoveredAttachments.textContent = response.totalAttachments || 0;
    });
  }

  // Batch Conversation Discovery
  function loadBatchConversations() {
    if (!activeTab?.id) return;
    refreshConvosBtn.textContent = '⏳ Scanning...';

    chrome.tabs.sendMessage(activeTab.id, { action: 'DISCOVER_CONVERSATIONS' }, (response) => {
      refreshConvosBtn.textContent = '🔄 Scan';
      if (response && response.conversations) {
        discoveredConversations = response.conversations;
        renderBatchList(discoveredConversations);
      }
    });
  }

  refreshConvosBtn?.addEventListener('click', loadBatchConversations);

  function renderBatchList(items) {
    if (!conversationListEl) return;
    conversationListEl.innerHTML = '';

    if (items.length === 0) {
      conversationListEl.innerHTML = '<div class="empty-list-placeholder">No conversations found in sidebar.</div>';
      return;
    }

    items.forEach((c, idx) => {
      const itemEl = document.createElement('label');
      itemEl.className = 'conversation-item';
      itemEl.innerHTML = `
        <input type="checkbox" class="convo-checkbox" data-index="${idx}" ${idx < 5 ? 'checked' : ''} />
        <span class="convo-badge ${c.type === 'SPACE' ? 'badge-space' : 'badge-dm'}">${c.type === 'SPACE' ? 'Space' : 'DM'}</span>
        <span class="convo-title" title="${c.name}">${c.name}</span>
      `;
      conversationListEl.appendChild(itemEl);
    });

    updateBatchCount();
  }

  function updateBatchCount() {
    const checked = conversationListEl?.querySelectorAll('.convo-checkbox:checked').length || 0;
    const total = discoveredConversations.length;
    if (batchSelectionCountEl) {
      batchSelectionCountEl.textContent = `${checked} of ${total} selected`;
    }
  }

  conversationListEl?.addEventListener('change', updateBatchCount);

  selectAllBtn?.addEventListener('click', () => {
    conversationListEl?.querySelectorAll('.convo-checkbox').forEach(cb => cb.checked = true);
    updateBatchCount();
  });

  deselectAllBtn?.addEventListener('click', () => {
    conversationListEl?.querySelectorAll('.convo-checkbox').forEach(cb => cb.checked = false);
    updateBatchCount();
  });

  // Start Export Handler
  exportBtn?.addEventListener('click', async () => {
    if (isExporting) return;
    isExporting = true;

    const format = getSelectedFormat();
    const retrieveHistory = autoScrollToggle?.checked ?? true;
    const downloadMedia = downloadImagesToggle?.checked ?? true;

    // UI Updates
    exportBtn.classList.add('hidden');
    cancelBtn.classList.remove('hidden');
    resetBtn.classList.add('hidden');
    progressCard.classList.remove('hidden');
    successCard.classList.add('hidden');
    errorCard.classList.add('hidden');

    progressPhaseText.textContent = 'Scanning conversation...';
    exportStatusBadge.textContent = 'Scanning conversation';
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

    const exportOptions = {
      format,
      retrieveHistory,
      downloadMedia,
      scope: currentScope,
      selectedConversations: currentScope === 'batch'
        ? Array.from(conversationListEl.querySelectorAll('.convo-checkbox:checked')).map(cb => discoveredConversations[parseInt(cb.dataset.index, 10)])
        : null
    };

    chrome.tabs.sendMessage(activeTab.id, { action: 'START_EXPORT', options: exportOptions }, (response) => {
      clearInterval(timerInterval);
      isExporting = false;

      exportBtn.classList.remove('hidden');
      cancelBtn.classList.add('hidden');
      resetBtn.classList.remove('hidden');

      if (chrome.runtime.lastError) {
        showError(chrome.runtime.lastError.message);
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

  // Progress Message Listener from Content Script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'EXPORT_PROGRESS') {
      const data = msg.data || {};
      if (data.phase) {
        progressPhaseText.textContent = data.phase;
        exportStatusBadge.textContent = data.phase;
      }
      if (data.detail && progressDetailText) progressDetailText.textContent = data.detail;
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
    successFilename.textContent = result.filename || 'Google_Chat_Export';

    if (successStatsBox) {
      successStatsBox.innerHTML = `
        <div style="display:flex; justify-content:space-around; padding:8px 0; font-size:12px;">
          <div><strong>${result.totalMessages || 0}</strong> Messages</div>
          <div><strong>${result.totalThreads || 0}</strong> Threads</div>
          <div><strong>${result.totalReplies || 0}</strong> Replies</div>
          <div><strong>${result.totalAttachments || 0}</strong> Attachments</div>
        </div>
      `;
    }
  }

  function showError(msg) {
    progressCard.classList.add('hidden');
    errorCard.classList.remove('hidden');
    errorMessage.textContent = msg;
  }

  diagnoseBtn?.addEventListener('click', () => {
    if (!activeTab?.id) return;
    chrome.tabs.sendMessage(activeTab.id, { action: 'DIAGNOSE' }, (res) => {
      console.log('[Google Chat Exporter Diagnostics]', res);
      alert('Diagnostic details printed to DevTools console.');
    });
  });
});
