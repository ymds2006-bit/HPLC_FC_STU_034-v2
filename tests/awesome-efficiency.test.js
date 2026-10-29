const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calculateRsFloor,
  flowchartDecision,
  predictCombination
} = require("../awesome-efficiency.js");

const current = {
  peakCount: 7,
  resolution: 1,
  length: 150,
  diameter: 4.6,
  particleSize: 5,
  flow: 1.5,
  t0: 1,
  lastPeakRetention: 10,
  pressure: 1000
};
const limits = { maxRunTime: 15, maxPressure: 4000, resolution: 1.4 };

test("calculates workbook Rs floors from HETP, plate count and pressure/runtime headroom", () => {
  const result = calculateRsFloor(current, limits, 1);
  const linearVelocity = 150 / 1 / 60;
  const hetp = (1.5 * 5 + 3 / linearVelocity + 0.15 * 5 ** 2 * linearVelocity) / 1;
  const nCurrent = 150 * 1000 / hetp;
  const headroom = Math.sqrt((4000 / 1000) * (15 / 10));
  const nMaxFpp = 1000 * 150 * headroom / (5 * (1.5 + 2 * Math.sqrt(3 * 0.15)));
  assert.equal(result.available, true);
  assert.ok(Math.abs(result.currentN - nCurrent) < 1e-10);
  assert.ok(Math.abs(result.headroom - headroom) < 1e-10);
  assert.ok(Math.abs(result.maximumNFullyPorous - nMaxFpp) < 1e-10);
  assert.ok(Math.abs(result.maximumNSpp - nMaxFpp * 1.5) < 1e-10);
  assert.ok(Math.abs(result.fullyPorousFloor - 1.4 * Math.sqrt(nCurrent / nMaxFpp)) < 1e-10);
  assert.ok(Math.abs(result.sppFloor - 1.4 * Math.sqrt(nCurrent / (nMaxFpp * 1.5))) < 1e-10);
});

test("withholds floor and Rs predictions for fewer than seven peaks", () => {
  const fewerThanSeven = { ...current, peakCount: 6, resolution: 0 };
  assert.match(calculateRsFloor(fewerThanSeven, limits, 1).reason, /At least 7/);
  assert.match(predictCombination(
    fewerThanSeven,
    limits,
    { length: 200, diameter: 4.6, particleSize: 3, flow: 1.5, packingFactor: 1.5 },
    1
  ).reason, /At least 7/);
});

test("maps the nine runtime and resolution bands to the specified flowchart actions", () => {
  const limits = { time: 15, pressure: 4000, resolution: 1.4 };
  const decisions = [
    [7.5, 0.6, "Increase L (watch BP)"],
    [7.5, 1, "Increase L (BP) OR decrease F OR decrease PS (BP) OR SPP"],
    [7.5, 1.4, "MET. Optionally increase F to shorten the run"],
    [7.5001, 0.6, "SELECTIVITY"],
    [7.5001, 1, "Decrease F OR decrease PS (BP) OR SPP"],
    [7.5001, 1.4, "MET. Optionally increase F to shorten the run"],
    [15.0001, 0.6, "SELECTIVITY"],
    [15.0001, 1, "Decrease PS (BP), then increase F to shorten the run"],
    [15.0001, 1.4, "Increase F to shorten the run"]
  ];
  for (const [runTime, resolution, expected] of decisions) {
    assert.equal(
      flowchartDecision({ ...current, resolution }, limits, 1, runTime),
      expected,
      `runtime ${runTime}, Rs ${resolution}`
    );
  }
  const floor = calculateRsFloor(current, {
    maxRunTime: limits.time,
    maxPressure: limits.pressure,
    resolution: limits.resolution
  }, 1);
  assert.equal(
    flowchartDecision({ ...current, resolution: floor.sppFloor }, limits, 1, limits.time),
    "Decrease F OR decrease PS (BP) OR SPP"
  );
});

test("predicts a user-entered L/PS combination and uses inclusive viability limits", () => {
  const result = predictCombination(
    current,
    limits,
    { length: 200, diameter: 4.6, particleSize: 3, flow: 1.5, packingFactor: 1 },
    1
  );
  const expectedT0 = 1 * (1.5 / 1.5) * (4.6 ** 2 / 4.6 ** 2) * (200 / 150);
  const expectedTr = 10 * (1.5 / 1.5) * (4.6 ** 2 / 4.6 ** 2) * (200 / 150);
  const expectedPressure = 1000 * ((200 * 1.5) / (150 * 1.5)) * ((5 * 4.6) / (3 * 4.6)) ** 2;
  assert.equal(result.available, true);
  assert.ok(Math.abs(result.proposedT0 - expectedT0) < 1e-10);
  assert.ok(Math.abs(result.predictedRetention - expectedTr) < 1e-10);
  assert.ok(Math.abs(result.predictedPressure - expectedPressure) < 1e-10);
  assert.equal(result.runtimePass, true);
  assert.equal(result.pressurePass, true);
  assert.equal(result.flowRangePass, true);
  assert.equal(result.proposedFlowWithinRange, true);
  assert.equal(result.resolutionPass, true);
  assert.equal(result.viable, true);
});

test("does not choose missing proposal values", () => {
  const result = predictCombination(current, limits, {}, 1);
  assert.match(result.reason, /Select a proposed packing type/);
  const blankInputs = predictCombination(current, limits, {
    length: 150, diameter: 4.6, particleSize: 5, packingFactor: 1
  }, 1);
  assert.match(blankInputs.reason, /proposals are never chosen automatically/);
});
