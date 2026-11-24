/**
 * @file zipExporter.js
 * @module ZipExporter
 * @description Bundles HTML, JSON, PDF, and media attachments into a structured ZIP archive
 * using the bundled JSZip library.
 */

'use strict';

import { HtmlExporter } from './htmlExporter.js';
import { JsonExporter } from './jsonExporter.js';
import { PdfExporter } from './pdfExporter.js';

export class ZipExporter {
  /**
   * Bundles conversation exports into a ZIP archive Blob.
   *
   * @param {Object} conversation - Normalized conversation
   * @param {Object} [metadata]    - Export metadata
   * @param {Object} [options]     - Export options (includeHtml, includeJson, includePdf, attachmentsMap)
   * @returns {Promise<Blob>} ZIP archive Blob
   */
  static async export(conversation, metadata = {}, options = {}) {
    const JSZipLib = (typeof window !== 'undefined' && window.JSZip) ||
                     (typeof globalThis !== 'undefined' && globalThis.JSZip) ||
                     null;

    if (!JSZipLib) {
      throw new Error('JSZip library is not available in the current execution context.');
    }

    const zip = new JSZipLib();
    const convoName = (metadata.name || conversation.name || 'google_chat').replace(/[^a-zA-Z0-9_-]/g, '_');

    // 1. Standalone HTML
    if (options.includeHtml !== false) {
      const htmlContent = HtmlExporter.export(conversation, metadata);
      zip.file(`${convoName}.html`, htmlContent);
    }

    // 2. Structured JSON
    if (options.includeJson !== false) {
      const jsonContent = JsonExporter.export(conversation, metadata, true);
      zip.file(`${convoName}.json`, jsonContent);
    }

    // 3. PDF
    if (options.includePdf !== false) {
      try {
        const pdfBlob = await PdfExporter.export(conversation, metadata);
        if (pdfBlob && pdfBlob instanceof Blob) {
          zip.file(`${convoName}.pdf`, pdfBlob);
        }
      } catch (err) {
        console.warn('[ZipExporter] PDF generation skipped in zip:', err);
      }
    }

    // 4. Attachments Folder
    const attachmentsMap = options.attachmentsMap || {};
    const attFolder = zip.folder('attachments');
    for (const [filename, fileData] of Object.entries(attachmentsMap)) {
      if (fileData) {
        attFolder.file(filename, fileData);
      }
    }

    // 5. Generate ZIP
    return await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
  }
}
