(function (root, factory) {
  const sequence = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = sequence;
  if (root) root.HplcStageSequence = sequence;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  const samePercent = (left, right) =>
    Number.isFinite(Number(left)) && Number.isFinite(Number(right)) &&
    Math.abs(Number(left) - Number(right)) < 0.01;

  function hasMeasuredResult(run) {
    const retention = Number.isFinite(run.lastPeakRetention) ? run.lastPeakRetention : run.totalTime;
    return Number.isFinite(run.peakCount) && Number.isFinite(retention);
  }

  function evaluateOrderedSequence(requiredPercentBs, actualRuns) {
    const required = requiredPercentBs.filter(Number.isFinite);
    if (!required.length) {
      return { complete: false, nextPercentB: null, matchedRuns: [], lastMatchedIndex: -1 };
    }
    let matchedRuns = [];
    let lastMatchedIndex = -1;
    for (const [runIndex, run] of actualRuns.entries()) {
      if (run.isSuggested || !hasMeasuredResult(run) || !Number.isFinite(run.percentB)) continue;
      const expected = required[matchedRuns.length];
      if (samePercent(run.percentB, expected)) {
        matchedRuns.push(run);
        lastMatchedIndex = runIndex;
      } else if (samePercent(run.percentB, required[0])) {
        matchedRuns = [run];
        lastMatchedIndex = runIndex;
      }
      if (matchedRuns.length === required.length) {
        return { complete: true, nextPercentB: null, matchedRuns, lastMatchedIndex };
      }
    }
    return {
      complete: false,
      nextPercentB: required[matchedRuns.length] ?? null,
      matchedRuns,
      lastMatchedIndex
    };
  }

  function uniqueDescendingPercentages(runs) {
    return [...new Set(runs
      .filter(run => !run.isSuggested && hasMeasuredResult(run) && Number.isFinite(run.percentB))
      .map(run => Number(run.percentB.toFixed(2))))]
      .sort((left, right) => right - left);
  }

  function convertAcetonitrilePercentToMethanol(percentB) {
    if (!Number.isFinite(percentB) || percentB < 0 || percentB > 100) return null;
    const methanolPercentB = Number((percentB + 10).toFixed(2));
    return methanolPercentB <= 100 ? methanolPercentB : null;
  }

  function acetonitrileToMethanolMappings(percentages) {
    const mappings = [];
    const excluded = [];
    for (const acetonitrilePercentB of percentages) {
      const methanolPercentB = convertAcetonitrilePercentToMethanol(acetonitrilePercentB);
      if (methanolPercentB === null) {
        excluded.push({
          acetonitrilePercentB,
          methanolPercentB: Number((acetonitrilePercentB + 10).toFixed(2))
        });
      } else {
        mappings.push({ acetonitrilePercentB, methanolPercentB });
      }
    }
    return { mappings, excluded };
  }

  function targetWasMet(runs, targetPeakCount) {
    return runs.some(run =>
      !run.isSuggested && Number.isFinite(run.peakCount) && run.peakCount >= targetPeakCount
    );
  }

  return {
    acetonitrileToMethanolMappings,
    convertAcetonitrilePercentToMethanol,
    evaluateOrderedSequence,
    hasMeasuredResult,
    targetWasMet,
    uniqueDescendingPercentages
  };
});
