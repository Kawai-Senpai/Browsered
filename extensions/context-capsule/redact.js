/*
 * Redaction is a safety net, not a security model.
 *
 * Everything here runs before a value is ever written to disk or handed to an
 * agent. It is deliberately conservative: when a key or value looks remotely
 * credential-shaped we drop it rather than trying to be clever.
 *
 * This module is pure and dependency-free so it can be unit tested outside of
 * a browser. See tests/redact.test.js.
 */

export const SECRET_KEY =
  /authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|session|jwt|credential|private[-_]?key|client[-_]?secret|refresh|bearer/i;

export const SECRET_ATTR =
  /^(value|token|secret|password|authorization|cookie)$/i;

export const BODY_MIME =
  /json|text|javascript|xml|graphql|x-www-form-urlencoded/i;

export const MAX_TEXT_BYTES = 500_000;

const JWT =
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

const BEARER =
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

const KEYED_VALUE =
  /(["']?(?:token|secret|password|api[-_]?key|authorization|client[-_]?secret|refresh[-_]?token)["']?\s*[:=]\s*["'])[^"']+(["'])/gi;

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/*
 * Vendor key shapes worth catching by name. Entropy scanning covers the rest.
 */
const VENDOR_KEYS = [
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bpk_live_[A-Za-z0-9]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  /\bglpat-[0-9A-Za-z_-]{16,}\b/g
];

const EMAIL =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/*
 * Card-shaped digit runs, Luhn-checked below so that order IDs and timestamps
 * do not get mangled.
 */
const CARD =
  /\b(?:\d[ -]*?){13,19}\b/g;

/**
 * Shannon entropy in bits per character. High-entropy long strings are the
 * signature of generated credentials.
 */
export function entropy(value) {
  const text = String(value || "");

  if (!text.length) {
    return 0;
  }

  const counts = new Map();

  for (const character of text) {
    counts.set(
      character,
      (counts.get(character) || 0) + 1
    );
  }

  let bits = 0;

  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }

  return bits;
}

export function looksLikeSecret(token) {
  const text = String(token || "");

  if (text.length < 24 || text.length > 512) {
    return false;
  }

  if (!/^[A-Za-z0-9._~+/=-]+$/.test(text)) {
    return false;
  }

  if (!/\d/.test(text) || !/[A-Za-z]/.test(text)) {
    return false;
  }

  /*
   * Words and paths are long and low entropy; keys are long and high entropy.
   */
  return entropy(text) >= 3.6;
}

