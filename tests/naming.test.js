const assert = require("node:assert/strict");
const test = require("node:test");
const { parse } = require("../naming.js");

const base = "GR02-08-2-ACN-3-ISO-90-1.5-20u-CP-0.1-C18AQP-150x4.6x5-amb-254";

test("parses the supplied example and preserves leading-zero run identifiers", () => {
  const parsed = parse(base);
  assert.equal(parsed.groupNo, "02");
  assert.equal(parsed.injectionNo, "08");
  assert.equal(parsed.hplcNo, "2");
  assert.equal(parsed.solvent, "ACN");
  assert.equal(parsed.phNo, "3");
  assert.equal(parsed.percentB, 90);
  assert.equal(parsed.flow, 1.5);
  assert.equal(parsed.injectionVolume, 20);
  assert.equal(parsed.sampleType, "CP");
  assert.equal(parsed.sampleConc, "0.1");
  assert.equal(parsed.ligand, "C18AQ");
  assert.equal(parsed.columnType, "Pinnacle");
  assert.equal(parsed.length, 150);
  assert.equal(parsed.diameter, 4.6);
  assert.equal(parsed.particleSize, 5);
  assert.equal(parsed.setTemperature, 25);
  assert.equal(parsed.wavelength, 254);
  assert.equal(parsed.poreSize, undefined);
  assert.equal(parsed.cLoad, undefined);
});

test("parses numeric values in an uploaded XLSX filename with a T-prefixed temperature", () => {
  const parsed = parse("GR09-16-4-ACN-3-ISO-35-1.5-20u-CP-0.1-C18aqP-150x4.6x5-T60-254.xlsx");
  assert.equal(parsed.groupNo, "09");
  assert.equal(parsed.injectionNo, "16");
  assert.equal(parsed.hplcNo, "4");
  assert.equal(parsed.solvent, "ACN");
  assert.equal(parsed.elutionMode, "Isocratic");
  assert.equal(parsed.percentB, 35);
  assert.equal(parsed.flow, 1.5);
  assert.equal(parsed.injectionVolume, 20);
  assert.equal(parsed.sampleType, "CP");
  assert.equal(parsed.ligand, "C18aq");
  assert.equal(parsed.columnType, "Pinnacle");
  assert.equal(parsed.length, 150);
  assert.equal(parsed.diameter, 4.6);
  assert.equal(parsed.particleSize, 5);
  assert.equal(parsed.setTemperature, 60);
  assert.equal(parsed.wavelength, 254);
});

test("parses solvent aliases, hyphenated MIX names, variable pH, and units", () => {
  assert.equal(parse(base.replace("-ACN-3-", "-MeOH-2.5-")).solvent, "METHANOL");
  assert.equal(parse(base.replace("-ACN-3-", "-METHANOL-2.5-")).solvent, "METHANOL");
  assert.equal(parse(base.replace("-ACN-3-", "-MIX-WATER-ACN-2.5-")).solvent, "MIX-WATER-ACN");
  assert.equal(parse(base.replace("-20u-", "-20uL-")).injectionVolume, 20);
  assert.equal(parse(base.replace("-20u-", "-20µL-")).injectionVolume, 20);
  assert.equal(parse(base.replace("-20u-", "-20μL-")).injectionVolume, 20);
  assert.equal(parse(base.replace("-3-ISO-", "-3.25-ISO-")).phNo, "3.25");
});

test("parses variable numeric flow and injection-volume values from CSV names", () => {
  const parsed = parse(base.replace("-90-1.5-20u-", "-50-0.75-5u-"));
  assert.equal(parsed.percentB, 50);
  assert.equal(parsed.flow, 0.75);
  assert.equal(parsed.injectionVolume, 5);
  assert.equal(parse(`${base}.csv`).injectionNo, "08");
  assert.equal(parse(base.replace("-20u-", "-20-")).injectionVolume, 20);
});

test("accepts CP with or without the concentration separator and BLK without concentration", () => {
  assert.equal(parse(base.replace("-CP-0.1-", "-CP0.1-")).sampleConc, "0.1");
  const blankWithNoConcentration = parse(base.replace("-CP-0.1-", "-BLK-"));
  assert.equal(blankWithNoConcentration.sampleType, "BLK");
  assert.equal(blankWithNoConcentration.sampleConc, "");
  const blankWithConcentration = parse(base.replace("-CP-0.1-", "-BLK0.05-"));
  assert.equal(blankWithConcentration.sampleType, "BLK");
  assert.equal(blankWithConcentration.sampleConc, "0.05");
});

