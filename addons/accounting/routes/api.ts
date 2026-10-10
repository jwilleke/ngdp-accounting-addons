/**
 * Accounting API — mounted at /api/accounting by index.ts.
 *
 * Routes only parse the request, call LedgerManager (the one door, which asks
 * for each action's permission on the request's own ApiContext), and shape the
 * reply. No permission, role or audit decision is made here.
 *
 * The host is imported through `dist/`, never `src/` (#1192).
 */
import { Router, type Request, type Response } from 'express';
import { ApiContext, ApiError } from '../../../dist/src/context/ApiContext.js';
import type LedgerManager from '../managers/LedgerManager.js';
import { LedgerError } from '../managers/LedgerManager.js';

interface Engine { getManager<T = unknown>(name: string): T | null | undefined }

type Handler = (ctx: ApiContext, ledger: LedgerManager, req: Request) => Promise<unknown>;

export default function apiRoutes(engine: Engine): Router {
  const router = Router();

  const handle = (status: number, fn: Handler) => async (req: Request, res: Response): Promise<void> => {
    try {
      const ledger = engine.getManager<LedgerManager>('LedgerManager');
      if (!ledger) { res.status(503).json({ ok: false, error: 'the ledger is not available on this site' }); return; }
      const ctx = ApiContext.from(req, engine as never);
      const result = await fn(ctx, ledger, req);
      res.status(status).json({ ok: true, result });
    } catch (err) {
      // A step-up refusal carries the way to re-authenticate (ngdpbase #1745).
      if (err instanceof ApiError) { res.status(err.status).json({ ok: false, error: err.message, ...(err.reauth ? { reauth: err.reauth } : {}) }); return; }
      if (err instanceof LedgerError) { res.status(err.status).json({ ok: false, error: err.message }); return; }
      res.status(500).json({ ok: false, error: 'internal error' });
    }
  };

  const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {});
  const query = (req: Request, key: string): string | undefined => (typeof req.query[key] === 'string' ? req.query[key] as string : undefined);

  // Funds
  router.get('/funds', handle(200, (ctx, ledger) => ledger.listFunds(ctx)));
  router.post('/funds', handle(201, (ctx, ledger, req) => ledger.createFund(ctx, body(req) as never)));
  router.patch('/funds/:id', handle(200, (ctx, ledger, req) => ledger.updateFund(ctx, String(req.params.id), body(req) as never)));
  router.post('/funds/:id/close', handle(200, (ctx, ledger, req) => ledger.closeFund(ctx, String(req.params.id), body(req).reason as string | undefined)));
  router.get('/balances', handle(200, (ctx, ledger) => ledger.fundBalances(ctx)));

  // Entries
  router.get('/transactions', handle(200, (ctx, ledger, req) => ledger.listTransactions(ctx, {
    fundId: query(req, 'fund'), from: query(req, 'from'), to: query(req, 'to'), includeVoided: query(req, 'voided') === 'true'
  })));
  router.get('/transactions/:id', handle(200, (ctx, ledger, req) => ledger.getTransaction(ctx, String(req.params.id))));
  router.post('/transactions', handle(201, (ctx, ledger, req) => ledger.postTransaction(ctx, body(req) as never)));
  router.post('/transactions/:id/void', handle(200, (ctx, ledger, req) => {
    const b = body(req);
    return ledger.voidTransaction(ctx, String(req.params.id), b.reason as string, b.replacement as never);
  }));
  router.post('/transfers', handle(201, (ctx, ledger, req) => ledger.transferBetweenFunds(ctx, body(req) as never)));

  return router;
}
