/**
 * MultiViewOverlay
 *
 * 在 Page1 Multi-View 节点的预览区上叠加 **已生成的中间数据**：
 *   1. 4 视图切分轮廓（来自 page1.splits.views[*].bbox）
 *   2. DWPose 关节点 + 骨架（来自 page1.joints.global.keypoints，按置信度变色）
 *   3. 视图模式切换：4-in-1 整图 ↔ 4 张拆分子图网格
 *
 * 设计：本组件只渲染图像区，**不带任何控件按钮**——开关由调用方持有，通过
 * 外部 `<MultiViewOverlayControls>` 面板控制（参考 RoughBackendPanel 的位置）。
 * 这样图像区不被按钮遮挡，节点下方留出一个独立的"显示选项"行。
 *
 * SVG 与 <img> 共用 objectFit:contain / preserveAspectRatio:xMidYMid meet，
 * 二者在容器内对齐方式一致 → bbox 与关节坐标无需手动换算容器尺寸。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import type {
  Page1JointsMeta,
  Page1SplitsMeta,
  ViewName,
} from '../types/joints';

/** 受控的 overlay 显示模式 */
export interface MultiViewOverlayState {
  /** 叠加 DWPose 关节与骨架 */
  showJoints: boolean;
  /** 切换为 4 张拆分子图网格（关闭时显示 4-in-1 主图） */
  showSplit: boolean;
}

export const DEFAULT_OVERLAY_STATE: MultiViewOverlayState = {
  showJoints: false,
  showSplit: false,
};

export interface MultiViewOverlayProps {
  /** 4-in-1 主图 URL（始终需要，splitView 模式下隐藏不渲染） */
  imageUrl: string;
  /** 受控显示状态 */
  state: MultiViewOverlayState;
  /** Page1 splits 元数据（含 4 视图 bbox）—— 缺失时 bbox 与 split 模式自动忽略 */
  splits?: Page1SplitsMeta;
  /** Page1 joints 元数据（DWPose 输出）—— 缺失时 joints 自动忽略 */
  joints?: Page1JointsMeta;
  /**
   * 按需加载切分子图（split 模式开启时调用一次）。
   * 返回 4 视图各自的 blob URL；本组件 unmount 时统一 revoke。
   */
  loadSubImages?: () => Promise<Partial<Record<ViewName, string>> | null>;
  /** 容器高度，沿用 Placeholder 的默认 160 */
  height?: number | string;
}

