"use strict";

const cameraViewport = document.querySelector(".camera-viewport");
const cameraFeed = document.getElementById("camera-feed");
const cameraPlaceholder = document.getElementById("camera-placeholder");
const cameraStatus = document.getElementById("camera-status");
const cameraResolution = document.getElementById("camera-resolution");
const lineStatePill = document.getElementById("line-state-pill");
const lineStateMessage = document.getElementById("line-state-message");
const lineMask = document.getElementById("line-mask");
const maskOverlayEnabled = document.getElementById("mask-overlay-enabled");
const maskOverlayOpacity = document.getElementById("mask-overlay-opacity");
const maskOverlayOpacityValue = document.getElementById("mask-overlay-opacity-value");
const lineColor = document.getElementById("line-color");
const lineMode = document.getElementById("line-mode");
const betweenStrategyField = document.getElementById("between-strategy-field");
const betweenStrategy = document.getElementById("between-strategy");
const lineSpeed = document.getElementById("line-speed");
const lineSpeedNumber = document.getElementById("line-speed-number");
const lineRoiTop = document.getElementById("line-roi-top");
const lineGain = document.getElementById("line-gain");
const lineMinArea = document.getElementById("line-min-area");
const lineStart = document.getElementById("line-start");
const lineStop = document.getElementById("line-stop");
const colorPickButton = document.getElementById("color-pick-button");
const colorPickerHint = document.getElementById("color-picker-hint");
const colorSampleValues = document.getElementById("color-sample-values");
const colorSwatch = document.getElementById("color-swatch");
const lineConfigJson = document.getElementById("line-config-json");
const lineConfigFile = document.getElementById("line-config-file");
const lineConfigCopy = document.getElementById("line-config-copy");
const lineConfigDownload = document.getElementById("line-config-download");
const lineConfigUpload = document.getElementById("line-config-upload");
const lineConfigApply = document.getElementById("line-config-apply");
const lineConfigMessage = document.getElementById("line-config-message");
const colorPickTarget = document.getElementById("color-pick-target");
const workspace = document.querySelector(".autonomy-workspace");
const controlCard = document.querySelector(".autonomy-controls");
const workspaceSplitter = document.querySelector(".workspace-splitter");
const batteryReadout = document.getElementById("battery-readout");
const batteryPercent = document.getElementById("battery-percent");
const batteryVoltage = document.getElementById("battery-voltage");
const cameraRoiOverlay = document.getElementById("line-roi-overlay");
const cameraRoiTrackMarker = document.getElementById("line-roi-track-marker");
const cameraRoiThumbMarker = document.getElementById("line-roi-thumb-marker");
const cameraTargetOverlay = document.getElementById("line-target-overlay");
const lineAxisOutline = document.getElementById("line-axis-outline");
const lineAxisOverlay = document.getElementById("line-axis-overlay");
const lineAxisFarMarker = document.getElementById("line-axis-far-marker");
const lineGuidanceArrow = document.getElementById("line-guidance-arrow");
const lineSteeringReadout = document.getElementById("line-steering-readout");

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
let editRevision = 0;
let configSaveTimer = null;
let configSaveError = null;
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
    document.getElementById(`${key}-range-summary`).textContent = `Min ${range.min.value} / Max ${range.max.value}`;
    for (const endpoint of ["min", "max"]) {
      range[endpoint].setAttribute("aria-valuetext", `${endpoint === "min" ? "Minimum" : "Maximum"} ${range[endpoint].value}`);
    }
  }
  updateRangeMarkers();
  updateColorRangePreview();
  updateRoiThumbPosition();
  document.getElementById("line-roi-value").textContent = `${lineRoiTop.value} %`;
  lineRoiTop.setAttribute("aria-valuetext", `Erkennung ab ${lineRoiTop.value} Prozent der Bildhöhe`);
  document.getElementById("line-gain-value").textContent = Number(lineGain.value).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  document.getElementById("line-area-value").textContent = `${Number(lineMinArea.value).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
  cameraRoiOverlay.setAttribute("y", lineRoiTop.value);
  cameraRoiOverlay.setAttribute("height", String(100 - Number(lineRoiTop.value)));
}

function updateRoiThumbPosition() {
  const width = cameraViewport.clientWidth;
  const height = cameraViewport.clientHeight;
  if (!(width > 0 && height > 0)) return;
  const xPercent = (width - 17) / width * 100;
  cameraRoiTrackMarker.setAttribute("x1", xPercent.toFixed(3));
  cameraRoiTrackMarker.setAttribute("x2", xPercent.toFixed(3));
  cameraRoiThumbMarker.setAttribute("cx", xPercent.toFixed(3));
  cameraRoiThumbMarker.setAttribute("cy", Number(lineRoiTop.value).toFixed(3));
  cameraRoiThumbMarker.setAttribute("rx", (9 * 100 / width).toFixed(3));
  cameraRoiThumbMarker.setAttribute("ry", (9 * 100 / height).toFixed(3));
}

function hsvToRgb(hue, saturation, value) {
  const hueDegrees = ((Number(hue) * 2) % 360 + 360) % 360;
  const normalizedHue = hueDegrees / 60;
  const normalizedSaturation = Number(saturation) / 255;
  const normalizedValue = Number(value) / 255;
  const chroma = normalizedValue * normalizedSaturation;
  const secondary = chroma * (1 - Math.abs((normalizedHue % 2) - 1));
  const offset = normalizedValue - chroma;
  const sector = Math.floor(normalizedHue);
  const rgb = sector === 0 ? [chroma, secondary, 0]
    : sector === 1 ? [secondary, chroma, 0]
      : sector === 2 ? [0, chroma, secondary]
        : sector === 3 ? [0, secondary, chroma]
          : sector === 4 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  return rgb.map((channel) => Math.round((channel + offset) * 255));
}

function updateColorRangePreview() {
  const hueMin = Number(hsvRanges.h.min.value);
  const hueMax = Number(hsvRanges.h.max.value);
  const saturationMin = Number(hsvRanges.s.min.value);
  const saturationMax = Number(hsvRanges.s.max.value);
  const valueMin = Number(hsvRanges.v.min.value);
  const valueMax = Number(hsvRanges.v.max.value);
  const minimum = hsvToRgb(hueMin, saturationMin, valueMin);
  const maximum = hsvToRgb(hueMax, saturationMax, valueMax);
  const context = colorSwatch.getContext("2d");
  const halfWidth = colorSwatch.width / 2;
  context.clearRect(0, 0, colorSwatch.width, colorSwatch.height);
  context.fillStyle = `rgb(${minimum.join(",")})`;
  context.fillRect(0, 0, halfWidth, colorSwatch.height);
  context.fillStyle = `rgb(${maximum.join(",")})`;
  context.fillRect(halfWidth, 0, colorSwatch.width - halfWidth, colorSwatch.height);
  context.fillStyle = "rgba(8, 15, 22, 0.78)";
  context.fillRect(halfWidth - 0.5, 0, 1, colorSwatch.height);
  const hueWrap = hueMin > hueMax ? " ↻" : "";
  colorSampleValues.textContent = `H ${hueMin}–${hueMax}${hueWrap} · S ${saturationMin}–${saturationMax} · V ${valueMin}–${valueMax}`;
  colorSwatch.title = `Erkennungsbereich · Minimum HSV ${hueMin}, ${saturationMin}, ${valueMin}; Maximum HSV ${hueMax}, ${saturationMax}, ${valueMax}`;
}

function updateRangeMarkers() {
  const hueMin = Number(hsvRanges.h.min.value);
  const hueMax = Number(hsvRanges.h.max.value);
  const hueMidpoint = (hueMin + ((hueMax - hueMin + 180) % 180) / 2) % 180;
  const saturationMidpoint = (Number(hsvRanges.s.min.value) + Number(hsvRanges.s.max.value)) / 2;
  const valueMidpoint = (Number(hsvRanges.v.min.value) + Number(hsvRanges.v.max.value)) / 2;
  const markerValues = {
    h: { min: [hueMin, saturationMidpoint, valueMidpoint], max: [hueMax, saturationMidpoint, valueMidpoint] },
    s: { min: [hueMidpoint, Number(hsvRanges.s.min.value), valueMidpoint], max: [hueMidpoint, Number(hsvRanges.s.max.value), valueMidpoint] },
    v: { min: [hueMidpoint, saturationMidpoint, Number(hsvRanges.v.min.value)], max: [hueMidpoint, saturationMidpoint, Number(hsvRanges.v.max.value)] }
  };

  for (const [key, range] of Object.entries(hsvRanges)) {
    const band = range.min.closest(".dual-range");
    const width = band.clientWidth || 328;
    for (const endpoint of ["min", "max"]) {
      const value = Number(range[endpoint].value);
      const fraction = value / range.limit;
      const marker = band.querySelector(`[data-range-endpoint="${endpoint}"]`);
      const x = 8 + fraction * Math.max(0, width - 16);
      marker.setAttribute("cx", (x / width * 100).toFixed(2));
      marker.setAttribute("cy", "12");
      marker.setAttribute("rx", (7.5 * 100 / width).toFixed(3));
      marker.setAttribute("ry", "7.5");
      marker.setAttribute("fill", `rgb(${hsvToRgb(...markerValues[key][endpoint]).join(",")})`);
    }
  }
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
  if (configSaveTimer !== null) window.clearTimeout(configSaveTimer);
  configSaveTimer = null;
  updateBetweenStrategyVisibility();
  showSliderValues();
  dirty = false;
  initialized = true;
  updateButtons();
}

function setDirty() {
  if (!initialized || active) return;
  dirty = true;
  configSaveError = null;
  editRevision += 1;
  showSliderValues();
  lineStateMessage.textContent = "Änderung wird automatisch übernommen …";
  updateButtons();
  if (configSaveTimer !== null) window.clearTimeout(configSaveTimer);
  configSaveTimer = window.setTimeout(() => {
    configSaveTimer = null;
    void applySettings();
  }, 280);
}

function updateButtons(detection = null, available = false) {
  lineStart.hidden = active;
  lineStop.hidden = !active;
  lineStart.disabled = active || dirty || saving || !available || !detection?.line_detected;
  for (const input of adjustableInputs) input.disabled = active;
  lineConfigUpload.disabled = active || saving;
  lineConfigApply.disabled = active || saving || !lineConfigJson.value.trim();
}

function setCameraAspect(width, height) {
  if (!(width > 0 && height > 0)) return;
  const ratio = width / height;
  cameraViewport.dataset.aspect = Math.abs(ratio - 4 / 3) < 0.04 ? "4-3"
    : Math.abs(ratio - 16 / 9) < 0.04 ? "16-9" : "other";
  updateRoiThumbPosition();
}

function updateMaskOverlay() {
  const opacity = Math.max(0, Math.min(100, Math.round(Number(maskOverlayOpacity.value) / 5) * 5));
  maskOverlayOpacity.value = String(opacity);
  maskOverlayOpacityValue.textContent = `${opacity} %`;
  for (let value = 0; value <= 100; value += 5) lineMask.classList.remove(`mask-opacity-${value}`);
  lineMask.classList.add(`mask-opacity-${opacity}`);
  lineMask.classList.toggle("is-visible", maskOverlayEnabled.checked);
}

function updateBetweenStrategyVisibility() {
  betweenStrategyField.hidden = lineMode.value !== "between";
  lineStart.textContent = lineMode.value === "area" ? "Flächenerkennung starten" : "Linienfolge starten";
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
  setCameraAspect(frameWidth, frameHeight);
  const stateText = {
    vision_unavailable: ["warning", "OpenCV fehlt", "OpenCV ist auf diesem Rover nicht installiert."],
    waiting_camera: ["waiting", "Warte auf Kamera", "Warte auf ein aktuelles Kamerabild."],
    updating: ["waiting", "Werte werden geprüft", "Die neuen Einstellungen werden auf das Livebild angewendet."],
    no_line: ["warning", "Keine Erkennung", "Farbbereich oder Suchbereich anpassen; die Erkennung erscheint türkis im Livebild."],
    ready: ["ready", "Erkennung bereit", "Prüfe, ob die Überlagerung nur die gewünschte Markierung enthält."],
    following: ["ready", "Automatik aktiv", "Bei Erkennungsverlust stoppt der Rover."],
    paused: ["waiting", "Pausiert", "Geschwindigkeit steht auf 0 %."],
    line_lost: ["warning", "Erkennung verloren", "Motoren gestoppt. Markierung neu ausrichten und erneut starten."],
    camera_lost: ["warning", "Kamera verloren", "Motoren gestoppt, weil kein aktuelles Kamerabild ankommt."],
    error: ["warning", "Erkennungsfehler", autonomy.error || "Die Linienauswertung wurde angehalten."]
  };
  const [tone, _label, message] = stateText[autonomy.state] || stateText.waiting_camera;
  const modeLabels = { area: "Fläche", single: "Linie", between: "Doppellinie" };
  const modeLabel = modeLabels[autonomy.config?.line_mode || lineMode.value] || "Linie";
  const frameAgeMs = Number(detection.frame_age_ms);
  const hasFreshFrame = detection.frame_age_ms !== null
    && Number.isFinite(frameAgeMs) && frameAgeMs <= 600;
  const hasPosition = detection.line_detected && hasFreshFrame
    && Number.isFinite(Number(detection.target_x_percent));
  const positionLabel = hasPosition ? `${Math.round(Number(detection.target_x_percent))} %` : "—";
  const angle = Number(detection.line_angle_degrees);
  const hasAngle = hasPosition && detection.line_angle_degrees !== null && Number.isFinite(angle);
  const angleLabel = hasAngle
    ? ` · ${angle > 0 ? "+" : ""}${angle.toLocaleString("de-DE", { maximumFractionDigits: 1 })}°`
    : "";
  setStatus(lineStatePill, tone, `${modeLabel} · ${positionLabel}${angleLabel}`);
  lineStatePill.title = message;
  lineStateMessage.textContent = dirty
    ? configSaveError || "Änderung wird automatisch übernommen …"
    : message;
  if (hasPosition) {
    const position = Number(detection.target_x_percent);
    cameraTargetOverlay.setAttribute("cx", String(position));
    cameraTargetOverlay.setAttribute("cy", String(detection.target_y_percent ?? 82));
    cameraTargetOverlay.removeAttribute("hidden");
  } else {
    cameraTargetOverlay.setAttribute("hidden", "");
  }

  const axisKeys = [
    "line_axis_far_x_percent", "line_axis_far_y_percent",
    "line_axis_near_x_percent", "line_axis_near_y_percent"
  ];
  const hasLineAxis = hasPosition && axisKeys.every(key =>
    detection[key] !== null && Number.isFinite(Number(detection[key]))
  );
  if (hasLineAxis) {
    const farX = Number(detection.line_axis_far_x_percent);
    const farY = Number(detection.line_axis_far_y_percent);
    const nearX = Number(detection.line_axis_near_x_percent);
    const nearY = Number(detection.line_axis_near_y_percent);
    for (const axis of [lineAxisOutline, lineAxisOverlay]) {
      axis.setAttribute("x1", String(farX));
      axis.setAttribute("y1", String(farY));
      axis.setAttribute("x2", String(nearX));
      axis.setAttribute("y2", String(nearY));
      axis.removeAttribute("hidden");
    }
    lineAxisFarMarker.setAttribute("cx", String(farX));
    lineAxisFarMarker.setAttribute("cy", String(farY));
    lineAxisFarMarker.removeAttribute("hidden");
  } else {
    lineAxisOutline.setAttribute("hidden", "");
    lineAxisOverlay.setAttribute("hidden", "");
    lineAxisFarMarker.setAttribute("hidden", "");
  }

  const speed = Math.max(0, Math.min(100, Number(autonomy.config?.speed_percent ?? 0))) / 100;
  const gain = Math.max(0, Number(autonomy.config?.steering_gain ?? 1));
  const steeringError = Number(detection.steering_error);
  const hasSteering = detection.line_detected && hasFreshFrame
    && detection.steering_error !== null && Number.isFinite(steeringError);
  if (hasSteering && speed > 0) {
    const requestedCorrection = steeringError * gain * speed;
    const leftSpeed = Math.max(0, Math.min(1, speed - requestedCorrection));
    const rightSpeed = Math.max(0, Math.min(1, speed + requestedCorrection));
    const maxDifferential = Math.min(2 * speed, 1);
    const turnStrength = Math.max(-1, Math.min(1, (rightSpeed - leftSpeed) / maxDifferential));
    const direction = turnStrength > 0.035 ? "Links" : turnStrength < -0.035 ? "Rechts" : "Geradeaus";
    const strength = Math.round(Math.abs(turnStrength) * 100);
    lineSteeringReadout.textContent = direction === "Geradeaus"
      ? "Lenkbefehl: Geradeaus"
      : `Lenkbefehl: ${direction} · ${strength} %`;
    lineGuidanceArrow.setAttribute("x2", String(50 - turnStrength * 26));
    lineGuidanceArrow.removeAttribute("hidden");
  } else {
    lineSteeringReadout.textContent = hasSteering && speed <= 0
      ? "Lenkbefehl: pausiert · Geschwindigkeit 0 %"
      : detection.line_detected && !hasFreshFrame
        ? "Lenkbefehl: kein aktuelles Kamerabild"
        : "Lenkbefehl: —";
    lineGuidanceArrow.setAttribute("hidden", "");
  }
  updateButtons(detection, Boolean(autonomy.available) && autonomy.state !== "updating");
}

function updateCamera(camera) {
  const width = Number(camera.width);
  const height = Number(camera.height);
  setCameraAspect(width, height);
  if (camera.preset && cameraResolution.value !== camera.preset) cameraResolution.value = camera.preset;
  if (camera.preset) lastCameraPreset = camera.preset;
  if (camera.state === "online") {
    setStatus(cameraStatus, "ready", "Kamera bereit");
    if (cameraFeed.naturalWidth > 0) cameraFeed.classList.add("loaded");
    cameraPlaceholder.hidden = true;
  } else {
    const message = camera.state === "disabled" ? "Kamera deaktiviert" : camera.state === "offline" ? "Kamera offline" : "Verbinde …";
    setStatus(cameraStatus, camera.state === "disabled" || camera.state === "offline" ? "warning" : "waiting", message);
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
    const modeLabels = { area: "Fläche", single: "Linie", between: "Doppellinie" };
    setStatus(lineStatePill, "warning", `${modeLabels[lineMode.value] || "Linie"} · —`);
    lineStatePill.title = "Rover nicht erreichbar.";
    lineStateMessage.textContent = "Die Verbindung zum Rover ist unterbrochen.";
    setStatus(cameraStatus, "warning", "Verbindung verloren");
    cameraTargetOverlay.setAttribute("hidden", "");
    lineAxisOutline.setAttribute("hidden", "");
    lineAxisOverlay.setAttribute("hidden", "");
    lineAxisFarMarker.setAttribute("hidden", "");
    lineGuidanceArrow.setAttribute("hidden", "");
    lineSteeringReadout.textContent = "Lenkbefehl: Verbindung getrennt";
    updateButtons(null, false);
    console.error(error.message);
  } finally {
    refreshing = false;
  }
}

async function applySettings() {
  if (active || saving || !dirty) return;
  saving = true;
  const savedRevision = editRevision;
  updateButtons();
  lineStateMessage.textContent = "Einstellungen werden automatisch übernommen …";
  try {
    const result = await requestJson("/api/v1/autonomy/line/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(readSettings())
    });
    configSaveError = null;
    dirty = savedRevision !== editRevision;
    renderAutonomy(result.autonomy);
  } catch (error) {
    configSaveError = `Automatische Übernahme fehlgeschlagen: ${error.message}`;
    lineStateMessage.textContent = configSaveError;
  } finally {
    saving = false;
    updateButtons();
    if (dirty && !active && savedRevision !== editRevision) {
      if (configSaveTimer !== null) window.clearTimeout(configSaveTimer);
      configSaveTimer = window.setTimeout(() => {
        configSaveTimer = null;
        void applySettings();
      }, 80);
    }
  }
}

function makeConfigDocument(settings = readSettings()) {
  return {
    format: "wave-rover-line-detection",
    version: 1,
    settings
  };
}

function setConfigMessage(message, isError = false) {
  lineConfigMessage.textContent = message;
  lineConfigMessage.classList.toggle("is-error", isError);
}

function parseImportedConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Die JSON-Wurzel muss ein Objekt sein.");
  }

  let source = value;
  if (Object.prototype.hasOwnProperty.call(value, "format")) {
    if (value.format !== "wave-rover-line-detection") throw new Error("Unbekanntes Konfigurationsformat.");
    if (value.version !== 1) throw new Error("Diese Version der Konfiguration wird nicht unterstützt.");
    source = value.settings;
  } else if (value.autonomy?.config) {
    source = value.autonomy.config;
  } else if (value.config) {
    source = value.config;
  } else if (value.settings) {
    source = value.settings;
  }

  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Die JSON-Datei enthält kein Einstellungsobjekt.");
  }

  const stringChoices = {
    color_preset: ["white", "black", "yellow", "red", "green", "blue", "custom"],
    line_mode: ["area", "single", "between"],
    between_strategy: ["midpoint", "stay_between"]
  };
  const numberLimits = {
    h_min: [0, 179, true], h_max: [0, 179, true],
    s_min: [0, 255, true], s_max: [0, 255, true],
    v_min: [0, 255, true], v_max: [0, 255, true],
    roi_top_percent: [0, 100, true], speed_percent: [0, 100, true],
    steering_gain: [0.2, 2.5, false], min_area_percent: [0.05, 5, false]
  };
  const normalized = {};
  for (const [key, choices] of Object.entries(stringChoices)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (!choices.includes(source[key])) throw new Error(`Ungültiger Wert für ${key}.`);
    normalized[key] = source[key];
  }
  for (const [key, [minimum, maximum, integer]] of Object.entries(numberLimits)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const valueAtKey = source[key];
    if (typeof valueAtKey !== "number" || !Number.isFinite(valueAtKey)
        || valueAtKey < minimum || valueAtKey > maximum
        || (integer && !Number.isInteger(valueAtKey))) {
      throw new Error(`Ungültiger Wert für ${key} (${minimum}–${maximum}).`);
    }
    normalized[key] = valueAtKey;
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error("Keine unterstützten Erkennungseinstellungen gefunden.");
  }
  return normalized;
}

function refreshConfigActionState() {
  lineConfigApply.disabled = active || saving || !lineConfigJson.value.trim();
  lineConfigUpload.disabled = active || saving;
}

async function copyCurrentConfig() {
  const text = JSON.stringify(makeConfigDocument(), null, 2);
  lineConfigJson.value = text;
  refreshConfigActionState();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      lineConfigJson.focus();
      lineConfigJson.select();
      if (!document.execCommand("copy")) throw new Error("Zwischenablage ist nicht verfügbar.");
    }
    setConfigMessage("Konfiguration in die Zwischenablage kopiert.");
  } catch (error) {
    setConfigMessage(`Kopieren fehlgeschlagen: ${error.message}`, true);
  }
}

function downloadCurrentConfig() {
  const text = JSON.stringify(makeConfigDocument(), null, 2);
  const blobUrl = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = "wave-rover-line-detection.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  setConfigMessage("JSON-Datei mit der aktuellen Konfiguration heruntergeladen.");
}

async function applyImportedConfig() {
  if (active || saving) return;
  let imported;
  try {
    imported = parseImportedConfig(JSON.parse(lineConfigJson.value));
  } catch (error) {
    setConfigMessage(`JSON konnte nicht übernommen werden: ${error.message}`, true);
    return;
  }

  const hadPendingChanges = dirty;
  const currentSettings = readSettings();
  const presetValues = imported.color_preset && imported.color_preset !== currentSettings.color_preset
    ? HSV_PRESETS[imported.color_preset] : null;
  const nextSettings = { ...currentSettings, ...(presetValues || {}), ...imported };
  if (nextSettings.s_min > nextSettings.s_max || nextSettings.v_min > nextSettings.v_max) {
    setConfigMessage("Min.-Werte für Sättigung und Helligkeit dürfen nicht über Max. liegen.", true);
    return;
  }
  if (configSaveTimer !== null) window.clearTimeout(configSaveTimer);
  configSaveTimer = null;
  saving = true;
  updateButtons();
  refreshConfigActionState();
  setConfigMessage("Konfiguration wird auf den Rover übertragen …");
  try {
    const result = await requestJson("/api/v1/autonomy/line/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextSettings)
    });
    const acceptedSettings = result.autonomy?.config || nextSettings;
    loadSettings(acceptedSettings);
    renderAutonomy(result.autonomy);
    setConfigMessage("Konfiguration übernommen und auf dem Rover gespeichert.");
  } catch (error) {
    dirty = hadPendingChanges;
    configSaveError = `Konfiguration konnte nicht übertragen werden: ${error.message}`;
    lineStateMessage.textContent = configSaveError;
    setConfigMessage(configSaveError, true);
    if (dirty) {
      configSaveTimer = window.setTimeout(() => {
        configSaveTimer = null;
        void applySettings();
      }, 280);
    }
  } finally {
    saving = false;
    updateButtons();
    refreshConfigActionState();
  }
}

lineConfigCopy.addEventListener("click", copyCurrentConfig);
lineConfigDownload.addEventListener("click", downloadCurrentConfig);
lineConfigUpload.addEventListener("click", () => lineConfigFile.click());
lineConfigApply.addEventListener("click", applyImportedConfig);
lineConfigJson.addEventListener("input", refreshConfigActionState);
lineConfigFile.addEventListener("change", async () => {
  const file = lineConfigFile.files?.[0];
  if (!file) return;
  try {
    lineConfigJson.value = await file.text();
    refreshConfigActionState();
    setConfigMessage(`${file.name} geladen. Prüfe die Werte und wähle „Konfiguration übernehmen“.`);
  } catch (error) {
    setConfigMessage(`Datei konnte nicht gelesen werden: ${error.message}`, true);
  } finally {
    lineConfigFile.value = "";
  }
});

async function startFollowing() {
  if (dirty || saving || active) return;
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
    : "";
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

function setPickedColor(hsv) {
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
  showSliderValues();
  setDirty();
  colorPickerHint.textContent = "Farbmessung übernommen; Einstellungen werden gespeichert.";
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
    setPickedColor(rgbToOpenCvHsv(...rgb));
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
maskOverlayEnabled.addEventListener("change", updateMaskOverlay);
maskOverlayOpacity.addEventListener("input", updateMaskOverlay);
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
lineStart.addEventListener("click", startFollowing);
lineStop.addEventListener("click", stopFollowing);
document.querySelector(".advanced-settings").addEventListener("toggle", updateRangeMarkers);
window.addEventListener("resize", () => {
  updateRangeMarkers();
  updateRoiThumbPosition();
});
if (typeof ResizeObserver !== "undefined") {
  const markerResizeObserver = new ResizeObserver(() => {
    updateRangeMarkers();
    updateRoiThumbPosition();
  });
  markerResizeObserver.observe(cameraViewport);
  for (const band of document.querySelectorAll(".dual-range")) markerResizeObserver.observe(band);
}

cameraFeed.addEventListener("load", () => {
  cameraFeed.classList.add("loaded");
  cameraPlaceholder.hidden = true;
});
cameraFeed.addEventListener("error", () => {
  cameraFeed.classList.remove("loaded");
  cameraPlaceholder.hidden = false;
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
updateMaskOverlay();
refreshStatus();
window.setInterval(refreshStatus, 650);
