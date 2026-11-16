// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer
// written from scratch to match marked 18.1.3's HTML byte for byte.
//
// Architecture: a line-oriented block parser (CommonMark phase 1) builds a
// small block tree, then a renderer walks it; leaf blocks are inline-parsed
// by a single-pass scanner with a delimiter stack for emphasis.
//
// Speed notes: the 40 generated READMEs dominate CPU time, so the inline
// scanner takes a fast path for plain text (no special characters), the
// block parser works on pre-split lines, and output is built in arrays.

const CH = {
  SPACE: 32, TAB: 9, LF: 10, CR: 13, BANG: 33, QUOTE: 34, HASH: 35,
  DOLLAR: 36, PERCENT: 37, AMP: 38, SQUOTE: 39, LPAREN: 40, RPAREN: 41,
  STAR: 42, PLUS: 43, COMMA: 44, MINUS: 45, DOT: 46, SLASH: 47,
  COLON: 58, SEMI: 59, LT: 60, EQ: 61, GT: 62, Q: 63, AT: 64,
  LBRACK: 91, BSLASH: 92, RBRACK: 93, CARET: 94, USCORE: 95, BTICK: 96,
  LBRACE: 123, PIPE: 124, RBRACE: 125, TILDE: 126
};

// ---------- character classification ----------

function isSpaceCh(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// Unicode punctuation (general categories P and S, per CommonMark) for
// non-ASCII code points.
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCh(c) {
  if (c < 128) return isAsciiPunct(c);
  return PUNCT_RE.test(String.fromCharCode(c));
}

// Is the code point starting at src[i] punctuation (surrogate-aware)?
function isPunctAt(src, i) {
  const c = src.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < src.length) {
    const lo = src.charCodeAt(i + 1);
    if (lo >= 0xDC00 && lo <= 0xDFFF) return PUNCT_RE.test(src.slice(i, i + 2));
  }
  return isPunctCh(c);
}

// Is the code point ending at src[i] (i = index just past it) punctuation?
function isPunctBefore(src, i) {
  const c = src.charCodeAt(i - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && i - 2 >= 0) {
    const hi = src.charCodeAt(i - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return PUNCT_RE.test(src.slice(i - 2, i));
  }
  return isPunctCh(c);
}

function isDigitCh(c) { return c >= 48 && c <= 57; }
function isAlphaCh(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnumCh(c) { return isAlphaCh(c) || isDigitCh(c); }
function isHexCh(c) {
  return isDigitCh(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

// ---------- escaping ----------

// Escape text for HTML output, leaving valid-looking entity references
// (&word; and &#...; / &#x...;) untouched — marked passes those through.
// `&` not followed by a word/#digits and `;` becomes &amp;.
function escapeText(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const semi = s.indexOf(';', i + 1);
      if (semi > i + 1 && semi - i <= 10) {
        let j = i + 1;
        let ok = false;
        if (s.charCodeAt(j) === 35) { // #
          j++;
          if (j < semi && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x/X
            j++;
            ok = j < semi && semi - j <= 6;
            while (j < semi) { if (!isHexCh(s.charCodeAt(j))) { ok = false; break; } j++; }
          } else {
            ok = j < semi && semi - j <= 7;
            while (j < semi) { if (!isDigitCh(s.charCodeAt(j))) { ok = false; break; } j++; }
          }
        } else {
          ok = true;
          while (j < semi) {
            const d = s.charCodeAt(j);
            if (!isAlnumCh(d)) { ok = false; break; }
            j++;
          }
        }
        if (ok) { out += s.slice(i, semi + 1); i = semi + 1; continue; }
      }
      out += '&amp;'; i++; continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    // fast run of ordinary characters
    let j = i + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Escape with every & encoded (code spans, code blocks).
function escapeAll(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += '&amp;'; i++; continue; }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    let j = i + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Decode one numeric character reference at s[i] === '&'; returns
// {ch, next} or null when not a valid numeric reference.
// Decimal: 1-7 digits; hex: 1-6 digits. 0, surrogates, >0x10FFFF -> U+FFFD.
function decodeNumericRef(s, i) {
  const n = s.length;
  if (i + 2 >= n || s.charCodeAt(i + 1) !== 35) return null;
  let j = i + 2;
  let hex = false;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
  const start = j;
  let val = 0;
  if (hex) {
    while (j < n && isHexCh(s.charCodeAt(j))) {
      const c = s.charCodeAt(j);
      val = val * 16 + (c <= 57 ? c - 48 : (c <= 70 ? c - 55 : c - 87));
      j++;
      if (j - start > 6) return null;
    }
    if (j === start || j >= n || s.charCodeAt(j) !== 59) return null;
  } else {
    while (j < n && isDigitCh(s.charCodeAt(j))) {
      val = val * 10 + (s.charCodeAt(j) - 48);
      j++;
      if (j - start > 7) return null;
    }
    if (j === start || j >= n || s.charCodeAt(j) !== 59) return null;
  }
  let ch;
  if (val === 0 || val > 0x10ffff || (val >= 0xd800 && val <= 0xdfff)) ch = '\uFFFD';
  else ch = String.fromCodePoint(val);
  return { ch, next: j + 1 };
}

// ---------- URLs ----------

// marked's cleanUrl: percent-encode the URL the way encodeURI does, but
// leave literal % alone. Returns null only when encoding throws.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// Unescape backslash escapes in a link destination/title (ASCII punctuation
// after a backslash becomes the punctuation itself).
function unescapeBackslashes(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// ---------- inline parsing ----------

const INLINE_SPECIAL = /[\\`*_\[!<&~\n]/;
const INLINE_SPECIAL_G = /[\\`*_\[!<&~\n]/g;

// Delimiter kinds
const D_EM = 1, D_STRONG = 2, D_DEL = 3;

function parseInline(src, refs, st) {
  const n = src.length;
  if (n === 0) return '';
  if (src.indexOf('www.') < 0 && src.indexOf('://') < 0 && src.indexOf('@') < 0 &&
      !INLINE_SPECIAL.test(src)) {
    return escapeText(src);
  }
  return parseInlineSlow(src, refs, st || { inLink: false, linkEmitted: false });
}

// --- autolink helpers ---

function isEmailLocalChar(c) {
  return isAlnumCh(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 ||
    c === 38 || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 ||
    c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 ||
    c === 125 || c === 126 || c === 45;
}

// Validate an email domain starting at i (after the @). Returns the end
// index (exclusive) of the domain, or -1. Requires at least one dot.
function emailDomainEnd(src, i) {
  const n = src.length;
  let j = i;
  let labels = 0;
  let hasDot = false;
  while (j < n) {
    // one label: alnum, then alnum/- up to 63 chars, ending alnum
    if (!isAlnumCh(src.charCodeAt(j))) return -1;
    let len = 0;
    let lastAlnum = -1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (isAlnumCh(c)) { lastAlnum = j; j++; len++; }
      else if (c === 45) { j++; len++; }
      else break;
      if (len > 63) return -1;
    }
    if (lastAlnum < 0 || src.charCodeAt(j - 1) === 45) return -1;
    labels++;
    if (j < n && src.charCodeAt(j) === 46) { // .
      hasDot = true;
      j++;
      if (j >= n || !isAlnumCh(src.charCodeAt(j))) return -1;
      continue;
    }
    break;
  }
  if (!hasDot || labels < 2) return -1;
  return j;
}

// Trim trailing punctuation from an extended-autolink URL (GFM rules):
// trailing ? ! . , : ; * _ ~ are dropped (but a ; that ends an entity
// reference is kept); a trailing ) is dropped when parens are unbalanced.
function trimAutolinkUrl(url) {
  let end = url.length;
  for (;;) {
    if (end === 0) break;
    const last = url.charCodeAt(end - 1);
    if (last === 41) { // )
      let open = 0, close = 0;
      for (let k = 0; k < end; k++) {
        const c = url.charCodeAt(k);
        if (c === 40) open++;
        else if (c === 41) close++;
      }
      if (open > close) break;
      end--;
      continue;
    }
    if (last === 59) { // ;
      // keep when it ends an entity reference &word;
      let k = end - 2;
      while (k >= 0 && isAlnumCh(url.charCodeAt(k))) k--;
      if (k >= 0 && url.charCodeAt(k) === 38 && end - 2 - k >= 1) break;
      end--;
      continue;
    }
    if (last === 63 || last === 33 || last === 46 || last === 44 ||
        last === 58 || last === 42 || last === 95 || last === 126) {
      end--;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

// Validate the domain of a www./http(s):// autolink. `i` is the index just
// after 'www.' or '://'. Returns the end of the domain, or -1. The domain
// must have at least two labels; the last label must be >= 2 letters.
function wwwDomainEnd(src, i) {
  const n = src.length;
  let j = i;
  let labels = 0;
  let lastLabel = '';
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAlnumCh(c) || c === 45) { lastLabel += src[j]; j++; }
    else if (c === 46) {
      if (lastLabel === '') return -1;
      labels++;
      lastLabel = '';
      j++;
    } else break;
  }
  if (lastLabel === '' || labels < 1) return -1;
  labels++;
  if (labels < 2) return -1;
  if (lastLabel.length < 2) return -1;
  for (let k = 0; k < lastLabel.length; k++) {
    if (!isAlphaCh(lastLabel.charCodeAt(k))) return -1;
  }
  return j;
}

// Try to parse an extended autolink starting at `p` (where a trigger was
// found). `runStart` bounds the email local part's backward scan so it never
// reaches past text already emitted. Returns {href, text, end} or null.
function parseExtendedAutolink(src, p, kind, runStart) {
  const n = src.length;
  if (kind === 3) { // email: local part ends at p (the @)
    let ls = p;
    while (ls > runStart && isEmailLocalChar(src.charCodeAt(ls - 1))) ls--;
    if (ls === p) return null;
    const domEnd = emailDomainEnd(src, p + 1);
    if (domEnd < 0) return null;
    const text = src.slice(ls, domEnd);
    return { href: 'mailto:' + text, text, end: domEnd, start: ls };
  }
  // www. or http(s)://
  const schemeEnd = kind === 1 ? p + 4 : src.indexOf('://', p) + 3;
  if (kind === 1) {
    // preceding character must be start, whitespace, or one of * _ ~ ( [ {
    if (p > 0) {
      const pc = src.charCodeAt(p - 1);
      if (!isSpaceCh(pc) && pc !== 42 && pc !== 95 && pc !== 126 &&
          pc !== 40 && pc !== 91 && pc !== 123 && pc !== 60 && pc !== 34 &&
          pc !== 39) return null;
    }
  } else {
    if (p > 0) {
      const pc = src.charCodeAt(p - 1);
      if (!isSpaceCh(pc) && pc !== 42 && pc !== 95 && pc !== 126 &&
          pc !== 40 && pc !== 91 && pc !== 123 && pc !== 60 && pc !== 34 &&
          pc !== 39) return null;
    }
  }
  const domEnd = wwwDomainEnd(src, schemeEnd);
  if (domEnd < 0) return null;
  // scan the rest of the URL: until whitespace, <, >, or a control char
  let end = domEnd;
  while (end < n) {
    const c = src.charCodeAt(end);
    if (c <= 32 || c === 60 || c === 62 || c === 127) break;
    end++;
  }
  let url = trimAutolinkUrl(src.slice(p, end));
  if (url.length === 0) return null;
  // the domain must still be valid after trimming (trimming only affects the tail)
  const href = kind === 1 ? 'http://' + url : url;
  return { href, text: url, end: p + url.length, start: p };
}

// Scan a text run [start, end) for extended autolinks, emitting text/link
// items. Returns the new position (may exceed `end` when a URL runs past
// the next special character).
function scanTextRun(src, start, end, items, st) {
  let i = start;
  // Inside a link, extended autolinks are suppressed (marked's url
  // tokenizer is skipped while state.inLink is set).
  if (st && st.inLink) {
    if (i < end) items.push(escapeText(src.slice(i, end)));
    return end;
  }
  while (i < end) {
    let p = -1, kind = 0;
    const w = src.indexOf('www.', i);
    if (w >= 0 && w < end) { p = w; kind = 1; }
    const h1 = src.indexOf('http://', i);
    if (h1 >= 0 && h1 < end && (p < 0 || h1 < p)) { p = h1; kind = 2; }
    const h2 = src.indexOf('https://', i);
    if (h2 >= 0 && h2 < end && (p < 0 || h2 < p)) { p = h2; kind = 2; }
    const at = src.indexOf('@', i);
    if (at >= 0 && at < end && (p < 0 || at < p)) { p = at; kind = 3; }
    if (p < 0) {
      if (i < end) items.push(escapeText(src.slice(i, end)));
      return end;
    }
    const link = parseExtendedAutolink(src, p, kind, i);
    if (!link) {
      // not an autolink: emit text up to and including the trigger's first char
      const cut = kind === 3 ? p + 1 : p + 1;
      if (i < cut) items.push(escapeText(src.slice(i, cut)));
      i = cut;
      continue;
    }
    if (link.start > i) items.push(escapeText(src.slice(i, link.start)));
    items.push('<a href="' + escapeText(link.href) + '">' + escapeText(link.text) + '</a>');
    i = link.end;
    if (i >= end) return i;
  }
  return i;
}

// --- link parsing ---

function skipInlineWS(src, j) {
  const n = src.length;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13) j++;
    else break;
  }
  return j;
}

// Find the matching ] for a [ at position i. Returns the index of ] or -1.
// Mirrors marked's label pattern: a backtick run starts a code span (the
// closing run may be any length), a run of 2+ backticks just before ] is a
// unit of its own, and brackets nest at most two levels deep.
function findLinkEnd(src, i) {
  const n = src.length;
  let depth = 1;
  for (let j = i + 1; j < n; j++) {
    const c = src.charCodeAt(j);
    if (c === 92) { j++; continue; }
    if (c === 96) { // backtick run
      let run = 1;
      while (j + run < n && src.charCodeAt(j + run) === 96) run++;
      if (run >= 2 && j + run < n && src.charCodeAt(j + run) === 93) {
        j += run - 1; // ``+(?=]) unit: the ] closes the label
        continue;
      }
      // find the closing run (any length, maximal)
      let k = j + run;
      let end = -1;
      while (k < n) {
        if (src.charCodeAt(k) === 96) {
          let r2 = 1;
          while (k + r2 < n && src.charCodeAt(k + r2) === 96) r2++;
          end = k + r2;
          break;
        }
        k++;
      }
      if (end < 0) return -1; // unclosed code span: the label cannot close
      j = end - 1;
      continue;
    }
    if (c === 91) {
      if (depth === 3) return -1;
      depth++;
    } else if (c === 93) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// Parse a link title starting at src[i] ('"' or '\'' or '(').
// Returns {title, end} or null.
function parseLinkTitle(src, i) {
  const n = src.length;
  const q = src.charCodeAt(i);
  if (q === 40) { // ( ... ) — no unescaped parens inside
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 41) return { title: out, end: j + 1 };
      if (c === 40) return null;
      if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) {
        out += src[j + 1];
        j += 2;
        continue;
      }
      out += src[j];
      j++;
    }
    return null;
  }
  // " or '
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === q) return { title: out, end: j + 1 };
    if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) {
      out += src[j + 1];
      j += 2;
      continue;
    }
    out += src[j];
    j++;
  }
  return null;
}

// Parse an inline link tail starting at src[i] === '('.
// Returns {dest, title, end} (end = index just after ')') or null.
function parseInlineLinkTail(src, i) {
  const n = src.length;
  let j = skipInlineWS(src, i + 1);
  if (j >= n) return null;
  let dest;
  if (src.charCodeAt(j) === 60) { // <...>
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 62) { ok = true; break; }
      if (c === 10 || c === 60) break;
      if (c === 92 && k + 1 < n) { k += 2; continue; } // \> is not the end
      k++;
    }
    if (!ok) return null;
    dest = unescapeBackslashes(src.slice(j + 1, k));
    j = k + 1;
  } else {
    let depth = 0;
    let k = j;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c === 13) break;
      if (c === 92 && k + 1 < n && isAsciiPunct(src.charCodeAt(k + 1))) { k += 2; continue; }
      if (c === 40) { depth++; k++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; k++; continue;
      }
      k++;
    }
    if (k === j) {
      // empty destination: () is a valid inline link
      dest = '';
    } else {
      if (depth !== 0) return null;
      dest = unescapeBackslashes(src.slice(j, k));
    }
    j = k;
  }
  let title = null;
  let k = skipInlineWS(src, j);
  if (k < n) {
    const tc = src.charCodeAt(k);
    if (tc === 34 || tc === 39 || tc === 40) {
      const t = parseLinkTitle(src, k);
      if (!t) return null;
      title = t.title;
      k = t.end;
    }
  }
  k = skipInlineWS(src, k);
  if (k >= n || src.charCodeAt(k) !== 41) return null;
  return { dest, title, end: k + 1 };
}

