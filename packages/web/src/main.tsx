import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { UpdatePrompt } from './pwa/UpdatePrompt';
import './theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <UpdatePrompt />
    </BrowserRouter>
  </StrictMode>,
);
