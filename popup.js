/**
 * ChatVault - Popup Controller (Current Chat PDF Exporter)
 * Manages active conversation detection, PDF export trigger,
 * real-time 4-metric progress tracking, and export cancellation.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Navigation & Detection
  const wrongTabView = document.getElementById('wrong-tab-view');
  const mainContent = document.getElementById('main-content');
  const openChatBtn = document.getElementById('open-chat-btn');
  const speedBadge = document.getElementById('speed-badge');

  // Single Chat View Info
  const conversationNameEl = document.getElementById('conversation-name');
  const conversationMetaEl = document.getElementById('conversation-meta');

  // Options
  const autoScrollToggle = document.getElementById('auto-scroll-toggle');
  const downloadImagesToggle = document.getElementById('download-images-toggle');
  const scrollDesc = document.getElementById('scroll-desc');
  const imagesDesc = document.getElementById('images-desc');

  // Action Buttons
  const exportBtn = document.getElementById('export-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const resetBtn = document.getElementById('reset-btn');
  const btnSpinner = document.getElementById('btn-spinner');
  const btnIcon = document.getElementById('btn-icon');
  const btnText = document.getElementById('btn-text');

  // Progress Card Elements
  const progressCard = document.getElementById('progress-card');
  const progressTargetText = document.getElementById('progress-target-text');
  const progressPhaseText = document.getElementById('progress-phase-text');
  const progressPercentText = document.getElementById('progress-percent-text');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressDetailText = document.getElementById('progress-detail-text');
  const metricDiscovered = document.getElementById('metric-discovered');
  const metricProcessed = document.getElementById('metric-processed');
  const metricSkipped = document.getElementById('metric-skipped');
  const metricFailed = document.getElementById('metric-failed');
  const metricTime = document.getElementById('metric-time');

  const diagnoseBtn = document.getElementById('diagnose-btn');

  // Result & Error Cards
  const successCard = document.getElementById('success-card');
  const successHeadline = document.getElementById('success-headline');
  const successFilename = document.getElementById('success-filename');
  const successStatsBox = document.getElementById('success-stats-box');
  const successBundlePills = document.getElementById('success-bundle-pills');
  const errorCard = document.getElementById('error-card');
  const errorMessage = document.getElementById('error-message');

  let activeTab = null;
  let timerInterval = null;
  let startTime = null;
  let isExporting = false;

  // Load preferences
  try {
    autoScrollToggle.checked = localStorage.getItem('chatvault_autoscroll') === 'true';
    const savedImages = localStorage.getItem('chatvault_images');
    downloadImagesToggle.checked = savedImages === null ? true : savedImages === 'true';
  } catch (e) {}

  function updateUiLabels() {
    if (speedBadge) speedBadge.textContent = '📑 PDF Export';
    if (imagesDesc) {
      imagesDesc.textContent = 'Embeds images scaled cleanly within PDF page boundaries.';
    }

    if (autoScrollToggle.checked) {
      scrollDesc.textContent = 'Sweeps top-to-bottom to render all messages & media.';
    } else {
      scrollDesc.textContent = 'Off = Fast export of loaded chat. On = Loads older history.';
    }

    if (!isExporting) {
      btnText.textContent = '⚡ Export Chat as PDF';
      exportBtn.disabled = false;
    }
  }

  autoScrollToggle.addEventListener('change', () => {
    localStorage.setItem('chatvault_autoscroll', autoScrollToggle.checked);
    updateUiLabels();
  });

  downloadImagesToggle.addEventListener('change', () => {
    localStorage.setItem('chatvault_images', downloadImagesToggle.checked);
  });

  openChatBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://chat.google.com' });
  });

  resetBtn.addEventListener('click', () => {
    resetUiToReady();
    checkChatInfo();
  });

  // Diagnose button — runs structural DOM inspection in the active tab
  if (diagnoseBtn) {
    diagnoseBtn.addEventListener('click', async () => {
      if (!activeTab) return;
      try {
        diagnoseBtn.disabled = true;
        diagnoseBtn.textContent = '🔍 Diagnosing…';
        await ensureContentScriptInjected(activeTab.id);
        const info = await sendMessageToTab(activeTab.id, { action: 'DIAGNOSE' });
        console.log('[ChatVault Diagnostics]', JSON.stringify(info, null, 2));
        errorMessage.textContent = `Diagnostics logged to DevTools console. feedFound=${info.feedFound}, rows=${info.messageRowCount}. Open DevTools → Console to view full report.`;
      } catch (e) {
        console.error('[ChatVault Diagnose error]', e);
        errorMessage.textContent = 'Diagnostics failed: ' + (e.message || e);
      } finally {
        diagnoseBtn.disabled = false;
        diagnoseBtn.textContent = '🔍 Run Diagnostics';
      }
    });
  }

  cancelBtn.addEventListener('click', async () => {
    if (!isExporting || !activeTab) return;
    try {
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Stopping...';
      await sendMessageToTab(activeTab.id, { action: 'CANCEL_EXPORT' });
    } catch (e) {
      console.warn('Cancel signal failed:', e);
    }
  });

  // Verify Active Tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab;

    if (!tab || !tab.url || !isGoogleChatUrl(tab.url)) {
      showWrongTabUi();
      return;
    }

    showChatDetectedUi();
    await ensureContentScriptInjected(tab.id);
    await checkChatInfo();
    updateUiLabels();
  } catch (err) {
    console.error('Init error:', err);
    showError('Unable to inspect active tab: ' + (err.message || 'Unknown error'));
  }

  function isGoogleChatUrl(url) {
    if (!url) return false;
    return (
      url.startsWith('https://chat.google.com') ||
      url.startsWith('https://mail.google.com')
    );
  }

  function showWrongTabUi() {
    wrongTabView.classList.remove('hidden');
    mainContent.classList.add('hidden');
  }

  function showChatDetectedUi() {
    wrongTabView.classList.add('hidden');
    mainContent.classList.remove('hidden');
  }

  async function ensureContentScriptInjected(tabId) {
    try {
      const res = await sendMessageToTab(tabId, { action: 'PING' });
      if (res && res.status === 'PONG') return;
    } catch (e) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['jspdf.umd.min.js', 'content.js']
        });
      } catch (injectErr) {
        console.error('Script injection failed:', injectErr);
        throw new Error('Failed to load exporter into Google Chat. Please refresh the page.');
      }
    }
  }

  async function checkChatInfo() {
    if (!activeTab) return;
    try {
      const info = await sendMessageToTab(activeTab.id, { action: 'GET_CHAT_INFO' });
      if (info && info.title) {
        conversationNameEl.textContent = info.title;
        conversationMetaEl.textContent = `${info.visibleCount || 0} messages loaded in view`;
      } else {
        conversationNameEl.textContent = 'Active Chat Room';
        conversationMetaEl.textContent = 'Ready to export';
      }
    } catch (err) {
      conversationNameEl.textContent = 'Google Chat Window';
      conversationMetaEl.textContent = 'Ready to scan active conversation';
    }
  }

  /**
   * Main Export Trigger (PDF Only, Current Chat Only)
   */
  exportBtn.addEventListener('click', async () => {
    if (isExporting || !activeTab) return;

    try {
      errorCard.classList.add('hidden');
      successCard.classList.add('hidden');
      resetBtn.classList.add('hidden');

      isExporting = true;
      exportBtn.disabled = true;
      exportBtn.classList.add('hidden');
      cancelBtn.classList.remove('hidden');
      cancelBtn.disabled = false;
      cancelBtn.textContent = '🛑 Cancel Export';

      progressCard.classList.remove('hidden');
      progressTargetText.textContent = `Exporting: ${conversationNameEl.textContent || 'Current Chat'}`;

      updateProgress({
        phase: 'PREPARING',
        message: 'Initializing ChatVault PDF engine...',
        percent: 5,
        detail: 'Connecting to DOM...',
        discovered: 0,
        processed: 0,
        skipped: 0,
        failed: 0
      });

      startTimer();
      await ensureContentScriptInjected(activeTab.id);

      const response = await sendMessageToTab(activeTab.id, {
        action: 'START_EXPORT',
        options: {
          scope: 'single',
          format: 'pdf',
          batchIds: [],
          autoScroll: autoScrollToggle.checked,
          downloadImages: downloadImagesToggle.checked,
          maxScrollAttempts: 25
        }
      });

      if (response && response.error) {
        throw new Error(response.error);
      }
    } catch (err) {
      console.error('Export failed to start:', err);
      showError(err.message || 'Failed to trigger export. Try refreshing Google Chat.');
      resetExportButton();
      stopTimer();
    }
  });

  // Listen for real-time progress & completion
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.tab && activeTab && sender.tab.id !== activeTab.id) return;

    if (message.type === 'STATUS_UPDATE') {
      updateProgress(message.data);
    } else if (message.type === 'EXPORT_COMPLETE') {
      handleExportComplete(message.data);
    } else if (message.type === 'EXPORT_ERROR') {
      showError(message.data?.error || 'An error occurred during extraction.');
      resetExportButton();
      stopTimer();
    } else if (message.type === 'EXPORT_CANCELLED') {
      handleExportCancelled(message.data);
    }
  });

  function updateProgress(data) {
    if (!data) return;

    if (data.target) progressTargetText.textContent = data.target;
    if (data.message) progressPhaseText.textContent = data.message;
    if (typeof data.percent === 'number') {
      const pct = Math.min(100, Math.max(0, Math.round(data.percent)));
      progressPercentText.textContent = `${pct}%`;
      progressBarFill.style.width = `${pct}%`;
    }
    if (data.detail) progressDetailText.textContent = data.detail;

    if (typeof data.discovered === 'number') metricDiscovered.textContent = data.discovered;
    if (typeof data.processed === 'number') metricProcessed.textContent = data.processed;
    if (typeof data.skipped === 'number') metricSkipped.textContent = data.skipped;
    if (typeof data.failed === 'number') metricFailed.textContent = data.failed;
  }

  function handleExportComplete(data) {
    stopTimer();
    isExporting = false;

    progressCard.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    successCard.classList.remove('hidden');
    resetBtn.classList.remove('hidden');

    const isPartial = (data.failedCount > 0 || data.skippedCount > 0);
    successHeadline.textContent = isPartial ? 'Export Finished (With Notices)' : 'Export Complete!';
    successFilename.textContent = data.filename || 'ChatVault_Export.pdf';

    successStatsBox.innerHTML = `
      <div><strong>Conversation Exported:</strong> 1</div>
      <div><strong>Messages Processed:</strong> ${data.processedCount || data.messageCount || 0}</div>
      <div><strong>Attachments Included:</strong> ${data.imageCount || 0}</div>
      ${data.skippedCount ? `<div class="text-amber"><strong>Items Skipped:</strong> ${data.skippedCount}</div>` : ''}
      ${data.failedCount ? `<div class="text-red"><strong>Failures:</strong> ${data.failedCount}</div>` : ''}
    `;

    successBundlePills.innerHTML = '<span class="bundle-pill">PDF Document</span><span class="bundle-pill">Print-Ready</span>';

    resetExportButton();
  }

  function handleExportCancelled(data) {
    stopTimer();
    isExporting = false;
    progressCard.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    showError(data?.message || 'Export was safely cancelled by user.');
    resetExportButton();
  }

  function showError(msg) {
    errorCard.classList.remove('hidden');
    errorMessage.textContent = msg;
    progressCard.classList.add('hidden');
    cancelBtn.classList.add('hidden');
  }

  function resetExportButton() {
    isExporting = false;
    exportBtn.disabled = false;
    exportBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
    btnSpinner.classList.add('hidden');
    btnIcon.classList.remove('hidden');
    updateUiLabels();
  }

  function resetUiToReady() {
    isExporting = false;
    resetExportButton();
    progressCard.classList.add('hidden');
    successCard.classList.add('hidden');
    errorCard.classList.add('hidden');
    resetBtn.classList.add('hidden');

    metricDiscovered.textContent = '0';
    metricProcessed.textContent = '0';
    metricSkipped.textContent = '0';
    metricFailed.textContent = '0';
    metricTime.textContent = '00:00';
    progressBarFill.style.width = '0%';
    progressPercentText.textContent = '0%';
    stopTimer();
    updateUiLabels();
  }

  function startTimer() {
    startTime = Date.now();
    metricTime.textContent = '00:00';
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
      const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const s = String(elapsedSec % 60).padStart(2, '0');
      metricTime.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  function sendMessageToTab(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }
});