function normalizeLabel(s) {
  // Unicode case folding: ß/ẞ fold to "ss" (toLowerCase leaves ß as ß)
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// End of an autolink <...> starting at src[i], or -1. The inner text must
// have no whitespace or '<' and be a scheme (2-32 chars) or an email.
function autolinkExtent(src, i) {
  const n = src.length;
  const gt = src.indexOf('>', i + 1);
  if (gt < 0 || gt - i > 200) return -1;
  const inner = src.slice(i + 1, gt);
  if (/[\s<]/.test(inner)) return -1;
  const colon = inner.indexOf(':');
  if (colon >= 2 && colon <= 32) {
    let ok = isAlphaCh(inner.charCodeAt(0));
    for (let k = 1; ok && k < colon; k++) {
      const c = inner.charCodeAt(k);
      if (!isAlnumCh(c) && c !== 43 && c !== 46 && c !== 45) ok = false;
    }
    if (ok) return gt + 1;
  }
  const at = inner.indexOf('@');
  if (at > 0) {
    let okLocal = true;
    for (let k = 0; k < at; k++) {
      if (!isEmailLocalChar(inner.charCodeAt(k))) { okLocal = false; break; }
    }
    if (okLocal) {
      const domEnd = emailDomainEnd(inner, at + 1);
      if (domEnd === inner.length) return gt + 1;
    }
  }
  return -1;
}

// Marked's Be(): does the label [start..close] contain a '<' that starts an
// inline tag or autolink whose match extends past the end of the label?
// If so the link is aborted.
function labelHasRunawayTag(src, start, close) {
  for (let s = start + 1; s < close; s++) {
    const c = src.charCodeAt(s);
    if (c === 92) { s++; continue; }
    if (c === 96) {
      const end = codeSpanEnd(src, s);
      if (end > 0) { s = end - 1; continue; }
      continue;
    }
    if (c !== 60) continue; // <
    const end = matchInlineHtml(src, s);
    if (end && end.end > close) return true;
    const ae = autolinkExtent(src, s);
    if (ae > 0 && ae > close) return true;
    if (end) s = end.end - 1;
    else if (ae > 0) s = ae - 1;
  }
  return false;
}

function lookupRef(refs, label) {
  if (!refs) return null;
  const v = refs.get(normalizeLabel(label));
  return v === undefined ? null : v;
}

// Render a link's inner HTML (already parsed) as <a ...>.
function renderLink(href, title, inner) {
  let out = '<a href="' + escapeText(href) + '"';
  if (title !== null && title !== undefined) out += ' title="' + escapeText(title) + '"';
  return out + '>' + inner + '</a>';
}

// Render an image: alt is the link text parsed as inline, then stripped of
// any HTML tags.
function renderImage(href, title, altText) {
  let out = '<img src="' + escapeText(href) + '" alt="' + altText + '"';
  if (title !== null && title !== undefined) out += ' title="' + escapeText(title) + '"';
  return out + '>';
}

// Try to parse a link or image starting at src[i] ('[' or '![').
// On success pushes the rendered HTML to items and returns the new index.
// On failure returns -1 (caller emits the '[' or '!' literally).
// Try to parse a link/image starting at src[i] ('[' or '![').
// Returns the end index, or -1 when no link forms. `st` carries marked's
// lexer state: while a link's text is parsed, inLink is set (extended
// autolinks suppressed) and linkEmitted records whether a link formed
// inside; a non-image link whose text contains a link is aborted.
function tryParseLink(src, i, isImage, refs, items, st) {
  const start = isImage ? i + 1 : i;
  const close = findLinkEnd(src, start);
  if (close < 0) return -1;
  const text = src.slice(start + 1, close);
  // Be(): a tag/autolink inside the label that runs past the label aborts
  if (labelHasRunawayTag(src, start, close)) return -1;
  // Parse the link text the way marked's De() does: inLink set, linkEmitted
  // cleared, then restored; a nested link aborts a non-image outer link.
  const parseText = () => {
    const savedInLink = st.inLink, savedEmitted = st.linkEmitted;
    st.inLink = true;
    st.linkEmitted = false;
    const inner = parseInline(text, refs, st);
    const nested = st.linkEmitted;
    st.inLink = savedInLink;
    st.linkEmitted = savedEmitted;
    return { inner, nested };
  };
  let j = close + 1;
  // inline link ( ... )
  if (j < src.length && src.charCodeAt(j) === 40) {
    const tail = parseInlineLinkTail(src, j);
    if (tail) {
      const href = cleanUrl(tail.dest);
      if (isImage) {
        const alt = stripTags(parseText().inner);
        if (href === null) {
          items.push(escapeText(alt));
        } else {
          items.push(renderImage(href, tail.title, escapeText(alt)));
        }
        return tail.end;
      }
      const { inner, nested } = parseText();
      if (nested) return -1;
      st.linkEmitted = true;
      if (href === null) items.push(inner);
      else items.push(renderLink(href, tail.title, inner));
      return tail.end;
    }
  }
  // reference link [label], [] (collapsed), or shortcut
  let ref = null;
  if (j + 1 < src.length && src.charCodeAt(j) === 91) {
    if (src.charCodeAt(j + 1) === 93) { // []
      ref = lookupRef(refs, text);
      j = j + 2;
    } else {
      const close2 = findLinkEnd(src, j);
      if (close2 >= 0) {
        const refLabel = src.slice(j + 1, close2);
        // ref labels may not contain unescaped [ or ]
        if (!hasUnescapedBracket(refLabel)) {
          ref = lookupRef(refs, refLabel);
          if (ref) j = close2 + 1;
        }
      }
    }
  } else {
    ref = lookupRef(refs, text);
  }
  if (ref) {
    if (isImage) {
      const alt = stripTags(parseText().inner);
      const href = cleanUrl(ref.dest);
      if (href === null) items.push(escapeText(alt));
      else items.push(renderImage(href, ref.title, escapeText(alt)));
    } else {
      const { inner, nested } = parseText();
      if (nested) return -1;
      st.linkEmitted = true;
      const href = cleanUrl(ref.dest);
      if (href === null) items.push(inner);
      else items.push(renderLink(href, ref.title, inner));
    }
    return j;
  }
  return -1;
}

// Does s contain an unescaped [ or ]?
function hasUnescapedBracket(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 92) { k++; continue; }
    if (c === 91 || c === 93) return true;
  }
  return false;
}

