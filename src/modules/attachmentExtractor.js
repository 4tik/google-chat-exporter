/**
 * @file attachmentExtractor.js
 * @module AttachmentExtractor
 * @description Extracts attachment metadata and blobs from Google Chat message
 *   DOM elements inside a Chrome Extension content-script context. Handles
 *   images, PDFs, Office documents, Google Drive files, and plain hyperlinks.
 *
 * Usage:
 *   const extractor = new AttachmentExtractor({ debug: false });
 *   const attachments = extractor.extractFromElement(msgElement);
 *   await extractor.downloadAttachment(attachments[0]);
 *   extractor.destroy();
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Enumeration of supported attachment types. */
export const AttachmentType = Object.freeze({
  IMAGE:      'IMAGE',
  PDF:        'PDF',
  WORD:       'WORD',
  EXCEL:      'EXCEL',
  DRIVE_FILE: 'DRIVE_FILE',
  LINK:       'LINK',
  UNKNOWN:    'UNKNOWN',
});

/**
 * File-extension → AttachmentType map.
 * Checked against the lowercase filename extension.
 */
const EXT_TYPE_MAP = Object.freeze({
  // Images
  jpg:  AttachmentType.IMAGE,
  jpeg: AttachmentType.IMAGE,
  png:  AttachmentType.IMAGE,
  gif:  AttachmentType.IMAGE,
  webp: AttachmentType.IMAGE,
  svg:  AttachmentType.IMAGE,
  bmp:  AttachmentType.IMAGE,
  tiff: AttachmentType.IMAGE,
  tif:  AttachmentType.IMAGE,
  heic: AttachmentType.IMAGE,
  avif: AttachmentType.IMAGE,

  // PDF
  pdf:  AttachmentType.PDF,

  // Word
  doc:  AttachmentType.WORD,
  docx: AttachmentType.WORD,
  odt:  AttachmentType.WORD,
  rtf:  AttachmentType.WORD,

  // Excel
  xls:  AttachmentType.EXCEL,
  xlsx: AttachmentType.EXCEL,
  csv:  AttachmentType.EXCEL,
  ods:  AttachmentType.EXCEL,
});

/**
 * MIME-type prefix / full value → AttachmentType.
 * Keys are tested with String.prototype.startsWith for prefixes or
 * strict equality for full values.
 */
const MIME_TYPE_MAP = Object.freeze([
  ['image/',                              AttachmentType.IMAGE],
  ['application/pdf',                     AttachmentType.PDF],
  ['application/msword',                  AttachmentType.WORD],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml', AttachmentType.WORD],
  ['application/vnd.oasis.opendocument.text', AttachmentType.WORD],
  ['application/vnd.ms-excel',            AttachmentType.EXCEL],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml',    AttachmentType.EXCEL],
  ['application/vnd.oasis.opendocument.spreadsheet', AttachmentType.EXCEL],
  ['text/csv',                            AttachmentType.EXCEL],
]);

// ---------------------------------------------------------------------------
// Selector helpers – maintained in one place so they're easy to update if
// Google Chat's DOM structure changes.
// ---------------------------------------------------------------------------

/**
 * CSS selectors that identify UI chrome images that should be SKIPPED:
 * user avatars, reaction icons, emoji sprites, toolbar icons, etc.
 */
const AVATAR_SELECTORS = [
  'img[data-hovercard-id]',         // user avatar with hovercard
  'img[aria-hidden="true"]',        // decorative / icon
  '.avatar img',
  '[data-member-id] img',           // member chip avatar
  'goog-inline-block img',          // legacy Google inline-block icons
  '.emoji img',
  '.reaction img',
  'img.emoji',
  'img[src*="emoji"]',
  'img[src*="/icon"]',
  'img[src*="avatar"]',
  'img[src*="profile_photo"]',
  'img[src*="s24"]',                // common tiny-size suffix for icons
  'img[src*="s32"]',
  'img[src*="s48"]',
  'img[src*="=s24"]',
  'img[src*="=s32"]',
  'img[src*="=s48"]',
];

