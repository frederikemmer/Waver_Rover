"use strict";

const cameraViewport = document.querySelector(".camera-viewport");
const cameraFeed = document.getElementById("camera-feed");
const cameraPlaceholder = document.getElementById("camera-placeholder");
const cameraStatus = document.getElementById("camera-status");
const cameraLiveLabel = document.getElementById("camera-live-label");
const cameraResolution = document.getElementById("camera-resolution");
const lineStatePill = document.getElementById("line-state-pill");
const lineStateMessage = document.getElementById("line-state-message");
const linePosition = document.getElementById("line-position");
const lineArea = document.getElementById("line-area");
const lineFps = document.getElementById("line-fps");
const lineMask = document.getElementById("line-mask");
const lineMaskViewport = document.querySelector(".line-mask-viewport");
const lineMaskPlaceholder = document.getElementById("line-mask-placeholder");
const lineColor = document.getElementById("line-color");
const lineMode = document.getElementById("line-mode");
const betweenStrategyField = document.getElementById("between-strategy-field");
const betweenStrategy = document.getElementById("between-strategy");
const lineSpeed = document.getElementById("line-speed");
const lineSpeedNumber = document.getElementById("line-speed-number");
const lineRoiTop = document.getElementById("line-roi-top");
const lineGain = document.getElementById("line-gain");
const lineMinArea = document.getElementById("line-min-area");
const lineApply = document.getElementById("line-apply");
const lineStart = document.getElementById("line-start");
const lineStop = document.getElementById("line-stop");
const colorPickButton = document.getElementById("color-pick-button");
const colorPickerHint = document.getElementById("color-picker-hint");
const colorSampleValues = document.getElementById("color-sample-values");
const colorSwatch = document.getElementById("color-swatch");
const colorPickTarget = document.getElementById("color-pick-target");
const workspace = document.querySelector(".autonomy-workspace");
const controlCard = document.querySelector(".autonomy-controls");
const workspaceSplitter = document.querySelector(".workspace-splitter");
const batteryReadout = document.getElementById("battery-readout");
const batteryPercent = document.getElementById("battery-percent");
const batteryVoltage = document.getElementById("battery-voltage");
const cameraRoiOverlay = document.getElementById("line-roi-overlay");
const cameraTargetOverlay = document.getElementById("line-target-overlay");

const HSV_PRESETS = {
  white: { h_min: 0, h_max: 179, s_min: 0, s_max: 85, v_min: 150, v_max: 255 },
  black: { h_min: 0, h_max: 179, s_min: 0, s_max: 255, v_min: 0, v_max: 75 },
  yellow: { h_min: 17, h_max: 38, s_min: 80, s_max: 255, v_min: 80, v_max: 255 },
  red: { h_min: 170, h_max: 10, s_min: 90, s_max: 255, v_min: 55, v_max: 255 },
  green: { h_min: 38, h_max: 90, s_min: 60, s_max: 255, v_min: 45, v_max: 255 },
  blue: { h_min: 90, h_max: 135, s_min: 60, s_max: 255, v_min: 45, v_max: 255 }
};

const hsvRanges = {
  h: { min: document.getElementById("h-min"), max: document.getElementById("h-max"), limit: 179 },
  s: { min: document.getElementById("s-min"), max: document.getElementById("s-max"), limit: 255 },
  v: { min: document.getElementById("v-min"), max: document.getElementById("v-max"), limit: 255 }
};
const hsvKeys = ["h_min", "h_max", "s_min", "s_max", "v_min", "v_max"];
const adjustableInputs = [lineColor, lineMode, betweenStrategy, lineSpeed, lineSpeedNumber, lineRoiTop, lineGain, lineMinArea,
  colorPickButton, ...Object.values(hsvRanges).flatMap((range) => [range.min, range.max])].filter(Boolean);
let dirty = false;
let active = false;
let saving = false;
let initialized = false;
let refreshing = false;
let lastCameraPreset = cameraResolution.value;
let splitterPointerId = null;
let splitterStartX = 0;
let splitterStartWidth = 0;
let colorPicking = false;
const sampleCanvas = document.createElement("canvas");
const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });

