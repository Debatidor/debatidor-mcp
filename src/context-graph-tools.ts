import type { McpServer } from '@modelcontextprotocol/server';
import type { DebatidorApiClient } from './debatidor-api.js';
import {
  createContextEdgeInputSchema, listContextEdgesInputSchema, revokeContextEdgeInputSchema,
  contextEdgeCreatedSchema, contextEdgesSchema, contextEdgeRevokedSchema,
} from './context-graph-contracts.js';

type ToolError = { content: Array<{ type: 'text'; text: string }>; isError: boolean };
const success = <T extends Record<string, unknown>>(result: T) => ({content: [{type: 'text' as const, text: JSON.stringify(result)}], structuredContent: result});
export function registerContextGraphTools(server: McpServer, api: DebatidorApiClient, onError: (error: unknown) => ToolError) {
  const mutationError = (error: unknown): ToolError => {
    const result = onError(error);
    return { ...result, content: result.content.map(block => ({...block,
      text: `${block.text} No automatic retry was attempted; do not infer completion. Retry only on explicit request, preserving the original clientEdgeId and identical creation input where applicable.`})) };
  };
  server.registerTool('debatidor_create_context_edge', {
    title: 'Grant directed context access between your sessions',
    description: 'Explicitly grant readerSessionId access to sourceSessionId in your current workspace. Both private context sessions must belong to you; the reader must be open. Select 1–3 distinct views: summary, recent or transcript. maxEvents defaults to 50 (1–50); ttlSeconds defaults to 3600 (1–86400). clientEdgeId is required; reuse it with identical input only for an explicitly requested retry. Access is one-way, never reverse or transitive. An unrevoked reader/source edge, even expired, must be explicitly revoked before replacement. Creates only an edge; it does not issue a delegate credential, read context, copy history or launch an agent. Never retry automatically.',
    inputSchema: createContextEdgeInputSchema, outputSchema: contextEdgeCreatedSchema,
    annotations: {readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false},
  }, async input => {try {return success(await api.createContextEdge(input));} catch(error) {return mutationError(error);}});
  server.registerTool('debatidor_list_context_edges', {
    title: 'List directed context access for one reader session',
    description: 'Read one metadata page of directed edges owned by you for readerSessionId in your current workspace. Includes expired or revoked grants for inspection. Pass nextCursor unchanged with the same reader to continue; limit defaults to 50 and is at most 100. An edge grants only its chosen source and views, without reverse or transitive access. This tool returns no transcript or delegate credential and does not grant new access.',
    inputSchema: listContextEdgesInputSchema, outputSchema: contextEdgesSchema,
    annotations: {readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false},
  }, async input => {try {return success(await api.listContextEdges(input));} catch(error) {return onError(error);}});
  server.registerTool('debatidor_revoke_context_edge', {
    title: 'Revoke one directed context grant',
    description: 'Explicitly revoke edgeId belonging to your readerSessionId. Revocation is idempotent and denies future delegated pages; already received context cannot be removed from another prompt or local copy. Raw session history is preserved. Missing or foreign grants are unavailable. This does not revoke other edges or issue, reveal or manage delegate credentials. Never retry automatically.',
    inputSchema: revokeContextEdgeInputSchema, outputSchema: contextEdgeRevokedSchema,
    annotations: {readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false},
  }, async input => {try {return success(await api.revokeContextEdge(input));} catch(error) {return mutationError(error);}});
}
