const valid = x => typeof x === 'number' && Number.isFinite(x);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const canonical = value => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;

export function createTimingTemplate({browserSessionId,cameraSessionId,setup,intendedDurationMs=1800000}={}) {
  if(typeof browserSessionId!=='string'||!browserSessionId||typeof cameraSessionId!=='string'||!cameraSessionId||!setup||!valid(intendedDurationMs)||intendedDurationMs<1000)throw new TypeError('browser and camera session, setup and duration required');
  return {schemaVersion:1,browserSessionId,cameraSessionId,setup,intendedDurationMs,reference:{method:'photodiode-camera-marker-shared-timebase',timebaseId:'',instrumentId:'',uncertaintyMs:null,evidenceFile:'',evidenceSha256:'',measuredAtUtc:''},cameraClock:{sourceClockId:'browser_video_capture_estimate',fit:[],validation:[]},displayRegions:{top:{yMin:0,yMax:1/3,fit:[],validation:[]},middle:{yMin:1/3,yMax:2/3,fit:[],validation:[]},bottom:{yMin:2/3,yMax:1,fit:[],validation:[]}}};
}

function fitAffine(pairs, xKey, yKey, referenceUncertaintyMs, maxExtrapolationMs) {
  if (!Array.isArray(pairs) || pairs.length < 3) throw new Error('at least three measured pairs required');
  const rows = pairs.map(p => {
    if (!exact(p, ['id', xKey, yKey]) || typeof p.id !== 'string' || !p.id || !valid(p[xKey]) || !valid(p[yKey]) || p[xKey] < 0 || p[yKey] < 0) throw new Error('invalid timing pair');
    return {id:p.id, x:p[xKey], y:p[yKey]};
  }).sort((a,b) => a.x-b.x);
  if (new Set(rows.map(p=>p.id)).size !== rows.length || rows.some((p,i)=>i && (p.x<=rows[i-1].x || p.y<=rows[i-1].y))) throw new Error('nonmonotonic or repeated timing pair');
  const x0=rows[0].x, x1=rows.at(-1).x, span=x1-x0, mx=(x0+x1)/2, my=rows.reduce((n,p)=>n+p.y,0)/rows.length;
  if (span < 1000) throw new Error('measurement span too short');
  const xx=rows.reduce((n,p)=>n+(p.x-mx)**2,0), slope=rows.reduce((n,p)=>n+(p.x-mx)*(p.y-my),0)/xx;
  if (!valid(slope) || slope<=0) throw new Error('invalid measured clock drift');
  const intercept=my-slope*mx, residuals=rows.map(p=>Math.abs(p.y-(intercept+slope*p.x))), maxResidual=Math.max(...residuals);
  const uncertaintyMs=referenceUncertaintyMs+maxResidual;
  const driftPpm=(slope-1)*1e6, driftUncertaintyPpm=(maxResidual+referenceUncertaintyMs)*1e6/span;
  if (!valid(uncertaintyMs) || !valid(driftPpm) || !valid(driftUncertaintyPpm)) throw new Error('invalid timing uncertainty');
  return {sourceAnchorMs:mx,sessionAnchorMs:intercept+slope*mx,driftPpm,uncertaintyMs,driftUncertaintyPpm,sourceMinMs:x0,sourceMaxMs:x1,maxExtrapolationMs,maxPairResidualMs:maxResidual};
}

