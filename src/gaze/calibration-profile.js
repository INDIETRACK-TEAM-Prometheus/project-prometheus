import {calibrationMetrics} from './index.js';

export const GAZE_CALIBRATION_PROFILE_KEY = 'prometheus.gaze-calibration.profile.v1';
export const GAZE_CALIBRATION_PROFILE_VERSION = 1;
export const GAZE_CALIBRATION_PROFILE_DB = 'prometheus-local-gaze';
export const GAZE_CALIBRATION_PROFILE_STORE = 'profiles';

const finite = Number.isFinite;
const maxPatchSide = 512;
const maxPatchBytes = maxPatchSide * maxPatchSide * 4;
const maxAdaptationSamples = 60;
const maxProfileCharacters = 128 * 1024 * 1024;

function validPoint(point) { return finite(point?.x) && finite(point?.y); }

function validEnvironment(environment) {
  return [environment?.viewport?.width,environment?.viewport?.height,environment?.viewport?.devicePixelRatio,
    environment?.screen?.width,environment?.screen?.height].every(finite) &&
    environment.viewport.width > 0 && environment.viewport.height > 0 && environment.viewport.devicePixelRatio > 0 &&
    environment.screen.width > 0 && environment.screen.height > 0 &&
    ['width','height','frameRate'].every(key => environment?.camera?.[key] === null || (finite(environment?.camera?.[key]) && environment.camera[key] > 0));
}

function sanitizeEnvironment(environment) {
  return {
    viewport:{width:environment.viewport.width,height:environment.viewport.height,devicePixelRatio:environment.viewport.devicePixelRatio},
    screen:{width:environment.screen.width,height:environment.screen.height},
    camera:{width:environment.camera.width ?? null,height:environment.camera.height ?? null,frameRate:environment.camera.frameRate ?? null}
  };
}

function validRuntime(runtime) {
  return runtime && typeof runtime === 'object' && !Array.isArray(runtime) && Object.keys(runtime).length > 0 &&
    Object.entries(runtime).every(([key,value]) => key.length > 0 && key.length <= 64 &&
      (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && finite(value))));
}

function sanitizeRuntime(runtime) {
  return Object.fromEntries(Object.entries(runtime).sort(([a],[b]) => a.localeCompare(b)));
}

function base64Encode(bytes) {
  if (typeof globalThis.btoa !== 'function') throw new Error('base64 encoding is unavailable');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i,i + 0x8000));
  return globalThis.btoa(binary);
}

function base64Decode(value) {
  if (typeof globalThis.atob !== 'function') throw new Error('base64 decoding is unavailable');
  const binary = globalThis.atob(value);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function imageDataPayload(imageData) {
  const width = imageData?.width, height = imageData?.height, data = imageData?.data;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > maxPatchSide || height > maxPatchSide ||
      !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4 || data.byteLength > maxPatchBytes) throw new Error('valid ImageData required for calibration replay');
  return {format:'ImageData',width,height,dataType:'Uint8ClampedArray',data:base64Encode(data)};
}

function validImageDataPayload(image) {
  if (image?.format !== 'ImageData' || image.dataType !== 'Uint8ClampedArray' || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
      image.width < 1 || image.height < 1 || image.width > maxPatchSide || image.height > maxPatchSide || typeof image.data !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) return false;
  return image.data.length === 4 * Math.ceil(image.width * image.height * 4 / 3);
}

function normalizedTarget(target) {
  if (Array.isArray(target) && target.length === 2 && target.every(finite)) return target.map(value=>value || 0);
  if (validPoint(target)) return [target.x || 0,target.y || 0];
  return null;
}

export function serializeWebEyeTrackAdaptationSample(sample) {
  if (validSerializedSample(sample)) return {
    eyePatch:{...sample.eyePatch},
    headVector:[...sample.headVector],
    faceOrigin3D:[...sample.faceOrigin3D],
    target:sample.target.map(value=>value || 0)
  };
  const target = normalizedTarget(sample?.target);
  if (!target || !Array.isArray(sample?.headVector) || sample.headVector.length !== 3 || !sample.headVector.every(finite) ||
      !Array.isArray(sample?.faceOrigin3D) || sample.faceOrigin3D.length !== 3 || !sample.faceOrigin3D.every(finite)) throw new Error('valid WebEyeTrack adaptation sample required');
  return {eyePatch:imageDataPayload(sample.eyePatch),headVector:[...sample.headVector],faceOrigin3D:[...sample.faceOrigin3D],target};
}