// Remove <...> tags from a string (for image alt text). An <img> tag
// contributes its alt attribute value (marked re-renders alt text with a
// text renderer, so a nested image yields its alt text, not nothing).
function stripTags(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 60) { // <
      const gt = s.indexOf('>', i + 1);
      if (gt >= 0) {
        const tag = s.slice(i, gt + 1);
        if (tag.startsWith('<img ')) {
          const m = / alt="([^"]*)"/.exec(tag);
          if (m) out += decodeAltEntities(m[1]);
        }
        i = gt + 1;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

// Decode the entities escapeText produces (&amp; &lt; &gt; &quot;) plus
// numeric character references, so an alt value taken out of rendered HTML
// is not double-escaped when it is escaped again.
function decodeAltEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|#39);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === '#39') return "'";
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

// --- autolinks and inline HTML ---

// Try to parse an autolink <...> or inline HTML starting at src[i] === '<'.
// Returns {html, end} or null (caller emits '&lt;'). A start <a> tag sets
// st.inLink, a </a> tag clears it (marked's tag tokenizer).
function parseAngle(src, i, items, st) {
  const n = src.length;
  // autolink: <scheme:...> or <email>
  const gt = src.indexOf('>', i + 1);
  if (gt > i + 1 && gt - i <= 200) {
    const inner = src.slice(i + 1, gt);
    if (!/[\s<]/.test(inner)) {
      // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
      const colon = inner.indexOf(':');
      if (colon >= 2 && colon <= 32) {
        let ok = isAlphaCh(inner.charCodeAt(0));
        for (let k = 1; ok && k < colon; k++) {
          const c = inner.charCodeAt(k);
          if (!isAlnumCh(c) && c !== 43 && c !== 46 && c !== 45) ok = false;
        }
        if (ok) {
          const href = cleanUrl(inner);
          const text = escapeText(inner);
          if (href !== null) items.push('<a href="' + escapeText(href) + '">' + text + '</a>');
          else items.push(text);
          return gt + 1;
        }
      }
      // email
      const at = inner.indexOf('@');
      if (at > 0) {
        let ls = 0;
        let okLocal = true;
        for (let k = 0; k < at; k++) {
          if (!isEmailLocalChar(inner.charCodeAt(k))) { okLocal = false; break; }
        }
        if (okLocal) {
          const domEnd = emailDomainEnd(inner, at + 1);
          if (domEnd === inner.length) {
            const href = 'mailto:' + inner;
            items.push('<a href="' + escapeText(href) + '">' + escapeText(inner) + '</a>');
            return gt + 1;
          }
        }
      }
    }
  }
  // inline HTML: comment, processing instruction, declaration, CDATA,
  // open tag, closing tag
  const html = matchInlineHtml(src, i);
  if (html) {
    if (st) {
      if (!st.inLink && /^<a[ >]/i.test(html.text)) st.inLink = true;
      else if (st.inLink && /^<\/a\s*>/i.test(html.text)) st.inLink = false;
    }
    items.push(html.text);
    return html.end;
  }
  return -1;
}