// Validates a locally supplied optical-measurement record. It proves schema,
// independent holdout fit and setup match; it cannot authenticate the instrument.
export function validateTimingCalibration(profile, expected) {
  if (!exact(profile,['schemaVersion','browserSessionId','cameraSessionId','setup','intendedDurationMs','reference','cameraClock','displayRegions']) || profile.schemaVersion!==1 || profile.browserSessionId!==expected?.browserSessionId || profile.cameraSessionId!==expected?.cameraSessionId || !valid(profile.intendedDurationMs) || profile.intendedDurationMs<1000 || !exact(profile.setup,['userAgent','viewport','camera']) || !exact(profile.setup.viewport,['width','height','devicePixelRatio','screenX','screenY','screenWidth','screenHeight']) || !exact(profile.setup.camera,['modelLabel','width','height','frameRate']) || typeof profile.setup.camera.modelLabel!=='string' || !profile.setup.camera.modelLabel.trim() || !expected?.setup || JSON.stringify(canonical(profile.setup))!==JSON.stringify(canonical(expected.setup))) throw new Error('timing setup or camera/browser session mismatch');
  const r=profile.reference;
  if (!exact(r,['method','timebaseId','instrumentId','uncertaintyMs','evidenceFile','evidenceSha256','measuredAtUtc']) || r.method!=='photodiode-camera-marker-shared-timebase' || ![r.timebaseId,r.instrumentId,r.evidenceFile].every(x=>typeof x==='string'&&x.trim()) || !/^[a-f\d]{64}$/i.test(r.evidenceSha256) || !valid(r.uncertaintyMs) || r.uncertaintyMs<=0 || !Number.isFinite(Date.parse(r.measuredAtUtc))) throw new Error('optical reference metadata required');
  const camera=profile.cameraClock;
  if (!exact(camera,['sourceClockId','fit','validation']) || camera.sourceClockId!=='browser_video_capture_estimate' || !Array.isArray(camera.fit) || !Array.isArray(camera.validation) || camera.fit.length<3 || camera.validation.length<3) throw new Error('camera clock measurements required');
  if([...camera.fit,...camera.validation].some(p=>!exact(p,['id','sourceMs','performanceMs','callbackMs'])||!valid(p.sourceMs)||!valid(p.performanceMs)||!valid(p.callbackMs)||p.sourceMs<0||p.performanceMs<0||p.callbackMs<p.performanceMs))throw new Error('invalid camera timing pair');
  const cameraIds=[...camera.fit,...camera.validation].map(p=>p?.id);
  if (cameraIds.some(id=>typeof id!=='string'||!id) || new Set(cameraIds).size!==cameraIds.length) throw new Error('camera holdout samples must be independent');
  const cameraModel=fitAffine(camera.fit.map(({id,sourceMs,performanceMs})=>({id,sourceMs,performanceMs})),'sourceMs','performanceMs',r.uncertaintyMs,profile.intendedDurationMs);
  const cameraValidation=camera.validation.map(p=>{if(!exact(p,['id','sourceMs','performanceMs','callbackMs'])||!valid(p.callbackMs)||p.callbackMs<p.performanceMs)throw new Error('invalid camera validation pair');return {id:p.id,x:p.sourceMs,y:p.performanceMs,callbackMs:p.callbackMs};});
  let cameraResidual=0;
  for(const p of cameraValidation){const residual=Math.abs(p.y-(cameraModel.sessionAnchorMs+(p.x-cameraModel.sourceAnchorMs)*(1+cameraModel.driftPpm/1e6)));cameraResidual=Math.max(cameraResidual,residual);}
  const cameraFitRows=camera.fit.map(p=>({...p,callbackMs:p.callbackMs}));
  if(cameraFitRows.some(p=>!valid(p.callbackMs)||p.callbackMs<p.performanceMs)) throw new Error('camera callback timing required');
  const lagRows=[...cameraFitRows,...cameraValidation].map(p=>p.callbackMs-p.performanceMs);
  const cameraRows=[...camera.fit.map(p=>({x:p.sourceMs,y:p.performanceMs})),...cameraValidation].sort((a,b)=>a.x-b.x),cameraResidualAt=p=>p.y-(cameraModel.sessionAnchorMs+(p.x-cameraModel.sourceAnchorMs)*(1+cameraModel.driftPpm/1e6));
  if(cameraRows.some((p,i)=>i&&(p.x<=cameraRows[i-1].x||Math.abs(cameraResidualAt(p)-cameraResidualAt(cameraRows[i-1]))>50))) throw new Error('camera clock jump detected');
  cameraModel.uncertaintyMs+=cameraResidual;
  cameraModel.driftUncertaintyPpm+=(cameraResidual*1e6)/Math.max(cameraModel.sourceMaxMs-cameraModel.sourceMinMs,1);
  cameraModel.jumpDetected=false;
  const specs={top:[0,1/3],middle:[1/3,2/3],bottom:[2/3,1]}, displayModels={};
  if(!exact(profile.displayRegions,Object.keys(specs))) throw new Error('top, middle and bottom display measurements required');
  for(const [name,[yMin,yMax]] of Object.entries(specs)){
    const region=profile.displayRegions[name];
    if(!exact(region,['yMin','yMax','fit','validation'])||region.yMin!==yMin||region.yMax!==yMax||!Array.isArray(region.fit)||!Array.isArray(region.validation)||region.fit.length<3||region.validation.length<3) throw new Error(`invalid ${name} display measurements`);
    const rows=[...region.fit,...region.validation];
    if(rows.some(p=>!exact(p,['id','renderMs','presentMs'])||typeof p.id!=='string'||!p.id||!valid(p.renderMs)||!valid(p.presentMs)||p.renderMs<0||p.presentMs<p.renderMs)||new Set(rows.map(p=>p.id)).size!==rows.length) throw new Error(`independent ${name} display measurements required`);
    const model=fitAffine(region.fit,'renderMs','presentMs',r.uncertaintyMs,profile.intendedDurationMs);
    const residuals=region.validation.map(p=>Math.abs(p.presentMs-(model.sessionAnchorMs+(p.renderMs-model.sourceAnchorMs)*(1+model.driftPpm/1e6))));
    const residual=Math.max(...residuals);
    const chronological=rows.map(p=>({x:p.renderMs,y:p.presentMs})).sort((a,b)=>a.x-b.x);
    const displayResidualAt=p=>p.y-(model.sessionAnchorMs+(p.x-model.sourceAnchorMs)*(1+model.driftPpm/1e6));
    if(chronological.some((p,i)=>i&&(p.x<=chronological[i-1].x||p.y<=chronological[i-1].y||Math.abs(displayResidualAt(p)-displayResidualAt(chronological[i-1]))>50))) throw new Error(`${name} display clock jump detected`);
    model.uncertaintyMs+=residual;model.driftUncertaintyPpm+=(residual*1e6)/Math.max(model.sourceMaxMs-model.sourceMinMs,1);model.jumpDetected=false;displayModels[name]=model;
  }
  const nowCheck=valid(expected.performanceNowMs)?Object.values(displayModels).every(model=>convertClock(expected.performanceNowMs,model).status==='ok'):true;
  if(!nowCheck||valid(expected.captureSourceMs)&&convertClock(expected.captureSourceMs,cameraModel).status!=='ok')throw new Error('timing measurements do not cover this running session');
  return {status:'measurement_record_validated',profileId:r.evidenceSha256.slice(0,16),browserSessionId:profile.browserSessionId,setup:profile.setup,sourceClockId:camera.sourceClockId,cameraClockModel:cameraModel,cameraCallbackLagMs:{min:Math.min(...lagRows),max:Math.max(...lagRows)},displayModels,reference:{method:r.method,timebaseId:r.timebaseId,instrumentId:r.instrumentId,uncertaintyMs:r.uncertaintyMs,evidenceFile:r.evidenceFile,evidenceSha256:r.evidenceSha256,measuredAtUtc:r.measuredAtUtc},intendedDurationMs:profile.intendedDurationMs,t15Status:'not_run'};
}
// All inputs are milliseconds in their declared clock domains. Model is calibrated
// at sourceAnchorMs: session = sessionAnchorMs + elapsed * (1 + driftPpm / 1e6).
export function convertClock(sourceMs, model) {
  for (const x of [sourceMs, model?.sourceAnchorMs, model?.sessionAnchorMs, model?.driftPpm, model?.uncertaintyMs, model?.driftUncertaintyPpm]) if (!valid(x)) throw new TypeError('finite clock values required');
  if (model.uncertaintyMs < 0 || model.driftUncertaintyPpm < 0 || 1 + model.driftPpm / 1e6 <= 0 || model.jumpDetected) return {status: 'withheld', reason: 'invalid_or_jumped_clock'};
  if (valid(model.sourceMinMs) && sourceMs < model.sourceMinMs || valid(model.sourceMaxMs) && valid(model.maxExtrapolationMs) && sourceMs > model.sourceMaxMs + model.maxExtrapolationMs) return {status:'withheld',reason:'clock_calibration_expired'};
  const elapsed = sourceMs - model.sourceAnchorMs;
  return {status: 'ok', sessionMs: model.sessionAnchorMs + elapsed * (1 + model.driftPpm / 1e6), uncertaintyMs: model.uncertaintyMs + Math.abs(elapsed) * model.driftUncertaintyPpm / 1e6};
}

