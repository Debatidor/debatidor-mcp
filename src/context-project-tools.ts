import type { McpServer } from '@modelcontextprotocol/server';
import type { DebatidorApiClient } from './debatidor-api.js';
import { contextExportDeletedSchema } from './context-governance-contracts.js';
import {
  createContextProjectSchema, contextProjectIdInputSchema, contextProjectSchema,
  contextProjectsInputSchema, contextProjectsSchema, replaceContextProjectSourcesSchema,
} from './context-project-contracts.js';

type ToolError = { content: Array<{ type: 'text'; text: string }>; isError: boolean };
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerContextProjectTools(
  server: McpServer, api: DebatidorApiClient, onError: (error: unknown) => ToolError,
) {
  server.registerTool('debatidor_list_context_projects', {
    title: 'List your memory projects',
    description: 'Read one page of your private context collections in the authenticated workspace. Pass nextCursor unchanged to continue. Collections group sources without granting access or modifying canonical memory. A project is not an Arena or an agent session.',
    inputSchema: contextProjectsInputSchema, outputSchema: contextProjectsSchema, annotations: readAnnotations,
  }, async input => {
    try {
      const result = await api.listContextProjects(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return onError(error); }
  });

  server.registerTool('debatidor_get_context_project', {
    title: 'Read a memory project',
    description: 'Read one private context collection you own and its currently readable sourceIds. Missing or foreign collections are unavailable. Source membership never grants access to another user\'s private memory.',
    inputSchema: contextProjectIdInputSchema, outputSchema: contextProjectSchema, annotations: readAnnotations,
  }, async ({ projectId }) => {
    try {
      const result = await api.getContextProject(projectId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return onError(error); }
  });

  server.registerTool('debatidor_create_context_project', {
    title: 'Create a private memory project',
    description: 'Explicitly create an empty private context collection in your authenticated workspace. Name is 1–120 trimmed characters; at most 50 collections per user. Does not create an Arena, copy memory or grant source access. Every call creates a new collection: never retry automatically.',
    inputSchema: createContextProjectSchema, outputSchema: contextProjectSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async input => {
    try {
      const result = await api.createContextProject(input);
      return { content: [{ type: 'text', text: `Created private memory project ${result.id}. Select sources explicitly with debatidor_update_context_project_sources.` }], structuredContent: result };
    } catch (error) { return mutationError(onError(error)); }
  });

  server.registerTool('debatidor_update_context_project_sources', {
    title: 'Replace a memory project source selection',
    description: 'Explicitly replace all sourceIds linked to your private context project with 0–100 unique currently readable sources. An empty array clears the collection. Every source must be accessible now; any inaccessible source rejects the whole replacement. Existing links not included are removed, while source content and canonical memory are preserved. New exports use the replacement; frozen exports retain their admitted sources while still authorized. This tool never retries automatically.',
    inputSchema: replaceContextProjectSourcesSchema, outputSchema: contextProjectSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try {
      const result = await api.replaceContextProjectSources(input);
      return { content: [{ type: 'text', text: `Replaced the source selection of memory project ${result.id} with ${result.sourceIds.length} sources. Canonical memory is preserved.` }], structuredContent: result };
    } catch (error) { return mutationError(onError(error)); }
  });

  server.registerTool('debatidor_delete_context_project', {
    title: 'Delete a private memory project',
    description: 'Delete a private context collection you own and invalidate its managed export snapshots. Preserves all canonical memory sources, items and raw conversation history. Downloaded/local projections are outside service control. Missing or foreign projects are unavailable. Never retry automatically; do not confuse this with deleting derived memory.',
    inputSchema: contextProjectIdInputSchema, outputSchema: contextExportDeletedSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ projectId }) => {
    try {
      const result = await api.deleteContextProject(projectId);
      return { content: [{ type: 'text', text: 'Deleted the private memory project and invalidated its managed snapshots. Canonical memory and downloaded copies are preserved.' }], structuredContent: result };
    } catch (error) { return mutationError(onError(error)); }
  });
}

function mutationError(result: ToolError): ToolError {
  return { ...result, content: result.content.map(block => ({ ...block,
    text: `${block.text} No automatic retry was attempted; do not infer completion or automatically repeat this mutation.` })) };
}
