import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initAnalytics } from './lib/analytics';
import './theme.css';

initAnalytics();
createRoot(document.getElementById('root')!).render(<App />);
