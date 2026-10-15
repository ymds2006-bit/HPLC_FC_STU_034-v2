const $ = id => document.getElementById(id);
const trials = [];
const TRIALS_STORAGE_KEY = "hplc-run-decision-tool.uploaded-runs.v1";
const deletedSuggestions = new Set();
let currentViewedTrialIndex = null;
let parameterTrialIndex = null;
let hasPositionedTrialTable = false;
let specificationValidationState = "NOT YET VALIDATED";
let pendingRunFile = null;
let specificationRevision = 0;
let analysisRequestId = 0;
let activeEquipmentModule = "";
let activeEquipmentParameter = "";
let activeInjectorImage = "manual";
let activeSolventNomogram = null;
let activePumpPercentBDecision = null;
let activeSelectivityDecision = null;
function reportTrialStorageError(action, error) {
  $("error").textContent = `Uploaded run history could not be ${action}: ${error.message}`;
  $("error").hidden = false;
  $("savedRunStatus").textContent = `Saved run history error: ${error.message}`;
}
function persistUploadedTrials() {
  try {
    const records = trials.filter(trial => !trial.isSuggested).map(trial => {
      const {
        recommendation, nextPercentB, minimumPercentBResult, intermediatePercentBResult,
        intermediateObservationCandidates,
        prediction, sequencePlan, ...record
      } = trial;
      return { ...record, isSuggested: false };
    });
    window.localStorage.setItem(TRIALS_STORAGE_KEY, JSON.stringify(records));
    $("savedRunStatus").textContent = `${records.length} uploaded run record${records.length === 1 ? "" : "s"} saved in this browser.`;
  } catch (error) {
    reportTrialStorageError("saved", error);
  }
}
function restoreUploadedTrials() {
  try {
    const saved = window.localStorage.getItem(TRIALS_STORAGE_KEY);
    if (!saved) return;
    const records = JSON.parse(saved);
    if (!Array.isArray(records) || records.some(record => !record || typeof record !== "object" || record.isSuggested)) {
      throw new Error("saved run history has an invalid format");
    }
    records.forEach(record => trials.push({
      ...record,
      recommendation: null,
      nextPercentB: null,
      minimumPercentBResult: null,
      intermediatePercentBResult: null,
      prediction: null,
      sequencePlan: null,
      isSuggested: false
    }));
    if (trials.length) {
      currentViewedTrialIndex = trials.length - 1;
      parameterTrialIndex = trials.length - 1;
    }
    $("savedRunStatus").textContent = `${trials.length} uploaded run record${trials.length === 1 ? "" : "s"} restored from this browser.`;
  } catch (error) {
    reportTrialStorageError("restored", error);
  }
}
function logDebug(label, value) {
  const output = $("debugLog");
  if (!output) return;
  if (output.textContent.startsWith("Upload a run")) output.textContent = "";
  output.textContent += `${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n\n`;
}
const parameterLabels = [
  ["Ligand", "ligand"], ["Column Type", "columnType"], ["Coreshell Present", "coreShell"],
  ["Pore Size (Å)", "poreSize"], ["C-Load (%)", "cLoad"], ["Column Length (mm)", "length"],
  ["Column Internal Diameter (mm)", "diameter"], ["Particle Size (μm)", "particleSize"],
  ["Solvent Type", "solvent"], ["%B", "percentB"], ["Flow Rate (mL/minute)", "flow"],
  ["Sample Concentration (mg/mL)", "sampleConc"], ["Sample Volume (µL)", "injectionVolume"],
  ["Set Temp (°C)", "setTemperature"],
  ["Measured Temp (°C)", "measuredTemperature"],
  ["Wavelength (nm)", "wavelength"]
];
const editableParameterNumberKeys = new Set([
  "length", "diameter", "particleSize", "percentB", "injectionVolume",
  "flow", "sampleConc", "setTemperature", "measuredTemperature", "wavelength"
]);
const MINIMUM_INTERMEDIATE_NOT_ENOUGH_RUNS = "NA% (Not Enough Runs to Calculate Min %B/Intermediate %B)";
const DECISION_DO_NOT_CONTINUE = "Do not continue run | Ensure Method specifications are met";
const DECREASE_PERCENT_B_RECOMMENDATION = "Decrease %B by 10%";
// EQUIPMENT REFERENCE LOOKUP:
// Static, module-specific explanations support the Equipment interface only.
// Leave numeric admissible ranges blank unless the supplied method notes specify them.
const equipmentModules = {
  solventBottles: {
    title: "Solvent Bottles",
    category: "Composition",
    function: "Stores and supplies the solvents used to prepare the mobile phase. Solvent selection and composition determine the mobile phase delivered to the column and, when buffers are used, contribute to the method pH.",
    description: "Bottles sit above the instrument and connect through individual lines. Select a parameter below to see what to adjust and what chromatographic change to expect.",
    parameters: [
      {
        name: "Solvent Type",
        dataKey: "Solvent",
        function: "Selects which solvent each bottle line supplies for mixing with water or another mobile-phase solvent.",
        category: "Composition",
        controlPoint: "Bench setup: solvent bottles and lines. Software: method solvent/line selection.",
        units: "Not applicable",
        admissibleRange: "Not specified in the available method notes.",
        typicalRange: "Common HPLC solvents include water, acetonitrile, methanol, and ethanol.",
        retentionEffect: "At the same %B, solvents can have different elution strengths. A stronger or weaker solvent may require a different %B to produce similar retention.",
        selectivityEffect: "Changing solvent changes mobile-phase/analyte interactions and can alter peak spacing and elution order.",
        efficiencyEffect: "",
        otherEffects: "Solvent viscosity affects system back-pressure. If the mobile phase is buffered, confirm that the chosen solvent and pH are compatible with the column.",
        whyChange: "Change solvent when the current solvent/%B combination cannot meet retention targets, or when a different selectivity is needed to resolve peaks.",
        recommendationWhen: "The decision flow can advance to a solvent-change stage after the sequential %B options at the preceding conditions have been tried."
      },
      {
        name: "%B (Mobile-phase composition)",
        dataKey: "percentage B",
        valueUnit: "%",
        function: "Sets the proportion of solvent B in the mobile phase. In reversed-phase methods, solvent B is commonly the organic solvent.",
        category: "Composition",
        controlPoint: "Initial preparation of solvent bottles and composition; the instrument method records which solvent lines are used and the %B setting.",
        units: "%",
        admissibleRange: "0–100%.",
        typicalRange: "0–100%, as specified by the method.",
        retentionEffect: "Changes mobile-phase elution strength and polarity. Increasing organic %B in a typical reversed-phase method generally decreases retention; decreasing %B generally increases retention.",
        selectivityEffect: "Composition can change analyte ionisation and mobile-phase interactions. pH/composition shifts can change peak spacing and may reorder peaks.",
        efficiencyEffect: "",
        otherEffects: "For buffered mobile phases, pH and temperature can affect ionisation. Keep pH within the column's stability limits.",
        whyChange: "Adjust %B to move the last peak toward the maximum-run-time target while retaining the required peaks.",
        recommendationWhen: "During the retention cycle, when peak count is below target, pressure passes, and roughly twice the current last-peak retention remains below the maximum run time, the decision engine recommends decreasing %B by 10 percentage points. If current runtime is below the limit but doubling reaches or exceeds it, it moves to Minimum %B OR Intermediate %B; if current runtime meets or exceeds the limit, it moves to Minimum %B THEN Intermediate %B."
      }
    ]
  },
  degasser: {
    title: "Degasser",
    category: "Mobile-phase preparation",
    function: "Removes dissolved gases through vacuum-held, gas-permeable tubing before the solvent reaches the pump.",
    description: "The degasser runs automatically and is not a separation control. It stabilises flow and detector baseline; it does not remove air bubbles already in the line, which require purging.",
    parameters: [
      {
        name: "Operational role (not user-adjustable)",
        function: "Removes dissolved gas to help maintain steady solvent delivery and a stable detector baseline.",
        category: "Mobile-phase preparation",
        controlPoint: "Automatic while the instrument is on. Check degasser status/vacuum; purge bubbles separately.",
        units: "Not applicable",
        admissibleRange: "Not applicable.",
        typicalRange: "Not applicable.",
        retentionEffect: "No direct effect; unstable delivery can reduce retention-time repeatability.",
        selectivityEffect: "No direct effect.",
        efficiencyEffect: "No direct effect; bubbles or unstable flow can make peak measurements unreliable.",
        otherEffects: "Failure signs include unsteady flow, a wandering baseline, and random chromatogram spikes.",
        whyChange: "Check or service it only to restore stable operation, not to tune the separation.",
        recommendationWhen: "Not recommended by the decision engine. Troubleshoot if flow or baseline is unstable; purge trapped bubbles."
      }
    ]
  },
  pump: {
    title: "Pump",
    category: "Mobile phase and flow",
    function: "Delivers mobile phase through the HPLC system at a controlled flow rate and composition.",
    description: "A dual-reciprocating pump delivers the mobile phase. Solvents may be mixed before or after the pump, depending on the instrument; the purge/drain valve must be closed for flow to reach the column.",
    parameters: [
      {
        name: "Flow Rate",
        dataKey: "flow",
        valueUnit: " mL/min",
        function: "Sets mobile-phase volume delivered through the column per unit time.",
        category: "Flow",
        controlPoint: "Instrument method: pump flow-rate setting.",
        units: "mL/min",
        admissibleRange: "Instrument-specific. Keep pressure below the lower of the instrument and column ratings; this project also checks a 4000 psi method limit.",
        typicalRange: "1.0 mL/min is cited for a 4.6 mm column; the supplied runs used 1.5 mL/min. Confirm the method and hardware limits.",
        retentionEffect: "Typically decreases retention time as the mobile phase moves through the column faster.",
        selectivityEffect: "Little or no direct effect on selectivity or elution order. Flow is not a co-elution remedy.",
        efficiencyEffect: "Efficiency depends on linear velocity (Van Deemter behaviour); flow far from the column optimum broadens peaks.",
        otherEffects: "Pressure rises with flow. Check that the purge/drain valve is closed and pressure is stable.",
        whyChange: "Adjust run time or reduce pressure only while preserving required resolution.",
        recommendationWhen: "The engine may recommend increasing flow when retention is within the time limit and resolution meets specification."
      },
      {
        name: "%B (Pump composition setting)",
        dataKey: "percentB",
        valueUnit: "%",
        parameterType: "Chemical parameter set and delivered through the pump's mechanical solvent-proportioning system.",
        function: "Sets the organic-solvent fraction delivered by the pump; it may be constant (isocratic) or programmed as a gradient.",
        category: "Mobile phase / Composition",
        controlPoint: "Instrument method: isocratic %B setting or programmed solvent composition.",
        units: "%",
        admissibleRange: "0–100%.",
        typicalRange: "About 40–80% B is the working range in the supplied unit method; it is not a universal limit.",
        retentionEffect: "In reversed-phase methods, lower organic %B generally raises k′ and lengthens retention; higher %B lowers both.",
        selectivityEffect: "Can change pairwise spacing because compounds respond differently; changing solvent identity or pH may have a larger effect.",
        efficiencyEffect: "Little direct effect on plate number.",
        otherEffects: "Lower %B can increase viscosity and pressure. Very low %B may push late peaks beyond the run-time window.",
        whyChange: "Tune retention and resolution while checking run time and pressure.",
        recommendationWhen: "The engine steps %B down, calculates the course-based Minimum %B, then asks the user to observe the peak movement and confirm an Intermediate %B when required."
      },
      {
        name: "Pressure Limit",
        dataKey: "pressure",
        valueUnit: " psi",
        currentValueLabel: "Observed back-pressure in selected run",
        function: "Sets a protective pump cut-off. Measured back-pressure is a system response, not a retention control.",
        category: "System protection",
        controlPoint: "Instrument method or pump settings.",
        units: "psi",
        admissibleRange: "Set no higher than the lower instrument/column rating. The hardware ratings are not specified in the supplied notes.",
        typicalRange: "The project method uses a 4000 psi back-pressure threshold; this is not a universal equipment rating.",
        retentionEffect: "No direct retention adjustment.",
        selectivityEffect: "No direct selectivity adjustment.",
        efficiencyEffect: "No direct efficiency adjustment.",
        otherEffects: "High pressure may indicate high viscosity, flow, or a blockage; near-zero pressure may indicate a leak or open purge valve.",
        whyChange: "Protect the system and investigate unexpected pressure changes.",
        recommendationWhen: "The tool compares measured pressure with the method specification; it does not recommend a pump cut-off setting."
      }
    ]
  },
  columnOven: {
    title: "Column/Column Oven",
    category: "Stationary phase and temperature",
    function: "The column provides the stationary phase for sample compounds to interact with and separate. The column oven maintains the column at a controlled temperature.",
    description: "The packed column is where separation occurs; the oven stabilises column temperature. Column attributes come from its data sheet, while temperature is set in the instrument method.",
    parameters: [
      {
        name: "Ligand (Stationary phase)",
        dataKey: "ligand",
        function: "Identifies the bonded stationary-phase chemistry (for example, C18) that interacts with analytes.",
        category: "Stationary phase",
        controlPoint: "Column selection / installed column.",
        units: "Chemistry/name",
        admissibleRange: "Use a column chemistry compatible with the analytes, mobile phase, and pH. No universal numeric range.",
        typicalRange: "Method-specific. The current run's ligand is shown in Run Analysis when available.",
        retentionEffect: "Ligand chemistry determines analyte interaction strength and retention.",
        selectivityEffect: "Changing ligand can strongly alter pairwise spacing and elution order.",
        efficiencyEffect: "A suitable stationary phase can improve peak shape and separation quality; efficiency also depends on packing and operating conditions.",
        otherEffects: "Confirm solvent and pH compatibility with the column.",
        whyChange: "Consider another ligand when the existing solvent, %B, and temperature stages do not provide the required separation.",
        recommendationWhen: "The staged flow considers ligand changes only after the prescribed solvent and temperature stages remain below the peak target."
      },
      {
        name: "Bead Type",
        function: "Identifies particle construction (for example, fully porous or core-shell) supporting the stationary phase.",
        category: "Column characteristics",
        controlPoint: "Column selection / installed column.",
        units: "Type/name",
        admissibleRange: "Column-specific; not specified in the available notes.",
        typicalRange: "Use the bead type stated for the installed column.",
        retentionEffect: "Porous particles generally provide more stationary-phase surface and retention than solid particles of the same size.",
        selectivityEffect: "Usually less direct than ligand or mobile-phase changes.",
        efficiencyEffect: "Core-shell construction shortens diffusion paths and can improve efficiency.",
        otherEffects: "Construction can affect pressure and loading capacity; verify the column data sheet.",
        whyChange: "Consider a different bead construction when more efficiency is needed without a longer column.",
        recommendationWhen: "The Stage 3 guidance may consider a bead-type change when resolution is low and run time allows."
      },
      {
        name: "Coreshell Present",
        dataKey: "coreShell",
        function: "Indicates whether particles have a solid core surrounded by a porous shell.",
        category: "Column characteristics",
        controlPoint: "Column selection / installed column.",
        units: "Yes/No",
        admissibleRange: "Yes or No, according to the installed column.",
        typicalRange: "Column-specific.",
        retentionEffect: "Often slightly lower than fully porous particles of the same diameter because less stationary phase is present.",
        selectivityEffect: "Little direct effect; it is not a primary chemical-selectivity control.",
        efficiencyEffect: "Shorter diffusion paths can improve efficiency, often without the pressure of sub-2 μm particles.",
        otherEffects: "Core-shell columns may have lower sample-loading capacity.",
        whyChange: "This is a fixed column choice, not an in-run setting.",
        recommendationWhen: "The decision engine does not independently recommend a core-shell change."
      },
      {
        name: "Pore Size",
        dataKey: "poreSize",
        valueUnit: " Å",
        function: "Describes particle-pore dimensions and the accessible surface area for analyte interaction.",
        category: "Column characteristics",
        controlPoint: "Column selection / installed column.",
        units: "Å",
        admissibleRange: "Use the manufacturer's column data sheet.",
        typicalRange: "140 Å is the supplied Pinnacle example; confirm the installed column specification.",
        retentionEffect: "Larger pores provide less surface area and generally lower retention; smaller pores provide more.",
        selectivityEffect: "Little direct effect for the small analytes in the supplied method.",
        efficiencyEffect: "Pores too small for an analyte can restrict diffusion and broaden peaks.",
        otherEffects: "Choose pore size to suit analyte dimensions.",
        whyChange: "Change only when selecting a column suitable for analyte access.",
        recommendationWhen: "The decision engine does not independently recommend a pore-size change."
      },
      {
        name: "Carbon Load",
        dataKey: "cLoad",
        valueUnit: "%",
        function: "Records carbon mass fraction, an indicator of bonded-phase coverage on the packing.",
        category: "Column characteristics",
        controlPoint: "Column selection / installed column.",
        units: "%",
        admissibleRange: "Use the manufacturer's column data sheet.",
        typicalRange: "The 6% value in the notes is an example, not a verified value for every column.",
        retentionEffect: "Higher carbon load generally means more bonded phase and higher retention.",
        selectivityEffect: "Little direct effect.",
        efficiencyEffect: "Lower coverage leaves more free silanols, which can contribute to peak tailing.",
        otherEffects: "A fixed column property, not a normal run-to-run adjustment.",
        whyChange: "Compare column phases only when stationary-phase interaction strength needs optimisation.",
        recommendationWhen: "The decision engine does not independently recommend a carbon-load change."
      },
      {
        name: "Column Length",
        dataKey: "length",
        valueUnit: " mm",
        function: "Sets the packed-bed path length and the number of plates available for separation.",
        category: "Column characteristics",
        controlPoint: "Column selection / installed column.",
        units: "mm",
        admissibleRange: "Column-specific; not specified in the available notes.",
        typicalRange: "Use the dimensions of the installed column.",
        retentionEffect: "Retention time and t0 scale with column length; retention factor k′ is unchanged.",
        selectivityEffect: "Does not usually change intrinsic selectivity, but can improve the observed separation of nearby peaks by providing more separation distance.",
        efficiencyEffect: "Plate number increases with length; resolution rises approximately with the square root of plate number.",
        otherEffects: "Pressure and run time increase with length.",
        whyChange: "Trade additional time and pressure for more resolution.",
        recommendationWhen: "Stage 3 may consider lengthening for low resolution with time margin, or shortening when run time is excessive."
      },
      {
        name: "Column Internal Diameter",
        dataKey: "diameter",
        valueUnit: " mm",
        function: "Sets the internal width of the column bore.",
        category: "Column characteristics",
        controlPoint: "Column selection / installed column.",
        units: "mm",
        admissibleRange: "Column-specific; not specified in the available notes.",
        typicalRange: "Use the dimensions of the installed column.",
        retentionEffect: "A narrower bore shortens t0 and retention time at the same flow; k′ is unchanged.",
        selectivityEffect: "Does not directly change intrinsic selectivity.",
        efficiencyEffect: "Excess extra-column volume can broaden peaks, especially with narrow-bore columns.",
        otherEffects: "Smaller ID raises linear velocity and pressure at fixed flow; scale flow approximately with ID squared.",
        whyChange: "Change for scale or sensitivity, not as a first-line selectivity adjustment.",
        recommendationWhen: "The decision engine does not currently recommend changing column internal diameter."
      },
      {
        name: "Particle Size",
        dataKey: "particleSize",
        valueUnit: " μm",
        function: "Sets the size of the particles packed inside the column.",
        category: "Column characteristics",
        controlPoint: "Column selection / installed column.",
        units: "μm",
        admissibleRange: "Column-specific; not specified in the available notes.",
        typicalRange: "Use the particle size stated for the installed column.",
        retentionEffect: "Does not normally change equilibrium retention directly.",
        selectivityEffect: "Does not normally change intrinsic chemical selectivity.",
        efficiencyEffect: "Smaller particles increase efficiency and can support faster flow.",
        otherEffects: "Pressure rises steeply as particle size falls; halving size can raise pressure about fourfold. Check hardware limits.",
        whyChange: "Consider a smaller particle size when efficiency is insufficient and system pressure allows it.",
        recommendationWhen: "The decision engine does not currently recommend changing particle size."
      },
      {
        name: "Temperature",
        dataKey: "setTemperature",
        valueUnit: "°C",
        function: "Controls the temperature of the column during separation.",
        category: "Column oven",
        controlPoint: "Instrument method: column-oven set temperature.",
        units: "°C",
        admissibleRange: "Use the lower temperature limit of the instrument and column; exact limits are model-specific.",
        typicalRange: "Ambient means Set Temp = 25°C (oven off); the supplied cycle also uses 40°C and 60°C, subject to hardware limits.",
        retentionEffect: "Higher temperature generally lowers reversed-phase retention and solvent viscosity.",
        selectivityEffect: "Compounds respond differently; peak spacing and even elution order can change.",
        efficiencyEffect: "Lower viscosity and faster mass transfer can modestly improve efficiency.",
        otherEffects: "Uncontrolled ambient temperature can shift retention; excess heat may degrade the column or analyte.",
        whyChange: "Change temperature after the prescribed %B cycle when peak count remains below target.",
        recommendationWhen: "After deficient runs at both calculated ambient Minimum %B and Intermediate %B, the staged flow recommends 40°C, followed by 60°C if needed."
      }
    ]
  },
  injector: {
    title: "Manual Injector / Autosampler",
    category: "Sample injection",
    function: "Introduces a measured sample plug into the pressurised mobile phase, manually or from an autosampler vial at a programmed time.",
    description: "Injection occurs after the pump; the INJECT action defines time zero. Manual injection volume is set by the installed loop, while autosampler volume is set in the method.",
    parameters: [
      {
        name: "Injection Volume",
        dataKey: "injectionVolume",
        valueUnit: " μL",
        function: "Sets sample-plug volume entering the mobile phase.",
        category: "Sample injection",
        controlPoint: "Manual: fitted sample-loop volume. Autosampler: injection-volume method setting.",
        units: "μL",
        admissibleRange: "Manual: fixed by loop size. Autosampler: instrument-specific; check its manual.",
        typicalRange: "20 μL in the supplied run conditions; use the method value.",
        retentionEffect: "Little direct effect unless the injection plug is large or its solvent is stronger than the starting mobile phase.",
        selectivityEffect: "No direct chemical selectivity effect; distortion can obscure peak separation.",
        efficiencyEffect: "Excess volume broadens bands and lowers apparent efficiency.",
        otherEffects: "Peak area rises with injected mass until column or detector saturation; carryover can create ghost peaks.",
        whyChange: "Reduce volume to limit broadening/overload; increase only when signal needs it and capacity permits.",
        recommendationWhen: "Not changed by the decision engine; keep it fixed across comparison runs."
      },
      {
        name: "Sample Concentration",
        dataKey: "sampleConc",
        valueUnit: " mg/mL",
        function: "Sets injected analyte mass together with injection volume.",
        category: "Sample injection",
        controlPoint: "Sample preparation before loading a manual injector or autosampler vial.",
        units: "mg/mL",
        admissibleRange: "Sample solubility, detector linearity, and column capacity are method-specific; confirm experimentally.",
        typicalRange: "About 1 mg/mL is cited for one supplied preparation; use the validated sample method.",
        retentionEffect: "Little direct effect until sample mass overloads the column.",
        selectivityEffect: "No direct effect at suitable loading; overload can mask resolution.",
        efficiencyEffect: "Overload can cause fronting/tailing and broader peaks.",
        otherEffects: "Peak area is comparable mainly for the same analyte across injections, not between different analytes.",
        whyChange: "Dilute if overloaded or detector-saturated; keep concentration constant across method-comparison runs.",
        recommendationWhen: "Not changed by the decision engine; maintain it during the decision cycle."
      }
    ]
  },
  detector: {
    title: "Detector (PDA/UV)",
    category: "Detection",
    function: "Measures UV absorbance as compounds elute and records the signal used to form chromatogram peaks.",
    description: "Wavelength affects which compounds are visible, not how the column separates them. A PDA can extract other wavelengths from recorded data; a single-wavelength UV detector generally requires a new run.",
    parameters: [
      {
        name: "Wavelength",
        dataKey: "wavelength",
        valueUnit: " nm",
        function: "Selects the UV wavelength used to measure analyte absorbance.",
        category: "Detection",
        controlPoint: "Instrument method: PDA/UV detector wavelength setting.",
        units: "nm",
        admissibleRange: "Limited by detector optics and analyte absorption; exact instrument limits are not stated in the supplied notes.",
        typicalRange: "254 nm in the supplied method (4 nm bandwidth).",
        retentionEffect: "No direct effect on chromatographic retention.",
        selectivityEffect: "No direct effect on chromatographic selectivity or elution order.",
        efficiencyEffect: "No effect on column efficiency; signal-to-noise affects how reliably peak width can be measured.",
        otherEffects: "A compound with weak absorbance may be missed, so measured peak count is not necessarily compound count. Methanol raises baseline at short UV wavelengths.",
        whyChange: "Change or reprocess wavelength if an expected analyte has weak detector response.",
        recommendationWhen: "Not recommended by the decision engine. Do not use wavelength to resolve co-eluting peaks."
      }
    ]
  }
};
function csvRows(text) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i], next = text[i + 1];
    if (c === '"' && quoted && next === '"') { cell += '"'; i += 1; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && next === "\n") i += 1;
      row.push(cell.trim()); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}
