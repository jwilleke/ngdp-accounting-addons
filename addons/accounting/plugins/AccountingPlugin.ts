/**
 * AccountingPlugin — renders [{Accounting}] on any page.
 */

interface PluginContext {
  engine?: { getManager(name: string): unknown };
  pageName?: string;
}

const AccountingPlugin = {
  name: 'Accounting',
  description: 'Accounting — Accounting plugin',
  author: 'ngdpbase',
  version: '1.0.0',

  /**
   * Params arrive as a plain object of the attributes written in the markup.
   * Return a STRING of HTML — returning a Promise is fine, the renderer awaits.
   */
  execute(_context: PluginContext, params: Record<string, string>): string {
    const label = params.label ?? 'Accounting';
    // Escape anything that reaches the page — params are author-controlled but
    // a plugin that interpolates raw input teaches the wrong pattern.
    const safe = String(label).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c] as string));
    return `<div class="accounting-accounting">${safe}</div>`;
  }
};

export default AccountingPlugin;
