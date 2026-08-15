/**
 * tools/index.ts — result helpers and registerTools wiring.
 */

import { describe, expect, it, vi } from 'vitest';

import { jsonResult, registerTools, textResult, type ToolContext, type ToolDefinition } from './index.js';

const ctx: ToolContext = {
  db: {} as ToolContext['db'],
  embedder: {} as ToolContext['embedder'],
};

interface FakeRegisterCall {
  name: string;
  config: { title?: string; description?: string; inputSchema?: unknown };
  cb: (args: unknown) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
}

function fakeServer(): { registerTool: ReturnType<typeof vi.fn>; calls: FakeRegisterCall[] } {
  const calls: FakeRegisterCall[] = [];
  const registerTool = vi.fn((name: string, config: FakeRegisterCall['config'], cb: FakeRegisterCall['cb']) => {
    calls.push({ name, config, cb });
  });
  return { registerTool, calls };
}

describe('result helpers', () => {
  it('textResult wraps plain text', () => {
    expect(textResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }], isError: false });
    expect(textResult('boom', true).isError).toBe(true);
  });

  it('jsonResult pretty-prints JSON', () => {
    const result = jsonResult({ a: 1, nested: { b: 'x' } });
    expect(result.content[0]!.text).toContain('"a": 1');
    expect(JSON.parse(result.content[0]!.text)).toEqual({ a: 1, nested: { b: 'x' } });
  });
});

describe('registerTools', () => {
  const definitions: readonly ToolDefinition[] = [
    {
      name: 'tool_a',
      description: 'A',
      inputSchema: { parse: () => ({}), safeParse: () => ({ success: true }), _zod: {} } as never,
      handler: async () => textResult('a ok'),
    },
    {
      name: 'tool_b',
      description: 'B',
      inputSchema: {} as never,
      handler: async () => {
        throw new Error('b exploded');
      },
    },
  ];

  it('registers every definition with name, title, description, and schema', () => {
    const { registerTool, calls } = fakeServer();
    registerTools({ registerTool } as never, ctx, definitions);
    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.name)).toEqual(['tool_a', 'tool_b']);
    expect(calls[0]!.config.title).toBe('tool_a');
    expect(calls[0]!.config.description).toBe('A');
    expect(calls[0]!.config.inputSchema).toBeDefined();
  });

  it('returns the handler result on success', async () => {
    const { registerTool, calls } = fakeServer();
    registerTools({ registerTool } as never, ctx, definitions);
    const result = await calls[0]!.cb({});
    expect(result.content[0]!.text).toBe('a ok');
    expect(result.isError).toBe(false);
  });

  it('wraps handler failures into error text', async () => {
    const { registerTool, calls } = fakeServer();
    registerTools({ registerTool } as never, ctx, definitions);
    const result = await calls[1]!.cb({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('b exploded');
  });

  it('passes raw args through to the handler', async () => {
    const seen: unknown[] = [];
    const defs: readonly ToolDefinition[] = [
      {
        name: 'capture',
        description: 'C',
        inputSchema: {} as never,
        handler: async (_c, args) => {
          seen.push(args);
          return textResult('ok');
        },
      },
    ];
    const { registerTool, calls } = fakeServer();
    registerTools({ registerTool } as never, ctx, defs);
    await calls[0]!.cb({ q: 1 });
    expect(seen[0]).toEqual({ q: 1 });
  });

  it('wraps non-Error throws as a string payload (errorText branch)', async () => {
    const defs: readonly ToolDefinition[] = [
      {
        name: 'str_thrower',
        description: 'S',
        inputSchema: {} as never,
        handler: async () => {
          throw 'plain string failure'; // eslint-disable-line no-throw-literal
        },
      },
    ];
    const { registerTool, calls } = fakeServer();
    registerTools({ registerTool } as never, ctx, defs);
    const result = await calls[0]!.cb({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: 'plain string failure' });
  });

  it('substitutes an empty object for null args', async () => {
    const seen: unknown[] = [];
    const defs: readonly ToolDefinition[] = [
      {
        name: 'nullargs',
        description: 'N',
        inputSchema: {} as never,
        handler: async (_c, args) => {
          seen.push(args);
          return textResult('ok');
        },
      },
    ];
    const { registerTool, calls } = fakeServer();
    registerTools({ registerTool } as never, ctx, defs);
    const result = await calls[0]!.cb(null);
    expect(result.isError).toBe(false);
    expect(seen[0]).toEqual({});
  });
});
