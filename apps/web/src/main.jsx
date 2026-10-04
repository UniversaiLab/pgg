import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createClient } from './lib/client.js';
import './styles.css';

const client = createClient();
client.boot();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