function clean(value) { return String(value ?? "").toLowerCase().replace(/[()[\]{}]/g, "").replace(/\s+/g, " ").trim(); }
function numeric(value) {
  const match = String(value ?? "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}
function rowValue(rows, label) {
  const key = clean(label);
  const row = rows.find(r => clean(r[0]) === key || clean(r[0]).includes(key));
  return row && row[1] !== undefined ? row[1] : "";
}
function labeledValue(rows, names) {
  const aliases = names.map(clean);
  const row = rows.find(candidate => {
    const label = clean(candidate[0]);
    return aliases.some(alias => label === alias || label.startsWith(`${alias} `) || label.startsWith(alias));
  });
  return row && row[1] !== undefined ? row[1] : "";
}
function headerValue(rows, names) {
  if (rows.length < 2) return "";
  const aliases = names.map(clean);
  const index = rows[0].findIndex(value => {
    const header = clean(value);
    return aliases.some(alias => header === alias || header.startsWith(`${alias} `) || header.startsWith(alias));
  });
  return index < 0 ? "" : rows[1][index] ?? "";
}
function traceValues(rows, sectionPattern) {
  const start = rows.findIndex(row => sectionPattern.test(String(row[0] || "")));
  if (start < 0) return { values: [], multiplier: 1 };
  const multiplierRow = rows.find((row, index) => index > start && index < start + 20 && clean(row[0]) === "intensity multiplier");
  const multiplier = multiplierRow ? numeric(multiplierRow[1]) : 1;
  const header = rows.findIndex((row, index) => index > start && clean(row[0]) === "r.time min");
  if (header < 0) return { values: [], multiplier };
  const values = [];
  for (let index = header + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (/^\[/.test(String(row[0] || "")) || numeric(row[0]) === null || numeric(row[1]) === null) break;
    values.push(numeric(row[1]));
  }
  return { values, multiplier };
}
function traceAverageWithin(rows, sectionPattern, endTime) {
  const start = rows.findIndex(row => sectionPattern.test(String(row[0] || "")));
  if (start < 0) return { values: [], startTime: null, endTime: null };
  const header = rows.findIndex((row, index) => index > start && clean(row[0]) === "r.time min");
  if (header < 0) return { values: [], startTime: null, endTime: null };
  const points = [];
  for (let index = header + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const time = numeric(row[0]);
    const value = numeric(row[1]);
    if (/^\[/.test(String(row[0] || "")) || time === null || value === null) break;
    if (time >= 0 && (!Number.isFinite(endTime) || time <= endTime)) points.push({ time, value });
  }
  return {
    values: points.map(point => point.value),
    startTime: points.length ? points[0].time : null,
    endTime: points.length ? points[points.length - 1].time : null
  };
}
function averagedTrace(rows, sectionPattern) {
  const trace = traceValues(rows, sectionPattern);
  if (!trace.values.length) return null;
  return trace.values.reduce((total, value) => total + value, 0) / trace.values.length * trace.multiplier;
}
function roundPressure(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}
const NOISE_AREA_THRESHOLD = 80000;
const MINIMUM_REGRESSION_R2_THRESHOLD = 0.99;
const NAMING_MISMATCH_MESSAGE = "Naming inconsistency detected. Data File Name is used only for comparison; parsed method values continue to come from Sample Name (cell B20).";
function filterNoise(peakRows) {
  const diagnostics = [];
  const retained = peakRows.filter(row => {
    const area = row.area;
    const kept = Number.isFinite(area) && area >= NOISE_AREA_THRESHOLD;
    diagnostics.push({ peak: row.peak, retention: row.retention, area, threshold: NOISE_AREA_THRESHOLD, kept, reason: kept ? "area meets threshold" : "area below threshold" });
    return kept;
  });
  console.groupCollapsed(`[HPLC] Peak noise filter: ${retained.length}/${peakRows.length} peaks retained`);
  console.table(diagnostics);
  console.groupEnd();
  logDebug(`[HPLC] Peak noise filter: ${retained.length}/${peakRows.length} peaks retained (area threshold: ${NOISE_AREA_THRESHOLD} AUC)`, diagnostics);
  return { rows: retained, diagnostics };
}
function parseMethodName(text, data) {
  const parsed = HplcRunNaming.parse(text);
  if (!parsed) return false;
  Object.assign(data, parsed);
  return true;
}
function parsedNomenclature(value) {
  const parsed = {};
  return parseMethodName(value, parsed) ? parsed : null;
}
const NOMENCLATURE_FIELDS = [
  "groupNo", "injectionNo", "hplcNo", "solvent", "phNo", "percentB", "flow",
  "elutionMode", "injectionVolume", "sampleType", "sampleConc", "ligand", "columnType", "length",
  "diameter", "particleSize", "setTemperature", "wavelength"
];
function nomenclatureValueKey(key, value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  if (["groupNo", "injectionNo", "hplcNo", "phNo"].includes(key)) {
    return String(value).trim().replace(/^0+(?=\d)/, "");
  }
  if (key === "solvent") {
    const solvent = String(value).trim().toUpperCase().replace(/[^A-Z]/g, "");
    return solvent === "MEOH" || solvent === "METHANOL" ? "METHANOL" : solvent;
  }
  if (key === "setTemperature" && /^amb(?:ient)?$/i.test(String(value).trim())) return "25";
  const number = numeric(value);
  if (number !== null) return String(number);
  return String(value).trim().toUpperCase();
}
function reconcileNomenclature(sampleName, dataFileName) {
  const sampleValue = parsedNomenclature(sampleName);
  const dataFileValue = parsedNomenclature(dataFileName);
  const parsedSources = [
    { name: "Sample Name", value: sampleValue },
    { name: "Data File Name", value: dataFileValue }
  ].filter(source => source.value);
  const resolved = sampleValue || {};
  const conflicts = {};
  if (sampleName && !sampleValue) conflicts.sampleName = [{ source: "Sample Name", value: sampleName }];
  if (dataFileName && !dataFileValue) conflicts.dataFileName = [{ source: "Data File Name", value: dataFileName }];
  if (!sampleName && dataFileName) {
    conflicts.sampleName = [
      { source: "Sample Name", value: "(missing)" },
      { source: "Data File Name", value: dataFileName }
    ];
  }
  if (sampleValue && dataFileValue) {
    NOMENCLATURE_FIELDS.forEach(key => {
      if (key === "columnType" && (!sampleValue[key] || !dataFileValue[key])) return;
      const sampleKey = nomenclatureValueKey(key, sampleValue[key]);
      const dataFileKey = nomenclatureValueKey(key, dataFileValue[key]);
      if (sampleKey !== dataFileKey) {
        conflicts[key] = [
          { source: "Sample Name", value: sampleValue[key] },
          { source: "Data File Name", value: dataFileValue[key] }
        ];
      }
    });
  } else if (sampleName && dataFileName && (!sampleValue || !dataFileValue)) {
    conflicts.dataFileName = [
      { source: "Sample Name", value: sampleName },
      { source: "Data File Name", value: dataFileName }
    ];
  }
  return { resolved, conflicts, parsedSources };
}
function parseRun(rows, uploadedFileName = "") {
  const b20SampleName = String(rows[19]?.[1] ?? "").trim();
  const sampleName = b20SampleName || rowValue(rows, "sample name");
  const dataFileName = rowValue(rows, "data file name");
  const nomenclature = reconcileNomenclature(sampleName, dataFileName);
  const nomenclatureMismatch = Object.keys(nomenclature.conflicts).length > 0;
  const data = { groupNo: "", injectionNo: "", hplcNo: "", phNo: "", injectionVolume: null, sampleType: "", ligand: "", columnType: "", coreShell: "No", poreSize: "140", cLoad: "6", length: null, diameter: null, particleSize: null, solvent: "", percentB: null, flow: null, sampleConc: "", setTemperature: null, measuredTemperature: null, wavelength: null, peakCount: null, totalTime: null, resolution: null, pressure: null, sampleName, dataFileName, uploadedFileName, nomenclatureMismatch, nomenclatureConflicts: nomenclature.conflicts };
  if (Object.keys(nomenclature.resolved).length) Object.assign(data, nomenclature.resolved);
  const simple = {
    ligand: ["ligand", "stationary phase"], columnType: ["column type"],
    length: ["column length", "length"],
    diameter: ["column internal diameter", "diameter"], particleSize: ["particle size"], solvent: ["solvent type", "solvent"],
    percentB: ["%b", "percent b"], flow: ["flow rate", "flow"], sampleConc: ["sample concentration", "sample conc"],
    setTemperature: ["set temperature", "set temp"], measuredTemperature: ["measured temperature"], wavelength: ["wavelength"]
  };
  Object.entries(simple).forEach(([key, names]) => {
    const value = labeledValue(rows, names) || headerValue(rows, names);
    if (value !== "") data[key] = key === "percentB" ? numeric(value) : value;
  });
  Object.assign(data, nomenclature.resolved);
  if (data.columnType) {
    data.coreShell = /^raptor$/i.test(String(data.columnType).trim()) ? "Yes" : "No";
  }
  data.peakCount = numeric(rowValue(rows, "# of peaks")) ?? numeric(rowValue(rows, "number of peaks"));
  data.peakCount ??= numeric(headerValue(rows, ["peak count", "number of peaks", "no. of peaks"]));
  const peakTableSection = rows.findIndex(row => /^\[Peak Table\b/i.test(String(row[0] || "")));
  const sectionEnd = peakTableSection >= 0
    ? rows.findIndex((row, index) => index > peakTableSection && /^\[/.test(String(row[0] || "")))
    : -1;
  const searchStart = peakTableSection >= 0 ? peakTableSection + 1 : 0;
  const searchEnd = sectionEnd >= 0 ? sectionEnd : rows.length;
  const peakHeader = rows.findIndex((row, index) =>
    index >= searchStart && index < searchEnd && row.some(value => clean(value) === "r.time")
  );
  const peakHeaders = peakHeader >= 0 ? rows[peakHeader].map(clean) : [];
  const columnIndex = names => peakHeaders.findIndex(header => names.includes(header));
  const peakNumberIndex = columnIndex(["peak#", "peak #"]);
  const retentionIndex = columnIndex(["r.time"]);
  const areaIndex = columnIndex(["area"]);
  const heightIndex = columnIndex(["height", "peak height"]);
  const widthIndex = columnIndex(["width", "peak width"]);
  const halfHeightWidthIndex = columnIndex(["w0.5", "w05", "width at half height", "half height width"]);
  const baselineWidthIndex = columnIndex(["wb", "baseline width", "base width"]);
  const plateIndex = columnIndex(["plate#", "plate #", "plate number", "n"]);
  const nameIndex = columnIndex(["name"]);
  const initialTimeIndex = columnIndex(["i.time", "initial time"]);
  const finalTimeIndex = columnIndex(["f.time", "final time"]);
  const resolutionIndex = columnIndex(["resolution", "r.s.", "rs"]);
  const retentionFactorIndex = columnIndex(["k'", "k", "retention factor"]);
  const peakTableRows = peakHeader >= 0 ? rows.slice(peakHeader + 1, searchEnd) : [];
  const extractedPeakRows = peakTableRows
    .filter(row => numeric(row[retentionIndex]) !== null && areaIndex >= 0)
    .map(row => ({
      peak: peakNumberIndex >= 0 ? row[peakNumberIndex] : "",
      retention: numeric(row[retentionIndex]),
      area: numeric(row[areaIndex]),
      height: heightIndex >= 0 ? numeric(row[heightIndex]) : null,
      width: widthIndex >= 0 ? numeric(row[widthIndex]) : null,
      halfHeightWidth: halfHeightWidthIndex >= 0 ? numeric(row[halfHeightWidthIndex]) : null,
      baselineWidth: baselineWidthIndex >= 0 ? numeric(row[baselineWidthIndex]) : null,
      plateNumber: plateIndex >= 0 ? numeric(row[plateIndex]) : null,
      initialTime: initialTimeIndex >= 0 ? numeric(row[initialTimeIndex]) : null,
      finalTime: finalTimeIndex >= 0 ? numeric(row[finalTimeIndex]) : null,
      name: nameIndex >= 0 ? row[nameIndex] : "",
      resolution: resolutionIndex >= 0 ? numeric(row[resolutionIndex]) : null,
      retentionFactor: retentionFactorIndex >= 0 ? numeric(row[retentionFactorIndex]) : null
    }));
  data.peaks = extractedPeakRows;
  const noiseFilter = filterNoise(extractedPeakRows);
  const peakRows = noiseFilter.rows;
  const retentions = peakRows.map(row => row.retention).filter(Number.isFinite);
  const resolutions = peakRows.map(row => row.resolution).filter(value => Number.isFinite(value) && value > 0);
  data.peakCount = peakRows.length || null;
  data.totalTime = numeric(rowValue(rows, "end time(min)")) ?? (retentions.length ? Math.max(...retentions) : null);
  data.totalTime ??= numeric(headerValue(rows, ["total retention time", "run time", "last retention time"]));
  data.resolution = resolutions.length ? Math.min(...resolutions) : null;
  data.resolution ??= numeric(headerValue(rows, ["resolution", "rs"]));
  data.pressure = roundPressure(averagedTrace(rows, /^\[LC Status Trace\(Pump A Pressure\)\]$/i));
  data.pressure ??= roundPressure(numeric(headerValue(rows, ["back pressure", "back-pressure", "pressure"])));
  const ovenTrace = traceAverageWithin(rows, /^\[LC Status Trace\(Oven Temp\.\)\]$/i, data.totalTime);
  const measuredTemperature = ovenTrace.values.length
    ? Number((ovenTrace.values.reduce((total, value) => total + value, 0) / ovenTrace.values.length).toFixed(2))
    : null;
  data.measuredTemperature = measuredTemperature ?? numeric(rowValue(rows, "measured temperature"));
  logDebug("[HPLC] Oven temperature trace", {
    startTime: ovenTrace.startTime,
    endTime: ovenTrace.endTime,
    totalRetentionTime: data.totalTime,
    sampleCount: ovenTrace.values.length,
    averageTemperature: measuredTemperature
  });
  data.wavelength = data.wavelength || numeric(rowValue(rows, "wavelength(nm)"));
  data.t0 = retentions.length ? Math.min(...retentions) : null;
  data.lastPeakRetention = retentions.length ? Math.max(...retentions) : null;
  console.groupCollapsed(`[HPLC] Extracted run ${data.groupNo || "?"}-${data.injectionNo || "?"}`);
  console.log("Method/sample:", sampleName);
  console.log("Raw peak rows:", extractedPeakRows.length);
  console.log("Filtered peak rows:", peakRows.length);
  console.log("Derived values:", { peakCount: data.peakCount, totalTime: data.totalTime, t0: data.t0, lastPeakRetention: data.lastPeakRetention, resolution: data.resolution, pressure: data.pressure, setTemperature: data.setTemperature, measuredTemperature: data.measuredTemperature, ovenTrace: { startTime: ovenTrace.startTime, endTime: ovenTrace.endTime, sampleCount: ovenTrace.values.length, average: measuredTemperature } });
  console.groupEnd();
  logDebug(`[HPLC] Extracted run ${data.groupNo || "?"}-${data.injectionNo || "?"}`, {
    sampleName,
    sampleNameSource: b20SampleName ? "Cell B20" : "Sample Name label fallback",
    dataFileName,
    uploadedFileName,
    nomenclatureMismatch,
    nomenclatureConflicts: nomenclature.conflicts,
    nomenclatureSources: nomenclature.parsedSources.map(source => ({
      name: source.name,
      values: Object.fromEntries(NOMENCLATURE_FIELDS.map(key => [key, source.value[key]]))
    })),
    rawPeakRows: extractedPeakRows.length,
    filteredPeakRows: peakRows.length,
    peakCount: data.peakCount,
    totalTime: data.totalTime,
    filteredFirstPeakT0: data.t0,
    filteredLastPeakTR: data.lastPeakRetention,
    t0: data.t0,
    lastPeakRetention: data.lastPeakRetention,
    resolution: data.resolution,
    pressure: data.pressure,
    setTemperature: data.setTemperature,
    measuredTemperature: data.measuredTemperature
  });
  return data;
}
function specifications() {
  const parse = id => {
    const raw = $(id).value.trim();
    if (!raw || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return { peaks: parse("peakSpec"), time: parse("timeSpec"), resolution: parse("resolutionSpec"), pressure: parse("pressureSpec") };
}
const specificationFields = [
  { id: "peakSpec", key: "peaks", label: "Target number of compounds/peaks", unit: "peaks" },
  { id: "timeSpec", key: "time", label: "Maximum Run Time", unit: "min" },
  { id: "resolutionSpec", key: "resolution", label: "Minimum Resolution", unit: "Rmin" },
  { id: "pressureSpec", key: "pressure", label: "Maximum Back-pressure", unit: "psi" }
];
function validateMethodSpecifications() {
  const values = specifications();
  const issues = [];
  const enteredValue = id => $(id).value.trim() || "(empty)";
  const addIssue = (field, message) => issues.push({
    ...field,
    entered: enteredValue(field.id),
    message
  });
  const peaksField = specificationFields[0];
  const timeField = specificationFields[1];
  const resolutionField = specificationFields[2];
  const pressureField = specificationFields[3];
  if (values.peaks === null) {
    addIssue(peaksField, "must be a finite number.");
  } else if (!Number.isInteger(values.peaks) || values.peaks <= 0) {
    addIssue(peaksField, "must be a positive integer greater than 0.");
  }
  if (values.time === null) {
    addIssue(timeField, "must be a finite number.");
  } else if (values.time <= 0) {
    addIssue(timeField, "must be greater than 0 minutes.");
  }
  if (values.resolution === null) {
    addIssue(resolutionField, "must be a finite number.");
  } else if (values.resolution < 0) {
    addIssue(resolutionField, "must be non-negative.");
  }
  if (values.pressure === null) {
    addIssue(pressureField, "must be a finite number in psi.");
  } else if (values.pressure <= 0) {
    addIssue(pressureField, "must be greater than 0 psi.");
  }
  return { valid: issues.length === 0, values, issues };
}
function clearTrialRecommendations() {
  trials.forEach(trial => {
    trial.recommendation = null;
    trial.nextPercentB = null;
    trial.minimumPercentBResult = null;
    trial.intermediatePercentBResult = null;
    trial.prediction = null;
    trial.sequencePlan = null;
  });
}
function renderSpecificationValidation(validation, state = specificationValidationState) {
  specificationValidationState = state;
  const status = $("specValidationStatus");
  const warning = $("specValidationWarning");
  const issueList = $("specValidationIssues");
  const decisionStatus = $("decisionValidationStatus");
  const decisionWarning = $("decisionValidationWarning");
  const decisionIssueList = $("decisionValidationIssues");
  const stateClass = state === "VALID" ? "status-valid"
    : state === "INVALID" ? "status-invalid"
      : "status-not-yet-validated";
  status.className = `validation-state ${stateClass}`;
  status.textContent = state === "VALID"
    ? "VALID — All method specifications are present and valid. The decision engine may run."
    : state === "INVALID"
      ? "INVALID — Decision generation is paused until all method specifications are corrected."
      : "NOT YET VALIDATED — Run analysis to validate these method specifications.";
  warning.hidden = state !== "INVALID";
  decisionWarning.hidden = state !== "INVALID";
  issueList.innerHTML = "";
  decisionIssueList.innerHTML = "";
  specificationFields.forEach(field => {
    const input = $(field.id);
    const inlineError = $(`${field.id}Error`);
    const issue = validation.issues.find(item => item.id === field.id);
    input.classList.toggle("specification-invalid", Boolean(issue));
    input.setAttribute("aria-invalid", String(Boolean(issue)));
    inlineError.hidden = !issue;
    inlineError.textContent = issue ? `${issue.message} Entered: ${issue.entered} ${field.unit}.` : "";
  });
  validation.issues.forEach(issue => {
    const item = document.createElement("li");
    item.textContent = `${issue.label} ${issue.message} Entered: ${issue.entered} ${issue.unit}.`;
    issueList.append(item);
    decisionIssueList.append(item.cloneNode(true));
  });
  decisionStatus.className = `decision-validation-status ${stateClass}`;
  decisionStatus.textContent = state === "VALID"
    ? "VALID — Recommendations were generated using the current method specifications."
    : state === "INVALID"
      ? "INVALID — No recommendations are available until method specifications pass validation."
      : "NOT YET VALIDATED — Recommendations are withheld until the current specifications are validated.";
}
function markSpecificationsEdited() {
  specificationRevision += 1;
  const validation = validateMethodSpecifications();
  clearTrialRecommendations();
  renderSpecificationValidation(validation, validation.valid ? "NOT YET VALIDATED" : "INVALID");
  renderTrials();
  renderEquipment();
}
function runAnalysis() {
  const requestId = ++analysisRequestId;
  const revision = specificationRevision;
  const validation = validateMethodSpecifications();
  if (!validation.valid) {
    clearTrialRecommendations();
    renderSpecificationValidation(validation, "INVALID");
    renderTrials();
    renderEquipment();
    return false;
  }
  if (pendingRunFile) {
    const file = pendingRunFile;
    return readFile(file).then(rows => {
      const currentValidation = validateMethodSpecifications();
      if (requestId !== analysisRequestId || revision !== specificationRevision) return false;
      if (!currentValidation.valid) {
        clearTrialRecommendations();
        renderSpecificationValidation(currentValidation, "INVALID");
        renderTrials();
        renderEquipment();
        return false;
      }
      const data = parseRun(rows, file.name);
      pendingRunFile = null;
      data.solventConversion = solventConversionForRecordedRun(data, trials);
      renderSpecificationValidation(validation, "VALID");
      trials.push(data);
      persistUploadedTrials();
      currentViewedTrialIndex = null;
      parameterTrialIndex = trials.length - 1;
      renderParameters(data);
      trials.forEach(updateRecommendation);
      renderTrials();
      renderEquipment();
      return true;
    }).catch(error => {
      if (requestId !== analysisRequestId) return false;
      $("error").textContent = error.message;
      $("error").hidden = false;
      return false;
    });
  }
  renderSpecificationValidation(validation, "VALID");
  $("error").hidden = true;
  trials.forEach(updateRecommendation);
  renderTrials();
  renderEquipment();
  return true;
}
function measurementStatus(value, limit, comparison) {
  if (!Number.isFinite(value) || !Number.isFinite(limit)) return { label: "NOT AVAILABLE", className: "status-unavailable" };
  const passed = comparison === "minimum" ? value >= limit : value <= limit;
  return { label: passed ? "PASS" : "FAIL", className: passed ? "status-pass" : "status-fail" };
}
function runMeasurementStatuses(data) {
  const peakTarget = specifications().peaks;
  if (Number.isFinite(data.peakCount) && Number.isFinite(peakTarget) && data.peakCount < peakTarget) {
    const resolutionNotAssessed = { label: "NOT ASSESSED", className: "status-not-assessed" };
    if (specificationValidationState !== "VALID") {
      const unvalidated = { label: "NOT VALIDATED", className: "status-unavailable" };
      return {
        peakCount: unvalidated,
        retentionTime: unvalidated,
        resolution: resolutionNotAssessed,
        pressure: unvalidated
      };
    }
  }
  if (specificationValidationState !== "VALID") {
    const unvalidated = { label: "NOT VALIDATED", className: "status-unavailable" };
    return {
      peakCount: unvalidated,
      retentionTime: unvalidated,
      resolution: unvalidated,
      pressure: unvalidated
    };
  }
  const spec = specifications();
  const resolutionStatus = Number.isFinite(data.peakCount) && data.peakCount < spec.peaks
    ? { label: "NOT ASSESSED", className: "status-not-assessed" }
    : measurementStatus(data.resolution, spec.resolution, "minimum");
  return {
    peakCount: measurementStatus(data.peakCount, spec.peaks, "minimum"),
    retentionTime: measurementStatus(decisionRunTime(data), spec.time, "maximum"),
    resolution: resolutionStatus,
    pressure: measurementStatus(data.pressure, spec.pressure, "maximum")
  };
}
function roundMinimumPercentB(value) {
  return Math.ceil(value);
}
function sameRunSeries(trial, reference) {
  const sameValue = key => {
    const expected = String(reference?.[key] ?? "").trim().toUpperCase();
    return !expected || String(trial[key] ?? "").trim().toUpperCase() === expected;
  };
  return sameValue("groupNo") && sameValue("hplcNo");
}
function predictionHistory(history, reference) {
  const referenceIndex = history.indexOf(reference);
  const eligibleHistory = referenceIndex >= 0 ? history.slice(0, referenceIndex + 1) : history;
  return eligibleHistory.filter(trial =>
    !trial.isSuggested &&
    sameRunSeries(trial, reference) &&
    (!reference || sameSolvent(trial.solvent, reference.solvent)) &&
    Number(trial.setTemperature) === 25 &&
    Number.isFinite(trial.percentB) &&
    trial.percentB > 0
  );
}
function minimumRetentionCycle(history = trials, reference = history.filter(trial => !trial.isSuggested).at(-1)) {
  const ambientRuns = predictionHistory(history, reference)
    .map((trial, index) => ({ trial, index, injection: numeric(trial.injectionNo) }))
    .sort((left, right) => left.injection !== null && right.injection !== null
      ? left.injection - right.injection || left.index - right.index
      : left.index - right.index)
    .map(entry => entry.trial);
  const cycles = [];
  let cycle = [];
  ambientRuns.forEach(trial => {
    const previous = cycle[cycle.length - 1];
    const step = previous ? Number(previous.percentB) - Number(trial.percentB) : null;
    if (!previous || Math.abs(step - 10) < 0.01) {
      cycle.push(trial);
    } else {
      if (cycle.length) cycles.push(cycle);
      cycle = [trial];
    }
  });
  if (cycle.length) cycles.push(cycle);
  return cycles.at(-1) || [];
}
function formatMinimumRegressionRuns(points) {
  const columns = [
    ["RUN", point => `R${String(point.index + 1).padStart(2, "0")} (Injection ${point.trial.injectionNo || "?"})`],
    ["%B", point => Number.isFinite(point.x) ? String(point.x) : "NA"],
    ["T0 (MIN)", point => Number.isFinite(point.t0) ? point.t0.toFixed(3) : "NA"],
    ["TR (MIN)", point => Number.isFinite(point.retention) ? point.retention.toFixed(3) : "NA"],
    ["K", point => Number.isFinite(point.k) ? point.k.toFixed(6) : "NA"],
    ["LOG10(K)", point => Number.isFinite(point.y) ? point.y.toFixed(6) : "NA"],
    ["PRESSURE (PSI)", point => Number.isFinite(point.pressure) ? point.pressure.toFixed(3) : "NA"],
    ["FIT STATUS", point => point.fitStatus]
  ];
  const values = points.map(point => columns.map(([, getValue]) => getValue(point)));
  const widths = columns.map(([heading], index) =>
    Math.max(heading.length, ...values.map(row => row[index].length))
  );
  const formatRow = row => row.map((value, index) => value.padEnd(widths[index])).join(" | ");
  return [formatRow(columns.map(([heading]) => heading)), widths.map(width => "-".repeat(width)).join("-+-"), ...values.map(formatRow)].join("\n");
}
function minimumPercentB(history = trials, reference = history.filter(trial => !trial.isSuggested).at(-1)) {
  const ambientRuns = minimumRetentionCycle(history, reference);
  if (!ambientRuns.length) {
    const result = MINIMUM_INTERMEDIATE_NOT_ENOUGH_RUNS;
    logDebug("[HPLC] Minimum-%B result", result);
    return result;
  }
  const pointCandidates = ambientRuns.map((trial, index) => {
    const t0 = Number.isFinite(trial.t0) && trial.t0 > 0 ? trial.t0 : null;
    const retention = Number.isFinite(trial.lastPeakRetention) ? trial.lastPeakRetention : null;
    const k = t0 !== null && retention !== null ? (retention - t0) / t0 : null;
    const usable = Number.isFinite(trial.percentB) && trial.percentB > 0 && k !== null && k > 0;
    return {
      x: trial.percentB,
      y: usable ? Math.log10(k) : null,
      t0,
      retention,
      k,
      pressure: trial.pressure,
      trial,
      index,
      usable,
      fitStatus: usable
        ? "Pending fit"
        : `Excluded: ${!Number.isFinite(trial.percentB) || trial.percentB <= 0
          ? "invalid %B"
          : t0 === null
            ? "no filtered peak for t0"
            : retention === null
              ? "no filtered peak for tR"
              : "tR must be later than t0"}`,
      reason: usable
        ? "included"
        : !Number.isFinite(trial.percentB) || trial.percentB <= 0
          ? "invalid %B"
          : t0 === null
            ? "first filtered peak t0 is missing or invalid"
            : retention === null
              ? "last-peak retention is missing"
              : "last filtered peak retention is not later than first filtered peak t0 (k <= 0)"
    };
  });
  const points = pointCandidates.filter(point => point.usable);
  logDebug("[HPLC] Ambient minimum-%B input validation", pointCandidates.map(point => ({
    groupNo: point.trial.groupNo,
    hplcNo: point.trial.hplcNo,
    injectionNo: point.trial.injectionNo,
    percentB: point.x,
    setTemperature: point.trial.setTemperature,
    t0: point.t0,
    lastPeakRetention: point.retention,
    k: point.k,
    pressure: point.pressure,
    usable: point.usable,
    reason: point.reason
  })));
  logDebug("[HPLC] Ambient minimum-%B inputs", points.map(point => ({
    groupNo: point.trial.groupNo,
    hplcNo: point.trial.hplcNo,
    injectionNo: point.trial.injectionNo,
    percentB: point.x,
    setTemperature: point.trial.setTemperature,
    t0: point.t0,
    retention: point.retention,
    k: point.k,
    log10K: point.y,
    pressure: point.pressure
  })));
  logDebug("[HPLC] Minimum-%B applicable ambient retention cycle", ambientRuns.map(trial => ({
    groupNo: trial.groupNo,
    hplcNo: trial.hplcNo,
    injectionNo: trial.injectionNo,
    percentB: trial.percentB,
    solvent: trial.solvent,
    ligand: trial.ligand,
    t0: trial.t0,
    lastPeakRetention: trial.lastPeakRetention,
    pressure: trial.pressure
  })));
  if (points.length < 3) {
    pointCandidates.filter(point => point.usable).forEach(point => {
      point.fitStatus = "Not fitted: fewer than 3 usable runs";
    });
    const result = MINIMUM_INTERMEDIATE_NOT_ENOUGH_RUNS;
    logDebug("[HPLC] Minimum-%B regression run table", formatMinimumRegressionRuns(pointCandidates));
    logDebug("[HPLC] Minimum-%B result", {
      result,
      reason: "at least three ambient runs with usable first/last noise-filtered peak retentions are required for an R²-checked regression",
      ambientCycleRuns: ambientRuns.length,
      usableRegressionPoints: points.length
    });
    return result;
  }
  const fit = values => {
    const meanX = values.reduce((sum, point) => sum + point.x, 0) / values.length;
    const meanY = values.reduce((sum, point) => sum + point.y, 0) / values.length;
    const denominator = values.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    if (!denominator) return null;
    const a = values.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
    const b = meanY - a * meanX;
    const ssTotal = values.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
    const ssResidual = values.reduce((sum, point) => sum + (point.y - (a * point.x + b)) ** 2, 0);
    return { a, b, r2: ssTotal === 0 ? 1 : 1 - ssResidual / ssTotal };
  };
  let usable = points;
  const removed = [];
  while (usable.length > 3) {
    const model = fit(usable);
    if (!model || model.r2 >= MINIMUM_REGRESSION_R2_THRESHOLD) break;
    let best = null;
    usable.forEach((point, index) => {
      const candidate = usable.filter((_, candidateIndex) => candidateIndex !== index);
      const candidateModel = fit(candidate);
      if (candidateModel && (!best || candidateModel.r2 > best.model.r2)) best = { point, model: candidateModel };
    });
    if (!best || best.model.r2 <= model.r2) break;
    best.point.fitStatus = "Removed to improve R²";
    removed.push({ percentB: best.point.x, log10K: best.point.y, injectionNo: best.point.trial.injectionNo });
    usable = usable.filter(point => point !== best.point);
  }
  const model = fit(usable);
  const targetRetention = specifications().time;
  const averageT0 = usable.reduce((sum, point) => sum + point.t0, 0) / usable.length;
  const targetK = (targetRetention - averageT0) / averageT0;
  const targetLog10K = targetK > 0 ? Math.log10(targetK) : null;
  const predictedPercentB = model && Number.isFinite(targetLog10K) && model.a !== 0
    ? (targetLog10K - model.b) / model.a
    : null;
  const validFit = Boolean(
    model &&
    usable.length >= 3 &&
    model.r2 >= MINIMUM_REGRESSION_R2_THRESHOLD &&
    Number.isFinite(model.a) &&
    model.a !== 0 &&
    Number.isFinite(targetLog10K) &&
    Number.isFinite(predictedPercentB)
  );
  const withinPercentBRange = validFit && predictedPercentB >= 0 && predictedPercentB <= 100;
  const result = withinPercentBRange
    ? roundMinimumPercentB(predictedPercentB)
    : validFit
      ? "NA% (Predicted %B Outside 0–100% Range)"
      : `NA% (R² < ${MINIMUM_REGRESSION_R2_THRESHOLD.toFixed(2)})`;
  usable.forEach(point => {
    point.fitStatus = validFit ? "Included in fit" : `Included; final R² below ${MINIMUM_REGRESSION_R2_THRESHOLD.toFixed(2)}`;
  });
  logDebug("[HPLC] Minimum-%B regression run table", formatMinimumRegressionRuns(pointCandidates));
  logDebug("[HPLC] Minimum-%B regression", {
    formula: "k = (targetRetention - averageT0) / averageT0; log10(k) = slope * %B + intercept; %B = (log10(k) - intercept) / slope",
    used: usable.map(point => ({ percentB: point.x, log10K: point.y })),
    removed,
    slope: model && model.a,
    intercept: model && model.b,
    r2: model && model.r2,
    r2Threshold: MINIMUM_REGRESSION_R2_THRESHOLD,
    targetRetention,
    averageT0,
    targetK,
    targetLog10K,
    predictedPercentB,
    admissiblePercentBRange: [0, 100],
    withinPercentBRange
  });
  if (!validFit) {
    logDebug("[HPLC] Minimum-%B result", result);
    return result;
  }
  logDebug("[HPLC] Minimum-%B result", { result, r2: model.r2, targetRetention, averageT0, targetK, targetLog10K });
  return result;
}
function intermediatePercentBCandidates(history = trials, reference = history.filter(trial => !trial.isSuggested).at(-1)) {
  const runs = intermediateObservationRuns(history, reference);
  const candidates = [];
  for (let index = 0; index < runs.length - 1; index += 1) {
    const higher = runs[index];
    const lower = runs[index + 1];
    if (Number(higher.percentB) - Number(lower.percentB) !== 10) continue;
    const percentB = (Number(higher.percentB) + Number(lower.percentB)) / 2;
    if (percentB >= 0 && percentB <= 100) {
      candidates.push({ percentB, higherPercentB: higher.percentB, lowerPercentB: lower.percentB });
    }
  }
  logDebug("[HPLC] Intermediate-%B observation candidates", {
    actualRetentionCycle: runs.map(trial => ({
      injectionNo: trial.injectionNo,
      percentB: trial.percentB,
      peakCount: trial.peakCount,
      lastPeakRetention: trial.lastPeakRetention
    })),
    candidates,
    status: "Candidates are optional prompts only; the user must compare the peak positions and confirm a value."
  });
  return candidates;
}
function intermediateObservationRuns(history = trials, reference = history.filter(trial => !trial.isSuggested).at(-1)) {
  const referenceIndex = history.indexOf(reference);
  const applicableHistory = referenceIndex >= 0 ? history.slice(0, referenceIndex + 1) : history;
  const seriesHistory = applicableHistory.filter(trial => sameRunSeries(trial, reference));
  const base = seriesHistory[0] || reference;
  if (!base) return [];
  const initialRuns = actualRunsForStage(seriesHistory, strategyStages(base, seriesHistory)[0]);
  const sequence = HplcStageSequence.evaluateOrderedSequence(INITIAL_PERCENT_INVESTIGATION, initialRuns);
  return sequence.complete ? sequence.matchedRuns : minimumRetentionCycle(applicableHistory, reference);
}
function decisionRunTime(data) {
  return Number.isFinite(data.lastPeakRetention) ? data.lastPeakRetention : data.totalTime;
}
function predictedRuntimeAtLowerPercentB(data, targetPercentB) {
  const setTemperature = Number(data.setTemperature);
  const runtime = decisionRunTime(data);
  const trialIndex = trials.indexOf(data);
  if (trialIndex < 0 || !Number.isFinite(setTemperature) || !Number.isFinite(runtime) || !Number.isFinite(data.percentB)) return null;
  const sameTemperatureRuns = trials.slice(0, trialIndex + 1).filter(trial =>
    !trial.isSuggested &&
    Number(trial.setTemperature) === setTemperature &&
    String(trial.groupNo || "").trim().toUpperCase() === String(data.groupNo || "").trim().toUpperCase() &&
    String(trial.hplcNo || "").trim().toUpperCase() === String(data.hplcNo || "").trim().toUpperCase() &&
    sameSolvent(trial.solvent, data.solvent) &&
    Number.isFinite(trial.percentB) &&
    Number.isFinite(decisionRunTime(trial))
  );
  const cycles = [];
  let cycle = [];
  sameTemperatureRuns.forEach(trial => {
    const previous = cycle[cycle.length - 1];
    if (!previous || trial.percentB < previous.percentB) {
      cycle.push(trial);
    } else {
      if (cycle.length) cycles.push(cycle);
      cycle = [trial];
    }
  });
  if (cycle.length) cycles.push(cycle);
  const matchingCycle = cycles.find(candidate => candidate.includes(data));
  if (!matchingCycle || matchingCycle.length < 2) return null;
  const currentRunIndex = matchingCycle.indexOf(data);
  const latestRuns = matchingCycle.slice(Math.max(0, currentRunIndex - 1), currentRunIndex + 1);
  if (latestRuns.length < 2) return null;
  const [previous, latest] = latestRuns;
  const percentDifference = latest.percentB - previous.percentB;
  if (percentDifference === 0) return null;
  const runtimePerPercent = (decisionRunTime(latest) - decisionRunTime(previous)) / percentDifference;
  const predicted = runtime + runtimePerPercent * (targetPercentB - data.percentB);
  return Number.isFinite(predicted) ? predicted : null;
}
const STRATEGY_RECOMMENDATIONS = [
  "",
  "Change Temperature to 40 degrees/ Run previous %B",
  "Change Temperature to 60 degrees/ Run previous %B",
  "Change Solvent/ Run previous %B At Ambient Temperature",
  "Change Solvent/Change Temperature to 40 degrees/ Run previous %B",
  "Change Solvent/Change Temperature to 60 degrees/ Run previous %B",
  "Change Solvent to Mix At Ambient Temperature/ Run previous %B",
  "Mixed Solvent/Change Temperature to 40 degrees/ Run previous %B",
  "Mixed Solvent/Change Temperature to 60 degrees/ Run previous %B",
  "Change Ligand/ Run previous %B"
];
function strategyPercentOptions(history = trials, reference = history.filter(trial => !trial.isSuggested).at(-1)) {
  const confirmedIntermediate = history.find(trial =>
    sameRunSeries(trial, reference) &&
    sameSolvent(trial.solvent, reference?.solvent) &&
    Number(trial.setTemperature) === 25 &&
    Number.isFinite(trial.confirmedIntermediatePercentB)
  )?.confirmedIntermediatePercentB;
  const runs = intermediateObservationRuns(history, reference);
  const values = runs.map(trial => trial.percentB);
  if (Number.isFinite(confirmedIntermediate)) values.push(confirmedIntermediate);
  return HplcStageSequence.uniqueDescendingPercentages(values);
}
function sameSolvent(left, right) {
  return String(left || "").trim().toUpperCase().replace(/[^A-Z]/g, "") ===
    String(right || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
}
function solventConversionForRecordedRun(data, history) {
  if (!sameSolvent(data.solvent, "METHANOL") || !Number.isFinite(data.percentB)) return null;
  const matchingAcetonitrileRun = history
    .filter(trial => {
      if (trial.isSuggested ||
          !sameSolvent(trial.solvent, "ACN") ||
          String(trial.groupNo || "").trim() !== String(data.groupNo || "").trim() ||
          String(trial.hplcNo || "").trim() !== String(data.hplcNo || "").trim() ||
          String(trial.ligand || "").trim().toUpperCase() !== String(data.ligand || "").trim().toUpperCase() ||
          !Number.isFinite(trial.percentB)) return false;
      const convertedPercentB = HplcStageSequence.convertAcetonitrilePercentToMethanol(trial.percentB);
      return convertedPercentB !== null && Math.abs(convertedPercentB - data.percentB) < 0.01;
    })
    .at(-1);
  if (!matchingAcetonitrileRun) return null;
  const convertedPercentB = HplcStageSequence.convertAcetonitrilePercentToMethanol(matchingAcetonitrileRun.percentB);
  if (convertedPercentB === null || Math.abs(convertedPercentB - data.percentB) >= 0.01) return null;
  return {
    fromPercentB: matchingAcetonitrileRun.percentB,
    toPercentB: data.percentB
  };
}
function strategyStages(base, history = trials) {
  const originalSolvent = String(base.solvent || "ACN").trim();
  const changedSolvent = history.filter(trial =>
    Number(trial.setTemperature) === 25 &&
    String(trial.ligand || "").trim().toUpperCase() === String(base.ligand || "").trim().toUpperCase() &&
    /^(ACN|METHANOL|MEOH)$/i.test(String(trial.solvent || "").trim()) &&
    !sameSolvent(trial.solvent, originalSolvent)
  ).at(-1)?.solvent;
  const alternateSolvent = changedSolvent ||
    (/^ACN$/i.test(originalSolvent) ? "METHANOL" : "ACN");
  const mixedSolvent = history
    .filter(trial => Number(trial.setTemperature) === 25 &&
      String(trial.ligand || "").trim().toUpperCase() === String(base.ligand || "").trim().toUpperCase() &&
      isMixedSolvent(trial.solvent, originalSolvent, alternateSolvent))
    .at(-1)?.solvent || "MIX";
  return [
    { solvent: originalSolvent, temperature: 25, ligand: base.ligand, recommendation: "" },
    { solvent: originalSolvent, temperature: 40, ligand: base.ligand, recommendation: STRATEGY_RECOMMENDATIONS[1] },
    { solvent: originalSolvent, temperature: 60, ligand: base.ligand, recommendation: STRATEGY_RECOMMENDATIONS[2] },
    { solvent: alternateSolvent, temperature: 25, ligand: base.ligand, recommendation: STRATEGY_RECOMMENDATIONS[3] },
    { solvent: alternateSolvent, temperature: 40, ligand: base.ligand, recommendation: STRATEGY_RECOMMENDATIONS[4] },
    { solvent: alternateSolvent, temperature: 60, ligand: base.ligand, recommendation: STRATEGY_RECOMMENDATIONS[5] },
    { solvent: mixedSolvent, temperature: 25, ligand: base.ligand, recommendation: STRATEGY_RECOMMENDATIONS[6] },
    { solvent: mixedSolvent, temperature: 40, ligand: base.ligand, recommendation: STRATEGY_RECOMMENDATIONS[7] },
    { solvent: mixedSolvent, temperature: 60, ligand: base.ligand, recommendation: STRATEGY_RECOMMENDATIONS[8] }
  ];
}
function isMixedSolvent(solvent, originalSolvent, alternateSolvent) {
  const normalized = String(solvent || "").trim();
  return /MIX/i.test(normalized) ||
    (/ACN/i.test(normalized) && /METHANOL|MEOH/i.test(normalized)) ||
    (Boolean(normalized) && !sameSolvent(normalized, originalSolvent) && !sameSolvent(normalized, alternateSolvent));
}
function matchesStage(trial, stage) {
  const solventMatches = sameSolvent(trial.solvent, stage.solvent);
  const ligandMatches = stage.ligand === ""
    ? /^[ABCD]$/i.test(String(trial.ligand || "").trim())
    : String(trial.ligand || "").trim().toUpperCase() === String(stage.ligand || "").trim().toUpperCase();
  return solventMatches &&
    Number(trial.setTemperature) === stage.temperature &&
    ligandMatches;
}
const INITIAL_PERCENT_INVESTIGATION = [100, 90, 80, 70, 60, 50, 40];
function actualRunsForStage(history, stage) {
  return history
    .filter(trial => !trial.isSuggested && matchesStage(trial, stage))
    .map((trial, index) => ({ trial, index, injection: numeric(trial.injectionNo) }))
    .sort((left, right) => left.injection !== null && right.injection !== null
      ? left.injection - right.injection || left.index - right.index
      : left.index - right.index)
    .map(entry => entry.trial);
}
function mandatorySequencePlan(data, history) {
  const spec = specifications();
  const seriesHistory = history.filter(trial => sameRunSeries(trial, data));
  const base = seriesHistory[0];
  if (!base) return null;
  const stages = strategyStages(base, seriesHistory);
  const ambientRuns = actualRunsForStage(seriesHistory, stages[0]);
  const initialSequence = HplcStageSequence.evaluateOrderedSequence(
    INITIAL_PERCENT_INVESTIGATION,
    ambientRuns
  );
  if (!initialSequence.complete) {
    return {
      kind: "initial",
      percentB: initialSequence.nextPercentB,
      recommendation: `Initial ambient %B sequence: test ${initialSequence.nextPercentB}% B`
    };
  }
  if (HplcStageSequence.targetWasMet(ambientRuns, spec.peaks)) {
    return {
      kind: "stopped",
      recommendation: "A run in the initial %B sequence met the peak target; selectivity progression is stopped."
    };
  }

  const baselineCycle = minimumRetentionCycle(
    initialSequence.matchedRuns,
    initialSequence.matchedRuns.at(-1)
  );
  const minimum = minimumPercentB(baselineCycle, baselineCycle.at(-1));
  const intermediateCandidates = intermediatePercentBCandidates(baselineCycle, baselineCycle.at(-1));
  data.minimumPercentBResult = minimum;
  data.intermediatePercentBResult = null;
  if (!Number.isFinite(minimum)) {
    return {
      kind: "blocked",
      recommendation: `Mandatory Minimum %B cannot be calculated from the completed 100–40% B ambient sequence (${minimum}).`
    };
  }

  const ambientAfterInitial = ambientRuns.slice(initialSequence.lastMatchedIndex + 1);
  const minimumSequence = HplcStageSequence.evaluateOrderedSequence([minimum], ambientAfterInitial);
  if (!minimumSequence.complete) {
    return {
      kind: "minimum",
      percentB: minimum,
      minimum,
      intermediate: null,
      recommendation: `Mandatory sequence: test calculated Minimum %B (${minimum}%)`
    };
  }
  if (HplcStageSequence.targetWasMet(ambientAfterInitial, spec.peaks)) {
    return {
      kind: "stopped",
      recommendation: "The Minimum %B run met the peak target; selectivity progression is stopped."
    };
  }
  const confirmedIntermediate = [...seriesHistory].reverse().find(trial =>
    Number.isFinite(trial.confirmedIntermediatePercentB) &&
    trial.confirmedIntermediatePercentB >= 0 &&
    trial.confirmedIntermediatePercentB <= 100 &&
    Number(trial.setTemperature) === 25 &&
    sameSolvent(trial.solvent, base.solvent)
  )?.confirmedIntermediatePercentB;
  if (!Number.isFinite(confirmedIntermediate)) {
    return {
      kind: "intermediate-observe",
      minimum,
      intermediateCandidates,
      observationRuns: baselineCycle,
      recommendation: "OBSERVE: compare the retention-cycle peak profiles and confirm an intermediate %B."
    };
  }
  const minimumAndIntermediate = HplcStageSequence.evaluateOrderedSequence(
    [minimum, confirmedIntermediate],
    ambientAfterInitial
  );
  if (!minimumAndIntermediate.complete) {
    return {
      kind: minimumAndIntermediate.matchedRuns.length ? "intermediate" : "minimum",
      percentB: minimumAndIntermediate.nextPercentB,
      minimum,
      intermediate: confirmedIntermediate,
      recommendation: minimumAndIntermediate.matchedRuns.length
        ? `Mandatory sequence: test user-confirmed Intermediate %B (${confirmedIntermediate}%)`
        : `Mandatory sequence: test calculated Minimum %B (${minimum}%)`
    };
  }
  if (HplcStageSequence.targetWasMet(ambientAfterInitial, spec.peaks)) {
    return {
      kind: "stopped",
      minimum,
      intermediate: confirmedIntermediate,
      recommendation: "The Minimum/user-confirmed Intermediate %B sequence met the peak target; selectivity progression is stopped."
    };
  }

  let previousStageRuns = [...initialSequence.matchedRuns, ...minimumAndIntermediate.matchedRuns];
  for (let stageIndex = 1; stageIndex < stages.length; stageIndex += 1) {
    const previousPercentBs = HplcStageSequence.uniqueDescendingPercentages(previousStageRuns);
    const stage = stages[stageIndex];
    const conversion = stageIndex === 3 && sameSolvent(base.solvent, "ACN") && sameSolvent(stage.solvent, "METHANOL")
      ? HplcStageSequence.acetonitrileToMethanolMappings(previousPercentBs)
      : null;
    const requiredPercentBs = conversion
      ? conversion.mappings.map(mapping => mapping.methanolPercentB)
      : previousPercentBs;
    const stageRuns = actualRunsForStage(seriesHistory, stage);
    if (HplcStageSequence.targetWasMet(stageRuns, spec.peaks)) {
      return {
        kind: "stopped",
        minimum,
        intermediate: confirmedIntermediate,
        recommendation: `A run at ${stage.temperature}°C met the peak target; selectivity progression is stopped.`
      };
    }
    const coverage = HplcStageSequence.evaluateOrderedSequence(requiredPercentBs, stageRuns);
    if (!coverage.complete) {
      data.minimumPercentBResult = minimum;
      data.intermediatePercentBResult = null;
      if (conversion && !conversion.mappings.length) {
        const excluded = conversion.excluded
          .map(mapping => `${mapping.acetonitrilePercentB}% ACN → ${mapping.methanolPercentB}% MeOH`)
          .join(", ");
        return {
          kind: "blocked",
          minimum,
          intermediate: confirmedIntermediate,
          recommendation: `Methanol %B sequence unavailable: every converted value is outside 0–100%. Excluded: ${excluded}.`
        };
      }
      const selectedConversion = conversion?.mappings.find(mapping =>
        Math.abs(mapping.methanolPercentB - coverage.nextPercentB) < 0.01
      );
      return {
        kind: "selectivity",
        percentB: coverage.nextPercentB,
        stageIndex,
        stage,
        conversionMappings: conversion?.mappings || null,
        excludedConversions: conversion?.excluded || [],
        sourcePercentB: selectedConversion?.acetonitrilePercentB ?? null,
        minimum,
        intermediate: confirmedIntermediate,
        recommendation: stage.recommendation
      };
    }
    previousStageRuns = coverage.matchedRuns;
  }

  const ligandStage = stages.at(-1);
  const requiredPercentBs = HplcStageSequence.uniqueDescendingPercentages(previousStageRuns);
  for (const ligand of ["A", "B", "C", "D"]) {
    const stage = { ...ligandStage, ligand };
    const stageRuns = actualRunsForStage(seriesHistory, stage);
    if (HplcStageSequence.targetWasMet(stageRuns, spec.peaks)) {
      return {
        kind: "stopped",
        minimum,
        intermediate: confirmedIntermediate,
        recommendation: `Ligand ${ligand} met the peak target; selectivity progression is stopped.`
      };
    }
    const coverage = HplcStageSequence.evaluateOrderedSequence(requiredPercentBs, stageRuns);
    if (!coverage.complete) {
      data.minimumPercentBResult = minimum;
      data.intermediatePercentBResult = null;
      return {
        kind: "selectivity",
        percentB: coverage.nextPercentB,
        stageIndex: 9,
        stage,
        ligand,
        minimum,
        intermediate: confirmedIntermediate,
        recommendation: STRATEGY_RECOMMENDATIONS[9]
      };
    }
    previousStageRuns = coverage.matchedRuns;
  }
  return {
    kind: "complete",
    minimum,
    intermediate,
    recommendation: "All prescribed %B and selectivity runs are complete; review the method before further changes."
  };
}
function strategyRecommendation(data, history = trials.slice(0, trials.indexOf(data) + 1).filter(trial => !trial.isSuggested)) {
  if (data.peakCount >= specifications().peaks) return null;
  const plan = mandatorySequencePlan(data, history);
  if (!plan || !["blocked", "complete", "minimum", "intermediate", "intermediate-observe", "selectivity", "stopped"].includes(plan.kind)) return null;
  data.sequencePlan = plan;
  return plan?.recommendation || null;
}
function decision(data, history = trials.slice(0, trials.indexOf(data) + 1).filter(trial => !trial.isSuggested)) {
  if (specificationValidationState !== "VALID" || !validateMethodSpecifications().valid) return null;
  data.sequencePlan = null;
  data.minimumPercentBResult = null;
  data.intermediatePercentBResult = null;
  const spec = specifications();
  const runTime = decisionRunTime(data);
  const pressureStatus = measurementStatus(data.pressure, spec.pressure, "maximum");
  logDebug("[HPLC] Decision measurements and method limits", {
    groupNo: data.groupNo,
    trialNo: data.injectionNo,
    peakCount: data.peakCount,
    targetPeakCount: spec.peaks,
    lastPeakRetention: runTime,
    maximumRunTime: spec.time,
    lowestResolution: data.resolution,
    minimumResolution: spec.resolution,
    backPressure: data.pressure,
    maximumBackPressure: spec.pressure,
    pressureStatus: pressureStatus.label,
    resolutionIsInformationalWhenPeakCountIsBelowTarget: true
  });
  if (pressureStatus.label !== "PASS") {
    if (pressureStatus.label !== "FAIL") {
      logDebug("[HPLC] Back-pressure unavailable; proceeding without a pressure pass/fail result", {
        measuredPressure: data.pressure,
        maximumBackPressure: spec.pressure,
        status: pressureStatus.label
      });
    } else {
    logDebug("[HPLC] Decision blocked by back-pressure", {
      measuredPressure: data.pressure,
      maximumBackPressure: spec.pressure,
      status: pressureStatus.label
    });
    return DECISION_DO_NOT_CONTINUE;
    }
  }
  if (data.peakCount === null || !Number.isFinite(runTime)) return "Missing peak count or last peak retention time";
  if (data.peakCount < spec.peaks) {
    const seriesHistory = history.filter(trial => sameRunSeries(trial, data));
    const previousMinimumRecommendation = [...seriesHistory].reverse().find(trial =>
      trial !== data &&
      trial.recommendation === "Jump to Minimum %B THEN, Intermediate %B" &&
      Number.isFinite(trial.minimumPercentBResult) &&
      sameSolvent(trial.solvent, data.solvent) &&
      Number(trial.setTemperature) === Number(data.setTemperature) &&
      Math.abs(trial.minimumPercentBResult - data.percentB) < 0.01
    );
    if (previousMinimumRecommendation && !Number.isFinite(data.confirmedIntermediatePercentB)) {
      const observationHistory = seriesHistory.filter(trial => trial !== data);
      const observationRuns = intermediateObservationRuns(observationHistory, previousMinimumRecommendation);
      data.sequencePlan = {
        kind: "intermediate-observe",
        minimum: previousMinimumRecommendation.minimumPercentBResult,
        intermediateCandidates: intermediatePercentBCandidates(observationHistory, previousMinimumRecommendation),
        observationRuns
      };
      return "OBSERVE: compare the retention-cycle peak profiles and confirm an intermediate %B.";
    }
    if (Number.isFinite(data.confirmedIntermediatePercentB)) {
      data.nextPercentB = data.confirmedIntermediatePercentB;
      return `User-confirmed Intermediate %B (${data.confirmedIntermediatePercentB}%) — run required`;
    }
    const initialSequenceComplete = HplcStageSequence.evaluateOrderedSequence(
      INITIAL_PERCENT_INVESTIGATION,
      actualRunsForStage(seriesHistory, strategyStages(seriesHistory[0] || data, seriesHistory)[0])
    ).complete;
    if (initialSequenceComplete) {
      const strategy = strategyRecommendation(data, seriesHistory);
      if (strategy) return strategy;
    }
    const approximatelyDoubledRuntime = runTime * 2;
    if (runTime >= spec.time) {
      logDebug("[HPLC] Retention-cycle decision", {
        currentLastPeakRetention: runTime,
        approximatelyDoubledRuntime,
        maximumRunTime: spec.time,
        branch: "current retention time is at or above the maximum"
      });
      return "Jump to Minimum %B THEN, Intermediate %B";
    }
    if (approximatelyDoubledRuntime < spec.time && Number.isFinite(data.percentB) && data.percentB > 0) {
      logDebug("[HPLC] Retention-cycle decision", {
        currentLastPeakRetention: runTime,
        approximatelyDoubledRuntime,
        maximumRunTime: spec.time,
        currentPercentB: data.percentB,
        nextPercentB: Math.max(0, data.percentB - 10),
        branch: "approximately doubled runtime remains below the maximum"
      });
      return DECREASE_PERCENT_B_RECOMMENDATION;
    }
    logDebug("[HPLC] Retention-cycle decision", {
      currentLastPeakRetention: runTime,
      approximatelyDoubledRuntime,
      maximumRunTime: spec.time,
      currentPercentB: data.percentB,
      branch: "current runtime is below maximum but approximately doubled runtime reaches or exceeds it"
    });
    return "Jump to Minimum %B OR Intermediate %B";
  }
  if (runTime < spec.time && data.resolution !== null && data.resolution < spec.resolution) {
    return runTime <= spec.time * 0.5
      ? "Increase Length of Column to Increase N"
      : "SELECTIVITY";
  }
  if (runTime < spec.time && data.resolution !== null && data.resolution >= spec.resolution) return "😊 increase F until R = spec to get most efficient method";
  if (runTime > spec.time && data.resolution !== null && data.resolution < spec.resolution) return "Jump to SELECTIVITY Cycle";
  if (runTime > spec.time && data.resolution !== null && data.resolution >= spec.resolution) return "N";
  return "Targets met";
}
function nextPercentB(data, recommendation, history = trials) {
  if (data.sequencePlan) return Number.isFinite(data.sequencePlan.percentB) ? data.sequencePlan.percentB : null;
  if (STRATEGY_RECOMMENDATIONS.includes(recommendation)) {
    return Number.isFinite(data.percentB) ? data.percentB : 100;
  }
  if (recommendation === DECREASE_PERCENT_B_RECOMMENDATION) {
    return Number.isFinite(data.percentB) ? Math.max(0, data.percentB - 10) : null;
  }
  if (/minimum %b/i.test(recommendation)) {
    return Number.isFinite(data.minimumPercentBResult)
      ? data.minimumPercentBResult
      : minimumPercentB(history, data);
  }
  if (/user-confirmed intermediate %b/i.test(recommendation)) {
    return Number.isFinite(data.confirmedIntermediatePercentB)
      ? data.confirmedIntermediatePercentB
      : null;
  }
  if (recommendation === "Jump to SEL cycle") return Number.isFinite(data.percentB) ? data.percentB : null;
  return null;
}
function suggestedPercentBs(trial) {
  if (trial.sequencePlan) {
    return Number.isFinite(trial.sequencePlan.percentB) ? [trial.sequencePlan.percentB] : [];
  }
  if (trial.recommendation === "Jump to Minimum %B OR Intermediate %B" &&
      trial.minimumIntermediateChoice === "intermediate" &&
      Number.isFinite(trial.confirmedIntermediatePercentB)) {
    return [trial.confirmedIntermediatePercentB];
  }
  if (Number.isFinite(trial.confirmedIntermediatePercentB) &&
      /user-confirmed intermediate %b/i.test(trial.recommendation)) {
    return [trial.confirmedIntermediatePercentB];
  }
  if (trial.recommendation === "Jump to Minimum %B OR Intermediate %B") {
    return Number.isFinite(trial.minimumPercentBResult)
      ? [trial.minimumPercentBResult]
      : [MINIMUM_INTERMEDIATE_NOT_ENOUGH_RUNS];
  }
  if (trial.recommendation === "Jump to Minimum %B THEN, Intermediate %B") {
    if (!Number.isFinite(trial.minimumPercentBResult)) return [MINIMUM_INTERMEDIATE_NOT_ENOUGH_RUNS];
    return [trial.minimumPercentBResult];
  }
  if (trial.nextPercentB === null || trial.nextPercentB === undefined) return [];
  if (!Number.isFinite(trial.nextPercentB)) return [trial.nextPercentB];
  return [trial.nextPercentB];
}
function intermediateObservationChart(trial, maxRetention) {
  const peaks = (trial.peaks || [])
    .filter(peak =>
      Number.isFinite(peak.retention) &&
      Number.isFinite(peak.area) &&
      peak.area >= NOISE_AREA_THRESHOLD
    )
    .sort((left, right) => left.retention - right.retention);
  const chartWidth = 480;
  const chartHeight = 190;
  const left = 42;
  const right = 464;
  const baseline = 148;
  const xPosition = time => left + (time / maxRetention) * (right - left);
  const maximumSignal = Math.max(1, ...peaks.map(peak => Math.max(0, peak.height ?? peak.area)));
  const peakMarks = peaks.map((peak, index) => {
    const x = xPosition(peak.retention);
    const signal = Math.max(0, peak.height ?? peak.area);
    const y = baseline - 12 - (signal / maximumSignal) * 78;
    const width = Number.isFinite(peak.width) && peak.width > 0
      ? Math.max(2, (peak.width / maxRetention) * (right - left))
      : 0;
    const widthMark = width
      ? `<line x1="${Math.max(left, x - width / 2)}" y1="${baseline - 3}" x2="${Math.min(right, x + width / 2)}" y2="${baseline - 3}" class="observation-peak-width"></line>`
      : "";
    return `${widthMark}<line x1="${x}" y1="${baseline}" x2="${x}" y2="${y}" class="observation-peak-stem"></line><circle cx="${x}" cy="${y}" r="4" class="observation-peak-point"><title>Peak ${index + 1}: ${peak.retention} min retention</title></circle><text x="${x}" y="${y - 7}" class="observation-peak-label">P${index + 1}</text>`;
  }).join("");
  const ticks = [0, maxRetention / 2, maxRetention];
  const tickMarks = ticks.map(value => {
    const x = xPosition(value);
    return `<line x1="${x}" y1="${baseline}" x2="${x}" y2="${baseline + 5}" class="observation-axis"></line><text x="${x}" y="${baseline + 20}" class="observation-axis-label">${value.toFixed(1)}</text>`;
  }).join("");
  return `<svg class="observation-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Peak-table retention map for ${trial.percentB} percent B">
    <line x1="${left}" y1="${baseline}" x2="${right}" y2="${baseline}" class="observation-axis"></line>
    ${tickMarks}${peakMarks}
    <text x="${(left + right) / 2}" y="184" class="observation-axis-label">Retention time (min)</text>
    ${peaks.length ? "" : `<text x="${chartWidth / 2}" y="80" class="observation-empty">No usable peak-table entries</text>`}
  </svg>`;
}
function renderIntermediateObservation() {
  const panel = $("intermediateObservation");
  const activeTrial = [...trials].reverse().find(trial =>
    !trial.isSuggested &&
    (trial.sequencePlan?.kind === "intermediate-observe" ||
      trial.recommendation === "Jump to Minimum %B OR Intermediate %B")
  );
  if (!activeTrial) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const trialIndex = trials.indexOf(activeTrial);
  const history = trials.slice(0, trialIndex + 1).filter(trial => !trial.isSuggested);
  const runs = activeTrial.sequencePlan?.observationRuns ||
    intermediateObservationRuns(history, activeTrial);
  const maxRetention = Math.max(1, ...runs
    .map(trial => trial.lastPeakRetention)
    .filter(Number.isFinite));
  const candidates = activeTrial.intermediateObservationCandidates || [];
  const minimumEstimate = activeTrial.sequencePlan?.minimum ?? activeTrial.minimumPercentBResult;
  const options = candidates.map(candidate =>
    `<option value="${candidate.percentB}">${candidate.percentB}% B candidate (between ${candidate.higherPercentB}% and ${candidate.lowerPercentB}% B)</option>`
  ).join("");
  const chromatograms = runs.map((run, index) => {
    const filteredPeaks = (run.peaks || []).filter(peak =>
      Number.isFinite(peak.retention) &&
      Number.isFinite(peak.area) &&
      peak.area >= NOISE_AREA_THRESHOLD
    );
    const resolution = filteredPeaks.length < 7
      ? "Rs = 0 (not assessable; fewer than 7 peaks)"
      : Number.isFinite(run.resolution)
        ? `Rs = ${run.resolution}`
        : "Rs not available";
    const lastRetention = filteredPeaks.length
      ? Math.max(...filteredPeaks.map(peak => peak.retention))
      : null;
    return `<article class="observation-run">
      <h4>${escapeHtml(String(run.percentB))}% B · Run ${escapeHtml(String(run.injectionNo || index + 1))}</h4>
      ${intermediateObservationChart(run, maxRetention)}
      <p><strong>Peaks:</strong> ${filteredPeaks.length} · <strong>Last-peak retention:</strong> ${escapeHtml(shown(lastRetention, " min"))}</p>
      <p><strong>${escapeHtml(resolution)}</strong></p>
    </article>`;
  }).join("");
  panel.hidden = false;
  panel.innerHTML = `<h3 id="intermediateObservationHeading">Intermediate %B — OBSERVE</h3>
    <p class="observation-minimum-result"><strong>Calculated Minimum %B:</strong> ${escapeHtml(shown(minimumEstimate, "%"))}. This remains the separate course-based regression result; see the Extraction log for its data points, fit equation, and R².</p>
    <p class="observation-instruction">OBSERVE: Compare the chromatograms as %B decreases. Identify the critical pair that limits separation. Choose an intermediate %B where the peaks may separate better without making the last-peak retention time unacceptably long.</p>
    <p class="observation-data-note"><strong>Data limitation:</strong> This importer does not read raw detector-signal chromatograms. The plots below show measured peak-table retention positions and reported widths, not reconstructed chromatograms. Peak numbers indicate elution order within each run; the app cannot reliably track compound identities or choose the best %B automatically.</p>
    <div class="observation-runs">${chromatograms || `<p>No eligible measured retention-cycle runs are available for comparison.</p>`}</div>
    <div class="observation-choice">
      <label for="intermediateObservationCandidate">Candidate from adjacent tested %B values</label>
      <select id="intermediateObservationCandidate" data-trial-index="${trialIndex}">
        <option value="">Choose a candidate after inspecting the plots</option>${options}
      </select>
      <label for="intermediateObservationValue">Confirmed next %B</label>
      <input id="intermediateObservationValue" type="number" min="0" max="100" step="0.1" inputmode="decimal" data-trial-index="${trialIndex}" aria-describedby="intermediateObservationStatus">
      <button type="button" id="confirmIntermediateObservation" data-trial-index="${trialIndex}">Confirm intermediate %B and generate next run</button>
      <p id="intermediateObservationStatus" role="status" aria-live="polite">A candidate is only a prompt. Inspect the measured peaks, then confirm your choice.</p>
    </div>`;
}
function predictionPlan(data, recommendation, history = trials.slice(0, trials.indexOf(data) + 1).filter(trial => !trial.isSuggested)) {
  if (STRATEGY_RECOMMENDATIONS.includes(recommendation) && recommendation) {
    const stageIndex = data.sequencePlan?.stageIndex ?? STRATEGY_RECOMMENDATIONS.indexOf(recommendation);
    const seriesHistory = history.filter(trial => sameRunSeries(trial, data));
    const base = seriesHistory[0] || data;
    const stages = strategyStages(base, seriesHistory);
    const stage = stages[stageIndex] || {
      solvent: stages[stages.length - 1].solvent, temperature: 60, ligand: "",
      recommendation: STRATEGY_RECOMMENDATIONS[9]
    };
    const usedLigands = new Set(seriesHistory
      .filter(trial => matchesStage(trial, stage))
      .map(trial => String(trial.ligand || "").trim().toUpperCase()));
    const ligand = data.sequencePlan?.ligand || ["A", "B", "C", "D"].find(option => !usedLigands.has(option)) || "A";
    const solventControl = stageIndex === 3 ? "organic-solvent"
      : stageIndex === 6 ? "mixed-solvent" : "";
    const solvent = stage.solvent;
    const percentOptions = data.sequencePlan?.conversionMappings
      ? data.sequencePlan.conversionMappings.map(mapping => mapping.methanolPercentB)
      : Number.isFinite(data.sequencePlan?.percentB)
        ? [data.sequencePlan.percentB]
        : strategyPercentOptions(seriesHistory, data);
    const requestedPercent = Number.isFinite(data.sequencePlan?.percentB)
      ? data.sequencePlan.percentB
      : Number.isFinite(data.percentB) ? data.percentB : 100;
    if (!percentOptions.includes(requestedPercent)) percentOptions.push(requestedPercent);
    return {
      percentB: percentOptions.includes(requestedPercent) ? requestedPercent : percentOptions[0],
      percentOptions,
      sourcePercentB: data.sequencePlan?.sourcePercentB ?? null,
      conversionMappings: data.sequencePlan?.conversionMappings || null,
      excludedConversions: data.sequencePlan?.excludedConversions || [],
      solvent,
      solventControl,
      temperature: stage.temperature,
      ligand: stageIndex === 9 ? ligand : stage.ligand,
      ligandControl: stageIndex === 9
    };
  }
  return null;
}
function updateRecommendation(trial) {
  if (specificationValidationState !== "VALID" || !validateMethodSpecifications().valid) {
    trial.recommendation = null;
    trial.nextPercentB = null;
    trial.minimumPercentBResult = null;
    trial.intermediatePercentBResult = null;
    trial.prediction = null;
    return;
  }
  const trialIndex = trials.indexOf(trial);
  const history = (trialIndex < 0 ? trials : trials.slice(0, trialIndex + 1))
    .filter(item => !item.isSuggested);
  trial.recommendation = decision(trial, history);
  if (!trial.sequencePlan) {
    const minimumIntermediateDecision = [
      "Jump to Minimum %B OR Intermediate %B",
      "Jump to Minimum %B THEN, Intermediate %B"
    ].includes(trial.recommendation);
    trial.minimumPercentBResult = minimumIntermediateDecision
      ? minimumPercentB(history, trial)
      : null;
    trial.intermediatePercentBResult = null;
    trial.intermediateObservationCandidates = trial.recommendation === "Jump to Minimum %B OR Intermediate %B"
      ? intermediatePercentBCandidates(history, trial)
      : [];
  } else if (trial.sequencePlan.kind === "intermediate-observe") {
    trial.minimumPercentBResult = trial.sequencePlan.minimum;
    trial.intermediatePercentBResult = null;
    trial.intermediateObservationCandidates = trial.sequencePlan.intermediateCandidates || [];
  } else {
    trial.intermediateObservationCandidates = [];
  }
  trial.nextPercentB = nextPercentB(trial, trial.recommendation, history);
  trial.prediction = predictionPlan(trial, trial.recommendation, history);
}
function selectivityPercentOptions() {
  const options = trials
    .filter(trial => !trial.isSuggested && Number(trial.setTemperature) === 25 && Number.isFinite(trial.percentB))
    .map(trial => trial.percentB);
  trials.forEach(trial => {
    if (Number.isFinite(trial.nextPercentB) && /minimum %b/i.test(trial.recommendation)) options.push(trial.nextPercentB);
  });
  return [...new Set(options)].sort((left, right) => right - left);
}
function shown(value, unit = "") {
  if (value === null || value === undefined || value === "") return "Not found";
  if (value === "-") return "-";
  if (unit === "%" && typeof value === "string" && value.includes("%")) return value;
  return `${value}${unit}`;
}
function parameterShown(value, unit = "") {
  if (value === null || value === undefined || value === "") return "-";
  return shown(value, unit);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}
function equipmentValue(parameter, trial) {
  if (!parameter.dataKey || !trial) return "No value recorded for the selected run.";
  const value = trial[parameter.dataKey];
  return value === null || value === undefined || value === ""
    ? "Not present in the selected run."
    : `${parameterShown(value, parameter.valueUnit || "")}`;
}
function equipmentField(label, value, valueClass = "") {
  if (!value) return "";
  const content = valueClass
    ? `<div class="${escapeHtml(valueClass)}">${escapeHtml(value)}</div>`
    : escapeHtml(value);
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${content}</td></tr>`;
}
function renderEffectFlow(effects) {
  return `<ul class="effect-flow-list">${effects.map(([label, effect]) =>
    `<li><strong>${escapeHtml(label)}</strong><span aria-hidden="true"> → </span>${escapeHtml(effect)}</li>`
  ).join("")}</ul>`;
}
function selectivityEquipmentTarget(stageIndex) {
  if ([1, 2, 4, 5, 7, 8].includes(stageIndex)) {
    return { module: "columnOven", parameter: "Temperature" };
  }
  if ([3, 6].includes(stageIndex)) {
    return { module: "solventBottles", parameter: "Solvent Type" };
  }
  if (stageIndex === 9) {
    return { module: "columnOven", parameter: "Ligand (Stationary phase)" };
  }
  return null;
}
function renderSelectivityDecisionRelationship(trial, context) {
  const stageIndex = Number(context.stageIndex);
  const stage = trial?.sequencePlan?.stage;
  const stageName = stageIndex === 1 || stageIndex === 2
    ? "Temperature in ACN"
    : stageIndex === 3
      ? "ACN to MeOH at ambient temperature"
      : stageIndex === 4 || stageIndex === 5
        ? "Temperature in MeOH"
        : stageIndex === 6
          ? "MeOH to mixed solvent at ambient temperature"
          : stageIndex === 7 || stageIndex === 8
            ? "Temperature in mixed solvent"
            : stageIndex === 9
              ? "Stationary-phase ligand"
              : "Selectivity stage";
  const hasValidatedSpecifications = specificationValidationState === "VALID" && validateMethodSpecifications().valid;
  const spec = hasValidatedSpecifications
    ? specifications()
    : { peaks: null, time: null, pressure: null };
  const pressureStatus = hasValidatedSpecifications
    ? measurementStatus(trial?.pressure, spec.pressure, "maximum")
    : { label: "NOT VALIDATED" };
  const peakStatus = hasValidatedSpecifications
    ? measurementStatus(trial?.peakCount, spec.peaks, "minimum")
    : { label: "NOT VALIDATED" };
  const retention = trial ? decisionRunTime(trial) : null;
  const runtimeStatus = hasValidatedSpecifications
    ? measurementStatus(retention, spec.time, "maximum")
    : { label: "NOT VALIDATED" };
  const prediction = context.prediction || trial?.prediction || {};
  const solvent = prediction.solvent || stage?.solvent || trial?.solvent || "Not specified";
  const temperature = Number.isFinite(Number(prediction.temperature))
    ? Number(prediction.temperature)
    : Number.isFinite(Number(stage?.temperature))
      ? Number(stage.temperature)
      : null;
  const percentB = Number.isFinite(Number(prediction.percentB))
    ? Number(prediction.percentB)
    : Number.isFinite(Number(context.percentB))
      ? Number(context.percentB)
      : null;
  const ligand = prediction.ligand || trial?.sequencePlan?.ligand || trial?.ligand || "Not specified";
  const wavelength = Number.isFinite(Number(trial?.wavelength)) ? `${trial.wavelength} nm` : "254 nm (method default)";
  const action = stage?.recommendation || STRATEGY_RECOMMENDATIONS[stageIndex] || "Review selectivity-stage recommendation";
  let purpose;
  let effects;
  let constants;
  if (stageIndex === 1 || stageIndex === 2 || stageIndex === 4 || stageIndex === 5 || stageIndex === 7 || stageIndex === 8) {
    purpose = `Optimise peak spacing by changing selectivity through temperature while keeping mobile-phase composition constant. Stage sequence: 25°C → 40°C → 60°C.`;
    effects = [
      ["Retention time", "usually decreases as temperature rises."],
      ["Selectivity", "may rise or fall; elution order may change."],
      ["Efficiency", "may improve slightly as interactions speed up."],
      ["Back-pressure", "usually decreases as solvent viscosity falls."]
    ];
    constants = [
      ["Mobile-phase composition (%B)", `${Number.isFinite(percentB) ? `${percentB}% B` : "selected composition"}; keep constant.`],
      ["Solvent type", `${solvent}; keep constant during this temperature stage.`],
      ["Flow rate", "Keep constant."],
      ["Column and stationary phase", "Keep constant."],
      ["Injection volume", "Keep constant."],
      ["Detection wavelength", `${wavelength}; keep constant.`],
      ["Column temperature", `Change to ${temperature === null ? "the proposed stage temperature" : `${temperature}°C`}; next temperature stage is only run if required.`]
    ];
  } else if (stageIndex === 3) {
    purpose = "Optimise peak spacing by changing mobile-phase chemistry from ACN to MeOH while maintaining approximately equal eluotropic strength.";
    effects = [
      ["Retention time", "should stay similar at equal strength; individual peaks may shift."],
      ["Selectivity", "may change as ACN is replaced by MeOH."],
      ["Efficiency", "may shift with peak widths."],
      ["Back-pressure", "usually increases with more viscous MeOH-water."]
    ];
    constants = [
      ["Eluotropic strength", "Keep approximately constant using the mapped equivalent solvent compositions."],
      ["Flow rate", "Keep constant."],
      ["Column and stationary phase", "Keep constant."],
      ["Injection volume", "Keep constant."],
      ["Detection wavelength", `${wavelength}; keep constant.`],
      ["Solvent type", `Change to ${solvent}.`],
      ["Mobile-phase composition", `Use the mapped composition${Number.isFinite(percentB) ? ` (${percentB}% MeOH${Number.isFinite(Number(prediction.sourcePercentB)) ? ` for ${prediction.sourcePercentB}% ACN` : ""})` : ""}; conversion follows the configured ACN-to-MeOH mapping.`],
      ["Column temperature", "Begin at ambient (25°C) for this comparison."]
    ];
  } else if (stageIndex === 6) {
    purpose = "Optimise peak spacing by moving from MeOH to a mixed ACN/MeOH mobile phase with intermediate solvent chemistry.";
    effects = [
      ["Retention time", "may stay similar; peaks and total runtime can shift."],
      ["Selectivity", "may improve or worsen with blend ratio."],
      ["Efficiency", "may shift with peak widths."],
      ["Back-pressure", "is expected between parent solvents; MeOH-rich blends run higher."]
    ];
    constants = [
      ["Eluotropic strength", "Keep approximately constant relative to the parent mobile phases."],
      ["Flow rate", "Keep constant."],
      ["Column and stationary phase", "Keep constant."],
      ["Injection volume", "Keep constant."],
      ["Detection wavelength", `${wavelength}; keep constant.`],
      ["Solvent type", `Change from MeOH to ${solvent}.`],
      ["Mobile-phase composition", "Use the selected blend ratio. The example equal-strength blend is 25% ACN, 30% MeOH, and 45% water; verify the recipe against the method."],
      ["Column temperature", "Begin at the best temperature established in the preceding stage; test 40°C and 60°C as required."]
    ];
  } else {
    purpose = "Change stationary-phase chemistry after the solvent and temperature selectivity stages have not achieved the target peak count.";
    effects = [
      ["Retention and selectivity", "depend on ligand-analyte interactions."],
      ["Peak spacing", "and elution order may change; improvement is not guaranteed."],
      ["Efficiency", "depends on column and operating conditions."],
      ["Back-pressure", "depends on column and solvent; check hardware limits."]
    ];
    constants = [
      ["Solvent type and composition", "Keep at the final selected selectivity-stage condition."],
      ["Flow rate", "Keep constant."],
      ["Column temperature", `${temperature === null ? "Keep at the final selected stage temperature" : `Keep at ${temperature}°C`}.`],
      ["Injection volume", "Keep constant."],
      ["Detection wavelength", `${wavelength}; keep constant.`],
      ["Stationary phase", `Change ligand to ${ligand}.`]
    ];
  }
  const evidence = `<div class="table-wrap"><table class="equipment-info-table"><tbody>
      <tr><th scope="row">Back-pressure</th><td>${escapeHtml(shown(trial?.pressure, " psi"))} — <span class="measurement-status ${hasValidatedSpecifications ? pressureStatus.className : "status-unavailable"}">${pressureStatus.label}</span>${hasValidatedSpecifications ? `; maximum ${escapeHtml(String(spec.pressure))} psi` : ""}</td></tr>
      <tr><th scope="row">Peak count</th><td>${escapeHtml(shown(trial?.peakCount))} — <span class="measurement-status ${hasValidatedSpecifications ? peakStatus.className : "status-unavailable"}">${peakStatus.label}</span>${hasValidatedSpecifications ? `; target ${escapeHtml(String(spec.peaks))}` : ""}</td></tr>
      <tr><th scope="row">Total retention time</th><td>${escapeHtml(shown(retention, " min"))} — <span class="measurement-status ${hasValidatedSpecifications ? runtimeStatus.className : "status-unavailable"}">${runtimeStatus.label}</span>${hasValidatedSpecifications ? `; maximum ${escapeHtml(String(spec.time))} min${runtimeStatus.label === "FAIL" ? " · method specification failure" : ""}` : ""}</td></tr>
      <tr><th scope="row">Selected action</th><td>${escapeHtml(action)}.</td></tr>
      <tr><th scope="row">Next test conditions</th><td>${escapeHtml(solvent)}; ${Number.isFinite(percentB) ? `${percentB}% B` : "composition not available"}; ${Number.isFinite(temperature) ? `${temperature}°C` : "temperature not available"}; ${escapeHtml(ligand)}.</td></tr>
    </tbody></table></div>`;
  return `<section class="decision-engine-relationship selectivity-decision-relationship" aria-labelledby="selectivity-decision-heading">
    <h4 id="selectivity-decision-heading" tabindex="-1">Selectivity Decision-engine Relationship: ${escapeHtml(stageName)}</h4>
    ${evidence}
    <h5>Purpose and evidence</h5>
    <p>${escapeHtml(purpose)} Compare chromatograms for peak count, neighbouring-peak selectivity (α), resolution (Rs), total runtime, and pressure. If the target of ${hasValidatedSpecifications ? escapeHtml(String(spec.peaks)) : "the configured"} peaks is achieved, stop this progression. Otherwise, interpret the critical pair before advancing.</p>
    <h5>Expected Chromatographic Effects</h5>
    ${renderEffectFlow(effects)}
    <h5>Parameters held constant / changed</h5>
    <div class="table-wrap"><table class="equipment-info-table"><thead><tr><th>Parameter</th><th>Setting</th></tr></thead><tbody>${constants.map(([name, value]) => `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table></div>
    <p><strong>Change only the parameter being investigated.</strong> Update the matching Equipment setting before the next HPLC run; preserve the other listed conditions.</p>
    ${Number.isInteger(currentViewedTrialIndex) ? `<button type="button" class="return-to-decision" data-source-index="${currentViewedTrialIndex}">Return to this run's decision</button>` : ""}
  </section>`;
}
function renderPumpPercentBRelationship(trial) {
  const decisionContext = activePumpPercentBDecision;
  const hasValidatedSpecifications = specificationValidationState === "VALID" && validateMethodSpecifications().valid;
  const spec = hasValidatedSpecifications
    ? specifications()
    : { peaks: null, time: null, resolution: null, pressure: null };
  const unvalidatedStatus = { label: "NOT VALIDATED", className: "status-unavailable" };
  const pressureStatus = hasValidatedSpecifications && trial
    ? measurementStatus(trial.pressure, spec.pressure, "maximum")
    : unvalidatedStatus;
  const peakStatus = hasValidatedSpecifications && trial
    ? measurementStatus(trial.peakCount, spec.peaks, "minimum")
    : unvalidatedStatus;
  const runTime = trial ? decisionRunTime(trial) : null;
  const nextPercentB = trial && Number.isFinite(trial.percentB) ? Math.max(0, trial.percentB - 10) : null;
  const approximatelyDoubledRuntime = hasValidatedSpecifications && Number.isFinite(runTime)
    ? runTime * 2
    : null;
  const runtimeStatus = hasValidatedSpecifications
    ? measurementStatus(approximatelyDoubledRuntime, spec.time, "maximum")
    : unvalidatedStatus;
  const selectedRun = trial && Number.isFinite(currentViewedTrialIndex)
    ? currentViewedTrialIndex
    : parameterTrialIndex;
  const currentPercentB = trial && Number.isFinite(trial.percentB) ? `${trial.percentB}% B` : "Not available";
  const proposedPercentB = Number.isFinite(nextPercentB) ? "−10 percentage points" : "Not available";
  const resultingPercentB = Number.isFinite(nextPercentB) ? `${nextPercentB}% B` : "Not available";
  const isMinimumIntermediate = ["minimum", "intermediate", "minimum-then", "minimum-or"].includes(decisionContext?.kind);
  const selectedAction = decisionContext?.kind === "minimum"
    ? "Run Minimum %B"
    : decisionContext?.kind === "intermediate"
      ? "Run user-confirmed Intermediate %B"
      : decisionContext?.kind === "minimum-then"
        ? "Run Minimum %B THEN Intermediate %B"
        : decisionContext?.kind === "minimum-or"
          ? "Run Minimum %B OR user-confirmed Intermediate %B"
          : "";
  const displayedPercentB = Number.isFinite(decisionContext?.percentB)
    ? `${decisionContext.percentB}% B`
    : "Not selected or not yet confirmed";
  const pathEvidenceRows = trial
    ? `<div class="table-wrap"><table class="equipment-info-table"><tbody>
        <tr><th scope="row">Back-pressure</th><td>${escapeHtml(shown(trial.pressure, " psi"))} — <span class="measurement-status ${hasValidatedSpecifications ? pressureStatus.className : "status-unavailable"}">${pressureStatus.label}</span>${hasValidatedSpecifications ? `; maximum ${escapeHtml(String(spec.pressure))} psi` : ""}</td></tr>
        <tr><th scope="row">Peak count</th><td>${escapeHtml(shown(trial.peakCount))} — <span class="measurement-status ${hasValidatedSpecifications ? peakStatus.className : "status-unavailable"}">${peakStatus.label}</span>${hasValidatedSpecifications ? `; target ${escapeHtml(String(spec.peaks))}` : ""}</td></tr>
        <tr><th scope="row">Total retention time</th><td>${escapeHtml(shown(runTime, " min"))} — <span class="measurement-status ${hasValidatedSpecifications ? runtimeStatus.className : "status-unavailable"}">${runtimeStatus.label}</span>${hasValidatedSpecifications ? `; maximum ${escapeHtml(String(spec.time))} min; ${runtimeStatus.label === "FAIL" ? "10-point decrease runtime check fails" : "10-point decrease runtime check passes"}` : ""}</td></tr>
        <tr><th scope="row">Selected action</th><td>${escapeHtml(selectedAction || "Minimum / Intermediate %B sequence")}${decisionContext?.kind === "minimum-then" ? " — Minimum first; Intermediate follows an OBSERVE confirmation." : decisionContext?.kind === "minimum-or" ? " — choose Minimum or confirm Intermediate in OBSERVE." : ""}</td></tr>
        <tr><th scope="row">Selected / proposed %B</th><td>${escapeHtml(displayedPercentB)}</td></tr>
      </tbody></table></div>`
    : "";
  const minimumIntermediateGuidance = isMinimumIntermediate
    ? `<h5>Purpose</h5>
      <p>${decisionContext.kind === "intermediate" || decisionContext.kind === "minimum-or"
        ? decisionContext.kind === "minimum-or"
          ? "Run calculated Minimum %B to investigate early retention and spacing, or use OBSERVE to compare retention-cycle runs and confirm an Intermediate %B between tested conditions."
          : "Refine the mobile-phase composition between the tested conditions by observing peak movement and confirming an Intermediate %B."
        : "Optimise peak spacing by finding Minimum %B from the course-based retention-factor-versus-%B regression."}</p>
      <h5>Evidence to review</h5>
      <p>Review early-peak retention factors (k′), selectivity between neighbouring compounds, measured resolution, and whether the total run time remains acceptable. For Intermediate %B, compare the best retention-cycle runs, focusing on peak separation and total retention time. The tool cannot reliably track compound identity or choose the best intermediate automatically.</p>
      <h5>Expected Chromatographic Effects</h5>
      ${renderEffectFlow([
        ["Retention time", decisionContext.kind === "minimum" || decisionContext.kind === "minimum-then"
          ? "lower %B → generally longer retention and runtime."
          : decisionContext.kind === "minimum-or"
            ? "lower Minimum %B → generally longer retention; Intermediate %B → direction depends on the composition change."
            : "raise/lower Intermediate %B → retention may increase/decrease with gradient elution."],
        ["Selectivity", "composition change → neighbouring peaks may shift differently."],
        ["Efficiency", "flow, column and temperature fixed → generally similar; width may still change."],
        ["Back-pressure", "solvent composition changes → pressure may change; check instrument/column limits."]
      ])}
      <h5>Parameters Held Constant During This Decision</h5>
      <div class="table-wrap"><table class="equipment-info-table"><thead><tr><th>Parameter</th><th>Action</th></tr></thead><tbody>
        <tr><td>Flow rate</td><td>Keep constant.</td></tr>
        <tr><td>Column temperature</td><td>Keep constant.</td></tr>
        <tr><td>Column and stationary phase</td><td>Keep constant.</td></tr>
        <tr><td>Injection volume</td><td>Keep constant.</td></tr>
      </tbody></table></div>`
    : "";
  const measurementRows = `<div class="table-wrap"><table class="equipment-info-table"><tbody>
      <tr><th scope="row">Back-pressure</th><td>${escapeHtml(shown(trial?.pressure, " psi"))} — <span class="measurement-status ${pressureStatus.className}">${pressureStatus.label}</span> (maximum ${escapeHtml(hasValidatedSpecifications ? String(spec.pressure) : "not validated")} psi)</td></tr>
      <tr><th scope="row">Peak count</th><td>${escapeHtml(shown(trial?.peakCount))} / ${escapeHtml(hasValidatedSpecifications ? String(spec.peaks) : "not validated")} — <span class="measurement-status ${peakStatus.className}">${peakStatus.label}</span></td></tr>
      <tr><th scope="row">Last-peak retention time</th><td>${escapeHtml(shown(runTime, " min"))}; maximum ${escapeHtml(hasValidatedSpecifications ? String(spec.time) : "not validated")} min; current margin ${escapeHtml(hasValidatedSpecifications && Number.isFinite(runTime) ? (spec.time - runTime).toFixed(3) : "Not validated")} min</td></tr>
      <tr><th scope="row">Approximate retention if %B decreases by 10 points</th><td>${escapeHtml(hasValidatedSpecifications ? `About ${shown(approximatelyDoubledRuntime, " min")}` : "Not calculated until specifications are validated")}; maximum ${escapeHtml(hasValidatedSpecifications ? String(spec.time) : "not validated")} min — <span class="measurement-status ${runtimeStatus.className}">${runtimeStatus.label}</span></td></tr>
    </tbody></table></div>`;
  return `<section class="decision-engine-relationship" id="pump-percent-b-decision-relationship" aria-labelledby="pump-percent-b-decision-heading">
    <h4 id="pump-percent-b-decision-heading" tabindex="-1">Decision-engine Relationship</h4>
    ${isMinimumIntermediate ? `${pathEvidenceRows}${minimumIntermediateGuidance}` : ""}
    ${!isMinimumIntermediate ? measurementRows : ""}
    ${!isMinimumIntermediate ? `<table class="equipment-info-table relationship-overview"><tbody>
      <tr><th scope="row">Current method %B</th><td>${escapeHtml(currentPercentB)}</td></tr>
      <tr><th scope="row">Proposed decrement</th><td>${escapeHtml(proposedPercentB)}. This project uses a 10 percentage-point decrement (for example, 70% to 60%), not a relative 10% reduction.</td></tr>
      <tr><th scope="row">Resulting %B</th><td>${escapeHtml(resultingPercentB)}</td></tr>
      <tr><th scope="row">Method mode</th><td>The supported naming convention identifies isocratic (ISO) runs. This recommendation changes the isocratic %B setting only; it does not alter gradient slope, timing, or programme.</td></tr>
    </tbody></table>
    <p><strong>Decision:</strong> ${!hasValidatedSpecifications
      ? "No decision is available until the current method specifications are validated."
      : trial && trial.recommendation === DECREASE_PERCENT_B_RECOMMENDATION
        ? "Decrease %B by 10 percentage points."
        : "The selected run does not currently meet every condition for the %B decrement."}</p>
    <h5>Expected Chromatographic Effects</h5>
    ${renderEffectFlow([
      ["Retention time", "lower %B → generally longer retention in reversed-phase HPLC."],
      ["Selectivity", "composition change → peak spacing may change."],
      ["Efficiency", "flow/column conditions change → efficiency may change."],
      ["Back-pressure", "composition change → recheck pressure."],
      ["Peak count and resolution", "next run → reassess; improvement is not guaranteed."]
    ])}
    <h5>Parameters Held Constant During This Decision</h5>
    <div class="table-wrap"><table class="equipment-info-table"><thead><tr><th>Parameter</th><th>Action</th></tr></thead><tbody>
      <tr><td>Mobile-phase composition (%B)</td><td>Decrease by the specified 10 percentage points only.</td></tr>
      <tr><td>Flow rate</td><td>Keep constant.</td></tr>
      <tr><td>Column temperature</td><td>Keep constant.</td></tr>
      <tr><td>Column and stationary phase</td><td>Keep constant.</td></tr>
      <tr><td>Injection volume</td><td>Keep constant.</td></tr>
      <tr><td>Other method parameters</td><td>Keep constant unless another explicit decision rule requires a change.</td></tr>
    </tbody></table></div>
    <p>After changing %B, rerun the method and reassess peak count, last-peak retention time, back-pressure, and resolution against their method specifications.</p>
    ` : ""}
    ${Number.isInteger(selectedRun) ? `<button type="button" class="return-to-decision" data-source-index="${selectedRun}">Return to this run's decision</button>` : ""}
  </section>`;
}
function renderEquipmentParameter(module, parameter, trial) {
  const failureWarning = module.title === "Degasser" && parameter.otherEffects.includes("Failure signs")
    ? "equipment-failure-warning"
    : "";
  const fields = [
    equipmentField("Parameter function", parameter.function),
    equipmentField("Category", parameter.category || module.category),
    equipmentField("Parameter type", parameter.parameterType),
    equipmentField("Instrument control point", parameter.controlPoint),
    equipmentField("Units", parameter.units),
    equipmentField("Admissible / allowed range", parameter.admissibleRange),
    equipmentField("Typical operating range", parameter.typicalRange),
    equipmentField("Effect on retention", parameter.retentionEffect),
    equipmentField("Effect on selectivity", parameter.selectivityEffect),
    equipmentField("Effect on efficiency", parameter.efficiencyEffect),
    equipmentField("Other chromatographic / system effects", parameter.otherEffects, failureWarning),
    equipmentField("Why this parameter may be changed", parameter.whyChange),
    equipmentField("When this tool recommends changing it", parameter.recommendationWhen)
  ].filter(Boolean).join("");
  const isPumpPercentB = module.title === "Pump" && parameter.name === "%B (Pump composition setting)";
  const relationshipId = isPumpPercentB ? ' id="pump-percent-b-parameter"' : "";
  const selectivityTarget = activeSelectivityDecision
    ? selectivityEquipmentTarget(activeSelectivityDecision.stageIndex)
    : null;
  const showSelectivityRelationship = selectivityTarget?.module === activeEquipmentModule &&
    selectivityTarget.parameter === parameter.name;
  return `<section class="equipment-parameter-card"${relationshipId} aria-live="polite">
    <h4>${escapeHtml(parameter.name)}</h4>
    <div class="table-wrap"><table class="equipment-info-table"><tbody>${fields}</tbody></table></div>
    ${isPumpPercentB ? renderPumpPercentBRelationship(trial) : ""}
    ${showSelectivityRelationship ? renderSelectivityDecisionRelationship(trial, activeSelectivityDecision) : ""}
  </section>`;
}
function renderEquipment() {
  document.querySelectorAll("[data-equipment-module]").forEach(button => {
    const selected = button.dataset.equipmentModule === activeEquipmentModule;
    button.classList.toggle("active", selected);
    if (button.classList.contains("equipment-tab")) button.setAttribute("aria-selected", String(selected));
    if (button.classList.contains("equipment-hotspot")) button.setAttribute("aria-pressed", String(selected));
  });
  $("equipmentLayout").hidden = false;
  if (!activeEquipmentModule) {
    $("equipmentDetails").innerHTML = '<p class="empty-selection">Choose a module on the schematic or from the tabs. Then choose a parameter to see what it does, where it is controlled, and how it affects the chromatogram.</p>';
    return;
  }
  const module = equipmentModules[activeEquipmentModule];
  if (!module) return;
  const parameters = module.parameters || [];
  if (!parameters.some(parameter => parameter.name === activeEquipmentParameter)) {
    activeEquipmentParameter = parameters.length ? parameters[0].name : "";
  }
  const parameter = parameters.find(item => item.name === activeEquipmentParameter) || parameters[0];
  const trialIndex = currentViewedTrialIndex ?? parameterTrialIndex;
  const trial = trialIndex === null ? null : trials[trialIndex];
  const pumpArrangements = activeEquipmentModule === "pump"
    ? `<details class="pump-arrangements">
        <summary>Two Ways to Arrange This</summary>
        <article class="pump-arrangement">
          <div>
            <h5>Binary System</h5>
            <p>Two pumps deliver the solvents separately. They mix after the pumps, at high pressure.</p>
          </div>
          <div class="pump-arrangement-images">
            <figure>
              <img src="binary-system-schematic.png" alt="Binary HPLC system schematic: two pumps feed a mixer after the pumps, then the injector and column">
              <figcaption>Clip-art diagram</figcaption>
            </figure>
            <figure>
              <img src="binary-system-instrument.png" alt="Real HPLC instrument showing the binary pump components">
              <figcaption>Instrument photo</figcaption>
            </figure>
          </div>
        </article>
        <article class="pump-arrangement">
          <div>
            <h5>Quaternary System</h5>
            <p>A proportioning valve mixes up to four solvents before the pump, at low pressure.</p>
          </div>
          <div class="pump-arrangement-images">
            <figure>
              <img src="quaternary-system-schematic.png" alt="Quaternary HPLC system schematic: solvent lines meet at a proportioning valve before the pump">
              <figcaption>Clip-art diagram</figcaption>
            </figure>
            <figure>
              <img src="quaternary-system-instrument.png" alt="Real HPLC instrument showing the quaternary solvent proportioning valve and pump">
              <figcaption>Instrument photo</figcaption>
            </figure>
          </div>
        </article>
      </details>`
    : "";
  const injectorImage = activeEquipmentModule === "injector"
    ? `<section class="injector-image-gallery" aria-label="Manual injector and autosampler images">
        <h4>Manual Injector / Autosampler</h4>
        <div class="injector-image-tabs" role="group" aria-label="Choose injector image">
          <button type="button" class="injector-image-tab${activeInjectorImage === "manual" ? " active" : ""}" data-injector-image="manual" aria-pressed="${activeInjectorImage === "manual"}">Manual Injector</button>
          <button type="button" class="injector-image-tab${activeInjectorImage === "autosampler" ? " active" : ""}" data-injector-image="autosampler" aria-pressed="${activeInjectorImage === "autosampler"}">Autosampler</button>
        </div>
        <figure class="injector-image-figure">
          <img src="${activeInjectorImage === "manual" ? "Manual%20injector.png" : "autosampler.png"}" alt="${activeInjectorImage === "manual" ? "Manual HPLC injector being operated with a syringe" : "HPLC autosampler sample-vial tray"}">
          <figcaption>${activeInjectorImage === "manual" ? "Manual Injector" : "Autosampler"}</figcaption>
        </figure>
      </section>`
    : "";
  $("equipmentDetails").innerHTML = `<h3>${escapeHtml(module.title)}</h3>
    <p><strong>Function:</strong> ${escapeHtml(module.function)}</p>
    <p><strong>Category:</strong> ${escapeHtml(module.category)}</p>
    <p><strong>Associated parameters:</strong> ${parameters.map(item => escapeHtml(item.name)).join(", ")}</p>
    <p>${escapeHtml(module.description)}</p>
    ${pumpArrangements}
    <label class="equipment-parameter-select" for="equipmentParameter">Select parameter
      <select id="equipmentParameter" aria-label="Select parameter">
        ${parameters.map(item => `<option value="${escapeHtml(item.name)}"${item.name === (parameter && parameter.name) ? " selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
      </select>
    </label>
    ${parameter ? renderEquipmentParameter(module, parameter, trial) : ""}
    `;
  const injectorGallery = $("equipmentLayout").querySelector(".injector-image-gallery");
  if (injectorGallery) injectorGallery.remove();
  if (injectorImage) $("equipmentFigure").insertAdjacentHTML("beforeend", injectorImage);
}
function renderParameters(data) {
  const canEditAllParameters = Boolean(data.nomenclatureMismatch);
  const cell = ([label, key]) => {
    if (key === "coreShell") {
      if (!data.columnType) return parameterShown(data.coreShell);
      return parameterShown(/^raptor$/i.test(String(data.columnType).trim()) ? "Yes" : "No");
    }
    if (key === "poreSize" || key === "cLoad") {
      const defaultValue = key === "poreSize" ? "140" : "6";
      const isDefault = String(data[key] ?? "").trim() === defaultValue;
      return `<div class="default-parameter-control"><input type="text" aria-label="${escapeHtml(label)}" data-parameter-key="${escapeHtml(key)}" value="${escapeHtml(data[key] ?? "")}"><span class="default-value-badge${isDefault ? "" : " edited"}">${isDefault ? "DEFAULT VALUE · change if required" : "EDITED VALUE"}</span></div>`;
    }
    if (canEditAllParameters) {
      return `<input type="text" aria-label="${escapeHtml(label)}" data-parameter-key="${escapeHtml(key)}" value="${escapeHtml(data[key] ?? "")}">`;
    }
    if (key === "columnType") {
      return parameterShown(data[key]);
    }
    return parameterShown(data[key], key === "percentB" ? "%" : "");
  };
  $("nomenclatureWarning").hidden = !canEditAllParameters;
  $("parameters").innerHTML = `<div class="table-wrap"><table><thead><tr>${parameterLabels.map(([label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody><tr>${parameterLabels.map(cell).map(value => `<td>${value}</td>`).join("")}</tr></tbody></table></div>`;
}
function renderTrials() {
  const trialsWrap = document.querySelector(".trials-table-wrap");
  const previousScrollLeft = trialsWrap.scrollLeft;
  const rows = [];
  trials.forEach((trial, index) => {
    rows.push(trialRow(trial, index + 1, trial.recommendation, false, index));
    const suggestionValues = Number.isInteger(trial.thenPredictionSourceIndex)
      ? []
      : suggestedPercentBs(trial);
    if (trial.recommendation === "Jump to Minimum %B THEN, Intermediate %B" &&
        trial.thenIntermediateSelected &&
        Number.isFinite(trial.thenConfirmedIntermediatePercentB)) {
      suggestionValues.push(trial.thenConfirmedIntermediatePercentB);
    }
    suggestionValues.forEach((percentB, suggestionIndex) => {
      const suggestionKey = `${index}:${suggestionIndex}`;
      if (deletedSuggestions.has(suggestionKey)) return;
      const hasMinimumIntermediatePredictions =
        trial.recommendation === "Jump to Minimum %B OR Intermediate %B" ||
        trial.recommendation === "Jump to Minimum %B THEN, Intermediate %B";
      const nextTrial = {
        ...trial,
        percentB: trial.prediction?.percentOptions ? trial.prediction.percentB : percentB,
        recommendation: "Suggested next run", isSuggested: true
      };
      nextTrial.sequencePlan = trial.sequencePlan;
      const nextNumber = Number(trial.injectionNo);
      nextTrial.injectionNo = Number.isFinite(nextNumber) ? String(nextNumber + suggestionIndex + 1).padStart(String(trial.injectionNo).length, "0") : `${index + suggestionIndex + 2}`;
      nextTrial.suggestionKey = suggestionKey;
      nextTrial.suggestionIndex = suggestionIndex;
      nextTrial.sourceRecommendation = trial.recommendation;
      nextTrial.sourceTrialIndex = index;
      nextTrial.prediction = hasMinimumIntermediatePredictions ? null : trial.prediction;
      nextTrial.suggestionType = hasMinimumIntermediatePredictions
        ? Number.isFinite(percentB)
          ? "minimum"
          : "minimum-intermediate-unavailable"
        : "next";
      if (trial.recommendation === "Jump to Minimum %B OR Intermediate %B" &&
          trial.minimumIntermediateChoice === "intermediate" &&
          Number.isFinite(trial.confirmedIntermediatePercentB)) {
        nextTrial.suggestionType = "intermediate";
      }
      if (trial.recommendation === "Jump to Minimum %B THEN, Intermediate %B" && suggestionIndex === 1) {
        nextTrial.suggestionType = "intermediate";
      }
      if (trial.sequencePlan) {
        nextTrial.suggestionType = trial.sequencePlan.kind === "minimum"
          ? "minimum"
          : trial.sequencePlan.kind === "intermediate"
            ? "intermediate"
            : "required";
      }
      nextTrial.minimumPercentBResult = trial.minimumPercentBResult;
      nextTrial.intermediatePercentBResult = trial.intermediatePercentBResult;
      nextTrial.isSelectivity = trial.recommendation === "Jump to SEL cycle";
      nextTrial.measuredTemperature = "";
      rows.push(nextTrial);
    });
  });
  const renderedRows = rows.map((row, rowIndex) => {
    if (typeof row === "string") return row;
    const hasRowBelow = rowIndex < rows.length - 1;
    const recommendation = row.suggestionType === "minimum"
        ? row.sourceRecommendation === "Jump to Minimum %B OR Intermediate %B"
          ? "Alternative 1: Minimum %B"
          : row.sourceRecommendation === "Jump to Minimum %B THEN, Intermediate %B"
            ? "Step 1 of 2: Minimum %B"
            : "Suggested minimum %B"
      : row.suggestionType === "intermediate"
        ? row.sourceRecommendation === "Jump to Minimum %B OR Intermediate %B"
          ? "Alternative 2: Intermediate %B"
          : row.sourceRecommendation === "Jump to Minimum %B THEN, Intermediate %B"
            ? "Step 2 of 2: Intermediate %B"
            : "Suggested intermediate %B"
      : row.suggestionType === "required"
        ? "Suggested required %B test"
        : row.suggestionType === "minimum-intermediate-unavailable"
          ? "Minimum/intermediate %B unavailable"
        : "Suggested next run";
    return trialRow(row, row.injectionNo, recommendation, true);
  });
  $("trialTable").querySelector("tbody").innerHTML = renderedRows.join("");
  renderIntermediateObservation();
  if (trials.length && !hasPositionedTrialTable) {
    trialsWrap.scrollLeft = trialsWrap.scrollWidth;
    hasPositionedTrialTable = true;
  } else {
    trialsWrap.scrollLeft = Math.min(previousScrollLeft, trialsWrap.scrollWidth - trialsWrap.clientWidth);
  }
}
function formatPercent(value) {
  return Number(value.toFixed(2)).toString();
}
function showSolventNomogram(acetonitrilePercentB, methanolPercentB, suggestionKey = null) {
  activeSolventNomogram = { acetonitrilePercentB, methanolPercentB, suggestionKey };
  const panel = $("solventNomogramPanel");
  const pair = `${formatPercent(acetonitrilePercentB)}% ACN → ${formatPercent(methanolPercentB)}% MeOH`;
  $("solventNomogramPair").textContent = pair;
  panel.hidden = false;
  const x = percentB => 84 + percentB * 4.16;
  const acnX = x(acetonitrilePercentB);
  const methanolX = x(methanolPercentB);
  const line = $("nomogramConversionLine");
  line.setAttribute("x1", String(acnX));
  line.setAttribute("y1", "144");
  line.setAttribute("x2", String(methanolX));
  line.setAttribute("y2", "60");
  const methanolPoint = $("nomogramMethanolPoint");
  methanolPoint.setAttribute("cx", String(methanolX));
  methanolPoint.setAttribute("cy", "60");
  const acetonitrilePoint = $("nomogramAcetonitrilePoint");
  acetonitrilePoint.setAttribute("cx", String(acnX));
  acetonitrilePoint.setAttribute("cy", "144");
  const methanolLabel = $("nomogramMethanolValue");
  methanolLabel.textContent = `${formatPercent(methanolPercentB)}%`;
  methanolLabel.setAttribute("x", String(methanolX));
  methanolLabel.setAttribute("y", "25");
  methanolLabel.setAttribute("text-anchor", methanolX > 470 ? "end" : methanolX < 115 ? "start" : "middle");
  const acetonitrileLabel = $("nomogramAcetonitrileValue");
  acetonitrileLabel.textContent = `${formatPercent(acetonitrilePercentB)}%`;
  acetonitrileLabel.setAttribute("x", String(acnX));
  acetonitrileLabel.setAttribute("y", "196");
  acetonitrileLabel.setAttribute("text-anchor", acnX > 470 ? "end" : acnX < 115 ? "start" : "middle");
}
function closeSolventNomogram() {
  $("solventNomogramPanel").hidden = true;
  activeSolventNomogram = null;
}
function trialRow(trial, fallbackNumber, recommendation, canDelete = false, sourceIndex = null) {
  const cells = parameterLabels.map(([, key]) => {
    if (trial.isSuggested && key === "percentB" &&
        trial.sourceRecommendation === "Jump to Minimum %B OR Intermediate %B" &&
        trial.suggestionIndex === 0) {
      const source = trials[trial.sourceTrialIndex];
      const choice = source?.minimumIntermediateChoice || "minimum";
      const options = [
        `<option value="minimum"${choice === "minimum" ? " selected" : ""}>Minimum %B (${escapeHtml(String(trial.minimumPercentBResult ?? "unavailable"))}%)</option>`,
        `<option value="observe"${choice === "observe" ? " selected" : ""}>OBSERVE to choose Intermediate %B</option>`,
        ...(Number.isFinite(source?.confirmedIntermediatePercentB)
          ? [`<option value="intermediate"${choice === "intermediate" ? " selected" : ""}>Intermediate %B (${source.confirmedIntermediatePercentB}%)</option>`]
          : [])
      ];
      return `<td><select class="minimum-intermediate-choice" data-suggestion-key="${trial.suggestionKey}" aria-label="Choose Minimum or observed Intermediate %B">${options.join("")}</select><small>Choose OBSERVE to inspect and confirm an alternative.</small></td>`;
    }
    if (trial.isSuggested && key === "percentB" &&
        trial.sourceRecommendation === "Jump to Minimum %B THEN, Intermediate %B" &&
        trial.suggestionIndex === 0) {
      const source = trials[trial.sourceTrialIndex];
      const confirmed = source?.thenConfirmedIntermediatePercentB;
      const options = [
        `<option value="minimum"${!source?.thenIntermediateSelected ? " selected" : ""}>Minimum %B · Step 1</option>`,
        `<option value="intermediate"${source?.thenIntermediateSelected ? " selected" : ""}${Number.isFinite(confirmed) ? "" : " disabled"}>${Number.isFinite(confirmed) ? `Add Intermediate %B (${confirmed}%) · Step 2` : "Intermediate %B · complete OBSERVE after Step 1 first"}</option>`
      ];
      return `<td>${parameterShown(trial[key], "%")}<small>Minimum %B · Step 1 of 2</small><label class="suggestion-option-label" for="thenIntermediateChoice-${trial.suggestionKey}">Optional Step 2</label><select id="thenIntermediateChoice-${trial.suggestionKey}" class="then-intermediate-choice" data-suggestion-key="${trial.suggestionKey}" aria-label="Add the observed Intermediate %B run">${options.join("")}</select></td>`;
    }
    if (trial.isSuggested && trial.sequencePlan && key === "percentB") {
      if (trial.prediction?.conversionMappings?.length) {
        const options = trial.prediction.conversionMappings.map(mapping =>
          `<option value="${mapping.methanolPercentB}"${Number(trial.prediction.percentB) === mapping.methanolPercentB ? " selected" : ""}>${mapping.methanolPercentB}% MeOH (${mapping.acetonitrilePercentB}% ACN)</option>`
        );
        return `<td><select class="prediction-percent" data-suggestion-key="${trial.suggestionKey}" aria-label="Select converted Methanol %B test">${options.join("")}</select><small>Required next test is selected by default</small></td>`;
      }
      const phase = trial.sequencePlan.kind === "minimum"
        ? "Minimum %B"
        : trial.sequencePlan.kind === "intermediate"
          ? "Intermediate %B"
          : "Required sequence value";
      return `<td>${parameterShown(trial[key], "%")}<small>${phase} · actual run required</small></td>`;
    }
    if (trial.isSuggested && trial.prediction && key === "percentB" && trial.prediction.percentOptions?.length) {
      return `<td><select class="prediction-percent" data-suggestion-key="${trial.suggestionKey}" aria-label="Predicted %B">${trial.prediction.percentOptions.map(value => `<option value="${value}"${Number(trial.prediction.percentB) === value ? " selected" : ""}>${value}% B</option>`).join("")}</select></td>`;
    }
    if (trial.isSuggested && key === "percentB" && trial.suggestionType === "minimum") {
      return `<td>${parameterShown(trial[key], "%")}<small>Minimum %B</small></td>`;
    }
    if (trial.isSuggested && key === "percentB" && trial.suggestionType === "intermediate") {
      return `<td>${parameterShown(trial[key], "%")}<small>Intermediate %B</small></td>`;
    }
    if (trial.isSuggested && trial.prediction && key === "solvent" && trial.prediction.solventControl === "organic-solvent") {
      return `<td><select class="prediction-solvent" data-suggestion-key="${trial.suggestionKey}" aria-label="Predicted solvent"><option value="ACN"${trial.prediction.solvent === "ACN" ? " selected" : ""}>ACN</option><option value="METHANOL"${trial.prediction.solvent === "METHANOL" ? " selected" : ""}>METHANOL</option></select></td>`;
    }
    if (trial.isSuggested && trial.prediction && key === "solvent" && trial.prediction.solventControl === "mixed-solvent") {
      return `<td><input class="prediction-solvent-text" data-suggestion-key="${trial.suggestionKey}" aria-label="Predicted mixed solvent" value="${escapeHtml(trial.prediction.solvent)}"></td>`;
    }
    if (trial.isSuggested && trial.prediction?.ligandControl && key === "ligand") {
      return `<td><select class="prediction-ligand" data-suggestion-key="${trial.suggestionKey}" aria-label="Predicted ligand">${["A", "B", "C", "D"].map(value => `<option value="${value}"${trial.prediction.ligand === value ? " selected" : ""}>${value}</option>`).join("")}</select></td>`;
    }
    if (trial.isSuggested && trial.prediction && key === "setTemperature") {
      const temperature = trial.prediction.temperature === 25 ? "Ambient" : String(trial.prediction.temperature);
      return `<td>${escapeHtml(temperature)}</td>`;
    }
    if (trial.isSuggested && trial.isSelectivity && key === "percentB") {
      const options = selectivityPercentOptions();
      const intermediateSelected = trial.percentB === "";
      return `<td><select class="suggestion-percent" data-suggestion-key="${trial.suggestionKey}"><option value="intermediate"${intermediateSelected ? " selected" : ""}>Intermediate %B (blank)</option>${options.map(value => `<option value="${value}"${Number(trial.percentB) === value ? " selected" : ""}>${value}%</option>`).join("")}</select></td>`;
    }
    if (trial.isSuggested && trial.isSelectivity && key === "setTemperature") {
      const temperature = trial.suggestedTemperature || "40";
      return `<td><select class="suggestion-temperature" data-suggestion-key="${trial.suggestionKey}"><option value="40"${temperature === "40" ? " selected" : ""}>40°C</option><option value="60"${temperature === "60" ? " selected" : ""}>60°C</option></select></td>`;
    }
    return `<td>${parameterShown(trial[key], key === "percentB" ? "%" : key === "injectionVolume" ? " µL" : "")}</td>`;
  }).join("");
  const conversionMapping = trial.isSuggested
    ? trial.prediction?.conversionMappings?.find(mapping =>
      Math.abs(mapping.methanolPercentB - Number(trial.prediction.percentB)) < 0.01
    )
    : trial.solventConversion;
  const conversionAction = conversionMapping
    ? `<button type="button" class="view-solvent-conversion" data-acn-percent="${conversionMapping.acetonitrilePercentB ?? conversionMapping.fromPercentB}" data-meoh-percent="${conversionMapping.methanolPercentB ?? conversionMapping.toPercentB}"${trial.isSuggested ? ` data-suggestion-key="${trial.suggestionKey}"` : ""}>${trial.isSuggested ? "Predicted" : "Recorded"}: ${conversionMapping.acetonitrilePercentB ?? conversionMapping.fromPercentB}% ACN → ${conversionMapping.methanolPercentB ?? conversionMapping.toPercentB}% MeOH · View nomogram</button>`
    : "";
  const excludedConversions = trial.isSuggested
    ? trial.prediction?.excludedConversions || []
    : [];
  const excludedConversionText = excludedConversions.length
    ? `<small>Excluded above 100%: ${excludedConversions.map(mapping =>
      `${mapping.acetonitrilePercentB}% ACN → ${mapping.methanolPercentB}% MeOH`
    ).map(escapeHtml).join(", ")}</small>`
    : "";
  const actionItems = [
    canDelete ? `<button type="button" class="delete-suggestion" data-suggestion-key="${trial.suggestionKey}">Delete</button>` : "",
    trial.nomenclatureMismatch
      ? `<span class="nomenclature-warning">${escapeHtml(NAMING_MISMATCH_MESSAGE).replace(/\n/g, "<br>")}</span>`
      : "",
    conversionAction,
    excludedConversionText
  ].filter(Boolean);
  const action = actionItems.join("<br>");
  const selected = !trial.isSuggested && sourceIndex === currentViewedTrialIndex ? " selected-trial" : "";
  const classes = `${trial.isSuggested ? "suggested-trial" : "source-trial"}${selected}`;
  const sourceAttribute = sourceIndex === null ? "" : ` data-source-index="${sourceIndex}"`;
  const measurementCell = (value, status, target = "") => {
    const accessibleStatus = target ? `${status.label}; ${target}` : status.label;
    const statusText = target ? `${status.label} · ${escapeHtml(target)}` : status.label;
    return `<td class="trial-measurement ${status.className}" aria-label="${escapeHtml(`${value}; ${accessibleStatus}`)}"><strong>${escapeHtml(value)}</strong><small>${statusText}</small></td>`;
  };
  const pendingMeasurement = () => measurementCell("Not run", { label: "PENDING", className: "status-unavailable" }, "awaiting run");
  const measuredCells = trial.isSuggested
    ? `${pendingMeasurement()}${pendingMeasurement()}${pendingMeasurement()}${pendingMeasurement()}`
    : (() => {
      const statuses = runMeasurementStatuses(trial);
      const runTime = decisionRunTime(trial);
      const spec = specifications();
      const isValidated = specificationValidationState === "VALID";
      const specValue = value => isValidated && Number.isFinite(value) ? value : "not validated";
      const values = [
        [shown(trial.peakCount), statuses.peakCount, `target ≥ ${specValue(spec.peaks)}`],
        [shown(runTime, " min"), statuses.retentionTime, `maximum ${specValue(spec.time)} min`],
        [Number.isFinite(trial.pressure) ? `${trial.pressure.toFixed(3)} psi` : "Not available", statuses.pressure, `maximum ${specValue(spec.pressure)} psi`]
      ];
      const measurementCells = values.map(([value, status, target]) => measurementCell(value, status, target));
      const resolutionCell = statuses.resolution.label === "NOT ASSESSED"
        ? measurementCell(shown(trial.resolution, " Rmin"), statuses.resolution)
        : measurementCell(shown(trial.resolution, " Rmin"), statuses.resolution, `minimum ${specValue(spec.resolution)} Rmin`);
      measurementCells.splice(2, 0, resolutionCell);
      return measurementCells.join("");
    })();
  const decisionCell = trial.isSuggested
    ? `<span class="suggested-row-label">${escapeHtml(recommendation)}</span>${
      trial.suggestionType === "minimum" && trial.sourceRecommendation === "Jump to Minimum %B OR Intermediate %B"
        ? `<small class="suggestion-sequence-note">Alternative: use OBSERVE to select and confirm Intermediate %B instead.</small>`
        : trial.suggestionType === "intermediate" && trial.sourceRecommendation === "Jump to Minimum %B OR Intermediate %B"
          ? `<small class="suggestion-sequence-note">Alternative selected after OBSERVE confirmation.</small>`
        : trial.suggestionType === "minimum" && trial.sourceRecommendation === "Jump to Minimum %B THEN, Intermediate %B"
          ? `<small class="suggestion-sequence-note">Required first run. After its result is uploaded, OBSERVE and confirm Intermediate %B for Step 2.</small>`
          : trial.suggestionType === "intermediate" && trial.sourceRecommendation === "Jump to Minimum %B THEN, Intermediate %B"
            ? `<small class="suggestion-sequence-note">Optional Step 2 using the confirmed Intermediate %B; conditions are copied from the Step 1 prediction.</small>`
          : ""
    }`
    : specificationValidationState !== "VALID"
      ? `<span class="recommendation-paused">${specificationValidationState === "INVALID"
        ? "INVALID — decision paused"
        : "NOT YET VALIDATED — run analysis"}</span>`
      : `${escapeHtml(recommendation)}${sourceIndex !== null && recommendation === DECREASE_PERCENT_B_RECOMMENDATION
      ? `<br><button type="button" class="view-pump-percent-explanation" data-source-index="${sourceIndex}">Open Decision-engine Relationship</button>`
      : ""}`;
  const pumpGuidanceKind = trial.isSuggested
    ? trial.suggestionType === "minimum"
      ? trial.sourceRecommendation === "Jump to Minimum %B OR Intermediate %B" ? "minimum-or" : "minimum-then"
      : trial.suggestionType === "intermediate"
        ? "intermediate"
        : ""
    : trial.recommendation === "Jump to Minimum %B OR Intermediate %B"
      ? "minimum-or"
      : trial.recommendation === "Jump to Minimum %B THEN, Intermediate %B"
        ? "minimum-then"
        : "";
  const pumpGuidancePercentB = trial.isSuggested
    ? trial.percentB
    : pumpGuidanceKind === "minimum-or"
      ? trial.minimumPercentBResult
      : trial.minimumPercentBResult;
  const pumpGuidanceButton = pumpGuidanceKind && Number.isInteger(trial.isSuggested ? trial.sourceTrialIndex : sourceIndex)
    ? `<br><button type="button" class="view-minimum-intermediate-guidance" data-source-index="${trial.isSuggested ? trial.sourceTrialIndex : sourceIndex}" data-pump-action="${trial.isSuggested && trial.suggestionType === "intermediate" ? "intermediate" : pumpGuidanceKind}"${Number.isFinite(pumpGuidancePercentB) ? ` data-pump-percentb="${pumpGuidancePercentB}"` : ""}>Open Pump %B composition guidance</button>`
    : "";
  const selectivityStageIndex = trial.sequencePlan?.kind === "selectivity"
    ? Number(trial.sequencePlan.stageIndex)
    : null;
  const selectivityTarget = Number.isInteger(selectivityStageIndex)
    ? selectivityEquipmentTarget(selectivityStageIndex)
    : null;
  const selectivityPrediction = trial.prediction || {};
  const selectivityGuidanceButton = selectivityTarget && Number.isInteger(trial.isSuggested ? trial.sourceTrialIndex : sourceIndex)
    ? `<br><button type="button" class="view-selectivity-guidance" data-source-index="${trial.isSuggested ? trial.sourceTrialIndex : sourceIndex}" data-stage-index="${selectivityStageIndex}" data-equipment-module="${selectivityTarget.module}" data-equipment-parameter="${escapeHtml(selectivityTarget.parameter)}" data-stage-solvent="${escapeHtml(selectivityPrediction.solvent || trial.sequencePlan.stage?.solvent || trial.solvent || "")}" data-stage-temperature="${escapeHtml(String(selectivityPrediction.temperature ?? trial.sequencePlan.stage?.temperature ?? ""))}" data-stage-percentb="${escapeHtml(String(selectivityPrediction.percentB ?? trial.percentB ?? ""))}" data-stage-ligand="${escapeHtml(selectivityPrediction.ligand || trial.sequencePlan.ligand || trial.ligand || "")}">Open Selectivity Equipment guidance</button>`
    : "";
  const linkedDecisionCell = pumpGuidanceButton || selectivityGuidanceButton
    ? `${decisionCell}${pumpGuidanceButton}${selectivityGuidanceButton}`
    : decisionCell;
  return `<tr class="${classes}"${sourceAttribute}><td>${parameterShown(trial.groupNo)}</td><td>${parameterShown(trial.injectionNo || fallbackNumber)}</td>${cells}<td>${linkedDecisionCell}</td><td>${action}</td>${measuredCells}</tr>`;
}
function clearCurrentView() {
  renderEquipment();
}
async function readFile(file) {
  if (file.name.toLowerCase().endsWith(".xlsx")) {
    if (!window.XLSX) throw new Error("The XLSX converter could not be loaded. Connect to the internet and try again.");
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    return workbook.SheetNames.flatMap(name => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: "", blankrows: true }));
  }
  return csvRows(await file.text());
}
$("runFile").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) return;
  pendingRunFile = file;
  $("fileName").textContent = file.name;
  $("error").hidden = true;
  runAnalysis();
});
$("runAnalysis").addEventListener("click", runAnalysis);
$("clearSavedRuns").addEventListener("click", () => {
  if (!window.confirm("Clear all uploaded run records saved in this browser?")) return;
  try {
    window.localStorage.removeItem(TRIALS_STORAGE_KEY);
    trials.splice(0, trials.length);
    currentViewedTrialIndex = null;
    parameterTrialIndex = null;
    hasPositionedTrialTable = false;
    $("savedRunStatus").textContent = "No uploaded run records are saved in this browser.";
    renderTrials();
    renderParameters({ ligand: "-", columnType: "", coreShell: "", poreSize: "140", cLoad: "6", length: "-", diameter: "-", particleSize: "-", solvent: "-", percentB: "-", flow: "-", sampleConc: "-", injectionVolume: "-", setTemperature: "-", measuredTemperature: "-", wavelength: "-" });
    renderEquipment();
  } catch (error) {
    reportTrialStorageError("cleared", error);
  }
});
specificationFields.forEach(field => $(field.id).addEventListener("input", markSpecificationsEdited));
function showAppView(activeView) {
document.querySelectorAll("[data-app-tab]").forEach(tab => {
  const selected = tab.dataset.appTab === activeView;
  tab.classList.toggle("active", selected);
  tab.setAttribute("aria-selected", String(selected));
});
$("analysisView").hidden = activeView !== "analysisView";
$("equipmentView").hidden = activeView !== "equipmentView";
if (activeView === "equipmentView") renderEquipment();
}
document.querySelectorAll("[data-app-tab]").forEach(button => button.addEventListener("click", () => {
  showAppView(button.dataset.appTab);
}));
function selectRunForNavigation(index) {
  const trial = trials[index];
  if (!trial) return null;
  currentViewedTrialIndex = index;
  parameterTrialIndex = index;
  renderParameters(trial);
  renderEquipment();
  $("trialTable").querySelectorAll(".source-trial").forEach(row => {
    row.classList.toggle("selected-trial", Number(row.dataset.sourceIndex) === index);
  });
  return trial;
}
document.addEventListener("click", event => {
  const pumpLink = event.target.closest(".view-pump-percent-explanation");
  const minimumIntermediateLink = event.target.closest(".view-minimum-intermediate-guidance");
  const selectivityLink = event.target.closest(".view-selectivity-guidance");
  if (pumpLink || minimumIntermediateLink || selectivityLink) {
    const link = pumpLink || minimumIntermediateLink || selectivityLink;
    const index = Number(link.dataset.sourceIndex);
    if (!selectRunForNavigation(index)) return;
    activePumpPercentBDecision = minimumIntermediateLink
      ? {
        kind: link.dataset.pumpAction,
        percentB: Number.isFinite(Number(link.dataset.pumpPercentb))
          ? Number(link.dataset.pumpPercentb)
          : null
      }
      : null;
    if (selectivityLink) {
      const stageIndex = Number(link.dataset.stageIndex);
      const target = selectivityEquipmentTarget(stageIndex);
      if (!target || target.module !== link.dataset.equipmentModule || target.parameter !== link.dataset.equipmentParameter) return;
      activePumpPercentBDecision = null;
      activeSelectivityDecision = {
        stageIndex,
        prediction: {
          solvent: link.dataset.stageSolvent,
          temperature: link.dataset.stageTemperature === "" ? null : Number(link.dataset.stageTemperature),
          percentB: link.dataset.stagePercentb === "" ? null : Number(link.dataset.stagePercentb),
          ligand: link.dataset.stageLigand
        }
      };
      activeEquipmentModule = target.module;
      activeEquipmentParameter = target.parameter;
    } else {
      activeSelectivityDecision = null;
      activeEquipmentModule = "pump";
      activeEquipmentParameter = equipmentModules.pump.parameters.find(parameter =>
        parameter.name === "%B (Pump composition setting)")?.name || "";
    }
    showAppView("equipmentView");
    const relationship = document.querySelector("#pump-percent-b-decision-relationship, .selectivity-decision-relationship");
    relationship?.scrollIntoView({ behavior: "smooth", block: "start" });
    (relationship?.querySelector("h4") || document.getElementById("pump-percent-b-decision-heading"))?.focus({ preventScroll: true });
    return;
  }
  const returnLink = event.target.closest(".return-to-decision");
  if (returnLink) {
    const trial = selectRunForNavigation(Number(returnLink.dataset.sourceIndex));
    if (!trial) return;
    showAppView("analysisView");
    document.querySelector(`#trialTable tbody tr.source-trial[data-source-index="${Number(returnLink.dataset.sourceIndex)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});
document.querySelectorAll("[data-equipment-module]").forEach(button => button.addEventListener("click", () => {
activeEquipmentModule = button.dataset.equipmentModule;
const module = equipmentModules[activeEquipmentModule];
activeEquipmentParameter = module && module.parameters.length ? module.parameters[0].name : "";
renderEquipment();
}));
$("equipmentDetails").addEventListener("change", event => {
  if (event.target.id !== "equipmentParameter") return;
  activeEquipmentParameter = event.target.value;
  renderEquipment();
});
$("equipmentLayout").addEventListener("click", event => {
  const button = event.target.closest("[data-injector-image]");
  if (!button) return;
  activeInjectorImage = button.dataset.injectorImage;
  renderEquipment();
});
$("trialTable").addEventListener("click", event => {
  const conversionButton = event.target.closest(".view-solvent-conversion");
  if (conversionButton) {
    showSolventNomogram(Number(conversionButton.dataset.acnPercent), Number(conversionButton.dataset.meohPercent), conversionButton.dataset.suggestionKey || null);
    return;
  }
  const sourceRow = event.target.closest(".source-trial");
  if (sourceRow && !event.target.closest("button")) {
    const trial = trials[Number(sourceRow.dataset.sourceIndex)];
    if (trial) {
      currentViewedTrialIndex = Number(sourceRow.dataset.sourceIndex);
      parameterTrialIndex = currentViewedTrialIndex;
      renderParameters(trial);
      renderEquipment();
      $("trialTable").querySelectorAll(".source-trial").forEach(row => row.classList.remove("selected-trial"));
      sourceRow.classList.add("selected-trial");
    }
    return;
  }
  const button = event.target.closest(".delete-suggestion");
  if (!button) return;
  deletedSuggestions.add(button.dataset.suggestionKey);
  renderTrials();
});
$("parameters").addEventListener("change", event => {
  const control = event.target.closest("[data-parameter-key]");
  if (!control || parameterTrialIndex === null) return;
  const trial = trials[parameterTrialIndex];
  if (!trial || trial.isSuggested) return;
  const key = control.dataset.parameterKey;
  const value = key === "setTemperature" && /^amb(?:ient)?$/i.test(control.value.trim())
    ? "25"
    : editableParameterNumberKeys.has(key)
      ? numeric(control.value) ?? ""
      : control.value.trim();
  trial[key] = value;
  if (key === "columnType") {
    trial.coreShell = /^raptor$/i.test(String(value).trim()) ? "Yes" : "No";
  }
  trials.slice(parameterTrialIndex).forEach(updateRecommendation);
  persistUploadedTrials();
  renderParameters(trial);
  renderTrials();
  renderEquipment();
});
$("trialTable").addEventListener("change", event => {
  const control = event.target.closest(".minimum-intermediate-choice, .then-intermediate-choice, .suggestion-percent, .suggestion-temperature, .prediction-percent, .prediction-solvent, .prediction-solvent-text, .prediction-ligand");
  if (!control) return;
  const suggestionKey = control.dataset.suggestionKey;
  const trial = trials.find(item => `${trials.indexOf(item)}:0` === suggestionKey);
  if (!trial) return;
  if (control.classList.contains("minimum-intermediate-choice")) {
    trial.minimumIntermediateChoice = control.value;
    persistUploadedTrials();
    renderTrials();
    if (control.value === "observe") {
      $("intermediateObservation").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }
  if (control.classList.contains("then-intermediate-choice")) {
    trial.thenIntermediateSelected = control.value === "intermediate";
    persistUploadedTrials();
    renderTrials();
    return;
  }
  if (control.classList.contains("suggestion-percent")) trial.nextPercentB = control.value === "intermediate" ? "" : Number(control.value);
  if (control.classList.contains("suggestion-temperature")) trial.suggestedTemperature = control.value;
  if (trial.prediction && control.classList.contains("prediction-percent")) {
    trial.prediction.percentB = Number(control.value);
    const mapping = trial.prediction.conversionMappings?.find(item =>
      Math.abs(item.methanolPercentB - trial.prediction.percentB) < 0.01
    );
    if (mapping) trial.prediction.sourcePercentB = mapping.acetonitrilePercentB;
    if (mapping && activeSolventNomogram?.suggestionKey === suggestionKey) {
      showSolventNomogram(mapping.acetonitrilePercentB, mapping.methanolPercentB, suggestionKey);
    }
  }
  if (trial.prediction && control.classList.contains("prediction-solvent")) trial.prediction.solvent = control.value;
  if (trial.prediction && control.classList.contains("prediction-solvent-text")) trial.prediction.solvent = control.value;
  if (trial.prediction && control.classList.contains("prediction-ligand")) trial.prediction.ligand = control.value;
  renderTrials();
});
$("closeSolventNomogram").addEventListener("click", closeSolventNomogram);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("solventNomogramPanel").hidden) closeSolventNomogram();
});
$("trialTable").addEventListener("input", event => {
  const control = event.target.closest(".prediction-solvent-text");
  if (!control) return;
  const trial = trials.find(item => `${trials.indexOf(item)}:0` === control.dataset.suggestionKey);
  if (trial?.prediction) trial.prediction.solvent = control.value;
});
$("intermediateObservation").addEventListener("change", event => {
  const candidate = event.target.closest("#intermediateObservationCandidate");
  const value = $("intermediateObservationValue");
  if (candidate && value) value.value = candidate.value;
  if (event.target.id === "intermediateObservationValue") {
    $("intermediateObservationCandidate").value = "";
  }
});
$("intermediateObservation").addEventListener("click", event => {
  const button = event.target.closest("#confirmIntermediateObservation");
  if (!button) return;
  const trial = trials[Number(button.dataset.trialIndex)];
  const valueInput = $("intermediateObservationValue");
  const status = $("intermediateObservationStatus");
  if (!trial || !valueInput || !status) return;
  const rawValue = valueInput.value.trim();
  const value = rawValue ? Number(rawValue) : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    status.textContent = "Enter or select a numeric %B from 0 to 100 before confirming.";
    valueInput.setAttribute("aria-invalid", "true");
    valueInput.focus();
    return;
  }
  valueInput.removeAttribute("aria-invalid");
  trial.confirmedIntermediatePercentB = value;
  const trialIndex = trials.indexOf(trial);
  const previousThenRun = trials.slice(0, trialIndex).reverse().find(previous =>
    previous.recommendation === "Jump to Minimum %B THEN, Intermediate %B" &&
    sameRunSeries(previous, trial) &&
    sameSolvent(previous.solvent, trial.solvent) &&
    Number(previous.setTemperature) === Number(trial.setTemperature) &&
    Number.isFinite(previous.minimumPercentBResult) &&
    Math.abs(previous.minimumPercentBResult - Number(trial.percentB)) < 0.01
  );
  if (previousThenRun) {
    previousThenRun.thenConfirmedIntermediatePercentB = value;
    trial.thenPredictionSourceIndex = trials.indexOf(previousThenRun);
  }
  if (trial.recommendation !== "Jump to Minimum %B OR Intermediate %B") {
    updateRecommendation(trial);
  }
  persistUploadedTrials();
  renderTrials();
  renderEquipment();
});
restoreUploadedTrials();
renderSpecificationValidation(validateMethodSpecifications(), "NOT YET VALIDATED");
renderTrials();
renderParameters(trials.at(-1) || { ligand: "-", columnType: "", coreShell: "", poreSize: "140", cLoad: "6", length: "-", diameter: "-", particleSize: "-", solvent: "-", percentB: "-", flow: "-", sampleConc: "-", injectionVolume: "-", setTemperature: "-", measuredTemperature: "-", wavelength: "-" });
renderEquipment();
