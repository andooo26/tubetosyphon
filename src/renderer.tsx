import './index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import GenWindowRoot from './GenView';
import ProjectorRoot from './ProjectorView';

// The same bundle serves three windows: the normal UI, the hidden offscreen
// 1920x1080 window (loaded with ?gen=1) whose painted frames become the Syphon
// output in 汎用 (generic) mode, and the fullscreen projector (?projector=1).
const query = new URLSearchParams(window.location.search);
const isGenWindow = query.get('gen') === '1';
const isProjector = query.get('projector') === '1';

const root = createRoot(document.getElementById('root')!);
root.render(
  isGenWindow ? <GenWindowRoot /> : isProjector ? <ProjectorRoot /> : <App />,
);
