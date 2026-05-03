import { useState, useCallback } from 'react';
import type { PageId } from './types';
import { TopNav } from './components/TopNav';
import { StatusBar } from './components/StatusBar';
import { ConceptToRoughModel } from './pages/Page1/ConceptToRoughModel';
import { HighresModel } from './pages/Page2/HighresModel';
import { ModelAssemble } from './pages/Page3/ModelAssemble';
import { ModelAssembleMockup } from './pages/Page3/ModelAssembleMockup';

type StatusType = 'info' | 'success' | 'warning' | 'error';

// Append ?mockup to the URL to preview the new Page3 layout mockup
// (no functionality, just visual). Falls back to production page otherwise.
const USE_PAGE3_MOCKUP =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('mockup');

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

      {/*
        All three pages stay mounted at all times so their internal state
        (uploads, in-flight generations, node-state machines) survives
        navigation. Inactive pages are hidden via CSS — never unmounted.
      */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        <PageHost active={page === 'page1'}>
          <ConceptToRoughModel onStatusChange={handleStatus} />
        </PageHost>
        <PageHost active={page === 'page2'}>
          <HighresModel onStatusChange={handleStatus} />
        </PageHost>
        <PageHost active={page === 'page3'}>
          {USE_PAGE3_MOCKUP
            ? <ModelAssembleMockup onStatusChange={handleStatus} />
            : <ModelAssemble onStatusChange={handleStatus} />}
        </PageHost>
      </div>

      <StatusBar
        message={status.msg}
        status={status.type}
        rightInfo={`Page: ${pageLabel(page)}`}
      />
    </div>
  );
}

interface PageHostProps {
  active: boolean;
  children: React.ReactNode;
}

/**
 * Keeps a page mounted while inactive (so its React state and any in-flight
 * async work is preserved), hiding it via CSS only. `inert` removes inactive
 * pages from the focus / accessibility tree.
 */
function PageHost({ active, children }: PageHostProps) {
  return (
    <div
      // `inert` is a real DOM attribute; React forwards unknown attrs to host
      // nodes verbatim. Casting via spread to avoid TS complaints.
      {...(active ? {} : { inert: '' })}
      style={{
        flex: 1,
        display: active ? 'flex' : 'none',
        overflow: 'hidden',
      }}
    >
      {children}
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
