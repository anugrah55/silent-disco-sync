import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@fontsource-variable/unbounded';
import './index.css';
import { App } from './App';
import { audioEngine } from './audio/engine';
import { getConnection } from './net/connection';
import { currentRoomSession } from './room/session';

// Read-only handles for debugging on a phone (remote inspector) and for the
// automated sync measurements; nothing in the app depends on this.
Object.assign(window, { __sds: { audioEngine, getConnection, currentRoomSession } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// Installable PWA (production only: a dev service worker would fight Vite's HMR).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* insecure context or blocked: the app works without it */
    });
  });
}
