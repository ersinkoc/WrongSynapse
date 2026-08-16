import { useEffect, useState } from 'react';
import { Box, Container, Flex, Heading, Tabs, Text, Badge, Spinner } from '@radix-ui/themes';

import Stats from './components/Stats';
import MemoryList from './components/MemoryList';
import MemoryGraph from './components/MemoryGraph';
import SearchPanel from './components/SearchPanel';
import { api } from './api';

/**
 * Single-page admin shell.
 *
 * Four tabs (Search / Stats / Memory / Graph) matching the product surfaces:
 * tri-hybrid retrieval with scores, database statistics, the memory list,
 * and the graph visualisation. The header carries the server version +
 * health badge so an operator can confirm the SPA is talking to a live
 * backend at a glance.
 */
export default function App() {
  const [health, setHealth] = useState<{ ok: boolean; version: string } | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch((err: unknown) => {
        if (!cancelled) setHealthError(err instanceof Error ? err.message : String(err));
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  return (
    <Box style={{ minHeight: '100vh' }}>
      {/* Header — brand + version + health badge. Stays dark-pro: tight,
          hairline border, monospace for IDs/versions. */}
      <Box
        asChild
        style={{
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
        }}
      >
        <header>
          <Container size="4" px="4">
            <Flex align="center" justify="between" py="3">
              <Flex align="center" gap="3">
                <Heading size="4" weight="bold" style={{ letterSpacing: '-0.01em' }}>
                  WrongSynapse
                </Heading>
                <Badge color="cyan" variant="soft" radius="full">
                  Admin
                </Badge>
              </Flex>
              <Flex align="center" gap="3">
                {health === null && healthError === null ? (
                  <Flex align="center" gap="2">
                    <Spinner size="1" />
                    <Text size="1" color="gray">
                      connecting…
                    </Text>
                  </Flex>
                ) : health !== null ? (
                  <Flex align="center" gap="2">
                    <Badge color="green" variant="soft" radius="full">
                      live
                    </Badge>
                    <Text size="1" color="gray" className="font-mono">
                      v{health.version}
                    </Text>
                  </Flex>
                ) : (
                  <Badge color="red" variant="soft" radius="full">
                    offline
                  </Badge>
                )}
              </Flex>
            </Flex>
          </Container>
        </header>
      </Box>

      <Container size="4" px="4" py="5">
        <Tabs.Root defaultValue="search">
          <Tabs.List>
            <Tabs.Trigger value="search">Search</Tabs.Trigger>
            <Tabs.Trigger value="stats">Statistics</Tabs.Trigger>
            <Tabs.Trigger value="memory">Memory</Tabs.Trigger>
            <Tabs.Trigger value="graph">Graph</Tabs.Trigger>
          </Tabs.List>

          <Box pt="4">
            <Tabs.Content value="search">
              <SearchPanel />
            </Tabs.Content>
            <Tabs.Content value="stats">
              <Stats />
            </Tabs.Content>
            <Tabs.Content value="memory">
              <MemoryList />
            </Tabs.Content>
            <Tabs.Content value="graph">
              <MemoryGraph />
            </Tabs.Content>
          </Box>
        </Tabs.Root>

        {healthError !== null && (
          <Box mt="4" p="3" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
            <Text size="2" color="red">
              Backend unreachable: {healthError}
            </Text>
          </Box>
        )}
      </Container>
    </Box>
  );
}
