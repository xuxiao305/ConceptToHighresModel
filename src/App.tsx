import { useState, useCallback } from 'react';
import type { PageId } from './types';
import { TopNav } from './components/TopNav';
import { StatusBar } from './components/StatusBar';
import { ConceptToRoughModel } from './pages/Page1/ConceptToRoughModel';
import { HighresModel } from './pages/Page2/HighresModel';
import { ModelAssemble } from './pages/Page3/ModelAssemble';

type StatusType = 'info' | 'success' | 'warning' | 'error';

export default function App() {
  const [page, setPage] = useState<PageId>('page1');
  const [status, setStatus] = useState<{ msg: string; type: StatusType }>({
    msg: '就绪',
    type: 'info',
  });

  const handleStatus = useCallback((msg: string, type: StatusType = 'info') => {
    setStatus({ msg, type });
  }, []);

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-app)',
      }}
    >
      <TopNav active={page} onChange={setPage} onProjectStatus={handleStatus} />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {page === 'page1' && <ConceptToRoughModel onStatusChange={handleStatus} />}
        {page === 'page2' && <HighresModel onStatusChange={handleStatus} />}
        {page === 'page3' && <ModelAssemble onStatusChange={handleStatus} />}
      </div>

      <StatusBar
        message={status.msg}
        status={status.type}
        rightInfo={`Page: ${pageLabel(page)}`}
      />
    </div>
  );
}

function pageLabel(p: PageId): string {
  switch (p) {
    case 'page1': return '1 / 3 — Concept to Rough Model';
    case 'page2': return '2 / 3 — Highres Model';
    case 'page3': return '3 / 3 — Model Assemble';
  }
}
