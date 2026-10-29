(function (root, factory) {
  const naming = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = naming;
  if (root) root.HplcRunNaming = naming;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
  const prefixPattern = new RegExp(
    `GR(\\d+)-(\\d+)-(\\d+)-(.+)-(${number})-ISO-(${number})-(${number})-(${number})(?:u|uL|µL|μL)?-`,
    "i"
  );
  const samplePattern = new RegExp(
    `^(.+?)(?:-([PUFR])|([PUFR]))?-(${number})x(${number})x(${number})-(amb(?:ient)?|RT|T-?${number}(?:°?C)?|${number}(?:°?C)?)-(${number})(?:nm)?`,
    "i"
  );
  const columnTypes = { P: "Pinnacle", U: "Ultra", F: "Force", R: "Raptor" };

  function parse(text) {
    const source = String(text || "");
    const prefix = prefixPattern.exec(source);
    if (!prefix) return null;

    const solvent = prefix[4].trim();
    if (!/^(?:ACN|METHANOL|MEOH|MIX(?:-.+)?)$/i.test(solvent)) return null;

    const sampleStart = prefix.index + prefix[0].length;
    const remainder = source.slice(sampleStart);
    const cpSample = new RegExp(`^CP-?(${number})-(.+)$`, "i").exec(remainder);
    const blankSample = new RegExp(`^BLK(?:-?(${number}))?-(.+)$`, "i").exec(remainder);
    const sample = cpSample || blankSample;
    if (!sample) return null;

    const sampleType = cpSample ? "CP" : "BLK";
    const sampleConc = sample[1] || "";
    const body = sample[2];
    const details = samplePattern.exec(body);
    if (!details) return null;

    const percentB = Number(prefix[6]);
    const temperatureText = details[7];
    const temperature = /^amb(?:ient)?$/i.test(temperatureText) || /^RT$/i.test(temperatureText)
      ? 25
      : Number(temperatureText.replace(/^T-?/i, "").replace(/°?C$/i, ""));
    const wavelength = Number(details[8]);
    if (!Number.isFinite(percentB) || percentB < 0 || percentB > 100) return null;
    if (!Number.isFinite(temperature) || temperature < 10 || temperature > 100) return null;
    if (!Number.isFinite(wavelength) || wavelength < 190 || wavelength > 800) return null;

    const columnCode = (details[2] || details[3] || "").toUpperCase();
    const canonicalSolvent = /^MEOH$/i.test(solvent) ? "METHANOL" : solvent;
    return {
      groupNo: prefix[1],
      injectionNo: prefix[2],
      hplcNo: prefix[3],
      solvent: canonicalSolvent,
      phNo: prefix[5],
      percentB,
      flow: Number(prefix[7]),
      elutionMode: "Isocratic",
      injectionVolume: Number(prefix[8]),
      sampleType,
      sampleConc,
      ligand: details[1],
      columnType: columnTypes[columnCode] || "",
      coreShell: columnCode ? columnCode === "R" ? "Yes" : "No" : "",
      length: Number(details[4]),
      diameter: Number(details[5]),
      particleSize: Number(details[6]),
      setTemperature: temperature,
      wavelength
    };
  }

  return { parse };
});
