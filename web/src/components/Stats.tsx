import { useEffect, useState } from 'react';
import { Box, Card, Flex, Grid, Heading, Text, Spinner, Badge } from '@radix-ui/themes';

import { api, type Stats as StatsData } from '../api';

/**
 * Statistics panel — the first tab. Shows the four core counts (entities,
 * relations, vectors, candidates) plus the FTS row count, and a breakdown
 * of entity types + relation types. Each stat card uses tabular-nums via
 * .font-mono so the digits align when stacked.
 */
export default function Stats() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .stats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  if (error !== null) {
    return (
      <Card>
        <Text color="red">Failed to load statistics: {error}</Text>
      </Card>
    );
  }
  if (stats === null) {
    return (
      <Flex align="center" gap="2" p="4">
        <Spinner />
        <Text color="gray">Loading statistics…</Text>
      </Flex>
    );
  }

  const cards: Array<{ label: string; value: number; accent: 'cyan' | 'green' | 'amber' | 'violet' }> = [
    { label: 'Entities', value: stats.entities, accent: 'cyan' },
    { label: 'Relations', value: stats.relations, accent: 'green' },
    { label: 'Vectors', value: stats.vectors, accent: 'violet' },
    { label: 'Candidates', value: stats.candidates, accent: 'amber' },
    { label: 'FTS rows', value: stats.ftsRows, accent: 'cyan' },
  ];

  return (
    <Flex direction="column" gap="4">
      <Grid columns={{ initial: '2', sm: '5' }} gap="3">
        {cards.map((c) => (
          <Card key={c.label} size="2">
            <Flex direction="column" gap="1">
              <Text size="1" color="gray">
                {c.label}
              </Text>
              <Text size="6" weight="bold" className="font-mono">
                {c.value.toLocaleString()}
              </Text>
            </Flex>
          </Card>
        ))}
      </Grid>

      <Grid columns={{ initial: '1', md: '2' }} gap="4">
        <BreakdownCard title="Entity types" entries={stats.breakdown.types} accent="cyan" />
        <BreakdownCard title="Relation types" entries={stats.breakdown.relations} accent="green" />
      </Grid>
    </Flex>
  );
}

function BreakdownCard(props: {
  title: string;
  entries: Record<string, number>;
  accent: 'cyan' | 'green';
}) {
  const rows = Object.entries(props.entries).sort(([, a], [, b]) => b - a);
  return (
    <Card size="2">
      <Flex direction="column" gap="3">
        <Heading size="3" weight="medium">
          {props.title}
        </Heading>
        {rows.length === 0 ? (
          <Text size="2" color="gray">
            No entries yet.
          </Text>
        ) : (
          <Box>
            {rows.map(([kind, count]) => (
              <Flex
                key={kind}
                align="center"
                justify="between"
                py="1"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <Text size="2" className="font-mono">
                  {kind}
                </Text>
                <Badge color={props.accent} variant="soft" radius="full">
                  {count.toLocaleString()}
                </Badge>
              </Flex>
            ))}
          </Box>
        )}
      </Flex>
    </Card>
  );
}