test("parses hyphenated ligands and every supported column type", () => {
  const ligands = ["C18", "C8", "C18aq", "PFP", "BiPh", "IBD", "My-Ligand"];
  const columnCodes = { P: "Pinnacle", U: "Ultra", F: "Force", R: "Raptor" };
  for (const ligand of ligands) {
    for (const [code, type] of Object.entries(columnCodes)) {
      const parsed = parse(base.replace("C18AQP", `${ligand}${code}`));
      assert.equal(parsed.ligand, ligand);
      assert.equal(parsed.columnType, type);
      assert.equal(parsed.coreShell, code === "R" ? "Yes" : "No");
    }
  }
});

test("parses column type written directly after the ligand or as a separate token", () => {
  for (const [code, type] of Object.entries({ P: "Pinnacle", U: "Ultra", F: "Force", R: "Raptor" })) {
    for (const separator of ["", "-"]) {
      const parsed = parse(base.replace("C18AQP-150x", `C18AQ${separator}${code}-150x`));
      assert.equal(parsed.ligand, "C18AQ");
      assert.equal(parsed.columnType, type);
      assert.equal(parsed.coreShell, code === "R" ? "Yes" : "No");
      assert.equal(parsed.length, 150);
      assert.equal(parsed.diameter, 4.6);
      assert.equal(parsed.particleSize, 5);
      assert.equal(parsed.poreSize, undefined);
    }
  }

  const hyphenatedLigand = parse(base.replace("C18AQP-150x", "My-Ligand-P-150x"));
  assert.equal(hyphenatedLigand.ligand, "My-Ligand");
  assert.equal(hyphenatedLigand.columnType, "Pinnacle");
});

test("parses method values when the sample name omits the column-type code without guessing it", () => {
  const name = "GR11-16-6-MeOH-3-ISO-50-1.5-20u-CP-0.1-BiPH-150x4.6x5-amb-254";
  const parsed = parse(name);
  assert.equal(parsed.groupNo, "11");
  assert.equal(parsed.injectionNo, "16");
  assert.equal(parsed.hplcNo, "6");
  assert.equal(parsed.solvent, "METHANOL");
  assert.equal(parsed.percentB, 50);
  assert.equal(parsed.flow, 1.5);
  assert.equal(parsed.injectionVolume, 20);
  assert.equal(parsed.sampleConc, "0.1");
  assert.equal(parsed.ligand, "BiPH");
  assert.equal(parsed.columnType, "");
  assert.equal(parsed.coreShell, "");
  assert.equal(parsed.length, 150);
  assert.equal(parsed.diameter, 4.6);
  assert.equal(parsed.particleSize, 5);
  assert.equal(parsed.setTemperature, 25);
  assert.equal(parsed.wavelength, 254);
});

test("accepts %B endpoints and rejects values outside 0–100", () => {
  assert.equal(parse(base.replace("-90-", "-0-")).percentB, 0);
  assert.equal(parse(base.replace("-90-", "-100-")).percentB, 100);
  assert.equal(parse(base.replace("-90-", "-100.1-")), null);
  assert.equal(parse(base.replace("-90-", "--0.1-")), null);
});

test("normalizes ambient aliases and accepts Celsius values only from 10 to 100", () => {
  for (const alias of ["amb", "ambient", "RT"]) {
    assert.equal(parse(base.replace("-amb-", `-${alias}-`)).setTemperature, 25);
  }
  assert.equal(parse(base.replace("-amb-", "-40-")).setTemperature, 40);
  assert.equal(parse(base.replace("-amb-", "-T40-")).setTemperature, 40);
  assert.equal(parse(base.replace("-amb-", "-T-40-")).setTemperature, 40);
  assert.equal(parse(base.replace("-amb-", "-40C-")).setTemperature, 40);
  assert.equal(parse(base.replace("-amb-", "-40°C-")).setTemperature, 40);
  assert.equal(parse(base.replace("-amb-", "-10-")).setTemperature, 10);
  assert.equal(parse(base.replace("-amb-", "-100-")).setTemperature, 100);
  assert.equal(parse(base.replace("-amb-", "-9-")), null);
  assert.equal(parse(base.replace("-amb-", "-101-")), null);
});

test("accepts wavelength limits and optional nm, rejecting values outside 190–800", () => {
  assert.equal(parse(base.replace("-254", "-190")).wavelength, 190);
  assert.equal(parse(base.replace("-254", "-800nm")).wavelength, 800);
  assert.equal(parse(base.replace("-254", "-189")), null);
  assert.equal(parse(base.replace("-254", "-801nm")), null);
});

test("rejects non-ISO names and unsupported solvent names while leaving ambiguous column type unspecified", () => {
  assert.equal(parse(base.replace("-ISO-", "-GRAD-")), null);
  assert.equal(parse(base.replace("-ACN-", "-WATER-")), null);
  const unknownColumnCode = parse(base.replace("C18AQP", "C18AQX"));
  assert.equal(unknownColumnCode.ligand, "C18AQX");
  assert.equal(unknownColumnCode.columnType, "");
});
