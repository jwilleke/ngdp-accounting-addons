/**
 * Accounting API — mounted at /api/accounting by index.ts.
 *
 * Every decision here is ctx.requirePermission('accounting-manage') on the
 * request's own subject (ApiContext forwards it, token and share ceilings
 * included). Never a role name, never isAuthenticated: allow and deny come from
 * policy (#1198), and this addon's config/default-config.json is where the
 * permission and the policy that grants it are declared.
 *
 * The host is imported through `dist/`, never `src/`. A value import of host
 * source pulls it into this addon's compilation and emits a `.js` beside it —
 * which exists on a developer's machine and does not exist in the container,
 * where the image carries `dist/` and `addons/` but no `src/` (#1192).
 */
import { Router, type Request, type Response } from 'express';
import { ApiContext, ApiError } from '../../../dist/src/context/ApiContext.js';
import type AccountingManager from '../managers/AccountingManager.js';

interface Engine { getManager<T = unknown>(name: string): T | null }

export default function apiRoutes(engine: Engine): Router {
  const router = Router();

  /** Status, for the addon dashboard and the admin view. */
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const ctx = ApiContext.from(req, engine as never);
      await ctx.requirePermission('accounting-manage');
      const manager = engine.getManager<AccountingManager>('AccountingManager');
      res.json({ ok: true, status: manager?.status() ?? null });
    } catch (err) {
      if (err instanceof ApiError) { res.status(err.status).json({ ok: false, error: err.message }); return; }
      res.status(500).json({ ok: false, error: 'internal error' });
    }
  });

  /** Refresh from the configured source — a mutating request, so the view sends the CSRF token. */
  router.post('/refresh', async (req: Request, res: Response) => {
    try {
      const ctx = ApiContext.from(req, engine as never);
      await ctx.requirePermission('accounting-manage');
      const manager = engine.getManager<AccountingManager>('AccountingManager');
      const source = typeof req.body?.source === 'string' ? req.body.source : '';
      if (!manager || !source) { res.status(400).json({ ok: false, error: 'source is required' }); return; }
      const count = await manager.refresh(source);
      res.json({ ok: true, count });
    } catch (err) {
      if (err instanceof ApiError) { res.status(err.status).json({ ok: false, error: err.message }); return; }
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'internal error' });
    }
  });

  return router;
}