// Match an inline HTML construct at src[i] === '<'. Returns {text, end}
// or null. All raw HTML tags pass through (marked does not escape any).
function matchInlineHtml(src, i) {
  const n = src.length;
  // comment (<!--> and <!---> are complete comments on their own)
  if (src.startsWith('<!--', i)) {
    if (src.startsWith('<!-->', i)) return { text: '<!-->', end: i + 5 };
    if (src.startsWith('<!--->', i)) return { text: '<!--->', end: i + 6 };
    let end = src.indexOf('-->', i + 4);
    if (end < 0) return null;
    end += 3;
    return { text: src.slice(i, end), end };
  }
  // processing instruction
  if (src.startsWith('<?', i)) {
    let end = src.indexOf('?>', i + 2);
    if (end < 0) return null;
    end += 2;
    return { text: src.slice(i, end), end };
  }
  // declaration <!NAME ...> — the name is letters, then whitespace is required
  if (src.startsWith('<!', i) && i + 2 < n) {
    const c = src.charCodeAt(i + 2);
    if (isAlphaCh(c)) {
      let j = i + 2;
      while (j < n && isAlphaCh(src.charCodeAt(j))) j++;
      if (j >= n || !isSpaceCh(src.charCodeAt(j))) return null;
      let end = src.indexOf('>', j);
      if (end < 0) return null;
      return { text: src.slice(i, end + 1), end: end + 1 };
    }
    if (src.startsWith('<![CDATA[', i)) {
      let end = src.indexOf(']]>', i + 9);
      if (end < 0) return null;
      end += 3;
      return { text: src.slice(i, end), end };
    }
  }
  // open or closing tag
  let j = i + 1;
  let closing = false;
  if (j < n && src.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n || !isAlphaCh(src.charCodeAt(j))) return null;
  const nameStart = j;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAlnumCh(c) || c === 45) j++;
    else break;
  }
  const name = src.slice(nameStart, j);
  // a closing tag takes only optional whitespace, then >
  if (closing) {
    while (j < n && isSpaceCh(src.charCodeAt(j))) j++;
    if (j >= n || src.charCodeAt(j) !== 62) return null;
    return { text: src.slice(i, j + 1), end: j + 1 };
  }
  // attributes — each one requires whitespace before it
  let selfClose = false;
  for (;;) {
    let ws = 0;
    while (j < n && isSpaceCh(src.charCodeAt(j))) { j++; ws++; }
    if (j >= n) return null;
    const c = src.charCodeAt(j);
    if (c === 62) { j++; break; } // >
    if (c === 47) { // /
      if (j + 1 < n && src.charCodeAt(j + 1) === 62) { selfClose = true; j += 2; break; }
      return null;
    }
    if (ws === 0) return null;
    // attribute name
    if (!(isAlphaCh(c) || c === 95 || c === 58 || c === 46 || c === 45)) return null;
    while (j < n) {
      const d = src.charCodeAt(j);
      if (isAlnumCh(d) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    // optional = value: peek past whitespace; only consume it when '='
    // follows (otherwise it belongs to the next attribute's \s+)
    const save = j;
    while (j < n && isSpaceCh(src.charCodeAt(j))) j++;
    if (j < n && src.charCodeAt(j) === 61) { // =
      j++;
      while (j < n && isSpaceCh(src.charCodeAt(j))) j++;
      if (j >= n) return null;
      const q = src.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && src.charCodeAt(j) !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        let any = false;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (isSpaceCh(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          any = true;
          j++;
        }
        if (!any) return null;
      }
    } else {
      j = save;
    }
  }
  return { text: src.slice(i, j), end: j };
}

// --- delimiter processing (opener-driven, as marked does it) ---

// Flanking for a delimiter run of `c` at src[sp..sp+run). Start/end of the
// inline text count as whitespace.
function delimFlanking(src, sp, run, c) {
  const n = src.length;
  const before = sp > 0 ? src.charCodeAt(sp - 1) : -1;
  const after = sp + run < n ? src.charCodeAt(sp + run) : -1;
  const beforeSpace = before < 0 || isSpaceCh(before);
  const afterSpace = after < 0 || isSpaceCh(after);
  const beforePunct = before >= 0 && isPunctBefore(src, sp);
  const afterPunct = after >= 0 && isPunctAt(src, sp + run);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  let canOpen, canClose;
  if (c === 95) {
    canOpen = leftFlanking && (!rightFlanking || beforePunct);
    canClose = rightFlanking && (!leftFlanking || afterPunct);
  } else {
    canOpen = leftFlanking;
    canClose = rightFlanking;
  }
  return { canOpen, canClose };
}

// End of a code span starting at src[sp] === '`', or -1 when unclosed.
function codeSpanEnd(src, sp) {
  const n = src.length;
  let run = 1;
  while (sp + run < n && src.charCodeAt(sp + run) === 96) run++;
  let j = sp + run;
  while (j < n) {
    if (src.charCodeAt(j) === 96) {
      let r2 = 1;
      while (j + r2 < n && src.charCodeAt(j + r2) === 96) r2++;
      if (r2 === run) return j + r2;
      j += r2;
    } else j++;
  }
  return -1;
}

// End of a link/image starting at src[i] ('[' or '!['), or -1 when no link
// forms there. Used to hide link text from the emphasis closer search.
function linkExtent(src, i, isImage, refs) {
  const start = isImage ? i + 1 : i;
  const close = findLinkEnd(src, start);
  if (close < 0) return -1;
  const text = src.slice(start + 1, close);
  let j = close + 1;
  if (j < src.length && src.charCodeAt(j) === 40) {
    const tail = parseInlineLinkTail(src, j);
    if (tail) return tail.end;
    return -1;
  }
  if (j + 1 < src.length && src.charCodeAt(j) === 91) {
    if (src.charCodeAt(j + 1) === 93) {
      if (lookupRef(refs, text)) return j + 2;
      return -1;
    }
    const close2 = findLinkEnd(src, j);
    if (close2 >= 0 && lookupRef(refs, src.slice(j + 1, close2))) return close2 + 1;
    return -1;
  }
  if (lookupRef(refs, text)) return j;
  return -1;
}

// Closer-scan skip patterns: when looking for a `*` closer, a region
// `__...*...__` is skipped whole (and symmetrically `**..._...**` for `_`).
const SKIP_STAR_RE = /[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/y;
const SKIP_UND_RE = /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/y;

// Is the character at src[i] escaped by an odd run of backslashes?
function isEscaped(src, i) {
  let k = i - 1, n = 0;
  while (k >= 0 && src.charCodeAt(k) === 92) { n++; k--; }
  return n % 2 === 1;
}

// End of an inline HTML tag or autolink starting at src[i] === '<', or -1.
// Mirrors the `html` alternative of the mask marked scans with: `<` not
// followed by a space, up to the first `>` with no `<` in between.
function htmlExtent(src, i) {
  const n = src.length;
  if (i + 1 < n && isSpaceCh(src.charCodeAt(i + 1))) return -1;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 62) return j + 1; // >
    if (c === 60) return -1; // < in between
    j++;
  }
  return -1;
}

// Find the closer for an opener run of `ch` whose remaining length from the
// current position is L and whose full run length is Y. Returns
// {innerEnd, strong} (innerEnd = just past the used part of the closer run;
// the token's inner text is src[sp+strip .. innerEnd-strip]) or null.
// Closer candidates are classified by flanking: opener-like runs add to
// the length still needed, closer-like runs subtract from it, and runs that
// can both open and close are subject to the rule of three (on Y).
function findEmClose(src, sp, L, Y, ch, refs) {
  const n = src.length;
  const chr = String.fromCharCode(ch);
  let m = L, f = 0;
  let q = sp + L;
  const skipRe = ch === 42 ? SKIP_STAR_RE : SKIP_UND_RE;
  skipRe.lastIndex = q;
  const sm = skipRe.exec(src);
  if (sm) q += sm[0].length;
  while (q < n) {
    let r = src.indexOf(chr, q);
    let b = src.indexOf('`', q);
    let l = src.indexOf('[', q);
    let t = src.indexOf('<', q);
    let next = r;
    if (b >= 0 && (next < 0 || b < next)) next = b;
    if (l >= 0 && (next < 0 || l < next)) next = l;
    if (t >= 0 && (next < 0 || t < next)) next = t;
    if (next < 0) return null;
    if (next === b) {
      const end = codeSpanEnd(src, b);
      if (end > 0) { q = end; continue; }
      q = b + 1;
      continue;
    }
    if (next === l) {
      const isImg = l > 0 && src.charCodeAt(l - 1) === 33;
      const end = linkExtent(src, isImg ? l - 1 : l, isImg, refs);
      if (end > 0) { q = end; continue; }
      q = l + 1;
      continue;
    }
    if (next === t) {
      const end = htmlExtent(src, t);
      if (end > 0) { q = end; continue; }
      q = t + 1;
      continue;
    }
    let run = 1;
    while (r + run < n && src.charCodeAt(r + run) === ch) run++;
    // A run whose first character is backslash-escaped contributes only
    // its unescaped remainder (the masked text marked scans has the
    // escaped character hidden).
    if (isEscaped(src, r)) {
      if (run === 1) { q = r + 1; continue; }
      r++;
      run--;
    }
    const fl = delimFlanking(src, r, run, ch);
    let matched = false;
    if (fl.canOpen && !fl.canClose) m += run;
    else if (!fl.canOpen && fl.canClose) { m -= run; matched = m <= 0; }
    else if (fl.canOpen && fl.canClose) {
      if (Y % 3 !== 0 && (Y + run) % 3 === 0) f += run;
      else { m -= run; matched = m <= 0; }
    }
    if (matched) {
      const used = Math.min(run, run + m + f);
      return { innerEnd: r + used, strong: Math.min(L, used) % 2 === 0 };
    }
    q = r + run;
  }
  return null;
}

// Strikethrough, marked's del rule: one or two tildes, content not
// starting/ending with space or tilde, closer of the same length, and the
// character after the closer is not a tilde.
const DEL_RE = /(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/y;

// Parse a code span starting at src[sp] === '`'. Pushes the rendered
// <code>...</code> (or literal backticks) and returns the new index.
function parseCodeSpan(src, sp, items) {
  const n = src.length;
  let run = 1;
  while (sp + run < n && src.charCodeAt(sp + run) === 96) run++;
  let j = sp + run;
  let found = -1;
  while (j < n) {
    if (src.charCodeAt(j) === 96) {
      let r2 = 1;
      while (j + r2 < n && src.charCodeAt(j + r2) === 96) r2++;
      if (r2 === run) { found = j; break; }
      j += r2;
    } else {
      j++;
    }
  }
  if (found < 0) {
    items.push('`'.repeat(run));
    return sp + run;
  }
  let content = src.slice(sp + run, found).replace(/\n/g, ' ');
  if (content.length >= 2 && content.charCodeAt(0) === 32 &&
      content.charCodeAt(content.length - 1) === 32 &&
      !/^ +$/.test(content)) {
    content = content.slice(1, -1);
  }
  items.push('<code>' + escapeAll(content) + '</code>');
  return found + run;
}

function parseInlineSlow(src, refs, st) {
  const n = src.length;
  const items = [];
  const re = INLINE_SPECIAL_G;
  let pos = 0;
  re.lastIndex = 0;
  let m = re.exec(src);
  while (true) {
    const sp = m ? m.index : n;
    pos = scanTextRun(src, pos, sp, items, st);
    if (!m) break;
    const c = src.charCodeAt(sp);
    if (c === 92) { // backslash
      if (sp + 1 < n) {
        const d = src.charCodeAt(sp + 1);
        if (d === 10) {
          items.push('<br>');
          pos = sp + 2;
          // a hard break eats the next line's leading spaces/tabs
          while (pos < n && (src.charCodeAt(pos) === 32 || src.charCodeAt(pos) === 9)) pos++;
        }
        else if (isAsciiPunct(d)) { items.push(escapeText(src[sp + 1])); pos = sp + 2; }
        else { items.push('\\'); pos = sp + 1; }
      } else { items.push('\\'); pos = sp + 1; }
    } else if (c === 96) { // backtick
      pos = parseCodeSpan(src, sp, items);
    } else if (c === 42 || c === 95) { // * _ : emphasis, opener-driven
      // Only the first character is tried as an opener; when it fails the
      // rest of the run is retried as a shorter run, exactly as marked's
      // lexer consumes one character of text and retries at the next.
      // Flanking is judged at the run start (marked backs the opener up
      // over preceding same characters); the remaining length from here
      // is what the closer must cover, the full run length is what the
      // rule of three uses.
      let runEnd = sp;
      while (runEnd < n && src.charCodeAt(runEnd) === c) runEnd++;
      let runStart = sp;
      while (runStart > 0 && src.charCodeAt(runStart - 1) === c) runStart--;
      const fullRun = runEnd - runStart;
      const fl = delimFlanking(src, runStart, fullRun, c);
      let done = false;
      if (fl.canOpen) {
        const close = findEmClose(src, sp, runEnd - sp, fullRun, c, refs);
        if (close) {
          const strip = close.strong ? 2 : 1;
          const inner = src.slice(sp + strip, close.innerEnd - strip);
          items.push((close.strong ? '<strong>' : '<em>') +
            parseInline(inner, refs, st) +
            (close.strong ? '</strong>' : '</em>'));
          pos = close.innerEnd;
          done = true;
        }
      }
      if (!done) {
        items.push(String.fromCharCode(c));
        pos = sp + 1;
      }
    } else if (c === 126) { // ~ : strikethrough
      DEL_RE.lastIndex = sp;
      const dm = DEL_RE.exec(src);
      if (dm) {
        items.push('<del>' + parseInline(dm[2], refs, st) + '</del>');
        pos = sp + dm[0].length;
      } else {
        items.push('~');
        pos = sp + 1;
      }
    } else if (c === 91) { // [
      const r = tryParseLink(src, sp, false, refs, items, st);
      if (r < 0) { items.push('['); pos = sp + 1; }
      else pos = r;
    } else if (c === 33) { // !
      if (sp + 1 < n && src.charCodeAt(sp + 1) === 91) {
        const r = tryParseLink(src, sp, true, refs, items, st);
        if (r < 0) { items.push('!'); pos = sp + 1; }
        else pos = r;
      } else { items.push('!'); pos = sp + 1; }
    } else if (c === 60) { // <
      const r = parseAngle(src, sp, items, st);
      if (r < 0) { items.push('&lt;'); pos = sp + 1; }
      else pos = r;
    } else if (c === 38) { // &
      const dec = decodeNumericRef(src, sp);
      if (dec) { items.push(escapeText(dec.ch)); pos = dec.next; }
      else {
        const semi = src.indexOf(';', sp + 1);
        let ok = false;
        if (semi > sp + 1) {
          ok = true;
          for (let k = sp + 1; k < semi; k++) {
            if (!isAlnumCh(src.charCodeAt(k))) { ok = false; break; }
          }
        }
        if (ok) { items.push(src.slice(sp, semi + 1)); pos = semi + 1; }
        else { items.push('&amp;'); pos = sp + 1; }
      }
    } else if (c === 10) { // newline: soft break, or hard break after 2+ spaces
      const last = items.length - 1;
      if (last >= 0 && typeof items[last] === 'string') {
        const s = items[last];
        let k = s.length;
        while (k > 0 && s.charCodeAt(k - 1) === 32) k--;
        if (s.length - k >= 2) {
          items[last] = s.slice(0, k);
          items.push('<br>');
          pos = sp + 1;
          // a hard break eats the next line's leading spaces/tabs
          while (pos < n && (src.charCodeAt(pos) === 32 || src.charCodeAt(pos) === 9)) pos++;
          re.lastIndex = pos;
          m = re.exec(src);
          continue;
        }
      }
      items.push('\n');
      pos = sp + 1;
    }
    re.lastIndex = pos;
    m = re.exec(src);
  }
  let out = '';
  for (const it of items) out += it;
  return out;
}

// ---------- block parsing ----------

const BLOCK_TAGS = new Set(
  ('address article aside base basefont blockquote body caption center col ' +
   'colgroup dd details dialog dir div dl dt fieldset figcaption figure ' +
   'footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe ' +
   'legend li link main menu menuitem nav noframes ol optgroup option p param ' +
   'search section summary table tbody td tfoot th thead title tr track ul')
  .split(' '));

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// [columns of leading whitespace, index where it ends]
function leadingWS(s) {
  let cols = 0, i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) { cols += 4 - (cols % 4); i++; }
    else break;
  }
  return [cols, i];
}

