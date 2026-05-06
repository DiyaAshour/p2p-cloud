import { createRoot } from 'react-dom/client';
import App from './App';
import TransferProgressOverlay from './TransferProgressOverlay';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <TransferProgressOverlay />
  </>
);
