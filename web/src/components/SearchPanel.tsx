import { useCallback, useRef, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  SegmentedControl,
  Slider,
  Spinner,
  Text,
  TextField,
} from '@radix-ui/themes';
import { MagnifyingGlassIcon } from '@radix-ui/react-icons';

import { api, type SearchResponse } from '../api';

/**
 * Tri-hybrid search panel — the retrieval surface behind the MCP
 * `synapse_hybrid_query` tool, in the browser: FTS5/BM25 + semantic
 * embeddings + graph expansion fused with Reciprocal Rank Fusion.
 *
 * Every result row shows the fused score (with a bar relative to the top
 * hit) and the per-channel ranks that produced it, so an operator can see
 * WHY something ranked where it did. Channel weights, result limit, graph
 * depth, and a scope filter map 1:1 onto the backend query params.
 */
export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [limit, setLimit] = useState(10);
  const [vectorWeight, setVectorWeight] = useState(1);
  const [lexicalWeight, setLexicalWeight] = useState(1);
  const [graphWeight, setGraphWeight] = useState(1);
  const [graphDepth, setGraphDepth] = useState('1');
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Request sequence: only the most recently issued search may update state
  // (a slow earlier response must not overwrite a newer one).
  const seq = useRef(0);

  const run = useCallback((): void => {
    const q = query.trim();
    if (q === '') return;
    const id = seq.current + 1;
    seq.current = id;
    setLoading(true);
    setError(null);
    api
      .search({
        q,
        scope: scope.trim() === '' ? undefined : scope.trim(),
        limit,
        vectorWeight,
        lexicalWeight,
        graphWeight,
        graphDepth: Number(graphDepth),
      })
      .then((res) => {
        if (seq.current !== id) return;
        setResponse(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (seq.current !== id) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [query, scope, limit, vectorWeight, lexicalWeight, graphWeight, graphDepth]);

  const maxScore = response !== null && response.results.length > 0 ? response.results[0]!.score : 0;

  return (
    <Flex direction="column" gap="3">
      {/* Query bar */}
      <Card size="2">
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
                placeholder="Search memory — tri-hybrid (BM25 + semantic + graph), fused with RRF…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') run();
                }}
                style={{ paddingLeft: '32px' }}
              />
            </Box>
            <Button onClick={run} disabled={loading || query.trim() === ''}>
              {loading ? <Spinner size="1" /> : 'Search'}
            </Button>
          </Flex>

          <Flex gap="3" align="center" wrap="wrap">
            <TextField.Root
              placeholder="Scope prefix (optional)"
              size="1"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
              }}
              style={{ width: '240px' }}
            />
            <Flex gap="2" align="center">
              <Text size="1" color="gray">
                Graph depth
              </Text>
              <SegmentedControl.Root
                size="1"
                value={graphDepth}
                onValueChange={setGraphDepth}
              >
                <SegmentedControl.Item value="1">1 hop</SegmentedControl.Item>
                <SegmentedControl.Item value="2">2 hops</SegmentedControl.Item>
                <SegmentedControl.Item value="3">3 hops</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Flex>
            <LabeledSlider label="Limit" value={limit} min={1} max={50} step={1} onChange={setLimit} />
          </Flex>

          <Flex gap="4" wrap="wrap">
            <LabeledSlider label="Semantic weight" value={vectorWeight} onChange={setVectorWeight} />
            <LabeledSlider label="Lexical weight" value={lexicalWeight} onChange={setLexicalWeight} />
            <LabeledSlider label="Graph weight" value={graphWeight} onChange={setGraphWeight} />
          </Flex>
        </Flex>
      </Card>

      {error !== null && (
        <Card size="1" style={{ borderColor: 'var(--color-danger)' }}>
          <Text size="2" color="red">
            Search failed: {error}
          </Text>
        </Card>
      )}

      {response !== null && response.warnings.length > 0 && (
        <Card size="1" style={{ borderColor: 'var(--color-warning)' }}>
          <Flex direction="column" gap="1">
            {response.warnings.map((w) => (
              <Text key={w} size="1" style={{ color: 'var(--color-warning)' }}>
                ⚠ {w}
              </Text>
            ))}
          </Flex>
        </Card>
      )}

      <Card size="2">
        {response === null ? (
          <Flex align="center" justify="center" p="6">
            <Text color="gray">Run a query to see tri-hybrid results with scores.</Text>
          </Flex>
        ) : response.results.length === 0 ? (
          <Flex align="center" justify="center" p="6">
            <Text color="gray">No results for “{response.query}”.</Text>
          </Flex>
        ) : (
          <Box>
            <Flex align="center" justify="between" pb="2" style={{ borderBottom: '1px solid var(--color-border)' }}>
              <Text size="1" color="gray">
                {response.count} result{response.count === 1 ? '' : 's'} for “{response.query}”
              </Text>
              <Badge
                color={response.vector_retrieval_used ? 'violet' : 'gray'}
                variant="soft"
                radius="full"
              >
                {response.vector_retrieval_used ? 'semantic on' : 'semantic off'}
              </Badge>
            </Flex>
            {response.results.map((result, index) => (
              <ResultRow
                key={result.entity.id}
                result={result}
                position={index + 1}
                maxScore={maxScore}
              />
            ))}
          </Box>
        )}
      </Card>
    </Flex>
  );
}