// Expand the leading whitespace run of s into spaces, each tab advancing
// to the next multiple of 4 from column 0 (marked's J() with offset 0).
function expandLeadingWS(s) {
  let i = 0, col = 0, out = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) { const adv = 4 - (col % 4); out += ' '.repeat(adv); col += adv; i++; }
    else break;
  }
  return out + s.slice(i);
}

// Strip `indent` columns of list-item indent from s the way marked does:
// expand the leading whitespace from column 0, then drop that many
// characters (a tab straddling the boundary becomes spaces, never a tab).
function stripItemIndent(s, indent) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  if (i < s.length && s.charCodeAt(i) === 9) return expandLeadingWS(s).slice(indent);
  return s.slice(indent);
}

// Remove `cols` columns of indent from the start of s (a tab that would
// overshoot becomes spaces).
function stripIndentCols(s, cols) {
  let c = 0, i = 0;
  while (i < s.length && c < cols) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { c++; i++; }
    else if (ch === 9) {
      const adv = 4 - (c % 4);
      if (c + adv <= cols) { c += adv; i++; }
      else return ' '.repeat(c + adv - cols) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

// Return the substring of s starting at column `target` (every character
// occupies one column except a tab, which advances to the next multiple
// of 4; a tab straddling the boundary becomes spaces).
function sliceAtCol(s, target) {
  let c = 0, i = 0;
  while (i < s.length && c < target) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { c++; i++; }
    else if (ch === 9) {
      const adv = 4 - (c % 4);
      if (c + adv <= target) { c += adv; i++; }
      else return ' '.repeat(c + adv - target) + s.slice(i + 1);
    } else { c++; i++; }
  }
  return s.slice(i);
}

// Match a block quote marker at the start of s (up to 3 spaces, then >,
// then whitespace). Marked expands the whitespace after '>' with tabs
// advancing to the next multiple of 4 from the marker column, then drops
// one space. Returns the remainder or null.
function matchQuote(s) {
  const [cols, i] = leadingWS(s);
  if (cols > 3) return null;
  if (i >= s.length || s.charCodeAt(i) !== 62) return null;
  let j = i + 1;
  if (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) {
    let k = j, col = i + 1, out = '';
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 32) { out += ' '; col++; k++; }
      else if (c === 9) { const adv = 4 - (col % 4); out += ' '.repeat(adv); col += adv; k++; }
      else break;
    }
    if (out.length > 0) out = out.slice(1);
    return out + s.slice(k);
  }
  return s.slice(j);
}

// ATX heading: returns {level, content} or null. Content has leading and
// trailing whitespace and closing hashes removed.
function matchAtx(s) {
  const [cols, i] = leadingWS(s);
  if (cols > 3) return null;
  let j = i, level = 0;
  while (j < s.length && s.charCodeAt(j) === 35) { level++; j++; }
  if (level === 0 || level > 6) return null;
  if (j < s.length && s.charCodeAt(j) !== 32 && s.charCodeAt(j) !== 9) return null;
  let content = s.slice(j).replace(/[ \t]+$/, '');
  // closing sequence of #s preceded by whitespace (checked before the
  // leading whitespace is stripped, so "### ###" closes to empty)
  const m = /[ \t]+#+$/.exec(content);
  if (m) content = content.slice(0, m.index).replace(/[ \t]+$/, '');
  content = content.replace(/^[ \t]+/, '');
  return { level, content };
}

// Fenced code start: returns {ch, len, info, indent} or null. indent is
// the leading whitespace of the fence line in columns; content lines have
// up to that many columns stripped.
function matchFence(s) {
  const [cols, i] = leadingWS(s);
  if (cols > 3) return null;
  if (i >= s.length) return null;
  const ch = s.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return null;
  let j = i, len = 0;
  while (j < s.length && s.charCodeAt(j) === ch) { len++; j++; }
  if (len < 3) return null;
  let info = s.slice(j).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (ch === 96 && info.indexOf('`') >= 0) return null;
  // info string: first word, backslash escapes decoded
  const sp = info.search(/[ \t]/);
  if (sp >= 0) info = info.slice(0, sp);
  info = unescapeBackslashes(info);
  return { ch, len, info, indent: cols };
}

// Thematic break: 3+ of the same -, _, * with optional spaces.
function matchHr(s) {
  const [cols, i] = leadingWS(s);
  if (cols > 3) return null;
  if (i >= s.length) return null;
  const ch = s.charCodeAt(i);
  if (ch !== 45 && ch !== 95 && ch !== 42) return null;
  let count = 0;
  for (let j = i; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return null;
  }
  return count >= 3;
}

// Setext underline: returns 1 for =, 2 for -, or 0. The marker run must
// be contiguous (no internal whitespace).
function matchSetext(s) {
  const [cols, i] = leadingWS(s);
  if (cols > 3) return 0;
  if (i >= s.length) return 0;
  const ch = s.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return 0;
  const rest = s.slice(i).replace(/[ \t]+$/, '');
  for (let j = 0; j < rest.length; j++) {
    if (rest.charCodeAt(j) !== ch) return 0;
  }
  return ch === 61 ? 1 : 2;
}

// List item start: returns {ordered, start, delim, bullet,
// contentIndent, content} or null. contentIndent is the absolute column
// count a continuation line must reach; content is the first line with
// that many columns stripped (so with 5+ spaces after the marker the
// content keeps its extra indentation).
function matchListItem(s) {
  const [cols, i] = leadingWS(s);
  if (cols > 3) return null;
  let j = i;
  const c0 = s.charCodeAt(j);
  let ordered = false, start = 0, delim = '', bullet = '';
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    bullet = s[j];
    j++;
  } else if (isDigitCh(c0)) {
    let k = j, num = 0, digits = 0;
    while (k < s.length && isDigitCh(s.charCodeAt(k)) && digits < 10) {
      num = num * 10 + (s.charCodeAt(k) - 48);
      k++; digits++;
    }
    if (digits === 0 || digits > 9) return null;
    if (k >= s.length) return null;
    const d = s.charCodeAt(k);
    if (d !== 46 && d !== 41) return null;
    if (digits === 10) return null; // a run of 10 digits is not a marker
    ordered = true;
    start = num;
    delim = s[k];
    j = k + 1;
  } else {
    return null;
  }
  const markerLen = j - i;
  // whitespace after the marker
  if (j >= s.length) {
    return {
      ordered, start, delim, bullet,
      contentIndent: cols + markerLen + 1, content: '', blankFirst: true
    };
  }
  const wc = s.charCodeAt(j);
  if (wc !== 32 && wc !== 9) return null;
  let wcols = 0, k = j;
  let col = cols + markerLen;
  let wsExp = '';
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 32) { wcols++; col++; wsExp += ' '; k++; }
    else if (c === 9) { const adv = 4 - (col % 4); wcols += adv; col += adv; wsExp += ' '.repeat(adv); k++; }
    else break;
  }
  if (wcols === 0) return null;
  let contentIndent;
  if (wcols >= 5) contentIndent = cols + markerLen + 1;
  else contentIndent = cols + markerLen + wcols;
  // with 5+ spaces after the marker the content keeps the extra
  // indentation (the whitespace is tab-expanded first, marked's J())
  let content = wcols >= 5 ? wsExp.slice(1) + s.slice(k) : s.slice(k);
  // an item with no content on the marker line takes the standard
  // indent (marker + one space), not the trailing whitespace
  if (content.trim() === '') {
    contentIndent = cols + markerLen + 1;
    content = '';
  }
  return {
    ordered, start, delim, bullet, contentIndent, content,
    blankFirst: content === ''
  };
}

