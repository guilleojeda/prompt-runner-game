import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const buildRevision = import.meta.env.VITE_BUILD_REVISION;

document.querySelector('meta[name="build-revision"]')?.setAttribute('content', buildRevision);
document.documentElement.dataset.buildRevision = buildRevision;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
