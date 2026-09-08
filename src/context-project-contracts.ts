import * as z from 'zod/v4';
import { contextIdSchema, contextSourceCursorSchema } from './context-governance-contracts.js';

const projectNameSchema = z.string().trim().min(1).max(120)
  .refine(name => !/[\u0000-\u001f\u007f]/.test(name), 'Invalid project name.');
const projectSourceIdsSchema = z.array(contextIdSchema).max(100)
  .refine(ids => new Set(ids).size === ids.length, 'Project source ids must be unique.');
const projectShape = {
  id: contextIdSchema,
  name: projectNameSchema,
  createdAt: z.iso.datetime({ offset: true }),
};

export const createContextProjectSchema = z.object({ name: projectNameSchema });
export const contextProjectIdInputSchema = z.object({ projectId: contextIdSchema });
export const contextProjectsInputSchema = z.object({
  cursor: contextSourceCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const replaceContextProjectSourcesSchema = z.object({
  projectId: contextIdSchema,
  // Empty is an explicit collection clear, never an implicit all-sources choice.
  sourceIds: projectSourceIdsSchema,
});
export const contextProjectSchema = z.object({ ...projectShape, sourceIds: projectSourceIdsSchema });
export const contextProjectsSchema = z.object({
  projects: z.array(z.object({ ...projectShape, sourceCount: z.number().int().min(0).max(100) })).max(100),
  nextCursor: contextSourceCursorSchema.nullable(),
}).refine(page => new Set(page.projects.map(project => project.id)).size === page.projects.length,
  'A project page must not duplicate projects.')
  .refine(page => page.nextCursor === null || page.projects.length > 0, 'An empty page cannot continue.');

export type CreateContextProjectInput = z.infer<typeof createContextProjectSchema>;
export type ContextProjectsInput = z.infer<typeof contextProjectsInputSchema>;
export type ReplaceContextProjectSourcesInput = z.infer<typeof replaceContextProjectSourcesSchema>;