// ── 骨架连接定义（DWPose 主关键点）────────────────────────────────────
const SKELETON: Array<[string, string]> = [
  ['neck', 'right_shoulder'],
  ['neck', 'left_shoulder'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['neck', 'right_hip'],
  ['neck', 'left_hip'],
  ['right_hip', 'left_hip'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
];

/** 统一蓝色（与按钮底色 --accent-blue #4a90e2 一致） */
function skeletonColor(): string {
  return '#4a90e2';
}

const containerStyle: CSSProperties = {
  width: '100%',
  background:
    'repeating-linear-gradient(45deg, #242424 0 10px, #1f1f1f 10px 20px)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 3,
  position: 'relative',
  overflow: 'hidden',
};

export function MultiViewOverlay({
  imageUrl,
  state,
  splits,
  joints,
  loadSubImages,
  height = 160,
}: MultiViewOverlayProps) {
  const { showJoints, showSplit } = state;
  const [subUrls, setSubUrls] = useState<Partial<Record<ViewName, string>> | null>(null);
  const [loadingSub, setLoadingSub] = useState(false);
  const subUrlsRef = useRef<Partial<Record<ViewName, string>> | null>(null);

  // 4-in-1 图的自然尺寸——优先用 joints 元数据里记录的值；
  // 拿不到时退回 onLoad 时读 naturalWidth/Height
  const metaSize = joints?.global.imageSize ?? null;
  const [imgSize, setImgSize] = useState<{ width: number; height: number } | null>(
    metaSize ? { width: metaSize.width, height: metaSize.height } : null,
  );

  // 切到 split 模式时按需加载子图（首次触发，后续复用缓存）
  useEffect(() => {
    if (!showSplit) return;
    if (subUrlsRef.current) return;
    if (!loadSubImages) return;
    let cancelled = false;
    setLoadingSub(true);
    loadSubImages()
      .then((m) => {
        if (cancelled) return;
        subUrlsRef.current = m ?? null;
        setSubUrls(m ?? null);
      })
      .catch((e) => {
        console.warn('[MultiViewOverlay] loadSubImages failed:', e);
      })
      .finally(() => {
        if (!cancelled) setLoadingSub(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showSplit, loadSubImages]);

  // unmount 时 revoke 子图 URL，避免内存泄漏。
  useEffect(() => {
    return () => {
      const cur = subUrlsRef.current;
      if (!cur) return;
      for (const u of Object.values(cur)) {
        if (u) URL.revokeObjectURL(u);
      }
      subUrlsRef.current = null;
    };
  }, []);

  const jointsOn =
    showJoints && !!joints && joints.global.keypoints.length > 0 && !showSplit;
  const splitOn = showSplit && !!splits;

  const numH = typeof height === 'number' ? height : 160;
  const unitsPerPx = imgSize && imgSize.height > 0 ? (imgSize.height / numH) : 8;
  const circleR = Math.ceil(5 * unitsPerPx);

  const keypointMap = useMemo(() => {
    if (!joints) return new Map<string, { x: number; y: number; confidence: number }>();
    const m = new Map<string, { x: number; y: number; confidence: number }>();
    for (const k of joints.global.keypoints) m.set(k.name, k);
    return m;
  }, [joints]);

  return (
    <div style={{ ...containerStyle, height }}>
      {splitOn ? (
        <SplitGrid subUrls={subUrls} loading={loadingSub} />
      ) : (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
          <img
            src={imageUrl}
            alt="multi-view"
            onLoad={(e) => {
              if (imgSize) return;
              const t = e.currentTarget;
              if (t.naturalWidth > 0 && t.naturalHeight > 0) {
                setImgSize({ width: t.naturalWidth, height: t.naturalHeight });
              }
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
          />
          {jointsOn && imgSize && (
            <svg
              viewBox={`0 0 ${imgSize.width} ${imgSize.height}`}
              preserveAspectRatio="xMidYMid meet"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
              }}
            >
              {jointsOn && joints && (
                <g>
                  {SKELETON.map(([a, b], i) => {
                    const ka = keypointMap.get(a);
                    const kb = keypointMap.get(b);
                    if (!ka || !kb) return null;
                    return (
                      <line
                        key={i}
                        x1={ka.x}
                        y1={ka.y}
                        x2={kb.x}
                        y2={kb.y}
                        stroke={skeletonColor()}
                        strokeWidth={2}
                        opacity={0.9}
                        style={{ vectorEffect: 'non-scaling-stroke' } as React.CSSProperties}
                      />
                    );
                  })}
                  {joints.global.keypoints.map((k) => (
                    <circle
                      key={k.name}
                      cx={k.x}
                      cy={k.y}
                      r={circleR}
                      fill={skeletonColor()}
                      stroke="#000"
                      strokeWidth={1.5}
                      style={{ vectorEffect: 'non-scaling-stroke' } as React.CSSProperties}
                    >
                      <title>{`${k.name}  conf=${k.confidence.toFixed(2)}`}</title>
                    </circle>
                  ))}
                </g>
              )}
            </svg>
          )}
        </div>
      )}
    </div>
  );
}

// ── 节点下方的显示选项面板（位置参考 RoughBackendPanel）──────────────

export interface MultiViewOverlayControlsProps {
  state: MultiViewOverlayState;
  onChange: (next: MultiViewOverlayState) => void;
  /** 是否存在 page1.joints（决定 "骨骼" 是否可用） */
  hasJoints: boolean;
  /** 是否存在子图加载能力（决定 "子图" 模式是否可用） */
  canLoadSubImages: boolean;
  /** 内联模式：去掉外框，直接嵌入 actions 栏 */
  inline?: boolean;
}

const panelStyle: CSSProperties = {
  marginTop: 6,
  padding: 6,
  background: 'var(--bg-surface-2, rgba(255,255,255,0.03))',
  border: '1px solid var(--border-subtle)',
  borderRadius: 3,
  fontSize: 11,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const panelLabelStyle: CSSProperties = {
  fontSize: 10,
  color: 'var(--text-muted)',
  minWidth: 64,
};

const chipBase: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 3,
  cursor: 'pointer',
  lineHeight: 1.2,
  userSelect: 'none',
};

const chipActive: CSSProperties = {
  background: 'var(--accent-blue)',
  borderColor: 'var(--accent-blue)',
  color: '#fff',
};

const chipDisabled: CSSProperties = {
  opacity: 0.35,
  cursor: 'not-allowed',
};

export function MultiViewOverlayControls({
  state,
  onChange,
  hasJoints,
  canLoadSubImages,
  inline,
}: MultiViewOverlayControlsProps) {
  const splitOn = state.showSplit && canLoadSubImages;
  const jointsDisabled = !hasJoints;
  const splitDisabled = !canLoadSubImages;

  const stop = (cb: () => void) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    cb();
  };

  const wrapStyle: CSSProperties = inline
    ? { display: 'flex', alignItems: 'center', gap: 6 }
    : panelStyle;

  return (
    <div style={wrapStyle} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {!inline && <span style={panelLabelStyle}>显示</span>}
      <Chip
        label="骨骼"
        active={state.showJoints && !splitOn}
        disabled={jointsDisabled}
        title={
          !hasJoints
            ? '尚未生成 page1.joints'
            : splitOn
              ? '切回整图并叠加骨骼'
              : '叠加 DWPose 关节与骨架'
        }
        onClick={stop(() =>
          splitOn
            ? onChange({ ...state, showSplit: false, showJoints: true })
            : onChange({ ...state, showJoints: !state.showJoints })
        )}
      />
      <Chip
        label="子图"
        active={state.showSplit}
        disabled={splitDisabled}
        title={
          !canLoadSubImages
            ? '尚未生成切分子图'
            : state.showSplit
              ? '切回 4-in-1 整图'
              : '查看 4 张拆分子图'
        }
        onClick={stop(() => onChange({ ...state, showSplit: !state.showSplit }))}
      />
    </div>
  );
}

interface ChipProps {
  label: string;
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: (e: ReactMouseEvent) => void;
}

function Chip({ label, active, disabled, title, onClick }: ChipProps) {
  const style: CSSProperties = {
    ...chipBase,
    ...(active ? chipActive : null),
    ...(disabled ? chipDisabled : null),
  };
  return (
    <button
      type="button"
      style={style}
      title={title}
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
    >
      {label}
    </button>
  );
}

interface SplitGridProps {
  subUrls: Partial<Record<ViewName, string>> | null;
  loading: boolean;
}

function SplitGrid({ subUrls, loading }: SplitGridProps) {
  const order: ViewName[] = ['front', 'left', 'back', 'right'];
  const labelMap: Record<ViewName, string> = {
    front: 'F',
    left: 'L',
    back: 'B',
    right: 'R',
  };
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--bg-app)',
        padding: 4,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 4,
      }}
    >
      {order.map((v) => {
        const url = subUrls?.[v];
        return (
          <div
            key={v}
            style={{
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 2,
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            {url ? (
              <img
                src={url}
                alt={v}
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  display: 'block',
                }}
              />
            ) : (
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {loading ? '…' : labelMap[v]}
              </span>
            )}
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: 4,
                fontSize: 12,
                fontWeight: 700,
                color: '#fff',
                background: 'rgba(0,0,0,0.55)',
                padding: '0 5px',
                borderRadius: 2,
                pointerEvents: 'none',
              }}
            >
              {labelMap[v]}
            </span>
          </div>
        );
      })}
    </div>
  );
}
