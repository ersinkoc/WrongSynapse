import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  Flex,
  IconButton,
  ScrollArea,
  Spinner,
  TextField,
  Text,
  TextArea,
} from '@radix-ui/themes';
import { MagnifyingGlassIcon, TrashIcon } from '@radix-ui/react-icons';

import { api, type MemorySummary, type MemoryDetail } from '../api';

/**
 * Memory list + detail + remove — the second tab.
 *
 * Layout: filter bar at the top (search + scope), a scrollable list of
 * memory entries on the left, and a detail panel on the right showing the
 * selected memory's metadata + graph paths. Delete is a confirmation dialog
 * (Radix Dialog handles focus trapping + escape).
 */
export default function MemoryList() {
  const [memories, setMemories] = useState<MemorySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback((query: string): void => {
    setLoading(true);
    setError(null);
    api
      .listMemories({ q: query === '' ? undefined : query, limit: 200 })
      .then((res) => {
        setMemories(res.memories);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    reload('');
  }, [reload]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .getMemory(selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return (): void => {
      cancelled = true;
    };
  }, [selectedId]);

  const filtered = useMemo(() => {
    if (search === '') return memories;
    const q = search.toLowerCase();
    return memories.filter((m) => m.name.toLowerCase().includes(q) || m.scope_path.toLowerCase().includes(q));
  }, [memories, search]);

  return (
    <Flex direction="column" gap="3">
      <Flex gap="3" align="center">
        <Box style={{ position: 'relative', flex: 1 }}>
          <Box
            style={{
              position: 'absolute',
              left: '10px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-muted)',
              pointerEvents: 'none',
            }}
          >
            <MagnifyingGlassIcon />
          </Box>
          <TextField.Root
            placeholder="Search by name or scope…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
            }}
            style={{ paddingLeft: '32px' }}
          />
        </Box>
        <Button
          variant="soft"
          onClick={() => {
            reload(search);
          }}
        >
          Refresh
        </Button>
      </Flex>

      <Flex gap="3" align="stretch" style={{ minHeight: '400px' }}>
        {/* List */}
        <Card size="2" style={{ flex: '1 1 40%' }}>
          {loading ? (
            <Flex align="center" gap="2" p="4">
              <Spinner />
              <Text color="gray">Loading memories…</Text>
            </Flex>
          ) : error !== null ? (
            <Text color="red">{error}</Text>
          ) : filtered.length === 0 ? (
            <Text color="gray">No memory entries match.</Text>
          ) : (
            <ScrollArea style={{ height: '500px' }}>
              {filtered.map((m) => (
                <MemoryRow
                  key={m.id}
                  memory={m}
                  selected={m.id === selectedId}
                  onSelect={() => {
                    setSelectedId(m.id);
                  }}
                  onDeleted={() => {
                    setSelectedId(null);
                    setDetail(null);
                    reload(search);
                  }}
                />
              ))}
            </ScrollArea>
          )}
        </Card>

        {/* Detail */}
        <Card size="2" style={{ flex: '1 1 60%' }}>
          {detail === null ? (
            <Flex align="center" justify="center" p="6">
              <Text color="gray">Select a memory entry to view details.</Text>
            </Flex>
          ) : (
            <MemoryDetailPanel
              detail={detail}
              onDeleted={() => {
                setSelectedId(null);
                setDetail(null);
                reload(search);
              }}
            />
          )}
        </Card>
      </Flex>
    </Flex>
  );
}

