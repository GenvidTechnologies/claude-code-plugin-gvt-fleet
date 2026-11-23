// Finds what JSON.parse followed by JSON.stringify would change silently in a
// JSON text: a repeated object key (the last value wins) and a number that
// does not survive a round trip through a double. Pure, no imports.
// Call it only after JSON.parse(text) has succeeded: the result is meaningful
// only for valid JSON. On text that is not valid JSON it still returns (every
// scanning loop is bounded by text.length) but the result is unspecified: null
// or a hit.

// sign, significant digits (no leading or trailing zeros) and a decimal exponent.
function normaliseDecimal(s) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (m === null) return null;
  const frac = m[3] ?? '';
  let digits = (m[2] + frac).replace(/^0+/, '');
  let exp = Number(m[4] ?? 0) - frac.length;
  const trimmed = digits.replace(/0+$/, '');
  exp += digits.length - trimmed.length;
  digits = trimmed;
  return digits === '' ? `${m[1]}0` : `${m[1]}${digits}e${exp}`;
}

function isLossyNumber(token) {
  const n = Number(token);
  if (!Number.isFinite(n)) return true;
  // String(-0) is "0", so a negative zero compares unequal on the sign.
  return normaliseDecimal(token) !== normaliseDecimal(String(n));
}

export function findLossyJson(text) {
  let i = 0;
  const lineAt = (pos) => {
    let line = 1;
    for (let k = 0; k < pos; k += 1) if (text.charCodeAt(k) === 10) line += 1;
    return line;
  };
  const skipWs = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i += 1;
  };
  const readString = () => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return { raw: text.slice(start, i), start };
  };

  function value() {
    skipWs();
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') {
      readString();
      return null;
    }
    const start = i;
    while (i < text.length && !' \t\n\r,]}'.includes(text[i])) i += 1;
    const token = text.slice(start, i);
    if (/^-?\d/.test(token) && isLossyNumber(token)) return { kind: 'number', token, line: lineAt(start) };
    return null;
  }

  function array() {
    i += 1;
    skipWs();
    if (text[i] === ']') {
      i += 1;
      return null;
    }
    while (i < text.length) {
      const hit = value();
      if (hit !== null) return hit;
      skipWs();
      i += 1; // ',' or ']'
      if (text[i - 1] === ']') return null;
    }
    return null;
  }

  function object() {
    i += 1;
    const seen = new Set();
    skipWs();
    if (text[i] === '}') {
      i += 1;
      return null;
    }
    while (i < text.length) {
      skipWs();
      const { raw, start } = readString();
      let key;
      try {
        key = JSON.parse(raw);
      } catch {
        return null; // not valid JSON
      }
      if (seen.has(key)) return { kind: 'duplicate-key', token: key, line: lineAt(start) };
      seen.add(key);
      skipWs();
      i += 1; // ':'
      const hit = value();
      if (hit !== null) return hit;
      skipWs();
      i += 1; // ',' or '}'
      if (text[i - 1] === '}') return null;
    }
    return null;
  }

  return value();
}
