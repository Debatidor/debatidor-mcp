import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { DebatidorApiClient } from './debatidor-api.js';
import {
  createContextSessionInputSchema, contextSessionCreatedSchema, contextSessionsInputSchema, contextSessionsSchema,
  getContextSessionInputSchema, contextSessionPageSchema, appendContextSessionInputSchema, contextEventAdmissionSchema,
  contextSessionIdInputSchema, contextSessionSchema, createContextDeclarationInputSchema, contextDeclarationAdmissionSchema,
  contextDeclarationIdInputSchema, contextDeclarationSchema, contextRawOriginInputSchema, contextRawOriginSchema, contextStatusSchema,
} from './context-knowledge-contracts.js';

type ToolError = { content: Array<{ type: 'text'; text: string }>; isError: boolean };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const success = <T extends Record<string, unknown>>(result: T) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result });

export function registerContextKnowledgeTools(server: McpServer, api: DebatidorApiClient, onError: (error: unknown) => ToolError) {
  const mutationError = (error: unknown): ToolError => {
    const result = onError(error);
    return { ...result, content: result.content.map(block => ({ ...block,
      text: `${block.text} No automatic retry was attempted. Completion is unknown unless confirmed. Retry only on explicit request; reuse the original client identifier and identical content where supported.` })) };
  };
  server.registerTool('debatidor_create_context_session', {
    title: 'Create a private raw context session',
    description: 'Explicitly create a private raw transcript owned only by the authenticated user; this does not create an Arena or launch an agent. Optionally link an owned context project. Supply clientSessionId to make an explicitly requested retry idempotent with the same label/project. Without it each call creates a new session. Never retry automatically. Capture only content the user has authorized to store.',
    inputSchema: createContextSessionInputSchema, outputSchema: contextSessionCreatedSchema,
    annotations: { ...write, idempotentHint: false },
  }, async input => { try { return success(await api.createContextSession(input)); } catch (error) { return mutationError(error); } });
  server.registerTool('debatidor_list_context_sessions', {
    title: 'List your private context sessions',
    description: 'Read one page of raw context sessions owned only by the authenticated user. Optionally filter by an owned project. Pass nextCursor unchanged to continue; a context session is independent of an Arena or a local agent connection.',
    inputSchema: contextSessionsInputSchema, outputSchema: contextSessionsSchema, annotations: read,
  }, async input => { try { return success(await api.listContextSessions(input)); } catch (error) { return onError(error); } });
  server.registerTool('debatidor_get_context_session', {
    title: 'Read a private raw session transcript',
    description: 'Read owner-only session metadata and one ordered page of exact raw events through throughSequence. This performs two authorized HTTP reads and returns nothing if either fails. Pass transcript.nextCursor unchanged for the next page of that snapshot. Later new events require a fresh first-page read. Raw history remains readable after closing or forgetting its derived memory.',
    inputSchema: getContextSessionInputSchema, outputSchema: contextSessionPageSchema, annotations: read,
  }, async input => { try { return success(await api.getContextSession(input)); } catch (error) { return onError(error); } });
  server.registerTool('debatidor_append_context_session', {
    title: 'Append an explicitly captured raw event',
    description: 'Append exact authorized content to an open private session you own. Supply the role explicitly (HUMAN, ASSISTANT, TOOL or SYSTEM); never infer a role from content or capture unrelated conversations. clientEventId is required and must be reused with identical role/content only for an explicitly requested retry. Content is at most 32768 UTF-8 bytes. queued confirms durable raw admission, not completed derived indexing. Never retry automatically; no provider API key is used.',
    inputSchema: appendContextSessionInputSchema, outputSchema: contextEventAdmissionSchema, annotations: write,
  }, async input => { try { return success(await api.appendContextSession(input)); } catch (error) { return mutationError(error); } });
  server.registerTool('debatidor_close_context_session', {
    title: 'Close a private context session',
    description: 'Explicitly close an owner-only raw context session to prevent new events. Closing is idempotent and preserves raw history and derived memory. This tool does not retry automatically or disconnect local agents.',
    inputSchema: contextSessionIdInputSchema, outputSchema: contextSessionSchema, annotations: { ...write, destructiveHint: true },
  }, async ({ sessionId }) => { try { return success(await api.closeContextSession(sessionId)); } catch (error) { return mutationError(error); } });
  server.registerTool('debatidor_create_context_declaration', {
    title: 'Record an explicitly declared fact, decision or conclusion',
    description: 'Store a user-authorized declaration as FACT, DECISION or CONCLUSION with 1–32 exact nonempty UTF-16 citations from current raw MESSAGE or SESSION_EVENT revisions in one readable source. This is a declared assertion, not a fact inferred or independently verified by Debatidor. Read the raw origin first to obtain exact content and valid Unicode boundaries. Never automatically classify text. clientDeclarationId is required; only explicitly retry with the same identifier and identical request. Content is at most 24000 UTF-8 bytes. queued confirms admission, not completed derived indexing. No BYOK and no automatic retry.',
    inputSchema: createContextDeclarationInputSchema, outputSchema: contextDeclarationAdmissionSchema, annotations: write,
  }, async input => { try { return success(await api.createContextDeclaration(input)); } catch (error) { return mutationError(error); } });
  server.registerTool('debatidor_get_context_declaration', {
    title: 'Read a declaration and its cited provenance',
    description: 'Read an authorized raw declaration with exact cited origins and current, stale or forgotten state. A stale or forgotten declaration must not be presented as current derived memory. Its declared kind is not independent factual verification.',
    inputSchema: contextDeclarationIdInputSchema, outputSchema: contextDeclarationSchema, annotations: read,
  }, async ({ declarationId }) => { try { return success(await api.getContextDeclaration(declarationId)); } catch (error) { return onError(error); } });
  server.registerTool('debatidor_get_context_raw_origin', {
    title: 'Read the exact raw revision behind a citation',
    description: 'Read an authorized exact MESSAGE or SESSION_EVENT revision, sequence, content and verified SHA-256 content hash. Citation offsets count UTF-16 code units, not bytes or code points. Historical message revisions may remain available after edits; do not imply they are current. Session events only have revision 1. Session sources remain owner-only; source access is always checked by the backend.',
    inputSchema: contextRawOriginInputSchema, outputSchema: contextRawOriginSchema, annotations: read,
  }, async input => { try { return success(await api.getContextRawOrigin(input)); } catch (error) { return onError(error); } });
  server.registerTool('debatidor_get_context_status', {
    title: 'Read context processing status',
    description: 'Read authorized aggregate semantic and first-party knowledge processing counters: raw counts/bytes, current/stale/forgotten summaries, queued/running/failed work and completion timing. These are operational counters, not factual-quality scores. Knowledge processing does not require provider credits. Missing legacy knowledge fields are unavailable, never assumed zero.',
    inputSchema: z.object({}).strict(), outputSchema: contextStatusSchema, annotations: read,
  }, async () => { try { return success(await api.getContextStatus()); } catch (error) { return onError(error); } });
}
