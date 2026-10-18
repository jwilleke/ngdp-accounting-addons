/**
 * Accounting API — mounted at /api/accounting by index.ts.
 *
 * Routes only parse the request, call LedgerManager (the one door, which asks
 * for each action's permission on the request's own ApiContext), and shape the
 * reply. No permission, role or audit decision is made here.
 *
 * Core values come from the `host` ngdpbase hands register() (#1813); only
 * types are imported from core.
 */
import type { Request, Response, Router } from 'express';
import type { AddonHost, ApiContext } from '@jwilleke/ngdpbase-types';
import type LedgerManager from '../managers/LedgerManager.js';
import { LedgerError } from '../managers/LedgerManager.js';
import type ReceiptManager from '../managers/ReceiptManager.js';

interface Engine {
  getManager<T = unknown>(name: string): T | null | undefined;
  /** A Router from ngdpbase's own Express (v5.15.0, #1861); add-ons never import express at runtime. */
  createRouter(): Router;
}

type Handler = (ctx: ApiContext, ledger: LedgerManager, req: Request, receipts: ReceiptManager) => Promise<unknown>;

export default function apiRoutes(engine: Engine, host: AddonHost): Router {
  const { ApiContext, ApiError, sendApiError } = host;
  const router = engine.createRouter();

  const handle = (status: number, fn: Handler) => async (req: Request, res: Response): Promise<void> => {
    try {
      const ledger = engine.getManager<LedgerManager>('LedgerManager');
      const receipts = engine.getManager<ReceiptManager>('ReceiptManager');
      if (!ledger || !receipts) { res.status(503).json({ ok: false, error: 'the ledger is not available on this site' }); return; }
      const ctx = ApiContext.from(req, engine as never);
      const result = await fn(ctx, ledger, req, receipts);
      res.status(status).json({ ok: true, result });
    } catch (err) {
      // A step-up refusal carries the way to re-authenticate (ngdpbase #1745).
      if (err instanceof ApiError) { sendApiError(res, err); return; }
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

  // Accounts: where the money sits (D-031). Bank accounts are configuration; only their opening balance is set here.
  router.get('/accounts', handle(200, (ctx, ledger) => ledger.listAccounts(ctx)));
  router.get('/account-balances', handle(200, (ctx, ledger) => ledger.accountBalances(ctx)));
  router.post('/accounts/:id/opening', handle(201, (ctx, ledger, req) => ledger.setAccountOpening(ctx, String(req.params.id), body(req) as never)));

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
  // Receipts: money coming in (D-028, D-029). The ledger numbers each one.
  router.post('/receipts', handle(201, (ctx, _ledger, req, receipts) => receipts.recordReceipt(ctx, body(req) as never)));
  router.post('/receipts/:id/refund', handle(201, (ctx, _ledger, req, receipts) => receipts.refundReceipt(ctx, String(req.params.id), body(req) as never)));
  router.post('/transfers', handle(201, (ctx, ledger, req) => ledger.transferBetweenFunds(ctx, body(req) as never)));

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
      // A link the treasurer follows: page mode redirects to sign in again (or to /login).
      if (err instanceof ApiError) { sendApiError(res, err, req.accepts(['html', 'json']) === 'html' ? 'page' : 'json'); return; }
      if (err instanceof LedgerError) { res.status(err.status).json({ ok: false, error: err.message }); return; }
      res.status(500).json({ ok: false, error: 'internal error' });
    }
  });

  return router;
}
