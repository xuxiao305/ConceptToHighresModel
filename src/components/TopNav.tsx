import type { PageId } from '../types';

interface TopNavProps {
  active: PageId;
  onChange: (page: PageId) => void;
}

const tabs: { id: PageId; label: string; subtitle: string }[] = [
  { id: 'page1', label: 'Concept to Rough Model', subtitle: '概念稿 → 粗模' },
  { id: 'page2', label: 'Highres Model', subtitle: '部件拆分 → 高清模型' },
  { id: 'page3', label: 'Model Assemble', subtitle: '拼装与骨骼迁移' },
];

export function TopNav({ active, onChange }: TopNavProps) {
  return (
    <div
      style={{
        height: 'var(--topnav-height)',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-default)',
        display: 'flex',
        alignItems: 'stretch',
        padding: '0 12px',
        gap: 4,
        flex: '0 0 auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          color: 'var(--text-primary)',
          fontWeight: 700,
          fontSize: 13,
          marginRight: 24,
          letterSpacing: 0.3,
        }}
      >
        <span style={{ color: 'var(--accent-blue)', marginRight: 6 }}>◆</span>
        ConceptToHighresModel
      </div>

      {tabs.map((tab, idx) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            style={{
              border: 'none',
              background: isActive ? 'var(--bg-app)' : 'transparent',
              color: isActive ? 'var(--accent-blue)' : 'var(--text-secondary)',
              padding: '0 16px',
              fontSize: 12,
              fontWeight: isActive ? 600 : 500,
              borderTop: isActive ? '2px solid var(--accent-blue)' : '2px solid transparent',
              borderBottom: isActive ? '2px solid var(--bg-app)' : '2px solid transparent',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'flex-start',
              gap: 1,
              transition: 'color 0.12s, background 0.12s',
            }}
          >
            <span>
              <span
                style={{
                  display: 'inline-block',
                  width: 16,
                  textAlign: 'center',
                  marginRight: 4,
                  color: isActive ? 'var(--accent-blue)' : 'var(--text-muted)',
                }}
              >
                {idx + 1}
              </span>
              {tab.label}
            </span>
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                marginLeft: 20,
                fontWeight: 400,
              }}
            >
              {tab.subtitle}
            </span>
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          color: 'var(--text-muted)',
          fontSize: 11,
        }}
      >
        <span>Mockup Preview</span>
        <span style={{ color: 'var(--text-disabled)' }}>v0.1</span>
      </div>
    </div>
  );
}