// Split a table row into cells on unescaped | outside code spans.
function splitTableRow(row) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = row.length;
  while (i < n) {
    const c = row.charCodeAt(i);
    if (c === 92 && i + 1 < n && row.charCodeAt(i + 1) === 124) {
      cur += '|';
      i += 2;
      continue;
    }
    if (c === 96) {
      // code span: skip to the matching run
      let run = 1;
      while (i + run < n && row.charCodeAt(i + run) === 96) run++;
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (row.charCodeAt(j) === 96) {
          let r2 = 1;
          while (j + r2 < n && row.charCodeAt(j + r2) === 96) r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else j++;
      }
      if (found < 0) {
        // unclosed code span: the backticks are literal and do not stop
        // the cell from being split on a later |
        cur += row.slice(i, i + run);
        i += run;
      } else {
        // a \| inside the code span is an escaped pipe: it becomes a
        // literal | in the cell (so the code span renders "a | b")
        cur += row.slice(i, found + run).replace(/\\\|/g, '|');
        i = found + run;
      }
      continue;
    }
    if (c === 124) {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += row[i];
    i++;
  }
  cells.push(cur);
  // strip one leading and one trailing empty cell from outer pipes
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// Parse a table delimiter row. Returns an array of alignments
// ('left'|'right'|'center'|null) or null.
function parseDelimiterRow(row) {
  const [cols] = leadingWS(row);
  if (cols > 3) return null;
  const cells = splitTableRow(row);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    if (m[1] === ':' && m[2] === ':') aligns.push('center');
    else if (m[1] === ':') aligns.push('left');
    else if (m[2] === ':') aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

// Skip spaces/tabs on one line starting at j.
function skipWSOnLine(s, j) {
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  return j;
}

// Parse a link title starting at lines[li][k]; it may span lines.
// Returns {title, endLine, endPos} or null.
function parseTitleMulti(lines, li, k) {
  const first = lines[li];
  const tc = first.charCodeAt(k);
  const closer = tc === 40 ? 41 : tc;
  let depth = tc === 40 ? 1 : 0;
  let content = '';
  let p = k + 1;
  let cur = li;
  while (cur < lines.length) {
    const s = lines[cur];
    while (p < s.length) {
      const c = s.charCodeAt(p);
      if (c === 92 && p + 1 < s.length && isAsciiPunct(s.charCodeAt(p + 1))) {
        content += s[p + 1];
        p += 2;
        continue;
      }
      if (tc === 40) {
        if (c === 40) { depth++; content += s[p]; p++; continue; }
        if (c === 41) {
          depth--;
          if (depth === 0) return { title: content, endLine: cur, endPos: p + 1 };
          content += s[p]; p++; continue;
        }
      } else if (c === closer) {
        return { title: content, endLine: cur, endPos: p + 1 };
      }
      content += s[p];
      p++;
    }
    cur++;
    if (cur >= lines.length) return null;
    content += '\n';
    p = 0;
  }
  return null;
}

// Parse a link reference definition starting at lines[idx].
// Returns {label, dest, title, nextLine} or null.
function parseRefDef(lines, idx) {
  const line = lines[idx];
  const [cols, i] = leadingWS(line);
  if (cols > 3) return null;
  if (i >= line.length || line.charCodeAt(i) !== 91) return null;
  const close = findLinkEnd(line, i);
  if (close < 0) return null;
  const label = line.slice(i + 1, close);
  if (label.length === 0 || label.length > 999) return null;
  // ref labels may not contain unescaped [ or ] (marked's `le` pattern)
  if (hasUnescapedBracket(label)) return null;
  let j = skipWSOnLine(line, close + 1);
  if (j >= line.length || line.charCodeAt(j) !== 58) return null;
  j++;
  j = skipWSOnLine(line, j);
  // the destination may be on this line or the next one (a continuation
  // line of the paragraph; its indentation is not limited)
  let destLine = idx;
  let dline = line;
  let k = j;
  if (k >= line.length) {
    if (idx + 1 >= lines.length) return null;
    const nl = lines[idx + 1];
    const [, ni] = leadingWS(nl);
    if (ni >= nl.length) return null;
    destLine = idx + 1;
    dline = nl;
    k = ni;
  }
  let dest, bracketed = false, destEnd;
  if (dline.charCodeAt(k) === 60) {
    let p = k + 1;
    let ok = false;
    while (p < dline.length) {
      const c = dline.charCodeAt(p);
      if (c === 62) { ok = true; break; }
      if (c === 10 || c === 60) break;
      p++;
    }
    if (!ok) return null;
    dest = unescapeBackslashes(dline.slice(k + 1, p));
    bracketed = true;
    destEnd = p + 1;
  } else {
    let depth = 0, p = k;
    while (p < dline.length) {
      const c = dline.charCodeAt(p);
      if (c === 32 || c === 9) break;
      if (c === 92 && p + 1 < dline.length && isAsciiPunct(dline.charCodeAt(p + 1))) { p += 2; continue; }
      if (c === 40) { depth++; p++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; p++; continue;
      }
      p++;
    }
    if (p === k || depth !== 0) return null;
    dest = unescapeBackslashes(dline.slice(k, p));
    destEnd = p;
  }
  let title = null;
  let nextLine = destLine + 1;
  // the title may be on the destination line or the following line, and
  // may span lines
  let tl = dline, tp = skipWSOnLine(dline, destEnd), tli = destLine;
  if (tp >= tl.length) {
    if (destLine + 1 < lines.length) {
      const nl = lines[destLine + 1];
      const [, ni] = leadingWS(nl);
      if (ni < nl.length) { tl = nl; tp = ni; tli = destLine + 1; }
    }
  }
  if (tp < tl.length) {
    const tc = tl.charCodeAt(tp);
    const onDestLine = tli === destLine;
    if (tc !== 34 && tc !== 39 && tc !== 40) {
      // not a title: on the destination line that is junk after the
      // dest (invalid refdef); on a following line it is just text
      if (onDestLine) return null;
    } else if (tc === 40 && bracketed) {
      if (onDestLine) return null; // no (title) after <dest>
    } else {
      const t = parseTitleMulti(lines, tli, tp);
      if (t) {
        const e = skipWSOnLine(lines[t.endLine], t.endPos);
        if (e >= lines[t.endLine].length) {
          title = t.title;
          nextLine = t.endLine + 1;
        } else if (onDestLine) return null;
      } else if (onDestLine) return null;
    }
  }
  return { label, dest, title, nextLine };
}

// Classify the HTML block (if any) starting on the given line (already
// container-stripped). Returns {type, closeTag} with type 1-7, or null.
// Type 1 script/pre/style/textarea, 2 comment, 3 pi, 4 declaration,
// 5 CDATA, 6 block tag, 7 a complete tag alone on the line.
function htmlBlockType(first) {
  const [cols, i] = leadingWS(first);
  if (cols > 3) return null;
  const rest = first.slice(i);
  let type = 0;
  let closeTag = '';
  if (/^<(script|pre|style|textarea)(?:[\s>]|$)/i.test(rest)) {
    type = 1;
    closeTag = rest.slice(1).split(/[\s>]/)[0].toLowerCase();
  } else if (rest.startsWith('<!--')) type = 2;
  else if (rest.startsWith('<?')) type = 3;
  else if (/^<![A-Z]/.test(rest)) type = 4;
  else if (rest.startsWith('<![CDATA[')) type = 5;
  else {
    // type 6: a block tag name followed by whitespace, >, /> or end of line
    const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s/>]|$)/.exec(rest);
    if (!m) return null;
    if (BLOCK_TAGS.has(m[1].toLowerCase())) {
      type = 6;
    } else {
      // type 7: a complete open/closing tag alone on the line
      const tag = matchInlineHtml(first, i);
      if (!tag) return null;
      if (first.slice(tag.end).trim() !== '') return null;
      type = 7;
    }
  }
  return { type, closeTag };
}

// Consume an HTML block whose first (already container-stripped) line is
// `first`. getLine(j) returns the stripped line j (or null when it does not
// belong to the current containers); rawLineAt(j) is the raw source line.
// Returns {text, next} where next is the index of the first line after the
// block, or null when no HTML block starts.
//
// Line gathering: the first continuation line must match the containers.
// Once at least one continuation line has been taken, a later line that
// does not match the containers is still taken when it is a lazy line
// (not blank, not starting a block), used verbatim. Types 6/7 end at the
// first blank line; types 1-5 end at their closing marker (which may be
// on the first line).
// Trailing newline: the text gets one trailing "\n" unless the block
// ended at a blank line, ended because the next line does not belong to
// the containers, or ended at EOF without a trailing newline in the input.
function consumeHtmlBlock(first, getLine, rawLineAt, li, total, endsWithNewline) {
  const t = htmlBlockType(first);
  if (!t) return null;
  const type = t.type;
  const closeTag = t.closeTag;
  const endRe = type === 1 ? new RegExp('</' + closeTag + '>', 'i') : null;
  function hasEnd(line) {
    if (type === 1) return endRe.test(line);
    if (type === 2) return line.indexOf('-->') >= 0;
    if (type === 3) return line.indexOf('?>') >= 0;
    if (type === 4) return line.indexOf('>') >= 0;
    if (type === 5) return line.indexOf(']]>') >= 0;
    return false;
  }
  const blockLines = [first];
  let j = li + 1;
  if (type <= 5 && hasEnd(first)) {
    // the closing marker is already on the first line
  } else {
    for (;;) {
      if (j >= total) break;
      const line = getLine(j);
      if (line !== null) {
        if (type >= 6 && isBlankLine(line)) break;
        blockLines.push(line);
        j++;
        if (type <= 5 && hasEnd(line)) break;
        continue;
      }
      // the line does not belong to the containers: take it only as a
      // lazy line, and only once the block already has a continuation
      if (blockLines.length < 2) break;
      const raw = rawLineAt(j);
      if (!isLazyLine(raw)) break;
      blockLines.push(raw);
      j++;
      if (type <= 5 && hasEnd(raw)) break;
    }
  }
  let trailingNL;
  if (j >= total) {
    trailingNL = endsWithNewline;
  } else {
    const nextLine = getLine(j);
    trailingNL = nextLine !== null && !isBlankLine(nextLine);
  }
  let text = blockLines.join('\n');
  if (trailingNL) text += '\n';
  return { text, next: j };
}

