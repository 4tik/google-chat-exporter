/**
 * @file background.js
 * @description Service worker for Manifest V3 Google Chat Exporter extension.
 * Coordinates background downloads, badge updates, and cross-tab communication.
 */

'use strict';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Google Chat Exporter] Background service worker initialized.');
});

// Message listener for background tasks
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SET_BADGE') {
    const text = request.text || '';
    const color = request.color || '#00897B';
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'DOWNLOAD_BLOB') {
    // Used when content script delegates file saving
    try {
      chrome.downloads.download({
        url: request.url,
        filename: request.filename || 'google_chat_export.html',
        saveAs: Boolean(request.saveAs)
      }, (downloadId) => {
        sendResponse({ success: Boolean(downloadId), downloadId });
      });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }
});
