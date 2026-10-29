/**
 * One of this add-on's forms on a page, drawn only for a viewer who may submit it
 * (ngdpbase#2094). The add-on's pages carry no audience: a screen is gated by the
 * permission its data or its action asks. Here that is the form's own write
 * permission, and core's `form-submit`, asked of the decision point with the
 * viewer's context; anyone else reads a short note instead of a form whose submit
 * would be refused. The form itself is core's forms add-on's `Form` plugin, run
 * through PluginManager with the same context. The handler's manager still asks
 * the permission on submit.
 */
import type { PluginFormatters } from '@jwilleke/ngdpbase-types';

export interface GatedFormContext {
  engine: { getManager<T = unknown>(name: string): T | null | undefined };
  userContext?: unknown;
  pageName?: string;
  formatters: PluginFormatters;
}

interface DecisionPointLike { permits(ctx: unknown, action: string): Promise<boolean> }
interface PluginManagerLike { execute(name: string, pageName: string, params: Record<string, unknown>, context: Record<string, unknown>): Promise<string> }

/** What a viewer without the permission reads. */
export const NOT_PERMITTED = "You don't have permission to do this.";

const note = (f: PluginFormatters, text: string): string => `<p class="text-muted"><em>${f.escapeHtml(text)}</em></p>`;

export async function gatedForm(context: GatedFormContext, id: string, permissions: Readonly<Record<string, string>>): Promise<string> {
  const f = context.formatters;
  const permission = permissions[id];
  if (!permission) return note(f, `No form '${id}' here.`);
  const pdp = context.engine.getManager<DecisionPointLike>('PolicyDecisionPoint');
  const ctx = context.userContext;
  const may = async (action: string) => Boolean(ctx && pdp && await pdp.permits(ctx, action));
  if (!(await may(permission)) || !(await may('form-submit'))) return note(f, NOT_PERMITTED);
  const plugins = context.engine.getManager<PluginManagerLike>('PluginManager');
  if (!plugins) return note(f, 'Forms are not available on this site.');
  return plugins.execute('Form', context.pageName ?? '', { id }, context as unknown as Record<string, unknown>);
}
