/**
 * DonationsPlugin — donations drawn on a page for the person viewing it:
 *
 *   [{Donations view='pledges'}]          open pledges: pledged, given, left
 *   [{Donations view='pledges' cancelled='true'}]
 *   [{Donations view='inkind'}]           in-kind gifts: donor, date, description (never a value)
 *
 * Every read goes through DonationManager as the viewer, so its permissions
 * decide (ledger-read: these name donors).
 */
import type { PluginFormatters } from '@jwilleke/ngdpbase-types';
import type DonationManager from '../managers/DonationManager.js';

type Params = Record<string, string | number | boolean>;
const note = (f: PluginFormatters, text: string): string => `<p class="text-muted"><em>${f.escapeHtml(text)}</em></p>`;

export async function renderDonationsView(f: PluginFormatters, donations: DonationManager, viewer: unknown, currency: string, params: Params): Promise<string> {
  const { escapeHtml, formatAsTable, formatMoney, parseBoolParam } = f;
  const money = (cents: number) => escapeHtml(formatMoney(cents, currency));
  const actor = {
    ipAddress: undefined, subject: (viewer ?? null) as never, actingUsername: () => 'viewer',
    enforceDeny: async (permission: string) => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
  };
  try {
    const view = String(params.view ?? 'pledges');
    if (view === 'pledges') {
      const pledges = await donations.listPledges(actor, { includeCancelled: parseBoolParam(params.cancelled as string | undefined, false) });
      return formatAsTable(['Donor', 'From', 'To', 'Schedule', 'Pledged', 'Given', 'Left', 'Status'],
        pledges.map(p => [escapeHtml(p.donorName), escapeHtml(p.startDate), escapeHtml(p.endDate ?? ''), escapeHtml(p.schedule),
          money(p.amount), money(p.given), `<strong>${money(p.remaining)}</strong>`, p.status === 'cancelled' ? `cancelled: ${escapeHtml(p.cancelReason ?? '')}` : 'open']),
        { sortable: true, emptyMessage: 'No pledges.' });
    }
    if (view === 'inkind') {
      const gifts = await donations.listInKind(actor, { includeVoided: parseBoolParam(params.voided as string | undefined, false) });
      return formatAsTable(['Date', 'Donor', 'What', 'Status'],
        gifts.map(g => [escapeHtml(g.date), escapeHtml(g.donorName), escapeHtml(g.description), g.status === 'voided' ? `voided: ${escapeHtml(g.voidReason ?? '')}` : 'posted']),
        { sortable: true, emptyMessage: 'No in-kind gifts.' });
    }
    return note(f, `Donations: unknown view '${view}'; use pledges or inkind.`);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return note(f, 'You may not see the donations.');
    return note(f, 'The donations could not be shown.');
  }
}

const DonationsPlugin = {
  name: 'Donations',
  description: 'Pledges and in-kind gifts, for those allowed to see them',
  author: 'jwilleke',
  version: '0.1.0',
  async execute(context: { engine: { getManager<T = unknown>(name: string): T | null | undefined }; userContext?: unknown; formatters: PluginFormatters }, params: Params): Promise<string> {
    const donations = context.engine.getManager<DonationManager>('DonationManager');
    const ledger = context.engine.getManager<{ currencyCode(): string }>('LedgerManager');
    if (!donations || !ledger) return note(context.formatters, 'Donations are not available on this site.');
    return renderDonationsView(context.formatters, donations, context.userContext, ledger.currencyCode(), params);
  }
};

export default DonationsPlugin;
