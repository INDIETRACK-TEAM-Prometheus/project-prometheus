export const MAX_CALIBRATION_SAMPLE_AGE_MS=1500;
export const CALIBRATION_TARGET_TIMEOUT_MS=2500;

export function calibrationSampleFreshnessMs(samples,{minMs=250,maxMs=MAX_CALIBRATION_SAMPLE_AGE_MS,cadenceMultiplier=1.5}={}){
 if(!Array.isArray(samples)||![minMs,maxMs,cadenceMultiplier].every(Number.isFinite)||minMs<0||maxMs<minMs||maxMs>MAX_CALIBRATION_SAMPLE_AGE_MS||cadenceMultiplier<=0)throw new TypeError('invalid calibration freshness window');
 const times=samples.filter(s=>Number.isFinite(s?.at)).map(s=>s.at).slice(-12),intervals=[];
 for(let i=1;i<times.length;i++){const interval=times[i]-times[i-1];if(interval>0&&interval<=1000)intervals.push(interval);}
 if(!intervals.length)return minMs;
 intervals.sort((a,b)=>a-b);
 const middle=Math.floor(intervals.length/2),cadence=intervals.length%2?intervals[middle]:(intervals[middle-1]+intervals[middle])/2;
 return Math.min(maxMs,Math.max(minMs,cadence*cadenceMultiplier));
}

export function calibrationTargetTimedOut(targetShownAt,now){
 return Number.isFinite(targetShownAt)&&Number.isFinite(now)&&now-targetShownAt>=CALIBRATION_TARGET_TIMEOUT_MS;
}

// Stability is a quality check, not proof that the user looked at the target.
export function stableCalibrationWindow(samples,{targetShownAt,now,minSamples=3,maxAgeMs=300,maxSpread=.03}={}){
 if(!Array.isArray(samples)||![targetShownAt,now,maxAgeMs,maxSpread].every(Number.isFinite)||now<targetShownAt+500)return false;
 const recentMaxAgeMs=calibrationSampleFreshnessMs(samples,{minMs:maxAgeMs,maxMs:MAX_CALIBRATION_SAMPLE_AGE_MS,cadenceMultiplier:2.5});
 const recent=samples.filter(s=>Number.isFinite(s.at)&&s.at>=targetShownAt+400&&now-s.at>=0&&now-s.at<=recentMaxAgeMs&&Array.isArray(s.features)&&s.features.length===2&&s.features.every(Number.isFinite));
 if(recent.length<minSamples)return false;
 for(let axis=0;axis<2;axis++){const v=recent.map(s=>s.features[axis]);if(Math.max(...v)-Math.min(...v)>maxSpread)return false;}
 return true;
}
