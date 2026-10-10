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
import { renderLedgerView, VIEW_PARAMS } from '../plugins/LedgerPlugin.js';

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

  // [{Ledger}] tables, loaded by public/js/ledger-view.js when a page opens.
  // Never cached: this is the live part the page's cached HTML leaves out.
  router.get('/view', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    void handle(200, async (ctx, ledger) => {
      const params: Record<string, string> = {};
      for (const key of VIEW_PARAMS) { const v = query(req, key); if (v !== undefined) params[key] = v; }
      return { html: await renderLedgerView(ledger, ctx, params) };
    })(req, res);
  });

  // Reports: ?month=current|previous|YYYY-MM, or ?from=YYYY-MM-DD&to=YYYY-MM-DD
  const period = (ledger: LedgerManager, req: Request) => ledger.period({ month: query(req, 'month'), from: query(req, 'from'), to: query(req, 'to') });
  router.get('/summary', handle(200, (ctx, ledger, req) => ledger.periodSummary(ctx, period(ledger, req))));

  // The CSV download. A link the treasurer follows, so a step-up refusal goes
  // to the re-authenticate page (it returns here) rather than answering JSON.
  router.get('/export', async (req: Request, res: Response): Promise<void> => {
    try {
      const ledger = engine.getManager<LedgerManager>('LedgerManager');
      if (!ledger) { res.status(503).json({ ok: false, error: 'the ledger is not available on this site' }); return; }
      const ctx = ApiContext.from(req, engine as never);
      const kind = query(req, 'kind') === 'funds' ? 'funds' : 'transactions';
      const file = await ledger.exportCsv(ctx, kind, period(ledger, req));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('X-Content-SHA256', file.sha256);
      res.send(file.body);
    } catch (err) {
      if (err instanceof ApiError && err.reauth && req.accepts(['html', 'json']) === 'html') { res.redirect(err.reauth); return; }
      if (err instanceof ApiError) { res.status(err.status).json({ ok: false, error: err.message, ...(err.reauth ? { reauth: err.reauth } : {}) }); return; }
      if (err instanceof LedgerError) { res.status(err.status).json({ ok: false, error: err.message }); return; }
      res.status(500).json({ ok: false, error: 'internal error' });
    }
  });

  return router;
}