function ResultRow(props: { result: SearchResponse['results'][number]; position: number; maxScore: number }) {
  const { result, position, maxScore } = props;
  const relative = maxScore > 0 ? result.score / maxScore : 0;
  return (
    <Box py="3" style={{ borderBottom: '1px solid var(--color-border)' }}>
      <Flex align="center" gap="3">
        <Text size="1" color="gray" className="font-mono" style={{ width: '28px' }}>
          #{position}
        </Text>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text
            size="2"
            weight="medium"
            className="font-mono"
            style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {result.entity.name}
          </Text>
          <Text
            size="1"
            color="gray"
            className="font-mono"
            style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {result.entity.scope_path}
          </Text>
        </Box>
        <Badge color="cyan" variant="soft" radius="full">
          {result.entity.type}
        </Badge>
        <Text size="1" className="font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {result.score.toFixed(4)}
        </Text>
      </Flex>
      <Flex gap="2" align="center" mt="2" pl="40px">
        <Box
          style={{
            flex: 1,
            height: '4px',
            background: 'var(--color-raised)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}
        >
          <Box
            style={{
              width: `${Math.round(relative * 100)}%`,
              height: '100%',
              background: 'var(--color-primary)',
            }}
          />
        </Box>
        <ChannelBadge label="FTS" rank={result.ranks.fts} color="grass" />
        <ChannelBadge label="VEC" rank={result.ranks.vector} color="violet" />
        <ChannelBadge label="GRAPH" rank={result.ranks.graph} color="cyan" />
      </Flex>
      {result.entity.content !== null && (
        <Text
          as="div"
          size="1"
          color="gray"
          mt="1"
          style={{
            paddingLeft: '40px',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {result.entity.content}
        </Text>
      )}
    </Box>
  );
}

/** Per-channel rank chip: `FTS #1` when the channel ranked the hit, `FTS —` when it did not. */
function ChannelBadge(props: { label: string; rank: number | null; color: 'grass' | 'violet' | 'cyan' }) {
  return (
    <Badge color={props.rank === null ? 'gray' : props.color} variant="soft" radius="full">
      {props.rank === null ? `${props.label} —` : `${props.label} #${props.rank}`}
    </Badge>
  );
}

function LabeledSlider(props: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Box style={{ minWidth: '170px', flex: '1 1 170px' }}>
      <Flex justify="between" mb="1">
        <Text size="1" color="gray">
          {props.label}
        </Text>
        <Text size="1" className="font-mono">
          {props.value}
        </Text>
      </Flex>
      <Slider
        size="1"
        value={[props.value]}
        min={props.min ?? 0}
        max={props.max ?? 10}
        step={props.step ?? 0.5}
        onValueChange={(values) => {
          const next = values[0];
          if (next !== undefined) props.onChange(next);
        }}
      />
    </Box>
  );
}
