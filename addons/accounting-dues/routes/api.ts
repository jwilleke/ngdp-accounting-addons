/**
 * Dues API, mounted at /api/accounting-dues. Routes parse the request and call
 * DuesManager, which asks each permission itself. An invoice is a page, shown
 * exactly as stored.
 */
import type { Request, Response, Router } from 'express';
import type { AddonHost } from '@jwilleke/ngdpbase-types';
import type DuesManager from '../managers/DuesManager.js';

interface Engine { getManager<T = unknown>(name: string): T | null | undefined; createRouter(): Router }

export default function duesRoutes(engine: Engine, host: AddonHost): Router {
  const { ApiContext, ApiError, sendApiError } = host;
  const router = engine.createRouter();

  /** An invoice page, exactly as stored: the treasurer's (ledger-read), or one of the person's own (ledger-self). */
  const invoicePage = (read: (dues: DuesManager, ctx: ReturnType<typeof ApiContext.from>, id: string) => Promise<{ html: string }>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        const dues = engine.getManager<DuesManager>('DuesManager');
        if (!dues) { res.status(503).json({ ok: false, error: 'dues are not available on this site' }); return; }
        const invoice = await read(dues, ApiContext.from(req, engine as never), String(req.params.id));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(invoice.html);
      } catch (err) {
        if (err instanceof ApiError) { sendApiError(res, err, 'page'); return; }
        const status = (err as { status?: number; name?: string }).name === 'LedgerError' ? (err as { status: number }).status : 500;
        res.status(status).json({ ok: false, error: status === 500 ? 'internal error' : (err as Error).message });
      }
    };
  router.get('/invoices/:id', invoicePage((dues, ctx, id) => dues.getInvoice(ctx, id)));
  router.get('/my-invoices/:id', invoicePage((dues, ctx, id) => dues.myInvoice(ctx, id)));
  return router;
}