function setStatus(element, state, label) {
  element.classList.remove("status-ready", "status-warning", "status-waiting");
  element.classList.add(
    state === "ready" ? "status-ready" : state === "warning" ? "status-warning" : "status-waiting"
  );
  element.querySelector("span:last-child").textContent = label;
}

function updateBattery(battery) {
  const voltage = Number(battery.voltage_v);
  batteryReadout.dataset.state = battery.state || "waiting";
  const estimate = battery.charge_percent_estimate;
  batteryPercent.textContent = Number.isFinite(estimate)
    ? `~${Math.round(estimate)} %`
    : battery.state === "disabled" ? "Nicht verfügbar" : "Warte auf Messwert …";
  if (Number.isFinite(voltage) && voltage > 0) {
    batteryVoltage.textContent = `${new Intl.NumberFormat("de-DE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(voltage)} V`;
    batteryReadout.title = "Grobe 3S-Li-Ion-Spannungsschätzung; unter Motorlast kann sie abweichen.";
  } else {
    batteryVoltage.textContent = "";
  }
}

function showSliderValues() {
  for (const [key, range] of Object.entries(hsvRanges)) {
    for (const endpoint of ["min", "max"]) {
      const input = range[endpoint];
      const value = document.getElementById(`${key}-${endpoint}-value`);
      const position = Math.round(Number(input.value) / range.limit * 100);
      value.textContent = input.value;
      value.dataset.position = String(position);
    }
  }
  document.getElementById("line-roi-value").textContent = `ab ${lineRoiTop.value} % Bildhöhe`;
  document.getElementById("line-gain-value").textContent = Number(lineGain.value).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  document.getElementById("line-area-value").textContent = `${Number(lineMinArea.value).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
  cameraRoiOverlay.setAttribute("y", lineRoiTop.value);
  cameraRoiOverlay.setAttribute("height", String(100 - Number(lineRoiTop.value)));
}

function readSettings() {
  return {
    color_preset: lineColor.value,
    line_mode: lineMode.value,
    between_strategy: betweenStrategy.value,
    h_min: Number(hsvRanges.h.min.value),
    h_max: Number(hsvRanges.h.max.value),
    s_min: Number(hsvRanges.s.min.value),
    s_max: Number(hsvRanges.s.max.value),
    v_min: Number(hsvRanges.v.min.value),
    v_max: Number(hsvRanges.v.max.value),
    roi_top_percent: Number(lineRoiTop.value),
    speed_percent: Number(lineSpeed.value),
    steering_gain: Number(lineGain.value),
    min_area_percent: Number(lineMinArea.value)
  };
}

function loadSettings(config) {
  lineColor.value = config.color_preset || "white";
  lineMode.value = config.line_mode || "single";
  betweenStrategy.value = config.between_strategy || "midpoint";
  for (const id of hsvKeys) {
    const [key, endpoint] = id.split("_");
    const input = hsvRanges[key][endpoint];
    if (Number.isFinite(Number(config[id]))) input.value = String(config[id]);
  }
  lineRoiTop.value = String(config.roi_top_percent ?? 58);
  lineSpeed.value = String(config.speed_percent ?? 15);
  lineSpeedNumber.value = lineSpeed.value;
  lineGain.value = String(config.steering_gain ?? 1.0);
  lineMinArea.value = String(config.min_area_percent ?? 0.15);
  updateBetweenStrategyVisibility();
  showSliderValues();
  dirty = false;
  initialized = true;
  updateButtons();
}

function setDirty() {
  dirty = true;
  showSliderValues();
  updateButtons();
}

function updateButtons(detection = null, available = false) {
  lineApply.disabled = active || saving || !dirty;
  lineStart.hidden = active;
  lineStop.hidden = !active;
  lineStart.disabled = active || dirty || saving || !available || !detection?.line_detected;
  for (const input of adjustableInputs) input.disabled = active || saving;
}

function updateBetweenStrategyVisibility() {
  betweenStrategyField.hidden = lineMode.value !== "between";
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  let result = {};
  try {
    result = await response.json();
  } catch (_error) {
    result = {};
  }
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function renderAutonomy(autonomy) {
  if (!autonomy) return;
  active = Boolean(autonomy.active);
  const detection = autonomy.detection || {};
  const frameWidth = Number(detection.width);
  const frameHeight = Number(detection.height);
  if (frameWidth > 0 && frameHeight > 0) {
    cameraViewport.style.setProperty("--camera-aspect", `${frameWidth} / ${frameHeight}`);
  }
  const stateText = {
    vision_unavailable: ["warning", "OpenCV fehlt", "OpenCV ist auf diesem Rover nicht installiert."],
    waiting_camera: ["waiting", "Warte auf Kamera", "Warte auf ein aktuelles Kamerabild."],
    updating: ["waiting", "Werte werden geprüft", "Die neuen Einstellungen werden auf das Livebild angewendet."],
    no_line: ["warning", "Keine Linie", "Farbprofil oder Bildbereich anpassen; erkannte Fläche in der Maske prüfen."],
    ready: ["ready", "Farbfläche erkannt", "Prüfe in der Erkennungsmaske, ob die erkannte Farbfläche wirklich deine Kurslinie ist."],
    following: ["ready", "Folgt der Linie", "Automatik aktiv. Bei Linienverlust stoppt der Rover."],
    paused: ["waiting", "Pausiert", "Geschwindigkeit steht auf 0 %."],
    line_lost: ["warning", "Linie verloren", "Motoren gestoppt. Linie neu ausrichten und erneut starten."],
    camera_lost: ["warning", "Kamera verloren", "Motoren gestoppt, weil kein aktuelles Kamerabild ankommt."],
    error: ["warning", "Erkennungsfehler", autonomy.error || "Die Linienauswertung wurde angehalten."]
  };
  const [tone, label, message] = stateText[autonomy.state] || stateText.waiting_camera;
  setStatus(lineStatePill, tone, label);
  lineStateMessage.textContent = dirty
    ? "Änderungen noch nicht angewendet. Einstellungen übernehmen, um die Maske zu aktualisieren."
    : message;
  if (detection.line_detected && Number.isFinite(Number(detection.target_x_percent))) {
    const position = Number(detection.target_x_percent);
    linePosition.textContent = `${Math.round(position)} %`;
    if (detection.line_count === 2 && autonomy.config?.between_strategy === "stay_between") {
      const left = Math.round(Number(detection.boundary_left_x_percent));
      const right = Math.round(Number(detection.boundary_right_x_percent));
      lineArea.textContent = `Korridor ${left}–${right} %`;
    } else {
      lineArea.textContent = `${detection.line_count === 2 ? "2 Linien" : "Linie"} · ${Number(detection.area_percent || 0).toLocaleString("de-DE")} %`;
    }
    cameraTargetOverlay.setAttribute("cx", String(position));
    cameraTargetOverlay.setAttribute("cy", String(detection.target_y_percent ?? 82));
    cameraTargetOverlay.removeAttribute("hidden");
  } else {
    linePosition.textContent = "—";
    lineArea.textContent = "Keine Linie";
    cameraTargetOverlay.setAttribute("hidden", "");
  }
  const fps = Number(detection.fps);
  lineFps.textContent = Number.isFinite(fps) && fps > 0 ? `${fps.toLocaleString("de-DE")} FPS` : "— FPS";
  if (autonomy.available) {
    lineMaskViewport.classList.add("has-frames");
    lineMaskPlaceholder.textContent = "Warte auf OpenCV-Auswertung …";
  } else {
    lineMaskViewport.classList.remove("has-frames");
    lineMaskPlaceholder.textContent = "OpenCV fehlt. Installiere das Paket python3-opencv.";
  }
  updateButtons(detection, Boolean(autonomy.available) && autonomy.state !== "updating");
}

function updateCamera(camera) {
  const width = Number(camera.width);
  const height = Number(camera.height);
  if (width > 0 && height > 0) {
    cameraViewport.style.setProperty("--camera-aspect", `${width} / ${height}`);
  }
  if (camera.preset && cameraResolution.value !== camera.preset) cameraResolution.value = camera.preset;
  if (camera.preset) lastCameraPreset = camera.preset;
  if (camera.state === "online") {
    setStatus(cameraStatus, "ready", "Kamera bereit");
    cameraLiveLabel.classList.remove("is-offline");
    cameraLiveLabel.querySelector("span:last-child").textContent = "LIVE";
    cameraPlaceholder.hidden = true;
  } else {
    const message = camera.state === "disabled" ? "Kamera deaktiviert" : camera.state === "offline" ? "Kamera offline" : "Verbinde …";
    setStatus(cameraStatus, camera.state === "disabled" || camera.state === "offline" ? "warning" : "waiting", message);
    cameraLiveLabel.classList.add("is-offline");
    cameraLiveLabel.querySelector("span:last-child").textContent = camera.state === "offline" ? "OFFLINE" : "WARTET";
    cameraPlaceholder.hidden = false;
  }
}

async function refreshStatus() {
  if (refreshing) return;
  refreshing = true;
  try {
    const status = await requestJson("/api/v1/status");
    updateBattery(status.battery || { state: "waiting" });
    updateCamera(status.camera || {});
    const autonomy = status.autonomy || {};
    if (!initialized && autonomy.config) loadSettings(autonomy.config);
    renderAutonomy(autonomy);
  } catch (error) {
    setStatus(lineStatePill, "warning", "Rover nicht erreichbar");
    lineStateMessage.textContent = "Die Verbindung zum Rover ist unterbrochen.";
    setStatus(cameraStatus, "warning", "Verbindung verloren");
    cameraLiveLabel.classList.add("is-offline");
    cameraLiveLabel.querySelector("span:last-child").textContent = "OFFLINE";
    updateButtons(null, false);
    console.error(error.message);
  } finally {
    refreshing = false;
  }
}

async function applySettings() {
  if (active || saving || !dirty) return;
  saving = true;
  updateButtons();
  lineStateMessage.textContent = "Einstellungen werden angewendet …";
  try {
    const result = await requestJson("/api/v1/autonomy/line/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(readSettings())
    });
    dirty = false;
    if (result.autonomy?.config) loadSettings(result.autonomy.config);
    renderAutonomy(result.autonomy);
    await refreshStatus();
  } catch (error) {
    lineStateMessage.textContent = error.message;
  } finally {
    saving = false;
    updateButtons();
  }
}

async function startFollowing() {
  if (dirty || active) return;
  setColorPickerActive(false);
  lineStart.disabled = true;
  try {
    const result = await requestJson("/api/v1/autonomy/line/start", { method: "POST" });
    renderAutonomy(result.autonomy);
    await refreshStatus();
  } catch (error) {
    lineStateMessage.textContent = error.message;
    await refreshStatus();
  }
}

async function stopFollowing() {
  lineStop.disabled = true;
  try {
    const result = await requestJson("/api/v1/autonomy/line/stop", { method: "POST" });
    renderAutonomy(result.autonomy);
  } catch (error) {
    lineStateMessage.textContent = error.message;
  } finally {
    lineStop.disabled = false;
    await refreshStatus();
  }
}

function setColorPreset(preset) {
  const values = HSV_PRESETS[preset];
  if (!values) return;
  for (const id of hsvKeys) {
    const [key, endpoint] = id.split("_");
    hsvRanges[key][endpoint].value = String(values[id]);
  }
  showSliderValues();
}

function setColorPickerActive(isActive) {
  colorPicking = isActive;
  cameraViewport.classList.toggle("is-picking", isActive);
  colorPickTarget.hidden = !isActive;
  colorPickButton.textContent = isActive ? "Auswahl abbrechen" : "Farbe im Livebild auswählen";
  colorPickerHint.classList.remove("is-error");
  colorPickerHint.textContent = isActive
    ? "Tippe auf die gewünschte Farbe im Livebild."
    : "Farbpunkt auswählen; die Bereiche werden um den Messwert gesetzt.";
}

function median(values) {
  const ordered = values.sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function rgbToOpenCvHsv(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const delta = high - low;
  let hue = 0;
  if (delta !== 0) {
    if (high === r) hue = 60 * (((g - b) / delta) % 6);
    else if (high === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return {
    h: Math.round(hue / 2) % 180,
    s: high === 0 ? 0 : Math.round(delta / high * 255),
    v: Math.round(high * 255)
  };
}

function setPickedColor(rgb, hsv) {
  const hueTolerance = 10;
  const saturationTolerance = 50;
  const valueTolerance = 45;
  const hueMin = hsv.s < 18 ? 0 : (hsv.h - hueTolerance + 180) % 180;
  const hueMax = hsv.s < 18 ? 179 : (hsv.h + hueTolerance) % 180;
  hsvRanges.h.min.value = String(hueMin);
  hsvRanges.h.max.value = String(hueMax);
  hsvRanges.s.min.value = String(Math.max(0, hsv.s - saturationTolerance));
  hsvRanges.s.max.value = String(Math.min(255, hsv.s + saturationTolerance));
  hsvRanges.v.min.value = String(Math.max(0, hsv.v - valueTolerance));
  hsvRanges.v.max.value = String(Math.min(255, hsv.v + valueTolerance));
  lineColor.value = "custom";
  const swatchContext = colorSwatch.getContext("2d");
  swatchContext.fillStyle = `rgb(${rgb.join(",")})`;
  swatchContext.fillRect(0, 0, colorSwatch.width, colorSwatch.height);
  colorSampleValues.textContent = `HSV ${hsv.h}, ${hsv.s}, ${hsv.v}`;
  showSliderValues();
  setDirty();
  colorPickerHint.textContent = "Messwert gewählt. Bereiche kontrollieren und Einstellungen anwenden.";
}

function pickColorFromLiveImage(event) {
  if (!colorPicking) return;
  if (!cameraFeed.complete || cameraFeed.naturalWidth < 1 || !sampleContext) {
    colorPickerHint.classList.add("is-error");
    colorPickerHint.textContent = "Das Livebild ist noch nicht für die Farbauswahl bereit.";
    return;
  }
  const bounds = cameraFeed.getBoundingClientRect();
  const imageWidth = cameraFeed.naturalWidth;
  const imageHeight = cameraFeed.naturalHeight;
  const scale = Math.min(bounds.width / imageWidth, bounds.height / imageHeight);
  const shownWidth = imageWidth * scale;
  const shownHeight = imageHeight * scale;
  const shownLeft = bounds.left + (bounds.width - shownWidth) / 2;
  const shownTop = bounds.top + (bounds.height - shownHeight) / 2;
  if (event.clientX < shownLeft || event.clientX >= shownLeft + shownWidth
      || event.clientY < shownTop || event.clientY >= shownTop + shownHeight) {
    colorPickerHint.classList.add("is-error");
    colorPickerHint.textContent = "Bitte einen Punkt direkt innerhalb des Kamerabilds auswählen.";
    return;
  }
  const imageX = Math.max(0, Math.min(imageWidth - 1, Math.floor((event.clientX - shownLeft) / scale)));
  const imageY = Math.max(0, Math.min(imageHeight - 1, Math.floor((event.clientY - shownTop) / scale)));
  try {
    sampleCanvas.width = imageWidth;
    sampleCanvas.height = imageHeight;
    sampleContext.drawImage(cameraFeed, 0, 0, imageWidth, imageHeight);
    const left = Math.max(0, imageX - 2);
    const top = Math.max(0, imageY - 2);
    const width = Math.min(5, imageWidth - left);
    const height = Math.min(5, imageHeight - top);
    const pixels = sampleContext.getImageData(left, top, width, height).data;
    const channels = [[], [], []];
    for (let index = 0; index < pixels.length; index += 4) {
      channels[0].push(pixels[index]);
      channels[1].push(pixels[index + 1]);
      channels[2].push(pixels[index + 2]);
    }
    const rgb = channels.map(median).map(Math.round);
    setColorPickerActive(false);
    setPickedColor(rgb, rgbToOpenCvHsv(...rgb));
  } catch (error) {
    colorPickerHint.classList.add("is-error");
    colorPickerHint.textContent = "Farbwert konnte nicht aus dem aktuellen Bild gelesen werden.";
    console.error(error.message);
  }
}

lineColor.addEventListener("change", () => {
  if (lineColor.value !== "custom") setColorPreset(lineColor.value);
  setDirty();
});
lineMode.addEventListener("change", () => {
  updateBetweenStrategyVisibility();
  setDirty();
});
betweenStrategy.addEventListener("change", setDirty);
lineRoiTop.addEventListener("input", setDirty);
lineGain.addEventListener("input", setDirty);
lineMinArea.addEventListener("input", setDirty);
for (const [key, range] of Object.entries(hsvRanges)) {
  const band = range.min.closest(".dual-range");
  band.querySelector(".dual-range-rail").addEventListener("pointerdown", (event) => {
    if (active || saving || !event.isPrimary) return;
    const bounds = band.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const nextValue = Math.round(fraction * range.limit);
    const endpoint = Math.abs(nextValue - Number(range.min.value)) <= Math.abs(nextValue - Number(range.max.value)) ? "min" : "max";
    range[endpoint].value = String(nextValue);
    range[endpoint].focus({ preventScroll: true });
    range[endpoint].dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (const endpoint of ["min", "max"]) {
    const input = range[endpoint];
    input.addEventListener("pointerdown", () => band.classList.add(`is-moving-${endpoint}`));
    input.addEventListener("input", () => {
      const value = Number(input.value);
      const other = range[endpoint === "min" ? "max" : "min"];
      if (key !== "h" && endpoint === "min" && value > Number(other.value)) other.value = String(value);
      if (key !== "h" && endpoint === "max" && value < Number(other.value)) other.value = String(value);
      lineColor.value = "custom";
      showSliderValues();
      setDirty();
    });
    input.addEventListener("pointerup", () => band.classList.remove(`is-moving-${endpoint}`));
    input.addEventListener("pointercancel", () => band.classList.remove(`is-moving-${endpoint}`));
    input.addEventListener("blur", () => band.classList.remove(`is-moving-${endpoint}`));
  }
}
colorPickButton.addEventListener("click", () => setColorPickerActive(!colorPicking));
cameraFeed.addEventListener("click", pickColorFromLiveImage);
window.addEventListener("pointerup", () => {
  for (const band of document.querySelectorAll(".dual-range")) {
    band.classList.remove("is-moving-min", "is-moving-max");
  }
});
lineSpeed.addEventListener("input", () => {
  lineSpeedNumber.value = lineSpeed.value;
  setDirty();
});
lineSpeedNumber.addEventListener("input", () => {
  if (lineSpeedNumber.value === "") return;
  const value = Math.max(0, Math.min(100, Math.round(Number(lineSpeedNumber.value))));
  lineSpeed.value = String(value);
  setDirty();
});
lineSpeedNumber.addEventListener("change", () => {
  const value = Math.max(0, Math.min(100, Math.round(Number(lineSpeedNumber.value) || 0)));
  lineSpeed.value = String(value);
  lineSpeedNumber.value = String(value);
  setDirty();
});
lineApply.addEventListener("click", applySettings);
lineStart.addEventListener("click", startFollowing);
lineStop.addEventListener("click", stopFollowing);

cameraFeed.addEventListener("load", () => {
  cameraFeed.classList.add("loaded");
  cameraPlaceholder.hidden = true;
});
cameraFeed.addEventListener("error", () => {
  cameraFeed.classList.remove("loaded");
  cameraPlaceholder.hidden = false;
});
lineMask.addEventListener("load", () => lineMaskViewport.classList.add("has-frames"));
lineMask.addEventListener("error", () => {
  lineMaskViewport.classList.remove("has-frames");
  if (lineMaskPlaceholder.textContent === "Warte auf OpenCV-Auswertung …") {
    lineMaskPlaceholder.textContent = "Erkennungsbild wird geladen …";
  }
});

cameraResolution.addEventListener("change", async () => {
  cameraResolution.disabled = true;
  try {
    const result = await requestJson("/api/v1/camera/resolution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: cameraResolution.value })
    });
    cameraResolution.value = result.camera?.preset || cameraResolution.value;
    lastCameraPreset = cameraResolution.value;
  } catch (error) {
    cameraResolution.value = lastCameraPreset;
    setStatus(cameraStatus, "warning", "Auflösung nicht verfügbar");
    console.error(error.message);
  } finally {
    cameraResolution.disabled = false;
    refreshStatus();
  }
});

const CONTROL_WIDTH_MIN = 340;
const CONTROL_WIDTH_MAX = 480;
const CONTROL_WIDTH_STEP = 20;
const CAMERA_WIDTH_MIN = 400;
const SPLITTER_AND_GAPS_WIDTH = 56;

function getControlWidth() {
  return Number(workspace.dataset.controlWidth) || 400;
}

function getControlWidthMax() {
  const available = workspace.clientWidth - SPLITTER_AND_GAPS_WIDTH - CAMERA_WIDTH_MIN;
  const rounded = Math.floor(available / CONTROL_WIDTH_STEP) * CONTROL_WIDTH_STEP;
  return Math.max(CONTROL_WIDTH_MIN, Math.min(CONTROL_WIDTH_MAX, rounded));
}

function setControlWidth(width) {
  const maximum = getControlWidthMax();
  const bounded = Math.max(CONTROL_WIDTH_MIN, Math.min(maximum, Math.round(width / CONTROL_WIDTH_STEP) * CONTROL_WIDTH_STEP));
  workspace.dataset.controlWidth = String(bounded);
  workspaceSplitter.setAttribute("aria-valuemax", String(maximum));
  workspaceSplitter.setAttribute("aria-valuenow", String(bounded));
  workspaceSplitter.setAttribute("aria-valuetext", `${bounded} Pixel Einstellungsbereich`);
}

workspaceSplitter.addEventListener("pointerdown", (event) => {
  if (window.matchMedia("(max-width: 900px)").matches || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  splitterPointerId = event.pointerId;
  splitterStartX = event.clientX;
  splitterStartWidth = controlCard.getBoundingClientRect().width;
  workspaceSplitter.classList.add("is-dragging");
  workspaceSplitter.setPointerCapture(event.pointerId);
});
workspaceSplitter.addEventListener("pointermove", (event) => {
  if (event.pointerId === splitterPointerId) setControlWidth(splitterStartWidth - (event.clientX - splitterStartX));
});
function finishSplitterDrag(event) {
  if (event.pointerId !== splitterPointerId) return;
  splitterPointerId = null;
  workspaceSplitter.classList.remove("is-dragging");
}
workspaceSplitter.addEventListener("pointerup", finishSplitterDrag);
workspaceSplitter.addEventListener("pointercancel", finishSplitterDrag);
workspaceSplitter.addEventListener("lostpointercapture", finishSplitterDrag);
workspaceSplitter.addEventListener("keydown", (event) => {
  const current = getControlWidth();
  const change = event.key === "ArrowLeft" ? CONTROL_WIDTH_STEP
    : event.key === "ArrowRight" ? -CONTROL_WIDTH_STEP
      : event.key === "Home" ? CONTROL_WIDTH_MIN - current
        : event.key === "End" ? getControlWidthMax() - current : 0;
  if (!change) return;
  event.preventDefault();
  setControlWidth(current + change);
});
window.addEventListener("resize", () => {
  if (!window.matchMedia("(max-width: 900px)").matches) setControlWidth(getControlWidth());
});
if (!window.matchMedia("(max-width: 900px)").matches) setControlWidth(getControlWidth());

window.addEventListener("pagehide", () => {
  if (active) {
    fetch("/api/v1/autonomy/line/stop", { method: "POST", keepalive: true }).catch(() => {});
  }
});

showSliderValues();
refreshStatus();
window.setInterval(refreshStatus, 650);
