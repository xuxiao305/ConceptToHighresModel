import type { NodeState } from '../types';

interface NodeConnectorProps {
  fromState: NodeState;
  toState: NodeState;
  height?: number;
}

/**
 * Horizontal arrow connector between two pipeline nodes.
 * Color reflects upstream state:
 *   - upstream complete → green solid
 *   - upstream running → blue dashed flow
 *   - else → gray
 */
export function NodeConnector({ fromState, toState, height = 200 }: NodeConnectorProps) {
  let color = 'var(--state-idle)';
  let dashed = false;
  let animated = false;

  if (fromState === 'complete') {
    color = toState === 'complete' || toState === 'running' ? 'var(--state-complete)' : 'var(--state-ready)';
  } else if (fromState === 'running') {
    color = 'var(--state-running)';
    dashed = true;
    animated = true;
  }

  const midY = height / 2;

  return (
    <div
      style={{
        flex: '0 0 auto',
        width: 36,
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width="36" height={height} style={{ overflow: 'visible' }}>
        <line
          x1="0"
          y1={midY}
          x2="28"
          y2={midY}
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? '6 4' : undefined}
          style={animated ? { animation: 'flow 0.6s linear infinite' } : undefined}
        />
        <polygon
          points={`28,${midY - 5} 36,${midY} 28,${midY + 5}`}
          fill={color}
        />
      </svg>
    </div>
  );
}
