const test = require("node:test");
const assert = require("node:assert");
const { replaceInString, collectReplacePreviews } = require("../replaceEngine");

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
