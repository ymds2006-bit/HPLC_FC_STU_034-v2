(function (root, factory) {
  const calculator = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = calculator;
  if (root) root.HplcAwesomeEfficiency = calculator;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  const VAN_DEEMTER = Object.freeze({ a: 1.5, b: 3, c: 0.15 });
  const SPP_FACTOR = 1.5;

  function finitePositive(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0;
  }

  function unavailable(reason) {
    return { available: false, reason };
  }

  function currentPlateCount(current, packingFactor) {
    const linearVelocity = Number(current.length) / Number(current.t0) / 60;
    const hetp = (
      VAN_DEEMTER.a * Number(current.particleSize) +
      VAN_DEEMTER.b / linearVelocity +
      VAN_DEEMTER.c * Number(current.particleSize) ** 2 * linearVelocity
    ) / packingFactor;
    const plates = Number(current.length) * 1000 / hetp;
    return finitePositive(plates) ? { linearVelocity, hetp, plates } : null;
  }

  function calculateRsFloor(current, limits, currentPackingFactor) {
    if (!Number.isFinite(Number(current.peakCount)) || Number(current.peakCount) < 7) {
      return unavailable("At least 7 noise-filtered peaks are needed; Rs is only a course placeholder below 7 peaks.");
    }
    if (!finitePositive(current.resolution)) {
      return unavailable("A positive measured lowest Rs is required; an unassessable Rs cannot be used.");
    }
    if (![1, SPP_FACTOR].includes(Number(currentPackingFactor))) {
      return unavailable("Select the current packing type (fully porous or SPP) to calculate the Rs floor.");
    }
    const required = [
      ["column length", current.length],
      ["particle size", current.particleSize],
      ["first-peak t0", current.t0],
      ["last-peak retention", current.lastPeakRetention],
      ["measured back-pressure", current.pressure],
      ["maximum run time", limits.maxRunTime],
      ["maximum back-pressure", limits.maxPressure],
      ["resolution specification", limits.resolution]
    ];
    const missing = required.find(([, value]) => !finitePositive(value));
    if (missing) return unavailable(`A positive ${missing[0]} is required by the workbook equations.`);

    const currentN = currentPlateCount(current, Number(currentPackingFactor));
    if (!currentN) return unavailable("The workbook's current plate-count calculation is not finite for this run.");
    const headroom = Math.sqrt(
      (Number(limits.maxPressure) / Number(current.pressure)) *
      (Number(limits.maxRunTime) / Number(current.lastPeakRetention))
    );
    const maximumNFullyPorous = 1000 * Number(current.length) * headroom /
      (Number(current.particleSize) * (
        VAN_DEEMTER.a + 2 * Math.sqrt(VAN_DEEMTER.b * VAN_DEEMTER.c)
      ));
    const maximumNSpp = maximumNFullyPorous * SPP_FACTOR;
    if (!finitePositive(maximumNFullyPorous) || !finitePositive(maximumNSpp)) {
      return unavailable("The workbook's maximum achievable plate-count calculation is not finite.");
    }
    const fullyPorousFloor = Number(limits.resolution) * Math.sqrt(currentN.plates / maximumNFullyPorous);
    const sppFloor = Number(limits.resolution) * Math.sqrt(currentN.plates / maximumNSpp);
    if (![fullyPorousFloor, sppFloor].every(Number.isFinite)) {
      return unavailable("The workbook's Rs-floor result is not finite for this run.");
    }
    const verdict = Number(current.resolution) >= fullyPorousFloor
      ? "Reachable with a fully porous column"
      : Number(current.resolution) >= sppFloor
        ? "Requires an SPP bead; below the fully porous floor"
        : "Below the SPP floor; change selectivity";
    return {
      available: true,
      currentN: currentN.plates,
      currentHetp: currentN.hetp,
      linearVelocity: currentN.linearVelocity,
      headroom,
      maximumNFullyPorous,
      maximumNSpp,
      fullyPorousFloor,
      sppFloor,
      verdict,
      constants: { ...VAN_DEEMTER, sppFactor: SPP_FACTOR }
    };
  }

  function flowchartDecision(current, limits, currentPackingFactor, runTime) {
    if (current.resolution === null || !Number.isFinite(current.resolution)) {
      return "Lowest Rs is unavailable; the efficiency decision cannot be classified.";
    }
    const runtimeBand = runTime <= limits.time * 0.5
      ? "much-less"
      : runTime <= limits.time
        ? "within"
        : "over";
    if (current.resolution >= limits.resolution) {
      return runtimeBand === "over"
        ? "Increase F to shorten the run"
        : "MET. Optionally increase F to shorten the run";
    }
    const floor = calculateRsFloor(current, {
      maxRunTime: limits.time,
      maxPressure: limits.pressure,
      resolution: limits.resolution
    }, currentPackingFactor);
    if (!floor.available) return `Rs floor unavailable: ${floor.reason}`;
    const resolutionBand = current.resolution < floor.sppFloor
      ? "below-floor"
      : current.resolution < limits.resolution
        ? "between-floor-and-spec"
        : "meets-spec";
    if (runtimeBand === "much-less") {
      if (resolutionBand === "below-floor") return "Increase L (watch BP)";
      if (resolutionBand === "between-floor-and-spec") {
        return "Increase L (BP) OR decrease F OR decrease PS (BP) OR SPP";
      }
      return "MET. Optionally increase F to shorten the run";
    }
    if (runtimeBand === "within") {
      if (resolutionBand === "below-floor") return "SELECTIVITY";
      if (resolutionBand === "between-floor-and-spec") {
        return "Decrease F OR decrease PS (BP) OR SPP";
      }
      return "MET. Optionally increase F to shorten the run";
    }
    if (resolutionBand === "below-floor") return "SELECTIVITY";
    if (resolutionBand === "between-floor-and-spec") {
      return "Decrease PS (BP), then increase F to shorten the run";
    }
    return "Increase F to shorten the run";
  }

  function predictCombination(current, limits, proposal, currentPackingFactor) {
    if (!Number.isFinite(Number(current.peakCount)) || Number(current.peakCount) < 7) {
      return unavailable("At least 7 noise-filtered peaks are needed for meaningful Rs predictions.");
    }
    if (![1, SPP_FACTOR].includes(Number(currentPackingFactor))) {
      return unavailable("Select the current packing type before calculating predictions.");
    }
    if (![1, SPP_FACTOR].includes(Number(proposal.packingFactor))) {
      return unavailable("Select a proposed packing type (fully porous or SPP).");
    }
    const requiredCurrent = [
      ["current column length", current.length],
      ["current internal diameter", current.diameter],
      ["current particle size", current.particleSize],
      ["current flow rate", current.flow],
      ["first-peak t0", current.t0],
      ["last-peak retention", current.lastPeakRetention],
      ["current back-pressure", current.pressure],
      ["current lowest Rs", current.resolution],
      ["maximum run time", limits.maxRunTime],
      ["maximum back-pressure", limits.maxPressure],
      ["resolution specification", limits.resolution]
    ];
    const missingCurrent = requiredCurrent.find(([, value]) => !finitePositive(value));
    if (missingCurrent) return unavailable(`A positive ${missingCurrent[0]} is required by the workbook equations.`);
    const requiredProposal = [
      ["proposed column length", proposal.length],
      ["proposed internal diameter", proposal.diameter],
      ["proposed particle size", proposal.particleSize],
      ["proposed flow rate", proposal.flow]
    ];
    const missingProposal = requiredProposal.find(([, value]) => !finitePositive(value));
    if (missingProposal) return unavailable(`Enter a positive ${missingProposal[0]}; proposals are never chosen automatically.`);

    const baseline = currentPlateCount(current, Number(currentPackingFactor));
    if (!baseline) return unavailable("The workbook's current plate-count calculation is not finite for this run.");
    const proposedT0 = Number(current.t0) *
      (Number(current.flow) / Number(proposal.flow)) *
      (Number(proposal.diameter) ** 2 / Number(current.diameter) ** 2) *
      (Number(proposal.length) / Number(current.length));
    const predictedRetention = Number(current.lastPeakRetention) *
      (Number(current.flow) / Number(proposal.flow)) *
      (Number(proposal.diameter) ** 2 / Number(current.diameter) ** 2) *
      (Number(proposal.length) / Number(current.length));
    const predictedPressure = Number(current.pressure) *
      ((Number(proposal.length) * Number(proposal.flow)) /
        (Number(current.length) * Number(current.flow))) *
      ((Number(current.particleSize) * Number(current.diameter)) /
        (Number(proposal.particleSize) * Number(proposal.diameter))) ** 2;
    const proposedVelocity = Number(proposal.length) / proposedT0 / 60;
    const proposedHetp = (
      VAN_DEEMTER.a * Number(proposal.particleSize) +
      VAN_DEEMTER.b / proposedVelocity +
      VAN_DEEMTER.c * Number(proposal.particleSize) ** 2 * proposedVelocity
    ) / Number(proposal.packingFactor);
    const predictedN = Number(proposal.length) * 1000 / proposedHetp;
    const predictedResolution = Number(current.resolution) * Math.sqrt(predictedN / baseline.plates);
    const minimumFlowForRetention = Number(current.flow) *
      (Number(current.lastPeakRetention) / Number(limits.maxRunTime)) *
      (Number(proposal.diameter) ** 2 / Number(current.diameter) ** 2) *
      (Number(proposal.length) / Number(current.length));
    const maximumFlowForPressure = (Number(limits.maxPressure) * Number(current.length) * Number(current.flow)) /
      (Number(current.pressure) * Number(proposal.length) *
        ((Number(current.particleSize) * Number(current.diameter)) /
          (Number(proposal.particleSize) * Number(proposal.diameter))) ** 2);
    if (![proposedT0, predictedRetention, predictedPressure, proposedVelocity, proposedHetp,
      predictedN, predictedResolution, minimumFlowForRetention, maximumFlowForPressure].every(Number.isFinite)) {
      return unavailable("The workbook equations produced a non-finite result for these inputs.");
    }
    const runtimePass = predictedRetention <= Number(limits.maxRunTime);
    const pressurePass = predictedPressure <= Number(limits.maxPressure);
    const resolutionPass = predictedResolution >= Number(limits.resolution);
    const flowRangePass = minimumFlowForRetention <= maximumFlowForPressure;
    return {
      available: true,
      proposedT0,
      predictedRetention,
      predictedPressure,
      linearVelocity: proposedVelocity,
      hetp: proposedHetp,
      plateCount: predictedN,
      predictedResolution,
      minimumFlowForRetention,
      maximumFlowForPressure,
      flowRangePass,
      proposedFlowWithinRange:
        Number(proposal.flow) >= minimumFlowForRetention &&
        Number(proposal.flow) <= maximumFlowForPressure,
      runtimePass,
      pressurePass,
      resolutionPass,
      viable: runtimePass && pressurePass && resolutionPass,
      constants: { ...VAN_DEEMTER, sppFactor: SPP_FACTOR }
    };
  }

  return { VAN_DEEMTER, SPP_FACTOR, calculateRsFloor, flowchartDecision, predictCombination };
});
