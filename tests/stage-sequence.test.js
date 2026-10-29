const assert = require("node:assert/strict");
const test = require("node:test");
const {
  acetonitrileToMethanolMappings,
  convertAcetonitrilePercentToMethanol,
  evaluateOrderedSequence,
  targetWasMet,
  uniqueDescendingPercentages
} = require("../stage-sequence.js");

const required = [100, 90, 80, 70, 60, 50, 40];

function run(percentB, peakCount = 3, extra = {}) {
  return {
    percentB,
    peakCount,
    lastPeakRetention: 5,
    totalTime: 6,
    ...extra
  };
}

test("requires actual ambient results in descending 100-to-40 order", () => {
  const outOfStart = evaluateOrderedSequence(required, [run(90)]);
  assert.equal(outOfStart.complete, false);
  assert.equal(outOfStart.nextPercentB, 100);

  const predictedOnly = evaluateOrderedSequence(required, [
    run(100),
    { ...run(90), isSuggested: true }
  ]);
  assert.equal(predictedOnly.complete, false);
  assert.equal(predictedOnly.nextPercentB, 90);

  const actual = evaluateOrderedSequence(required, required.map(value => run(value)));
  assert.equal(actual.complete, true);
  assert.equal(actual.matchedRuns.length, 7);
  assert.equal(actual.matchedRuns[0].percentB, 100);
  assert.equal(actual.matchedRuns.at(-1).percentB, 40);
});

test("does not count missing measured peak or retention results as completed tests", () => {
  const result = evaluateOrderedSequence([100, 90], [
    run(100, null),
    run(90, 3, { lastPeakRetention: null, totalTime: null })
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.nextPercentB, 100);
});

test("an out-of-order result does not satisfy the required sequence", () => {
  const result = evaluateOrderedSequence([100, 90, 80], [
    run(90),
    run(100),
    run(80)
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.nextPercentB, 90);
});

test("selectivity replay values contain only actual results and are descending", () => {
  const values = uniqueDescendingPercentages([
    run(40),
    run(70),
    run(50),
    run(60),
    { ...run(100), isSuggested: true },
    run(90, 4, { lastPeakRetention: null, totalTime: null })
  ]);
  assert.deepEqual(values, [70, 60, 50, 40]);
});

test("converts ACN %B to MeOH by ten points and excludes values outside 0–100", () => {
  assert.equal(convertAcetonitrilePercentToMethanol(20), 30);
  assert.equal(convertAcetonitrilePercentToMethanol(90), 100);
  assert.equal(convertAcetonitrilePercentToMethanol(100), null);
  assert.equal(convertAcetonitrilePercentToMethanol(-1), null);
  assert.equal(convertAcetonitrilePercentToMethanol(Number.NaN), null);
  assert.deepEqual(acetonitrileToMethanolMappings([100, 90, 20]), {
    mappings: [
      { acetonitrilePercentB: 90, methanolPercentB: 100 },
      { acetonitrilePercentB: 20, methanolPercentB: 30 }
    ],
    excluded: [{ acetonitrilePercentB: 100, methanolPercentB: 110 }]
  });
});

test("stops stage progression when an actual run meets the peak target", () => {
  assert.equal(targetWasMet([run(80, 6)], 7), false);
  assert.equal(targetWasMet([run(80, 7)], 7), true);
  assert.equal(targetWasMet([{ ...run(80, 7), isSuggested: true }], 7), false);
});
