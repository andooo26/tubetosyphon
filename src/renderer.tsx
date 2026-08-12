import './index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import GenWindowRoot from './GenView';

// The same bundle serves two windows: the normal UI, and the hidden offscreen
// 1920x1080 window (loaded with ?gen=1) whose painted frames become the Syphon
// output in 汎用 (generic) mode.
const isGenWindow = new URLSearchParams(window.location.search).get('gen') === '1';

const root = createRoot(document.getElementById('root')!);
root.render(isGenWindow ? <GenWindowRoot /> : <App />);
