function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(query, options, global = false) {
  try {
    const source = options.useRegex ? query : escapeRegex(query);
    const bounded = options.wholeWord ? `\\b(?:${source})\\b` : source;
    return new RegExp(bounded, `${options.matchCase ? "" : "i"}${global ? "g" : ""}`);
  } catch {
    return null;
  }
}

// Plain mode inserts the replacement literally; $& and $1 are special only in regex mode.
function literalOrPattern(replaceStr, options) {
  const r = replaceStr ?? "";
  return options.useRegex ? r : () => r;
}

function replaceInString(text, findQuery, replaceStr, options) {
  const re = buildRegex(findQuery, options, true);
  if (!re) return { newText: text, count: 0, error: "invalid_pattern" };
  const matches = text.match(re);
  const count = matches ? matches.length : 0;
  if (!count) return { newText: text, count: 0 };
  return { newText: text.replace(re, literalOrPattern(replaceStr, options)), count };
}

/**
 * Collect per-match line previews for Replace UI (Rider-style tree).
 * @returns {{ count: number, previews: Array<{lineNumber:number, column:number, before:string, after:string, matchLength:number}>, error?: string }}
 */
function collectReplacePreviews(text, findQuery, replaceStr, options, maxPreviews) {
  const re = buildRegex(findQuery, options, true);
  if (!re) return { count: 0, previews: [], error: "invalid_pattern" };
  const localRe = buildRegex(findQuery, options, false);
  const limit = Math.max(0, Number(maxPreviews) || 0);
  /** @type {Array<{lineNumber:number, column:number, before:string, after:string, matchLength:number}>} */
  const previews = [];
  let count = 0;
  let match = re.exec(text);
  while (match) {
    count += 1;
    if (previews.length < limit) {
      const idx = match.index;
      const beforeChunk = text.slice(0, idx);
      const lineNumber = beforeChunk.split(/\r?\n/).length;
      const nl = Math.max(beforeChunk.lastIndexOf("\n"), beforeChunk.lastIndexOf("\r"));
      const lineStart = nl + 1;
      let lineEnd = text.indexOf("\n", idx);
      if (lineEnd < 0) lineEnd = text.length;
      if (lineEnd > 0 && text[lineEnd - 1] === "\r") lineEnd -= 1;
      const line = text.slice(lineStart, lineEnd);
      const column = idx - lineStart + 1;
      const matchLength = match[0].length;
      let replacedMatch = replaceStr ?? "";
      if (localRe) {
        try {
          replacedMatch = match[0].replace(localRe, literalOrPattern(replaceStr, options));
        } catch {
          replacedMatch = replaceStr ?? "";
        }
      }
      const after =
        line.slice(0, Math.max(0, column - 1)) + replacedMatch + line.slice(Math.max(0, column - 1) + matchLength);
      previews.push({ lineNumber, column, before: line, after, matchLength });
    }
    if (!re.global) break;
    if (match[0].length === 0) {
      re.lastIndex += 1;
    }
    match = re.exec(text);
  }
  return { count, previews };
}

module.exports = { escapeRegex, buildRegex, replaceInString, collectReplacePreviews };
