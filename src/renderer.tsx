import './index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ProjectorRoot from './ProjectorView';

// The same bundle serves both windows: the control UI and the fullscreen
// projector (?projector=1).
const isProjector =
  new URLSearchParams(window.location.search).get('projector') === '1';

const root = createRoot(document.getElementById('root')!);
root.render(isProjector ? <ProjectorRoot /> : <App />);