function luhn(digits) {
  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;

    if (double) {
      digit *= 2;

      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

/**
 * Redact a text value. Returns the cleaned text; call `redactText.report` style
 * counting via `redactTextWithReport` when you need an audit trail.
 */
export function redactText(value) {
  return redactTextWithReport(value).text;
}

export function redactTextWithReport(value) {
  const findings = [];

  if (value == null) {
    return { text: value, findings };
  }

  let text = String(value);

  const mark = (kind, count) => {
    if (count > 0) {
      findings.push({ kind, count });
    }
  };

  let count = 0;

  text = text.replace(PRIVATE_KEY_BLOCK, () => {
    count++;
    return "[REDACTED_PRIVATE_KEY]";
  });

  mark("private-key", count);

  count = 0;

  text = text.replace(BEARER, () => {
    count++;
    return "Bearer [REDACTED]";
  });

  mark("bearer-token", count);

  count = 0;

  text = text.replace(KEYED_VALUE, (_match, head, tail) => {
    count++;
    return `${head}[REDACTED]${tail}`;
  });

  mark("keyed-secret", count);

  count = 0;

  text = text.replace(JWT, (match) => {
    /*
     * Require a decodable JSON header so that version strings and minified
     * property chains survive.
     */
    const header = match.split(".")[0];

    if (!isJwtHeader(header)) {
      return match;
    }

    count++;
    return "[REDACTED_JWT]";
  });

  mark("jwt", count);

  for (const pattern of VENDOR_KEYS) {
    count = 0;

    text = text.replace(pattern, () => {
      count++;
      return "[REDACTED_API_KEY]";
    });

    mark("vendor-api-key", count);
  }

  count = 0;

  text = text.replace(CARD, (match) => {
    const digits = match.replace(/\D/g, "");

    if (digits.length < 13 || digits.length > 19) {
      return match;
    }

    if (!luhn(digits)) {
      return match;
    }

    count++;
    return "[REDACTED_CARD]";
  });

  mark("payment-card", count);

  count = 0;

  text = text.replace(EMAIL, (match) => {
    count++;
    return maskEmail(match);
  });

  mark("email", count);

  count = 0;

  /*
   * Entropy sweep last, so labelled secrets are already gone and we only look
   * at leftover bare tokens.
   */
  text = text.replace(
    /[A-Za-z0-9._~+/=-]{24,512}/g,
    (match) => {
      if (!looksLikeSecret(match)) {
        return match;
      }

      count++;
      return "[REDACTED_HIGH_ENTROPY]";
    }
  );

  mark("high-entropy", count);

  let truncated = false;

  if (text.length > MAX_TEXT_BYTES) {
    text = text.slice(0, MAX_TEXT_BYTES);
    truncated = true;
  }

  return { text, findings, truncated };
}

function isJwtHeader(segment) {
  try {
    const json = atob(
      segment.replaceAll("-", "+").replaceAll("_", "/")
    );

    const parsed = JSON.parse(json);

    return Boolean(parsed && parsed.alg);
  } catch {
    return false;
  }
}

function maskEmail(address) {
  const [local, domain] = address.split("@");

  const head = local.slice(0, 1);

  return `${head}${"*".repeat(
    Math.max(1, local.length - 1)
  )}@${domain}`;
}

export function redactHeaders(headers) {
  const output = {};

  for (const [key, value] of Object.entries(headers || {})) {
    output[key] = SECRET_KEY.test(key)
      ? "[REDACTED]"
      : redactText(String(value));
  }

  return output;
}

export function stringifySafe(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function sanitizeValue(value, depth = 0) {
  if (depth > 7) {
    return "[MAX_DEPTH]";
  }

  if (
    value == null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 200)
      .map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const output = {};

    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      output[key] = SECRET_KEY.test(key)
        ? "[REDACTED]"
        : sanitizeValue(item, depth + 1);
    }

    return output;
  }

  return String(value);
}

/*
 * Markers the redaction pass leaves behind. Counting them tells the user what
 * was removed, which is the honest version of a review screen: we report what
 * we took out, not a promise that nothing sensitive remains.
 */
const MARKERS = {
  "[REDACTED]": "credential-shaped key",
  "[REDACTED_JWT]": "JWT",
  "[REDACTED_API_KEY]": "vendor API key",
  "[REDACTED_PRIVATE_KEY]": "private key block",
  "[REDACTED_CARD]": "payment card number",
  "[REDACTED_HIGH_ENTROPY]": "high-entropy token",
  "[BINARY BODY OMITTED]": "binary response body",
  "[MAX_DEPTH]": "truncated deep object"
};

/**
 * Scan a finished capsule file list so the panel can show a review screen and
 * the capsule can carry a redaction report.
 *
 * `removed`  - what redaction already stripped, counted from its markers.
 * `residual` - what a second, independent pass still finds. This should be
 *              empty; anything here is a leak and must block a silent export.
 */
export function scanForReview(files) {
  const removed = new Map();
  const residual = new Map();

  let scannedBytes = 0;
  let textFiles = 0;

  const bump = (map, kind, count, path) => {
    const current = map.get(kind) || {
      kind,
      count: 0,
      files: []
    };

    current.count += count;

    if (!current.files.includes(path)) {
      current.files.push(path);
    }

    map.set(kind, current);
  };

  for (const file of files) {
    if (file.encoding !== "utf8") {
      continue;
    }

    textFiles++;
    scannedBytes += file.data.length;

    for (const [marker, label] of Object.entries(MARKERS)) {
      const count = file.data.split(marker).length - 1;

      if (count > 0) {
        bump(removed, label, count, file.path);
      }
    }

    /*
     * Strip the markers first so we do not rediscover our own output.
     */
    const cleaned = Object.keys(MARKERS).reduce(
      (text, marker) => text.replaceAll(marker, ""),
      file.data
    );

    for (const finding of
      redactTextWithReport(cleaned).findings) {
      bump(
        residual,
        finding.kind,
        finding.count,
        file.path
      );
    }
  }

  return {
    scannedBytes,
    textFiles,
    removed: Array.from(removed.values()),
    residual: Array.from(residual.values())
  };
}