function validSerializedSample(sample) {
  return validImageDataPayload(sample?.eyePatch) && Array.isArray(sample.headVector) && sample.headVector.length === 3 && sample.headVector.every(finite) &&
    Array.isArray(sample.faceOrigin3D) && sample.faceOrigin3D.length === 3 && sample.faceOrigin3D.every(finite) &&
    Array.isArray(sample.target) && sample.target.length === 2 && sample.target.every(value => finite(value) && value >= -.5 && value <= .5);
}

export function serializeWebEyeTrackAdaptationSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 4 || samples.length > maxAdaptationSamples) throw new Error('calibration adaptation samples required');
  return samples.map(serializeWebEyeTrackAdaptationSample);
}

// Restores the exact byte data to the ImageData type expected by tracker.adapt().
export function restoreWebEyeTrackAdaptationSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 4 || samples.length > maxAdaptationSamples || !samples.every(validSerializedSample)) throw new Error('invalid calibration replay payload');
  return samples.map(sample => {
    const data = base64Decode(sample.eyePatch.data), {width,height} = sample.eyePatch;
    const eyePatch = typeof globalThis.ImageData === 'function' ? new globalThis.ImageData(data,width,height) : {data,width,height};
    return {eyePatch,headVector:[...sample.headVector],faceOrigin3D:[...sample.faceOrigin3D],target:[...sample.target]};
  });
}

function sanitizeCalibration(calibration) {
  const allowed = ['passed','status','attempts','validCount','validRate','p50','p95','unit','trainingAttempts','validationAttempts','completedAtUtc','method'];
  return Object.fromEntries(allowed.filter(key => calibration[key] !== undefined).map(key => [key,calibration[key]]));
}

function validAffineModel(model) {
  return model?.dimension === 2 && Array.isArray(model.x) && model.x.length === 3 && model.x.every(finite) &&
    Array.isArray(model.y) && model.y.length === 3 && model.y.every(finite) && Array.isArray(model.trainingIds) &&
    model.trainingIds.every(id => typeof id === 'string' && id.length > 0) && new Set(model.trainingIds).size === model.trainingIds.length &&
    Array.isArray(model.featureBounds) && model.featureBounds.length === 2 && model.featureBounds.every(bound => finite(bound?.min) && finite(bound?.max) && bound.min <= bound.max);
}

function sanitizeAffineModel(model) {
  return {dimension:2,x:[...model.x],y:[...model.y],trainingIds:[...model.trainingIds],featureBounds:model.featureBounds.map(bound=>({min:bound.min,max:bound.max}))};
}

function validLandmarkResidualModel(model) {
  return model?.dimension === 3 && Array.isArray(model.x) && model.x.length === 4 && model.x.every(finite) &&
    Array.isArray(model.y) && model.y.length === 4 && model.y.every(finite) && Array.isArray(model.trainingIds) &&
    model.trainingIds.length > 0 && model.trainingIds.every(id => typeof id === 'string' && id.length > 0) && new Set(model.trainingIds).size === model.trainingIds.length &&
    Array.isArray(model.featureBounds) && model.featureBounds.length === 3 && model.featureBounds.every(bound =>
      finite(bound?.min) && finite(bound?.max) && bound.min >= -1 && bound.max <= 1 && bound.min <= bound.max);
}

function sanitizeLandmarkResidualModel(model) {
  return {dimension:3,x:[...model.x],y:[...model.y],trainingIds:[...model.trainingIds],featureBounds:model.featureBounds.map(bound=>({min:bound.min,max:bound.max}))};
}

function validMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return false;
  return (metrics.attempts === undefined || (Number.isInteger(metrics.attempts) && metrics.attempts >= 0)) &&
    (metrics.validCount === undefined || (Number.isInteger(metrics.validCount) && metrics.validCount >= 0)) &&
    (metrics.validRate === undefined || (finite(metrics.validRate) && metrics.validRate >= 0 && metrics.validRate <= 1)) &&
    ['p50','p95'].every(key => metrics[key] === undefined || metrics[key] === null || (finite(metrics[key]) && metrics[key] >= 0)) &&
    (metrics.unit === undefined || typeof metrics.unit === 'string');
}

