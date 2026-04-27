import { useState } from 'react';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';

type GalleryTab = 'outliner' | 'mesh' | 'model' | 'pose';

interface Props {
  onStatusChange: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

const MOCK_OUTLINER = [
  { name: 'Body', visible: true, locked: false },
  { name: 'Head', visible: true, locked: false },
  { name: 'Left Arm', visible: true, locked: true },
  { name: 'Right Arm', visible: true, locked: false },
  { name: 'Left Leg', visible: false, locked: false },
  { name: 'Right Leg', visible: true, locked: false },
];

const MOCK_GALLERY = [
  { name: 'Sword_v01', faces: '12.4k' },
  { name: 'Shield_v02', faces: '8.7k' },
  { name: 'Helmet_v01', faces: '15.2k' },
  { name: 'Armor_v03', faces: '32.1k' },
  { name: 'Boots_v01', faces: '9.5k' },
  { name: 'Cape_v02', faces: '4.8k' },
];

const MOCK_POSES = ['T-Pose', 'A-Pose', 'Idle', 'Walk', 'Run', 'Attack'];

export function ModelAssemble({ onStatusChange }: Props) {
  const [tab, setTab] = useState<GalleryTab>('outliner');
  const [landmarks, setLandmarks] = useState<{ id: number; label: string; coords: string }[]>([
    { id: 1, label: 'L_Shoulder', coords: '(0.21, 1.45, 0.08)' },
    { id: 2, label: 'R_Shoulder', coords: '(-0.21, 1.45, 0.08)' },
    { id: 3, label: 'Pelvis', coords: '(0.00, 0.95, 0.00)' },
  ]);
  const [aligning, setAligning] = useState(false);
  const [alignError, setAlignError] = useState<number | null>(null);

  const addLandmark = () => {
    const nextId = (landmarks[landmarks.length - 1]?.id ?? 0) + 1;
    setLandmarks([
      ...landmarks,
      {
        id: nextId,
        label: `Point_${nextId}`,
        coords: `(${(Math.random() * 2 - 1).toFixed(2)}, ${(Math.random() * 2).toFixed(2)}, ${(Math.random() * 2 - 1).toFixed(2)})`,
      },
    ]);
    onStatusChange(`已添加 Landmark Point #${nextId}`, 'info');
  };

  const removeLandmark = (id: number) => {
    setLandmarks(landmarks.filter((p) => p.id !== id));
    onStatusChange(`已删除 Landmark Point #${id}`, 'warning');
  };

  const runAlign = () => {
    if (landmarks.length < 3) {
      onStatusChange('至少需要 3 个 Landmark Points 才能对齐', 'error');
      return;
    }
    setAligning(true);
    setAlignError(null);
    onStatusChange('正在执行最小二乘法对齐 …', 'info');
    window.setTimeout(() => {
      const err = +(Math.random() * 0.05).toFixed(4);
      setAlignError(err);
      setAligning(false);
      onStatusChange(`对齐完成，平均误差 ${err}`, 'success');
    }, 1500);
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '260px 1fr 280px',
        overflow: 'hidden',
        background: 'var(--bg-app)',
      }}
    >
      {/* LEFT PANEL */}
      <aside
        style={{
          background: 'var(--bg-surface)',
          borderRight: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-default)' }}>
          {(['outliner', 'mesh', 'model', 'pose'] as GalleryTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: '8px 4px',
                background: tab === t ? 'var(--bg-app)' : 'transparent',
                color: tab === t ? 'var(--accent-blue)' : 'var(--text-secondary)',
                border: 'none',
                borderBottom: tab === t ? '2px solid var(--accent-blue)' : '2px solid transparent',
                fontSize: 11,
                fontWeight: tab === t ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {tabLabel(t)}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
          {tab === 'outliner' && <OutlinerList />}
          {tab === 'mesh' && <GalleryGrid items={MOCK_GALLERY} kind="Mesh" />}
          {tab === 'model' && <GalleryGrid items={MOCK_GALLERY} kind="Model" />}
          {tab === 'pose' && <PoseList items={MOCK_POSES} onApply={(p) => onStatusChange(`已应用姿态：${p}`, 'success')} />}
        </div>
        <div
          style={{
            padding: 8,
            borderTop: '1px solid var(--border-default)',
            display: 'flex',
            gap: 6,
          }}
        >
          <Button size="sm" style={{ flex: 1 }}>＋ 导入</Button>
          <Button size="sm" style={{ flex: 1 }}>刷新</Button>
        </div>
      </aside>

      {/* CENTER 3D VIEWPORT */}
      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: 12,
          gap: 8,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--text-secondary)',
            fontSize: 11,
          }}
        >
          <Button size="sm">视图: 透视</Button>
          <Button size="sm">显示模式: 实体</Button>
          <Button size="sm">线框叠加</Button>
          <span style={{ flex: 1 }} />
          <span>已加载部件: {landmarks.length}</span>
        </div>
        <div
          style={{
            flex: 1,
            background:
              'radial-gradient(ellipse at 50% 40%, #3a3a3a 0%, #1f1f1f 70%, #141414 100%)',
            border: '1px solid var(--border-default)',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* Mock grid floor */}
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#2c2c2c" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', zIndex: 1 }}>
            <div style={{ fontSize: 48, opacity: 0.4 }}>◈</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>3D 拼装视口</div>
            <div style={{ fontSize: 10, marginTop: 4, color: 'var(--text-disabled)' }}>
              （Mockup 占位 — 实际版本将集成 Babylon.js / Three.js）
            </div>
          </div>
          <div
            style={{
              position: 'absolute',
              bottom: 8,
              left: 12,
              fontSize: 10,
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            视口: 1920×1080  |  FPS: 60
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm">→ Transfer Rigging Page</Button>
          <span style={{ flex: 1 }} />
          <Button size="sm">导出场景</Button>
          <Button variant="primary" size="sm">完成拼装</Button>
        </div>
      </main>

      {/* RIGHT PANEL */}
      <aside
        style={{
          background: 'var(--bg-surface)',
          borderLeft: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Landmark Points */}
        <PanelSection title="Landmark Points">
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              marginBottom: 8,
              lineHeight: 1.5,
            }}
          >
            在 3D 视口中点击模型表面添加点位，用于刚体+缩放对齐
          </div>
          <div
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 3,
              maxHeight: 220,
              overflow: 'auto',
              background: 'var(--bg-app)',
            }}
          >
            {landmarks.map((p) => (
              <div
                key={p.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '4px 8px',
                  borderBottom: '1px solid var(--border-subtle)',
                  fontSize: 11,
                  gap: 6,
                }}
              >
                <span style={{ color: 'var(--accent-blue)', width: 18 }}>#{p.id}</span>
                <span style={{ flex: 1, color: 'var(--text-primary)' }}>{p.label}</span>
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                  {p.coords}
                </span>
                <button
                  onClick={() => removeLandmark(p.id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    fontSize: 12,
                    padding: 2,
                  }}
                  title="删除"
                >
                  ×
                </button>
              </div>
            ))}
            {landmarks.length === 0 && (
              <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
                暂无 Landmark Points
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <Button size="sm" onClick={addLandmark} style={{ flex: 1 }}>＋ 添加</Button>
            <Button size="sm" onClick={() => setLandmarks([])}>清空</Button>
          </div>
        </PanelSection>

        {/* Align Tools */}
        <PanelSection title="Align Tools">
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
            算法: 最小二乘法 (刚体 + 缩放)
          </div>
          <Button
            variant="primary"
            size="sm"
            loading={aligning}
            onClick={runAlign}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            执行对齐
          </Button>
          {alignError !== null && (
            <div
              style={{
                marginTop: 8,
                padding: 8,
                background: 'var(--bg-app)',
                border: '1px solid var(--state-complete)',
                borderRadius: 3,
                fontSize: 11,
                color: 'var(--accent-green)',
              }}
            >
              ✓ 平均误差: {alignError}
              <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 2 }}>
                建议: {alignError < 0.02 ? '对齐质量优秀' : '可手动微调'}
              </div>
            </div>
          )}
        </PanelSection>

        {/* Properties */}
        <PanelSection title="属性编辑">
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            选中场景中的部件可在此编辑变换、材质等属性
          </div>
        </PanelSection>
      </aside>
    </div>
  );
}

