import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import './index.css';
import App from './App.tsx';
import { GameProvider } from './context/GameContext.tsx';

createRoot(document.getElementById('root')!).render(
  <GameProvider>
    <App />
    <Analytics />
  </GameProvider>
);
