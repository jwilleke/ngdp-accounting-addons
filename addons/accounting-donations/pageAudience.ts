/**
 * Upgrade: take the shipped `audience` off this add-on's own seeded pages
 * (ngdpbase#2094, operator 2026-10-29). Up to now each page shipped
 * `audience: [treasurer]`; now a screen is gated by the permission its data or its
 * action asks, and the pages carry no audience. Reseed and Required Pages Sync
 * compare a page's body only, and a reseed keeps the frontmatter a page already
 * has, so a site seeded before this keeps the old audience until this pass
 * removes it.
 *
 * Runs at every start and is a no-op once done. It touches only this add-on's
 * pages, by the uuids it ships in `pages/`, and only an audience that is still
 * exactly the one shipped: a site that set its own keeps it, with a warning. Each
 * page is saved through core's page door (`PageManager.savePage`) as the system,
 * with the reason stated, so the save is recorded in the audit log; the body and
 * last-modified date are left as they are.
 */
import { readdirSync } from 'node:fs';

/** The audience every page of this add-on shipped with before ngdpbase#2094. */
export const SHIPPED_AUDIENCE: readonly string[] = ['treasurer'];

interface PageLike { title: string; content: string; metadata: Record<string, unknown> }
/** The slice of core's PageManager the pass uses: its read and its one write door, each with a context. */
export interface PageDoor {
  getPage(identifier: string, ctx: unknown): Promise<PageLike | null>;
  savePage(name: string, content: string, metadata: Record<string, unknown>, ctx: unknown, options?: Record<string, unknown>): Promise<unknown>;
}

/** The uuids of the pages this add-on ships: each seed file is `<uuid>.md`. */
export function shippedPageUuids(dir: URL = new URL('./pages/', import.meta.url)): string[] {
  return readdirSync(dir).filter(f => /^[0-9a-f-]{36}\.md$/.test(f)).map(f => f.slice(0, -3));
}

/** Remove the shipped audience from this add-on's own pages; returns the titles changed. */
export async function clearShippedAudience(pages: PageDoor | null | undefined, ctx: unknown, addon: string, uuids: readonly string[],
  log: { info(m: string): void; warn(m: string): void }): Promise<string[]> {
  if (!pages) return [];
  const cleared: string[] = [];
  for (const uuid of uuids) {
    const page = await pages.getPage(uuid, ctx);
    if (!page || page.metadata.addon !== addon || page.metadata.audience === undefined) continue;
    const audience = page.metadata.audience;
    if (!Array.isArray(audience) || audience.length !== SHIPPED_AUDIENCE.length || !SHIPPED_AUDIENCE.every(a => audience.includes(a))) {
      log.warn(`[${addon}] '${page.title}' keeps its audience: the site set it, not this add-on. The page's data asks its own permission, so the audience is not needed`);
      continue;
    }
    const { audience: _shipped, ...metadata } = page.metadata;
    await pages.savePage(page.title, page.content, metadata, ctx, { skipValidation: true, preserveLastModified: true });
    cleared.push(page.title);
  }
  if (cleared.length) log.info(`[${addon}] Took the shipped audience off ${cleared.length} page(s): each page's data asks its own permission`);
  return cleared;
}