function MemoryRow(props: {
  memory: MemorySummary;
  selected: boolean;
  onSelect: () => void;
  onDeleted: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Box
      onClick={props.onSelect}
      style={{
        padding: '8px 12px',
        cursor: 'pointer',
        background: props.selected ? 'var(--color-raised)' : 'transparent',
        borderLeft: props.selected ? '2px solid var(--color-primary)' : '2px solid transparent',
      }}
    >
      <Flex align="center" justify="between" gap="2">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="2" weight="medium" className="font-mono" style={{ display: 'block' }}>
            {truncate(props.memory.name, 60)}
          </Text>
          <Text size="1" color="gray" className="font-mono" style={{ display: 'block' }}>
            {props.memory.scope_path}
          </Text>
        </Box>
        <Badge color="cyan" variant="soft" radius="full">
          {Math.round(props.memory.confidence * 100)}%
        </Badge>
        <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Dialog.Trigger>
            <IconButton
              size="1"
              variant="ghost"
              color="red"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmOpen(true);
              }}
              aria-label="Delete memory"
            >
              <TrashIcon />
            </IconButton>
          </Dialog.Trigger>
          <Dialog.Content style={{ maxWidth: '420px' }}>
            <Dialog.Title>Delete memory entry?</Dialog.Title>
            <Dialog.Description size="2" color="gray">
              This removes the memory, its embedding, and any relations that
              touch it. The action is irreversible.
            </Dialog.Description>
            <Flex direction="column" gap="2" mt="3">
              <Text size="2" className="font-mono">
                {props.memory.scope_path}
              </Text>
              <Text size="2" color="gray">
                {truncate(props.memory.name, 80)}
              </Text>
            </Flex>
            <Flex gap="2" mt="4" justify="end">
              <Dialog.Close>
                <Button variant="soft" color="gray">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button
                color="red"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  api
                    .deleteMemory(props.memory.id)
                    .then(() => {
                      setConfirmOpen(false);
                      props.onDeleted();
                    })
                    .catch((err: unknown) => {
                      setBusy(false);
                      setError(err instanceof Error ? err.message : String(err));
                    });
                }}
              >
                {busy ? <Spinner size="1" /> : 'Delete'}
              </Button>
            </Flex>
            {error !== null && (
              <Text size="1" color="red" mt="2">
                Delete failed: {error}
              </Text>
            )}
          </Dialog.Content>
        </Dialog.Root>
      </Flex>
    </Box>
  );
}

function MemoryDetailPanel(props: { detail: MemoryDetail; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Flex direction="column" gap="3">
      <Flex align="center" justify="between">
        <Badge color="cyan" variant="soft">
          {props.detail.type}
        </Badge>
        <Button
          size="1"
          variant="ghost"
          color="red"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            api
              .deleteMemory(props.detail.id)
              .then(() => {
                props.onDeleted();
              })
              .catch((err: unknown) => {
                setBusy(false);
                setError(err instanceof Error ? err.message : String(err));
              });
          }}
        >
          {busy ? <Spinner size="1" /> : 'Delete'}
        </Button>
      </Flex>
      {error !== null && (
        <Text size="1" color="red">
          Delete failed: {error}
        </Text>
      )}
      <Box>
        <Text size="1" color="gray">
          Scope
        </Text>
        <Text size="2" className="font-mono" style={{ display: 'block' }}>
          {props.detail.scope_path}
        </Text>
      </Box>
      <Box>
        <Text size="1" color="gray">
          Name
        </Text>
        <Text size="2" weight="medium" style={{ display: 'block' }}>
          {props.detail.name}
        </Text>
      </Box>
      <Box>
        <Text size="1" color="gray">
          Content
        </Text>
        <TextArea value={props.detail.content ?? ''} readOnly rows={6} />
      </Box>
      {props.detail.graph_paths.length > 0 && (
        <Box>
          <Text size="1" color="gray">
            Graph paths ({props.detail.graph_paths.length})
          </Text>
          <Box mt="1">
            {props.detail.graph_paths.map((p) => (
              <Flex key={p.id} gap="2" align="center" py="1">
                <Badge variant="soft" color="green">
                  {p.relation}
                </Badge>
                <Text size="2" className="font-mono">
                  {p.sourceName}
                </Text>
                <Text size="2" color="gray">
                  →
                </Text>
                <Text size="2" className="font-mono">
                  {p.targetName}
                </Text>
              </Flex>
            ))}
          </Box>
        </Box>
      )}
      <Flex gap="4">
        <Box>
          <Text size="1" color="gray">
            Confidence
          </Text>
          <Text size="2" className="font-mono" style={{ display: 'block' }}>
            {(props.detail.confidence * 100).toFixed(0)}%
          </Text>
        </Box>
        <Box>
          <Text size="1" color="gray">
            Updated
          </Text>
          <Text size="2" className="font-mono" style={{ display: 'block' }}>
            {new Date(props.detail.updated_at).toLocaleString()}
          </Text>
        </Box>
      </Flex>
    </Flex>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
