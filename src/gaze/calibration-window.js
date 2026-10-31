// Stability is a quality check, not proof that the user looked at the target.
export function stableCalibrationWindow(samples,{targetShownAt,now,minSamples=3,maxAgeMs=300,maxSpread=.03}={}){
 if(!Array.isArray(samples)||![targetShownAt,now,maxAgeMs,maxSpread].every(Number.isFinite)||now<targetShownAt+500)return false;
 const recent=samples.filter(s=>Number.isFinite(s.at)&&s.at>=targetShownAt+400&&now-s.at>=0&&now-s.at<=maxAgeMs&&Array.isArray(s.features)&&s.features.length===2&&s.features.every(Number.isFinite));
 if(recent.length<minSamples)return false;
 for(let axis=0;axis<2;axis++){const v=recent.map(s=>s.features[axis]);if(Math.max(...v)-Math.min(...v)>maxSpread)return false;}
 return true;
}
