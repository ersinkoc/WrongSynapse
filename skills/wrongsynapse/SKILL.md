---
name: wrongsynapse-memory
description: Persistent project memory for coding agents — query WrongSynapse before design decisions or file edits, record observations during work, consolidate candidates when a task completes. Use when working in any repo indexed by WrongSynapse or when the wrongsynapse CLI/MCP tools are available.
---

# WrongSynapse Memory Skill

You have a local, persistent memory layer for this project: **WrongSynapse**
(npm: `wrongsynapse`). It gives you tri-hybrid retrieval (semantic + FTS5/BM25
+ knowledge-graph) over the codebase structure, decisions, and episodic notes
— 100% local, zero cloud. This skill wires the memory reflex into your
workflow so knowledge survives session boundaries.

## Setup (one-time, if tools are missing)

- MCP client config (Claude Code / Claude Desktop / Cursor / any MCP host):

```json
{
  "mcpServers": {
    "wrongsynapse": {
      "command": "wrongsynapse",
      "env": { "SYNAPSE_DB_PATH": "/absolute/path/to/synapse.db" }
    }
  }
}
```

- If the `synapse_*` tools are not visible, run `wrongsynapse --index .` once
  in the workspace to populate the graph, then reconnect the MCP client.

## When to use

- **Before non-trivial work**: query memory for prior decisions, gotchas, and
  related symbols touching the files you are about to edit.
- **During work**: record surprises, root causes, conventions you had to
  discover — cheap writes, no graph pollution.
- **At task end**: consolidate — promote keepers, discard noise.

## Workflow

1. **Recall** — before designing or editing:
   `synapse_hybrid_query { query: "<feature/area>", scopes: ["proj:<name>"], limit: 5 }`
   Read `ranks` (fts/vector/graph) to see *why* each hit matched. Trust stale
   entries only after checking the anchored file still says so.
2. **Orient** — find the real structure:
   `synapse_graph_neighbors { entity_id: "proj:<name>/file:src/auth.ts", depth: 1 }`
   Callers, callees, anchored memories, and hierarchy in one hop.
3. **Work** — do the coding task.
4. **Observe** — for each durable insight (root cause, convention, decision,
   trap):
   `synapse_record_observation { content: "[domain-term: <term>] <one self-contained sentence>", scope_path: "proj:<name>/file:<path>", confidence: 0.85 }`
   Tag domain terms (`[domain-term: pushPrefixClause]`) so glossary queries
   find them; one coherent fact per observation.
5. **Consolidate** — at task end review the pool:
   `synapse_list_candidates { status: "pending" }` →
   `synapse_promote_candidate { candidate_id, target_scope }` for keepers;
   `synapse_discard_candidate { candidate_id }` for noise.
   Discard is terminal — a discarded candidate can never be promoted.

## Scope URIs (addressing scheme)

- `proj:<name>/pkg:<pkg>/dir:<path>/file:<path>/sym:<symbol>` — hierarchy;
  `proj:<name>/commit:<sha>` for git history.
- Prefix filters are boundary-aware: `proj:app` matches `proj:app/...` but
  NEVER the sibling `proj:app2/...`.

## Rules

- Never guess a symbol's neighborhood — one `graph_neighbors` call beats
  re-deriving call graphs by hand.
- Record the *why*, not the what; the graph already knows the what.
- Zero-cloud: the embedding model is local; if it is missing, semantic search
  degrades gracefully to lexical + graph (still useful — keep querying).
- Don't spam observations: if a fact is obvious from the code, the graph
  already has it.
