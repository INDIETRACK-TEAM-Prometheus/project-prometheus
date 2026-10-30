export const GAZE_CALIBRATION_STORAGE_KEY = 'prometheus.gaze-calibration.v1';

const finite = Number.isFinite;

function validModel(model) {
  return model?.dimension === 4 && Array.isArray(model.x) && model.x.length === 5 && model.x.every(finite) &&
    Array.isArray(model.y) && model.y.length === 5 && model.y.every(finite) &&
    Array.isArray(model.featureBounds) && model.featureBounds.length === 4 &&
    model.featureBounds.every(bound => finite(bound?.min) && finite(bound?.max) && bound.min <= bound.max);
}

function validEnvironment(environment) {
  return [environment?.viewport?.width, environment?.viewport?.height, environment?.viewport?.devicePixelRatio,
    environment?.screen?.width, environment?.screen?.height].every(finite) &&
    ['width', 'height', 'frameRate'].every(key => environment?.camera?.[key] === null || finite(environment?.camera?.[key]));
}

function sanitizeModel(model) {
  return {dimension:4, x:[...model.x], y:[...model.y], featureBounds:model.featureBounds.map(bound => ({min:bound.min,max:bound.max}))};
}

function sanitizeEnvironment(environment) {
  return {
    viewport:{width:environment.viewport.width,height:environment.viewport.height,devicePixelRatio:environment.viewport.devicePixelRatio},
    screen:{width:environment.screen.width,height:environment.screen.height},
    camera:{width:environment.camera.width ?? null,height:environment.camera.height ?? null,frameRate:environment.camera.frameRate ?? null}
  };
}

export function saveGazeCalibration(storage, {model, calibration, environment} = {}) {
  if (!storage || typeof storage.setItem !== 'function' || !validModel(model) || calibration?.passed !== true || !validEnvironment(environment)) return false;
  const summary = Object.fromEntries(['passed','status','attempts','validCount','validRate','p50','p95','unit','trainingAttempts','validationAttempts','screenSize','completedAtUtc'].filter(key => calibration[key] !== undefined).map(key => [key, calibration[key]]));
  try {
    storage.setItem(GAZE_CALIBRATION_STORAGE_KEY, JSON.stringify({version:1,model:sanitizeModel(model),calibration:summary,environment:sanitizeEnvironment(environment)}));
    return true;
  } catch { return false; }
}

export function loadGazeCalibration(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    const saved = JSON.parse(storage.getItem(GAZE_CALIBRATION_STORAGE_KEY));
    if (saved?.version !== 1 || !validModel(saved.model) || saved.calibration?.passed !== true || !validEnvironment(saved.environment)) return null;
    return {model:sanitizeModel(saved.model),calibration:{...saved.calibration},environment:sanitizeEnvironment(saved.environment)};
  } catch { return null; }
}

export function gazeCalibrationEnvironmentChanged(saved, current) {
  if (!validEnvironment(saved) || !validEnvironment(current)) return true;
  return [['viewport','width'],['viewport','height'],['viewport','devicePixelRatio'],['screen','width'],['screen','height'],['camera','width'],['camera','height'],['camera','frameRate']]
    .some(([section,key]) => saved[section][key] !== current[section][key]);
}

// Calibration targets are in viewport CSS pixels, so retain their normalized
// position when a later viewport has different dimensions.
export function remapGazePointToViewport(point, savedEnvironment, currentEnvironment) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || !validEnvironment(savedEnvironment) || !validEnvironment(currentEnvironment)) return null;
  return {
    x: point.x / savedEnvironment.viewport.width * currentEnvironment.viewport.width,
    y: point.y / savedEnvironment.viewport.height * currentEnvironment.viewport.height
  };
}
