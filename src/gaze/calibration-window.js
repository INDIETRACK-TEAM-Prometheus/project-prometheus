export const MAX_CALIBRATION_SAMPLE_AGE_MS=2500;
export const CALIBRATION_TARGET_TIMEOUT_MS=8000;
export const MAX_CALIBRATION_TARGET_TIMEOUT_MS=12000;
export const CALIBRATION_RUN_TIMEOUT_MS=240000;
export const CALIBRATION_ADAPT_TIMEOUT_MS=60000;
const MAX_CALIBRATION_CADENCE_INTERVAL_MS=5000;
const MAX_CALIBRATION_WINDOW_AGE_MS=10000;

function sampleCadenceMs(samples){
 const times=Array.isArray(samples)?samples.filter(s=>Number.isFinite(s?.at)).map(s=>s.at).slice(-12):[],intervals=[];
 for(let i=1;i<times.length;i++){const interval=times[i]-times[i-1];if(interval>0&&interval<=MAX_CALIBRATION_CADENCE_INTERVAL_MS)intervals.push(interval);}
 if(!intervals.length)return null;
 intervals.sort((a,b)=>a-b);
 const middle=Math.floor(intervals.length/2);
 return intervals.length%2?intervals[middle]:(intervals[middle-1]+intervals[middle])/2;
}

export function calibrationSampleFreshnessMs(samples,{minMs=250,maxMs=MAX_CALIBRATION_SAMPLE_AGE_MS,cadenceMultiplier=1.5}={}){
 if(!Array.isArray(samples)||![minMs,maxMs,cadenceMultiplier].every(Number.isFinite)||minMs<0||maxMs<minMs||maxMs>MAX_CALIBRATION_SAMPLE_AGE_MS||cadenceMultiplier<=0)throw new TypeError('invalid calibration freshness window');
 const cadence=sampleCadenceMs(samples);
 return cadence===null?minMs:Math.min(maxMs,Math.max(minMs,cadence*cadenceMultiplier));
}

export function calibrationSampleStatus(sample,{targetShownAt,now,maxAgeMs=MAX_CALIBRATION_SAMPLE_AGE_MS}={}){
 if(!Number.isFinite(targetShownAt)||!Number.isFinite(now)||!Number.isFinite(maxAgeMs)||maxAgeMs<0)return 'invalid_window';
 if(!sample?.features||sample.features.length!==2||!sample.features.every(Number.isFinite))return 'no_open_eye_sample';
 if(!Number.isFinite(sample.callbackTimestampMs))return 'missing_sample_timestamp';
 if(sample.callbackTimestampMs<targetShownAt+500)return 'no_post_dwell_sample';
 const age=now-sample.callbackTimestampMs;
 if(age<0)return 'future_sample';
 if(age>maxAgeMs)return 'stale_sample';
 return 'ready';
}

export function calibrationTargetTimeoutMs(samples,targetShownAt=-Infinity){
 const source=Array.isArray(samples)?samples:[];
 const targetSamples=Number.isFinite(targetShownAt)?source.filter(s=>Number.isFinite(s?.at)&&s.at>=targetShownAt+500):source;
 const cadence=sampleCadenceMs(targetSamples);
 return Math.min(MAX_CALIBRATION_TARGET_TIMEOUT_MS,Math.max(CALIBRATION_TARGET_TIMEOUT_MS,cadence===null?CALIBRATION_TARGET_TIMEOUT_MS:cadence*4+1500));
}

export function calibrationTargetTimedOut(targetShownAt,now,samples){
 return Number.isFinite(targetShownAt)&&Number.isFinite(now)&&now-targetShownAt>=calibrationTargetTimeoutMs(samples,targetShownAt);
}

export function calibrationWindowStatus(samples,{targetShownAt,now,minSamples=3,maxAgeMs=300,maxSpread=.05}={}){
 if(!Array.isArray(samples)||![targetShownAt,now,maxAgeMs,maxSpread].every(Number.isFinite)||now<targetShownAt+500)return 'settling';
 const cadence=sampleCadenceMs(samples),recentMaxAgeMs=Math.min(MAX_CALIBRATION_WINDOW_AGE_MS,Math.max(maxAgeMs,(cadence??maxAgeMs)*2.5));
 const targetSamples=samples.filter(s=>Number.isFinite(s.at)&&s.at>=targetShownAt+500&&Array.isArray(s.features)&&s.features.length===2&&s.features.every(Number.isFinite));
 const recent=targetSamples.filter(s=>now-s.at>=0&&now-s.at<=recentMaxAgeMs);
 if(recent.length<minSamples)return targetSamples.length?'insufficient_recent_samples':'no_post_dwell_samples';
 for(let axis=0;axis<2;axis++){const v=recent.map(s=>s.features[axis]);if(Math.max(...v)-Math.min(...v)>maxSpread)return 'gaze_unstable';}
 return 'ready';
}

// Stability checks validation quality, not fixation; training must not require the uncalibrated output to be stable.
export function stableCalibrationWindow(samples,options={}){
 return calibrationWindowStatus(samples,options)==='ready';
}
