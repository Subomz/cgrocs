// ============================================================
//  CGrocs — utils.js
//  Shared utility functions. Import wherever needed instead
//  of copy-pasting.
// ============================================================

/**
 * Escape a value for safe insertion into HTML innerHTML.
 * Prevents XSS when rendering user-supplied or Firestore data.
 *
 * @param {*} str - Any value; will be converted to string first.
 * @returns {string} HTML-safe string.
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