function validProfile(profile) {
  return profile?.version === GAZE_CALIBRATION_PROFILE_VERSION && typeof profile.createdAtUtc === 'string' &&
    !Number.isNaN(Date.parse(profile.createdAtUtc)) && validEnvironment(profile.environment) && validRuntime(profile.runtime) &&
    profile.calibration?.passed === true && validMetrics(profile.calibration) &&
    profile.adaptation?.method === 'webeyetrack_replay' && Array.isArray(profile.adaptation.samples) &&
    profile.adaptation.samples.length >= 4 && profile.adaptation.samples.length <= maxAdaptationSamples && profile.adaptation.samples.every(validSerializedSample) &&
    (profile.landmarkResidual === undefined || profile.landmarkResidual === null || validLandmarkResidualModel(profile.landmarkResidual)) &&
    (profile.affine === null || (validAffineModel(profile.affine?.model) && validMetrics(profile.affine?.selection?.baseline) && validMetrics(profile.affine?.selection?.candidate) && typeof profile.affine?.selection?.selected === 'boolean'));
}

export function createGazeCalibrationProfile({adaptationSamples,calibration,environment,runtime,affine=null,landmarkResidual=null,createdAtUtc=new Date().toISOString()} = {}) {
  if (calibration?.passed !== true || !validEnvironment(environment) || !validRuntime(runtime) || typeof createdAtUtc !== 'string' || Number.isNaN(Date.parse(createdAtUtc))) throw new Error('completed calibration and valid runtime environment required');
  if (landmarkResidual !== undefined && landmarkResidual !== null && !validLandmarkResidualModel(landmarkResidual)) throw new Error('invalid landmark residual calibration');
  const profile = {
    version:GAZE_CALIBRATION_PROFILE_VERSION,
    createdAtUtc,
    runtime:sanitizeRuntime(runtime),
    environment:sanitizeEnvironment(environment),
    calibration:sanitizeCalibration(calibration),
    adaptation:{method:'webeyetrack_replay',samples:serializeWebEyeTrackAdaptationSamples(adaptationSamples)},
    landmarkResidual:landmarkResidual ? sanitizeLandmarkResidualModel(landmarkResidual) : null
  };
  if (affine) {
    if (!validAffineModel(affine.model) || !validMetrics(affine.selection?.baseline) || !validMetrics(affine.selection?.candidate) || typeof affine.selection?.selected !== 'boolean') throw new Error('invalid affine calibration selection');
    profile.affine = {model:sanitizeAffineModel(affine.model),selection:{selected:affine.selection.selected,status:String(affine.selection.status ?? 'not_selected'),baseline:affine.selection.baseline,candidate:affine.selection.candidate}};
  } else profile.affine = null;
  if (!validProfile(profile)) throw new Error('invalid calibration profile');
  return profile;
}

export function validateGazeCalibrationProfile(profile, {environment,runtime} = {}) {
  if (!validProfile(profile)) return {status:'invalid_profile',compatible:false,profile:null};
  if (!validEnvironment(environment) || !validRuntime(runtime)) return {status:'validation_context_unavailable',compatible:false,profile};
  for (const section of ['viewport','screen','camera']) for (const [key,value] of Object.entries(profile.environment[section])) {
    if (value !== environment[section]?.[key]) return {status:'environment_changed',compatible:false,reason:`${section}.${key}`,profile};
  }
  const currentRuntime = sanitizeRuntime(runtime), savedRuntime = sanitizeRuntime(profile.runtime);
  if (JSON.stringify(currentRuntime) !== JSON.stringify(savedRuntime)) return {status:'runtime_changed',compatible:false,profile};
  return {status:'compatible',compatible:true,profile};
}

export function restoreLandmarkResidualCalibration(profile) {
  if (profile?.landmarkResidual == null) return null;
  if (!validLandmarkResidualModel(profile.landmarkResidual)) throw new Error('invalid landmark residual calibration');
  return sanitizeLandmarkResidualModel(profile.landmarkResidual);
}