export class ClockDriftMonitor {
  constructor(model, callbackLagMs, jumpThresholdMs=50) { this.model=model;this.callbackLagMs=callbackLagMs;this.jumpThresholdMs=jumpThresholdMs;this.last=null;this.jumped=false; }
  reset() { this.last=null;this.jumped=false; }
  observe(sourceMs, callbackMs) {
    if(this.jumped)return {status:'withheld',reason:'clock_jump_detected'};
    const converted=convertClock(sourceMs,this.model);
    if(converted.status!=='ok')return converted;
    const lag=callbackMs-converted.sessionMs, margin=this.jumpThresholdMs+converted.uncertaintyMs;
    if(!valid(callbackMs)||callbackMs<0||lag<this.callbackLagMs.min-margin||lag>this.callbackLagMs.max+margin){this.jumped=true;return {status:'withheld',reason:'clock_jump_detected'};}
    if(this.last){
      if(sourceMs<=this.last.sourceMs||callbackMs<=this.last.callbackMs||Math.abs((converted.sessionMs-this.last.sessionMs)-(callbackMs-this.last.callbackMs))>margin){this.jumped=true;return {status:'withheld',reason:'clock_jump_detected'};}
    }
    this.last={sourceMs,callbackMs,sessionMs:converted.sessionMs};
    return {status:'ok',sessionMs:converted.sessionMs,uncertaintyMs:converted.uncertaintyMs};
  }
}

