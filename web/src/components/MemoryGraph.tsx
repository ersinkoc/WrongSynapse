import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  type Edge,
  type Node,
  type NodeProps,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Badge, Box, Card, Flex, Spinner, Text } from '@radix-ui/themes';

import { api, type MemoryGraph as MemoryGraphData } from '../api';

/**
 * Memory graph — the third tab. React Flow visualization of every memory
 * entry plus the non-memory endpoints of every relation that touches one.
 *
 * Layout: dagre-style positioning computed once on load (cheap O(N log N);
 * fine for the 500-cap). Pan + zoom controls are the React Flow defaults.
 */
export default function MemoryGraph() {
  return (
    <ReactFlowProvider>
      <MemoryGraphInner />
    </ReactFlowProvider>
  );
}

function MemoryGraphInner() {
  const [data, setData] = useState<MemoryGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .memoryGraph(500)
      .then((g) => {
        if (!cancelled) setData(g);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const { nodes, edges } = useMemo(() => {
    if (data === null) return { nodes: [], edges: [] };
    return layoutGraph(data);
  }, [data]);

  if (error !== null) {
    return (
      <Card>
        <Text color="red">Failed to load graph: {error}</Text>
      </Card>
    );
  }
  if (data === null) {
    return (
      <Flex align="center" gap="2" p="4">
        <Spinner />
        <Text color="gray">Loading graph…</Text>
      </Flex>
    );
  }
  if (data.nodes.length === 0) {
    return (
      <Card>
        <Text color="gray">No memory entries to graph yet.</Text>
      </Card>
    );
  }

  return (
    <Card size="2" style={{ height: '600px', padding: 0 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="var(--color-border)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Card>
  );
}

/**
 * Layout the memory graph. When the server provided deterministic
 * `position`s (demo mode: ctx.layoutSeed → seeded server-side layout),
 * honor them verbatim — the same --demo-seed then paints the same picture
 * on every client. Otherwise fall back to the local two-column grid
 * (memory entries left, non-memory neighbors right).
 */
function layoutGraph(data: MemoryGraphData): { nodes: Node[]; edges: Edge[] } {
  const memoryIds = new Set(data.nodes.filter((n) => n.type === 'memory_entry').map((n) => n.id));
  const colX = (n: MemoryGraphData['nodes'][number]): number => (memoryIds.has(n.id) ? 0 : 360);
  const rowOf = new Map<string, number>();
  data.nodes.forEach((n, i) => rowOf.set(n.id, i));
  const colWidth = 220;
  const nodes: Node[] = data.nodes.map((n) => ({
    id: n.id,
    type: n.type === 'memory_entry' ? 'memory' : 'neighbor',
    position: n.position ?? { x: colX(n), y: (rowOf.get(n.id) ?? 0) * colWidth },
    data: n,
  }));
  const edges: Edge[] = data.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.relation,
    type: 'smoothstep',
    animated: false,
  }));
  return { nodes, edges };
}

const NODE_TYPES = { memory: MemoryNode, neighbor: NeighborNode };

function MemoryNode(props: NodeProps) {
  const data = props.data as MemoryGraphData['nodes'][number];
  return (
    <Box
      style={{
        padding: '8px 12px',
        border: '1px solid var(--color-primary)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface)',
        minWidth: '180px',
        maxWidth: '320px',
      }}
    >
      <Flex direction="column" gap="1">
        <Flex align="center" justify="between" gap="2">
          <Badge color="cyan" variant="soft" radius="full">
            memory
          </Badge>
          <Text size="1" color="gray" className="font-mono">
            {(data.confidence * 100).toFixed(0)}%
          </Text>
        </Flex>
        <Text size="2" weight="medium" className="font-mono">
          {data.label}
        </Text>
        <Text size="1" color="gray" className="font-mono">
          {data.scope_path}
        </Text>
      </Flex>
    </Box>
  );
}

function NeighborNode(props: NodeProps) {
  const data = props.data as MemoryGraphData['nodes'][number];
  return (
    <Box
      style={{
        padding: '6px 10px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-raised)',
        minWidth: '160px',
        maxWidth: '300px',
      }}
    >
      <Flex direction="column" gap="1">
        <Badge color="gray" variant="soft" radius="full">
          {data.type}
        </Badge>
        <Text size="2" className="font-mono">
          {data.label}
        </Text>
      </Flex>
    </Box>
  );
}
