import {useEffect, useRef, useState} from 'react';
import {comparePlaces} from '../lib/api.js';
import {captureVideo, keyframeGrid} from '../lib/frames.js';

// Place memory across recordings. When the clip changes, what this recording built (objects in 3D, the room's SLAM
// points, a few keyframes) is stored as a place, and the memory is rebuilt from nothing for the new recording. Once
// the new recording has shown a few frames, Muse Spark compares them with each remembered place's keyframes; on a
// match the earlier objects come back at their stored 3D positions (recordings of one home share an MPS world frame)
// and the earlier room points join the map.

const FIRST_FRAMES = 3, MAX_KEYFRAMES = 8, KEYFRAME_EVERY_S = 6, SAME_PLACE_CONFIDENCE = .6;

const spread = (items, count) => items.length <= count ? items : Array.from({length:count}, (_, i) => items[Math.round(i * (items.length - 1) / (count - 1))]);

export function usePlaceMemory({videoRef, clip, track, memory, onMemory}) {
  const places = useRef([]), current = useRef(null);
  const [place, setPlace] = useState({status:'', recalledCloud:null});

  // Clip change: store the recording that just ended as a place (or extend the place it was recognised as), then
  // start the new recording's memory empty.
  useEffect(() => {
    const previous = current.current;
    if (previous?.track) {
      const objects = memory.list().filter(o => o.label).map(({label, position, count}) => ({label, position, count}));
      if (previous.place) {
        const stored = previous.place;
        stored.objects = objects; stored.keyframes = spread([...stored.keyframes, ...previous.keyframes], MAX_KEYFRAMES);
        stored.clouds = [...stored.clouds, previous.track.cloud].filter(Boolean); stored.titles = [...new Set([...stored.titles, previous.title])];
      } else if (previous.keyframes.length) {
        places.current.push({id:`place-${places.current.length + 1}`, titles:[previous.title], objects, keyframes:spread(previous.keyframes, MAX_KEYFRAMES), clouds:[previous.track.cloud].filter(Boolean)});
      }
    }
    memory.clear(); onMemory();
    current.current = clip ? {title:clip.title, start:clip.start ?? 0, track:null, keyframes:[], place:null, compared:false} : null;
    setPlace({status:clip ? 'Building a new place memory' : '', recalledCloud:null});
  }, [clip, memory, onMemory]);

  useEffect(() => { if (current.current) current.current.track = track; }, [track]);

  // Keyframes: the first few seconds for recognition, then one every few seconds for the stored place.
  useEffect(() => {
    let busy = false;
    const timer = setInterval(async () => {
      const video = videoRef.current, state = current.current;
      if (!video || !state?.track || video.paused || video.readyState < 2 || busy) return;
      const due = state.keyframes.length < FIRST_FRAMES ? .5 + state.keyframes.length : FIRST_FRAMES + (state.keyframes.length - FIRST_FRAMES + 1) * KEYFRAME_EVERY_S;
      if (video.currentTime - state.start >= due && state.keyframes.length < MAX_KEYFRAMES * 2) state.keyframes.push(captureVideo(video, 256, {quality:.75}).dataUrl);
      if (state.compared || state.keyframes.length < FIRST_FRAMES) return;
      state.compared = true;
      if (!places.current.length) { setPlace({status:'New place · building its memory', recalledCloud:null}); return; }
      busy = true;
      setPlace({status:'Comparing with remembered places', recalledCloud:null});
      try {
        for (const stored of [...places.current].reverse()) {
          const grid = await keyframeGrid(spread(stored.keyframes, FIRST_FRAMES), state.keyframes.slice(0, FIRST_FRAMES));
          // one retry: a single malformed or cut-off model answer should not lose the recognition
          // retries: a malformed answer, or the API briefly blocked after a rate limit (the circuit reopens in seconds)
          let answer = null;
          for (let attempt = 0; !answer && attempt < 3; attempt++) {
            answer = await comparePlaces(grid).catch(error => { if (attempt === 2) throw error; return null; });
            if (!answer) await new Promise(resolve => setTimeout(resolve, 5000));
            if (current.current !== state) return;
          }
          if (current.current !== state) return;
          if (answer.same && answer.confidence >= SAME_PLACE_CONFIDENCE) {
            state.place = stored;
            memory.seed(stored.objects, stored.titles.at(-1)); onMemory();
            const total = stored.clouds.reduce((n, c) => n + c.length, 0), merged = new Float32Array(total);
            stored.clouds.reduce((offset, c) => { merged.set(c, offset); return offset + c.length; }, 0);
            setPlace({status:`Recognised: same place as "${stored.titles.join('", "')}" (${Math.round(answer.confidence * 100)}%) · ${stored.objects.length} objects recalled · ${answer.evidence}`, recalledCloud:merged});
            return;
          }
        }
        setPlace({status:'New place · building its memory', recalledCloud:null});
      } catch (error) { if (current.current === state) setPlace({status:`Place comparison failed (${error.message}) · building a new memory`, recalledCloud:null}); }
      finally { busy = false; }
    }, 250);
    return () => clearInterval(timer);
  }, [videoRef, memory, onMemory]);

  return place;
}