export async function saveGazeCalibrationProfile(storage, profile) {
  if (!storage || typeof storage.setItem !== 'function' || !validProfile(profile)) return false;
  try {
    const serialized = JSON.stringify(profile);
    if (serialized.length > maxProfileCharacters) return false;
    await storage.setItem(GAZE_CALIBRATION_PROFILE_KEY,serialized);
    return true;
  } catch { return false; }
}

export async function loadGazeCalibrationProfile(storage, context = {}) {
  if (!storage || typeof storage.getItem !== 'function') return {status:'unavailable',compatible:false,profile:null};
  try {
    const raw = await storage.getItem(GAZE_CALIBRATION_PROFILE_KEY);
    if (raw == null) return {status:'missing',compatible:false,profile:null};
    if (typeof raw !== 'string' || raw.length > maxProfileCharacters) return {status:'invalid_profile',compatible:false,profile:null};
    const profile = JSON.parse(raw);
    return validateGazeCalibrationProfile(profile,context);
  } catch { return {status:'invalid_profile',compatible:false,profile:null}; }
}

export function openGazeCalibrationProfileStore({indexedDB = globalThis.indexedDB, databaseName = GAZE_CALIBRATION_PROFILE_DB} = {}) {
  if (!indexedDB?.open || typeof databaseName !== 'string' || !databaseName) return Promise.reject(new Error('IndexedDB unavailable'));
  return new Promise((resolve,reject) => {
    const request = indexedDB.open(databaseName,1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(GAZE_CALIBRATION_PROFILE_STORE)) request.result.createObjectStore(GAZE_CALIBRATION_PROFILE_STORE);
    };
    request.onerror = () => reject(request.error ?? new Error('calibration profile database open failed'));
    request.onblocked = () => reject(new Error('calibration profile database upgrade blocked'));
    request.onsuccess = () => {
      const db = request.result;
      const store = {
        getItem(key) {
          return new Promise((resolveGet,rejectGet) => {
            const tx = db.transaction(GAZE_CALIBRATION_PROFILE_STORE,'readonly'), requestGet = tx.objectStore(GAZE_CALIBRATION_PROFILE_STORE).get(key);
            requestGet.onsuccess = () => resolveGet(requestGet.result ?? null);
            requestGet.onerror = () => rejectGet(requestGet.error ?? new Error('calibration profile read failed'));
            tx.onabort = () => rejectGet(tx.error ?? new Error('calibration profile read aborted'));
          });
        },
        setItem(key,value) {
          return new Promise((resolveSet,rejectSet) => {
            const tx = db.transaction(GAZE_CALIBRATION_PROFILE_STORE,'readwrite');
            tx.objectStore(GAZE_CALIBRATION_PROFILE_STORE).put(value,key);
            tx.oncomplete = () => resolveSet();
            tx.onerror = tx.onabort = () => rejectSet(tx.error ?? new Error('calibration profile write failed'));
          });
        },
        removeItem(key) {
          return new Promise((resolveDelete,rejectDelete) => {
            const tx = db.transaction(GAZE_CALIBRATION_PROFILE_STORE,'readwrite');
            tx.objectStore(GAZE_CALIBRATION_PROFILE_STORE).delete(key);
            tx.oncomplete = () => resolveDelete();
            tx.onerror = tx.onabort = () => rejectDelete(tx.error ?? new Error('calibration profile delete failed'));
          });
        },
        close() { db.close(); }
      };
      resolve(store);
    };
  });
}

function solve3(matrix, vector) {
  const rows = matrix.map((row,i) => [...row,vector[i]]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    if (Math.abs(rows[pivot][column]) < 1e-12) throw new Error('degenerate affine fit');
    [rows[column],rows[pivot]] = [rows[pivot],rows[column]];
    const scale = rows[column][column];
    for (let j = column; j < 4; j++) rows[column][j] /= scale;
    for (let row = 0; row < 3; row++) if (row !== column) {
      const factor = rows[row][column];
      for (let j = column; j < 4; j++) rows[row][j] -= factor * rows[column][j];
    }
  }
  return rows.map(row => row[3]);
}