function tabLabel(t: GalleryTab): string {
  switch (t) {
    case 'outliner': return 'Outliner';
    case 'mesh': return 'Mesh';
    case 'model': return 'Model';
    case 'pose': return 'Pose';
  }
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border-default)', padding: 10 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-primary)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function OutlinerList() {
  return (
    <div>
      {MOCK_OUTLINER.map((item) => (
        <div
          key={item.name}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '4px 8px',
            fontSize: 11,
            color: item.visible ? 'var(--text-primary)' : 'var(--text-disabled)',
            gap: 6,
            cursor: 'pointer',
            borderRadius: 2,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-2)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <span style={{ width: 14, color: 'var(--text-muted)' }}>{item.visible ? '👁' : '∅'}</span>
          <span style={{ flex: 1 }}>{item.name}</span>
          {item.locked && <span style={{ color: 'var(--text-muted)' }}>🔒</span>}
        </div>
      ))}
    </div>
  );
}

function GalleryGrid({ items, kind }: { items: { name: string; faces: string }[]; kind: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
      {items.map((item) => (
        <div
          key={item.name}
          style={{
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 3,
            padding: 6,
            cursor: 'grab',
          }}
          title={`拖拽到视口加入 ${kind}`}
        >
          <Placeholder type="3d" state="complete" height={70} label={item.name} />
          <div style={{ fontSize: 10, marginTop: 4, color: 'var(--text-primary)' }}>{item.name}</div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{item.faces} faces</div>
        </div>
      ))}
    </div>
  );
}

function PoseList({ items, onApply }: { items: string[]; onApply: (p: string) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map((p) => (
        <button
          key={p}
          onClick={() => onApply(p)}
          style={{
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 3,
            color: 'var(--text-primary)',
            padding: '6px 8px',
            textAlign: 'left',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
