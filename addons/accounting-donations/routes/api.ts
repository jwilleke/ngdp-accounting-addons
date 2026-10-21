/**
 * Donations API, mounted at /api/accounting-donations. Routes parse the
 * request and call DonationManager, which asks each permission itself.
 * Statements are pages: shown as stored, or previewed before issuing.
 */
import type { Request, Response, Router } from 'express';
import type { AddonHost, ApiContext as Ctx } from '@jwilleke/ngdpbase-types';
import type DonationManager from '../managers/DonationManager.js';

interface Engine { getManager<T = unknown>(name: string): T | null | undefined; createRouter(): Router }

export default function donationRoutes(engine: Engine, host: AddonHost): Router {
  const { ApiContext, ApiError, sendApiError } = host;
  const router = engine.createRouter();
  const query = (req: Request, key: string) => (typeof req.query[key] === 'string' ? req.query[key] as string : '');

  const page = (fn: (donations: DonationManager, ctx: Ctx, req: Request) => Promise<string>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        const donations = engine.getManager<DonationManager>('DonationManager');
        if (!donations) { res.status(503).json({ ok: false, error: 'donations are not available on this site' }); return; }
        const html = await fn(donations, ApiContext.from(req, engine as never), req);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch (err) {
        if (err instanceof ApiError) { sendApiError(res, err, 'page'); return; }
        const status = (err as { status?: number; name?: string }).name === 'LedgerError' ? (err as { status: number }).status : 500;
        res.status(status).json({ ok: false, error: status === 500 ? 'internal error' : (err as Error).message });
      }
    };

  // A stored statement, exactly as issued; ?donor=person|<@id>&year=2026 previews one not yet issued.
  router.get('/statements/preview', page((d, ctx, req) => d.previewStatement(ctx, query(req, 'donor'), Number(query(req, 'year')))));
  router.get('/statements/:id', page(async (d, ctx, req) => (await d.getStatement(ctx, String(req.params.id))).html));
  return router;
}