function rawFeatures(sample) {
  if (Array.isArray(sample?.features) && sample.features.length === 2) return sample.features;
  if (validPoint(sample?.raw)) return [sample.raw.x,sample.raw.y];
  return null;
}

function weightedAffineFit(samples, weights, ridge) {
  const matrix = Array.from({length:3},()=>Array(3).fill(0)), rhsX = Array(3).fill(0), rhsY = Array(3).fill(0);
  samples.forEach((sample,index) => {
    const [x,y] = rawFeatures(sample), row = [1,x,y], weight = weights[index];
    for (let i = 0; i < 3; i++) {
      rhsX[i] += weight * row[i] * sample.target.x;
      rhsY[i] += weight * row[i] * sample.target.y;
      for (let j = 0; j < 3; j++) matrix[i][j] += weight * row[i] * row[j];
    }
  });
  matrix[1][1] += ridge;
  matrix[2][2] += ridge;
  return {x:solve3(matrix,rhsX),y:solve3(matrix,rhsY)};
}

const median = values => {
  const sorted = [...values].sort((a,b)=>a-b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function fitAffineCalibration(samples, {ridge = 1e-4, robustIterations = 3, huberK = 1.345} = {}) {
  if (!Array.isArray(samples) || samples.length < 3 || !finite(ridge) || ridge < 0 || !Number.isInteger(robustIterations) || robustIterations < 0 || !finite(huberK) || huberK <= 0) throw new Error('valid affine training samples required');
  const ids = new Set();
  for (const sample of samples) {
    const features = rawFeatures(sample);
    if (typeof sample.id !== 'string' || !sample.id || ids.has(sample.id) || !features?.every(value => finite(value) && value >= 0 && value <= 1) || !validPoint(sample.target)) throw new Error('invalid affine training sample');
    ids.add(sample.id);
  }
  let weights = samples.map(() => 1);
  weightedAffineFit(samples,weights,0); // Reject collinear samples even when ridge regularization is enabled.
  let fit = weightedAffineFit(samples,weights,ridge);
  for (let iteration = 0; iteration < robustIterations; iteration++) {
    const residuals = samples.map(sample => {
      const [x,y] = rawFeatures(sample), px = fit.x[0] + fit.x[1] * x + fit.x[2] * y, py = fit.y[0] + fit.y[1] * x + fit.y[2] * y;
      return Math.hypot(px - sample.target.x,py - sample.target.y);
    });
    const center = median(residuals), scale = Math.max(1e-6,1.4826 * median(residuals.map(value => Math.abs(value - center)))), cutoff = huberK * scale;
    weights = residuals.map(value => value <= cutoff ? 1 : cutoff / value);
    fit = weightedAffineFit(samples,weights,ridge);
  }
  return {
    dimension:2,
    x:fit.x,
    y:fit.y,
    trainingIds:[...ids],
    featureBounds:[0,1].map(index=>({min:Math.min(...samples.map(sample=>rawFeatures(sample)[index])),max:Math.max(...samples.map(sample=>rawFeatures(sample)[index]))}))
  };
}

export function identityAffineCalibration(screen) {
  if (!finite(screen?.width) || !finite(screen?.height) || screen.width <= 0 || screen.height <= 0) throw new Error('valid screen required');
  return {dimension:2,x:[0,screen.width,0],y:[0,0,screen.height],trainingIds:[],featureBounds:[{min:0,max:1},{min:0,max:1}]};
}

export function selectAffineCalibrationCandidate({candidateModel,baselineModel,selectionSamples,screen,maxP95 = .05,minValidRate = .8} = {}) {
  if (!validAffineModel(candidateModel) || !validAffineModel(baselineModel) || !finite(maxP95) || maxP95 < 0 || !finite(minValidRate) || minValidRate < 0 || minValidRate > 1) throw new Error('candidate, baseline, and selection limits required');
  const baseline = calibrationMetrics(baselineModel,selectionSamples,screen,{independent:true});
  const candidate = calibrationMetrics(candidateModel,selectionSamples,screen,{independent:true});
  const selected = candidate.p95 !== null && baseline.p95 !== null && candidate.validRate >= minValidRate && candidate.p95 <= maxP95 && candidate.p95 < baseline.p95;
  return {selected,status:selected?'selected_on_independent_selection':'not_selected',baseline,candidate};
}
