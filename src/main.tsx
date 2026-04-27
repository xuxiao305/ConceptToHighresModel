import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ProjectProvider } from './contexts/ProjectContext';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ProjectProvider>
      <App />
    </ProjectProvider>
  </React.StrictMode>
);
