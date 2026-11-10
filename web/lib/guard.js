'use strict';

/*
 * Check where a modifying request came from before changing anything.
 */

// Whether a request that changes something came from one of our own pages.
// A form on some other website can post here from the office computer's
// browser — past the "this computer only" check — but the browser says where the form was: in
// Sec-Fetch-Site, and in Origin on every POST. With neither header it isn't a
// browser, and has no remembered password to borrow.
function sameOrigin(headers) {
  const site = headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  if (!headers.origin) return true;
  try {
    return new URL(headers.origin).host === headers.host;
  } catch (e) {
    return false; // "null", from a sandboxed page
  }
}

module.exports = { sameOrigin };
