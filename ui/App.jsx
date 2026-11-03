import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {listClips} from './lib/api.js';
import {parseGazeTrack} from '../src/gaze/gaze-replay.js';
import {createObjectMemory} from '../src/spatial/object-memory.js';
import {usePerception} from './hooks/usePerception.js';
import {usePlaceMemory} from './hooks/usePlaceMemory.js';
import SceneStage from './components/SceneStage.jsx';
import EyePanels from './components/EyePanels.jsx';
import MemoryView from './components/MemoryView.jsx';

// Prometheus on Project Aria recordings: the glasses' scene video and eye cameras, MPS eye gaze driving SAM 3.1,
// YOLO and depth live, a 3D memory of what the wearer looked at, and Muse Spark's next-action predictions.
// Clips play one after another (data/demo/playlist.json order); each rebuilds its memory and is compared with the
// places remembered from earlier clips (usePlaceMemory).

const autostart = new URLSearchParams(location.search).has('autostart');

export default function App() {
  const [clips, setClips] = useState([]), [index, setIndex] = useState(0), [track, setTrack] = useState(null);
  const [running, setRunning] = useState(autostart), [status, setStatus] = useState('Loading clips');
  const [objects, setObjects] = useState([]), [hud, setHud] = useState({timings:{}, errors:{}, spark:null});
  const videoRef = useRef(null);
  const memory = useMemo(() => createObjectMemory(), []);
  const onMemory = useCallback(() => setObjects(memory.list()), [memory]);
  const live = usePerception({videoRef, track, running, memory, onMemory});
  const clip = clips[index] ?? null;
  const place = usePlaceMemory({videoRef, clip, track, memory, onMemory});

  useEffect(() => { listClips().then(list => { setClips(list); setStatus(list.length ? '' : 'No clips in data/demo'); }, () => setStatus('Could not list the clips')); }, []);

  // Load a clip: its gaze track (with poses), then the video (usePlaceMemory resets the memory).
  useEffect(() => {
    if (!clip) return;
    let cancelled = false;
    setTrack(null);
    fetch(clip.gaze).then(r => r.text()).then(text => {
      if (cancelled) return;
      setTrack(parseGazeTrack(text));
      const video = videoRef.current;
      video.src = clip.video;
      video.onloadedmetadata = () => { if (clip.start) video.currentTime = clip.start; void video.play().catch(() => {}); };
    }).catch(() => !cancelled && setStatus(`Could not load ${clip.title}`));
    return () => { cancelled = true; };
  }, [clip]);

  const next = useCallback(() => setIndex(i => clips.length ? (i + 1) % clips.length : 0), [clips.length]);
  const onTimeUpdate = useCallback(() => { const video = videoRef.current; if (clip?.end && video.currentTime >= clip.end) next(); }, [clip, next]);

  // Timings, errors and the latest Spark result, refreshed a few times a second (the overlay reads the ref directly).
  useEffect(() => {
    const timer = setInterval(() => { const s = live.current; setHud({timings:{...s.timings}, errors:{...s.errors}, busy:{...s.busy}, spark:s.spark}); }, 250);
    return () => clearInterval(timer);
  }, [live]);

  const seconds = ms => ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  const stages = [['YOLO', 'yolo'], ['SAM 3.1', 'sam'], ['Depth', 'depth'], ['Spark naming', 'naming'], ['Muse Spark', 'spark']];

  return (
    <div className="app">
      <header className="bar">
        <div className="brand"><strong>Prometheus</strong><span>Gaze → SAM 3.1 → depth → Muse Spark</span></div>
        <nav className="clips" aria-label="Recordings">
          {clips.map((item, i) => <button key={item.name} className={i === index ? 'clip current' : 'clip'} onClick={() => setIndex(i)}>{item.title}</button>)}
        </nav>
        <div className="actions">
          <button className="ghost" onClick={() => { const v = videoRef.current; v.paused ? void v.play() : v.pause(); }}>Play / pause</button>
          <button className={running ? 'primary on' : 'primary'} onClick={() => setRunning(r => !r)}>{running ? 'Stop analysis' : 'Start analysis'}</button>
        </div>
      </header>

      <main className="scene">
        <SceneStage videoRef={videoRef} track={track} live={live} onEnded={next} onTimeUpdate={onTimeUpdate}>
          <div className="hud" aria-label="Model timings">
            {stages.map(([name, key]) => <span key={key} className={hud.errors[key] ? 'stage-chip error' : hud.busy?.[key] ? 'stage-chip busy' : 'stage-chip'} title={hud.errors[key] ?? ''}>{name}<b>{hud.errors[key] ? 'error' : seconds(hud.timings[key])}</b></span>)}
          </div>
          {hud.spark?.scenarios?.length ? (
            <div className="caption" aria-live="polite">
              <span className="caption-source">Muse Spark{hud.spark.label ? ` · looking at ${hud.spark.label}` : ''}</span>
              <p>{hud.spark.scenarios[0]}</p>
              {hud.spark.scenarios.slice(1, 3).map(text => <p key={text} className="alt">{text}</p>)}
            </div>
          ) : running ? <div className="caption quiet"><span className="caption-source">Muse Spark</span><p>Reading the scene…</p></div> : null}
          {status ? <div className="notice">{status}</div> : null}
        </SceneStage>
      </main>

      <aside className="side">
        <EyePanels src={clip?.eyes ?? null} sceneRef={videoRef} />
        <section className="memory" aria-label="3D memory">
          <div className="memory-head"><h2>3D memory</h2><span>{objects.length} {objects.length === 1 ? 'object' : 'objects'}{objects.some(o => o.recalled) ? ` · ${objects.filter(o => o.recalled).length} recalled` : ''}</span></div>
          {place.status ? <p className="place-status">{place.status}</p> : null}
          <MemoryView track={track} sceneRef={videoRef} objects={objects} recalledCloud={place.recalledCloud} />
        </section>
      </aside>
    </div>
  );
}