// Consume a fenced code block. `fence` was matched on the first line;
// getLine(j) gives the stripped later lines, rawLineAt(j) the raw line.
// The first content line must match the containers; later lines may be
// lazy lines. The closing fence must match the containers. One trailing
// blank content line is dropped (it is the line ending before the fence).
function consumeFence(fence, getLine, rawLineAt, li, total) {
  let j = li + 1;
  const closeRe = new RegExp(
    '^ {0,3}' + (fence.ch === 96 ? '`' : '~') + '{' + fence.len + ',}[ \\t]*$');
  const out = [];
  let closed = false;
  while (j < total) {
    const line = getLine(j);
    if (line !== null) {
      if (closeRe.test(line)) { closed = true; break; }
      out.push(fence.indent > 0 ? stripIndentCols(line, fence.indent) : line);
      j++;
      continue;
    }
    if (out.length === 0) break;
    const raw = rawLineAt(j);
    if (!isLazyLine(raw)) break;
    out.push(raw);
    j++;
  }
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return { lines: out, next: closed ? j + 1 : j };
}

// Consume an indented code block whose first (stripped) line is `first`
// (it has >= 4 columns of indent).
function consumeIndentedCode(first, getLine, li, total) {
  const out = [stripIndentCols(first, 4)];
  let j = li + 1;
  let pending = [];
  while (j < total) {
    const line = getLine(j);
    if (line === null) break;
    if (isBlankLine(line)) { pending.push(stripIndentCols(line, 4)); j++; continue; }
    const [cols] = leadingWS(line);
    if (cols < 4) break;
    for (const b of pending) out.push(b);
    pending = [];
    out.push(stripIndentCols(line, 4));
    j++;
  }
  return { lines: out, next: j };
}

// Build a table node from a header line and a delimiter line. bodyStart is
// the index of the first body row. Returns {node, next} or null.
function makeTable(header, delimLine, bodyStart, getLine, total) {
  const aligns = parseDelimiterRow(delimLine);
  if (!aligns) return null;
  const head = splitTableRow(header);
  if (head.length !== aligns.length) return null;
  const rows = [];
  let j = bodyStart;
  while (j < total) {
    const line = getLine(j);
    if (line === null || isBlankLine(line)) break;
    if (startsBlock(line)) break;
    rows.push(splitTableRow(line));
    j++;
  }
  return { node: { t: 'table', aligns, head, rows }, next: j };
}

// Does this line start a block that interrupts a table's body rows?
function startsBlock(line) {
  const [cols, i] = leadingWS(line);
  if (cols > 3) return false;
  if (i >= line.length) return false;
  const c = line.charCodeAt(i);
  if (c === 35) return true; // ATX heading
  if (c === 62) return true; // block quote
  if (c === 96 || c === 126) {
    // fenced code
    let k = i, len = 0;
    while (k < line.length && line.charCodeAt(k) === c) { len++; k++; }
    if (len >= 3) return true;
  }
  if (c === 60) {
    // html block start (a real block tag, comment, pi, declaration, CDATA)
    if (htmlBlockType(line) !== null) return true;
  }
  if (c === 45 || c === 43 || c === 42) {
    // list marker or thematic break (a bare "-foo" is paragraph text)
    return matchListItem(line) !== null || matchHr(line);
  }
  if (c === 95) return matchHr(line); // "_" thematic break
  if (isDigitCh(c)) return matchListItem(line) !== null;
  return false;
}

// A "lazy" continuation line: not blank, and does not start a block.
// Used for HTML-block and fenced-code continuation lines that do not
// match the open containers (list items / block quotes).
function isLazyLine(raw) {
  if (isBlankLine(raw)) return false;
  const [cols] = leadingWS(raw);
  if (cols >= 4) return false; // indented code
  return !startsBlock(raw);
}