/**
 * CSS selectors for file attachment chips / cards rendered by Google Chat.
 * These are the preview cards shown for Drive files, PDFs, Office docs, etc.
 */
const FILE_CHIP_SELECTORS = [
  // Drive / attachment chip containers
  '[data-attachmentid]',
  '[data-drive-item-id]',
  'c-wiz[data-node-index] a[href*="drive.google.com"]',
  'a[href*="docs.google.com"]',
  'a[href*="sheets.google.com"]',
  'a[href*="slides.google.com"]',
  // Generic file chips used in newer Chat UI
  '.VfPpkd-dgl2Hf-ppHlrf-sM5MNb',  // Material chip container (may change)
  '[jsname="N9Xkfe"]',              // attachment card jsname
  '[data-attachment-type]',
  '.attachment-card',
  '.file-chip',
  // Thumbnail + filename wrappers
  'div[role="link"][aria-label]',   // accessibility-labelled file rows
];

/**
 * Selectors for the filename text node inside a file chip.
 */
const FILENAME_SELECTORS = [
  '[data-filename]',
  '[aria-label]',
  '.file-name',
  '.attachment-name',
  'span[jsname]',
  'div[jsname]',
];

/**
 * URL patterns that indicate a Google Drive hosted resource.
 */
const DRIVE_URL_PATTERNS = [
  /drive\.google\.com\/file\/d\/([^/?#]+)/,
  /drive\.google\.com\/open\?id=([^&]+)/,
  /docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/d\/([^/?#]+)/,
  /drive\.google\.com\/uc\?.*[?&]id=([^&]+)/,
  /googleusercontent\.com\/.*\/([A-Za-z0-9_-]{20,})/,
];

/**
 * URL patterns considered UI/infrastructure (skip as "real" links).
 */
const SKIP_LINK_PATTERNS = [
  /^https?:\/\/accounts\.google\.com/,
  /^https?:\/\/support\.google\.com/,
  /^javascript:/i,
  /^mailto:/i,
  /^#/,
  /chat\.google\.com\/u\/\d+\/r\/(dm|room|space)\/[^/]+$/,  // internal nav links
];

/**
 * Minimum dimension (px) for an image to be considered a "real" attachment
 * rather than an inline icon. Applied when naturalWidth/naturalHeight are 0
 * we fall back to the rendered width/height from the DOM.
 */
const MIN_IMAGE_DIMENSION_PX = 60;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Returns a pseudo-random id string prefixed with `att_`.
 * @returns {string}
 */
function generateId() {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Extracts the file extension (lowercase, no dot) from a URL path or filename.
 * Returns an empty string when no extension is found.
 * @param {string} name - Filename or URL string.
 * @returns {string}
 */
function getExtension(name) {
  if (!name) return '';
  // Strip query string / fragment before extracting extension
  const clean = name.split('?')[0].split('#')[0];
  const dot = clean.lastIndexOf('.');
  if (dot === -1 || dot === clean.length - 1) return '';
  return clean.slice(dot + 1).toLowerCase();
}

/**
 * Derives the best AttachmentType from a filename and/or MIME type string.
 * @param {string} [filename='']
 * @param {string} [mimeType='']
 * @returns {string} An AttachmentType constant.
 */
function inferType(filename = '', mimeType = '') {
  // Try MIME first (most authoritative)
  if (mimeType) {
    for (const [prefix, type] of MIME_TYPE_MAP) {
      if (mimeType.startsWith(prefix)) return type;
    }
  }

  // Fall back to file extension
  const ext = getExtension(filename) || getExtension(mimeType);
  if (ext && EXT_TYPE_MAP[ext]) return EXT_TYPE_MAP[ext];

  return AttachmentType.UNKNOWN;
}

/**
 * Extracts a Google Drive file ID from a URL.
 * @param {string} url
 * @returns {string|null}
 */
function extractDriveFileId(url) {
  if (!url) return null;
  for (const pattern of DRIVE_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

/**
 * Returns the best resolved URL from an <img> element, checking `src`,
 * `data-src` (lazy-load), and the first `srcset` entry.
 * @param {HTMLImageElement} imgEl
 * @returns {string|null}
 */
function resolveBestImageSrc(imgEl) {
  // Prefer the loaded src if already resolved
  if (imgEl.src && !imgEl.src.startsWith('data:') && imgEl.complete) {
    return imgEl.src;
  }

  // Lazy-load attribute (Intersection Observer pattern)
  const dataSrc = imgEl.getAttribute('data-src')
    || imgEl.getAttribute('data-lazy-src')
    || imgEl.getAttribute('data-original');
  if (dataSrc) return dataSrc;

  // srcset – pick highest-resolution (last) or first descriptor
  const srcset = imgEl.getAttribute('srcset');
  if (srcset) {
    const entries = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
    if (entries.length > 0) return entries[entries.length - 1]; // last = highest resolution
  }

  // Fall back to raw src
  return imgEl.src || null;
}

/**
 * Checks whether a URL appears to be accessible (i.e. not a known expired
 * or placeholder URL). Note: this is a heuristic; actual network reachability
 * is only known after a fetch attempt.
 * @param {string} url
 * @returns {{ isAccessible: boolean, isExpired: boolean }}
 */
function assessAccessibility(url) {
  if (!url || url === 'about:blank' || url.startsWith('data:')) {
    return { isAccessible: false, isExpired: false };
  }

  // Google's expired/placeholder image pattern
  const expiredPatterns = [
    /googleusercontent\.com\/.*\/[A-Za-z0-9_-]+=e\d+/,  // =e<timestamp> expiry
    /\/expired\//i,
    /placeholder/i,
  ];
  const isExpired = expiredPatterns.some(p => p.test(url));

  return { isAccessible: !isExpired, isExpired };
}

/**
 * Attempts to parse a human-readable file size string (e.g. "2.3 MB") and
 * return it normalised. Returns the raw string unchanged if unparseable.
 * @param {string} raw
 * @returns {string}
 */
function normalizeSize(raw) {
  if (!raw) return '';
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Returns `true` if the given element (or any of its ancestors up to `root`)
 * matches one of the avatar/icon selectors – meaning the image is UI chrome.
 * @param {Element} el
 * @param {Element} root
 * @returns {boolean}
 */
function isAvatarOrIcon(el, root) {
  for (const selector of AVATAR_SELECTORS) {
    try {
      if (el.matches(selector)) return true;
      // Walk up to root checking parents
      let parent = el.parentElement;
      while (parent && parent !== root) {
        if (parent.matches(selector)) return true;
        parent = parent.parentElement;
      }
    } catch (_) {
      // Invalid selector for this browser – skip
    }
  }
  return false;
}

/**
 * Returns `true` if the image is too small to be a "real" content image.
 * @param {HTMLImageElement} imgEl
 * @returns {boolean}
 */
function isTooSmall(imgEl) {
  const w = imgEl.naturalWidth  || imgEl.width  || parseInt(imgEl.getAttribute('width')  || '0', 10);
  const h = imgEl.naturalHeight || imgEl.height || parseInt(imgEl.getAttribute('height') || '0', 10);

  // If we genuinely have no size info, we give the image the benefit of the doubt
  if (w === 0 && h === 0) return false;

  return w < MIN_IMAGE_DIMENSION_PX && h < MIN_IMAGE_DIMENSION_PX;
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * Extracts attachment metadata from Google Chat message DOM elements.
 *
 * @example
 * const extractor = new AttachmentExtractor({ debug: true });
 * const attachments = extractor.extractFromElement(document.querySelector('.message'));
 * console.log(attachments);
 * extractor.destroy();
 */
export class AttachmentExtractor {
  /**
   * @param {object}  [options={}]
   * @param {boolean} [options.debug=false]      Log debug info to console.
   * @param {number}  [options.fetchTimeout=10000] ms before fetch is aborted.
   */
  constructor(options = {}) {
    this._debug        = Boolean(options.debug);
    this._fetchTimeout = options.fetchTimeout ?? 10_000;

    /** @type {Map<string, string>} blobUrl → objectURL for cleanup */
    this._blobUrls = new Map();

    /** AbortController instances keyed by attachment id */
    this._fetchControllers = new Map();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Top-level extraction entry point. Runs all sub-extractors and deduplicates
   * the results by URL before returning.
   *
   * @param {Element} element - A message container DOM element.
   * @returns {AttachmentDescriptor[]} Ordered array of unique attachments.
   */
  extractFromElement(element) {
    if (!(element instanceof Element)) {
      this._log('warn', 'extractFromElement: argument is not a DOM Element', element);
      return [];
    }

    const images = this.extractImages(element);
    const files  = this.extractFiles(element);
    const links  = this.extractLinks(element);

    // Merge, then deduplicate by canonical URL (images > files > links precedence)
    const all    = [...images, ...files, ...links];
    const seen   = new Set();
    const unique = [];

    for (const att of all) {
      const key = att.url || att.id;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(att);
      }
    }

    this._log('info', `extractFromElement: found ${unique.length} attachment(s)`, unique);
    return unique;
  }

  /**
   * Finds all `<img>` elements inside `element` that represent real message
   * content (not avatars, icons, or decorative images).
   *
   * @param {Element} element
   * @returns {AttachmentDescriptor[]}
   */
  extractImages(element) {
    if (!(element instanceof Element)) return [];

    const results   = [];
    const imgEls    = Array.from(element.querySelectorAll('img'));

    for (const img of imgEls) {
      try {
        // Skip UI chrome
        if (isAvatarOrIcon(img, element)) {
          this._log('debug', 'Skipping avatar/icon img', img.src);
          continue;
        }

        // Skip images that are clearly too small
        if (isTooSmall(img)) {
          this._log('debug', 'Skipping too-small img', img.src);
          continue;
        }

        const url = resolveBestImageSrc(img);
        if (!url) continue;

        // Skip data URIs (inline tiny icons)
        if (url.startsWith('data:')) continue;

        const { isAccessible, isExpired } = assessAccessibility(url);

        /** @type {AttachmentDescriptor} */
        const attachment = {
          id:         generateId(),
          type:       AttachmentType.IMAGE,
          filename:   this._filenameFromUrl(url) || img.getAttribute('alt') || '',
          url,
          previewUrl: url,  // For images, the URL itself is the preview
          size:       '',
          mimeType:   this._mimeFromUrl(url),
          isAccessible,
          isExpired,
          driveFileId: extractDriveFileId(url),
        };

        // Refine type if the image is actually a Drive file thumbnail
        if (attachment.driveFileId) {
          attachment.type = AttachmentType.DRIVE_FILE;
        }

        results.push(attachment);
      } catch (err) {
        this._log('error', 'extractImages: error processing img element', err);
      }
    }

    return results;
  }

  /**
   * Finds file attachment chips/cards inside `element` and extracts their
   * metadata. Handles Drive files, PDFs, Office documents, and generic files.
   *
   * @param {Element} element
   * @returns {AttachmentDescriptor[]}
   */
  extractFiles(element) {
    if (!(element instanceof Element)) return [];

    const results = [];
    const seen    = new Set(); // Track anchor hrefs to avoid double-counting

    for (const selector of FILE_CHIP_SELECTORS) {
      let chips;
      try {
        chips = Array.from(element.querySelectorAll(selector));
      } catch (_) {
        continue; // Invalid selector in this browser
      }

      for (const chip of chips) {
        try {
          // Resolve the primary URL for this chip
          const url = this._resolveChipUrl(chip);
          if (!url || seen.has(url)) continue;
          seen.add(url);

          const filename    = this._resolveChipFilename(chip, url);
          const mimeType    = this._resolveChipMime(chip, filename);
          const driveFileId = extractDriveFileId(url);
          const type        = driveFileId
            ? AttachmentType.DRIVE_FILE
            : inferType(filename, mimeType);

          const previewUrl  = this._resolveChipPreview(chip);
          const size        = this._resolveChipSize(chip);
          const { isAccessible, isExpired } = assessAccessibility(url);

          results.push({
            id: chip.getAttribute('data-attachmentid')
              || chip.getAttribute('data-drive-item-id')
              || generateId(),
            type,
            filename,
            url,
            previewUrl,
            size,
            mimeType,
            isAccessible,
            isExpired,
            driveFileId,
          });
        } catch (err) {
          this._log('error', 'extractFiles: error processing chip', err);
        }
      }
    }

    return results;
  }

  /**
   * Finds meaningful hyperlinks inside `element`, filtering out navigation
   * UI links, blank anchors, and anchors whose href would already be captured
   * by extractImages or extractFiles.
   *
   * @param {Element} element
   * @returns {AttachmentDescriptor[]}
   */
  extractLinks(element) {
    if (!(element instanceof Element)) return [];

    const results = [];
    const anchors = Array.from(element.querySelectorAll('a[href]'));

    for (const anchor of anchors) {
      try {
        const href = anchor.href || anchor.getAttribute('href') || '';
        if (!href) continue;

        // Skip UI / navigation links
        if (SKIP_LINK_PATTERNS.some(p => p.test(href))) continue;

        // Skip if it's a Drive/Docs link that extractFiles would catch
        if (extractDriveFileId(href)) {
          this._log('debug', 'extractLinks: skipping Drive link (handled by extractFiles)', href);
          continue;
        }

        const url      = href;
        const filename = anchor.textContent?.trim()
          || anchor.getAttribute('aria-label')
          || this._filenameFromUrl(url)
          || '';

        const mimeType = this._mimeFromUrl(url);
        const type     = inferType(url, mimeType);

        // If the linked resource is an image file, it may already appear in
        // extractImages; mark it IMAGE type regardless.
        const finalType = type !== AttachmentType.UNKNOWN
          ? type
          : AttachmentType.LINK;

        const { isAccessible, isExpired } = assessAccessibility(url);

        results.push({
          id:          generateId(),
          type:        finalType,
          filename,
          url,
          previewUrl:  null,
          size:        '',
          mimeType,
          isAccessible,
          isExpired,
          driveFileId: null,
        });
      } catch (err) {
        this._log('error', 'extractLinks: error processing anchor', err);
      }
    }

    return results;
  }

  /**
   * Attempts to fetch an attachment's resource and returns a temporary
   * blob URL that can be used as an `<a href>` or `<img src>`.
   *
   * - Only attempts the fetch when `attachment.isAccessible` is `true`.
   * - Respects the `fetchTimeout` option.
   * - Stores the created blob URL internally for cleanup via `destroy()`.
   *
   * @param {AttachmentDescriptor} attachment
   * @returns {Promise<string|null>} Blob URL on success, `null` otherwise.
   */
  async downloadAttachment(attachment) {
    if (!attachment || !attachment.url) {
      this._log('warn', 'downloadAttachment: no attachment or url provided');
      return null;
    }

    if (!attachment.isAccessible) {
      this._log('warn', `downloadAttachment: "${attachment.id}" is marked inaccessible – skipping fetch`);
      return null;
    }

    // Abort any in-flight fetch for this id
    this._abortFetch(attachment.id);

    const controller = new AbortController();
    this._fetchControllers.set(attachment.id, controller);

    const timeoutId = setTimeout(() => controller.abort(), this._fetchTimeout);

    try {
      this._log('info', `downloadAttachment: fetching "${attachment.url}"`);

      const response = await fetch(attachment.url, {
        signal:      controller.signal,
        credentials: 'include',  // Send cookies (required for Google auth)
        mode:        'cors',
      });

      if (!response.ok) {
        // Mark inaccessible in-place for caller's awareness
        attachment.isAccessible = false;
        if (response.status === 404 || response.status === 410) {
          attachment.isExpired = true;
        }
        this._log('warn', `downloadAttachment: HTTP ${response.status} for "${attachment.url}"`);
        return null;
      }

      const blob    = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      // Update mimeType from actual response if unknown
      if (!attachment.mimeType || attachment.mimeType === '') {
        attachment.mimeType = blob.type || '';
        // Refine type now that we have the real MIME
        if (attachment.type === AttachmentType.UNKNOWN) {
          attachment.type = inferType('', attachment.mimeType);
        }
      }

      // Track for cleanup
      this._blobUrls.set(attachment.id, blobUrl);

      this._log('info', `downloadAttachment: created blob URL for "${attachment.id}"`);
      return blobUrl;
    } catch (err) {
      if (err.name === 'AbortError') {
        this._log('warn', `downloadAttachment: fetch aborted for "${attachment.id}"`);
      } else {
        this._log('error', `downloadAttachment: fetch error for "${attachment.id}"`, err);
        attachment.isAccessible = false;
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
      this._fetchControllers.delete(attachment.id);
    }
  }

  /**
   * Revokes all object URLs created by this extractor and aborts any pending
   * fetch operations. Call this when the extractor is no longer needed to
   * avoid memory leaks.
   */
  destroy() {
    // Abort all in-flight fetches
    for (const controller of this._fetchControllers.values()) {
      try { controller.abort(); } catch (_) { /* ignore */ }
    }
    this._fetchControllers.clear();

    // Revoke blob URLs
    for (const blobUrl of this._blobUrls.values()) {
      try { URL.revokeObjectURL(blobUrl); } catch (_) { /* ignore */ }
    }
    this._blobUrls.clear();

    this._log('info', 'AttachmentExtractor destroyed');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolves the primary URL for a file chip element.
   * Checks data attributes first, then `href`, then nested anchors.
   * @param {Element} chip
   * @returns {string|null}
   */
  _resolveChipUrl(chip) {
    // Explicit data attributes
    const dataUrl = chip.getAttribute('data-url')
      || chip.getAttribute('data-src')
      || chip.getAttribute('data-href');
    if (dataUrl) return dataUrl;

    // The chip itself may be an anchor
    if (chip.tagName === 'A' && chip.href) return chip.href;

    // Nested anchor
    const nestedAnchor = chip.querySelector('a[href]');
    if (nestedAnchor?.href) return nestedAnchor.href;

    return null;
  }

  /**
   * Resolves a human-readable filename from a chip element.
   * @param {Element} chip
   * @param {string}  [fallbackUrl='']
   * @returns {string}
   */
  _resolveChipFilename(chip, fallbackUrl = '') {
    // data-filename attribute
    const dataFilename = chip.getAttribute('data-filename');
    if (dataFilename) return dataFilename;

    // aria-label on the chip itself (often contains "filename.ext")
    const ariaLabel = chip.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.includes('.')) return ariaLabel.trim();

    // Try known filename child selectors
    for (const sel of FILENAME_SELECTORS) {
      const el = chip.querySelector(sel);
      if (el) {
        const text = (el.getAttribute('data-filename')
          || el.getAttribute('aria-label')
          || el.textContent
          || '').trim();
        if (text && text.length > 0) return text;
      }
    }

    // Fall back to deriving from URL
    return this._filenameFromUrl(fallbackUrl);
  }

  /**
   * Resolves a MIME type from a chip element's data attributes.
   * @param {Element} chip
   * @param {string}  [filename='']
   * @returns {string}
   */
  _resolveChipMime(chip, filename = '') {
    return chip.getAttribute('data-mime-type')
      || chip.getAttribute('data-type')
      || this._mimeFromUrl(filename)
      || '';
  }

  /**
   * Resolves a thumbnail/preview URL from a chip element.
   * @param {Element} chip
   * @returns {string|null}
   */
  _resolveChipPreview(chip) {
    // data-thumbnail-url is set by some Chat UI versions
    const dataThumbnail = chip.getAttribute('data-thumbnail-url')
      || chip.getAttribute('data-preview-url');
    if (dataThumbnail) return dataThumbnail;

    // Nested image that isn't an avatar (might be the Drive thumbnail)
    const imgEl = chip.querySelector('img:not([aria-hidden="true"])');
    if (imgEl) {
      return resolveBestImageSrc(imgEl) || null;
    }

    return null;
  }

  /**
   * Resolves the human-readable file size string from a chip element.
   * @param {Element} chip
   * @returns {string}
   */
  _resolveChipSize(chip) {
    const dataSize = chip.getAttribute('data-size') || chip.getAttribute('data-file-size');
    if (dataSize) return normalizeSize(dataSize);

    // Look for a child element that looks like it contains a size string
    const sizeEl = chip.querySelector(
      '[data-size], [data-file-size], .file-size, .attachment-size'
    );
    if (sizeEl) {
      return normalizeSize(
        sizeEl.getAttribute('data-size') || sizeEl.textContent || ''
      );
    }

    // Try to find text that matches common size patterns in the chip's text
    const text = chip.textContent || '';
    const sizeMatch = text.match(/\b(\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB))\b/i);
    return sizeMatch ? normalizeSize(sizeMatch[1]) : '';
  }

  /**
   * Extracts a bare filename (with extension) from a URL.
   * @param {string} url
   * @returns {string}
   */
  _filenameFromUrl(url) {
    if (!url) return '';
    try {
      // Strip query/fragment and get the last path segment
      const path = new URL(url).pathname;
      const segment = path.split('/').filter(Boolean).pop() || '';
      // Decode percent-encoding
      return decodeURIComponent(segment);
    } catch (_) {
      // Not a valid absolute URL – try treating it as a path string
      const segment = url.split('?')[0].split('#')[0].split('/').pop() || '';
      return decodeURIComponent(segment);
    }
  }

  /**
   * Infers a MIME type string from a URL's file extension.
   * Returns an empty string when no match is found.
   * @param {string} url
   * @returns {string}
   */
  _mimeFromUrl(url) {
    const ext = getExtension(url);
    const mimeMap = {
      jpg:  'image/jpeg',
      jpeg: 'image/jpeg',
      png:  'image/png',
      gif:  'image/gif',
      webp: 'image/webp',
      svg:  'image/svg+xml',
      bmp:  'image/bmp',
      tiff: 'image/tiff',
      tif:  'image/tiff',
      heic: 'image/heic',
      avif: 'image/avif',
      pdf:  'application/pdf',
      doc:  'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      odt:  'application/vnd.oasis.opendocument.text',
      rtf:  'application/rtf',
      xls:  'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv:  'text/csv',
      ods:  'application/vnd.oasis.opendocument.spreadsheet',
    };
    return mimeMap[ext] || '';
  }

  /**
   * Aborts any in-flight fetch for the given attachment id.
   * @param {string} id
   */
  _abortFetch(id) {
    const existing = this._fetchControllers.get(id);
    if (existing) {
      try { existing.abort(); } catch (_) { /* ignore */ }
      this._fetchControllers.delete(id);
    }
  }

  /**
   * Internal logging helper. No-ops when `debug` is false.
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param  {...*} args
   */
  _log(level, ...args) {
    if (!this._debug && (level === 'debug' || level === 'info')) return;
    const prefix = '[AttachmentExtractor]';
    switch (level) {
      case 'debug': console.debug(prefix, ...args); break;
      case 'info':  console.info(prefix, ...args);  break;
      case 'warn':  console.warn(prefix, ...args);  break;
      case 'error': console.error(prefix, ...args); break;
      default:      console.log(prefix, ...args);
    }
  }
}

// ---------------------------------------------------------------------------
// JSDoc type definitions (for IDE intellisense)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AttachmentDescriptor
 * @property {string}       id           - Unique identifier (from DOM or generated).
 * @property {string}       type         - One of the AttachmentType constants.
 * @property {string}       filename     - Original filename if determinable, else ''.
 * @property {string}       url          - Primary resource URL (src or href).
 * @property {string|null}  previewUrl   - Thumbnail/preview image URL, or null.
 * @property {string}       size         - Human-readable size (e.g. '2.3 MB'), or ''.
 * @property {string}       mimeType     - MIME type string if detectable, else ''.
 * @property {boolean}      isAccessible - Whether the resource is likely reachable.
 * @property {boolean}      isExpired    - Whether the resource appears to have expired.
 * @property {string|null}  driveFileId  - Google Drive file ID if applicable, else null.
 */
