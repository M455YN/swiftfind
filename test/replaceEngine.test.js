const test = require("node:test");
const assert = require("node:assert");
const { replaceInString, collectReplacePreviews, decodeUtf8Strict, endPosition } = require("../replaceEngine");

test("plain mode treats regex chars and $ literally", () => {
  const r = replaceInString("a.b a.b", "a.b", "$&-$1", { matchCase: true });
  assert.deepStrictEqual(r, { newText: "$&-$1 $&-$1", count: 2 });
});

test("regex mode supports capture groups", () => {
  const r = replaceInString("foo1 foo2", "foo([0-9])", "bar$1", { useRegex: true, matchCase: true });
  assert.strictEqual(r.newText, "bar1 bar2");
});

test("whole word and case", () => {
  assert.strictEqual(replaceInString("cat concat Cat", "cat", "x", { wholeWord: true }).newText, "x concat x");
  assert.strictEqual(replaceInString("cat Cat", "cat", "x", { matchCase: true }).count, 1);
});

test("invalid regex reports error, no change", () => {
  const r = replaceInString("abc", "(", "x", { useRegex: true });
  assert.strictEqual(r.error, "invalid_pattern");
  assert.strictEqual(r.newText, "abc");
});

test("CRLF previews give per-line positions", () => {
  const p = collectReplacePreviews("one\r\ntwo foo\r\n", "foo", "bar", { matchCase: true }, 5);
  assert.deepStrictEqual(p.previews, [{ lineNumber: 2, column: 5, before: "two foo", after: "two bar", matchLength: 3 }]);
});

test("empty regex match terminates", () => {
  assert.strictEqual(collectReplacePreviews("ab", "x*", "-", { useRegex: true }, 10).count, 3);
});

test("decodeUtf8Strict accepts UTF-8 (BOM dropped), rejects cp1250, UTF-16 and binary", () => {
  assert.strictEqual(decodeUtf8Strict(Buffer.from("zażółć")), "zażółć");
  assert.strictEqual(decodeUtf8Strict(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a")])), "a");
  assert.strictEqual(decodeUtf8Strict(Buffer.from([0x7a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6])), null);
  assert.strictEqual(decodeUtf8Strict(Buffer.from("ab", "utf16le")), null);
  assert.strictEqual(decodeUtf8Strict(Buffer.from([0x61, 0x00, 0x62])), null);
});

test("endPosition follows LF, CRLF and CR line breaks", () => {
  assert.deepStrictEqual(endPosition(""), { line: 0, character: 0 });
  assert.deepStrictEqual(endPosition("ab\r\ncde"), { line: 1, character: 3 });
  assert.deepStrictEqual(endPosition("a\nb\n"), { line: 2, character: 0 });
  assert.deepStrictEqual(endPosition("a\rbc"), { line: 1, character: 2 });
});