// Would this line interrupt an open paragraph if it started a new block?
// A list item interrupts only when its first item is non-empty and it is
// a bullet list or an ordered list starting at 1.
function interruptsPara(line) {
  if (matchAtx(line)) return true;
  if (matchFence(line)) return true;
  if (matchHr(line)) return true;
  if (matchQuote(line) !== null) return true;
  if (htmlBlockType(line) !== null) return true;
  const lm = matchListItem(line);
  if (lm) return lm.content.trim() !== '' && (lm.bullet !== '' || lm.start === 1);
  return false;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Two list items belong to the same list when both are bullets with the
// same marker, or both are ordered with the same delimiter.
function sameListType(list, lm) {
  if (list.ordered !== lm.ordered) return false;
  if (lm.ordered) return list.delim === lm.delim;
  return list.marker === lm.bullet;
}

function parseBlocks(src) {
  const norm = src.replace(/\r\n?/g, '\n');
  const endsWithNewline = norm.endsWith('\n');
  let lines = norm.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const refs = new Map();
  const doc = { t: 'doc', children: [] };
  const stack = [doc];
  let para = null;
  let pendingBlank = false;

  function container() { return stack[stack.length - 1]; }

  // The line at index, with the open containers' markers stripped, or null
  // when it does not belong to the current containers.
  function lineAt(index) {
    let cur = lines[index];
    for (let si = 1; si < stack.length; si++) {
      const b = stack[si];
      if (b.t === 'quote') {
        const m = matchQuote(cur);
        if (m === null) return null;
        cur = m;
      } else if (b.t === 'item') {
        if (isBlankLine(cur)) cur = '';
        else {
          const [cols] = leadingWS(cur);
          if (cols < b.contentIndent) return null;
          cur = stripItemIndent(cur, b.contentIndent);
        }
      }
    }
    return cur;
  }
  const getLine = (j) => lineAt(j);
  const rawLineAt = (j) => lines[j];

  function extractRefDefs(ls) {
    let idx = 0;
    while (idx < ls.length) {
      const def = parseRefDef(ls, idx);
      if (!def) break;
      const key = normalizeLabel(def.label);
      if (!refs.has(key)) refs.set(key, { dest: def.dest, title: def.title });
      idx = def.nextLine;
    }
    return idx;
  }

  function closePara() {
    if (!para) return;
    const n = extractRefDefs(para.lines);
    if (n > 0) para.lines.splice(0, n);
    if (para.lines.length === 0) {
      const p = para.parent;
      const ci = p.children.indexOf(para);
      if (ci >= 0) p.children.splice(ci, 1);
    }
    para = null;
  }

  function finalizeList(list) {
    list.tight = !list.hadBlankBetween && !list.children.some((it) => it.hadBlank);
  }

  // Append a block to the current container. A blank line followed by a
  // block directly inside an item makes that item loose.
  function addBlock(node) {
    const parent = container();
    if (pendingBlank && parent.t === 'item') parent.hadBlank = true;
    pendingBlank = false;
    parent.children.push(node);
    return node;
  }

  function addItem(list, lm) {
    if (pendingBlank && list.children.length > 0) list.hadBlankBetween = true;
    pendingBlank = false;
    const item = { t: 'item', contentIndent: lm.contentIndent, children: [], hadBlank: false, task: null };
    list.children.push(item);
    stack.push(item);
    return item;
  }

  function openListItem(lm) {
    let list = null;
    if (container().t === 'list' && sameListType(container(), lm)) {
      list = container();
    } else {
      list = {
        t: 'list', ordered: lm.ordered, delim: lm.delim, marker: lm.bullet,
        start: lm.start, children: [], tight: true, hadBlankBetween: false
      };
      addBlock(list);
      stack.push(list);
    }
    return addItem(list, lm);
  }

  // Try to turn the open paragraph's last line plus the delimiter line
  // into a table. Returns {next} or null.
  function tryTableFromPara(delimLine, li) {
    if (para.lines.length === 0) return null;
    const headerLine = para.lines[para.lines.length - 1];
    const tab = makeTable(headerLine, delimLine, li + 1, getLine, total);
    if (!tab) return null;
    // a table is formed: drop the header line, then extract any refdefs
    // that precede it (never splice when no table forms)
    para.lines.pop();
    const n = extractRefDefs(para.lines);
    if (n > 0) para.lines.splice(0, n);
    closePara();
    addBlock(tab.node);
    return { next: tab.next };
  }

  let li = 0;
  while (li < total) {
    const rawLine = lines[li];
    // 1. match the open containers
    let cur = rawLine;
    let failAt = -1;
    for (let si = 1; si < stack.length; si++) {
      const b = stack[si];
      if (b.t === 'quote') {
        const m = matchQuote(cur);
        if (m === null) { failAt = si; break; }
        cur = m;
      } else if (b.t === 'item') {
        if (isBlankLine(cur)) cur = '';
        else {
          const [cols] = leadingWS(cur);
          if (cols < b.contentIndent) { failAt = si; break; }
          cur = stripItemIndent(cur, b.contentIndent);
        }
      }
    }
    if (failAt >= 0) {
      // lazy continuation: judged on the line after the containers that
      // DID match are stripped, so "> bar" inside a triple quote is a
      // lazy "bar", while "> bar" at the top level starts a blockquote.
      // A list-item line inside a list item is never lazy: it is a new
      // item (even an empty one, or an ordered item not starting at 1).
      const lazyListItem = para !== null && matchListItem(cur) !== null && para.parent.t === 'item';
      if (para && !isBlankLine(cur) && !interruptsPara(cur) && !lazyListItem) {
        // lazy continuation of the paragraph; a leading run of 4+
        // columns of whitespace is stripped, shorter runs are kept.
        // A line that looks like a setext underline is indented by four
        // spaces so it stays paragraph text instead of becoming a heading.
        let text = cur;
        if (matchSetext(text) > 0) {
          para.lines.push('    ' + text);
        } else {
          const [cols] = leadingWS(text);
          if (cols >= 4) text = stripIndentCols(text, 4);
          para.lines.push(text);
        }
        li++;
        continue;
      }
      closePara();
      while (stack.length > failAt) {
        const b = stack.pop();
        if (b.t === 'list') finalizeList(b);
      }
      continue;
    }
    // 2. blank line; a blank line closes an empty list item, so a later
    // indented line does not rejoin it. A whitespace-only line that had
    // a container marker stripped (e.g. ">  ") is a paragraph
    // continuation when a paragraph is open, not a blank line.
    if (isBlankLine(cur)) {
      // a whitespace-only remainder (">  " -> " ") continues the
      // paragraph; a truly empty remainder (">") is a blank line
      if (para && cur !== rawLine && cur.length > 0) {
        para.lines.push(cur);
        li++;
        continue;
      }
      closePara();
      if (container().t === 'item' && container().children.length === 0) {
        stack.pop();
      }
      pendingBlank = true;
      li++;
      continue;
    }
    // 3. a list ends when the line is not a new item of that list; a
    // thematic break wins over a list item ("* * *" is an hr, not an item)
    if (container().t === 'list') {
      const lm = matchListItem(cur);
      if (!lm || !sameListType(container(), lm) || matchHr(cur)) {
        const b = stack.pop();
        finalizeList(b);
        continue;
      }
    }
    // 4. block starts (may loop when opening containers)
    let cur2 = cur;
    for (;;) {
      if (para) {
        const se = matchSetext(cur2);
        if (se > 0) {
          const n = extractRefDefs(para.lines);
          if (n > 0) para.lines.splice(0, n);
          if (para.lines.length === 0) {
            const p = para.parent;
            const ci = p.children.indexOf(para);
            if (ci >= 0) p.children.splice(ci, 1);
            para = null;
            continue;
          }
          // a setext heading trims the leading whitespace of its first
          // line and the trailing whitespace of its last line
          const hLines = para.lines.slice();
          hLines[0] = hLines[0].replace(/^[ \t]+/, '');
          hLines[hLines.length - 1] = hLines[hLines.length - 1].replace(/[ \t]+$/, '');
          const h = { t: 'h', level: se, lines: hLines };
          const p = para.parent;
          p.children[p.children.indexOf(para)] = h;
          para = null;
          break;
        }
        const atx = matchAtx(cur2);
        if (atx) { closePara(); addBlock({ t: 'h', level: atx.level, lines: [atx.content] }); break; }
        const fence = matchFence(cur2);
        if (fence) {
          closePara();
          const f = consumeFence(fence, getLine, rawLineAt, li, total);
          addBlock({ t: 'code', info: fence.info, lines: f.lines, fenced: true });
          li = f.next - 1;
          break;
        }
        // only html block types 1-6 interrupt a paragraph; type 7 (a
        // complete tag alone on the line) does not
        const hbt = htmlBlockType(cur2);
        if (hbt !== null && hbt.type < 7) {
          const html = consumeHtmlBlock(cur2, getLine, rawLineAt, li, total, endsWithNewline);
          if (html) { closePara(); addBlock({ t: 'html', text: html.text }); li = html.next - 1; break; }
        }
        if (matchHr(cur2)) { closePara(); addBlock({ t: 'hr' }); break; }
        const tab = tryTableFromPara(cur2, li);
        if (tab) { li = tab.next - 1; break; }
        const lm = matchListItem(cur2);
        // a list item interrupts a paragraph when it is non-empty (and a
        // bullet, or an ordered list starting at 1); inside a list item
        // any list item marker (even an empty one) starts a new item
        const inList = para.parent.t === 'item';
        if (lm && (inList || (lm.content.trim() !== '' && (lm.bullet !== '' || lm.start === 1)))) {
          closePara();
          openListItem(lm);
          cur2 = lm.content;
          continue;
        }
        const qm = matchQuote(cur2);
        if (qm !== null) {
          closePara();
          const q = { t: 'quote', children: [] };
          addBlock(q);
          stack.push(q);
          cur2 = qm;
          continue;
        }
        // paragraph continuation (leading whitespace kept)
        para.lines.push(cur2);
        break;
      } else {
        const atx = matchAtx(cur2);
        if (atx) { addBlock({ t: 'h', level: atx.level, lines: [atx.content] }); break; }
        const fence = matchFence(cur2);
        if (fence) {
          const f = consumeFence(fence, getLine, rawLineAt, li, total);
          addBlock({ t: 'code', info: fence.info, lines: f.lines, fenced: true });
          li = f.next - 1;
          break;
        }
        const html = consumeHtmlBlock(cur2, getLine, rawLineAt, li, total, endsWithNewline);
        if (html) { addBlock({ t: 'html', text: html.text }); li = html.next - 1; break; }
        if (matchHr(cur2)) { addBlock({ t: 'hr' }); break; }
        const lm = matchListItem(cur2);
        if (lm) {
          openListItem(lm);
          if (lm.content.trim() === '') break;
          cur2 = lm.content;
          continue;
        }
        const qm = matchQuote(cur2);
        if (qm !== null) {
          const q = { t: 'quote', children: [] };
          addBlock(q);
          stack.push(q);
          cur2 = qm;
          continue;
        }
        const [cols] = leadingWS(cur2);
        if (cols >= 4) {
          const c = consumeIndentedCode(cur2, getLine, li, total);
          addBlock({ t: 'code', info: '', lines: c.lines, fenced: false });
          li = c.next - 1;
          break;
        }
        // a line that is blank after its containers are stripped (e.g. a
        // lone ">" line) starts no paragraph
        if (isBlankLine(cur2)) break;
        // paragraph start (leading whitespace is part of the paragraph)
        const firstLine = cur2;
        const p = { t: 'p', lines: [firstLine], parent: container() };
        addBlock(p);
        para = p;
        // task list: the item's first paragraph may start with a checkbox
        const parent = container();
        if (parent.t === 'item' && parent.children[0] === p) {
          const m = /^\[( |x|X)\][ \t]+(?=\S)/.exec(firstLine);
          if (m) {
            parent.task = m[1] === ' ' ? 'unchecked' : 'checked';
            let k = 3;
            while (k < firstLine.length && (firstLine[k] === ' ' || firstLine[k] === '\t')) k++;
            p.lines[0] = firstLine.slice(k);
          }
        }
        break;
      }
    }
    li++;
  }
  closePara();
  while (stack.length > 1) {
    const b = stack.pop();
    if (b.t === 'list') finalizeList(b);
  }
  return { doc, refs };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderInlineText(text, refs) {
  return parseInline(text, refs);
}

function renderBlock(node, refs) {
  switch (node.t) {
    case 'p':
      return '<p>' + renderInlineText(node.lines.join('\n'), refs) + '</p>\n';
    case 'h':
      return '<h' + node.level + '>' + renderInlineText(node.lines.join('\n'), refs) + '</h' + node.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      const info = node.fenced && node.info !== '' ? ' class="language-' + escapeText(node.info) + '"' : '';
      const content = node.lines.length > 0
        ? escapeAll(node.lines.join('\n')) + '\n'
        : '';
      return '<pre><code' + info + '>' + content + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'quote': {
      let s = '<blockquote>\n';
      for (const child of node.children) s += renderBlock(child, refs);
      return s + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let s = '<' + tag + start + '>\n';
      for (const item of node.children) s += renderItem(item, node.tight, refs);
      return s + '</' + tag + '>\n';
    }
    case 'table': {
      let s = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < node.head.length; i++) {
        const a = node.aligns[i];
        s += '<th' + (a ? ' align="' + a + '"' : '') + '>' +
          renderInlineText(node.head[i], refs) + '</th>\n';
      }
      s += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        s += '<tbody>';
        for (const row of node.rows) {
          s += '<tr>\n';
          for (let i = 0; i < node.head.length; i++) {
            const a = node.aligns[i];
            const cell = i < row.length ? row[i] : '';
            s += '<td' + (a ? ' align="' + a + '"' : '') + '>' +
              renderInlineText(cell, refs) + '</td>\n';
          }
          s += '</tr>\n';
        }
        s += '</tbody>';
      }
      return s + '</table>\n';
    }
    default:
      return '';
  }
}

function renderItem(item, tight, refs) {
  const taskHtml = item.task === 'checked'
    ? '<input checked="" disabled="" type="checkbox"> '
    : item.task === 'unchecked'
      ? '<input disabled="" type="checkbox"> '
      : '';
  let s = '<li>';
  for (let i = 0; i < item.children.length; i++) {
    const child = item.children[i];
    if (child.t === 'p') {
      const inner = renderInlineText(child.lines.join('\n'), refs);
      if (tight) s += (i === 0 ? taskHtml : '') + inner;
      else s += '<p>' + (i === 0 ? taskHtml : '') + inner + '</p>\n';
    } else {
      s += renderBlock(child, refs);
    }
  }
  return s + '</li>\n';
}

export function parse(markdown) {
  const { doc, refs } = parseBlocks(markdown);
  let out = '';
  for (const child of doc.children) out += renderBlock(child, refs);
  return out;
}