// Caller selects frames by present estimate, never response arrival order. A
// conservative sum includes capture, sync, display and temporal separation.
export function alignCapture(capture, frames, budgetMs = 50) {
  if (!capture || !valid(capture.sessionMs) || !valid(capture.uncertaintyMs) || capture.uncertaintyMs < 0 || !valid(budgetMs) || budgetMs < 0 || !Array.isArray(frames)) throw new TypeError('invalid alignment inputs');
  const eligible = frames.filter(f => f && typeof f.frameId === 'string' && f.frameId && valid(f.presentMs) && valid(f.syncUncertaintyMs) && f.syncUncertaintyMs >= 0 && valid(f.displayUncertaintyMs) && f.displayUncertaintyMs >= 0 && f.presentMs <= capture.sessionMs);
  eligible.sort ( (a, b) => b.presentMs - a.presentMs );
  if (!eligible.length) return {status: 'withheld', reason: 'no_presented_frame'};
  const f = eligible[0];
  const errorMs = capture.sessionMs - f.presentMs + capture.uncertaintyMs + f.syncUncertaintyMs + f.displayUncertaintyMs;
  return errorMs <= budgetMs ? {status: 'ok', frameId: f.frameId, errorMs} : {status: 'withheld', reason: 'alignment_budget_exceeded', errorMs};
}
